-- App catalog (0.2.7): the operations each product declares, read from the SIGNED release index (the same source Core's
-- release sync reads, L1). Writers use it to refuse rules that can never match (L3, L24); the gate never reads it.

-- One row per verified manifest (by digest): a compact summary of its operations, fetched once.
CREATE TABLE catalog_manifests (
  digest TEXT PRIMARY KEY,
  product TEXT NOT NULL,
  version TEXT NOT NULL,
  published_at TEXT NOT NULL,
  -- JSON [{id, title, effect, audience, dynamic, tools[]}]
  ops TEXT NOT NULL
);

-- Last index read. `digests` = the manifests the current index lists (JSON array); errors never clear it.
CREATE TABLE catalog_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at TEXT,
  synced_at INTEGER,
  attempted_at INTEGER,
  digests TEXT,
  error TEXT
);
INSERT INTO catalog_sync (id, generated_at, synced_at, attempted_at, digests, error) VALUES (1, NULL, NULL, NULL, NULL, NULL);
