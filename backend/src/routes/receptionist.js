const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const env = require('../config/env');
const { pool, withTransaction } = require('../config/db');
const { authenticate, authorize, loadProfile } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, badRequest } = require('../utils/httpError');
const { asyncHandler, auditReq, camelize, likeContains, limitOffset, paged, schema } = require('../utils/helpers');
const appts = require('../services/appointments');

// Receptionists see patient demographics and the schedule only: no medical records, prescriptions or pharmacy data.
router.use(authenticate, authorize('Receptionist'), loadProfile('receptionist'));

// ---------------------------------------------------------------- patients
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

const patientFields = {
  fullName: schema.shortText(120),
  dateOfBirth: schema.dateOnly.refine((d) => d <= new Date().toISOString().slice(0, 10), 'Date of birth cannot be in the future'),
  gender: z.enum(['Male', 'Female']),
  phone: schema.phone,
  email: schema.email.optional(),
  address: schema.optionalText(255),
  bloodType: z.enum(BLOOD_TYPES).optional(),
  emergencyContactName: schema.optionalText(120),
  emergencyContactPhone: schema.phone.optional(),
};

const PATIENT_SELECT = `SELECT p.id, p.medical_record_no, p.full_name, p.date_of_birth, p.gender, p.phone, p.email, p.address,
  p.blood_type, p.emergency_contact_name, p.emergency_contact_phone, p.created_at, (p.user_id IS NOT NULL) AS is_portal_user
  FROM patients p`;

router.get(
  '/patients',
  validate({ query: schema.pagination }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const params = [];
    let clause = '';
    if (q.q) {
      clause = 'WHERE p.full_name LIKE ? OR p.phone LIKE ? OR p.medical_record_no = ?';
      params.push(likeContains(q.q), likeContains(q.q), q.q);
    }
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM patients p ${clause}`, params);
    const [rows] = await pool.query(`${PATIENT_SELECT} ${clause} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [...params, ...limitOffset(q)]);
    res.json(paged(rows, q, total));
  })
);

router.get(
  '/patients/:id',
  validate({ params: z.object({ id: schema.id }) }),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(`${PATIENT_SELECT} WHERE p.id = ?`, [req.valid.params.id]);
    if (!rows[0]) throw notFound('Patient not found');
    res.json(camelize(rows[0]));
  })
);

