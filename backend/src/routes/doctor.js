const router = require('express').Router();
const { z } = require('zod');
const { pool, withTransaction } = require('../config/db');
const { authenticate, authorize, loadProfile } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, forbidden, conflict } = require('../utils/httpError');
const { asyncHandler, auditReq, camelize, likeContains, limitOffset, paged, schema } = require('../utils/helpers');
const appts = require('../services/appointments');

router.use(authenticate, authorize('Doctor'), loadProfile('doctor'));

const STATUSES = ['Scheduled', 'Confirmed', 'Completed', 'Cancelled', 'No-Show'];
const RX_STATUSES = ['Pending', 'Partially Dispensed', 'Dispensed', 'Cancelled'];

/** A doctor may only work with patients who have (or had) a non-cancelled appointment with them. */
async function assertAssigned(db, doctorId, patientId) {
  const [rows] = await db.query("SELECT 1 FROM appointments WHERE doctor_id = ? AND patient_id = ? AND status <> 'Cancelled' LIMIT 1", [doctorId, patientId]);
  if (!rows.length) throw forbidden('This patient is not assigned to you');
}

// ---------------------------------------------------------------- dashboard
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const d = req.doctorId;
    const [[row]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM appointments WHERE doctor_id = ? AND DATE(scheduled_at) = CURDATE() AND status IN ('Scheduled','Confirmed')) AS today_pending,
        (SELECT COUNT(*) FROM appointments WHERE doctor_id = ? AND DATE(scheduled_at) = CURDATE()) AS today_total,
        (SELECT COUNT(*) FROM appointments WHERE doctor_id = ? AND scheduled_at > NOW() AND status IN ('Scheduled','Confirmed')) AS upcoming,
        (SELECT COUNT(DISTINCT patient_id) FROM appointments WHERE doctor_id = ? AND status <> 'Cancelled') AS total_patients,
        (SELECT COUNT(*) FROM prescriptions WHERE doctor_id = ? AND status IN ('Pending','Partially Dispensed')) AS open_prescriptions`,
      [d, d, d, d, d]
    );
    const [today] = await pool.query(
      `${appts.APPOINTMENT_SELECT} WHERE a.doctor_id = ? AND DATE(a.scheduled_at) = CURDATE() ORDER BY a.scheduled_at`,
      [d]
    );
    res.json(camelize({ ...row, todayAppointments: today }));
  })
);

// ---------------------------------------------------------------- appointments
router.get(
  '/appointments',
  validate({
    query: schema.pagination.extend({
      from: schema.dateOnly.optional(),
      to: schema.dateOnly.optional(),
      status: z.enum(STATUSES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = ['a.doctor_id = ?'];
    const params = [req.doctorId];
    if (q.from) { where.push('a.scheduled_at >= ?'); params.push(q.from); }
    if (q.to) { where.push('a.scheduled_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(q.to); }
    if (q.status) { where.push('a.status = ?'); params.push(q.status); }
    if (q.q) { where.push('p.full_name LIKE ?'); params.push(likeContains(q.q)); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM appointments a JOIN patients p ON p.id = a.patient_id ${clause}`, params);
    const [rows] = await pool.query(`${appts.APPOINTMENT_SELECT} ${clause} ORDER BY a.scheduled_at DESC LIMIT ? OFFSET ?`, [...params, ...limitOffset(q)]);
    res.json(paged(rows, q, total));
  })
);

router.put(
  '/appointments/:id/status',
  validate({ params: z.object({ id: schema.id }), body: z.object({ status: z.enum(['Confirmed', 'Completed', 'No-Show']) }) }),
  asyncHandler(async (req, res) => {
    const { status } = req.valid.body;
    await appts.changeStatus(pool, {
      appointmentId: req.valid.params.id,
      newStatus: status,
      allowedTargets: ['Confirmed', 'Completed', 'No-Show'],
      doctorId: req.doctorId,
      actorUserId: req.user.id,
    });
    await auditReq(req, pool, { action: 'APPOINTMENT_STATUS_CHANGED', entityType: 'appointment', entityId: req.valid.params.id, details: { status } });
    res.status(204).end();
  })
);

