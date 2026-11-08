import { api, debounce } from '../api.js';
import { h, clear, card, pageHeader, statCard, badge, dataTable, createList, formModal, openModal, confirmDialog, buildForm, toast, fmtDate, fmtDateTime, fmtTime, todayIso, age, emptyState, errorState } from '../ui.js';

const RX_STATUSES = ['Pending', 'Partially Dispensed', 'Dispensed', 'Cancelled'];
const progress = (done, total) => {
  const fill = h('span');
  fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  return h('div', { class: 'progress', title: `${done} of ${total}` }, fill);
};

// ------------------------------------------------------------------ appointment actions (shared by dashboard + list)
function appointmentActions(a, reload) {
  const setStatus = async (status) => {
    if (status === 'No-Show') {
      const ok = await confirmDialog({ title: 'Mark as no-show', message: `${a.patientName} did not attend.`, confirmLabel: 'Mark no-show', danger: true });
      if (!ok) return;
    }
    try {
      await api.put(`/doctor/appointments/${a.id}/status`, { status });
      toast(`Marked ${status}`);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const open = ['Scheduled', 'Confirmed'].includes(a.status);
  return [
    a.status === 'Scheduled' && h('button', { class: 'btn sm', onclick: () => setStatus('Confirmed') }, 'Confirm'),
    ' ',
    open && h('button', { class: 'btn sm primary', onclick: () => setStatus('Completed') }, 'Complete'),
    ' ',
    open && h('button', { class: 'btn sm', onclick: () => setStatus('No-Show') }, 'No-show'),
    ' ',
    a.status !== 'Cancelled' && a.status !== 'No-Show' && h('button', { class: 'btn sm', onclick: () => visitNote(a) }, 'Visit note'),
  ];
}

async function visitNote(a) {
  let existing = {};
  try {
    const detail = await api.get(`/doctor/patients/${a.patientId}`);
    existing = detail.appointments.find((x) => x.id === a.id) || {};
  } catch (err) {
    return toast(err.message, 'error');
  }
  formModal({
    title: `Visit note: ${a.patientName}`,
    wide: true,
    fields: [
      { name: 'diagnosis', label: 'Diagnosis', required: true, maxlength: 500, value: existing.diagnosis || '', full: true },
      { name: 'notes', label: 'Clinical notes', type: 'textarea', rows: 6, maxlength: 5000, value: existing.notes || '', full: true },
    ],
    onSubmit: async (v) => {
      await api.put(`/doctor/appointments/${a.id}/record`, v);
      toast('Visit note saved');
    },
  });
}

const apptColumns = (reload, withDate = true) => [
  { label: 'When', render: (a) => [fmtTime(a.scheduledAt), withDate && h('span', { class: 'sub' }, fmtDate(a.scheduledAt))] },
  { label: 'Patient', render: (a) => [a.patientName, h('span', { class: 'sub' }, a.medicalRecordNo)] },
  { label: 'Reason', render: (a) => a.reason || '—' },
  { label: 'Status', render: (a) => badge(a.status) },
  { label: '', class: 'actions', render: (a) => appointmentActions(a, reload) },
];

// ------------------------------------------------------------------ dashboard
async function dashboard(c) {
  const load = async () => {
    const d = await api.get('/doctor/dashboard');
    const todayBox = h('div', {}, dataTable(apptColumns(refresh, false), d.todayAppointments, 'No appointments today.'));
    clear(wrap).append(
      h('div', { class: 'stat-grid' }, statCard('Waiting today', d.todayPending, `of ${d.todayTotal} today`), statCard('Upcoming', d.upcoming, 'Open future appointments'), statCard('My patients', d.totalPatients), statCard('Open prescriptions', d.openPrescriptions, 'Pending or partly dispensed')),
      card("Today's schedule", todayBox)
    );
  };
  const wrap = h('div');
  const refresh = () => load().catch((err) => clear(wrap).append(errorState(err, refresh)));
  c.append(pageHeader('My day', fmtDate(todayIso())), wrap);
  await load();
}

// ------------------------------------------------------------------ appointments
async function appointments(c) {
  let list;
  const reload = () => list.reload();
  list = createList({
    search: { placeholder: 'Search patient name' },
    filters: [
      { name: 'from', label: 'From', type: 'date', value: todayIso() },
      { name: 'to', label: 'To', type: 'date' },
      { name: 'status', label: 'Status', options: [['', 'All'], ...['Scheduled', 'Confirmed', 'Completed', 'Cancelled', 'No-Show'].map((s) => [s, s])] },
    ],
    fetch: (s) => api.get('/doctor/appointments', { page: s.page, pageSize: s.pageSize, q: s.q, from: s.from, to: s.to, status: s.status }),
    emptyText: 'No appointments in this range.',
    columns: apptColumns(reload),
  });
  c.append(pageHeader('Appointments', 'Your schedule. Completing a visit lets you record the diagnosis and prescribe.'), card(null, list.el));
}

// ------------------------------------------------------------------ patients
async function patientDetail(id) {
  const body = h('div');
  const modal = openModal({ title: 'Patient', wide: true, body });
  try {
    const p = await api.get(`/doctor/patients/${id}`);
    modal.dialog.setAttribute('aria-label', p.fullName);
    clear(body).append(
      h('dl', { class: 'kv' }, ...[['Name', p.fullName], ['MRN', p.medicalRecordNo], ['Age', `${age(p.dateOfBirth)} years`], ['Gender', p.gender], ['Blood type', p.bloodType || 'Unknown'], ['Phone', p.phone]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))),
      h('div', { class: 'section-title' }, 'Visits with you'),
      dataTable(
        [
          { label: 'Date', render: (a) => fmtDateTime(a.scheduledAt) },
          { label: 'Status', render: (a) => badge(a.status) },
          { label: 'Diagnosis', render: (a) => [a.diagnosis || '—', a.notes && h('span', { class: 'sub' }, a.notes)] },
        ],
        p.appointments,
        'No visits yet.'
      ),
      h('div', { class: 'section-title' }, 'Prescriptions you wrote'),
      dataTable(
        [
          { label: '#', render: (r) => `RX-${r.id}` },
          { label: 'Date', render: (r) => fmtDate(r.createdAt) },
          { label: 'Items', key: 'itemCount' },
          { label: 'Status', render: (r) => badge(r.status) },
          { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', onclick: () => prescriptionDetail(r.id) }, 'Open') },
        ],
        p.prescriptions,
        'No prescriptions yet.'
      ),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn primary', onclick: () => { modal.close(); newPrescription({ id: p.id, name: p.fullName }); } }, 'Write prescription'))
    );
  } catch (err) {
    clear(body).append(errorState(err));
  }
}

async function patients(c) {
  const list = createList({
    search: { placeholder: 'Search name or MRN' },
    fetch: (s) => api.get('/doctor/patients', { page: s.page, pageSize: s.pageSize, q: s.q }),
    emptyText: 'No patients assigned yet. Patients appear here once they have an appointment with you.',
    columns: [
      { label: 'Patient', render: (p) => [p.fullName, h('span', { class: 'sub' }, `${p.medicalRecordNo} · ${age(p.dateOfBirth)} yrs · ${p.gender}`)] },
      { label: 'Last visit', render: (p) => (p.lastVisit ? fmtDate(p.lastVisit) : '—') },
      { label: 'Next visit', render: (p) => (p.nextVisit ? fmtDateTime(p.nextVisit) : '—') },
      { label: 'Appointments', key: 'appointmentCount', class: 'num' },
      { label: '', class: 'actions', render: (p) => [h('button', { class: 'btn sm', onclick: () => patientDetail(p.id) }, 'Open record'), ' ', h('button', { class: 'btn sm primary', onclick: () => newPrescription({ id: p.id, name: p.fullName }) }, 'Prescribe')] },
    ],
  });
  c.append(pageHeader('My patients', 'Only patients who have an appointment with you'), card(null, list.el));
}

// ------------------------------------------------------------------ prescriptions
async function prescriptionDetail(id, onChange) {
  const body = h('div');
  const modal = openModal({ title: `Prescription RX-${id}`, wide: true, body });
  try {
    const rx = await api.get(`/doctor/prescriptions/${id}`);
    clear(body).append(
      h('dl', { class: 'kv' }, ...[['Patient', rx.patientName], ['Written', fmtDateTime(rx.createdAt)]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))), h('div', {}, h('dt', {}, 'Status'), h('dd', {}, badge(rx.status)))),
      rx.notes && h('div', { class: 'note-box' }, rx.notes),
      dataTable(
        [
          { label: 'Medication', render: (i) => [i.medication, h('span', { class: 'sub' }, `${i.strength} · ${i.form}`)] },
          { label: 'Directions', render: (i) => [`${i.dosage}, ${i.frequency}`, h('span', { class: 'sub' }, `${i.durationDays} days${i.instructions ? ` · ${i.instructions}` : ''}`)] },
          { label: 'Dispensed', render: (i) => [`${i.quantityDispensed} / ${i.quantityPrescribed}`, progress(i.quantityDispensed, i.quantityPrescribed)] },
        ],
        rx.items
      ),
      rx.status === 'Pending' &&
        h('div', { class: 'form-actions' }, h('button', { class: 'btn danger', onclick: async () => {
          const ok = await confirmDialog({ title: 'Cancel prescription', message: 'The pharmacist will no longer be able to dispense it.', confirmLabel: 'Cancel prescription', danger: true });
          if (!ok) return;
          try {
            await api.post(`/doctor/prescriptions/${id}/cancel`);
            toast('Prescription cancelled');
            modal.close();
            if (onChange) onChange();
          } catch (err) {
            toast(err.message, 'error');
          }
        } }, 'Cancel prescription'))
    );
  } catch (err) {
    clear(body).append(errorState(err));
  }
}

