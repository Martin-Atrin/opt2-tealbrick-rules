// Replicated Fleet read model (C81 G2). Rules never calls Governance (product id `fleet`) inside a hook (G3, no re-entry):
// it reads `directory_feed` (contract fleet.directory_feed/1) through its companion grant OUTSIDE calls, keeps teams and
// trust in its own tables, and the gate reads only that local copy. Refresh points: every 60 s from a timer once the SDK
// offers `callApp` outside op handlers (C85, spec 0.1.13; feature-checked), agent events, and person ops when the copy is
// older than 60 s.
// Every answer is validated against the vendored schema (src/contracts, a byte copy of the frozen contract, see
// test/contracts/PROVENANCE.md) and every handle must be canonical (normalizeHandle(h) === h). A mismatch is a REFUSAL:
// the error is recorded (fleet_status shows it), the copy is cleared, nothing of the answer is read (never a partial read).
// No Governance (no grant, not deployed) or a refused answer → the Fleet facts are UNAVAILABLE: the engine applies deny
// and hold rules that name Fleet facts and skips allow rules that name them (fail closed, C230).

import { normalizeHandle, validateAgainstSchema } from "@opt2-tealbrick/manifest";
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import feedSchema from "./contracts/fleet.directory_feed.1.schema.json" with { type: "json" };
import type { Trust } from "./engine.ts";
import { emptyFleet, FLEET_MAX_STALE_MS, type FleetModel, type FleetTeam, fleetState, setFleetStale, staleMarksOf, type TrustEntry, writeFleetChunked } from "./store.ts";

export const FLEET_PRODUCT = "fleet";
export const FLEET_OP = "directory_feed";
export const REFRESH_MS = 60_000;
/** The error code of an answer that does not fit the contract (a refusal). */
export const FEED_INVALID = "feed_invalid";
/**
 * Refusals: Governance is not there for us (no grant, not deployed, unlicensed, paused, ...) or its answer breaks the
 * contract. The copy is CLEARED at once (the Fleet facts become unavailable, A2A-9 / C230). Any 4xx except 408/429 is a
 * refusal too; everything else (5xx incl. the feed's 503 `feed_too_large`, timeout, network, rate limit) is transient:
 * the copy is kept while its last successful read is ≤ FLEET_MAX_STALE_MS old.
 */
const REFUSALS = new Set([
  FEED_INVALID,
  "no_grant",
  "not_granted",
  "grant_missing",
  "grant_invalid",
  "grant_stale",
  "not_found",
  "unknown_product",
  "unknown_tool",
  "app_not_found",
  "unlicensed",
  "not_licensed",
  "forbidden",
  "scope_denied",
  "paused",
  "held",
]);

export function isRefusal(e: unknown): boolean {
  const code = isObj(e) && typeof e.code === "string" ? e.code : "";
  if (REFUSALS.has(code)) return true;
  const status = isObj(e) && typeof e.httpStatus === "number" ? e.httpStatus : null;
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export type CallApp = (product: string, op: string, input: Json) => Promise<{ status: "ok"; output: unknown } | { status: "held"; holdId: string }>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const feedInvalid = (why: string): Error => Object.assign(new Error(why.slice(0, 240)), { code: FEED_INVALID });

/** Least permissive last: the stricter trust wins whenever two values meet for one key (never widens). */
const STRICTNESS: readonly Trust[] = ["trusted", "unreviewed", "limited", "blocked"];
export const strictest = (a: Trust, b: Trust): Trust => (STRICTNESS.indexOf(a) >= STRICTNESS.indexOf(b) ? a : b);

export interface ParsedFeed {
  revision: number;
  unchanged: boolean;
  model: FleetModel;
}

/**
 * The model from a `directory_feed` answer. Throws (code `feed_invalid`) unless the answer passes the vendored schema, every
 * handle is canonical and no team, contact or agent id is listed twice. Mapping:
 * - TWO key sets per team. `keys` = every member (deny and hold rules); `activeKeys` = members that count (allow rules).
 *   A DEPARTED or BLOCKED contact and a REMOVED agent are members but do not count; so is a member the producer left out
 *   of `contacts`/`agents`. A paused agent counts. Keys are dropped PER MEMBER: an active contact that shares a handle with
 *   a departed one keeps the handle key.
 *   Keys: `agent:<id>`; `contact:<id>` and `handle:<canonical>` (every handle of the contact).
 * - trust keys: `contact:<id>`, each `handle:<h>`, `agent:<id>`. A gone (departed/removed) `trusted` entry becomes
 *   `unreviewed`; blocked/limited/unreviewed stay. When several entries share a key the STRICTER trust wins, and the key is
 *   "gone" only if all of them are.
 */
export function parseFeed(out: unknown): ParsedFeed {
  if (!isObj(out)) throw feedInvalid("directory_feed answered no object");
  const v = validateAgainstSchema(feedSchema as unknown as Parameters<typeof validateAgainstSchema>[0], out as Json);
  if (!v.ok) throw feedInvalid(`the answer does not fit fleet.directory_feed/1: ${v.errors.slice(0, 3).map((e) => `${e.path || "/"} ${e.message}`).join("; ")}`);
  const revision = out.revision as number;
  if (out.unchanged === true) return { revision, unchanged: true, model: emptyFleet() };

  const contacts = out.contacts as { id: string; kind: string; status: string; trust: Trust; handles: string[] }[];
  const agents = out.agents as { id: string; status: string; trust: Trust }[];
  const teamsIn = out.teams as { id: string; name?: string; members: { kind: string; id: string }[] }[];
  for (const c of contacts)
    for (const h of c.handles) if (normalizeHandle(h) !== h) throw feedInvalid(`a handle is not canonical (normalizeHandle): ${h.slice(0, 40)}`);
  for (const [what, ids] of [["team", teamsIn.map((t) => t.id)], ["contact", contacts.map((c) => c.id)], ["agent", agents.map((a) => a.id)]] as const) {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) throw feedInvalid(`${what} id listed twice: ${id.slice(0, 40)}`);
      seen.add(id);
    }
  }

  const trust = new Map<string, TrustEntry>();
  const put = (key: string, t: Trust, gone: boolean) => {
    const cur = trust.get(key);
    trust.set(key, cur ? { trust: strictest(cur.trust, t), gone: cur.gone && gone } : { trust: t, gone });
  };
  const contactBy = new Map<string, { keys: string[]; gone: boolean }>();
  for (const c of contacts) {
    const keys = [`contact:${c.id}`, ...c.handles.map((h) => `handle:${h}`)];
    const gone = c.status === "departed" || c.trust === "blocked";
    contactBy.set(c.id, { keys, gone });
    const eff: Trust = gone && c.trust === "trusted" ? "unreviewed" : c.trust;
    for (const k of keys) put(k, eff, gone);
  }
  const agentGone = new Map<string, boolean>();
  for (const a of agents) {
    const gone = a.status === "removed";
    agentGone.set(a.id, gone);
    put(`agent:${a.id}`, gone && a.trust === "trusted" ? "unreviewed" : a.trust, gone);
  }

  const teams: FleetTeam[] = [];
  for (const t of teamsIn) {
    const team: FleetTeam = { id: t.id, name: t.name ?? t.id, people: 0, agents: 0, keys: [], activeKeys: [] };
    for (const m of t.members) {
      if (m.kind === "agent") {
        team.agents++;
        team.keys.push(`agent:${m.id}`);
        if (agentGone.get(m.id) === false) team.activeKeys.push(`agent:${m.id}`);
      } else {
        team.people++;
        const c = contactBy.get(m.id);
        team.keys.push(...(c?.keys ?? [`contact:${m.id}`]));
        if (c && !c.gone) team.activeKeys.push(...c.keys);
      }
    }
    team.keys = [...new Set(team.keys)];
    team.activeKeys = [...new Set(team.activeKeys)];
    teams.push(team);
  }
  return { revision, unchanged: false, model: { teams, trust } };
}

