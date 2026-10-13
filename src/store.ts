// Rules' own tables (migrations/0001_init.sql): rules + revisions, drafts, decision traces, Fleet read model.
// Plain functions over the SDK `Db`. The gate reads rules and the Fleet index from per-database caches that every
// write here invalidates, so a hook call does no query except the trace insert.
import { ulid } from "@opt2-tealbrick/manifest";
import { type Db, TbError } from "@opt2-tealbrick/miniapp-sdk";
import { CATALOG_MISSING, catalogOf, catalogProblem } from "./catalog.ts";
import { type CallFacts, type Decision, order, type Rule, type RuleSpec, specProblem } from "./engine.ts";

/** At most this many live rules (a gate evaluates all of them on every call). */
export const MAX_RULES = 500;
/** Pending drafts per submitting agent. */
export const MAX_PENDING_DRAFTS = 20;
/** Decision traces kept: newest N, and none older than the retention window. */
export const TRACE_KEEP = 100_000;
export const TRACE_RETENTION_MS = 30 * 24 * 3600 * 1000;

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(Number(ms)).toISOString());
const json = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== "string") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

// ── caches ───────────────────────────────────────────────────────────────────
const ruleCache = new WeakMap<Db, Rule[]>();
const fleetCache = new WeakMap<Db, { idx: Map<string, string[]>; okAt: number | null }>();
/** A Fleet copy older than this (no successful read since) is not used: team rules match nobody (A2A-9, fail safe). */
export const FLEET_MAX_STALE_MS = 10 * 60 * 1000;

export function invalidateRules(db: Db): void {
  ruleCache.delete(db);
}

/** Live rules (not deleted) in evaluation order; cached until the next write. */
export function liveRules(db: Db): Rule[] {
  const hit = ruleCache.get(db);
  if (hit) return hit;
  const rows = db.prepare("SELECT id, rev, spec, updated_at FROM rules WHERE deleted = 0").all();
  const rules = order(rows.map((r) => ({ id: String(r.id), rev: Number(r.rev), spec: JSON.parse(String(r.spec)) as RuleSpec, updatedAt: Number(r.updated_at) })));
  ruleCache.set(db, rules);
  return rules;
}

// ── rules ────────────────────────────────────────────────────────────────────
export interface RuleView {
  id: string;
  rev: number;
  spec: RuleSpec;
  source: string;
  createdAt: string;
  updatedAt: string;
}

function ruleView(r: Record<string, unknown>): RuleView {
  return { id: String(r.id), rev: Number(r.rev), spec: JSON.parse(String(r.spec)) as RuleSpec, source: String(r.source), createdAt: iso(Number(r.created_at)) as string, updatedAt: iso(Number(r.updated_at)) as string };
}

export function listRules(db: Db, includeDeleted = false): RuleView[] {
  const rows = db.prepare(`SELECT * FROM rules ${includeDeleted ? "" : "WHERE deleted = 0"} ORDER BY deleted, priority, updated_at DESC, id`).all();
  return rows.map(ruleView);
}

export function getRule(db: Db, id: string): { rule: RuleView; deleted: boolean; revisions: { rev: number; change: "created" | "updated" | "deleted"; spec: RuleSpec; actor: string; at: string }[] } {
  const row = db.prepare("SELECT * FROM rules WHERE id = ?").get(id);
  if (!row) throw new TbError("not_found", "no rule with this id", 404);
  const revisions = db
    .prepare("SELECT rev, change, spec, actor, at FROM rule_revisions WHERE rule_id = ? ORDER BY rev DESC")
    .all(id)
    .map((r) => ({ rev: Number(r.rev), change: String(r.change) as "created" | "updated" | "deleted", spec: JSON.parse(String(r.spec)) as RuleSpec, actor: String(r.actor), at: iso(Number(r.at)) as string }));
  return { rule: ruleView(row), deleted: Number(row.deleted) === 1, revisions };
}

/** Why a stored or submitted spec is unusable ("" = fine): schema-free checks, then the app catalog (never matches). */
export function ruleProblem(db: Db, spec: RuleSpec): string {
  return specProblem(spec) || catalogProblem(spec, catalogOf(db));
}

