-- Pet recall ingest: D1 schema
-- Design notes:
--   * raw_json and raw_description are NEVER dropped. Extraction improves over
--     time and you will want to re-run it across the whole corpus.
--   * extraction_version lets you find records extracted by an older prompt.
--   * content_hash lets the cron skip unchanged records so you only pay for
--     LLM extraction when something actually changed.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- recalls: one row per recall notice, normalized across FSIS and openFDA
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recalls (
  id                 TEXT PRIMARY KEY,           -- 'fsis:065-2026' | 'fda:F-1234-2026'
  source             TEXT NOT NULL,              -- 'fsis' | 'fda'
  source_id          TEXT NOT NULL,
  title              TEXT,
  raw_description    TEXT,                       -- the messy free text we extract from
  reason             TEXT,
  classification     TEXT,                       -- 'Class I' | 'Class II' | 'Class III'
  status             TEXT,                       -- 'ongoing' | 'completed' | 'terminated'
  category           TEXT,                       -- 'pet_food' | 'human_food' | 'drug' | 'device' | 'other'
  species            TEXT,                       -- JSON array: ["dog","cat"]
  recall_date        TEXT,                       -- ISO 8601 date
  recalling_firm     TEXT,
  states             TEXT,                       -- JSON array of 2-letter codes
  url                TEXT,
  raw_json           TEXT NOT NULL,              -- full original payload
  content_hash       TEXT NOT NULL,              -- sha256 of meaningful source fields
  extraction_version INTEGER,                    -- NULL = not yet extracted
  extraction_confidence TEXT,                    -- 'high' | 'medium' | 'low'
  extracted_at       TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_recalls_category_date ON recalls (category, recall_date DESC);
CREATE INDEX IF NOT EXISTS idx_recalls_pending       ON recalls (extraction_version) WHERE extraction_version IS NULL;
CREATE INDEX IF NOT EXISTS idx_recalls_date          ON recalls (recall_date DESC);

-- ---------------------------------------------------------------------------
-- brands: deduped canonical brands. normalized_name is the join key.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brands (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name  TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,          -- lowercase, punctuation stripped
  recall_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Hand-maintained. 'nestle purina' -> the Purina brand row, etc.
-- You WILL be editing this by hand. That is fine and expected.
CREATE TABLE IF NOT EXISTS brand_aliases (
  alias_normalized TEXT PRIMARY KEY,
  brand_id         INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- recall_products: one row per distinct product variant inside a recall
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recall_products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recall_id     TEXT NOT NULL REFERENCES recalls(id) ON DELETE CASCADE,
  brand_raw     TEXT,                            -- exactly as extracted
  brand_id      INTEGER REFERENCES brands(id),   -- resolved, nullable
  product_name  TEXT,
  package_sizes TEXT,                            -- JSON array of strings
  lot_codes     TEXT,                            -- JSON array; display only, do not match on these
  establishment_number TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_recall ON recall_products (recall_id);
CREATE INDEX IF NOT EXISTS idx_products_brand  ON recall_products (brand_id);

-- ---------------------------------------------------------------------------
-- recall_upcs: the high-confidence match path. This is the hot lookup.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recall_upcs (
  recall_id TEXT NOT NULL REFERENCES recalls(id) ON DELETE CASCADE,
  upc       TEXT NOT NULL,                       -- digits only, normalized to 12 where possible
  upc_raw   TEXT NOT NULL,                       -- as it appeared in the notice
  PRIMARY KEY (recall_id, upc)
);

CREATE INDEX IF NOT EXISTS idx_upcs_upc ON recall_upcs (upc);

-- ---------------------------------------------------------------------------
-- ingest_runs: audit log. Check this when something looks wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingest_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  extracted   INTEGER NOT NULL DEFAULT 0,
  errors      TEXT                               -- JSON array of error strings
);

-- ---------------------------------------------------------------------------
-- notify_queue: new/changed recalls waiting to be pushed. The app-facing
-- notifier drains this. Kept separate so a push failure never corrupts ingest.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notify_queue (
  recall_id  TEXT PRIMARY KEY REFERENCES recalls(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,                      -- 'new' | 'updated'
  queued_at  TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_notify_pending ON notify_queue (sent_at) WHERE sent_at IS NULL;

-- ---------------------------------------------------------------------------
-- devices: one row per installed app, keyed by its Expo push token.
--
-- Additive: nothing above this line changed when it was introduced. The same
-- DDL is in migrations/0001_devices.sql for applying to an existing database.
--
-- The token IS the identity. There are no accounts, so the app has nothing else
-- stable to present, and a reinstall legitimately produces a new device.
--
-- followed_brand_ids and pantry_upcs are JSON arrays rather than child tables
-- because matching reads them through json_each() and the whole registry is
-- scanned per recall anyway — the join key would buy nothing at this size, and
-- a single row keeps registration a single idempotent upsert.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devices (
  token              TEXT PRIMARY KEY,             -- 'ExponentPushToken[...]'
  platform           TEXT,                         -- 'ios' | 'android' | NULL
  followed_brand_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of brands.id
  pantry_upcs        TEXT NOT NULL DEFAULT '[]',   -- JSON array of normalized UPCs
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_devices_updated ON devices (updated_at DESC);
