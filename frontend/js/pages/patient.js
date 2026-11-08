import { api } from '../api.js';
import { h, clear, card, pageHeader, statCard, badge, dataTable, createList, buildForm, openModal, confirmDialog, formModal, toast, fmtDate, fmtDateTime, fmtTime, age, errorState } from '../ui.js';
import { openBookingModal, getScheduling } from '../booking.js';

const STATUS_TEXT = {
  Pending: 'Your prescription has been sent to the pharmacy and is waiting to be prepared.',
  'Partially Dispensed': 'Part of your prescription has been handed out. The rest is waiting at the pharmacy.',
  Dispensed: 'Your prescription has been fully dispensed.',
  Cancelled: 'This prescription was cancelled by your doctor.',
};

const progress = (done, total) => {
  const fill = h('span');
  fill.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
  return h('div', { class: 'progress', title: `${done} of ${total}` }, fill);
};

async function openPrescription(id) {
  const body = h('div');
  const modal = openModal({ title: `Prescription RX-${id}`, wide: true, body });
  try {
    const rx = await api.get(`/patient/prescriptions/${id}`);
    clear(body).append(
      h('dl', { class: 'kv' }, ...[['Doctor', `${rx.doctorName}, ${rx.department}`], ['Written', fmtDateTime(rx.createdAt)]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))), h('div', {}, h('dt', {}, 'Status'), h('dd', {}, badge(rx.status)))),
      h('div', { class: 'note-box' }, STATUS_TEXT[rx.status]),
      rx.notes && h('p', {}, h('strong', {}, 'Doctor’s note: '), rx.notes),
      dataTable(
        [
          { label: 'Medication', render: (i) => [i.medication, h('span', { class: 'sub' }, `${i.strength} · ${i.form}`)] },
          { label: 'How to take it', render: (i) => [`${i.dosage}, ${i.frequency}`, h('span', { class: 'sub' }, `For ${i.durationDays} days${i.instructions ? ` · ${i.instructions}` : ''}`)] },
          { label: 'Collected', render: (i) => [`${i.quantityDispensed} of ${i.quantityPrescribed}`, progress(i.quantityDispensed, i.quantityPrescribed), i.lastDispensedAt && h('span', { class: 'sub' }, `Last: ${fmtDateTime(i.lastDispensedAt)}`)] },
        ],
        rx.items
      )
    );
  } catch (err) {
    clear(body).append(errorState(err));
  }
  return modal;
}

