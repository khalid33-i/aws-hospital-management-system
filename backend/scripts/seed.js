/*
 * Seeds reference data + FICTIONAL demo data. Run once on an empty database:  npm run seed
 * Demo accounts use SEED_PASSWORD from the environment (a random one is generated and printed if unset).
 * Never run this against anything that holds real data.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../src/config/env');
const { pool } = require('../src/config/db');
const { DEFAULT_SETTINGS } = require('../src/services/settings');
const { dispensePrescription } = require('../src/services/dispensing');

const q = (sql, params) => pool.query(sql, params);

async function main() {
  const [[{ n }]] = await q('SELECT COUNT(*) AS n FROM users');
  if (n > 0) {
    console.error('Database already contains users. Refusing to seed. (Use a fresh database.)');
    process.exit(1);
  }

  const generated = !process.env.SEED_PASSWORD;
  const password = process.env.SEED_PASSWORD || `${crypto.randomBytes(9).toString('hex')}Aa1`;
  const hash = await bcrypt.hash(password, env.bcryptRounds);

  // ---- date helper (hospital-local "today" comes from the database session)
  const [[{ today }]] = await q('SELECT CURDATE() AS today');
  const at = (dayOffset, hhmm) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    return `${d.toISOString().slice(0, 10)} ${hhmm}:00`;
  };
  const dateOnly = (dayOffset) => at(dayOffset, '00:00').slice(0, 10);

  // ---- reference data
  for (const name of ['Admin', 'Doctor', 'Receptionist', 'Pharmacist', 'Patient']) await q('INSERT INTO roles (name) VALUES (?)', [name]);
  const roleId = Object.fromEntries((await q('SELECT id, name FROM roles'))[0].map((r) => [r.name, r.id]));

  const deptIds = {};
  for (const [name, desc] of [
    ['Cardiology', 'Heart and blood-vessel care'],
    ['Pediatrics', 'Medical care for infants and children'],
    ['General Medicine', 'Primary and internal medicine'],
    ['Orthopedics', 'Bones, joints and muscles'],
    ['Dermatology', 'Skin conditions'],
  ]) deptIds[name] = (await q('INSERT INTO departments (name, description) VALUES (?, ?)', [name, desc]))[0].insertId;

  const specIds = {};
  for (const name of ['Cardiologist', 'Pediatrician', 'General Practitioner', 'Orthopedic Surgeon', 'Dermatologist']) {
    specIds[name] = (await q('INSERT INTO specialties (name) VALUES (?)', [name]))[0].insertId;
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) await q('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);

  // ---- staff accounts
  const addUser = async (role, email, fullName, phone) =>
    (await q('INSERT INTO users (role_id, email, password_hash, full_name, phone) VALUES (?, ?, ?, ?, ?)', [roleId[role], email, hash, fullName, phone]))[0].insertId;

  await addUser('Admin', 'admin@hms.test', 'System Administrator', '+973 3000 0001');

  const addDoctor = async (email, name, dept, spec, license, fee) => {
    const uid = await addUser('Doctor', email, name, '+973 3000 0002');
    return (await q('INSERT INTO doctors (user_id, department_id, specialty_id, license_no, consultation_fee) VALUES (?, ?, ?, ?, ?)', [uid, deptIds[dept], specIds[spec], license, fee]))[0].insertId;
  };
  const sara = await addDoctor('dr.sara@hms.test', 'Dr. Sara Al-Khalifa', 'Cardiology', 'Cardiologist', 'DEMO-MD-1001', 25);
  const omar = await addDoctor('dr.omar@hms.test', 'Dr. Omar Hassan', 'Pediatrics', 'Pediatrician', 'DEMO-MD-1002', 20);
  const layla = await addDoctor('dr.layla@hms.test', 'Dr. Layla Mansoor', 'General Medicine', 'General Practitioner', 'DEMO-MD-1003', 15);

  const recUser = await addUser('Receptionist', 'reception@hms.test', 'Noor Ebrahim', '+973 3000 0003');
  await q('INSERT INTO receptionists (user_id, employee_no) VALUES (?, ?)', [recUser, 'REC-0001']);
  const pharmUser = await addUser('Pharmacist', 'pharmacy@hms.test', 'Yousef Karimi', '+973 3000 0004');
  const pharmacistId = (await q('INSERT INTO pharmacists (user_id, license_no) VALUES (?, ?)', [pharmUser, 'DEMO-PH-2001']))[0].insertId;

  // ---- patients (first three also get portal logins)
  const patientRows = [
    ['Ahmed Salman', '1985-03-14', 'Male', '+973 3000 0101', 'A+', 'ahmed@hms.test'],
    ['Fatima Jassim', '1992-07-02', 'Female', '+973 3000 0102', 'O+', 'fatima@hms.test'],
    ['Mohammed Yusuf', '1978-11-23', 'Male', '+973 3000 0103', 'B+', 'mohammed@hms.test'],
    ['Zainab Ali', '2015-05-09', 'Female', '+973 3000 0104', 'A-', null],
    ['Hassan Mahdi', '1969-01-30', 'Male', '+973 3000 0105', 'AB+', null],
    ['Maryam Khalil', '2019-09-17', 'Female', '+973 3000 0106', 'O-', null],
    ['Ali Radhi', '2001-12-05', 'Male', '+973 3000 0107', 'B-', null],
    ['Huda Saeed', '1996-04-21', 'Female', '+973 3000 0108', null, null],
  ];
  const pid = [];
  for (const [name, dob, gender, phone, blood, loginEmail] of patientRows) {
    const userId = loginEmail ? await addUser('Patient', loginEmail, name, phone) : null;
    const [r] = await q(
      `INSERT INTO patients (user_id, full_name, date_of_birth, gender, phone, blood_type, address, emergency_contact_name, emergency_contact_phone, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'Manama, Bahrain (fictional)', 'Emergency Contact (fictional)', '+973 3000 0999', ?)`,
      [userId, name, dob, gender, phone, blood, recUser]
    );
    await q('UPDATE patients SET medical_record_no = ? WHERE id = ?', [`MRN-${String(r.insertId).padStart(6, '0')}`, r.insertId]);
    pid.push(r.insertId);
  }
  const [P1, P2, P3, P4, P5, P6, P7, P8] = pid;

  // ---- appointments (past completed ones carry a medical record)
  const appt = async (patient, doctor, when, status, reason) =>
    (await q('INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)', [patient, doctor, when, status, reason, recUser]))[0].insertId;
  const record = (a, patient, doctor, diagnosis, notes) =>
    q('INSERT INTO medical_records (appointment_id, patient_id, doctor_id, diagnosis, notes) VALUES (?, ?, ?, ?, ?)', [a, patient, doctor, diagnosis, notes]);

  const a1 = await appt(P1, sara, at(-14, '09:00'), 'Completed', 'Blood pressure follow-up');
  await record(a1, P1, sara, 'Essential hypertension', 'Home readings slightly elevated. Continue medication, review in two weeks.');
  const a2 = await appt(P2, omar, at(-10, '10:00'), 'Completed', 'Fever and cough');
  await record(a2, P2, omar, 'Acute bronchitis', 'Rest, fluids and prescribed antibiotics.');
  const a3 = await appt(P3, layla, at(-7, '11:00'), 'Completed', 'Routine diabetes check');
  await record(a3, P3, layla, 'Type 2 diabetes mellitus', 'HbA1c stable. Continue metformin.');
  const a4 = await appt(P4, layla, at(-5, '09:30'), 'Completed', 'Stomach pain');
  await record(a4, P4, layla, 'Gastritis', 'Avoid spicy food. Short course of acid reducer and pain relief.');
  const a5 = await appt(P5, omar, at(-3, '14:00'), 'Completed', 'Allergy symptoms');
  await record(a5, P5, omar, 'Seasonal allergic rhinitis', 'Antihistamine as needed.');
  const a6 = await appt(P1, sara, at(-2, '09:30'), 'Completed', 'Chest tightness check');
  await record(a6, P1, sara, 'Mild angina symptoms, ECG normal', 'Advised lifestyle changes. Statin therapy started.');

  await appt(P1, sara, at(0, '10:00'), 'Confirmed', 'Medication review');
  await appt(P6, omar, at(0, '09:00'), 'Scheduled', 'Vaccination check');
  await appt(P7, layla, at(0, '11:30'), 'Scheduled', 'Headache');
  await appt(P2, omar, at(0, '15:00'), 'Confirmed', 'Cough follow-up');
  await appt(P3, layla, at(1, '10:00'), 'Scheduled', 'Lab results review');
  await appt(P6, omar, at(2, '10:00'), 'Cancelled', 'Vaccination check');
  await appt(P1, sara, at(3, '09:30'), 'Scheduled', 'Cardiology review');
  await appt(P8, omar, at(5, '13:00'), 'Scheduled', 'General check-up');
  await appt(P4, layla, at(7, '14:00'), 'Scheduled', 'Follow-up');

  // ---- pharmacy catalogue + stock batches (some deliberately low / out / expired / expiring)
  const med = async (name, generic, form, strength, price, reorder, batches) => {
    const [r] = await q('INSERT INTO medications (name, generic_name, form, strength, unit_price, reorder_level) VALUES (?, ?, ?, ?, ?, ?)', [name, generic, form, strength, price, reorder]);
    for (const [batchNo, qty, expiryOffset] of batches) {
      await q('INSERT INTO pharmacy_inventory (medication_id, batch_no, quantity, expiry_date) VALUES (?, ?, ?, ?)', [r.insertId, batchNo, qty, dateOnly(expiryOffset)]);
    }
    return r.insertId;
  };
  const amlodipine = await med('Amlodipine', 'Amlodipine besilate', 'Tablet', '5 mg', 0.45, 30, [['AML-2401', 200, 400]]);
  const atorvastatin = await med('Atorvastatin', 'Atorvastatin calcium', 'Tablet', '20 mg', 0.9, 30, [['ATO-2402', 150, 300]]);
  const metformin = await med('Metformin', 'Metformin hydrochloride', 'Tablet', '500 mg', 0.25, 50, [['MET-2403', 400, 250]]);
  const amoxicillin = await med('Amoxicillin', 'Amoxicillin trihydrate', 'Syrup', '250 mg/5 ml', 2.5, 20, [['AMX-2404', 40, 200]]);
  const paracetamol = await med('Paracetamol', 'Acetaminophen', 'Syrup', '120 mg/5 ml', 1.2, 20, [['PAR-2405A', 30, 60], ['PAR-2405B', 50, 180]]);
  const ibuprofen = await med('Ibuprofen', 'Ibuprofen', 'Tablet', '400 mg', 0.3, 40, [['IBU-2406', 25, 20]]); // low + expiring soon
  const omeprazole = await med('Omeprazole', 'Omeprazole', 'Capsule', '20 mg', 0.6, 30, [['OME-2407', 0, 300]]); // out of stock
  await med('Cetirizine', 'Cetirizine hydrochloride', 'Tablet', '10 mg', 0.2, 30, [['CET-2408', 120, 365]]);
  await med('Salbutamol', 'Salbutamol sulfate', 'Inhaler', '100 mcg', 3.8, 20, [['SAL-2409', 18, 150]]); // low
  await med('Hydrocortisone', 'Hydrocortisone', 'Cream', '1%', 1.9, 15, [['HYD-2410', 35, 220]]);
  await med('Insulin Glargine', 'Insulin glargine', 'Injection', '100 IU/ml', 12.0, 15, [['INS-2411', 10, 90]]); // low
  await med('Azithromycin', 'Azithromycin', 'Tablet', '500 mg', 1.5, 20, [['AZI-2301', 45, -30]]); // only an EXPIRED batch
  await med('Vitamin D3', 'Cholecalciferol', 'Capsule', '1000 IU', 0.15, 50, [['VTD-2412', 300, 500], ['VTD-2301', 20, -10]]); // healthy + one expired batch

  // ---- prescriptions in every status
  const rx = async (patient, doctor, appointment, notes, items) => {
    const [r] = await q('INSERT INTO prescriptions (appointment_id, patient_id, doctor_id, notes) VALUES (?, ?, ?, ?)', [appointment, patient, doctor, notes]);
    const ids = [];
    for (const [medId, dosage, frequency, days, qty, instructions] of items) {
      ids.push((await q('INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration_days, instructions, quantity_prescribed) VALUES (?, ?, ?, ?, ?, ?, ?)', [r.insertId, medId, dosage, frequency, days, instructions, qty]))[0].insertId);
    }
    return { id: r.insertId, items: ids };
  };
  const dispense = (prescription, picks, key) =>
    dispensePrescription({
      prescriptionId: prescription.id,
      pharmacistId,
      userId: pharmUser,
      requestKey: key,
      items: picks.map(([index, quantity]) => ({ itemId: prescription.items[index], quantity })),
      ip: 'seed',
    });

  const rx1 = await rx(P1, sara, a6, 'Take with water. Return if chest pain worsens.', [
    [amlodipine, '5 mg', 'Once daily', 30, 30, 'Take in the morning'],
    [atorvastatin, '20 mg', 'Once daily', 30, 30, 'Take in the evening'],
  ]);
  const rx2 = await rx(P2, omar, a2, null, [
    [amoxicillin, '5 ml', 'Three times daily', 7, 2, 'Finish the whole course'],
    [paracetamol, '5 ml', 'Every 6 hours if fever', 5, 3, 'Maximum 4 doses a day'],
  ]);
  await dispense(rx2, [[1, 3]], 'seed-rx2-paracetamol'); // -> Partially Dispensed
  const rx3 = await rx(P3, layla, a3, 'Check blood sugar regularly.', [[metformin, '500 mg', 'Twice daily', 30, 60, 'Take with meals']]);
  await dispense(rx3, [[0, 60]], 'seed-rx3-metformin'); // -> Dispensed
  await rx(P4, layla, a4, null, [
    [omeprazole, '20 mg', 'Once daily', 14, 14, 'Before breakfast'],
    [ibuprofen, '400 mg', 'Twice daily if needed', 5, 10, 'Take after food'],
  ]); // Pending (omeprazole has no stock: good for demoing the stock rule)
  const rx5 = await rx(P5, omar, a5, null, [[(await q('SELECT id FROM medications WHERE name = ?', ['Cetirizine']))[0][0].id, '10 mg', 'Once daily', 10, 10, null]]);
  await q("UPDATE prescriptions SET status = 'Cancelled', cancelled_at = NOW() WHERE id = ?", [rx5.id]);

  console.log('\nSeed complete. Demo accounts (fictional):');
  for (const [role, email] of [
    ['Admin', 'admin@hms.test'],
    ['Doctor', 'dr.sara@hms.test  (also dr.omar@hms.test, dr.layla@hms.test)'],
    ['Receptionist', 'reception@hms.test'],
    ['Pharmacist', 'pharmacy@hms.test'],
    ['Patient', 'ahmed@hms.test  (also fatima@hms.test, mohammed@hms.test)'],
  ]) console.log(`  ${role.padEnd(13)} ${email}`);
  console.log(generated ? `\nGenerated password for ALL demo accounts (shown once): ${password}\n` : '\nAll demo accounts use the password from SEED_PASSWORD.\n');
  await pool.end();
}

main().catch(async (err) => {
  console.error('Seed failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
