const router = require('express').Router();
const { z } = require('zod');
const { pool, withTransaction } = require('../config/db');
const { authenticate, authorize, loadProfile } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { notFound, conflict } = require('../utils/httpError');
const { asyncHandler, auditReq, camelize, likeContains, limitOffset, paged, schema } = require('../utils/helpers');
const { getPharmacyStats } = require('../services/pharmacy');
const { getSettings } = require('../services/settings');
const { dispensePrescription } = require('../services/dispensing');

/*
 * Pharmacist API. There is deliberately NO route that edits prescriptions or prescription items:
 * the only way a prescription changes here is through dispensing (quantity_dispensed + status),
 * which runs in a transaction inside services/dispensing.js.
 */
router.use(authenticate, authorize('Pharmacist'), loadProfile('pharmacist'));

router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const stats = await getPharmacyStats(pool);
    const [lowStock] = await pool.query(
      `SELECT m.id, m.name, m.strength, m.reorder_level, COALESCE(SUM(CASE WHEN i.expiry_date >= CURDATE() THEN i.quantity END), 0) AS available
       FROM medications m LEFT JOIN pharmacy_inventory i ON i.medication_id = m.id
       WHERE m.is_active = 1 GROUP BY m.id, m.name, m.strength, m.reorder_level
       HAVING available <= m.reorder_level ORDER BY available, m.name LIMIT 8`
    );
    const [expiring] = await pool.query(
      `SELECT m.name, m.strength, i.batch_no, i.quantity, i.expiry_date, (i.expiry_date < CURDATE()) AS is_expired
       FROM pharmacy_inventory i JOIN medications m ON m.id = i.medication_id
       WHERE i.quantity > 0 AND i.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) ORDER BY i.expiry_date LIMIT 8`
    );
    res.json({ ...stats, ...camelize({ lowStock, expiring }) });
  })
);

// ---------------------------------------------------------------- medications
const FORMS = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Cream', 'Drops', 'Inhaler'];
const medicationBody = z.object({
  name: schema.shortText(120),
  genericName: schema.optionalText(120),
  form: z.enum(FORMS),
  strength: schema.shortText(40),
  unitPrice: z.coerce.number().min(0).max(100000),
  reorderLevel: z.coerce.number().int().min(0).max(100000).optional(),
});

const MED_LIST_SELECT = `
  SELECT m.id, m.name, m.generic_name, m.form, m.strength, m.unit_price, m.reorder_level, m.is_active,
         COALESCE(SUM(CASE WHEN i.expiry_date >= CURDATE() THEN i.quantity END), 0) AS available,
         COALESCE(SUM(CASE WHEN i.expiry_date < CURDATE() THEN i.quantity END), 0) AS expired_units,
         MIN(CASE WHEN i.quantity > 0 THEN i.expiry_date END) AS nearest_expiry
  FROM medications m LEFT JOIN pharmacy_inventory i ON i.medication_id = m.id`;

