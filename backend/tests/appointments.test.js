const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, login, pool, dateOffset } = require('./helpers');

let reception;
let patient;
let ahmed;
let drLayla;
let patientId;
let doctorId;
let day = 40; // far-future days, advanced per test so runs never collide with each other or with seed data

const nextDay = async () => {
  day += 1;
  return dateOffset(day);
};

before(async () => {
  await start();
  reception = await login('reception@hms.test');
  ahmed = await login('ahmed@hms.test');
  drLayla = await login('dr.layla@hms.test');
  patient = ahmed;
  [[{ id: patientId }]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Ahmed Salman'");
  [[{ id: doctorId }]] = await pool.query("SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = 'dr.layla@hms.test'");
  // random start offset so repeated test runs use different days
  day += Math.floor(Math.random() * 300);
});
after(stop);

const book = (client, path, body) => client.post(path, body);

describe('appointments', () => {
  it('books an appointment and rejects double booking of the same doctor slot', async () => {
    const date = await nextDay();
    const first = await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${date} 10:00`, reason: 'Check-up' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const [[other]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Fatima Jassim'");
    const clash = await book(reception, '/api/receptionist/appointments', { patientId: other.id, doctorId, scheduledAt: `${date} 10:00` });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'SLOT_TAKEN');
  });

  it('rejects two simultaneous bookings for the same slot (only one wins)', async () => {
    const date = await nextDay();
    const [[p2]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Fatima Jassim'");
    const [[p3]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Mohammed Yusuf'");
    const results = await Promise.all([
      book(reception, '/api/receptionist/appointments', { patientId: p2.id, doctorId, scheduledAt: `${date} 11:00` }),
      book(reception, '/api/receptionist/appointments', { patientId: p3.id, doctorId, scheduledAt: `${date} 11:00` }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  });

  it('prevents the same patient from having two appointments at the same time', async () => {
    const date = await nextDay();
    const [[otherDoctor]] = await pool.query("SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.email = 'dr.omar@hms.test'");
    assert.equal((await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${date} 09:30` })).status, 201);
    const res = await book(reception, '/api/receptionist/appointments', { patientId, doctorId: otherDoctor.id, scheduledAt: `${date} 09:30` });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PATIENT_BUSY');
  });

  it('enforces clinic hours, slot alignment and future dates', async () => {
    const date = await nextDay();
    for (const time of ['07:00', '17:00', '16:45', '10:10']) {
      const res = await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${date} ${time}` });
      assert.equal(res.status, 400, `${time} should be rejected`);
    }
    const past = await dateOffset(-2);
    assert.equal((await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${past} 10:00` })).status, 400);
    assert.equal((await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: 'tomorrow' })).status, 400);
  });

  it('a cancelled slot can be booked again', async () => {
    const date = await nextDay();
    const a = await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${date} 13:00` });
    assert.equal((await reception.post(`/api/receptionist/appointments/${a.body.id}/cancel`, { reason: 'Patient request' })).status, 204);
    const again = await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${date} 13:00` });
    assert.equal(again.status, 201);
  });

  it('reschedules an open appointment and refuses to touch a finished one', async () => {
    const date = await nextDay();
    const a = await book(reception, '/api/receptionist/appointments', { patientId, doctorId, scheduledAt: `${date} 14:00` });
    const moved = await reception.put(`/api/receptionist/appointments/${a.body.id}/reschedule`, { scheduledAt: `${date} 15:00` });
    assert.equal(moved.status, 204);
    const [[row]] = await pool.query('SELECT TIME_FORMAT(scheduled_at, "%H:%i") AS t FROM appointments WHERE id = ?', [a.body.id]);
    assert.equal(row.t, '15:00');
    await reception.post(`/api/receptionist/appointments/${a.body.id}/cancel`, {});
    const res = await reception.put(`/api/receptionist/appointments/${a.body.id}/reschedule`, { scheduledAt: `${date} 16:00` });
    assert.equal(res.status, 409);
  });

  it('a patient books for themselves only and cannot pass another patient id', async () => {
    const date = await nextDay();
    const [[other]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Fatima Jassim'");
    const res = await patient.post('/api/patient/appointments', { doctorId, scheduledAt: `${date} 09:00`, patientId: other.id });
    assert.equal(res.status, 201);
    const [[row]] = await pool.query('SELECT patient_id FROM appointments WHERE id = ?', [res.body.id]);
    assert.equal(row.patient_id, patientId, 'the extra patientId must be ignored');
  });

  it('patients can cancel far-ahead appointments but not inside the cancellation window', async () => {
    const date = await nextDay();
    const far = await patient.post('/api/patient/appointments', { doctorId, scheduledAt: `${date} 09:30` });
    assert.equal((await patient.post(`/api/patient/appointments/${far.body.id}/cancel`, {})).status, 204);

    // an appointment later today / tomorrow is inside the default 24h window: insert directly to control the time
    const [[soon]] = await pool.query("SELECT DATE_ADD(NOW(), INTERVAL 2 HOUR) AS t");
    const [ins] = await pool.query("INSERT INTO appointments (patient_id, doctor_id, scheduled_at, created_by) VALUES (?, ?, ?, 1)", [patientId, doctorId, soon.t]);
    const res = await patient.post(`/api/patient/appointments/${ins.insertId}/cancel`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'CANCELLATION_WINDOW');
    await pool.query('DELETE FROM appointments WHERE id = ?', [ins.insertId]);
  });

  it("a patient cannot cancel someone else's appointment (looks like 404)", async () => {
    const date = await nextDay();
    const [[other]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Fatima Jassim'");
    const a = await book(reception, '/api/receptionist/appointments', { patientId: other.id, doctorId, scheduledAt: `${date} 10:30` });
    assert.equal((await patient.post(`/api/patient/appointments/${a.body.id}/cancel`, {})).status, 404);
  });

  it('a doctor changes status only for their own appointments, and only along valid transitions', async () => {
    const [[today]] = await pool.query('SELECT CURDATE() AS d');
    const [[slot]] = await pool.query("SELECT TIME_FORMAT(DATE_ADD(NOW(), INTERVAL 1 HOUR), '%H:%i') AS t");
    // insert an appointment for today with this doctor directly (booking in the past is blocked by the API on purpose)
    const [ins] = await pool.query("INSERT INTO appointments (patient_id, doctor_id, scheduled_at, created_by) VALUES (?, ?, ?, 1)", [patientId, doctorId, `${today.d} 23:30:00`]);
    const omar = await login('dr.omar@hms.test');
    assert.equal((await omar.put(`/api/doctor/appointments/${ins.insertId}/status`, { status: 'Completed' })).status, 404);
    assert.equal((await drLayla.put(`/api/doctor/appointments/${ins.insertId}/status`, { status: 'Completed' })).status, 204);
    const again = await drLayla.put(`/api/doctor/appointments/${ins.insertId}/status`, { status: 'Confirmed' });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'INVALID_TRANSITION');
    assert.equal(typeof slot.t, 'string');
    await pool.query('DELETE FROM appointments WHERE id = ?', [ins.insertId]);
  });
});

