const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const env = require('../config/env');
const { pool } = require('../config/db');
const { validate } = require('../middleware/validate');
const { COOKIE_NAME, cookieOptions, signToken, authenticate, tryGetUserId } = require('../middleware/auth');
const { unauthorized, badRequest } = require('../utils/httpError');
const { asyncHandler, writeAudit, schema } = require('../utils/helpers');

// Compared against when the e-mail does not exist, so response time does not reveal valid accounts
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', env.bcryptRounds);

router.post(
  '/login',
  validate({ body: z.object({ email: schema.email, password: z.string().min(1).max(128) }) }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.valid.body;
    const [rows] = await pool.query(
      `SELECT u.id, u.email, u.full_name, u.password_hash, u.is_active, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?`,
      [email]
    );
    const user = rows[0];
    const passwordOk = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !passwordOk || !user.is_active) {
      await writeAudit(pool, { userId: user ? user.id : null, action: 'LOGIN_FAILED', details: { email }, ip: req.ip });
      throw unauthorized('Invalid email or password'); // same message for every failure reason
    }

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
    await writeAudit(pool, { userId: user.id, action: 'LOGIN', entityType: 'user', entityId: user.id, ip: req.ip });

    res.cookie(COOKIE_NAME, signToken(user), { ...cookieOptions(), maxAge: env.jwt.cookieMaxAgeMs });
    res.json({ user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role } });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const userId = tryGetUserId(req);
    if (userId) await writeAudit(pool, { userId, action: 'LOGOUT', entityType: 'user', entityId: userId, ip: req.ip });
    res.clearCookie(COOKIE_NAME, cookieOptions());
    res.status(204).end();
  })
);

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post(
  '/change-password',
  authenticate,
  validate({ body: z.object({ currentPassword: z.string().min(1).max(128), newPassword: schema.password }) }),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.valid.body;
    const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) throw unauthorized('Current password is incorrect');
    if (currentPassword === newPassword) throw badRequest('New password must be different from the current one');
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(newPassword, env.bcryptRounds), req.user.id]);
    await writeAudit(pool, { userId: req.user.id, action: 'PASSWORD_CHANGED', entityType: 'user', entityId: req.user.id, ip: req.ip });
    res.status(204).end();
  })
);

module.exports = router;
