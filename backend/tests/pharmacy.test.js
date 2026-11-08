const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, login, pool, requestKey, dateOffset } = require('./helpers');

let doctor;
let pharmacist;
let patientId;

const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

// ---- builders (every test creates its own medication so tests never depend on each other's stock)
async function newMedication(batches) {
  const name = `TestMed-${uniq()}`;
  const med = await pharmacist.post('/api/pharmacist/medications', { name, form: 'Tablet', strength: '10 mg', unitPrice: 1.5, reorderLevel: 5 });
  assert.equal(med.status, 201, JSON.stringify(med.body));
  const ids = [];
  for (const [quantity, expiryOffset] of batches) {
    const batchNo = `B-${uniq()}`;
    if (expiryOffset > 0) {
      const inv = await pharmacist.post('/api/pharmacist/inventory', { medicationId: med.body.id, batchNo, quantity, expiryDate: await dateOffset(expiryOffset) });
      assert.equal(inv.status, 201, JSON.stringify(inv.body));
      ids.push(inv.body.id);
    } else {
      // The API refuses to receive expired stock, so an already-expired batch is inserted directly (simulates stock that aged on the shelf)
      const [r] = await pool.query('INSERT INTO pharmacy_inventory (medication_id, batch_no, quantity, expiry_date) VALUES (?, ?, ?, ?)', [med.body.id, batchNo, quantity, await dateOffset(expiryOffset)]);
      ids.push(r.insertId);
    }
  }
  return { id: med.body.id, name, batchIds: ids };
}