// ------------------------------------------------------------------ overview
async function overview(c) {
  const [profile, upcoming, rx] = await Promise.all([api.get('/patient/profile'), api.get('/patient/appointments', { scope: 'upcoming', pageSize: 3 }), api.get('/patient/prescriptions', { pageSize: 3 })]);
  const next = upcoming.data[0];
  c.append(
    pageHeader(`Welcome, ${profile.fullName.split(' ')[0]}`, `${profile.medicalRecordNo} · ${age(profile.dateOfBirth)} years`, h('button', { class: 'btn primary', onclick: () => openBookingModal({ asPatient: true, onBooked: () => { location.hash = '#/appointments'; } }) }, 'Book an appointment')),
    h('div', { class: 'stat-grid' }, statCard('Upcoming appointments', upcoming.total), statCard('Prescriptions', rx.total), statCard('Next visit', next ? fmtDate(next.scheduledAt) : 'None booked', next ? `${fmtTime(next.scheduledAt)} with ${next.doctorName}` : 'Book one when you need it')),
    h(
      'div',
      { class: 'grid2' },
      card('Upcoming appointments', dataTable([{ label: 'When', render: (a) => fmtDateTime(a.scheduledAt) }, { label: 'Doctor', render: (a) => [a.doctorName, h('span', { class: 'sub' }, a.department)] }, { label: 'Status', render: (a) => badge(a.status) }], upcoming.data, 'No upcoming appointments.')),
      card('Latest prescriptions', dataTable([{ label: '#', render: (r) => `RX-${r.id}` }, { label: 'Date', render: (r) => fmtDate(r.createdAt) }, { label: 'Status', render: (r) => badge(r.status) }, { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', onclick: () => openPrescription(r.id) }, 'Open') }], rx.data, 'No prescriptions yet.'))
    )
  );
}

// ------------------------------------------------------------------ appointments
async function appointments(c) {
  const scheduling = await getScheduling();
  let list;
  const cancel = async (a) => {
    const ok = await confirmDialog({
      title: 'Cancel appointment',
      message: `Cancel your visit with ${a.doctorName} on ${fmtDateTime(a.scheduledAt)}? Appointments can be cancelled up to ${scheduling.cancellationWindowHours} hours before they start.`,
      confirmLabel: 'Cancel appointment',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/patient/appointments/${a.id}/cancel`);
      toast('Appointment cancelled');
      list.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  list = createList({
    filters: [{ name: 'scope', label: 'Show', value: 'upcoming', options: [['upcoming', 'Upcoming'], ['history', 'History']] }],
    toolbarExtra: h('button', { class: 'btn primary', onclick: () => openBookingModal({ asPatient: true, onBooked: () => list.reload() }) }, 'Book an appointment'),
    fetch: (s) => api.get('/patient/appointments', { page: s.page, pageSize: s.pageSize, scope: s.scope }),
    emptyText: 'No appointments here.',
    columns: [
      { label: 'When', render: (a) => [fmtDate(a.scheduledAt), h('span', { class: 'sub' }, fmtTime(a.scheduledAt))] },
      { label: 'Doctor', render: (a) => [a.doctorName, h('span', { class: 'sub' }, a.department)] },
      { label: 'Reason', render: (a) => a.reason || '—' },
      { label: 'Status', render: (a) => badge(a.status) },
      { label: '', class: 'actions', render: (a) => (['Scheduled', 'Confirmed'].includes(a.status) ? h('button', { class: 'btn sm', onclick: () => cancel(a) }, 'Cancel') : '') },
    ],
  });
  c.append(pageHeader('My appointments'), card(null, list.el));
}

// ------------------------------------------------------------------ prescriptions
async function prescriptions(c) {
  const list = createList({
    fetch: (s) => api.get('/patient/prescriptions', { page: s.page, pageSize: s.pageSize }),
    emptyText: 'You have no prescriptions yet.',
    columns: [
      { label: '#', render: (r) => `RX-${r.id}` },
      { label: 'Date', render: (r) => fmtDate(r.createdAt) },
      { label: 'Doctor', key: 'doctorName' },
      { label: 'Medications', key: 'itemCount', class: 'num' },
      { label: 'Status', render: (r) => badge(r.status) },
      { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', onclick: () => openPrescription(r.id) }, 'Details') },
    ],
  });
  c.append(pageHeader('My prescriptions', 'See what was prescribed and whether the pharmacy has dispensed it'), card(null, list.el));
}

// ------------------------------------------------------------------ visits
async function visits(c) {
  const list = createList({
    fetch: (s) => api.get('/patient/visits', { page: s.page, pageSize: s.pageSize }),
    emptyText: 'No completed visits yet.',
    columns: [
      { label: 'Date', render: (v) => fmtDate(v.scheduledAt) },
      { label: 'Doctor', render: (v) => [v.doctorName, h('span', { class: 'sub' }, v.department)] },
      { label: 'Reason', render: (v) => v.reason || '—' },
      { label: 'Diagnosis', render: (v) => [v.diagnosis || 'Not recorded', v.notes && h('span', { class: 'sub' }, v.notes)] },
    ],
  });
  c.append(pageHeader('Previous visits'), card(null, list.el));
}

// ------------------------------------------------------------------ profile
async function profile(c) {
  const p = await api.get('/patient/profile');
  const { form } = buildForm({
    submitLabel: 'Save changes',
    fields: [
      { name: 'phone', label: 'Phone', type: 'tel', required: true, value: p.phone },
      { name: 'email', label: 'Email', type: 'email', value: p.email || '' },
      { name: 'address', label: 'Address', maxlength: 255, value: p.address || '', full: true },
      { name: 'emergencyContactName', label: 'Emergency contact', maxlength: 120, value: p.emergencyContactName || '' },
      { name: 'emergencyContactPhone', label: 'Emergency contact phone', type: 'tel', value: p.emergencyContactPhone || '' },
    ],
    onSubmit: async (v) => {
      await api.put('/patient/profile', v);
      toast('Profile updated');
    },
  });
  c.append(
    pageHeader('My profile'),
    card('Registered details', h('dl', { class: 'kv' }, ...[['Name', p.fullName], ['MRN', p.medicalRecordNo], ['Date of birth', fmtDate(p.dateOfBirth)], ['Gender', p.gender], ['Blood type', p.bloodType || 'Unknown']].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v)))), h('span', { class: 'muted' }, 'Ask reception to change these')),
    card('Contact details you can update', form)
  );
}

export const pages = [
  { id: 'overview', label: 'Overview', render: overview },
  { id: 'appointments', label: 'Appointments', render: appointments },
  { id: 'prescriptions', label: 'Prescriptions', render: prescriptions },
  { id: 'visits', label: 'Previous visits', render: visits },
  { id: 'profile', label: 'My profile', render: profile },
];
