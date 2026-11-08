-- ============================================================================
-- Hospital Management System (educational portfolio project, FICTIONAL DATA ONLY)
-- Compatible with MySQL 8.0+ (Docker / RDS) and MariaDB 10.5+.
-- Load into an existing, empty database:   mysql -u root -p hms < schema.sql
-- ============================================================================
SET NAMES utf8mb4;

-- ----------------------------------------------------------------------------
-- Reference / lookup tables
-- ----------------------------------------------------------------------------
CREATE TABLE roles (
  id   TINYINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(30) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE departments (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(255) NULL,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_departments_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE specialties (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(100) NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_specialties_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE system_settings (
  setting_key   VARCHAR(60)  NOT NULL,
  setting_value VARCHAR(255) NOT NULL,
  updated_by    INT UNSIGNED NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Identity: users + one profile table per role
-- password_hash stores a bcrypt hash (never a plain password)
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  role_id       TINYINT UNSIGNED NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  full_name     VARCHAR(120) NOT NULL,
  phone         VARCHAR(30) NULL,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email),
  KEY idx_users_role_active (role_id, is_active),
  CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE patients (
  id                      INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id                 INT UNSIGNED NULL,           -- NULL = registered at the desk, no portal login
  medical_record_no       VARCHAR(20) NULL,
  full_name               VARCHAR(120) NOT NULL,
  date_of_birth           DATE NOT NULL,
  gender                  ENUM('Male','Female') NOT NULL,
  phone                   VARCHAR(30) NOT NULL,
  email                   VARCHAR(255) NULL,
  address                 VARCHAR(255) NULL,
  blood_type              ENUM('A+','A-','B+','B-','AB+','AB-','O+','O-') NULL,
  emergency_contact_name  VARCHAR(120) NULL,
  emergency_contact_phone VARCHAR(30) NULL,
  created_by              INT UNSIGNED NULL,
  created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_patients_user (user_id),
  UNIQUE KEY uk_patients_mrn (medical_record_no),
  KEY idx_patients_name (full_name),
  KEY idx_patients_phone (phone),
  CONSTRAINT fk_patients_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_patients_creator FOREIGN KEY (created_by) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE doctors (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id          INT UNSIGNED NOT NULL,
  department_id    INT UNSIGNED NOT NULL,
  specialty_id     INT UNSIGNED NOT NULL,
  license_no       VARCHAR(40) NOT NULL,
  consultation_fee DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  PRIMARY KEY (id),
  UNIQUE KEY uk_doctors_user (user_id),
  UNIQUE KEY uk_doctors_license (license_no),
  KEY idx_doctors_department (department_id),
  KEY idx_doctors_specialty (specialty_id),
  CONSTRAINT fk_doctors_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_doctors_department FOREIGN KEY (department_id) REFERENCES departments (id),
  CONSTRAINT fk_doctors_specialty FOREIGN KEY (specialty_id) REFERENCES specialties (id),
  CONSTRAINT chk_doctors_fee CHECK (consultation_fee >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE receptionists (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NOT NULL,
  employee_no VARCHAR(30) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_receptionists_user (user_id),
  UNIQUE KEY uk_receptionists_employee (employee_no),
  CONSTRAINT fk_receptionists_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pharmacists (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    INT UNSIGNED NOT NULL,
  license_no VARCHAR(40) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_pharmacists_user (user_id),
  UNIQUE KEY uk_pharmacists_license (license_no),
  CONSTRAINT fk_pharmacists_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Appointments
-- active_slot is NULL for Cancelled / No-Show rows, so the two UNIQUE keys below
-- make double-booking (same doctor OR same patient at the same time) impossible
-- at the database level, while cancelled slots can be re-booked.
-- ----------------------------------------------------------------------------
CREATE TABLE appointments (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_id       INT UNSIGNED NOT NULL,
  doctor_id        INT UNSIGNED NOT NULL,
  scheduled_at     DATETIME NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  status           ENUM('Scheduled','Confirmed','Completed','Cancelled','No-Show') NOT NULL DEFAULT 'Scheduled',
  reason           VARCHAR(255) NULL,
  cancel_reason    VARCHAR(255) NULL,
  created_by       INT UNSIGNED NOT NULL,
  cancelled_by     INT UNSIGNED NULL,
  active_slot      DATETIME GENERATED ALWAYS AS (IF(status IN ('Cancelled','No-Show'), NULL, scheduled_at)) STORED,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_appt_doctor_slot (doctor_id, active_slot),
  UNIQUE KEY uk_appt_patient_slot (patient_id, active_slot),
  KEY idx_appt_doctor_date (doctor_id, scheduled_at),
  KEY idx_appt_patient_date (patient_id, scheduled_at),
  KEY idx_appt_status_date (status, scheduled_at),
  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT fk_appt_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id),
  CONSTRAINT fk_appt_creator FOREIGN KEY (created_by) REFERENCES users (id),
  CONSTRAINT fk_appt_canceller FOREIGN KEY (cancelled_by) REFERENCES users (id),
  CONSTRAINT chk_appt_duration CHECK (duration_minutes > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE medical_records (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id INT UNSIGNED NOT NULL,
  patient_id     INT UNSIGNED NOT NULL,
  doctor_id      INT UNSIGNED NOT NULL,
  diagnosis      VARCHAR(500) NOT NULL,
  notes          TEXT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_records_appointment (appointment_id),
  KEY idx_records_patient (patient_id, created_at),
  KEY idx_records_doctor (doctor_id),
  CONSTRAINT fk_records_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id),
  CONSTRAINT fk_records_patient FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT fk_records_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Pharmacy catalogue + stock (stock is tracked per BATCH because expiry is per batch)
-- ----------------------------------------------------------------------------
CREATE TABLE medications (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  generic_name  VARCHAR(120) NULL,
  form          ENUM('Tablet','Capsule','Syrup','Injection','Cream','Drops','Inhaler') NOT NULL,
  strength      VARCHAR(40) NOT NULL,
  unit_price    DECIMAL(10,2) NOT NULL,
  reorder_level INT UNSIGNED NOT NULL DEFAULT 20,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_medications_identity (name, strength, form),
  KEY idx_medications_active_name (is_active, name),
  CONSTRAINT chk_medications_price CHECK (unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pharmacy_inventory (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  medication_id INT UNSIGNED NOT NULL,
  batch_no      VARCHAR(40) NOT NULL,
  quantity      INT NOT NULL DEFAULT 0,
  expiry_date   DATE NOT NULL,
  received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_inventory_batch (medication_id, batch_no),
  KEY idx_inventory_med_expiry (medication_id, expiry_date),
  KEY idx_inventory_expiry (expiry_date),
  CONSTRAINT fk_inventory_medication FOREIGN KEY (medication_id) REFERENCES medications (id),
  CONSTRAINT chk_inventory_quantity CHECK (quantity >= 0)          -- stock can never go negative
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Doctor -> Prescription -> Items -> (Pharmacist dispenses) -> Patient
-- ----------------------------------------------------------------------------
CREATE TABLE prescriptions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  appointment_id INT UNSIGNED NULL,
  patient_id     INT UNSIGNED NOT NULL,
  doctor_id      INT UNSIGNED NOT NULL,
  status         ENUM('Pending','Partially Dispensed','Dispensed','Cancelled') NOT NULL DEFAULT 'Pending',
  notes          VARCHAR(500) NULL,
  cancelled_at   DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_rx_status_created (status, created_at),
  KEY idx_rx_patient (patient_id, created_at),
  KEY idx_rx_doctor (doctor_id, created_at),
  KEY idx_rx_appointment (appointment_id),
  CONSTRAINT fk_rx_appointment FOREIGN KEY (appointment_id) REFERENCES appointments (id),
  CONSTRAINT fk_rx_patient FOREIGN KEY (patient_id) REFERENCES patients (id),
  CONSTRAINT fk_rx_doctor FOREIGN KEY (doctor_id) REFERENCES doctors (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE prescription_items (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_id    INT UNSIGNED NOT NULL,
  medication_id      INT UNSIGNED NOT NULL,
  dosage             VARCHAR(60) NOT NULL,
  frequency          VARCHAR(60) NOT NULL,
  duration_days      SMALLINT UNSIGNED NOT NULL,
  instructions       VARCHAR(255) NULL,
  quantity_prescribed INT UNSIGNED NOT NULL,
  quantity_dispensed  INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_rx_item_medication (prescription_id, medication_id),
  KEY idx_rx_items_medication (medication_id),
  CONSTRAINT fk_rx_items_rx FOREIGN KEY (prescription_id) REFERENCES prescriptions (id),
  CONSTRAINT fk_rx_items_medication FOREIGN KEY (medication_id) REFERENCES medications (id),
  CONSTRAINT chk_rx_items_duration CHECK (duration_days BETWEEN 1 AND 365),
  CONSTRAINT chk_rx_items_qty CHECK (quantity_prescribed > 0),
  CONSTRAINT chk_rx_items_dispensed CHECK (quantity_dispensed <= quantity_prescribed)  -- cannot over-dispense
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (item, batch) a dispensing request drew from. request_key is the
-- client-generated idempotency key that prevents duplicate dispensing on retries/double-clicks.
CREATE TABLE dispensing_records (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  prescription_item_id INT UNSIGNED NOT NULL,
  inventory_id       INT UNSIGNED NOT NULL,
  pharmacist_id      INT UNSIGNED NOT NULL,
  quantity           INT UNSIGNED NOT NULL,
  unit_price         DECIMAL(10,2) NOT NULL,           -- price snapshot at dispensing time
  request_key        VARCHAR(64) NOT NULL,
  dispensed_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_dispense_request (request_key, prescription_item_id, inventory_id),
  KEY idx_dispense_item (prescription_item_id),
  KEY idx_dispense_inventory (inventory_id),
  KEY idx_dispense_pharmacist_date (pharmacist_id, dispensed_at),
  KEY idx_dispense_date (dispensed_at),
  CONSTRAINT fk_dispense_item FOREIGN KEY (prescription_item_id) REFERENCES prescription_items (id),
  CONSTRAINT fk_dispense_inventory FOREIGN KEY (inventory_id) REFERENCES pharmacy_inventory (id),
  CONSTRAINT fk_dispense_pharmacist FOREIGN KEY (pharmacist_id) REFERENCES pharmacists (id),
  CONSTRAINT chk_dispense_qty CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Audit trail
-- ----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     INT UNSIGNED NULL,
  action      VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40) NULL,
  entity_id   VARCHAR(40) NULL,
  details     JSON NULL,
  ip_address  VARCHAR(45) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_created (created_at),
  KEY idx_audit_user_created (user_id, created_at),
  KEY idx_audit_action_created (action, created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