router.post(
  '/patients',
  validate({
    body: z.object({
      ...patientFields,
      // Optional: create a portal login for the patient at the same time
      account: z.object({ email: schema.email, password: schema.password }).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const hash = b.account ? await bcrypt.hash(b.account.password, env.bcryptRounds) : null;
    const patientId = await withTransaction(async (conn) => {
      let userId = null;
      if (b.account) {
        const [[role]] = await conn.query("SELECT id FROM roles WHERE name = 'Patient'");
        const [u] = await conn.query('INSERT INTO users (role_id, email, password_hash, full_name, phone) VALUES (?, ?, ?, ?, ?)', [
          role.id, b.account.email, hash, b.fullName, b.phone,
        ]);
        userId = u.insertId;
      }
      const [r] = await conn.query(
        `INSERT INTO patients (user_id, full_name, date_of_birth, gender, phone, email, address, blood_type,
                               emergency_contact_name, emergency_contact_phone, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, b.fullName, b.dateOfBirth, b.gender, b.phone, b.email || null, b.address || null, b.bloodType || null,
         b.emergencyContactName || null, b.emergencyContactPhone || null, req.user.id]
      );
      await conn.query('UPDATE patients SET medical_record_no = ? WHERE id = ?', [`MRN-${String(r.insertId).padStart(6, '0')}`, r.insertId]);
      await auditReq(req, conn, { action: 'PATIENT_REGISTERED', entityType: 'patient', entityId: r.insertId, details: { portalAccount: Boolean(b.account) } });
      return r.insertId;
    });
    const [rows] = await pool.query(`${PATIENT_SELECT} WHERE p.id = ?`, [patientId]);
    res.status(201).json(camelize(rows[0]));
  })
);

router.put(
  '/patients/:id',
  validate({ params: z.object({ id: schema.id }), body: z.object(patientFields) }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const [r] = await pool.query(
      `UPDATE patients SET full_name = ?, date_of_birth = ?, gender = ?, phone = ?, email = ?, address = ?, blood_type = ?,
              emergency_contact_name = ?, emergency_contact_phone = ? WHERE id = ?`,
      [b.fullName, b.dateOfBirth, b.gender, b.phone, b.email || null, b.address || null, b.bloodType || null,
       b.emergencyContactName || null, b.emergencyContactPhone || null, req.valid.params.id]
    );
    if (!r.affectedRows) throw notFound('Patient not found');
    await auditReq(req, pool, { action: 'PATIENT_UPDATED', entityType: 'patient', entityId: req.valid.params.id });
    const [rows] = await pool.query(`${PATIENT_SELECT} WHERE p.id = ?`, [req.valid.params.id]);
    res.json(camelize(rows[0]));
  })
);

// ---------------------------------------------------------------- appointments
const STATUSES = ['Scheduled', 'Confirmed', 'Completed', 'Cancelled', 'No-Show'];

router.get(
  '/appointments',
  validate({
    query: schema.pagination.extend({
      date: schema.dateOnly.optional(),
      doctorId: schema.id.optional(),
      patientId: schema.id.optional(),
      status: z.enum(STATUSES).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.date) { where.push('DATE(a.scheduled_at) = ?'); params.push(q.date); }
    if (q.doctorId) { where.push('a.doctor_id = ?'); params.push(q.doctorId); }
    if (q.patientId) { where.push('a.patient_id = ?'); params.push(q.patientId); }
    if (q.status) { where.push('a.status = ?'); params.push(q.status); }
    if (q.q) { where.push('(p.full_name LIKE ? OR p.medical_record_no = ?)'); params.push(likeContains(q.q), q.q); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM appointments a JOIN patients p ON p.id = a.patient_id ${clause}`,
      params
    );
    const [rows] = await pool.query(`${appts.APPOINTMENT_SELECT} ${clause} ORDER BY a.scheduled_at ${q.date ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`, [
      ...params,
      ...limitOffset(q),
    ]);
    res.json(paged(rows, q, total));
  })
);

router.post(
  '/appointments',
  validate({
    body: z.object({ patientId: schema.id, doctorId: schema.id, scheduledAt: schema.dateTime, reason: schema.optionalText(255) }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const id = await appts.bookAppointment(pool, { ...b, createdBy: req.user.id });
    await auditReq(req, pool, { action: 'APPOINTMENT_BOOKED', entityType: 'appointment', entityId: id, details: { doctorId: b.doctorId, scheduledAt: b.scheduledAt } });
    res.status(201).json({ id });
  })
);

router.put(
  '/appointments/:id/reschedule',
  validate({
    params: z.object({ id: schema.id }),
    body: z.object({ scheduledAt: schema.dateTime, doctorId: schema.id.optional() }),
  }),
  asyncHandler(async (req, res) => {
    await appts.rescheduleAppointment(pool, { appointmentId: req.valid.params.id, ...req.valid.body });
    await auditReq(req, pool, { action: 'APPOINTMENT_RESCHEDULED', entityType: 'appointment', entityId: req.valid.params.id, details: req.valid.body });
    res.status(204).end();
  })
);

router.post(
  '/appointments/:id/cancel',
  validate({ params: z.object({ id: schema.id }), body: z.object({ reason: schema.optionalText(255) }) }),
  asyncHandler(async (req, res) => {
    await appts.cancelAppointment(pool, { appointmentId: req.valid.params.id, actorUserId: req.user.id, reason: req.valid.body.reason, enforceWindow: false });
    await auditReq(req, pool, { action: 'APPOINTMENT_CANCELLED', entityType: 'appointment', entityId: req.valid.params.id });
    res.status(204).end();
  })
);

router.put(
  '/appointments/:id/status',
  validate({ params: z.object({ id: schema.id }), body: z.object({ status: z.enum(['Confirmed', 'No-Show', 'Cancelled']) }) }),
  asyncHandler(async (req, res) => {
    const { status } = req.valid.body;
    if (!status) throw badRequest('Status is required');
    await appts.changeStatus(pool, {
      appointmentId: req.valid.params.id,
      newStatus: status,
      allowedTargets: ['Confirmed', 'No-Show', 'Cancelled'],
      actorUserId: req.user.id,
    });
    await auditReq(req, pool, { action: 'APPOINTMENT_STATUS_CHANGED', entityType: 'appointment', entityId: req.valid.params.id, details: { status } });
    res.status(204).end();
  })
);

module.exports = router;
