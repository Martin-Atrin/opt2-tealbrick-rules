// Hook handlers (MANIFEST §8, BRIDGE §8.2). The bridge calls them for every agent-audience call in the workspace
// (manifest `match`); the SDK route checks the hook proof and the timeout. Each handler decides from Rules' own
// cached tables only: no app call (G3), no model call, no network. Every error refuses (fail closed).
import { performance } from "node:perf_hooks";
import { hookResponseProblem } from "@opt2-tealbrick/manifest";
import type { Db, HookContext, HookHandler, HookRequest, Json } from "@opt2-tealbrick/miniapp-sdk";
import { type CallFacts, type Claim, claimKey, evaluate, recorded, redactionsFor, type Verdict } from "./engine.ts";
import { fleetIndex, liveRules, recordDecision } from "./store.ts";

/** Rules' own answer budget, far below the bridge's 2 s hook limit: slower → refuse. */
export const GATE_BUDGET_MS = 250;
/**
 * Spec 0.1.13 (G1): a before hook may answer hold with family `policy`. Feature check with the ONE hook-answer
 * validator (manifest 0.1.8, the same the SDK route and the bridge use): if it refused a policy hold, Rules would
 * fall back to refusing (fail closed) instead of sending an answer the SDK would turn into hook_failed.
 */
export const HOLD_SUPPORTED = hookResponseProblem("before", { allow: false, hold: { family: "policy", reason: "probe" } }, "rules") === null;
export const REASON_MAX = 280;
export const FAIL_CLOSED = "Rules could not decide this call in time, so it is refused (fail closed).";

const clamp = (s: string) => (s.length <= REASON_MAX ? s : `${s.slice(0, REASON_MAX - 1)}…`);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** `tb.onBehalfOf` (bridge, spec 0.1.13 G4b): `{ claim: {kind, id, display?}, verified, via }`. Malformed → no claim. */
export function claimOf(context: Record<string, unknown>): { claim: Claim | null; verified: boolean } {
  const o = context["tb.onBehalfOf"];
  if (!isObj(o) || !isObj(o.claim)) return { claim: null, verified: false };
  const { kind, id } = o.claim;
  if ((kind !== "person" && kind !== "agent" && kind !== "channel_sender") || typeof id !== "string" || id.length === 0 || id.length > 256) return { claim: null, verified: false };
  return { claim: { kind, id }, verified: o.verified === true };
}

/** Facts for one hook call: caller, target, claim, and the claim's teams (local Fleet copy + live Fleet context facts). */
export function factsOf(req: HookRequest, db: Db): CallFacts {
  const ctx = (req.context ?? {}) as Record<string, unknown>;
  const { claim, verified } = claimOf(ctx);
  const teams = new Set<string>();
  if (claim) {
    for (const t of fleetIndex(db).get(claimKey(claim)) ?? []) teams.add(t);
    // Fleet's context hook (order -100) runs before ours in the context phase; its live facts can only add teams,
    // and team rules can only narrow, so a union never widens.
    const live = ctx["fleet.requesterTeams"];
    if (Array.isArray(live)) for (const t of live) if (isObj(t) && typeof t.id === "string") teams.add(t.id);
  }
  return {
    caller: { type: req.call.caller.type, id: req.call.caller.id, mode: req.call.caller.mode ?? null },
    target: { product: req.call.target.product, op: req.call.target.op, effect: req.call.target.effect },
    claim,
    claimVerified: verified,
    claimTeams: [...teams],
  };
}

export type GateAnswer = { allow: true } | { allow: false; reason: string } | { allow: false; hold: { family: "policy"; reason: string } };

