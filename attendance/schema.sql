-- ================================================================
-- Softmasters Attendance System — PostgreSQL Schema
-- Run once: psql -d your_db -f schema.sql
-- ================================================================

-- ── Attendance Records ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance_records (
  id        BIGSERIAL     PRIMARY KEY,
  name      TEXT          NOT NULL,
  emp_id    TEXT          NOT NULL DEFAULT '',
  type      TEXT          NOT NULL,           -- 'Check In' | 'Check Out'
  date      TEXT          NOT NULL,           -- dd/mm/yyyy (display)
  date_key  TEXT          NOT NULL,           -- yyyy-mm-dd (filter/sort)
  time      TEXT          NOT NULL,           -- HH:MM:SS
  day       TEXT          NOT NULL DEFAULT '',-- 'Monday' etc.
  iso       TEXT          NOT NULL,           -- full ISO timestamp
  status    TEXT          NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_att_date_key ON attendance_records(date_key);
CREATE INDEX IF NOT EXISTS idx_att_name     ON attendance_records(name);

-- ── Employee Registry ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employees (
  id        BIGSERIAL     PRIMARY KEY,
  name      TEXT          NOT NULL,
  dept      TEXT          NOT NULL DEFAULT '',
  emp_id    TEXT          NOT NULL UNIQUE,
  pin_hash  TEXT          NOT NULL,
  pin_raw   TEXT          NOT NULL DEFAULT '', -- shown to admin once then cleared
  photo     TEXT          NOT NULL DEFAULT '', -- base64 data URI
  added     TEXT          NOT NULL DEFAULT '', -- dd/mm/yyyy display string
  added_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_emp_name_lower ON employees(LOWER(name));

-- ── Shared Settings ─────────────────────────────────────────────
-- key/value store; e.g. key 'gps' → {"lat":5.60,"lng":-0.21,"radius":100}
-- (the server also creates this table automatically on startup)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT          PRIMARY KEY,
  value      JSONB         NOT NULL,
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