describe('receptionist patient management', () => {
  it('registers a patient with an optional portal login, who can then sign in', async () => {
    const email = `new.${Date.now()}@hms.test`;
    const res = await reception.post('/api/receptionist/patients', {
      fullName: 'Test Patient', dateOfBirth: '1990-01-15', gender: 'Female', phone: '+973 3999 0001',
      account: { email, password: 'PatientPass1' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.medicalRecordNo, /^MRN-\d{6}$/);
    assert.equal(res.body.isPortalUser, true);
    const portal = await login(email, 'PatientPass1');
    assert.equal((await portal.get('/api/patient/profile')).status, 200);
  });

  it('validates patient input (impossible dates, future birth dates, bad phone)', async () => {
    const base = { fullName: 'Bad Input', dateOfBirth: '1990-01-15', gender: 'Male', phone: '+973 3999 0002' };
    assert.equal((await reception.post('/api/receptionist/patients', { ...base, dateOfBirth: '1990-02-31' })).status, 400);
    assert.equal((await reception.post('/api/receptionist/patients', { ...base, dateOfBirth: '2999-01-01' })).status, 400);
    assert.equal((await reception.post('/api/receptionist/patients', { ...base, phone: 'abc' })).status, 400);
  });

  it('searches patients by name, phone and MRN with pagination', async () => {
    const byName = await reception.get('/api/receptionist/patients?q=Ahmed');
    assert.ok(byName.body.data.some((p) => p.fullName === 'Ahmed Salman'));
    const paged = await reception.get('/api/receptionist/patients?pageSize=2&page=1');
    assert.equal(paged.body.data.length, 2);
    assert.ok(paged.body.total >= 8);
  });

  it('a patient can update contact details but not their name or date of birth', async () => {
    const res = await patient.put('/api/patient/profile', { phone: '+973 3000 0101', address: 'New address (fictional)', fullName: 'Hacker', dateOfBirth: '1900-01-01' });
    assert.equal(res.status, 200);
    assert.equal(res.body.address, 'New address (fictional)');
    assert.equal(res.body.fullName, 'Ahmed Salman');
    assert.equal(res.body.dateOfBirth, '1985-03-14');
  });
});
