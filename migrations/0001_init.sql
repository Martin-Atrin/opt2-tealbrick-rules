-- Baseline (SDK-API §7.1): forward-only, one transaction per file, never edited after release.
-- App tables only; `tb_*` names are reserved for the SDK.

-- Rules: the current revision of each rule. `spec` is the RuleSpec JSON (manifest $defs/RuleSpec).
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL,
  spec TEXT NOT NULL,
  priority INTEGER NOT NULL,
  active INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX rules_by_order ON rules (deleted, priority, updated_at DESC, id);

-- Every revision of every rule (who changed what, when).
CREATE TABLE rule_revisions (
  rule_id TEXT NOT NULL,
  rev INTEGER NOT NULL,
  change TEXT NOT NULL,
  spec TEXT NOT NULL,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (rule_id, rev)
);

-- English rules drafted by the owner's agent; the owner approves or rejects them once.
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  text TEXT NOT NULL,
  note TEXT NOT NULL,
  rules TEXT NOT NULL,
  submitted_by_type TEXT NOT NULL,
  submitted_by_id TEXT NOT NULL,
  submitted_by_name TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT,
  rule_ids TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX drafts_by_status ON drafts (status, submitted_at DESC);

-- Decision traces. One row per (call, phase) that Rules decided on; `call_id` joins the target app's receipts.
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  call_id TEXT,
  phase TEXT NOT NULL,
  at INTEGER NOT NULL,
  caller_type TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  caller_mode TEXT,
  product TEXT NOT NULL,
  op TEXT NOT NULL,
  effect TEXT NOT NULL,
  decision TEXT NOT NULL,
  answered TEXT NOT NULL,
  reason TEXT NOT NULL,
  rule_id TEXT,
  rule_rev INTEGER,
  rule_title TEXT,
  on_behalf_of TEXT,
  detail TEXT,
  duration_us INTEGER NOT NULL
);
CREATE INDEX decisions_by_call ON decisions (call_id);
CREATE INDEX decisions_by_caller ON decisions (caller_id, id DESC);

-- Replicated Fleet read model (C81 G2): one row per (team, member key). Keys: person:<id>, agent:<id>, handle:<channel>:<value>.
CREATE TABLE fleet_teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  people INTEGER NOT NULL,
  agents INTEGER NOT NULL
);
CREATE TABLE fleet_members (
  team_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  PRIMARY KEY (team_id, member_key)
);
CREATE INDEX fleet_members_by_key ON fleet_members (member_key);
CREATE TABLE fleet_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER,
  synced_at INTEGER,
  stale INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
INSERT INTO fleet_sync (id, revision, synced_at, stale, error) VALUES (1, NULL, NULL, 1, NULL);
