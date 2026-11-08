import { api, newRequestKey } from '../api.js';
import { h, clear, card, pageHeader, statCard, badge, dataTable, createList, formModal, openModal, confirmDialog, toast, fmtDate, fmtDateTime, money, num, errorState, todayIso } from '../ui.js';

const FORMS = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Cream', 'Drops', 'Inhaler'].map((f) => [f, f]);
const RX_STATUSES = ['Pending', 'Partially Dispensed', 'Dispensed', 'Cancelled'];

const stockBadge = (m) => (m.available === 0 ? badge('Out of stock', 'red') : m.available <= m.reorderLevel ? badge('Low', 'amber') : badge('OK', 'green'));
const expiryCell = (date, expired) => [fmtDate(date), expired && h('span', { class: 'sub' }, badge('Expired', 'red'))];

// ------------------------------------------------------------------ dashboard
async function dashboard(c) {
  const d = await api.get('/pharmacist/dashboard');
  c.append(
    pageHeader('Pharmacy overview', fmtDate(todayIso())),
    h(
      'div',
      { class: 'stat-grid' },
      statCard('Medications', d.totalMedications),
      statCard('Units in stock', d.availableStock, 'Excludes expired'),
      statCard('Low stock', d.lowStockMedications, `${d.outOfStockMedications} out of stock`, d.lowStockMedications ? 'warn' : ''),
      statCard('Expired medications', d.expiredMedications, `${num(d.expiredUnits)} units to remove`, d.expiredMedications ? 'danger' : ''),
      statCard('Pending prescriptions', d.pendingPrescriptions, '', d.pendingPrescriptions ? 'warn' : ''),
      statCard('Partially dispensed', d.partiallyDispensedPrescriptions),
      statCard('Completed', d.completedPrescriptions),
      statCard('Dispensed today', d.dispensedToday)
    ),
    h(
      'div',
      { class: 'grid2' },
      card('Needs reordering', dataTable([{ label: 'Medication', render: (m) => `${m.name} ${m.strength}` }, { label: 'In stock', key: 'available', class: 'num' }, { label: 'Level', key: 'reorderLevel', class: 'num' }], d.lowStock, 'Everything is stocked.')),
      card('Expired or expiring within 30 days', dataTable([{ label: 'Medication', render: (m) => `${m.name} ${m.strength}` }, { label: 'Batch', key: 'batchNo' }, { label: 'Qty', key: 'quantity', class: 'num' }, { label: 'Expiry', render: (m) => expiryCell(m.expiryDate, m.isExpired) }], d.expiring, 'Nothing is expiring soon.'))
    )
  );
}