// Diagnosis / visit notes for one of MY appointments (creates or updates the medical record)
router.put(
  '/appointments/:id/record',
  validate({
    params: z.object({ id: schema.id }),
    body: z.object({ diagnosis: schema.shortText(500), notes: schema.optionalText(5000) }),
  }),
  asyncHandler(async (req, res) => {
    const [[appt]] = await pool.query('SELECT id, patient_id, status FROM appointments WHERE id = ? AND doctor_id = ?', [req.valid.params.id, req.doctorId]);
    if (!appt) throw notFound('Appointment not found');
    if (appt.status === 'Cancelled' || appt.status === 'No-Show') throw conflict('No record can be written for a cancelled or missed appointment', 'INVALID_STATE');
    const { diagnosis, notes } = req.valid.body;
    await pool.query(
      `INSERT INTO medical_records (appointment_id, patient_id, doctor_id, diagnosis, notes) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE diagnosis = VALUES(diagnosis), notes = VALUES(notes)`,
      [appt.id, appt.patient_id, req.doctorId, diagnosis, notes || null]
    );
    await auditReq(req, pool, { action: 'MEDICAL_RECORD_SAVED', entityType: 'appointment', entityId: appt.id });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- patients (assigned only)
router.get(
  '/patients',
  validate({ query: schema.pagination }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = ["a.doctor_id = ? AND a.status <> 'Cancelled'"];
    const params = [req.doctorId];
    if (q.q) { where.push('(p.full_name LIKE ? OR p.medical_record_no = ?)'); params.push(likeContains(q.q), q.q); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(DISTINCT p.id) AS total FROM appointments a JOIN patients p ON p.id = a.patient_id ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT p.id, p.medical_record_no, p.full_name, p.date_of_birth, p.gender, p.phone,
              MAX(CASE WHEN a.scheduled_at <= NOW() THEN a.scheduled_at END) AS last_visit,
              MIN(CASE WHEN a.scheduled_at > NOW() AND a.status IN ('Scheduled','Confirmed') THEN a.scheduled_at END) AS next_visit,
              COUNT(a.id) AS appointment_count
       FROM appointments a JOIN patients p ON p.id = a.patient_id ${clause}
       GROUP BY p.id, p.medical_record_no, p.full_name, p.date_of_birth, p.gender, p.phone
       ORDER BY p.full_name LIMIT ? OFFSET ?`,
      [...params, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

router.get(
  '/patients/:id',
  validate({ params: z.object({ id: schema.id }) }),
  asyncHandler(async (req, res) => {
    const patientId = req.valid.params.id;
    await assertAssigned(pool, req.doctorId, patientId);
    const [[patient]] = await pool.query(
      'SELECT id, medical_record_no, full_name, date_of_birth, gender, phone, blood_type FROM patients WHERE id = ?',
      [patientId]
    );
    const [history] = await pool.query(
      `SELECT a.id, a.scheduled_at, a.status, a.reason, mr.diagnosis, mr.notes
       FROM appointments a LEFT JOIN medical_records mr ON mr.appointment_id = a.id
       WHERE a.patient_id = ? AND a.doctor_id = ? ORDER BY a.scheduled_at DESC LIMIT 50`,
      [patientId, req.doctorId]
    );
    const [prescriptions] = await pool.query(
      `SELECT rx.id, rx.status, rx.created_at, (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS item_count
       FROM prescriptions rx WHERE rx.patient_id = ? AND rx.doctor_id = ? ORDER BY rx.id DESC LIMIT 50`,
      [patientId, req.doctorId]
    );
    await auditReq(req, pool, { action: 'PATIENT_RECORD_VIEWED', entityType: 'patient', entityId: patientId });
    res.json(camelize({ ...patient, appointments: history, prescriptions }));
  })
);

// ---------------------------------------------------------------- medication catalogue (NO stock or price: not the doctor's business)
router.get(
  '/medications',
  validate({ query: z.object({ q: z.string().trim().max(100).optional() }) }),
  asyncHandler(async (req, res) => {
    const { q } = req.valid.query;
    const params = [];
    let where = 'WHERE is_active = 1';
    if (q) { where += ' AND (name LIKE ? OR generic_name LIKE ?)'; params.push(likeContains(q), likeContains(q)); }
    const [rows] = await pool.query(`SELECT id, name, generic_name, form, strength FROM medications ${where} ORDER BY name, strength LIMIT 50`, params);
    res.json({ data: camelize(rows) });
  })
);

// ---------------------------------------------------------------- prescriptions
const itemSchema = z.object({
  medicationId: schema.id,
  dosage: schema.shortText(60),
  frequency: schema.shortText(60),
  durationDays: z.coerce.number().int().min(1).max(365),
  quantity: z.coerce.number().int().min(1).max(1000),
  instructions: schema.optionalText(255),
});

router.post(
  '/prescriptions',
  validate({
    body: z.object({
      patientId: schema.id,
      appointmentId: schema.id.optional(),
      notes: schema.optionalText(500),
      items: z.array(itemSchema).min(1).max(20),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const medIds = b.items.map((i) => i.medicationId);
    if (new Set(medIds).size !== medIds.length) throw conflict('Each medication can appear only once per prescription', 'DUPLICATE_ITEM');

    const rxId = await withTransaction(async (conn) => {
      await assertAssigned(conn, req.doctorId, b.patientId);
      if (b.appointmentId) {
        const [a] = await conn.query('SELECT id FROM appointments WHERE id = ? AND doctor_id = ? AND patient_id = ?', [b.appointmentId, req.doctorId, b.patientId]);
        if (!a.length) throw notFound('Appointment not found for this doctor and patient');
      }
      const [meds] = await conn.query('SELECT id FROM medications WHERE id IN (?) AND is_active = 1', [medIds]);
      if (meds.length !== medIds.length) throw conflict('One or more medications do not exist or are inactive', 'INVALID_MEDICATION');

      const [rx] = await conn.query('INSERT INTO prescriptions (appointment_id, patient_id, doctor_id, notes) VALUES (?, ?, ?, ?)', [
        b.appointmentId || null, b.patientId, req.doctorId, b.notes || null,
      ]);
      for (const it of b.items) {
        await conn.query(
          `INSERT INTO prescription_items (prescription_id, medication_id, dosage, frequency, duration_days, instructions, quantity_prescribed)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [rx.insertId, it.medicationId, it.dosage, it.frequency, it.durationDays, it.instructions || null, it.quantity]
        );
      }
      await auditReq(req, conn, { action: 'PRESCRIPTION_CREATED', entityType: 'prescription', entityId: rx.insertId, details: { patientId: b.patientId, items: b.items.length } });
      return rx.insertId;
    });
    // Status is 'Pending' by default, so the prescription is immediately visible in the pharmacist queue.
    res.status(201).json({ id: rxId, status: 'Pending' });
  })
);

