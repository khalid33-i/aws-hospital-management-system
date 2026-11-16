/*
 * Creates the database schema on an empty database.
 * Safe to run on every server start: it does nothing when the tables already exist.
 * A MySQL lock makes sure two servers starting at the same time do not both create the tables.
 *   node backend/scripts/init-db.js
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../src/config/env');

const log = (message, extra = {}) => console.log(JSON.stringify({ level: 'info', message, ...extra }));

async function main() {
  let ssl;
  if (env.db.ssl) {
    ssl = { rejectUnauthorized: true };
    if (env.db.sslCaPath) ssl.ca = fs.readFileSync(env.db.sslCaPath);
  }

  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    ssl,
    multipleStatements: true,
    connectTimeout: 10000,
  });

  try {
    const [[{ got }]] = await conn.query("SELECT GET_LOCK('hms_init', 120) AS got");
    if (got !== 1) throw new Error('Could not obtain the initialisation lock');

    const [[{ n }]] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      ['roles']
    );
    if (n > 0) {
      log('Schema already present, nothing to do');
      return;
    }

    const sql = fs.readFileSync(path.resolve(__dirname, '../../database/schema.sql'), 'utf8');
    await conn.query(sql);
    log('Schema created');
  } finally {
    try {
      await conn.query("SELECT RELEASE_LOCK('hms_init')");
    } catch (err) {
      /* connection already closed */
    }
    await conn.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'error', message: 'Database initialisation failed', error: err.message }));
  process.exit(1);
});