async function prescribe(items) {
  const res = await doctor.post('/api/doctor/prescriptions', {
    patientId,
    items: items.map(([med, quantity]) => ({ medicationId: med.id, dosage: '1 tablet', frequency: 'Twice daily', durationDays: 5, quantity })),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const detail = await doctor.get(`/api/doctor/prescriptions/${res.body.id}`);
  return { id: res.body.id, itemIds: detail.body.items.map((i) => i.id) };
}

const dispense = (rx, picks, key = requestKey()) =>
  pharmacist.post(`/api/pharmacist/prescriptions/${rx.id}/dispense`, {
    requestKey: key,
    items: picks.map(([index, quantity]) => ({ itemId: rx.itemIds[index], quantity })),
  });

const stockOf = async (med) => {
  const [rows] = await pool.query('SELECT id, quantity FROM pharmacy_inventory WHERE medication_id = ? ORDER BY expiry_date, id', [med.id]);
  return rows.map((r) => r.quantity);
};
const statusOf = async (rx) => (await pool.query('SELECT status FROM prescriptions WHERE id = ?', [rx.id]))[0][0].status;
const recordCount = async (rx) =>
  (await pool.query('SELECT COUNT(*) AS n FROM dispensing_records dr JOIN prescription_items pi ON pi.id = dr.prescription_item_id WHERE pi.prescription_id = ?', [rx.id]))[0][0].n;

before(async () => {
  await start();
  doctor = await login('dr.sara@hms.test');
  pharmacist = await login('pharmacy@hms.test');
  [[{ id: patientId }]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Ahmed Salman'");
});
after(stop);

describe('doctor -> pharmacist -> patient workflow', () => {
  it('a new prescription is instantly visible to the pharmacist as Pending and to the patient', async () => {
    const med = await newMedication([[20, 200]]);
    const rx = await prescribe([[med, 4]]);

    const queue = await pharmacist.get('/api/pharmacist/prescriptions?status=Pending&pageSize=100');
    assert.ok(queue.body.data.some((r) => r.id === rx.id), 'prescription should be in the pharmacist queue');

    const detail = await pharmacist.get(`/api/pharmacist/prescriptions/${rx.id}`);
    assert.equal(detail.body.status, 'Pending');
    assert.equal(detail.body.doctorName, 'Dr. Sara Al-Khalifa');
    assert.equal(detail.body.patientName, 'Ahmed Salman');
    assert.equal(detail.body.items[0].dosage, '1 tablet');
    assert.equal(detail.body.items[0].frequency, 'Twice daily');
    assert.equal(detail.body.items[0].durationDays, 5);

    const ahmed = await login('ahmed@hms.test');
    const mine = await ahmed.get(`/api/patient/prescriptions/${rx.id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.status, 'Pending');
  });

  it('partial then full dispensing updates status, stock, history and the patient view', async () => {
    const med = await newMedication([[50, 200]]);
    const rx = await prescribe([[med, 10]]);

    const first = await dispense(rx, [[0, 4]]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.status, 'Partially Dispensed');
    assert.deepEqual(await stockOf(med), [46]);

    const second = await dispense(rx, [[0, 6]]);
    assert.equal(second.body.status, 'Dispensed');
    assert.deepEqual(await stockOf(med), [40]);

    const detail = await pharmacist.get(`/api/pharmacist/prescriptions/${rx.id}`);
    assert.equal(detail.body.dispensing.length, 2);
    assert.ok(detail.body.dispensing.every((d) => d.pharmacistName === 'Yousef Karimi' && d.dispensedAt));

    const ahmed = await login('ahmed@hms.test');
    const mine = await ahmed.get(`/api/patient/prescriptions/${rx.id}`);
    assert.equal(mine.body.status, 'Dispensed');
    assert.equal(mine.body.items[0].quantityDispensed, 10);

    const [[audit]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PRESCRIPTION_DISPENSED' AND entity_id = ?", [String(rx.id)]);
    assert.equal(audit.n, 2);
  });

  it('a fully dispensed prescription cannot be dispensed again', async () => {
    const med = await newMedication([[20, 200]]);
    const rx = await prescribe([[med, 3]]);
    assert.equal((await dispense(rx, [[0, 3]])).status, 200);
    const again = await dispense(rx, [[0, 1]]);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'ALREADY_DISPENSED');
    assert.deepEqual(await stockOf(med), [17]);
  });

  it('only a Pending prescription can be cancelled by the doctor, and a cancelled one cannot be dispensed', async () => {
    const med = await newMedication([[20, 200]]);
    const rx = await prescribe([[med, 5]]);
    assert.equal((await doctor.post(`/api/doctor/prescriptions/${rx.id}/cancel`)).status, 204);
    assert.equal(await statusOf(rx), 'Cancelled');
    const res = await dispense(rx, [[0, 1]]);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PRESCRIPTION_CANCELLED');

    const rx2 = await prescribe([[med, 5]]);
    assert.equal((await dispense(rx2, [[0, 1]])).status, 200);
    assert.equal((await doctor.post(`/api/doctor/prescriptions/${rx2.id}/cancel`)).status, 409);
  });
});

describe('pharmacy business rules', () => {
  it('rule 1: expired stock cannot be dispensed', async () => {
    const med = await newMedication([[30, -5]]);
    const rx = await prescribe([[med, 2]]);
    const res = await dispense(rx, [[0, 2]]);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
    assert.match(res.body.error.message, /expired/i);
    assert.deepEqual(await stockOf(med), [30]);
    assert.equal(await statusOf(rx), 'Pending');
  });

  it('rule 1b: an expired batch is skipped and only valid stock is used', async () => {
    const med = await newMedication([[100, -5], [10, 200]]);
    const rx = await prescribe([[med, 8]]);
    assert.equal((await dispense(rx, [[0, 8]])).status, 200);
    assert.deepEqual(await stockOf(med), [100, 2]); // expired batch untouched
    const tooMuch = await prescribe([[med, 5]]);
    const res = await dispense(tooMuch, [[0, 5]]); // only 2 valid units left; the 100 expired ones must not count
    assert.equal(res.status, 409);
    assert.equal(res.body.error.details.available, 2);
  });

  it('rules 2+3: cannot dispense more than the available stock; stock never goes negative', async () => {
    const med = await newMedication([[3, 200]]);
    const rx = await prescribe([[med, 10]]);
    const res = await dispense(rx, [[0, 5]]);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INSUFFICIENT_STOCK');
    assert.deepEqual(await stockOf(med), [3]);
    assert.equal(await recordCount(rx), 0);
  });

  it('rule 3b: cannot dispense more than was prescribed', async () => {
    const med = await newMedication([[50, 200]]);
    const rx = await prescribe([[med, 5]]);
    const res = await dispense(rx, [[0, 6]]);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EXCEEDS_PRESCRIBED');
    assert.deepEqual(await stockOf(med), [50]);
  });

  it('rule 2b: the database itself refuses negative stock and over-dispensing (CHECK constraints)', async () => {
    const med = await newMedication([[5, 200]]);
    await assert.rejects(pool.query('UPDATE pharmacy_inventory SET quantity = -1 WHERE id = ?', [med.batchIds[0]]), /constraint/i);
    const rx = await prescribe([[med, 2]]);
    await assert.rejects(pool.query('UPDATE prescription_items SET quantity_dispensed = 99 WHERE id = ?', [rx.itemIds[0]]), /constraint/i);
    const adjust = await pharmacist.post(`/api/pharmacist/inventory/${med.batchIds[0]}/adjust`, { delta: -6, reason: 'test' });
    assert.equal(adjust.status, 409);
    assert.equal(adjust.body.error.code, 'NEGATIVE_STOCK');
  });

  it('rules 4+5: dispensing is atomic and recorded; a failure on one item rolls back every item', async () => {
    const medA = await newMedication([[50, 200]]);
    const medB = await newMedication([]); // no stock at all
    const rx = await prescribe([[medA, 5], [medB, 5]]);
    const res = await dispense(rx, [[0, 5], [1, 5]]);
    assert.equal(res.status, 409);
    assert.deepEqual(await stockOf(medA), [50], 'stock of the first item must be rolled back');
    assert.equal(await recordCount(rx), 0, 'no dispensing record may survive the rollback');
    assert.equal(await statusOf(rx), 'Pending');
    const [[{ q }]] = await pool.query('SELECT SUM(quantity_dispensed) AS q FROM prescription_items WHERE prescription_id = ?', [rx.id]);
    assert.equal(Number(q), 0);

    // the same prescription still works once only the available item is requested
    assert.equal((await dispense(rx, [[0, 5]])).status, 200);
    assert.equal(await statusOf(rx), 'Partially Dispensed');
  });

  it('rule 6: a repeated request (double click / retry) is ignored and never deducts twice', async () => {
    const med = await newMedication([[50, 200]]);
    const rx = await prescribe([[med, 10]]);
    const key = requestKey();
    const first = await dispense(rx, [[0, 4]], key);
    assert.equal(first.body.duplicate, false);
    const replay = await dispense(rx, [[0, 4]], key);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true);
    assert.deepEqual(await stockOf(med), [46]);
    assert.equal(await recordCount(rx), 1);

    // the same key on a different prescription is rejected
    const other = await prescribe([[med, 3]]);
    assert.equal((await dispense(other, [[0, 1]], key)).status, 409);
  });

  it('rule 6b: two simultaneous requests with the same key deduct only once', async () => {
    const med = await newMedication([[50, 200]]);
    const rx = await prescribe([[med, 10]]);
    const key = requestKey();
    const results = await Promise.all([dispense(rx, [[0, 5]], key), dispense(rx, [[0, 5]], key), dispense(rx, [[0, 5]], key)]);
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    assert.equal(results.filter((r) => r.body.duplicate === false).length, 1);
    assert.deepEqual(await stockOf(med), [45]);
  });

  it('concurrency: two pharmacists racing for the last units can never oversell', async () => {
    const med = await newMedication([[10, 200]]);
    const rxA = await prescribe([[med, 10]]);
    const rxB = await prescribe([[med, 10]]);
    const [a, b] = await Promise.all([dispense(rxA, [[0, 10]]), dispense(rxB, [[0, 10]])]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409], `got ${a.status} and ${b.status}`);
    assert.deepEqual(await stockOf(med), [0]);
  });

  it('uses First-Expiry-First-Out across batches and records which batches were used', async () => {
    const med = await newMedication([[5, 300], [5, 60]]); // second batch expires first
    const rx = await prescribe([[med, 8]]);
    const res = await dispense(rx, [[0, 8]]);
    assert.equal(res.status, 200);
    assert.equal(res.body.dispensed[0].batches.length, 2);
    assert.deepEqual(await stockOf(med), [0, 2]); // ordered by expiry: earliest-expiring batch emptied first
    assert.equal(await recordCount(rx), 2);
  });

  it('an inactive medication cannot be dispensed', async () => {
    const med = await newMedication([[10, 200]]);
    const rx = await prescribe([[med, 2]]);
    assert.equal((await pharmacist.post(`/api/pharmacist/medications/${med.id}/deactivate`)).status, 204);
    const res = await dispense(rx, [[0, 2]]);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'MEDICATION_INACTIVE');
  });

  it('stock that is already expired cannot be received', async () => {
    const med = await newMedication([]);
    const res = await pharmacist.post('/api/pharmacist/inventory', { medicationId: med.id, batchNo: `X-${uniq()}`, quantity: 5, expiryDate: await dateOffset(-1) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EXPIRED_STOCK');
  });

  it('rule 7: a doctor cannot prescribe unassigned patients, duplicate items or inactive medications', async () => {
    const med = await newMedication([[10, 200]]);
    const [[other]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Huda Saeed'"); // never seen by Dr. Sara
    const body = (extra) => ({ patientId, items: [{ medicationId: med.id, dosage: '1', frequency: 'Daily', durationDays: 3, quantity: 3 }], ...extra });
    assert.equal((await doctor.post('/api/doctor/prescriptions', body({ patientId: other.id }))).status, 403);
    const dup = body();
    dup.items.push({ ...dup.items[0] });
    assert.equal((await doctor.post('/api/doctor/prescriptions', dup)).status, 409);
    await pharmacist.post(`/api/pharmacist/medications/${med.id}/deactivate`);
    assert.equal((await doctor.post('/api/doctor/prescriptions', body())).status, 409);
  });
});

describe('pharmacy dashboard', () => {
  it('reports the figures the pharmacist needs', async () => {
    const res = await pharmacist.get('/api/pharmacist/dashboard');
    assert.equal(res.status, 200);
    for (const key of ['totalMedications', 'availableStock', 'lowStockMedications', 'expiredMedications', 'pendingPrescriptions', 'partiallyDispensedPrescriptions', 'completedPrescriptions']) {
      assert.equal(typeof res.body[key], 'number', `${key} should be a number`);
    }
    assert.ok(res.body.expiredMedications >= 1, 'seed data contains expired stock');
    assert.ok(res.body.lowStockMedications >= 1, 'seed data contains low stock');
  });

  it('filters medications by low stock, out of stock and expired', async () => {
    const low = await pharmacist.get('/api/pharmacist/medications?filter=low&pageSize=100');
    assert.ok(low.body.data.length >= 1 && low.body.data.every((m) => m.available <= m.reorderLevel));
    const out = await pharmacist.get('/api/pharmacist/medications?filter=out&pageSize=100');
    assert.ok(out.body.data.every((m) => m.available === 0));
    const expired = await pharmacist.get('/api/pharmacist/medications?filter=expired&pageSize=100');
    assert.ok(expired.body.data.length >= 1 && expired.body.data.every((m) => m.expiredUnits > 0));
  });
});
