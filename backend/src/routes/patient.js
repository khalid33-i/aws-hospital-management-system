const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../config/db');
const { authenticate, authorize, loadProfile } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound } = require('../utils/httpError');
const { asyncHandler, auditReq, camelize, limitOffset, paged, schema } = require('../utils/helpers');
const appts = require('../services/appointments');

/*
 * Every query below is scoped with "patient_id = req.patientId" (taken from the signed-in account),
 * never from a URL or body value, so a patient can only ever read or change their own data.
 * Records that belong to someone else answer 404, exactly like records that do not exist.
 */
router.use(authenticate, authorize('Patient'), loadProfile('patient'));

// ---------------------------------------------------------------- profile
const PROFILE_SELECT = `SELECT id, medical_record_no, full_name, date_of_birth, gender, phone, email, address, blood_type,
  emergency_contact_name, emergency_contact_phone FROM patients WHERE id = ?`;

router.get(
  '/profile',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(PROFILE_SELECT, [req.patientId]);
    res.json(camelize(rows[0]));
  })
);

// Patients may change contact details only (name, date of birth, MRN and blood type are managed by staff)
router.put(
  '/profile',
  validate({
    body: z.object({
      phone: schema.phone,
      email: schema.email.optional(),
      address: schema.optionalText(255),
      emergencyContactName: schema.optionalText(120),
      emergencyContactPhone: schema.phone.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    await pool.query(
      'UPDATE patients SET phone = ?, email = ?, address = ?, emergency_contact_name = ?, emergency_contact_phone = ? WHERE id = ?',
      [b.phone, b.email || null, b.address || null, b.emergencyContactName || null, b.emergencyContactPhone || null, req.patientId]
    );
    await pool.query('UPDATE users SET phone = ? WHERE id = (SELECT user_id FROM patients WHERE id = ?)', [b.phone, req.patientId]);
    await auditReq(req, pool, { action: 'PROFILE_UPDATED', entityType: 'patient', entityId: req.patientId });
    const [rows] = await pool.query(PROFILE_SELECT, [req.patientId]);
    res.json(camelize(rows[0]));
  })
);

// ---------------------------------------------------------------- appointments
router.get(
  '/appointments',
  validate({ query: schema.pagination.extend({ scope: z.enum(['upcoming', 'history']).default('upcoming') }) }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    // upcoming = still open and in the future; history = everything else
    const cond = q.scope === 'upcoming' ? "a.status IN ('Scheduled','Confirmed') AND a.scheduled_at >= NOW()" : "NOT (a.status IN ('Scheduled','Confirmed') AND a.scheduled_at >= NOW())";
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM appointments a WHERE a.patient_id = ? AND ${cond}`, [req.patientId]);
    const [rows] = await pool.query(
      `${appts.APPOINTMENT_SELECT} WHERE a.patient_id = ? AND ${cond} ORDER BY a.scheduled_at ${q.scope === 'upcoming' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
      [req.patientId, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

router.post(
  '/appointments',
  validate({ body: z.object({ doctorId: schema.id, scheduledAt: schema.dateTime, reason: schema.optionalText(255) }) }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const id = await appts.bookAppointment(pool, { patientId: req.patientId, doctorId: b.doctorId, scheduledAt: b.scheduledAt, reason: b.reason, createdBy: req.user.id });
    await auditReq(req, pool, { action: 'APPOINTMENT_BOOKED', entityType: 'appointment', entityId: id, details: { by: 'patient' } });
    res.status(201).json({ id });
  })
);

router.post(
  '/appointments/:id/cancel',
  validate({ params: z.object({ id: schema.id }), body: z.object({ reason: schema.optionalText(255) }) }),
  asyncHandler(async (req, res) => {
    await appts.cancelAppointment(pool, {
      appointmentId: req.valid.params.id,
      actorUserId: req.user.id,
      reason: req.valid.body.reason,
      patientId: req.patientId,
      enforceWindow: true, // patients must respect the cancellation window from system settings
    });
    await auditReq(req, pool, { action: 'APPOINTMENT_CANCELLED', entityType: 'appointment', entityId: req.valid.params.id, details: { by: 'patient' } });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- visits (completed appointments + the doctor's record)
router.get(
  '/visits',
  validate({ query: schema.pagination }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM appointments WHERE patient_id = ? AND status = 'Completed'", [req.patientId]);
    const [rows] = await pool.query(
      `SELECT a.id, a.scheduled_at, a.reason, du.full_name AS doctor_name, dep.name AS department, mr.diagnosis, mr.notes
       FROM appointments a
       JOIN doctors d ON d.id = a.doctor_id JOIN users du ON du.id = d.user_id JOIN departments dep ON dep.id = d.department_id
       LEFT JOIN medical_records mr ON mr.appointment_id = a.id
       WHERE a.patient_id = ? AND a.status = 'Completed' ORDER BY a.scheduled_at DESC LIMIT ? OFFSET ?`,
      [req.patientId, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

// ---------------------------------------------------------------- prescriptions
router.get(
  '/prescriptions',
  validate({ query: schema.pagination }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM prescriptions WHERE patient_id = ?', [req.patientId]);
    const [rows] = await pool.query(
      `SELECT rx.id, rx.status, rx.created_at, du.full_name AS doctor_name,
              (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS item_count
       FROM prescriptions rx JOIN doctors d ON d.id = rx.doctor_id JOIN users du ON du.id = d.user_id
       WHERE rx.patient_id = ? ORDER BY rx.id DESC LIMIT ? OFFSET ?`,
      [req.patientId, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

router.get(
  '/prescriptions/:id',
  validate({ params: z.object({ id: schema.id }) }),
  asyncHandler(async (req, res) => {
    const [[rx]] = await pool.query(
      `SELECT rx.id, rx.status, rx.notes, rx.created_at, du.full_name AS doctor_name, dep.name AS department
       FROM prescriptions rx JOIN doctors d ON d.id = rx.doctor_id JOIN users du ON du.id = d.user_id JOIN departments dep ON dep.id = d.department_id
       WHERE rx.id = ? AND rx.patient_id = ?`,
      [req.valid.params.id, req.patientId]
    );
    if (!rx) throw notFound('Prescription not found');
    const [items] = await pool.query(
      `SELECT pi.id, m.name AS medication, m.generic_name, m.strength, m.form, pi.dosage, pi.frequency, pi.duration_days, pi.instructions,
              pi.quantity_prescribed, pi.quantity_dispensed,
              (SELECT MAX(dr.dispensed_at) FROM dispensing_records dr WHERE dr.prescription_item_id = pi.id) AS last_dispensed_at
       FROM prescription_items pi JOIN medications m ON m.id = pi.medication_id WHERE pi.prescription_id = ? ORDER BY pi.id`,
      [rx.id]
    );
    res.json(camelize({ ...rx, items }));
  })
);

module.exports = router;