// ------------------------------------------------------------------ prescriptions + dispensing
async function openPrescription(id, onChange) {
  const body = h('div', { class: 'modal-body', style: { padding: '0' } });
  const modal = openModal({ title: `Prescription RX-${id}`, wide: true, body, onClose: onChange });
  let requestKey = newRequestKey(); // identifies this dispensing attempt: a double click or retry can never deduct twice

  async function load() {
    try {
      const rx = await api.get(`/pharmacist/prescriptions/${id}`);
      const closed = rx.status === 'Cancelled' || rx.status === 'Dispensed';
      const inputs = new Map();
      const banner = h('div', { class: 'form-error', role: 'alert', hidden: true });

      const rows = rx.items.map((i) => {
        const max = Math.min(i.remaining, i.availableStock);
        const blocked = closed || i.remaining === 0 || !i.isActive || max === 0;
        const input = h('input', { type: 'number', class: 'qty-input', min: 0, max, value: 0, disabled: blocked, 'aria-label': `Quantity of ${i.medication} to dispense` });
        inputs.set(i.id, { input, max, blocked });
        const reason = closed ? '' : i.remaining === 0 ? 'Done' : !i.isActive ? 'Inactive' : i.availableStock === 0 ? 'No valid stock' : '';
        return { i, input, max, blocked, reason };
      });

      const fillAll = () => rows.forEach((r) => { if (!r.blocked) r.input.value = r.max; });
      const submit = h('button', { class: 'btn primary', type: 'button', disabled: closed || rows.every((r) => r.blocked) }, 'Dispense selected');
      const fillBtn = h('button', { class: 'btn', type: 'button', disabled: closed, onclick: fillAll }, 'Fill maximum');

      submit.addEventListener('click', async () => {
        banner.hidden = true;
        const items = rows.filter((r) => !r.blocked && Number(r.input.value) > 0).map((r) => ({ itemId: r.i.id, quantity: Number(r.input.value) }));
        const over = rows.find((r) => !r.blocked && Number(r.input.value) > r.max);
        if (!items.length) { banner.hidden = false; banner.textContent = 'Enter a quantity for at least one medication.'; return; }
        if (over) { banner.hidden = false; banner.textContent = `${over.i.medication}: the most you can dispense now is ${over.max}.`; return; }
        submit.disabled = true;
        try {
          const res = await api.post(`/pharmacist/prescriptions/${id}/dispense`, { requestKey, items });
          requestKey = newRequestKey();
          toast(res.duplicate ? 'This request was already processed. Nothing was deducted twice.' : `Dispensed. Status: ${res.status}`);
          await load();
        } catch (err) {
          banner.hidden = false;
          banner.textContent = err.message; // the request was rejected and rolled back, so the same key stays valid for a retry
          submit.disabled = false;
        }
      });

      clear(body).append(
        h('dl', { class: 'kv' }, ...[['Patient', `${rx.patientName} (${rx.medicalRecordNo})`], ['Date of birth', fmtDate(rx.dateOfBirth)], ['Prescribed by', `${rx.doctorName}, ${rx.department}`], ['Written', fmtDateTime(rx.createdAt)]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))), h('div', {}, h('dt', {}, 'Status'), h('dd', {}, badge(rx.status)))),
        rx.notes && h('div', { class: 'note-box' }, `Doctor's note: ${rx.notes}`),
        h('p', { class: 'muted' }, 'Prescriptions are written by doctors and cannot be edited here. Dispensing records what you hand over and deducts stock from the earliest-expiring valid batch.'),
        dataTable(
          [
            { label: 'Medication', render: ({ i }) => [i.medication, h('span', { class: 'sub' }, `${i.strength} · ${i.form} · ${money(i.unitPrice)}`)] },
            { label: 'Directions', render: ({ i }) => [`${i.dosage}, ${i.frequency}`, h('span', { class: 'sub' }, `${i.durationDays} days${i.instructions ? ` · ${i.instructions}` : ''}`)] },
            { label: 'Dispensed', class: 'num', render: ({ i }) => `${i.quantityDispensed} / ${i.quantityPrescribed}` },
            { label: 'Valid stock', class: 'num', render: ({ i }) => num(i.availableStock) },
            { label: 'Dispense now', class: 'num', render: (r) => [r.input, r.reason && h('span', { class: 'sub' }, r.reason)] },
          ],
          rows
        ),
        banner,
        h('div', { class: 'form-actions' }, fillBtn, submit),
        h('div', { class: 'section-title' }, 'Dispensing history'),
        dataTable(
          [
            { label: 'When', render: (d) => fmtDateTime(d.dispensedAt) },
            { label: 'Medication', key: 'medication' },
            { label: 'Batch', key: 'batchNo' },
            { label: 'Qty', key: 'quantity', class: 'num' },
            { label: 'Pharmacist', key: 'pharmacistName' },
          ],
          rx.dispensing,
          'Nothing dispensed yet.'
        )
      );
    } catch (err) {
      clear(body).append(errorState(err, load));
    }
  }
  await load();
  return modal;
}

async function prescriptions(c) {
  const list = createList({
    search: { placeholder: 'Search patient name or MRN' },
    filters: [{ name: 'status', label: 'Status', value: 'Open', options: [['Open', 'Open (pending + partial)'], ['', 'All'], ...RX_STATUSES.map((s) => [s, s])] }],
    fetch: (s) => api.get('/pharmacist/prescriptions', { page: s.page, pageSize: s.pageSize, q: s.q, status: s.status }),
    emptyText: 'No prescriptions match.',
    columns: [
      { label: '#', render: (r) => `RX-${r.id}` },
      { label: 'Patient', render: (r) => [r.patientName, h('span', { class: 'sub' }, r.medicalRecordNo)] },
      { label: 'Doctor', key: 'doctorName' },
      { label: 'Received', render: (r) => fmtDateTime(r.createdAt) },
      { label: 'Items', key: 'itemCount', class: 'num' },
      { label: 'Status', render: (r) => badge(r.status) },
      { label: '', class: 'actions', render: (r) => h('button', { class: `btn sm ${['Pending', 'Partially Dispensed'].includes(r.status) ? 'primary' : ''}`, onclick: () => openPrescription(r.id, () => list.reload()) }, ['Pending', 'Partially Dispensed'].includes(r.status) ? 'Review & dispense' : 'View') },
    ],
  });
  c.append(pageHeader('Prescriptions', 'Oldest first, so nobody waits longer than necessary'), card(null, list.el));
}

