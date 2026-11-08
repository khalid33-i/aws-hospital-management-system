const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const env = require('../config/env');
const { pool, withTransaction } = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, conflict, badRequest } = require('../utils/httpError');
const { asyncHandler, auditReq, camelize, likeContains, limitOffset, paged, schema } = require('../utils/helpers');
const { SETTING_SCHEMAS, getSettings } = require('../services/settings');
const { getPharmacyStats } = require('../services/pharmacy');

router.use(authenticate, authorize('Admin'));

// ---------------------------------------------------------------- dashboard
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const days = [6, 5, 4, 3, 2, 1, 0].map((n) => `SELECT CURDATE() - INTERVAL ${n} DAY AS day`).join(' UNION ALL ');
    const [[counts], [byStatus], [byRole], [perDay], [activity], [recent], [byDept], pharmacy] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*) FROM patients) AS total_patients,
        (SELECT COUNT(*) FROM doctors d JOIN users u ON u.id = d.user_id WHERE u.is_active = 1) AS total_doctors,
        (SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1 AND r.name <> 'Patient') AS total_employees,
        (SELECT COUNT(*) FROM appointments) AS total_appointments,
        (SELECT COUNT(*) FROM appointments WHERE DATE(scheduled_at) = CURDATE()) AS appointments_today`),
      pool.query('SELECT status, COUNT(*) AS count FROM appointments GROUP BY status'),
      pool.query('SELECT r.name AS role, COUNT(*) AS count FROM users u JOIN roles r ON r.id = u.role_id WHERE u.is_active = 1 GROUP BY r.name'),
      pool.query(`SELECT d.day, COUNT(a.id) AS count FROM (${days}) d LEFT JOIN appointments a ON DATE(a.scheduled_at) = d.day GROUP BY d.day ORDER BY d.day`),
      pool.query(`SELECT x.day, COUNT(l.id) AS count FROM (${days}) x LEFT JOIN audit_logs l ON DATE(l.created_at) = x.day GROUP BY x.day ORDER BY x.day`),
      pool.query(`SELECT l.id, l.action, l.entity_type, l.entity_id, l.created_at, u.full_name AS user_name
                  FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 10`),
      pool.query(`SELECT dep.name AS department, COUNT(d.id) AS doctors
                  FROM departments dep LEFT JOIN doctors d ON d.department_id = dep.id WHERE dep.is_active = 1 GROUP BY dep.id, dep.name ORDER BY dep.name`),
      getPharmacyStats(pool),
    ]);
    res.json(
      camelize({
        ...counts[0],
        appointmentsByStatus: byStatus,
        usersByRole: byRole,
        appointmentsPerDay: perDay,
        activityPerDay: activity,
        recentActivity: recent,
        doctorsByDepartment: byDept,
        pharmacy,
      })
    );
  })
);

router.get(
  '/pharmacy-stats',
  asyncHandler(async (req, res) => {
    res.json(await getPharmacyStats(pool));
  })
);

// ---------------------------------------------------------------- users
const ROLES = ['Admin', 'Doctor', 'Receptionist', 'Pharmacist', 'Patient'];
const base = { email: schema.email, fullName: schema.shortText(120), phone: schema.phone.optional(), password: schema.password };

const createUserSchema = z.discriminatedUnion('role', [
  z.object({ ...base, role: z.literal('Admin') }),
  z.object({
    ...base,
    role: z.literal('Doctor'),
    departmentId: schema.id,
    specialtyId: schema.id,
    licenseNo: schema.shortText(40),
    consultationFee: z.coerce.number().min(0).max(100000).default(0),
  }),
  z.object({ ...base, role: z.literal('Receptionist'), employeeNo: schema.shortText(30).optional() }),
  z.object({ ...base, role: z.literal('Pharmacist'), licenseNo: schema.shortText(40) }),
]);

const USER_SELECT = `
  SELECT u.id, u.email, u.full_name, u.phone, u.is_active, u.last_login_at, u.created_at, r.name AS role,
         d.id AS doctor_id, d.department_id, d.specialty_id, d.license_no AS doctor_license, d.consultation_fee,
         ph.license_no AS pharmacist_license, rc.employee_no
  FROM users u
  JOIN roles r ON r.id = u.role_id
  LEFT JOIN doctors d ON d.user_id = u.id
  LEFT JOIN pharmacists ph ON ph.user_id = u.id
  LEFT JOIN receptionists rc ON rc.user_id = u.id`;

router.get(
  '/users',
  validate({
    query: schema.pagination.extend({
      role: z.enum(ROLES).optional(),
      active: z.enum(['true', 'false']).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.role) { where.push('r.name = ?'); params.push(q.role); }
    if (q.active) { where.push('u.is_active = ?'); params.push(q.active === 'true' ? 1 : 0); }
    if (q.q) { where.push('(u.full_name LIKE ? OR u.email LIKE ?)'); params.push(likeContains(q.q), likeContains(q.q)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM users u JOIN roles r ON r.id = u.role_id ${clause}`, params);
    const [rows] = await pool.query(`${USER_SELECT} ${clause} ORDER BY u.id DESC LIMIT ? OFFSET ?`, [...params, ...limitOffset(q)]);
    res.json(paged(rows, q, total));
  })
);

