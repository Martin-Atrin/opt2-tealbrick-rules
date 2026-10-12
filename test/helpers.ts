// Test helpers: a migrated node:sqlite database shaped like the SDK's Db, hook requests and contexts, rule specs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Db, HookContext, HookRequest, Json, OpContext } from "@opt2-tealbrick/miniapp-sdk";
import { migrationsDir } from "../src/app.ts";
import type { RuleSpec } from "../src/engine.ts";

export const AGENT_A = "agt_01J0000000000000000000000A";
export const AGENT_B = "agt_01J0000000000000000000000B";
export const OWNER = "per_01J00000000000000000000OWN";

/** In-memory database with every migration applied (same files the SDK runs). */
export function migratedDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) raw.exec(readFileSync(join(migrationsDir, f), "utf8"));
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction<T>(fn: () => T): T {
      raw.exec("BEGIN");
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db: db as unknown as Db, raw };
}

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

export function hookCtx(db: Db, signal: AbortSignal = new AbortController().signal): HookContext {
  return { db, log: quiet, signal, getKey: async () => null, secrets: { put: async () => {}, get: async () => null, delete: async () => {} } } as HookContext;
}

export function hookReq(
  phase: "before" | "context" | "after",
  o: { caller?: string; mode?: "free" | "bound"; product?: string; op?: string; effect?: string; context?: Record<string, Json>; output?: Json; callId?: string },
): HookRequest {
  return {
    phase,
    call: {
      id: o.callId ?? "cal_01J00000000000000000000001",
      ws: "wsp_01J000000000000000000000WS",
      caller: { type: "agent", id: o.caller ?? AGENT_A, mode: o.mode ?? "free" },
      target: { instance: "ins_01J0000000000000000000TGT", product: o.product ?? "connect", op: o.op ?? "buzz_dm", crud: ["create"], effect: o.effect ?? "outward" },
      input: { text: "hello" },
    },
    context: o.context ?? {},
    ...(phase === "after" ? { output: o.output ?? null } : {}),
  } as unknown as HookRequest;
}

export function spec(o: Partial<RuleSpec> & { decision?: RuleSpec["outcome"]["decision"]; reason?: string }): RuleSpec {
  const { decision, reason, ...rest } = o;
  return { title: "rule", active: true, priority: 100, match: {}, outcome: { decision: decision ?? "deny", reason: reason ?? "not allowed" }, ...rest };
}

/** Minimal OpContext for handler tests (person or agent caller). */
export function opCtx(db: Db, caller: { type: "person" | "agent"; id: string; name?: string; mode?: "free" | "bound" | null }, callApp?: OpContext["callApp"]): OpContext {
  const meta: Json[] = [];
  return {
    db,
    caller: { type: caller.type, id: caller.id, name: caller.name ?? caller.id, mode: caller.mode ?? null },
    log: quiet,
    receipt: { summary() {}, meta: (v: Json) => meta.push(v) },
    statusChanged() {},
    callApp: callApp ?? (async () => Promise.reject(Object.assign(new Error("no grant"), { code: "not_granted" }))),
    signal: new AbortController().signal,
  } as unknown as OpContext;
}