function medicationRow(onRemove, canRemove) {
  const search = h('input', { type: 'search', placeholder: 'Type to search medications…', 'aria-label': 'Search medication', maxlength: 100 });
  const select = h('select', { 'aria-label': 'Medication' }, h('option', { value: '' }, '— search above, then select —'));
  const dosage = h('input', { placeholder: 'Dose, e.g. 1 tablet', 'aria-label': 'Dosage', maxlength: 60 });
  const frequency = h('input', { placeholder: 'e.g. Twice daily', 'aria-label': 'Frequency', maxlength: 60 });
  const days = h('input', { type: 'number', min: 1, max: 365, placeholder: 'Days', 'aria-label': 'Duration in days' });
  const qty = h('input', { type: 'number', min: 1, max: 1000, placeholder: 'Qty', 'aria-label': 'Quantity to dispense' });
  const instructions = h('input', { placeholder: 'Instructions (optional)', 'aria-label': 'Instructions', maxlength: 255 });
  search.addEventListener('input', debounce(async () => {
    try {
      const res = await api.get('/doctor/medications', { q: search.value.trim() });
      const keep = select.value;
      clear(select).append(h('option', { value: '' }, res.data.length ? '— select —' : 'No match'), ...res.data.map((m) => h('option', { value: m.id }, `${m.name} ${m.strength} (${m.form})`)));
      select.value = keep;
    } catch (err) {
      toast(err.message, 'error');
    }
  }, 300));
  search.dispatchEvent(new Event('input'));
  const el = h('div', { class: 'card', style: { padding: '0.8rem', marginBottom: '0' } },
    h('div', { class: 'form' }, h('div', { class: 'field' }, search), h('div', { class: 'field' }, select), h('div', { class: 'field' }, dosage), h('div', { class: 'field' }, frequency), h('div', { class: 'field' }, days), h('div', { class: 'field' }, qty), h('div', { class: 'field full' }, instructions)),
    canRemove && h('div', { class: 'form-actions' }, h('button', { class: 'btn sm', type: 'button', onclick: () => onRemove(el) }, 'Remove medication')));
  el.read = () => ({ medicationId: select.value, dosage: dosage.value.trim(), frequency: frequency.value.trim(), durationDays: days.value, quantity: qty.value, instructions: instructions.value.trim() });
  return el;
}