/** Writer strict (L24): refuse a spec with a problem. `label` prefixes the message (drafts name the rule). */
function checkSpec(db: Db, spec: RuleSpec, label = ""): void {
  const p = ruleProblem(db, spec);
  if (p === CATALOG_MISSING) throw new TbError("catalog_unavailable", p, 503);
  if (p) throw new TbError("input_invalid", `${label}${p}`, 400);
}

/** Create (no id) or update (id + optional expectedRev). Writes a revision row. */
export function saveRule(db: Db, input: { id?: string; expectedRev?: number; spec: RuleSpec; actor: string; source?: string }, now = Date.now()): RuleView {
  checkSpec(db, input.spec);
  const out = db.transaction(() => {
    if (!input.id) {
      const live = Number(db.prepare("SELECT COUNT(*) AS n FROM rules WHERE deleted = 0").get()?.n ?? 0);
      if (live >= MAX_RULES) throw new TbError("too_many_rules", `at most ${MAX_RULES} rules`, 409);
      const id = `rul_${ulid(now)}`;
      const spec = JSON.stringify(input.spec);
      db.prepare("INSERT INTO rules (id, rev, spec, priority, active, deleted, source, created_at, updated_at) VALUES (?, 1, ?, ?, ?, 0, ?, ?, ?)").run(id, spec, input.spec.priority, input.spec.active ? 1 : 0, input.source ?? "owner", now, now);
      db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, 1, 'created', ?, ?, ?)").run(id, spec, input.actor, now);
      return id;
    }
    const row = db.prepare("SELECT rev, deleted FROM rules WHERE id = ?").get(input.id);
    if (!row || Number(row.deleted) === 1) throw new TbError("not_found", "no rule with this id", 404);
    const rev = Number(row.rev);
    if (input.expectedRev !== undefined && input.expectedRev !== rev) throw new TbError("revision_conflict", `the rule changed (now revision ${rev}); reload and edit again`, 409);
    const spec = JSON.stringify(input.spec);
    db.prepare("UPDATE rules SET rev = ?, spec = ?, priority = ?, active = ?, updated_at = ? WHERE id = ?").run(rev + 1, spec, input.spec.priority, input.spec.active ? 1 : 0, now, input.id);
    db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, ?, 'updated', ?, ?, ?)").run(input.id, rev + 1, spec, input.actor, now);
    return input.id;
  });
  invalidateRules(db);
  return ruleView(db.prepare("SELECT * FROM rules WHERE id = ?").get(out) as Record<string, unknown>);
}

/** Removes the rule from evaluation; its history stays (a new 'deleted' revision). */
export function deleteRule(db: Db, input: { id: string; expectedRev?: number; actor: string }, now = Date.now()): { id: string; rev: number } {
  const rev = db.transaction(() => {
    const row = db.prepare("SELECT rev, spec, deleted FROM rules WHERE id = ?").get(input.id);
    if (!row || Number(row.deleted) === 1) throw new TbError("not_found", "no rule with this id", 404);
    const cur = Number(row.rev);
    if (input.expectedRev !== undefined && input.expectedRev !== cur) throw new TbError("revision_conflict", `the rule changed (now revision ${cur})`, 409);
    db.prepare("UPDATE rules SET rev = ?, deleted = 1, active = 0, updated_at = ? WHERE id = ?").run(cur + 1, now, input.id);
    db.prepare("INSERT INTO rule_revisions (rule_id, rev, change, spec, actor, at) VALUES (?, ?, 'deleted', ?, ?, ?)").run(input.id, cur + 1, String(row.spec), input.actor, now);
    return cur + 1;
  });
  invalidateRules(db);
  return { id: input.id, rev };
}

// ── drafts ───────────────────────────────────────────────────────────────────
export interface DraftView {
  id: string;
  status: "pending" | "approved" | "rejected";
  text: string;
  note: string;
  rules: RuleSpec[];
  submittedBy: { type: string; id: string; name: string };
  submittedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  ruleIds: string[];
}

