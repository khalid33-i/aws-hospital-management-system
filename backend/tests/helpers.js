// Test helpers. Tests run against a MySQL/MariaDB database that has the schema loaded and `npm run seed` applied.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.LOGIN_RATE_LIMIT = '1000'; // do not trip the login limiter while testing failed logins
process.env.BCRYPT_ROUNDS = process.env.BCRYPT_ROUNDS || '4';

const http = require('http');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { pool } = require('../src/config/db');

const PASSWORD = process.env.SEED_PASSWORD || 'DemoPass123';
let server;
let base;

async function start() {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}

class Client {
  constructor() {
    this.cookie = null;
  }

  async request(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.startsWith('hms_token=')) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (err) {
      /* not JSON */
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body ?? {}); }
  put(path, body) { return this.request('PUT', path, body ?? {}); }
  delete(path) { return this.request('DELETE', path); }
}

async function login(email, password = PASSWORD) {
  const client = new Client();
  const res = await client.post('/api/auth/login', { email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return client;
}

const requestKey = () => `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 'YYYY-MM-DD' for today + n days (hospital-local, taken from the database session). */
async function dateOffset(days) {
  const [[row]] = await pool.query('SELECT DATE_ADD(CURDATE(), INTERVAL ? DAY) AS d', [days]);
  return row.d;
}

module.exports = { start, stop, Client, login, pool, requestKey, dateOffset, PASSWORD };
