import { api } from '../api.js';
import { h, card, pageHeader, statCard, barList, badge, dataTable, createList, formModal, buildForm, confirmDialog, toast, fmtDateTime, shortDay, num, emptyState } from '../ui.js';

const ROLES = ['Admin', 'Doctor', 'Receptionist', 'Pharmacist', 'Patient'];

// ------------------------------------------------------------------ dashboard
async function dashboard(c) {
  const s = await api.get('/admin/stats');
  const ph = s.pharmacy;
  c.append(
    pageHeader('Hospital overview', 'Live figures from the system'),
    h('div', { class: 'stat-grid' }, statCard('Patients', s.totalPatients), statCard('Doctors', s.totalDoctors), statCard('Employees', s.totalEmployees, 'Active staff accounts'), statCard('Appointments', s.totalAppointments, `${num(s.appointmentsToday)} today`)),
    h(
      'div',
      { class: 'grid2' },
      card('Appointments, last 7 days', barList(s.appointmentsPerDay.map((d) => ({ label: shortDay(d.day), value: d.count })))),
      card('Appointments by status', barList(s.appointmentsByStatus.map((d) => ({ label: d.status, value: d.count })), 'No appointments yet'))
    ),
    h(
      'div',
      { class: 'grid2' },
      card('Active users by role', barList(s.usersByRole.map((d) => ({ label: d.role, value: d.count })))),
      card('Doctors by department', barList(s.doctorsByDepartment.map((d) => ({ label: d.department, value: d.doctors }))))
    ),
    card(
      'Pharmacy',
      h(
        'div',
        { class: 'stat-grid' },
        statCard('Medications', ph.totalMedications),
        statCard('Units in stock', ph.availableStock),
        statCard('Low stock', ph.lowStockMedications, 'At or below reorder level', ph.lowStockMedications ? 'warn' : ''),
        statCard('With expired stock', ph.expiredMedications, `${num(ph.expiredUnits)} units`, ph.expiredMedications ? 'danger' : ''),
        statCard('Pending prescriptions', ph.pendingPrescriptions),
        statCard('Partially dispensed', ph.partiallyDispensedPrescriptions),
        statCard('Completed', ph.completedPrescriptions),
        statCard('Dispensed today', ph.dispensedToday)
      )
    ),
    card(
      'Recent system activity',
      dataTable(
        [
          { label: 'When', render: (r) => fmtDateTime(r.createdAt) },
          { label: 'User', render: (r) => r.userName || 'System' },
          { label: 'Action', render: (r) => r.action },
          { label: 'Entity', render: (r) => (r.entityType ? `${r.entityType} #${r.entityId}` : '—') },
        ],
        s.recentActivity,
        'No activity yet.'
      )
    )
  );
}

