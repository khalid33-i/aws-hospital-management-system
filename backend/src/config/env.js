const path = require('path');
const dotenv = require('dotenv');

// Load backend/.env first, then the repository-root .env (dotenv never overrides values already set)
dotenv.config({ quiet: true });
dotenv.config({ path: path.resolve(__dirname, '../../../.env'), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';

const jwtSecret = required('JWT_SECRET');
if (jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters long');

const jwtMinutes = Number(process.env.JWT_EXPIRES_MINUTES || 60);

module.exports = {
  nodeEnv,
  isProd,
  port: Number(process.env.PORT || 3000),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    database: required('DB_NAME'),
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    ssl: process.env.DB_SSL === 'true',
    sslCaPath: process.env.DB_SSL_CA || '',
  },
  jwt: {
    secret: jwtSecret,
    expiresIn: `${jwtMinutes}m`,
    cookieMaxAgeMs: jwtMinutes * 60 * 1000,
  },
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS || 12),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  tz: process.env.HOSPITAL_TZ || '+03:00',
  frontendDir: process.env.FRONTEND_DIR || path.resolve(__dirname, '../../../frontend'),
};
