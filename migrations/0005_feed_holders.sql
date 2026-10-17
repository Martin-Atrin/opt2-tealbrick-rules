-- 0.3.0 (C236, second review): a key (a handle) can be held by several contacts. fleet_trust now keeps, per key, the SET of
-- raw trust values of its holders and whether every holder is active; deny/hold rules match if ANY holder matches, allow
-- rules need EVERY holder active and matching. The old rows (one trust per key) cannot say that: the copy is cleared and
-- the next read is a full one.
DELETE FROM fleet_members;
DELETE FROM fleet_teams;
DROP TABLE fleet_trust;
CREATE TABLE fleet_trust (
  member_key TEXT PRIMARY KEY,
  -- comma-separated subset of unreviewed,trusted,limited,blocked (sorted); never empty
  trusts TEXT NOT NULL CHECK (trusts <> ''),
  all_active INTEGER NOT NULL CHECK (all_active IN (0, 1))
);
UPDATE fleet_sync SET revision = NULL, synced_at = NULL, stale = 1, error = NULL, usable = 0 WHERE id = 1;
