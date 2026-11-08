const { z } = require('zod');

// ---- async + audit ---------------------------------------------------------
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Writes an audit row. Pass a transaction connection so the log rolls back together with the change. */
async function writeAudit(executor, { userId = null, action, entityType = null, entityId = null, details = null, ip = null }) {
  await executor.query(
    'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [userId, action, entityType, entityId == null ? null : String(entityId), details ? JSON.stringify(details) : null, ip]
  );
}

const auditReq = (req, executor, data) => writeAudit(executor, { userId: req.user ? req.user.id : null, ip: req.ip, ...data });

// ---- response shaping --------------------------------------------------------
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** snake_case DB rows -> camelCase JSON; columns named is_* become booleans. */
function camelize(value) {
  if (Array.isArray(value)) return value.map(camelize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[toCamel(key)] = key.startsWith('is_') ? Boolean(val) : camelize(val);
    }
    return out;
  }
  return value;
}

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
const likeContains = (s) => `%${escapeLike(s)}%`;

// ---- shared zod building blocks ------------------------------------------------
const isRealDate = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

const id = z.coerce.number().int().positive();

const password = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Password needs a lowercase letter')
  .regex(/[A-Z]/, 'Password needs an uppercase letter')
  .regex(/\d/, 'Password needs a digit');

const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use format YYYY-MM-DD')
  .refine((s) => {
    const [y, m, d] = s.split('-').map(Number);
    return isRealDate(y, m, d);
  }, 'Invalid date');

/** 'YYYY-MM-DD HH:mm' or 'YYYY-MM-DDTHH:mm' -> 'YYYY-MM-DD HH:mm:00' */
const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/, 'Use format YYYY-MM-DD HH:mm')
  .refine((s) => {
    const [y, m, d] = s.slice(0, 10).split('-').map(Number);
    const hh = Number(s.slice(11, 13));
    const mm = Number(s.slice(14, 16));
    return isRealDate(y, m, d) && hh < 24 && mm < 60;
  }, 'Invalid date or time')
  .transform((s) => `${s.slice(0, 10)} ${s.slice(11, 16)}:00`);

const phone = z.string().trim().regex(/^[0-9+\-\s()]{6,30}$/, 'Invalid phone number');
const shortText = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));
const email = z.string().trim().toLowerCase().email().max(255);

const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
});
const limitOffset = (p) => [p.pageSize, (p.page - 1) * p.pageSize];
const paged = (data, p, total) => ({ data: camelize(data), page: p.page, pageSize: p.pageSize, total: Number(total) });

module.exports = {
  asyncHandler,
  writeAudit,
  auditReq,
  camelize,
  likeContains,
  schema: { id, password, dateOnly, dateTime, phone, shortText, optionalText, email, pagination },
  limitOffset,
  paged,
};
