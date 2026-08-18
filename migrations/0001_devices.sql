-- Additive migration: device registry for push delivery.
--
-- Nothing here touches recalls, recall_products, recall_upcs, brands,
-- brand_aliases, ingest_runs or notify_queue. Apply with:
--
--   wrangler d1 execute pet-recall --remote --file=./migrations/0001_devices.sql
--
-- The same DDL lives in schema.sql so a fresh init produces this table too;
-- both are CREATE ... IF NOT EXISTS, so applying either twice is a no-op.

-- ---------------------------------------------------------------------------
-- devices: one row per installed app, keyed by its Expo push token.
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