router.get(
  '/prescriptions',
  validate({ query: schema.pagination.extend({ status: z.enum(RX_STATUSES).optional(), patientId: schema.id.optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = ['rx.doctor_id = ?'];
    const params = [req.doctorId];
    if (q.status) { where.push('rx.status = ?'); params.push(q.status); }
    if (q.patientId) { where.push('rx.patient_id = ?'); params.push(q.patientId); }
    if (q.q) { where.push('p.full_name LIKE ?'); params.push(likeContains(q.q)); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT rx.id, rx.status, rx.created_at, p.id AS patient_id, p.full_name AS patient_name,
              (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS item_count
       FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id ${clause} ORDER BY rx.id DESC LIMIT ? OFFSET ?`,
      [...params, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

router.get(
  '/prescriptions/:id',
  validate({ params: z.object({ id: schema.id }) }),
  asyncHandler(async (req, res) => {
    const [[rx]] = await pool.query(
      `SELECT rx.id, rx.status, rx.notes, rx.created_at, p.id AS patient_id, p.full_name AS patient_name
       FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id WHERE rx.id = ? AND rx.doctor_id = ?`,
      [req.valid.params.id, req.doctorId]
    );
    if (!rx) throw notFound('Prescription not found');
    const [items] = await pool.query(
      `SELECT pi.id, m.name AS medication, m.strength, m.form, pi.dosage, pi.frequency, pi.duration_days, pi.instructions,
              pi.quantity_prescribed, pi.quantity_dispensed
       FROM prescription_items pi JOIN medications m ON m.id = pi.medication_id WHERE pi.prescription_id = ? ORDER BY pi.id`,
      [rx.id]
    );
    res.json(camelize({ ...rx, items }));
  })
);

// A doctor may cancel their own prescription only while nothing has been dispensed yet
router.post(
  '/prescriptions/:id/cancel',
  validate({ params: z.object({ id: schema.id }) }),
  asyncHandler(async (req, res) => {
    await withTransaction(async (conn) => {
      const [[rx]] = await conn.query('SELECT id, status FROM prescriptions WHERE id = ? AND doctor_id = ? FOR UPDATE', [req.valid.params.id, req.doctorId]);
      if (!rx) throw notFound('Prescription not found');
      if (rx.status !== 'Pending') throw conflict('Only a pending prescription (nothing dispensed yet) can be cancelled', 'INVALID_STATE');
      await conn.query("UPDATE prescriptions SET status = 'Cancelled', cancelled_at = NOW() WHERE id = ?", [rx.id]);
      await auditReq(req, conn, { action: 'PRESCRIPTION_CANCELLED', entityType: 'prescription', entityId: rx.id });
    });
    res.status(204).end();
  })
);

module.exports = router;
