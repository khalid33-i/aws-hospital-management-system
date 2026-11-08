// Read-only lookups any signed-in user may need (booking forms, filters). No sensitive data here.
const router = require('express').Router();
const { z } = require('zod');
const { pool } = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { asyncHandler, camelize, schema } = require('../utils/helpers');
const { getSettings } = require('../services/settings');

router.use(authenticate);

router.get(
  '/doctors',
  validate({ query: z.object({ departmentId: schema.id.optional() }) }),
  asyncHandler(async (req, res) => {
    const { departmentId } = req.valid.query;
    const params = [];
    let where = 'WHERE u.is_active = 1 AND dep.is_active = 1';
    if (departmentId) {
      where += ' AND d.department_id = ?';
      params.push(departmentId);
    }
    const [rows] = await pool.query(
      `SELECT d.id, u.full_name, dep.id AS department_id, dep.name AS department, s.name AS specialty, d.consultation_fee
       FROM doctors d
       JOIN users u ON u.id = d.user_id
       JOIN departments dep ON dep.id = d.department_id
       JOIN specialties s ON s.id = d.specialty_id
       ${where} ORDER BY u.full_name`,
      params
    );
    res.json({ data: camelize(rows) });
  })
);

router.get(
  '/doctors/:id/booked',
  validate({ params: z.object({ id: schema.id }), query: z.object({ date: schema.dateOnly }) }),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(
      "SELECT TIME_FORMAT(scheduled_at, '%H:%i') AS time FROM appointments WHERE doctor_id = ? AND DATE(scheduled_at) = ? AND status NOT IN ('Cancelled','No-Show')",
      [req.valid.params.id, req.valid.query.date]
    );
    res.json({ data: rows.map((r) => r.time) });
  })
);

router.get(
  '/departments',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT id, name FROM departments WHERE is_active = 1 ORDER BY name');
    res.json({ data: rows });
  })
);

router.get(
  '/specialties',
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query('SELECT id, name FROM specialties WHERE is_active = 1 ORDER BY name');
    res.json({ data: rows });
  })
);

// Public-ish scheduling settings (clinic hours, slot length, cancellation window)
router.get(
  '/scheduling',
  asyncHandler(async (req, res) => {
    const s = await getSettings(pool);
    res.json({
      hospitalName: s.hospital_name,
      clinicOpen: s.clinic_open,
      clinicClose: s.clinic_close,
      slotMinutes: Number(s.appointment_duration_minutes),
      cancellationWindowHours: Number(s.cancellation_window_hours),
    });
  })
);

module.exports = router;
