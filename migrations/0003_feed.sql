-- 0.3.0 (C230, G-3): the Fleet read model is now filled from Governance's `directory_feed` (contract fleet.directory_feed/1).
-- Member keys change: `person:<id>` becomes `contact:<id>`, and trust is new. The 0.2.x copy is unusable under the new
-- keys, so it is cleared here and the first read after the update is a full one. Until that read succeeds the copy is
-- "unavailable": deny and hold rules that name Fleet facts apply, allow rules that name them do not (fail closed).

DELETE FROM fleet_members;
DELETE FROM fleet_teams;
-- member key (`contact:<id>` or `handle:<canonical handle>`) -> trust of that contact, one row per key
CREATE TABLE fleet_trust (
  member_key TEXT PRIMARY KEY,
  trust TEXT NOT NULL CHECK (trust IN ('unreviewed', 'trusted', 'limited', 'blocked'))
);
-- 1 only after a successful read, and until a refusal clears the copy (transient failures keep it; age is checked separately)
ALTER TABLE fleet_sync ADD COLUMN usable INTEGER NOT NULL DEFAULT 0;
UPDATE fleet_sync SET revision = NULL, synced_at = NULL, stale = 1, error = NULL, usable = 0 WHERE id = 1;

-- Who proposed a draft. JSON {kind: 'agent' | 'app', product?, name?, instance?}; NULL on rows from 0.2.x (derived from submitted_by_*).
ALTER TABLE drafts ADD COLUMN source TEXT;
