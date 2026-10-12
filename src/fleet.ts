// Replicated Fleet read model (C81 G2). Rules never calls Fleet inside a hook (G3, no re-entry): it reads Fleet's
// `directory_get` through its companion grant OUTSIDE calls, keeps teams in its own tables, and the gate reads only
// that local copy. Refresh points: every 60 s from a timer once the SDK offers `callApp` outside op handlers (C85,
// spec 0.1.13; feature-checked), agent events, and person ops when the copy is older than 60 s.
// No Fleet (no grant, not deployed) → teams are empty, so team rules simply do not match.
import type { Db, Json } from "@opt2-tealbrick/miniapp-sdk";
import { normalizeHandle } from "./engine.ts";
import { type FleetTeam, fleetState, writeFleet } from "./store.ts";

export const FLEET_PRODUCT = "fleet";
export const FLEET_OP = "directory_get";
export const REFRESH_MS = 60_000;
/** Refusals that mean "Fleet is not there for us": the copy is cleared (teams empty), not kept. */
const ABSENT = new Set(["not_granted", "unknown_product", "unknown_tool", "app_not_found", "grant_missing", "no_bridge"]);

export type CallApp = (product: string, op: string, input: Json) => Promise<{ status: "ok"; output: unknown } | { status: "held"; holdId: string }>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Teams with their member keys from a `directory_get` answer (Fleet contract, specs/REQUESTS "rules → fleet").
 * Departed people and removed agents carry no team (never widens). Unknown shapes yield no teams.
 */
export function parseDirectory(out: unknown): { revision: number | null; unchanged: boolean; teams: FleetTeam[] } {
  if (!isObj(out)) throw new Error("directory_get answered no object");
  const revision = typeof out.revision === "number" ? out.revision : null;
  if (out.unchanged === true) return { revision, unchanged: true, teams: [] };
  const teams = new Map<string, FleetTeam>();
  for (const t of Array.isArray(out.teams) ? out.teams : []) {
    if (!isObj(t) || typeof t.id !== "string") continue;
    const team: FleetTeam = { id: t.id, name: typeof t.name === "string" ? t.name : t.id, people: 0, agents: 0, keys: [] };
    for (const m of Array.isArray(t.members) ? t.members : []) {
      if (!isObj(m) || typeof m.id !== "string") continue;
      if (m.kind === "agent") {
        team.agents++;
        team.keys.push(`agent:${m.id}`);
      } else if (m.kind === "person") {
        team.people++;
        team.keys.push(`person:${m.id}`);
        for (const h of strs(m.handles)) team.keys.push(`handle:${normalizeHandle(h)}`);
      }
    }
    teams.set(team.id, team);
  }
  // People and agents lists are authoritative for status: drop departed people / removed agents from every team.
  const gone = new Set<string>();
  for (const p of Array.isArray(out.people) ? out.people : []) {
    if (isObj(p) && typeof p.id === "string" && p.status === "departed") {
      gone.add(`person:${p.id}`);
      for (const h of strs(p.handles)) gone.add(`handle:${normalizeHandle(h)}`);
    }
  }
  for (const a of Array.isArray(out.agents) ? out.agents : []) if (isObj(a) && typeof a.id === "string" && a.status === "removed") gone.add(`agent:${a.id}`);
  for (const t of teams.values()) t.keys = [...new Set(t.keys.filter((k) => !gone.has(k)))];
  return { revision, unchanged: false, teams: [...teams.values()] };
}

const inflight = new WeakMap<Db, Promise<void>>();

/** One sync. Never throws: errors are recorded in fleet_sync.error and the last good copy is kept. */
export function syncFleet(db: Db, callApp: CallApp, now: () => number = Date.now): Promise<void> {
  const running = inflight.get(db);
  if (running) return running;
  const p = (async () => {
    const st = fleetState(db);
    try {
      const res = await callApp(FLEET_PRODUCT, FLEET_OP, st.revision != null && !st.stale ? { sinceRevision: st.revision } : {});
      if (res.status !== "ok") throw Object.assign(new Error("Fleet held the directory read"), { code: "held" });
      const d = parseDirectory(res.output);
      writeFleet(db, d.unchanged ? null : d.teams, { revision: d.revision, error: null }, now());
    } catch (e) {
      const code = isObj(e) && typeof e.code === "string" ? e.code : "error";
      const msg = `${code}: ${e instanceof Error ? e.message : "fleet read failed"}`.slice(0, 280);
      // Fleet absent → empty teams (C81: "until then, teams are empty"); transient errors keep the last copy.
      writeFleet(db, ABSENT.has(code) ? [] : null, { revision: ABSENT.has(code) ? null : st.revision, error: msg }, now());
    }
  })().finally(() => inflight.delete(db));
  inflight.set(db, p);
  return p;
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
