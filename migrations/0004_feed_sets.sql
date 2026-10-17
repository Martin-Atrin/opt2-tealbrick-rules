-- 0.3.0 (C230, C236 review): two membership sets and a "gone" mark on trust keys.
-- fleet_members.active: 1 = the member counts for ALLOW rules; 0 = blocked, departed or removed (deny/hold rules still see
-- the membership, allow rules never do). fleet_trust.gone: 1 = every contact or agent behind the key is gone.
-- The copy read before this migration has no such marks: it is cleared and the next read is a full one.
DELETE FROM fleet_members;
DELETE FROM fleet_teams;
DELETE FROM fleet_trust;
ALTER TABLE fleet_members ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fleet_trust ADD COLUMN gone INTEGER NOT NULL DEFAULT 0;
UPDATE fleet_sync SET revision = NULL, synced_at = NULL, stale = 1, error = NULL, usable = 0 WHERE id = 1;