const inflight = new WeakMap<Db, Promise<void>>();

/**
 * One sync (plus at most two more when `markFleetStale` was called while it ran: the flag the first write cleared is set
 * again and the agent-list change is read). Never throws: errors are recorded in fleet_sync.error and the last good copy is
 * kept (unless refused).
 */
export function syncFleet(db: Db, callApp: CallApp, now: () => number = Date.now): Promise<void> {
  const running = inflight.get(db);
  if (running) return running;
  const p = (async () => {
    for (let round = 0; round < 3; round++) {
      const marks = staleMarksOf(db);
      await syncOnce(db, callApp, now);
      if (staleMarksOf(db) === marks) break;
      setFleetStale(db);
    }
  })().finally(() => inflight.delete(db));
  inflight.set(db, p);
  return p;
}

async function syncOnce(db: Db, callApp: CallApp, now: () => number): Promise<void> {
  const st = fleetState(db);
  try {
    const since = st.revision != null && !st.stale && st.usable ? st.revision : null;
    const res = await callApp(FLEET_PRODUCT, FLEET_OP, since !== null ? { sinceRevision: since } : {});
    if (res.status !== "ok") throw Object.assign(new Error("Governance held the directory read"), { code: "held" });
    const d = parseFeed(res.output);
    // "unchanged" is only valid for the revision we asked about; anything else is a broken answer, not a no-op.
    if (d.unchanged && d.revision !== since) throw feedInvalid(`unchanged answered for revision ${d.revision}, asked ${since ?? "none"}`);
    await writeFleetChunked(db, d.unchanged ? null : d.model, { revision: d.revision, error: null }, now());
  } catch (e) {
    const code = isObj(e) && typeof e.code === "string" ? e.code : "error";
    const reason = e instanceof Error ? e.message : "fleet read failed";
    const msg = (code === FEED_INVALID ? `Governance feed refused: ${reason}` : `Governance not reachable: ${code}: ${reason}`).slice(0, 280);
    const t = now();
    const expired = st.syncedAt == null || t - st.syncedAt > FLEET_MAX_STALE_MS;
    // Refusal → clear now; transient → keep the last copy for ≤ 10 min after the last successful read, then clear.
    // The timer keeps retrying every REFRESH_MS either way.
    await writeFleetChunked(db, isRefusal(e) || expired ? emptyFleet() : null, { revision: st.revision, error: msg }, t);
  }
}

/** Refresh when the copy is stale or older than REFRESH_MS (person ops; bounded wait so the UI stays responsive). */
export async function refreshIfStale(db: Db, callApp: CallApp, waitMs = 3000, now: () => number = Date.now): Promise<void> {
  const st = fleetState(db);
  if (!st.stale && st.syncedAt != null && now() - st.syncedAt < REFRESH_MS) return;
  await Promise.race([syncFleet(db, callApp, now), new Promise((r) => setTimeout(r, waitMs).unref())]);
}

/** The 60 s timer, when the SDK hands out a background `callApp` (C85). Returns a stop function. */
export function startFleetTimer(db: Db, callApp: CallApp): () => void {
  void syncFleet(db, callApp);
  const t = setInterval(() => void syncFleet(db, callApp), REFRESH_MS);
  t.unref();
  return () => clearInterval(t);
}
