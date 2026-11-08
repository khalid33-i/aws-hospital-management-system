const { badRequest, notFound, conflict } = require('../utils/httpError');
const { getSettings } = require('./settings');

// Allowed status changes (a finished appointment can never be changed again)
const TRANSITIONS = {
  Scheduled: ['Confirmed', 'Cancelled', 'No-Show', 'Completed'],
  Confirmed: ['Cancelled', 'No-Show', 'Completed'],
  Completed: [],
  Cancelled: [],
  'No-Show': [],
};
const OPEN_STATUSES = ['Scheduled', 'Confirmed'];

const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** scheduledAt is 'YYYY-MM-DD HH:mm:00' in the hospital's local time. */
async function assertValidSlot(db, scheduledAt, settings) {
  const duration = Number(settings.appointment_duration_minutes);
  const minutes = toMinutes(scheduledAt.slice(11, 16));
  const open = toMinutes(settings.clinic_open);
  const close = toMinutes(settings.clinic_close);

  if (minutes < open || minutes + duration > close) {
    throw badRequest(`Appointments must be between ${settings.clinic_open} and ${settings.clinic_close}`);
  }
  if ((minutes - open) % duration !== 0) {
    throw badRequest(`Appointments start every ${duration} minutes from ${settings.clinic_open}`);
  }
  const [[row]] = await db.query('SELECT (? > NOW()) AS is_future', [scheduledAt]);
  if (!row.is_future) throw badRequest('Appointment time must be in the future');
}

function translateSlotConflict(err) {
  if (err.code === 'ER_DUP_ENTRY') {
    const msg = err.sqlMessage || '';
    if (msg.includes('uk_appt_patient_slot')) {
      return conflict('The patient already has an appointment at this time', 'PATIENT_BUSY');
    }
    return conflict('The doctor is already booked at this time', 'SLOT_TAKEN');
  }
  return err;
}

async function bookAppointment(db, { patientId, doctorId, scheduledAt, reason, createdBy }) {
  const settings = await getSettings(db);
  await assertValidSlot(db, scheduledAt, settings);

  const [doctor] = await db.query(
    'SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND u.is_active = 1',
    [doctorId]
  );
  if (!doctor.length) throw notFound('Doctor not found or not active');
  const [patient] = await db.query('SELECT id FROM patients WHERE id = ?', [patientId]);
  if (!patient.length) throw notFound('Patient not found');

  try {
    const [result] = await db.query(
      'INSERT INTO appointments (patient_id, doctor_id, scheduled_at, duration_minutes, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [patientId, doctorId, scheduledAt, Number(settings.appointment_duration_minutes), reason || null, createdBy]
    );
    return result.insertId;
  } catch (err) {
    throw translateSlotConflict(err);
  }
}

async function getAppointment(db, appointmentId) {
  const [rows] = await db.query(
    'SELECT id, patient_id, doctor_id, scheduled_at, status FROM appointments WHERE id = ?',
    [appointmentId]
  );
  if (!rows[0]) throw notFound('Appointment not found');
  return rows[0];
}

async function rescheduleAppointment(db, { appointmentId, scheduledAt, doctorId }) {
  const appt = await getAppointment(db, appointmentId);
  if (!OPEN_STATUSES.includes(appt.status)) {
    throw conflict(`A ${appt.status} appointment cannot be rescheduled`, 'INVALID_STATE');
  }
  const settings = await getSettings(db);
  await assertValidSlot(db, scheduledAt, settings);
  const newDoctorId = doctorId || appt.doctor_id;
  if (doctorId) {
    const [doctor] = await db.query(
      'SELECT d.id FROM doctors d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND u.is_active = 1',
      [doctorId]
    );
    if (!doctor.length) throw notFound('Doctor not found or not active');
  }
  try {
    await db.query('UPDATE appointments SET scheduled_at = ?, doctor_id = ?, status = ? WHERE id = ?', [
      scheduledAt,
      newDoctorId,
      'Scheduled',
      appointmentId,
    ]);
  } catch (err) {
    throw translateSlotConflict(err);
  }
  return appt;
}

async function cancelAppointment(db, { appointmentId, actorUserId, reason, patientId, enforceWindow }) {
  const appt = await getAppointment(db, appointmentId);
  if (patientId && appt.patient_id !== patientId) throw notFound('Appointment not found'); // not yours -> looks like it does not exist
  if (!OPEN_STATUSES.includes(appt.status)) {
    throw conflict(`A ${appt.status} appointment cannot be cancelled`, 'INVALID_STATE');
  }
  if (enforceWindow) {
    const settings = await getSettings(db);
    const hours = Number(settings.cancellation_window_hours);
    const [[row]] = await db.query('SELECT (? >= DATE_ADD(NOW(), INTERVAL ? HOUR)) AS allowed', [appt.scheduled_at, hours]);
    if (!row.allowed) {
      throw conflict(`Appointments can only be cancelled at least ${hours} hours in advance`, 'CANCELLATION_WINDOW');
    }
  }
  await db.query(
    "UPDATE appointments SET status = 'Cancelled', cancel_reason = ?, cancelled_by = ? WHERE id = ? AND status IN ('Scheduled','Confirmed')",
    [reason || null, actorUserId, appointmentId]
  );
  return appt;
}

/** Generic status change with a transition check. allowedTargets limits what the caller's role may set. */
async function changeStatus(db, { appointmentId, newStatus, allowedTargets, doctorId, actorUserId }) {
  const appt = await getAppointment(db, appointmentId);
  if (doctorId && appt.doctor_id !== doctorId) throw notFound('Appointment not found');
  if (!allowedTargets.includes(newStatus)) {
    throw badRequest(`You cannot set the status to ${newStatus}`);
  }
  if (!TRANSITIONS[appt.status].includes(newStatus)) {
    throw conflict(`Cannot change status from ${appt.status} to ${newStatus}`, 'INVALID_TRANSITION');
  }
  if (newStatus === 'Completed') {
    const [[row]] = await db.query('SELECT (DATE(?) <= CURDATE()) AS ok', [appt.scheduled_at]);
    if (!row.ok) throw conflict('An appointment can only be completed on or after its scheduled day', 'TOO_EARLY');
  }
  if (newStatus === 'Cancelled') {
    await db.query("UPDATE appointments SET status = 'Cancelled', cancelled_by = ? WHERE id = ?", [actorUserId, appointmentId]);
  } else {
    await db.query('UPDATE appointments SET status = ? WHERE id = ?', [newStatus, appointmentId]);
  }
  return appt;
}

// Shared SELECT used by receptionist / doctor / patient appointment lists
const APPOINTMENT_SELECT = `
  SELECT a.id, a.scheduled_at, a.duration_minutes, a.status, a.reason, a.cancel_reason,
         p.id AS patient_id, p.full_name AS patient_name, p.medical_record_no,
         d.id AS doctor_id, du.full_name AS doctor_name, dep.name AS department
  FROM appointments a
  JOIN patients p ON p.id = a.patient_id
  JOIN doctors d ON d.id = a.doctor_id
  JOIN users du ON du.id = d.user_id
  JOIN departments dep ON dep.id = d.department_id`;

module.exports = {
  OPEN_STATUSES,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  changeStatus,
  APPOINTMENT_SELECT,
};
