// Hook handlers on a migrated database: decisions and traces, fail-closed paths (budget, abort, store failure),
// rules.narrowing v1 from an onBehalfOf claim resolved through the Fleet read model, after-hook redactions.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Json } from "@opt2-tealbrick/miniapp-sdk";
import { FAIL_CLOSED, GATE_BUDGET_MS, makeHooks } from "../src/hooks.ts";
import { listDecisions, saveRule, writeFleet } from "../src/store.ts";
import { hookCtx, hookReq, migratedDb, OWNER, spec } from "./helpers.ts";

const hooks = makeHooks("rules");
const call = (id: string, ...args: unknown[]) => (hooks[id] as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);
const CLAIM = { "tb.onBehalfOf": { claim: { kind: "channel_sender", id: "slack:u777" }, verified: false, via: "mcp_meta" } } as Record<string, Json>;

function j3Db() {
  const { db, raw } = migratedDb();
  writeFleet(db, [{ id: "tm_x", name: "Team X", people: 1, agents: 0, keys: ["person:psn_1", "handle:slack:U777"] }], { revision: 3, error: null });
  saveRule(db, { spec: spec({ title: "Team X: nothing with money", priority: 10, match: { effects: ["money"], onBehalfOf: { teams: ["tm_x"] } }, decision: "deny", reason: "Requests from team X may not involve money" }), actor: OWNER });
  saveRule(db, {
    spec: spec({ title: "Team X: work only", priority: 20, match: { onBehalfOf: { teams: ["tm_x"] } }, decision: "allow", reason: "Team X sees only work memories", narrowing: { memoryTags: { anyOf: ["work"], noneOf: ["critical"] } } }),
    actor: OWNER,
  });
  return { db, raw };
}

test("gate: deny with reason and a trace keyed by callId; ungated read without a rule leaves no trace", async () => {
  const { db } = j3Db();
  const out = await call("rules_gate", hookReq("before", { effect: "money", op: "pay", callId: "cal_money", context: CLAIM }), hookCtx(db));
  assert.equal(out.allow, false);
  assert.match(String(out.reason), /may not involve money \(rule rul_/);
  const allowed = await call("rules_gate", hookReq("before", { effect: "read", product: "knowledge", op: "memory_recall", callId: "cal_read" }), hookCtx(db));
  assert.deepEqual(allowed, { allow: true });
  const outward = await call("rules_gate", hookReq("before", { effect: "outward", callId: "cal_out" }), hookCtx(db));
  assert.deepEqual(outward, { allow: true }, "no rule → allow (C84)");
  const traces = listDecisions(db, { limit: 10 }).items;
  assert.deepEqual(traces.map((t) => [t.callId, t.answered]).sort(), [
    ["cal_money", "deny"],
    ["cal_out", "allow"],
  ]);
  const money = traces.find((t) => t.callId === "cal_money");
  assert.equal(money?.ruleTitle, "Team X: nothing with money");
  assert.deepEqual(money?.onBehalfOf, { kind: "channel_sender", id: "slack:u777", verified: false, teams: ["tm_x"] });
});

test("gate fails closed: over budget, aborted signal, store failure", async () => {
  const { db, raw } = j3Db();
  let t = 0;
  const slow = makeHooks("rules", { clock: () => (t += GATE_BUDGET_MS + 1) });
  const r1 = await (slow.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(hookReq("before", {}), hookCtx(db));
  assert.deepEqual(r1, { allow: false, reason: FAIL_CLOSED });
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await call("rules_gate", hookReq("before", {}), hookCtx(db, ac.signal)), { allow: false, reason: FAIL_CLOSED });
  const broken = migratedDb();
  broken.raw.exec("DROP TABLE rules");
  assert.deepEqual(await call("rules_gate", hookReq("before", {}), hookCtx(broken.db)), { allow: false, reason: FAIL_CLOSED });
  raw.close();
});

test("gate: hold without spec 0.1.13 is refused with the reason; with it, a policy hold verdict", async () => {
  const { db } = migratedDb();
  saveRule(db, { spec: spec({ match: { effects: ["money"] }, decision: "hold", reason: "Payments need the owner" }), actor: OWNER });
  const off = await call("rules_gate", hookReq("before", { effect: "money", op: "pay" }), hookCtx(db));
  assert.equal(off.allow, false);
  assert.match(String(off.reason), /Payments need the owner.*refused/);
  const on = makeHooks("rules", { holdSupported: true });
  const held = await (on.rules_gate as unknown as (...a: unknown[]) => Promise<Record<string, unknown>>)(hookReq("before", { effect: "money", op: "pay" }), hookCtx(db));
  assert.equal(held.allow, false);
  assert.equal((held.hold as { family: string }).family, "policy");
});

test("context: rules.narrowing v1 for a team-tagged knowledge read; nothing without a claim", async () => {
  const { db } = j3Db();
  const out = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge", op: "memory_recall", context: CLAIM }), hookCtx(db))) as { add: Record<string, any> };
  assert.deepEqual(out.add["rules.narrowing"].memoryTags, { anyOf: ["work"], noneOf: ["critical"] });
  assert.equal(out.add["rules.narrowing"].v, 1);
  assert.match(out.add["rules.narrowing"].ruleId, /^rul_/);
  assert.equal(out.add["rules.matched"].decision, "allow");
  assert.deepEqual(out.add["rules.onBehalfOf"].teams, ["tm_x"]);
  assert.ok(Object.keys(out.add).every((k) => k.startsWith("rules.")), "keys are namespaced");
  const none = (await call("rules_context", hookReq("context", { effect: "read", product: "knowledge" }), hookCtx(db))) as { add: Record<string, unknown> };
  assert.deepEqual(none.add, {});
  // Live Fleet facts (fleet.requesterTeams) add teams the local copy does not know yet.
  const live = { ...CLAIM, "tb.onBehalfOf": { claim: { kind: "person", id: "psn_new" }, verified: false }, "fleet.requesterTeams": [{ id: "tm_x", name: "Team X", role: "member" }] } as Record<string, Json>;
  const viaLive = (await call("rules_context", hookReq("context", { effect: "read", context: live }), hookCtx(db))) as { add: Record<string, any> };
  assert.ok(viaLive.add["rules.narrowing"]);
});

test("after: results outside the narrowing are redacted and the redaction is traced", async () => {
  const { db } = j3Db();
  const output = { memories: [{ id: "m1", tags: ["work"] }, { id: "m2", tags: ["family"] }, { id: "m3", tags: ["work", "critical"] }] } as Json;
  const out = await call("rules_filter", hookReq("after", { effect: "read", product: "knowledge", op: "memory_recall", context: CLAIM, output, callId: "cal_r" }), hookCtx(db));
  assert.deepEqual(out, { redactions: ["/memories/2", "/memories/1"] });
  assert.equal(listDecisions(db, { callId: "cal_r", limit: 5 }).items[0]?.answered, "redact");
  assert.deepEqual(await call("rules_filter", hookReq("after", { effect: "read", output }), hookCtx(db)), {}, "no claim → no narrowing → untouched");
});
