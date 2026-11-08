// Allowed system settings and their validation (used by the admin API and by business rules)
const { z } = require('zod');

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use format HH:mm');

const SETTING_SCHEMAS = {
  hospital_name: z.string().trim().min(2).max(100),
  cancellation_window_hours: z.coerce.number().int().min(0).max(168).transform(String),
  appointment_duration_minutes: z.coerce.number().int().min(10).max(120).transform(String),
  clinic_open: timeOfDay,
  clinic_close: timeOfDay,
  default_reorder_level: z.coerce.number().int().min(0).max(100000).transform(String),
};

const DEFAULT_SETTINGS = {
  hospital_name: 'Al Noor General Hospital (fictional)',
  cancellation_window_hours: '24',
  appointment_duration_minutes: '30',
  clinic_open: '08:00',
  clinic_close: '17:00',
  default_reorder_level: '20',
};

async function getSettings(db) {
  const [rows] = await db.query('SELECT setting_key, setting_value FROM system_settings');
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) settings[row.setting_key] = row.setting_value;
  return settings;
}

module.exports = { SETTING_SCHEMAS, DEFAULT_SETTINGS, getSettings };
