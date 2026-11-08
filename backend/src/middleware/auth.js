const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool } = require('../config/db');
const { unauthorized, forbidden } = require('../utils/httpError');

const COOKIE_NAME = 'hms_token';

const cookieOptions = () => ({
  httpOnly: true, // JavaScript in the browser cannot read the token (mitigates XSS token theft)
  sameSite: 'strict', // cookie is never sent on cross-site requests (mitigates CSRF)
  secure: env.cookieSecure,
  path: '/',
});

function signToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, env.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: env.jwt.expiresIn,
    issuer: 'hms',
  });
}

function extractToken(req) {
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return null;
}

function verifyToken(token) {
  return jwt.verify(token, env.jwt.secret, { algorithms: ['HS256'], issuer: 'hms' });
}

/**
 * AUTHENTICATION: who are you?
 * Verifies the JWT signature + expiry, then re-loads the user from the database so that a
 * deactivated account or a changed role takes effect immediately (not only when the token expires).
 */
async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized();
    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      throw unauthorized('Invalid or expired session');
    }
    const [rows] = await pool.query(
      'SELECT u.id, u.email, u.full_name, u.is_active, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.is_active) throw unauthorized('Account is not active');
    req.user = { id: user.id, email: user.email, fullName: user.full_name, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

/** AUTHORIZATION: are you allowed to do this? Role is taken from the database, never from the client. */
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
  return next();
};

const PROFILE_TABLES = { doctor: 'doctors', patient: 'patients', pharmacist: 'pharmacists', receptionist: 'receptionists' };

/** Resolves the caller's own profile id (req.doctorId, req.patientId, ...) so queries can be scoped to "me". */
function loadProfile(kind) {
  const table = PROFILE_TABLES[kind];
  return async (req, res, next) => {
    try {
      const [rows] = await pool.query(`SELECT id FROM ${table} WHERE user_id = ?`, [req.user.id]);
      if (!rows[0]) throw forbidden(`No ${kind} profile is linked to this account`);
      req[`${kind}Id`] = rows[0].id;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Best-effort user id from a token (used by logout so it works even when the token just expired). */
function tryGetUserId(req) {
  try {
    const token = extractToken(req);
    return token ? Number(verifyToken(token).sub) : null;
  } catch (err) {
    return null;
  }
}

module.exports = { COOKIE_NAME, cookieOptions, signToken, authenticate, authorize, loadProfile, tryGetUserId };
