import { api } from '../api.js';
import { h, card, pageHeader, badge, createList, formModal, confirmDialog, toast, fmtDate, fmtDateTime, fmtTime, todayIso, age } from '../ui.js';
import { openBookingModal, openRescheduleModal } from '../booking.js';

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((b) => [b, b]);

// ------------------------------------------------------------------ patients
function patientFields(p = {}) {
  return [
    { name: 'fullName', label: 'Full name', required: true, maxlength: 120, value: p.fullName || '' },
    { name: 'dateOfBirth', label: 'Date of birth', type: 'date', required: true, max: todayIso(), value: p.dateOfBirth || '' },
    { name: 'gender', label: 'Gender', type: 'select', required: true, options: [['Male', 'Male'], ['Female', 'Female']], value: p.gender || '', placeholder: '— select —' },
    { name: 'phone', label: 'Phone', type: 'tel', required: true, value: p.phone || '' },
    { name: 'email', label: 'Email', type: 'email', value: p.email || '' },
    { name: 'bloodType', label: 'Blood type', type: 'select', options: BLOOD, value: p.bloodType || '', placeholder: 'Unknown' },
    { name: 'address', label: 'Address', maxlength: 255, value: p.address || '', full: true },
    { name: 'emergencyContactName', label: 'Emergency contact', maxlength: 120, value: p.emergencyContactName || '' },
    { name: 'emergencyContactPhone', label: 'Emergency contact phone', type: 'tel', value: p.emergencyContactPhone || '' },
  ];
}

async function patients(c) {
  let list;
  const register = () =>
    formModal({
      title: 'Register a new patient',
      wide: true,
      submitLabel: 'Register patient',
      fields: [
        ...patientFields(),
        { name: 'createAccount', label: 'Create a patient portal login', type: 'checkbox', full: true, hint: 'Lets the patient view appointments and prescriptions online.' },
        { name: 'accountEmail', label: 'Portal email', type: 'email', required: true, showIf: { createAccount: ['true'] } },
        { name: 'accountPassword', label: 'Initial password', type: 'password', required: true, showIf: { createAccount: ['true'] }, hint: '10+ characters, upper and lower case, one digit.' },
      ],
      onSubmit: async (v) => {
        const { createAccount, accountEmail, accountPassword, ...body } = v;
        if (createAccount) body.account = { email: accountEmail, password: accountPassword };
        const created = await api.post('/receptionist/patients', body);
        toast(`Registered ${created.fullName} (${created.medicalRecordNo})`);
        list.reload();
      },
    });

  const edit = (p) =>
    formModal({
      title: `Edit ${p.fullName}`,
      wide: true,
      fields: patientFields(p),
      onSubmit: async (v) => {
        await api.put(`/receptionist/patients/${p.id}`, v);
        toast('Patient updated');
        list.reload();
      },
    });

  list = createList({
    search: { placeholder: 'Search name, phone or MRN' },
    toolbarExtra: h('button', { class: 'btn primary', onclick: register }, 'Register patient'),
    fetch: (s) => api.get('/receptionist/patients', { page: s.page, pageSize: s.pageSize, q: s.q }),
    emptyText: 'No patients found.',
    columns: [
      { label: 'MRN', key: 'medicalRecordNo' },
      { label: 'Patient', render: (p) => [p.fullName, h('span', { class: 'sub' }, `${fmtDate(p.dateOfBirth)} · ${age(p.dateOfBirth)} yrs`)] },
      { label: 'Gender', key: 'gender' },
      { label: 'Phone', key: 'phone' },
      { label: 'Portal', render: (p) => badge(p.isPortalUser ? 'Active' : 'None', p.isPortalUser ? 'green' : 'grey') },
      {
        label: '',
        class: 'actions',
        render: (p) => [h('button', { class: 'btn sm', onclick: () => edit(p) }, 'Edit'), ' ', h('button', { class: 'btn sm primary', onclick: () => openBookingModal({ patient: { id: p.id, name: p.fullName }, onBooked: () => toast('Open the Appointments tab to see it') }) }, 'Book')],
      },
    ],
  });
  c.append(pageHeader('Patients', 'Register, search and update patient details'), card(null, list.el));
}