function draftView(r: Record<string, unknown>): DraftView {
  return {
    id: String(r.id),
    status: String(r.status) as DraftView["status"],
    text: String(r.text),
    note: String(r.note),
    rules: json<RuleSpec[]>(r.rules, []),
    submittedBy: { type: String(r.submitted_by_type), id: String(r.submitted_by_id), name: String(r.submitted_by_name) },
    submittedAt: iso(Number(r.submitted_at)) as string,
    decidedAt: iso(r.decided_at == null ? null : Number(r.decided_at)),
    decidedBy: r.decided_by == null ? null : String(r.decided_by),
    ruleIds: json<string[]>(r.rule_ids, []),
  };
}

export function submitDraft(db: Db, input: { text: string; note?: string; rules: RuleSpec[]; by: { type: string; id: string; name: string } }, now = Date.now()): DraftView {
  input.rules.forEach((spec, i) => {
    checkSpec(db, spec, `rule ${i + 1} (“${spec.title}”): `);
  });
  const pending = Number(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending' AND submitted_by_id = ?").get(input.by.id)?.n ?? 0);
  if (pending >= MAX_PENDING_DRAFTS) throw new TbError("too_many_drafts", `at most ${MAX_PENDING_DRAFTS} pending drafts per agent; ask the owner to review them`, 429);
  const id = `drf_${ulid(now)}`;
  db.prepare(
    "INSERT INTO drafts (id, status, text, note, rules, submitted_by_type, submitted_by_id, submitted_by_name, submitted_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, input.text, input.note ?? "", JSON.stringify(input.rules), input.by.type, input.by.id, input.by.name.slice(0, 120), now);
  return draftView(db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Record<string, unknown>);
}

export function getDraft(db: Db, id: string): DraftView | null {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id);
  return row ? draftView(row) : null;
}

export function pendingDraftCount(db: Db): number {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE status = 'pending'").get()?.n ?? 0);
}

export function listDrafts(db: Db, status: DraftView["status"] | undefined, limit: number): DraftView[] {
  const rows = status
    ? db.prepare("SELECT * FROM drafts WHERE status = ? ORDER BY submitted_at DESC, id DESC LIMIT ?").all(status, limit)
    : db.prepare("SELECT * FROM drafts ORDER BY (status = 'pending') DESC, submitted_at DESC, id DESC LIMIT ?").all(limit);
  return rows.map(draftView);
}

/** Approve (rules created, source = draft id) or reject, once. A decided draft is final. */
export function decideDraft(db: Db, input: { id: string; decision: "approve" | "reject"; actor: string }, now = Date.now()): DraftView {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(input.id);
  if (!row) throw new TbError("not_found", "no draft with this id", 404);
  if (String(row.status) !== "pending") throw new TbError("draft_decided", `this draft is already ${String(row.status)}`, 409);
  const ruleIds: string[] = [];
  if (input.decision === "approve") {
    // A draft whose rule could never match is not applied (it would look like protection and protect nothing, L3).
    json<RuleSpec[]>(row.rules, []).forEach((spec, i) => {
      const p = ruleProblem(db, spec);
      if (p === CATALOG_MISSING) throw new TbError("catalog_unavailable", p, 503);
      if (p) throw new TbError("draft_never_matches", `This draft cannot be applied: rule ${i + 1} (“${spec.title}”): ${p}. Reject it and ask the agent for a corrected draft.`, 409);
    });
    const live = Number(db.prepare("SELECT COUNT(*) AS n FROM rules WHERE deleted = 0").get()?.n ?? 0);
    if (live + json<RuleSpec[]>(row.rules, []).length > MAX_RULES) throw new TbError("too_many_rules", `at most ${MAX_RULES} rules; delete some first`, 409);
    for (const spec of json<RuleSpec[]>(row.rules, [])) ruleIds.push(saveRule(db, { spec, actor: input.actor, source: input.id }, now).id);
  }
  db.prepare("UPDATE drafts SET status = ?, decided_at = ?, decided_by = ?, rule_ids = ? WHERE id = ? AND status = 'pending'").run(
    input.decision === "approve" ? "approved" : "rejected",
    now,
    input.actor,
    JSON.stringify(ruleIds),
    input.id,
  );
  return draftView(db.prepare("SELECT * FROM drafts WHERE id = ?").get(input.id) as Record<string, unknown>);
}

// ── decision traces ──────────────────────────────────────────────────────────
export type Answered = "allow" | "deny" | "hold" | "narrow" | "redact";
export interface TraceInput {
  callId: string | null;
  phase: "before" | "context" | "after" | "preview";
  facts: CallFacts;
  decision: Decision;
  answered: Answered;
  reason: string;
  rule: { id: string; rev: number; title: string } | null;
  detail?: Record<string, unknown> | null;
  durationUs: number;
}

let inserts = 0;

export function recordDecision(db: Db, t: TraceInput, now = Date.now()): string {
  const id = `dec_${ulid(now)}`;
  const obo = t.facts.claim ? JSON.stringify({ ...t.facts.claim, verified: t.facts.claimVerified, teams: t.facts.claimTeams }) : null;
  db.prepare(
    "INSERT INTO decisions (id, call_id, phase, at, caller_type, caller_id, caller_mode, product, op, effect, decision, answered, reason, rule_id, rule_rev, rule_title, on_behalf_of, detail, duration_us) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    t.callId,
    t.phase,
    now,
    t.facts.caller.type,
    t.facts.caller.id,
    t.facts.caller.mode,
    t.facts.target.product,
    t.facts.target.op,
    t.facts.target.effect,
    t.decision,
    t.answered,
    t.reason.slice(0, 280),
    t.rule?.id ?? null,
    t.rule?.rev ?? null,
    t.rule?.title ?? null,
    obo,
    t.detail ? JSON.stringify(t.detail) : null,
    Math.max(0, Math.round(t.durationUs)),
  );
  if (++inserts % 1000 === 0) pruneDecisions(db, now);
  return id;
}

export function pruneDecisions(db: Db, now = Date.now()): void {
  db.prepare("DELETE FROM decisions WHERE at < ?").run(now - TRACE_RETENTION_MS);
  db.prepare("DELETE FROM decisions WHERE id IN (SELECT id FROM decisions ORDER BY id DESC LIMIT -1 OFFSET ?)").run(TRACE_KEEP);
}

export interface DecisionView {
  id: string;
  callId: string | null;
  phase: TraceInput["phase"];
  at: string;
  caller: { type: string; id: string; mode: string | null };
  target: { product: string; op: string; effect: string };
  decision: Decision;
  answered: Answered;
  reason: string;
  ruleId: string | null;
  ruleRev: number | null;
  ruleTitle: string | null;
  onBehalfOf: Record<string, unknown> | null;
  detail: Record<string, unknown> | null;
  durationUs: number;
}

function decisionView(r: Record<string, unknown>): DecisionView {
  return {
    id: String(r.id),
    callId: r.call_id == null ? null : String(r.call_id),
    phase: String(r.phase) as DecisionView["phase"],
    at: iso(Number(r.at)) as string,
    caller: { type: String(r.caller_type), id: String(r.caller_id), mode: r.caller_mode == null ? null : String(r.caller_mode) },
    target: { product: String(r.product), op: String(r.op), effect: String(r.effect) },
    decision: String(r.decision) as Decision,
    answered: String(r.answered) as Answered,
    reason: String(r.reason),
    ruleId: r.rule_id == null ? null : String(r.rule_id),
    ruleRev: r.rule_rev == null ? null : Number(r.rule_rev),
    ruleTitle: r.rule_title == null ? null : String(r.rule_title),
    onBehalfOf: json<Record<string, unknown> | null>(r.on_behalf_of, null),
    detail: json<Record<string, unknown> | null>(r.detail, null),
    durationUs: Number(r.duration_us),
  };
}

export function listDecisions(db: Db, q: { callId?: string; caller?: string; decision?: Decision; product?: string; cursor?: string; limit: number }): { items: DecisionView[]; nextCursor: string | null } {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    if (value === undefined || value === "") return;
    where.push(sql);
    args.push(value);
  };
  add("call_id = ?", q.callId);
  add("caller_id = ?", q.caller);
  add("decision = ?", q.decision);
  add("product = ?", q.product);
  add("id < ?", q.cursor);
  const rows = db.prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, q.limit + 1);
  const items = rows.slice(0, q.limit).map(decisionView);
  return { items, nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
}

