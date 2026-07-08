-- M3-02 initial D1 schema for My Mirror Computer.
--
-- Stores ONLY the minimal persistent data allowed by docs/03-security-model.md
-- section 9: device public keys + status, time-boxed remote-allow policies, and
-- a minimal pseudonymous audit trail with 7-day retention. No screen frames,
-- keystrokes, coordinates, SDP, or long-lived tokens are ever stored here.
--
-- Apply with:  wrangler d1 migrations apply <DB_NAME>   (see apps/signaling/README once the D1 binding is wired)

-- One row per registered home-PC agent device. The private key never leaves the
-- host (DPAPI); only the public key + status live here.
CREATE TABLE IF NOT EXISTS devices (
  device_id   TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,             -- IdP subject the device is paired to
  public_key  TEXT NOT NULL,             -- base64url agent device public key
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'revoked')),
  created_at  INTEGER NOT NULL,          -- unix ms
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_devices_subject ON devices (subject);

-- Explicit, time-boxed "allow remote" policy the user sets at the home PC before
-- leaving. Default is no policy => control is off. See ADR-002 / security model
-- section 5.5 (recommended default: view+control, once, start<=12h, max 2h).
CREATE TABLE IF NOT EXISTS remote_policies (
  id                  TEXT PRIMARY KEY,
  device_id           TEXT NOT NULL REFERENCES devices (device_id) ON DELETE CASCADE,
  permission          TEXT NOT NULL CHECK (permission IN ('view', 'control')),
  starts_at           INTEGER NOT NULL,  -- unix ms window open
  expires_at          INTEGER NOT NULL,  -- unix ms window close
  max_session_seconds INTEGER NOT NULL,
  recurrence          TEXT NOT NULL DEFAULT 'once'
                        CHECK (recurrence IN ('once', 'recurring')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'consumed', 'revoked', 'expired')),
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_remote_policies_device ON remote_policies (device_id, status);

-- Minimal audit trail. Pseudonymous IDs only (salted hashes), generalized cause
-- codes, no sensitive content. Rows auto-expire after 7 days (expires_at); a
-- scheduled job / query prunes where expires_at < now.
CREATE TABLE IF NOT EXISTS audit_events (
  id           TEXT PRIMARY KEY,         -- random event id
  device_hash  TEXT,                     -- salted pseudonymous device id (nullable)
  session_hash TEXT,                     -- salted pseudonymous session id (nullable)
  event_type   TEXT NOT NULL,            -- e.g. login.ok, pairing.approved, session.control, turn.issued, ratelimit, emergency.stop
  result       TEXT NOT NULL,            -- e.g. ok, denied, expired
  reason_code  TEXT,                     -- generalized, non-sensitive
  created_at   INTEGER NOT NULL,         -- unix ms
  expires_at   INTEGER NOT NULL          -- unix ms, created_at + 7 days
);

CREATE INDEX IF NOT EXISTS idx_audit_events_expires ON audit_events (expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_type_time ON audit_events (event_type, created_at);
