const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { start, stop, Client, login, pool, PASSWORD } = require('./helpers');

const ROUTES = {
  Admin: '/api/admin/stats',
  Receptionist: '/api/receptionist/patients',
  Doctor: '/api/doctor/dashboard',
  Pharmacist: '/api/pharmacist/dashboard',
  Patient: '/api/patient/profile',
};
const ACCOUNTS = {
  Admin: 'admin@hms.test',
  Receptionist: 'reception@hms.test',
  Doctor: 'dr.sara@hms.test',
  Pharmacist: 'pharmacy@hms.test',
  Patient: 'ahmed@hms.test',
};

before(start);
after(stop);

describe('authentication', () => {

  it('rejects a wrong password with a generic message', async () => {
    const res = await new Client().post('/api/auth/login', { email: 'admin@hms.test', password: 'WrongPassword1' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Invalid email or password');
  });

  it('gives the same answer for an unknown e-mail (no account enumeration)', async () => {
    const res = await new Client().post('/api/auth/login', { email: 'nobody@hms.test', password: PASSWORD });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Invalid email or password');
  });

  it('logs in, sets an HttpOnly + SameSite=Strict cookie and never returns the password hash', async () => {
    const client = new Client();
    const res = await client.post('/api/auth/login', { email: 'admin@hms.test', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'Admin');
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.ok(!JSON.stringify(res.body).includes('password'));
    assert.equal((await client.get('/api/auth/me')).status, 200);
  });

  it('stores passwords as bcrypt hashes', async () => {
    const [[row]] = await pool.query("SELECT password_hash FROM users WHERE email = 'admin@hms.test'");
    assert.match(row.password_hash, /^\$2[aby]\$\d{2}\$/);
  });

  it('requires a session for protected routes', async () => {
    assert.equal((await new Client().get('/api/auth/me')).status, 401);
    assert.equal((await new Client().get('/api/admin/stats')).status, 401);
  });

  it('logout removes the session cookie', async () => {
    const client = await login('admin@hms.test');
    assert.equal((await client.post('/api/auth/logout')).status, 204);
    assert.equal((await client.get('/api/auth/me')).status, 401);
  });

  it('rejects tokens signed with another secret and expired tokens', async () => {
    const forged = jwt.sign({ sub: '1', role: 'Admin' }, 'another-secret-another-secret-another', { algorithm: 'HS256', issuer: 'hms' });
    const expired = jwt.sign({ sub: '1', role: 'Admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'hms', expiresIn: -10 });
    for (const token of [forged, expired, 'not.a.jwt']) {
      const client = new Client();
      client.cookie = `hms_token=${token}`;
      assert.equal((await client.get('/api/admin/stats')).status, 401);
    }
  });

  it('rejects SQL-injection style input without leaking or erroring', async () => {
    const res = await new Client().post('/api/auth/login', { email: "' OR 1=1 --", password: "' OR '1'='1" });
    assert.equal(res.status, 400);
    const reception = await login('reception@hms.test');
    const found = await reception.get(`/api/receptionist/patients?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.total, 0);
  });
});

describe('role-based access control (enforced by the backend)', () => {

  it('every role can reach its own area and no other role area', async () => {
    for (const [role, email] of Object.entries(ACCOUNTS)) {
      const client = await login(email);
      for (const [targetRole, path] of Object.entries(ROUTES)) {
        const res = await client.get(path);
        if (targetRole === role) assert.equal(res.status, 200, `${role} should access ${path}`);
        else assert.equal(res.status, 403, `${role} must NOT access ${path} (got ${res.status})`);
      }
    }
  });

  it('ignores the role inside the token: the role always comes from the database', async () => {
    const [[u]] = await pool.query("SELECT id FROM users WHERE email = 'ahmed@hms.test'");
    const token = jwt.sign({ sub: String(u.id), role: 'Admin' }, process.env.JWT_SECRET, { algorithm: 'HS256', issuer: 'hms', expiresIn: '5m' });
    const client = new Client();
    client.cookie = `hms_token=${token}`;
    assert.equal((await client.get('/api/admin/stats')).status, 403);
  });

  it('a deactivated account loses access immediately, and can be re-activated', async () => {
    const admin = await login('admin@hms.test');
    const email = `temp.${Date.now()}@hms.test`;
    const created = await admin.post('/api/admin/users', { role: 'Receptionist', email, fullName: 'Temp Receptionist', password: 'TempPassw0rd1' });
    assert.equal(created.status, 201);
    const temp = await login(email, 'TempPassw0rd1');
    assert.equal((await temp.get('/api/receptionist/patients')).status, 200);
    assert.equal((await admin.post(`/api/admin/users/${created.body.id}/deactivate`)).status, 204);
    assert.equal((await temp.get('/api/receptionist/patients')).status, 401);
    assert.equal((await new Client().post('/api/auth/login', { email, password: 'TempPassw0rd1' })).status, 401);
  });

  it('an administrator cannot deactivate their own account', async () => {
    const admin = await login('admin@hms.test');
    const me = await admin.get('/api/auth/me');
    const res = await admin.post(`/api/admin/users/${me.body.user.id}/deactivate`);
    assert.equal(res.status, 400);
  });

  it('a patient can only read their own prescriptions (others look like 404)', async () => {
    const ahmed = await login('ahmed@hms.test');
    const mine = await ahmed.get('/api/patient/prescriptions');
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.length >= 1);
    const [[other]] = await pool.query("SELECT rx.id FROM prescriptions rx JOIN patients p ON p.id = rx.patient_id WHERE p.full_name = 'Fatima Jassim' LIMIT 1");
    assert.equal((await ahmed.get(`/api/patient/prescriptions/${other.id}`)).status, 404);
    const fatima = await login('fatima@hms.test');
    assert.equal((await fatima.get(`/api/patient/prescriptions/${other.id}`)).status, 200);
  });

  it('a doctor cannot open a patient or prescription that is not theirs', async () => {
    const omar = await login('dr.omar@hms.test');
    const [[ahmed]] = await pool.query("SELECT id FROM patients WHERE full_name = 'Ahmed Salman'");
    assert.equal((await omar.get(`/api/doctor/patients/${ahmed.id}`)).status, 403);
    const [[saraRx]] = await pool.query("SELECT rx.id FROM prescriptions rx JOIN doctors d ON d.id = rx.doctor_id JOIN users u ON u.id = d.user_id WHERE u.email = 'dr.sara@hms.test' LIMIT 1");
    assert.equal((await omar.get(`/api/doctor/prescriptions/${saraRx.id}`)).status, 404);
  });

  it('the doctor medication catalogue exposes no stock or price', async () => {
    const sara = await login('dr.sara@hms.test');
    const res = await sara.get('/api/doctor/medications?q=amlo');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length >= 1);
    for (const m of res.body.data) {
      assert.deepEqual(Object.keys(m).sort(), ['form', 'genericName', 'id', 'name', 'strength']);
    }
  });

  it('pharmacists have no way to edit or delete prescriptions', async () => {
    const pharmacist = await login('pharmacy@hms.test');
    const [[rx]] = await pool.query('SELECT id FROM prescriptions ORDER BY id LIMIT 1');
    assert.equal((await pharmacist.put(`/api/pharmacist/prescriptions/${rx.id}`, { status: 'Dispensed' })).status, 404);
    assert.equal((await pharmacist.delete(`/api/pharmacist/prescriptions/${rx.id}`)).status, 404);
    assert.equal((await pharmacist.post(`/api/doctor/prescriptions/${rx.id}/cancel`)).status, 403);
  });

  it('receptionists and admins cannot read prescriptions or pharmacy stock', async () => {
    for (const email of [ACCOUNTS.Receptionist, ACCOUNTS.Admin]) {
      const client = await login(email);
      assert.equal((await client.get('/api/doctor/prescriptions')).status, 403);
      assert.equal((await client.get('/api/pharmacist/inventory')).status, 403);
    }
  });

  it('rejects unknown input fields instead of writing them', async () => {
    const admin = await login('admin@hms.test');
    const res = await admin.post('/api/admin/users', {
      role: 'Admin', email: `x.${Date.now()}@hms.test`, fullName: 'X Y', password: 'ValidPassw0rd1', isActive: false, roleId: 1,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.isActive, true); // the extra isActive field was ignored
  });

  it('enforces the password policy', async () => {
    const admin = await login('admin@hms.test');
    const res = await admin.post('/api/admin/users', { role: 'Admin', email: `w.${Date.now()}@hms.test`, fullName: 'Weak Pw', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  });
});
