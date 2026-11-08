const env = require('./config/env');
const { pool } = require('./config/db');
const app = require('./app');

const server = app.listen(env.port, () => {
  console.log(JSON.stringify({ level: 'info', message: `HMS listening on port ${env.port}`, env: env.nodeEnv }));
});

// Graceful shutdown so in-flight requests finish (important for rolling deployments / Auto Scaling)
function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', message: `${signal} received, shutting down` }));
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