router.get(
  '/users/:id',
  validate({ params: z.object({ id: schema.id }) }),
  asyncHandler(async (req, res) => {
    const [rows] = await pool.query(`${USER_SELECT} WHERE u.id = ?`, [req.valid.params.id]);
    if (!rows[0]) throw notFound('User not found');
    res.json(camelize(rows[0]));
  })
);

router.post(
  '/users',
  validate({ body: createUserSchema }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const hash = await bcrypt.hash(b.password, env.bcryptRounds);
    const userId = await withTransaction(async (conn) => {
      const [[role]] = await conn.query('SELECT id FROM roles WHERE name = ?', [b.role]);
      const [ins] = await conn.query('INSERT INTO users (role_id, email, password_hash, full_name, phone) VALUES (?, ?, ?, ?, ?)', [
        role.id, b.email, hash, b.fullName, b.phone || null,
      ]);
      const uid = ins.insertId;
      if (b.role === 'Doctor') {
        await conn.query('INSERT INTO doctors (user_id, department_id, specialty_id, license_no, consultation_fee) VALUES (?, ?, ?, ?, ?)', [
          uid, b.departmentId, b.specialtyId, b.licenseNo, b.consultationFee,
        ]);
      } else if (b.role === 'Pharmacist') {
        await conn.query('INSERT INTO pharmacists (user_id, license_no) VALUES (?, ?)', [uid, b.licenseNo]);
      } else if (b.role === 'Receptionist') {
        await conn.query('INSERT INTO receptionists (user_id, employee_no) VALUES (?, ?)', [uid, b.employeeNo || `REC-${String(uid).padStart(4, '0')}`]);
      }
      await auditReq(req, conn, { action: 'USER_CREATED', entityType: 'user', entityId: uid, details: { role: b.role, email: b.email } });
      return uid;
    });
    const [rows] = await pool.query(`${USER_SELECT} WHERE u.id = ?`, [userId]);
    res.status(201).json(camelize(rows[0]));
  })
);

const updateUserSchema = z.object({
  email: schema.email.optional(),
  fullName: schema.shortText(120).optional(),
  phone: schema.phone.optional(),
  departmentId: schema.id.optional(),
  specialtyId: schema.id.optional(),
  licenseNo: schema.shortText(40).optional(),
  consultationFee: z.coerce.number().min(0).max(100000).optional(),
  employeeNo: schema.shortText(30).optional(),
});

