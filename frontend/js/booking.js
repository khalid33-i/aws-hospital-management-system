// Shared by the receptionist and patient pages: slot picker, booking and rescheduling dialogs.
import { api, debounce } from './api.js';
import { h, clear, openModal, toast, skeleton, errorState, todayIso, fmtDateTime } from './ui.js';
import { ApiError } from './api.js';

let schedulingCache = null;
export function getScheduling() {
  if (!schedulingCache) {
    schedulingCache = api.get('/directory/scheduling').catch((err) => {
      schedulingCache = null;
      throw err;
    });
  }
  return schedulingCache;
}

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toLabel = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export function slotPicker({ doctorId = '' } = {}) {
  let doctor = doctorId;
  let date = '';
  let selected = '';
  let seq = 0;
  const dateInput = h('input', { type: 'date', min: todayIso(), 'aria-label': 'Appointment date' });
  const grid = h('div', { class: 'slots', role: 'group', 'aria-label': 'Available times' });
  const hint = h('p', { class: 'hint' }, 'Choose a doctor and a date to see available times.');

  async function refresh() {
    const mine = ++seq;
    selected = '';
    clear(grid);
    hint.hidden = Boolean(doctor && date);
    if (!doctor || !date) return;
    grid.append(skeleton(2));
    try {
      const [s, booked] = await Promise.all([getScheduling(), api.get(`/directory/doctors/${doctor}/booked`, { date })]);
      if (mine !== seq) return;
      const taken = new Set(booked.data);
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const buttons = [];
      for (let t = toMin(s.clinicOpen); t + s.slotMinutes <= toMin(s.clinicClose); t += s.slotMinutes) {
        const label = toLabel(t);
        const unavailable = taken.has(label) || (date === todayIso() && t <= nowMin);
        const btn = h('button', { type: 'button', class: 'slot', 'aria-pressed': 'false', disabled: unavailable, title: unavailable ? 'Not available' : '' }, label);
        btn.addEventListener('click', () => {
          for (const b of buttons) b.setAttribute('aria-pressed', 'false');
          btn.setAttribute('aria-pressed', 'true');
          selected = `${date} ${label}`;
        });
        buttons.push(btn);
      }
      clear(grid).append(...buttons);
      if (buttons.every((b) => b.disabled)) grid.append(h('p', { class: 'muted' }, 'No free times on this day.'));
    } catch (err) {
      if (mine === seq) clear(grid).append(errorState(err, refresh));
    }
  }

  dateInput.addEventListener('change', () => {
    date = dateInput.value;
    refresh();
  });
  return {
    el: h('div', { class: 'field full' }, h('label', {}, 'Date and time', h('span', { class: 'req' }, ' *')), dateInput, grid, hint),
    setDoctor(id) {
      doctor = id;
      refresh();
    },
    refresh,
    get value() {
      return selected;
    },
  };
}

function errorBanner() {
  return h('div', { class: 'form-error full', role: 'alert', hidden: true });
}
function showError(banner, err) {
  banner.hidden = false;
  banner.textContent = err instanceof ApiError ? err.message : 'Unexpected error. Please try again.';
}