// ------------------------------------------------------------------ users
async function users(c) {
  const [deptRes, specRes] = await Promise.all([api.get('/admin/departments'), api.get('/admin/specialties')]);
  const depts = deptRes.data;
  const specs = specRes.data;
  const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name || '—';
  const activeOptions = (list) => list.filter((x) => x.isActive).map((x) => [x.id, x.name]);
  let list;

  const detail = (u) => {
    if (u.role === 'Doctor') return [nameOf(depts, u.departmentId), h('span', { class: 'sub' }, `${nameOf(specs, u.specialtyId)} · ${u.doctorLicense}`)];
    if (u.role === 'Pharmacist') return h('span', {}, `License ${u.pharmacistLicense}`);
    if (u.role === 'Receptionist') return h('span', {}, u.employeeNo);
    return '—';
  };

  const createFields = [
    { name: 'role', label: 'Role', type: 'select', required: true, options: ['Admin', 'Doctor', 'Receptionist', 'Pharmacist'].map((r) => [r, r]), placeholder: '— select a role —', full: true },
    { name: 'fullName', label: 'Full name', required: true, maxlength: 120 },
    { name: 'email', label: 'Email', type: 'email', required: true, maxlength: 255 },
    { name: 'phone', label: 'Phone', type: 'tel' },
    { name: 'password', label: 'Initial password', type: 'password', required: true, hint: '10+ characters, upper and lower case, one digit.' },
    { name: 'departmentId', label: 'Department', type: 'select', options: activeOptions(depts), required: true, showIf: { role: ['Doctor'] } },
    { name: 'specialtyId', label: 'Specialty', type: 'select', options: activeOptions(specs), required: true, showIf: { role: ['Doctor'] } },
    { name: 'licenseNo', label: 'License number', required: true, maxlength: 40, showIf: { role: ['Doctor', 'Pharmacist'] } },
    { name: 'consultationFee', label: 'Consultation fee (BHD)', type: 'number', min: 0, step: '0.5', showIf: { role: ['Doctor'] } },
    { name: 'employeeNo', label: 'Employee number', maxlength: 30, hint: 'Generated if left empty', showIf: { role: ['Receptionist'] } },
  ];

  const edit = (u) => {
    const f = [
      { name: 'fullName', label: 'Full name', required: true, value: u.fullName },
      { name: 'email', label: 'Email', type: 'email', required: true, value: u.email },
      { name: 'phone', label: 'Phone', type: 'tel', value: u.phone || '' },
    ];
    if (u.role === 'Doctor') {
      f.push(
        { name: 'departmentId', label: 'Department', type: 'select', required: true, options: depts.map((d) => [d.id, d.name]), value: u.departmentId },
        { name: 'specialtyId', label: 'Specialty', type: 'select', required: true, options: specs.map((d) => [d.id, d.name]), value: u.specialtyId },
        { name: 'licenseNo', label: 'License number', required: true, value: u.doctorLicense },
        { name: 'consultationFee', label: 'Consultation fee (BHD)', type: 'number', min: 0, step: '0.5', value: u.consultationFee }
      );
    }
    if (u.role === 'Pharmacist') f.push({ name: 'licenseNo', label: 'License number', required: true, value: u.pharmacistLicense });
    if (u.role === 'Receptionist') f.push({ name: 'employeeNo', label: 'Employee number', required: true, value: u.employeeNo });
    formModal({
      title: `Edit ${u.fullName}`,
      fields: f,
      onSubmit: async (values) => {
        await api.put(`/admin/users/${u.id}`, values);
        toast('User updated');
        list.reload();
      },
    });
  };

  const toggle = async (u) => {
    const deactivate = u.isActive;
    const ok = await confirmDialog({
      title: deactivate ? 'Deactivate account' : 'Reactivate account',
      message: deactivate ? `${u.fullName} will be signed out and can no longer log in. Their history is kept.` : `${u.fullName} will be able to log in again.`,
      confirmLabel: deactivate ? 'Deactivate' : 'Reactivate',
      danger: deactivate,
    });
    if (!ok) return;
    try {
      await api.post(`/admin/users/${u.id}/${deactivate ? 'deactivate' : 'activate'}`);
      toast(deactivate ? 'Account deactivated' : 'Account reactivated');
      list.reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const resetPassword = (u) =>
    formModal({
      title: `Reset password for ${u.fullName}`,
      submitLabel: 'Set new password',
      fields: [{ name: 'newPassword', label: 'New password', type: 'password', required: true, full: true, hint: '10+ characters, upper and lower case, one digit.' }],
      onSubmit: async (values) => {
        await api.post(`/admin/users/${u.id}/reset-password`, values);
        toast('Password reset');
      },
    });

  list = createList({
    search: { placeholder: 'Search name or email' },
    filters: [
      { name: 'role', label: 'Role', options: [['', 'All roles'], ...ROLES.map((r) => [r, r])] },
      { name: 'active', label: 'Status', options: [['', 'All'], ['true', 'Active'], ['false', 'Inactive']] },
    ],
    toolbarExtra: h(
      'button',
      {
        class: 'btn primary',
        onclick: () =>
          formModal({
            title: 'Add user',
            fields: createFields,
            wide: true,
            onSubmit: async (values) => {
              await api.post('/admin/users', values);
              toast('User created');
              list.reload();
            },
          }),
      },
      'Add user'
    ),
    fetch: (s) => api.get('/admin/users', { page: s.page, pageSize: s.pageSize, q: s.q, role: s.role, active: s.active }),
    columns: [
      { label: 'Name', render: (u) => [u.fullName, h('span', { class: 'sub' }, u.email)] },
      { label: 'Role', render: (u) => badge(u.role) },
      { label: 'Details', render: detail },
      { label: 'Status', render: (u) => badge(u.isActive ? 'Active' : 'Inactive') },
      { label: 'Last login', render: (u) => (u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : 'Never') },
      {
        label: '',
        class: 'actions',
        render: (u) => [
          u.role !== 'Patient' && h('button', { class: 'btn sm', onclick: () => edit(u) }, 'Edit'),
          ' ',
          h('button', { class: 'btn sm', onclick: () => resetPassword(u) }, 'Reset password'),
          ' ',
          h('button', { class: `btn sm ${u.isActive ? '' : 'primary'}`, onclick: () => toggle(u) }, u.isActive ? 'Deactivate' : 'Reactivate'),
        ],
      },
    ],
  });
  c.append(pageHeader('Users', 'Create staff accounts, change details and control access'), card(null, list.el));
}

// ------------------------------------------------------------------ departments + specialties
function lookupCard({ title, path, singular, withDescription }) {
  const body = h('div');
  const addBtn = h('button', { class: 'btn primary sm', onclick: () => open() }, `Add ${singular}`);
  const fields = (item = {}) => [
    { name: 'name', label: 'Name', required: true, maxlength: 100, value: item.name || '', full: true },
    withDescription && { name: 'description', label: 'Description', maxlength: 255, value: item.description || '', full: true },
    item.id && { name: 'isActive', label: 'Active', type: 'checkbox', value: item.isActive, hint: 'Inactive items disappear from forms but stay on existing records.' },
  ].filter(Boolean);

  function open(item) {
    formModal({
      title: item ? `Edit ${singular}` : `Add ${singular}`,
      fields: fields(item),
      onSubmit: async (values) => {
        if (item) await api.put(`/admin/${path}/${item.id}`, values);
        else await api.post(`/admin/${path}`, values);
        toast('Saved');
        load();
      },
    });
  }
  async function load() {
    const res = await api.get(`/admin/${path}`);
    body.replaceChildren(
      dataTable(
        [
          { label: 'Name', key: 'name' },
          withDescription && { label: 'Description', render: (r) => r.description || '—' },
          { label: 'Status', render: (r) => badge(r.isActive ? 'Active' : 'Inactive') },
          { label: '', class: 'actions', render: (r) => h('button', { class: 'btn sm', onclick: () => open(r) }, 'Edit') },
        ].filter(Boolean),
        res.data,
        `No ${title.toLowerCase()} yet.`
      )
    );
  }
  load().catch((err) => body.append(emptyState(err.message)));
  return card(title, body, addBtn);
}

async function structure(c) {
  c.append(
    pageHeader('Departments and specialties', 'Used when adding doctors and booking appointments'),
    lookupCard({ title: 'Departments', path: 'departments', singular: 'department', withDescription: true }),
    lookupCard({ title: 'Specialties', path: 'specialties', singular: 'specialty', withDescription: false })
  );
}

// ------------------------------------------------------------------ settings
async function settings(c) {
  const s = await api.get('/admin/settings');
  const { form } = buildForm({
    submitLabel: 'Save settings',
    fields: [
      { name: 'hospital_name', label: 'Hospital name', required: true, value: s.hospital_name, full: true },
      { name: 'clinic_open', label: 'Clinic opens', type: 'time', required: true, value: s.clinic_open },
      { name: 'clinic_close', label: 'Clinic closes', type: 'time', required: true, value: s.clinic_close },
      { name: 'appointment_duration_minutes', label: 'Appointment length (minutes)', type: 'number', min: 10, max: 120, step: 5, required: true, value: s.appointment_duration_minutes, hint: 'Also the spacing of bookable time slots.' },
      { name: 'cancellation_window_hours', label: 'Patient cancellation window (hours)', type: 'number', min: 0, max: 168, required: true, value: s.cancellation_window_hours, hint: 'Patients cannot cancel closer to the appointment than this.' },
      { name: 'default_reorder_level', label: 'Default low-stock level (units)', type: 'number', min: 0, required: true, value: s.default_reorder_level, hint: 'Used for new medications when no level is given.' },
    ],
    onSubmit: async (values) => {
      await api.put('/admin/settings', values);
      toast('Settings saved');
    },
  });
  c.append(pageHeader('System settings', 'Changes apply immediately to new bookings'), card(null, form));
}

// ------------------------------------------------------------------ audit logs
const ACTIONS = ['LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'USER_CREATED', 'USER_UPDATED', 'USER_ACTIVATED', 'USER_DEACTIVATED', 'PATIENT_REGISTERED', 'PATIENT_UPDATED', 'PATIENT_RECORD_VIEWED', 'APPOINTMENT_BOOKED', 'APPOINTMENT_RESCHEDULED', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_STATUS_CHANGED', 'MEDICAL_RECORD_SAVED', 'PRESCRIPTION_CREATED', 'PRESCRIPTION_VIEWED', 'PRESCRIPTION_CANCELLED', 'PRESCRIPTION_DISPENSED', 'MEDICATION_CREATED', 'MEDICATION_UPDATED', 'STOCK_RECEIVED', 'STOCK_ADJUSTED', 'SETTINGS_UPDATED'];

async function audit(c) {
  const short = (d) => {
    if (!d) return '—';
    const text = JSON.stringify(d);
    return h('span', { title: text }, text.length > 70 ? `${text.slice(0, 70)}…` : text);
  };
  const list = createList({
    pageSize: 15,
    filters: [
      { name: 'action', label: 'Action', options: [['', 'All actions'], ...ACTIONS.map((a) => [a, a])] },
      { name: 'from', label: 'From', type: 'date' },
      { name: 'to', label: 'To', type: 'date' },
    ],
    fetch: (s) => api.get('/admin/audit-logs', { page: s.page, pageSize: s.pageSize, action: s.action, from: s.from, to: s.to }),
    columns: [
      { label: 'When', render: (r) => fmtDateTime(r.createdAt) },
      { label: 'User', render: (r) => (r.userName ? [r.userName, h('span', { class: 'sub' }, r.userRole)] : 'Anonymous') },
      { label: 'Action', render: (r) => r.action },
      { label: 'Entity', render: (r) => (r.entityType ? `${r.entityType} #${r.entityId}` : '—') },
      { label: 'Details', render: (r) => short(r.details) },
      { label: 'IP', render: (r) => r.ipAddress || '—' },
    ],
    emptyText: 'No audit entries match.',
  });
  c.append(pageHeader('Audit log', 'Who did what and when. Read only.'), card(null, list.el));
}

export const pages = [
  { id: 'dashboard', label: 'Dashboard', render: dashboard },
  { id: 'users', label: 'Users', render: users },
  { id: 'structure', label: 'Departments & specialties', render: structure },
  { id: 'settings', label: 'Settings', render: settings },
  { id: 'audit', label: 'Audit log', render: audit },
];
