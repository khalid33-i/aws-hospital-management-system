const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const env = require('./config/env');
const { pool } = require('./config/db');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

const app = express();

app.disable('x-powered-by');
// Behind an Application Load Balancer set TRUST_PROXY=1 so req.ip is the real client address
if (env.trustProxy) app.set('trust proxy', env.trustProxy);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      // 'upgrade-insecure-requests' would break plain-HTTP deployments (e.g. an ALB without a certificate)
      directives: { 'upgrade-insecure-requests': env.cookieSecure ? [] : null },
    },
    hsts: env.cookieSecure,
  })
);
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Structured (JSON) access log on stdout: easy to ship to CloudWatch Logs later
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (req.path === '/health') return;
    console.log(
      JSON.stringify({
        level: 'info',
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Number((process.hrtime.bigint() - started) / 1000000n),
        userId: req.user ? req.user.id : null,
        ip: req.ip,
      })
    );
  });
  next();
});

// ---- health checks (used by the load balancer; no authentication, no sensitive data)
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'unavailable', database: 'down' });
  }
});

// ---- API
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store'); // API responses may contain personal data: never cache them
  next();
});
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(
  '/api/auth/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number(process.env.LOGIN_RATE_LIMIT || 10),
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true, // only failed attempts count towards the limit
    message: { error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many failed login attempts. Try again in 15 minutes.' } },
  })
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/directory', require('./routes/directory'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/receptionist', require('./routes/receptionist'));
app.use('/api/doctor', require('./routes/doctor'));
app.use('/api/pharmacist', require('./routes/pharmacist'));
app.use('/api/patient', require('./routes/patient'));
app.use('/api', notFoundHandler);

// ---- static frontend (the same Express app serves the HTML/CSS/JS)
app.use(express.static(env.frontendDir, { maxAge: env.isProd ? '1h' : 0, index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(env.frontendDir, 'index.html')));

app.use(errorHandler);

module.exports = app;