router.put(
  '/users/:id',
  validate({ params: z.object({ id: schema.id }), body: updateUserSchema }),
  asyncHandler(async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    await withTransaction(async (conn) => {
      const [[user]] = await conn.query('SELECT u.id, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE', [id]);
      if (!user) throw notFound('User not found');

      const sets = [];
      const params = [];
      if (b.email !== undefined) { sets.push('email = ?'); params.push(b.email); }
      if (b.fullName !== undefined) { sets.push('full_name = ?'); params.push(b.fullName); }
      if (b.phone !== undefined) { sets.push('phone = ?'); params.push(b.phone); }
      if (sets.length) await conn.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

      const profile = (table, map) => {
        const cols = Object.entries(map).filter(([key]) => b[key] !== undefined);
        if (!cols.length) return Promise.resolve();
        return conn.query(`UPDATE ${table} SET ${cols.map(([, col]) => `${col} = ?`).join(', ')} WHERE user_id = ?`, [...cols.map(([key]) => b[key]), id]);
      };
      if (user.role === 'Doctor') {
        await profile('doctors', { departmentId: 'department_id', specialtyId: 'specialty_id', licenseNo: 'license_no', consultationFee: 'consultation_fee' });
      } else if (user.role === 'Pharmacist') {
        await profile('pharmacists', { licenseNo: 'license_no' });
      } else if (user.role === 'Receptionist') {
        await profile('receptionists', { employeeNo: 'employee_no' });
      }
      await auditReq(req, conn, { action: 'USER_UPDATED', entityType: 'user', entityId: id, details: { fields: Object.keys(b) } });
    });
    const [rows] = await pool.query(`${USER_SELECT} WHERE u.id = ?`, [id]);
    res.json(camelize(rows[0]));
  })
);