/** opts: { asPatient, patient:{id,name} (receptionist, optional fixed patient), onBooked } */
export async function openBookingModal({ asPatient = false, patient = null, onBooked }) {
  const banner = errorBanner();
  let doctors;
  try {
    doctors = (await api.get('/directory/doctors')).data;
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  let patientId = patient ? patient.id : '';
  const patientBlock = [];
  if (!asPatient) {
    if (patient) {
      patientBlock.push(h('div', { class: 'field full' }, h('label', {}, 'Patient'), h('div', {}, h('strong', {}, patient.name))));
    } else {
      const results = h('select', { size: 4, class: 'pick-list', 'aria-label': 'Matching patients' });
      const search = h('input', { type: 'search', placeholder: 'Search by name, phone or MRN…', 'aria-label': 'Search patients', maxlength: 100 });
      search.addEventListener(
        'input',
        debounce(async () => {
          clear(results);
          patientId = '';
          if (search.value.trim().length < 2) return;
          try {
            const res = await api.get('/receptionist/patients', { q: search.value.trim(), pageSize: 20 });
            results.append(...res.data.map((p) => h('option', { value: p.id }, `${p.fullName} · ${p.medicalRecordNo} · ${p.phone}`)));
            if (!res.data.length) results.append(h('option', { disabled: true }, 'No matching patients'));
          } catch (err) {
            showError(banner, err);
          }
        }, 300)
      );
      results.addEventListener('change', () => {
        patientId = results.value;
      });
      patientBlock.push(h('div', { class: 'field full' }, h('label', {}, 'Patient', h('span', { class: 'req' }, ' *')), search, results));
    }
  }

  const doctorSelect = h('select', { 'aria-label': 'Doctor' }, h('option', { value: '' }, '— select a doctor —'), doctors.map((d) => h('option', { value: d.id }, `${d.fullName} — ${d.specialty} (${d.department})`)));
  const picker = slotPicker();
  doctorSelect.addEventListener('change', () => picker.setDoctor(doctorSelect.value));
  const reason = h('textarea', { rows: 2, maxlength: 255, placeholder: 'Reason for visit (optional)', 'aria-label': 'Reason' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Book appointment');

  const form = h(
    'form',
    { class: 'form', novalidate: true },
    patientBlock,
    h('div', { class: 'field full' }, h('label', {}, 'Doctor', h('span', { class: 'req' }, ' *')), doctorSelect),
    picker.el,
    h('div', { class: 'field full' }, h('label', {}, 'Reason'), reason),
    banner,
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit)
  );
  const modal = openModal({ title: 'Book an appointment', body: form });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    banner.hidden = true;
    if (!asPatient && !patientId) return showError(banner, new ApiError(0, 'X', 'Please select a patient.'));
    if (!doctorSelect.value) return showError(banner, new ApiError(0, 'X', 'Please select a doctor.'));
    if (!picker.value) return showError(banner, new ApiError(0, 'X', 'Please pick a date and an available time.'));
    submit.disabled = true;
    try {
      const body = { doctorId: Number(doctorSelect.value), scheduledAt: picker.value, reason: reason.value.trim() || undefined };
      if (asPatient) await api.post('/patient/appointments', body);
      else await api.post('/receptionist/appointments', { ...body, patientId: Number(patientId) });
      modal.close();
      toast(`Appointment booked for ${fmtDateTime(body.scheduledAt)}`);
      if (onBooked) onBooked();
    } catch (err) {
      showError(banner, err);
      if (err.status === 409) picker.refresh();
    } finally {
      submit.disabled = false;
    }
  });
}

export function openRescheduleModal({ appointment, onDone }) {
  const banner = errorBanner();
  const picker = slotPicker({ doctorId: appointment.doctorId });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Reschedule');
  const form = h(
    'form',
    { class: 'form', novalidate: true },
    h('div', { class: 'field full' }, h('p', {}, h('strong', {}, appointment.patientName), ' with ', h('strong', {}, appointment.doctorName)), h('p', { class: 'muted' }, `Currently ${fmtDateTime(appointment.scheduledAt)}`)),
    picker.el,
    banner,
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit)
  );
  const modal = openModal({ title: 'Reschedule appointment', body: form });
  picker.setDoctor(appointment.doctorId);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    banner.hidden = true;
    if (!picker.value) return showError(banner, new ApiError(0, 'X', 'Please pick a date and an available time.'));
    submit.disabled = true;
    try {
      await api.put(`/receptionist/appointments/${appointment.id}/reschedule`, { scheduledAt: picker.value });
      modal.close();
      toast('Appointment rescheduled');
      if (onDone) onDone();
    } catch (err) {
      showError(banner, err);
      if (err.status === 409) picker.refresh();
    } finally {
      submit.disabled = false;
    }
  });
}