router.get(
  '/medications',
  validate({ query: schema.pagination.extend({ filter: z.enum(['all', 'low', 'out', 'expired', 'inactive']).default('all') }) }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.filter === 'inactive') where.push('m.is_active = 0');
    else where.push('m.is_active = 1');
    if (q.q) { where.push('(m.name LIKE ? OR m.generic_name LIKE ?)'); params.push(likeContains(q.q), likeContains(q.q)); }
    const having = { all: '', low: 'HAVING available <= m.reorder_level', out: 'HAVING available = 0', expired: 'HAVING expired_units > 0', inactive: '' }[q.filter];
    const base = `${MED_LIST_SELECT} WHERE ${where.join(' AND ')} GROUP BY m.id ${having}`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM (${base}) t`, params);
    const [rows] = await pool.query(`${base} ORDER BY m.name, m.strength LIMIT ? OFFSET ?`, [...params, ...limitOffset(q)]);
    res.json(paged(rows, q, total));
  })
);

router.post(
  '/medications',
  validate({ body: medicationBody }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const reorder = b.reorderLevel ?? Number((await getSettings(pool)).default_reorder_level);
    const [r] = await pool.query(
      'INSERT INTO medications (name, generic_name, form, strength, unit_price, reorder_level) VALUES (?, ?, ?, ?, ?, ?)',
      [b.name, b.genericName || null, b.form, b.strength, b.unitPrice, reorder]
    );
    await auditReq(req, pool, { action: 'MEDICATION_CREATED', entityType: 'medication', entityId: r.insertId, details: { name: b.name } });
    res.status(201).json({ id: r.insertId });
  })
);

router.put(
  '/medications/:id',
  validate({ params: z.object({ id: schema.id }), body: medicationBody }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const [r] = await pool.query(
      `UPDATE medications SET name = ?, generic_name = ?, form = ?, strength = ?, unit_price = ?, reorder_level = COALESCE(?, reorder_level) WHERE id = ?`,
      [b.name, b.genericName || null, b.form, b.strength, b.unitPrice, b.reorderLevel ?? null, req.valid.params.id]
    );
    if (!r.affectedRows) throw notFound('Medication not found');
    await auditReq(req, pool, { action: 'MEDICATION_UPDATED', entityType: 'medication', entityId: req.valid.params.id });
    res.status(204).end();
  })
);

async function setMedicationActive(req, res, active) {
  const [r] = await pool.query('UPDATE medications SET is_active = ? WHERE id = ?', [active ? 1 : 0, req.valid.params.id]);
  if (!r.affectedRows) throw notFound('Medication not found');
  await auditReq(req, pool, { action: active ? 'MEDICATION_ACTIVATED' : 'MEDICATION_DEACTIVATED', entityType: 'medication', entityId: req.valid.params.id });
  res.status(204).end();
}
const idParam = validate({ params: z.object({ id: schema.id }) });
router.post('/medications/:id/deactivate', idParam, asyncHandler((req, res) => setMedicationActive(req, res, false)));
router.post('/medications/:id/activate', idParam, asyncHandler((req, res) => setMedicationActive(req, res, true)));

// Hard delete only when the medication was never stocked or prescribed (foreign keys protect the rest)
router.delete(
  '/medications/:id',
  idParam,
  asyncHandler(async (req, res) => {
    const [r] = await pool.query('DELETE FROM medications WHERE id = ?', [req.valid.params.id]);
    if (!r.affectedRows) throw notFound('Medication not found');
    await auditReq(req, pool, { action: 'MEDICATION_DELETED', entityType: 'medication', entityId: req.valid.params.id });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- inventory (batches)
router.get(
  '/inventory',
  validate({ query: schema.pagination.extend({ medicationId: schema.id.optional(), status: z.enum(['all', 'expired', 'expiring']).default('all') }) }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.medicationId) { where.push('i.medication_id = ?'); params.push(q.medicationId); }
    if (q.status === 'expired') where.push('i.expiry_date < CURDATE() AND i.quantity > 0');
    if (q.status === 'expiring') where.push('i.expiry_date >= CURDATE() AND i.expiry_date <= DATE_ADD(CURDATE(), INTERVAL 30 DAY) AND i.quantity > 0');
    if (q.q) { where.push('m.name LIKE ?'); params.push(likeContains(q.q)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = 'FROM pharmacy_inventory i JOIN medications m ON m.id = i.medication_id';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT i.id, i.medication_id, m.name, m.strength, i.batch_no, i.quantity, i.expiry_date, (i.expiry_date < CURDATE()) AS is_expired
       ${from} ${clause} ORDER BY i.expiry_date, i.id LIMIT ? OFFSET ?`,
      [...params, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

router.post(
  '/inventory',
  validate({
    body: z.object({
      medicationId: schema.id,
      batchNo: schema.shortText(40),
      quantity: z.coerce.number().int().min(1).max(1000000),
      expiryDate: schema.dateOnly,
    }),
  }),
  asyncHandler(async (req, res) => {
    const b = req.valid.body;
    const [[today]] = await pool.query('SELECT (? > CURDATE()) AS ok', [b.expiryDate]);
    if (!today.ok) throw conflict('Cannot receive stock that is already expired or expires today', 'EXPIRED_STOCK');
    const [r] = await pool.query('INSERT INTO pharmacy_inventory (medication_id, batch_no, quantity, expiry_date) VALUES (?, ?, ?, ?)', [
      b.medicationId, b.batchNo, b.quantity, b.expiryDate,
    ]);
    await auditReq(req, pool, { action: 'STOCK_RECEIVED', entityType: 'inventory', entityId: r.insertId, details: { medicationId: b.medicationId, batchNo: b.batchNo, quantity: b.quantity } });
    res.status(201).json({ id: r.insertId });
  })
);

// Manual correction (damage, recount). The WHERE clause makes a negative result impossible.
router.post(
  '/inventory/:id/adjust',
  validate({
    params: z.object({ id: schema.id }),
    body: z.object({ delta: z.coerce.number().int().min(-1000000).max(1000000).refine((n) => n !== 0, 'Delta cannot be 0'), reason: schema.shortText(255) }),
  }),
  asyncHandler(async (req, res) => {
    const { delta, reason } = req.valid.body;
    await withTransaction(async (conn) => {
      const [r] = await conn.query('UPDATE pharmacy_inventory SET quantity = quantity + ? WHERE id = ? AND quantity + ? >= 0', [delta, req.valid.params.id, delta]);
      if (!r.affectedRows) {
        const [[exists]] = await conn.query('SELECT id FROM pharmacy_inventory WHERE id = ?', [req.valid.params.id]);
        if (!exists) throw notFound('Batch not found');
        throw conflict('Adjustment would make the stock negative', 'NEGATIVE_STOCK');
      }
      await auditReq(req, conn, { action: 'STOCK_ADJUSTED', entityType: 'inventory', entityId: req.valid.params.id, details: { delta, reason } });
    });
    res.status(204).end();
  })
);

// ---------------------------------------------------------------- prescriptions (read-only + dispensing)
const RX_STATUSES = ['Pending', 'Partially Dispensed', 'Dispensed', 'Cancelled'];

router.get(
  '/prescriptions',
  validate({ query: schema.pagination.extend({ status: z.enum([...RX_STATUSES, 'Open']).optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.status === 'Open') where.push("rx.status IN ('Pending','Partially Dispensed')");
    else if (q.status) { where.push('rx.status = ?'); params.push(q.status); }
    if (q.q) { where.push('(p.full_name LIKE ? OR p.medical_record_no = ?)'); params.push(likeContains(q.q), q.q); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT rx.id, rx.status, rx.created_at, p.full_name AS patient_name, p.medical_record_no, du.full_name AS doctor_name,
              (SELECT COUNT(*) FROM prescription_items pi WHERE pi.prescription_id = rx.id) AS item_count
       FROM prescriptions rx
       JOIN patients p ON p.id = rx.patient_id
       JOIN doctors d ON d.id = rx.doctor_id JOIN users du ON du.id = d.user_id
       ${clause} ORDER BY rx.created_at ASC, rx.id ASC LIMIT ? OFFSET ?`,
      [...params, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

router.get(
  '/prescriptions/:id',
  idParam,
  asyncHandler(async (req, res) => {
    const [[rx]] = await pool.query(
      `SELECT rx.id, rx.status, rx.notes, rx.created_at,
              p.full_name AS patient_name, p.medical_record_no, p.date_of_birth, p.gender, p.phone AS patient_phone,
              du.full_name AS doctor_name, dep.name AS department
       FROM prescriptions rx
       JOIN patients p ON p.id = rx.patient_id
       JOIN doctors d ON d.id = rx.doctor_id JOIN users du ON du.id = d.user_id
       JOIN departments dep ON dep.id = d.department_id
       WHERE rx.id = ?`,
      [req.valid.params.id]
    );
    if (!rx) throw notFound('Prescription not found');
    const [items] = await pool.query(
      `SELECT pi.id, m.id AS medication_id, m.name AS medication, m.strength, m.form, m.unit_price, m.is_active,
              pi.dosage, pi.frequency, pi.duration_days, pi.instructions, pi.quantity_prescribed, pi.quantity_dispensed,
              (pi.quantity_prescribed - pi.quantity_dispensed) AS remaining,
              (SELECT COALESCE(SUM(i.quantity), 0) FROM pharmacy_inventory i WHERE i.medication_id = m.id AND i.expiry_date >= CURDATE()) AS available_stock
       FROM prescription_items pi JOIN medications m ON m.id = pi.medication_id WHERE pi.prescription_id = ? ORDER BY pi.id`,
      [rx.id]
    );
    const [history] = await pool.query(
      `SELECT dr.id, dr.quantity, dr.dispensed_at, dr.request_key, m.name AS medication, i.batch_no, pu.full_name AS pharmacist_name
       FROM dispensing_records dr
       JOIN prescription_items pi ON pi.id = dr.prescription_item_id JOIN medications m ON m.id = pi.medication_id
       JOIN pharmacy_inventory i ON i.id = dr.inventory_id
       JOIN pharmacists ph ON ph.id = dr.pharmacist_id JOIN users pu ON pu.id = ph.user_id
       WHERE pi.prescription_id = ? ORDER BY dr.id`,
      [rx.id]
    );
    await auditReq(req, pool, { action: 'PRESCRIPTION_VIEWED', entityType: 'prescription', entityId: rx.id });
    res.json(camelize({ ...rx, items, dispensing: history }));
  })
);

router.post(
  '/prescriptions/:id/dispense',
  validate({
    params: z.object({ id: schema.id }),
    body: z.object({
      requestKey: z.string().trim().regex(/^[A-Za-z0-9_-]{8,64}$/, 'requestKey must be 8-64 letters, digits, - or _'),
      items: z
        .array(z.object({ itemId: schema.id, quantity: z.coerce.number().int().min(1).max(100000) }))
        .min(1)
        .max(20)
        .refine((list) => new Set(list.map((i) => i.itemId)).size === list.length, 'Each item can appear only once'),
    }),
  }),
  asyncHandler(async (req, res) => {
    const result = await dispensePrescription({
      prescriptionId: req.valid.params.id,
      pharmacistId: req.pharmacistId,
      userId: req.user.id,
      requestKey: req.valid.body.requestKey,
      items: req.valid.body.items,
      ip: req.ip,
    });
    res.status(200).json(result);
  })
);

router.get(
  '/dispensing-history',
  validate({ query: schema.pagination.extend({ from: schema.dateOnly.optional(), to: schema.dateOnly.optional() }) }),
  asyncHandler(async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.from) { where.push('dr.dispensed_at >= ?'); params.push(q.from); }
    if (q.to) { where.push('dr.dispensed_at < DATE_ADD(?, INTERVAL 1 DAY)'); params.push(q.to); }
    if (q.q) { where.push('(m.name LIKE ? OR p.full_name LIKE ?)'); params.push(likeContains(q.q), likeContains(q.q)); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const from = `FROM dispensing_records dr
      JOIN prescription_items pi ON pi.id = dr.prescription_item_id
      JOIN prescriptions rx ON rx.id = pi.prescription_id
      JOIN patients p ON p.id = rx.patient_id
      JOIN medications m ON m.id = pi.medication_id
      JOIN pharmacy_inventory i ON i.id = dr.inventory_id
      JOIN pharmacists ph ON ph.id = dr.pharmacist_id JOIN users pu ON pu.id = ph.user_id`;
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from} ${clause}`, params);
    const [rows] = await pool.query(
      `SELECT dr.id, dr.dispensed_at, dr.quantity, dr.unit_price, rx.id AS prescription_id, p.full_name AS patient_name,
              m.name AS medication, m.strength, i.batch_no, pu.full_name AS pharmacist_name
       ${from} ${clause} ORDER BY dr.id DESC LIMIT ? OFFSET ?`,
      [...params, ...limitOffset(q)]
    );
    res.json(paged(rows, q, total));
  })
);

module.exports = router;
