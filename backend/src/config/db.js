const fs = require('fs');
const mysql = require('mysql2/promise');
const env = require('./env');

function sslOptions() {
  if (!env.db.ssl) return undefined;
  const options = { rejectUnauthorized: true };
  if (env.db.sslCaPath) options.ca = fs.readFileSync(env.db.sslCaPath);
  return options;
}

// One pool per process. Always use placeholders (?) so values are escaped by the driver (SQL-injection safe).
const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.connectionLimit,
  queueLimit: 0,
  connectTimeout: 10000,
  dateStrings: true, // DATE/DATETIME come back as plain strings, no timezone surprises
  decimalNumbers: true,
  ssl: sslOptions(),
});

// Make NOW()/CURDATE() follow the hospital's local time zone
pool.pool.on('connection', (connection) => {
  connection.query('SET time_zone = ?', [env.tz]);
});

/**
 * Runs fn(conn) inside a transaction. Commits on success, rolls back on any error.
 * Retries automatically (up to 2 times) when MySQL reports a deadlock.
 */
async function withTransaction(fn, retries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        /* connection already gone */
      }
      if (err.code === 'ER_LOCK_DEADLOCK' && attempt < retries) continue;
      throw err;
    } finally {
      conn.release();
    }
  }
}

module.exports = { pool, withTransaction };