async function setActive(req, res, active) {
  const { id } = req.valid.params;
  await withTransaction(async (conn) => {
    const [[user]] = await conn.query('SELECT u.id, u.is_active, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE', [id]);
    if (!user) throw notFound('User not found');
    if (!active) {
      if (id === req.user.id) throw badRequest('You cannot deactivate your own account');
      if (user.role === 'Admin') {
        const [[{ n }]] = await conn.query("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'Admin' AND u.is_active = 1 AND u.id <> ?", [id]);
        if (n === 0) throw conflict('At least one active administrator is required', 'LAST_ADMIN');
      }
    }
    await conn.query('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]);
    await auditReq(req, conn, { action: active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', entityType: 'user', entityId: id });
  });
  res.status(204).end();
}
router.post('/users/:id/deactivate', validate({ params: z.object({ id: schema.id }) }), asyncHandler((req, res) => setActive(req, res, false)));
router.post('/users/:id/activate', validate({ params: z.object({ id: schema.id }) }), asyncHandler((req, res) => setActive(req, res, true)));

router.post(
  '/users/:id/reset-password',
  validate({ params: z.object({ id: schema.id }), body: z.object({ newPassword: schema.password }) }),
  asyncHandler(async (req, res) => {
    const hash = await bcrypt.hash(req.valid.body.newPassword, env.bcryptRounds);
    const [r] = await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.valid.params.id]);
    if (!r.affectedRows) throw notFound('User not found');
    await auditReq(req, pool, { action: 'PASSWORD_RESET', entityType: 'user', entityId: req.valid.params.id });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- departments & specialties
function lookupCrud(path, table, { withDescription }) {
  const body = z.object({
    name: schema.shortText(100),
    ...(withDescription ? { description: schema.optionalText(255) } : {}),
    isActive: z.boolean().optional(),
  });
  const cols = withDescription ? 'id, name, description, is_active' : 'id, name, is_active';

  router.get(
    `/${path}`,
    asyncHandler(async (req, res) => {
      const [rows] = await pool.query(`SELECT ${cols} FROM ${table} ORDER BY name`);
      res.json({ data: camelize(rows) });
    })
  );
  router.post(
    `/${path}`,
    validate({ body }),
    asyncHandler(async (req, res) => {
      const b = req.valid.body;
      const [r] = withDescription
        ? await pool.query(`INSERT INTO ${table} (name, description) VALUES (?, ?)`, [b.name, b.description || null])
        : await pool.query(`INSERT INTO ${table} (name) VALUES (?)`, [b.name]);
      await auditReq(req, pool, { action: `${table.toUpperCase()}_CREATED`, entityType: table, entityId: r.insertId, details: { name: b.name } });
      res.status(201).json({ id: r.insertId, name: b.name });
    })
  );
  router.put(
    `/${path}/:id`,
    validate({ params: z.object({ id: schema.id }), body }),
    asyncHandler(async (req, res) => {
      const b = req.valid.body;
      const sets = ['name = ?'];
      const params = [b.name];
      if (withDescription) { sets.push('description = ?'); params.push(b.description || null); }
      if (b.isActive !== undefined) { sets.push('is_active = ?'); params.push(b.isActive ? 1 : 0); }
      const [r] = await pool.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...params, req.valid.params.id]);
      if (!r.affectedRows) throw notFound();
      await auditReq(req, pool, { action: `${table.toUpperCase()}_UPDATED`, entityType: table, entityId: req.valid.params.id });
      res.status(204).end();
    })
  );
}
lookupCrud('departments', 'departments', { withDescription: true });
lookupCrud('specialties', 'specialties', { withDescription: false });

// ---------------------------------------------------------------- settings
router.get(
  '/settings',
  asyncHandler(async (req, res) => {
    res.json(await getSettings(pool));
  })
);

router.put(
  '/settings',
  validate({ body: z.record(z.string(), z.union([z.string(), z.number()])) }),
  asyncHandler(async (req, res) => {
    const entries = Object.entries(req.valid.body);
    if (!entries.length) throw badRequest('No settings provided');
    const clean = {};
    for (const [key, value] of entries) {
      if (!SETTING_SCHEMAS[key]) throw badRequest(`Unknown setting: ${key}`);
      clean[key] = SETTING_SCHEMAS[key].parse(value);
    }
    if (clean.clinic_open || clean.clinic_close) {
      const current = await getSettings(pool);
      if ((clean.clinic_open || current.clinic_open) >= (clean.clinic_close || current.clinic_close)) throw badRequest('Clinic opening time must be before closing time');
    }
    await withTransaction(async (conn) => {
      for (const [key, value] of Object.entries(clean)) {
        await conn.query(
          'INSERT INTO system_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
          [key, value, req.user.id]
        );
      }
      await auditReq(req, conn, { action: 'SETTINGS_UPDATED', entityType: 'settings', details: clean });
    });
    res.json(await getSettings(pool));
  })
);

// ---------------------------------------------------------------- audit logs
router.get(
  '/audit-logs',
  validate({
    query: schema.pagination.extend({
      action: z.string().trim().max(60).optional(),
      userId: schema.id.optional(),
      from: schema.dateOnly.optional(),
      to: schema.dateOnly.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.action) { where.push('l.action = ?'); params.push(q.action); }
    if (q.userId) { where.push('l.user_id = ?'); params.push(q.userId); }
    if (q.from) { where.push('l.created_at >= ?'); params.push(q.from); }
    if (q.to) { where.push('l.created_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(q.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM audit_logs l ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT l.id, l.action, l.entity_type, l.entity_id, l.details, l.ip_address, l.created_at, u.full_name AS user_name, r.name AS user_role
       FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN roles r ON r.id = u.role_id
       ${clause} ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      [...params, ...limitOffset(q)]
    );
    // MySQL returns JSON columns as objects, MariaDB as strings: normalise
    for (const row of rows) if (typeof row.details === 'string') { try { row.details = JSON.parse(row.details); } catch (e) { /* keep raw */ } }
    res.json(paged(rows, q, total));
  })
);

module.exports = router;