// ------------------------------------------------------------------ medications
function medFields(m = {}) {
  return [
    { name: 'name', label: 'Name', required: true, maxlength: 120, value: m.name || '' },
    { name: 'genericName', label: 'Generic name', maxlength: 120, value: m.genericName || '' },
    { name: 'form', label: 'Form', type: 'select', required: true, options: FORMS, value: m.form || '', placeholder: '— select —' },
    { name: 'strength', label: 'Strength', required: true, maxlength: 40, value: m.strength || '', placeholder: 'e.g. 500 mg' },
    { name: 'unitPrice', label: 'Unit price (BHD)', type: 'number', min: 0, step: '0.01', required: true, value: m.unitPrice ?? '' },
    { name: 'reorderLevel', label: 'Low-stock level (units)', type: 'number', min: 0, value: m.reorderLevel ?? '', hint: m.id ? '' : 'Uses the system default if empty' },
  ];
}

async function medications(c) {
  let list;
  const reload = () => list.reload();
  const receive = (m) =>
    formModal({
      title: `Receive stock: ${m.name} ${m.strength}`,
      fields: [
        { name: 'batchNo', label: 'Batch number', required: true, maxlength: 40 },
        { name: 'quantity', label: 'Quantity received', type: 'number', min: 1, required: true },
        { name: 'expiryDate', label: 'Expiry date', type: 'date', required: true, full: true, hint: 'Stock that is already expired cannot be received.' },
      ],
      onSubmit: async (v) => {
        await api.post('/pharmacist/inventory', { ...v, medicationId: m.id });
        toast('Stock received');
        reload();
      },
    });
  const toggle = async (m) => {
    const off = m.isActive;
    if (off && !(await confirmDialog({ title: 'Deactivate medication', message: `${m.name} ${m.strength} can no longer be prescribed or dispensed. History is kept.`, confirmLabel: 'Deactivate', danger: true }))) return;
    try {
      await api.post(`/pharmacist/medications/${m.id}/${off ? 'deactivate' : 'activate'}`);
      toast(off ? 'Medication deactivated' : 'Medication activated');
      reload();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const remove = async (m) => {
    if (!(await confirmDialog({ title: 'Delete medication', message: `Permanently delete ${m.name} ${m.strength}? This only works if it was never stocked or prescribed. Otherwise deactivate it.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/pharmacist/medications/${m.id}`);
      toast('Medication deleted');
      reload();
    } catch (err) {
      toast(err.code === 'IN_USE' ? 'It has stock or prescriptions on record. Deactivate it instead.' : err.message, 'error');
    }
  };

  list = createList({
    search: { placeholder: 'Search name or generic name' },
    filters: [{ name: 'filter', label: 'Show', options: [['all', 'All active'], ['low', 'Low stock'], ['out', 'Out of stock'], ['expired', 'Has expired stock'], ['inactive', 'Inactive']] }],
    toolbarExtra: h('button', { class: 'btn primary', onclick: () => formModal({ title: 'Add medication', fields: medFields(), wide: true, onSubmit: async (v) => { await api.post('/pharmacist/medications', v); toast('Medication added. Now receive its first stock.'); reload(); } }) }, 'Add medication'),
    fetch: (s) => api.get('/pharmacist/medications', { page: s.page, pageSize: s.pageSize, q: s.q, filter: s.filter }),
    emptyText: 'No medications match.',
    columns: [
      { label: 'Medication', render: (m) => [m.name, h('span', { class: 'sub' }, `${m.strength} · ${m.form}${m.genericName ? ` · ${m.genericName}` : ''}`)] },
      { label: 'Price', render: (m) => money(m.unitPrice), class: 'num' },
      { label: 'In stock', render: (m) => [num(m.available), m.expiredUnits > 0 && h('span', { class: 'sub' }, `+${num(m.expiredUnits)} expired`)], class: 'num' },
      { label: 'Level', key: 'reorderLevel', class: 'num' },
      { label: 'Stock', render: (m) => (m.isActive ? stockBadge(m) : badge('Inactive')) },
      { label: 'Next expiry', render: (m) => (m.nearestExpiry ? fmtDate(m.nearestExpiry) : '—') },
      {
        label: '',
        class: 'actions',
        render: (m) => [
          m.isActive && h('button', { class: 'btn sm primary', onclick: () => receive(m) }, 'Receive stock'),
          ' ',
          h('button', { class: 'btn sm', onclick: () => formModal({ title: `Edit ${m.name}`, wide: true, fields: medFields(m), onSubmit: async (v) => { await api.put(`/pharmacist/medications/${m.id}`, v); toast('Medication updated'); reload(); } }) }, 'Edit'),
          ' ',
          h('button', { class: 'btn sm', onclick: () => toggle(m) }, m.isActive ? 'Deactivate' : 'Activate'),
          ' ',
          h('button', { class: 'btn sm', onclick: () => remove(m) }, 'Delete'),
        ],
      },
    ],
  });
  c.append(pageHeader('Medications', 'Catalogue, prices and stock levels'), card(null, list.el));
}

// ------------------------------------------------------------------ inventory batches
async function inventory(c) {
  let list;
  const adjust = (b) =>
    formModal({
      title: `Adjust stock: ${b.name} ${b.strength}`,
      fields: [
        { name: 'delta', label: 'Change in units (negative to remove)', type: 'number', required: true, step: 1, hint: `Batch ${b.batchNo} currently has ${b.quantity}. It can never go below 0.` },
        { name: 'reason', label: 'Reason', required: true, maxlength: 255, placeholder: 'e.g. damaged, recount, expired disposal', full: true },
      ],
      onSubmit: async (v) => {
        await api.post(`/pharmacist/inventory/${b.id}/adjust`, v);
        toast('Stock adjusted');
        list.reload();
      },
    });
  list = createList({
    search: { placeholder: 'Search medication' },
    filters: [{ name: 'status', label: 'Show', options: [['all', 'All batches'], ['expiring', 'Expiring in 30 days'], ['expired', 'Expired (with stock)']] }],
    fetch: (s) => api.get('/pharmacist/inventory', { page: s.page, pageSize: s.pageSize, q: s.q, status: s.status }),
    emptyText: 'No batches match.',
    columns: [
      { label: 'Medication', render: (b) => `${b.name} ${b.strength}` },
      { label: 'Batch', key: 'batchNo' },
      { label: 'Quantity', key: 'quantity', class: 'num' },
      { label: 'Expiry', render: (b) => expiryCell(b.expiryDate, b.isExpired) },
      { label: '', class: 'actions', render: (b) => h('button', { class: 'btn sm', onclick: () => adjust(b) }, 'Adjust') },
    ],
  });
  c.append(pageHeader('Inventory batches', 'Expiry is tracked per batch. Expired batches are never dispensed.'), card(null, list.el));
}

// ------------------------------------------------------------------ history
async function history(c) {
  const list = createList({
    pageSize: 15,
    search: { placeholder: 'Search medication or patient' },
    filters: [{ name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }],
    fetch: (s) => api.get('/pharmacist/dispensing-history', { page: s.page, pageSize: s.pageSize, q: s.q, from: s.from, to: s.to }),
    emptyText: 'Nothing has been dispensed in this period.',
    columns: [
      { label: 'When', render: (r) => fmtDateTime(r.dispensedAt) },
      { label: 'Prescription', render: (r) => `RX-${r.prescriptionId}` },
      { label: 'Patient', key: 'patientName' },
      { label: 'Medication', render: (r) => `${r.medication} ${r.strength}` },
      { label: 'Batch', key: 'batchNo' },
      { label: 'Qty', key: 'quantity', class: 'num' },
      { label: 'Value', render: (r) => money(r.quantity * r.unitPrice), class: 'num' },
      { label: 'Pharmacist', key: 'pharmacistName' },
    ],
  });
  c.append(pageHeader('Dispensing history', 'Every dispensing is recorded with who, what, which batch and when'), card(null, list.el));
}

export const pages = [
  { id: 'dashboard', label: 'Overview', render: dashboard },
  { id: 'prescriptions', label: 'Prescriptions', render: prescriptions },
  { id: 'medications', label: 'Medications', render: medications },
  { id: 'inventory', label: 'Inventory', render: inventory },
  { id: 'history', label: 'Dispensing history', render: history },
];