async function newPrescription(patient, onCreated) {
  let patientId = patient ? patient.id : '';
  const banner = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const patientBlock = [];
  if (patient) {
    patientBlock.push(h('div', {}, h('div', { class: 'section-title' }, 'Patient'), h('strong', {}, patient.name)));
  } else {
    let res;
    try {
      res = await api.get('/doctor/patients', { pageSize: 100 });
    } catch (err) {
      return toast(err.message, 'error');
    }
    if (!res.data.length) return toast('You have no assigned patients yet.', 'error');
    const sel = h('select', { 'aria-label': 'Patient' }, h('option', { value: '' }, '— select a patient —'), res.data.map((p) => h('option', { value: p.id }, `${p.fullName} (${p.medicalRecordNo})`)));
    sel.addEventListener('change', () => { patientId = sel.value; });
    patientBlock.push(h('div', { class: 'field' }, h('label', {}, 'Patient', h('span', { class: 'req' }, ' *')), sel));
  }
  const notes = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Notes for the pharmacist (optional)', 'aria-label': 'Notes' });
  const rows = h('div', { style: { display: 'grid', gap: '0.7rem' } });
  const rowEls = [];
  const addRow = () => {
    const row = medicationRow((el) => { rowEls.splice(rowEls.indexOf(el), 1); el.remove(); rowEls.forEach((r) => r.refresh && r.refresh()); }, rowEls.length > 0);
    rowEls.push(row);
    rows.append(row);
  };
  addRow();
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Send to pharmacy');
  const form = h('form', { novalidate: true, class: 'modal-body', style: { padding: '0' } },
    patientBlock, rows,
    h('button', { class: 'btn', type: 'button', onclick: addRow }, '+ Add another medication'),
    h('div', { class: 'field' }, h('label', {}, 'Notes'), notes), banner,
    h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => modal.close() }, 'Cancel'), submit));
  const modal = openModal({ title: 'New prescription', wide: true, body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    banner.hidden = true;
    const fail = (m) => { banner.hidden = false; banner.textContent = m; };
    if (!patientId) return fail('Please select a patient.');
    const items = rowEls.map((r) => r.read());
    for (const [i, it] of items.entries()) {
      if (!it.medicationId || !it.dosage || !it.frequency || !it.durationDays || !it.quantity) return fail(`Medication ${i + 1}: choose a medication and fill dose, frequency, days and quantity.`);
    }
    submit.disabled = true;
    try {
      const body = { patientId: Number(patientId), notes: notes.value.trim() || undefined, items: items.map((it) => ({ ...it, medicationId: Number(it.medicationId), instructions: it.instructions || undefined })) };
      await api.post('/doctor/prescriptions', body);
      modal.close();
      toast('Prescription sent to the pharmacy');
      if (onCreated) onCreated();
    } catch (err) {
      const d = (err.details || []).map((x) => `${x.field}: ${x.message}`).join('; ');
      fail(d ? `${err.message}. ${d}` : err.message);
    } finally {
      submit.disabled = false;
    }
  });
}