/** The before-hook answer for a verdict. Hold without spec 0.1.13 → refuse with the reason (fail closed). */
export function gateAnswer(v: Verdict, holdSupported = HOLD_SUPPORTED): { answer: GateAnswer; answered: "allow" | "deny" | "hold" } {
  const tag = v.rule ? ` (rule ${v.rule.id})` : "";
  if (v.decision === "allow") return { answer: { allow: true }, answered: "allow" };
  if (v.decision === "hold" && holdSupported) return { answer: { allow: false, hold: { family: "policy", reason: clamp(`Needs owner review: ${v.reason}${tag}`) } }, answered: "hold" };
  if (v.decision === "hold")
    return { answer: { allow: false, reason: clamp(`Rules: ${v.reason}${tag}. This needs owner review, which this workspace cannot hold yet, so the call is refused.`) }, answered: "deny" };
  return { answer: { allow: false, reason: clamp(`Rules: ${v.reason}${tag}`) }, answered: "deny" };
}

function elapsedUs(t0: number): number {
  return (performance.now() - t0) * 1000;
}

/** Builds the three handlers. `product` (the manifest id) prefixes context keys; `now` and `budgetMs` are test seams. */
export function makeHooks(product: string, opts: { budgetMs?: number; holdSupported?: boolean; clock?: () => number } = {}): Record<string, HookHandler> {
  const budget = opts.budgetMs ?? GATE_BUDGET_MS;
  const clock = opts.clock ?? (() => performance.now());

  async function rules_gate(req: HookRequest, ctx: HookContext): Promise<GateAnswer> {
    const t0 = clock();
    try {
      const facts = factsOf(req, ctx.db);
      const v = evaluate(liveRules(ctx.db), facts);
      const { answer, answered } = gateAnswer(v, opts.holdSupported ?? HOLD_SUPPORTED);
      if (ctx.signal.aborted || clock() - t0 > budget) throw new Error("gate budget exceeded");
      if (recorded(facts, v)) recordDecision(ctx.db, { callId: req.call.id, phase: "before", facts, decision: v.decision, answered, reason: v.reason, rule: v.rule, durationUs: elapsedUs(t0) });
      return answer;
    } catch (e) {
      ctx.log.warn("rules_gate refused (fail closed)", { error: e instanceof Error ? e.message : "unknown", call: req.call.id });
      return { allow: false, reason: FAIL_CLOSED };
    }
  }

  async function rules_context(req: HookRequest, ctx: HookContext): Promise<{ add: Record<string, Json> }> {
    const t0 = clock();
    const facts = factsOf(req, ctx.db);
    const v = evaluate(liveRules(ctx.db), facts);
    const add: Record<string, Json> = {};
    if (v.rule) add[`${product}.matched`] = { v: 1, ruleId: v.rule.id, rev: v.rule.rev, decision: v.decision };
    if (facts.claim) add[`${product}.onBehalfOf`] = { claim: { ...facts.claim }, verified: facts.claimVerified, teams: [...facts.claimTeams] };
    if (v.decision === "allow" && v.narrowing?.memoryTags && v.rule) {
      add[`${product}.narrowing`] = { v: 1, ruleId: v.rule.id, reason: clamp(v.reason), memoryTags: v.narrowing.memoryTags as Json };
      recordDecision(ctx.db, { callId: req.call.id, phase: "context", facts, decision: v.decision, answered: "narrow", reason: v.reason, rule: v.rule, detail: { narrowing: v.narrowing as Record<string, unknown> }, durationUs: elapsedUs(t0) });
    }
    if (clock() - t0 > budget) throw new Error("context budget exceeded");
    return { add };
  }

  async function rules_filter(req: HookRequest, ctx: HookContext): Promise<{ redactions?: string[] }> {
    if (req.phase !== "after") return {};
    const t0 = clock();
    const facts = factsOf(req, ctx.db);
    const v = evaluate(liveRules(ctx.db), facts);
    if (v.decision !== "allow" || !v.narrowing) return {};
    const redactions = redactionsFor(req.output, v.narrowing);
    if (redactions.length === 0) return {};
    recordDecision(ctx.db, { callId: req.call.id, phase: "after", facts, decision: v.decision, answered: "redact", reason: v.reason, rule: v.rule, detail: { redacted: redactions.length }, durationUs: elapsedUs(t0) });
    return { redactions };
  }

  return { rules_gate, rules_context, rules_filter } as unknown as Record<string, HookHandler>;
}