// ------------------------------------------------------------------ appointments
async function appointments(c) {
  const doctors = (await api.get('/directory/doctors')).data;
  let list;
  const reload = () => list.reload();

  const setStatus = async (a, status, verb) => {
    if (status === 'No-Show') {
      const ok = await confirmDialog({ title: 'Mark as no-show', message: `${a.patientName} did not attend. This frees the time slot.`, confirmLabel: 'Mark no-show', danger: true });
      if (!ok) return;
    }
    try {
      await api.put(`/receptionist/appointments/${a.id}/status`, { status });
      toast(`Appointment ${verb}`);
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const cancel = (a) =>
    formModal({
      title: `Cancel appointment for ${a.patientName}`,
      submitLabel: 'Cancel appointment',
      fields: [{ name: 'reason', label: 'Reason (optional)', type: 'textarea', maxlength: 255, full: true }],
      onSubmit: async (v) => {
        await api.post(`/receptionist/appointments/${a.id}/cancel`, v);
        toast('Appointment cancelled');
        reload();
      },
    });

  list = createList({
    search: { placeholder: 'Search patient name or MRN' },
    filters: [
      { name: 'date', label: 'Date', type: 'date', value: todayIso() },
      { name: 'doctorId', label: 'Doctor', options: [['', 'All doctors'], ...doctors.map((d) => [d.id, d.fullName])] },
      { name: 'status', label: 'Status', options: [['', 'All'], ...['Scheduled', 'Confirmed', 'Completed', 'Cancelled', 'No-Show'].map((s) => [s, s])] },
    ],
    toolbarExtra: h('button', { class: 'btn primary', onclick: () => openBookingModal({ onBooked: reload }) }, 'Book appointment'),
    fetch: (s) => api.get('/receptionist/appointments', { page: s.page, pageSize: s.pageSize, q: s.q, date: s.date, doctorId: s.doctorId, status: s.status }),
    emptyText: 'No appointments match. Clear the date filter to see all.',
    columns: [
      { label: 'When', render: (a) => [fmtTime(a.scheduledAt), h('span', { class: 'sub' }, fmtDate(a.scheduledAt))] },
      { label: 'Patient', render: (a) => [a.patientName, h('span', { class: 'sub' }, a.medicalRecordNo)] },
      { label: 'Doctor', render: (a) => [a.doctorName, h('span', { class: 'sub' }, a.department)] },
      { label: 'Status', render: (a) => badge(a.status) },
      { label: 'Reason', render: (a) => a.reason || '—' },
      {
        label: '',
        class: 'actions',
        render: (a) => {
          if (!['Scheduled', 'Confirmed'].includes(a.status)) return a.cancelReason ? h('span', { class: 'sub', title: a.cancelReason }, 'Reason noted') : '';
          return [
            a.status === 'Scheduled' && h('button', { class: 'btn sm primary', onclick: () => setStatus(a, 'Confirmed', 'confirmed') }, 'Confirm'),
            ' ',
            h('button', { class: 'btn sm', onclick: () => openRescheduleModal({ appointment: a, onDone: reload }) }, 'Reschedule'),
            ' ',
            h('button', { class: 'btn sm', onclick: () => setStatus(a, 'No-Show', 'marked as no-show') }, 'No-show'),
            ' ',
            h('button', { class: 'btn sm', onclick: () => cancel(a) }, 'Cancel'),
          ];
        },
      },
    ],
  });
  c.append(pageHeader('Appointments', 'Book, move and manage the schedule'), card(null, list.el));
}

export const pages = [
  { id: 'appointments', label: 'Appointments', render: appointments },
  { id: 'patients', label: 'Patients', render: patients },
];