async function prescriptions(c) {
  let list;
  list = createList({
    search: { placeholder: 'Search patient name' },
    filters: [{ name: 'status', label: 'Status', options: [['', 'All'], ...RX_STATUSES.map((s) => [s, s])] }],
    toolbarExtra: h('button', { class: 'btn primary', onclick: () => newPrescription(null, () => list.reload()) }, 'New prescription'),
    fetch: (s) => api.get('/doctor/prescriptions', { page: s.page, pageSize: s.pageSize, q: s.q, status: s.status }),
    emptyText: 'No prescriptions yet.',
    columns: [
      { label: '#', render: (r) => `RX-${r.id}` },
      { label: 'Patient', key: 'patientName' },
      { label: 'Written', render: (r) => fmtDateTime(r.createdAt) },
      { label: 'Items', key: 'itemCount', class: 'num' },
      { label: 'Status', render: (r) => badge(r.status) },
      { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', onclick: () => prescriptionDetail(r.id, () => list.reload()) }, 'Open') },
    ],
  });
  c.append(pageHeader('Prescriptions', 'New prescriptions reach the pharmacist queue immediately'), card(null, list.el));
}

export const pages = [
  { id: 'dashboard', label: 'My day', render: dashboard },
  { id: 'appointments', label: 'Appointments', render: appointments },
  { id: 'patients', label: 'Patients', render: patients },
  { id: 'prescriptions', label: 'Prescriptions', render: prescriptions },
];