// ── Fleet read model ─────────────────────────────────────────────────────────
export interface FleetTeam {
  id: string;
  name: string;
  people: number;
  agents: number;
  /** member keys: person:<id>, agent:<id>, handle:<handle> */
  keys: string[];
}

export interface FleetSyncState {
  revision: number | null;
  /** epoch ms of the last SUCCESSFUL read (errors never move it) */
  syncedAt: number | null;
  stale: boolean;
  error: string | null;
}

export function fleetState(db: Db): FleetSyncState {
  const r = db.prepare("SELECT revision, synced_at, stale, error FROM fleet_sync WHERE id = 1").get();
  return { revision: r?.revision == null ? null : Number(r.revision), syncedAt: r?.synced_at == null ? null : Number(r.synced_at), stale: Number(r?.stale ?? 1) === 1, error: r?.error == null ? null : String(r.error) };
}

export function markFleetStale(db: Db): void {
  db.prepare("UPDATE fleet_sync SET stale = 1 WHERE id = 1").run();
}

/**
 * One sync outcome in one transaction. Success (`error` null): `teams` replaces the model (null = unchanged), the read
 * time moves. Failure: `teams` = [] clears the model (revision forgotten, next read is a full one), null keeps it; the
 * last successful read time stays.
 */
export function writeFleet(db: Db, teams: FleetTeam[] | null, state: { revision: number | null; error: string | null }, now = Date.now()): void {
  db.transaction(() => {
    if (teams) {
      db.exec("DELETE FROM fleet_members; DELETE FROM fleet_teams;");
      const t = db.prepare("INSERT INTO fleet_teams (id, name, people, agents) VALUES (?, ?, ?, ?)");
      const m = db.prepare("INSERT OR IGNORE INTO fleet_members (team_id, member_key) VALUES (?, ?)");
      for (const team of teams) {
        t.run(team.id, team.name, team.people, team.agents);
        for (const k of team.keys) m.run(team.id, k);
      }
    }
    if (state.error === null) db.prepare("UPDATE fleet_sync SET revision = ?, synced_at = ?, stale = 0, error = NULL WHERE id = 1").run(state.revision, now);
    else if (teams) db.prepare("UPDATE fleet_sync SET revision = NULL, stale = 1, error = ? WHERE id = 1").run(state.error);
    else db.prepare("UPDATE fleet_sync SET error = ? WHERE id = 1").run(state.error);
  });
  fleetCache.delete(db);
}

export function fleetTeams(db: Db): { id: string; name: string; people: number; agents: number }[] {
  return db
    .prepare("SELECT id, name, people, agents FROM fleet_teams ORDER BY name, id")
    .all()
    .map((r) => ({ id: String(r.id), name: String(r.name), people: Number(r.people), agents: Number(r.agents) }));
}

/**
 * member key → team ids; cached until the next sync. Empty when no read has succeeded within FLEET_MAX_STALE_MS, so a
 * copy that can no longer be confirmed never decides (fail safe), whatever stopped the refresh.
 */
export function fleetIndex(db: Db, now = Date.now()): Map<string, string[]> {
  let hit = fleetCache.get(db);
  if (!hit) {
    hit = { idx: loadFleetIndex(db), okAt: fleetState(db).syncedAt };
    fleetCache.set(db, hit);
  }
  return hit.okAt != null && now - hit.okAt <= FLEET_MAX_STALE_MS ? hit.idx : new Map();
}

function loadFleetIndex(db: Db): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const r of db.prepare("SELECT team_id, member_key FROM fleet_members").all()) {
    const k = String(r.member_key);
    const list = idx.get(k) ?? [];
    list.push(String(r.team_id));
    idx.set(k, list);
  }
  return idx;
}
