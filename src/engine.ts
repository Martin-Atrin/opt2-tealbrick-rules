// The rule engine: pure functions, no I/O, no model call. The gate hook calls `evaluate` on every call it sees,
// so everything here is synchronous and linear in the number of active rules.
//
// Semantics (harvested from the v1 policy engine, new structure):
// - A rule matches when every criterion it names matches (an absent or empty list = any).
// - Rules are ordered by priority (lower first), then newest update, then id. The FIRST matching rule decides.
// - No matching rule = allow (C84). Free/Bound caps and held families stay the floor in the target app.
// - An `onBehalfOf` claim that is not verified may only NARROW (C82): the decision is the stricter of the
//   evaluation with the claim and the evaluation without any claim-dependent rule; narrowing lists are merged.
// - Fleet facts (teams of the caller or of the claimed requester, trust of the claimed requester) come from the local
//   Fleet read model. When that copy is unavailable (never read, refused, too old) a DENY or HOLD rule that names Fleet
//   facts APPLIES (the criterion counts as met) and an ALLOW rule that names them does NOT apply: the gap can only make
//   a decision stricter (C230, G-3, fail closed).
import { normalizeTag, normalizeHandle as sharedNormalizeHandle, tagsMatch } from "@opt2-tealbrick/manifest";
import type { RulesSetInputRuleSpec } from "#kit";

export type RuleSpec = RulesSetInputRuleSpec;
export type Decision = RuleSpec["outcome"]["decision"];
export type Effect = "read" | "write" | "outward" | "destructive" | "money";

/** Effects Rules always gates and records, even when no rule names the call (brief C81: outward/destructive/money). */
export const GATED_EFFECTS: ReadonlySet<string> = new Set(["outward", "destructive", "money"]);
/** Strictness order: a later entry wins when two evaluations disagree. */
const SEVERITY: Record<Decision, number> = { allow: 0, hold: 1, deny: 2 };
export const NO_MATCH_REASON = "No rule matched; the default is allow.";

export interface Rule {
  id: string;
  rev: number;
  spec: RuleSpec;
  /** epoch ms */
  updatedAt: number;
}

/** Trust states of a contact (contract fleet.directory_feed/1). */
export const TRUSTS = ["unreviewed", "trusted", "limited", "blocked"] as const;
export type Trust = (typeof TRUSTS)[number];

export interface Claim {
  kind: "person" | "agent" | "channel_sender";
  id: string;
}

/** What Rules knows about one call at decision time. */
export interface CallFacts {
  caller: { type: string; id: string; mode: string | null };
  target: { product: string; op: string; effect: string };
  /** `tb.onBehalfOf` claim (bridge-copied, spec 0.1.13), or null */
  claim: Claim | null;
  claimVerified: boolean;
  /** team ids the claim resolves to (Fleet read model plus live Fleet context facts) */
  claimTeams: readonly string[];
  /** team ids of the CALLER agent (Fleet read model) */
  callerTeams: readonly string[];
  /** trust of the claimed requester (Fleet read model, contact found by contact id or canonical handle), or null if unknown */
  claimTrust: Trust | null;
  /** false = the Fleet read model cannot be relied on (never read, refused, too old): see the header */
  fleetAvailable: boolean;
}

export interface Narrowing {
  memoryTags?: { anyOf?: string[]; noneOf?: string[] };
}

export interface Verdict {
  decision: Decision;
  reason: string;
  rule: { id: string; rev: number; title: string } | null;
  /** only on allow */
  narrowing: Narrowing | null;
  /** true when the decisive rule matched through the onBehalfOf claim */
  viaClaim: boolean;
  /** true when the decisive deny/hold rule applied only because the Fleet facts it names were unavailable */
  closedOnFleet: boolean;
}

export interface Step {
  ruleId: string;
  title: string;
  matched: boolean;
  why: string;
}

const anyOf = (list: readonly string[] | undefined, value: string | null | undefined): boolean => !list || list.length === 0 || (value != null && list.includes(value));

/** Fleet facts a rule names: caller teams, claimed requester's teams or trust. */
export function dependsOnFleet(spec: RuleSpec): boolean {
  const m = spec.match;
  return (m.callerTeams?.length ?? 0) > 0 || (m.onBehalfOf?.teams?.length ?? 0) > 0 || (m.onBehalfOf?.trust?.length ?? 0) > 0;
}

export function dependsOnClaim(spec: RuleSpec): boolean {
  const o = spec.match.onBehalfOf;
  return !!o && ((o.teams?.length ?? 0) > 0 || (o.ids?.length ?? 0) > 0 || (o.kinds?.length ?? 0) > 0 || (o.trust?.length ?? 0) > 0);
}

export const NEEDS_FLEET = "needs Fleet facts, which are unavailable (allow rules do not apply without them)";

/**
 * Why `rule` does not match `facts` ("" = it matches), and whether it matches only because the Fleet facts it names are
 * unavailable (`closed`, deny and hold rules only). `useClaim = false` makes every claim criterion fail.
 */
export function judge(spec: RuleSpec, facts: CallFacts, useClaim = true): { why: string; closed: boolean } {
  const no = (why: string) => ({ why, closed: false });
  if (!spec.active) return no("inactive");
  const m = spec.match;
  if (!anyOf(m.agents, facts.caller.id)) return no("caller is not listed");
  if (!anyOf(m.modes, facts.caller.mode)) return no("caller mode differs");
  if (!anyOf(m.products, facts.target.product)) return no("target product differs");
  if (!anyOf(m.operations, facts.target.op)) return no("target operation differs");
  if (!anyOf(m.effects, facts.target.effect)) return no("effect differs");
  const strict = spec.outcome.decision !== "allow";
  let closed = false;
  // A Fleet criterion: met, not met, or (copy unavailable) met for a deny/hold rule and never met for an allow rule.
  const fleet = (met: boolean, why: string): string => {
    if (facts.fleetAvailable) return met ? "" : why;
    if (!strict) return NEEDS_FLEET;
    closed = true;
    return "";
  };
  if (m.callerTeams?.length) {
    const why = fleet(m.callerTeams.some((t) => facts.callerTeams.includes(t)), "caller is not in the teams");
    if (why) return no(why);
  }
  if (dependsOnClaim(spec)) {
    const obo = m.onBehalfOf as NonNullable<RuleSpec["match"]["onBehalfOf"]>;
    if (!useClaim) return no("needs an on-behalf-of claim (claims only narrow)");
    const c = facts.claim;
    if (!c) return no("no on-behalf-of claim");
    if (!anyOf(obo.kinds, c.kind)) return no("claim kind differs");
    if (obo.ids?.length && !obo.ids.includes(c.id) && !obo.ids.includes(handleOf(c.id) ?? "")) return no("claimed requester is not listed");
    if (obo.teams?.length) {
      const why = fleet(obo.teams.some((t) => facts.claimTeams.includes(t)), "claimed requester is not in the teams");
      if (why) return no(why);
    }
    if (obo.trust?.length) {
      const why = fleet(facts.claimTrust !== null && obo.trust.includes(facts.claimTrust), "claimed requester's trust is not listed");
      if (why) return no(why);
    }
  }
  return { why: "", closed };
}

export function mismatch(spec: RuleSpec, facts: CallFacts, useClaim = true): string {
  return judge(spec, facts, useClaim).why;
}

/** Evaluation order: priority ascending, then newest update, then id. */
export function order(rules: readonly Rule[]): Rule[] {
  return [...rules].sort((a, b) => a.spec.priority - b.spec.priority || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function firstMatch(ordered: readonly Rule[], facts: CallFacts, useClaim: boolean): { rule: Rule; closed: boolean } | null {
  for (const r of ordered) {
    const j = judge(r.spec, facts, useClaim);
    if (j.why === "") return { rule: r, closed: j.closed };
  }
  return null;
}

function verdictOf(hit: { rule: Rule; closed: boolean } | null): Verdict {
  if (!hit) return { decision: "allow", reason: NO_MATCH_REASON, rule: null, narrowing: null, viaClaim: false, closedOnFleet: false };
  const rule = hit.rule;
  const n = rule.spec.outcome.decision === "allow" ? normNarrowing(rule.spec.narrowing) : null;
  return {
    decision: rule.spec.outcome.decision,
    reason: rule.spec.outcome.reason,
    rule: { id: rule.id, rev: rule.rev, title: rule.spec.title },
    narrowing: n,
    viaClaim: dependsOnClaim(rule.spec),
    closedOnFleet: hit.closed,
  };
}

function normNarrowing(n: RuleSpec["narrowing"]): Narrowing | null {
  const t = n?.memoryTags;
  if (!t || (t.anyOf === undefined && !t.noneOf?.length)) return null;
  return { memoryTags: { ...(t.anyOf ? { anyOf: [...t.anyOf] } : {}), ...(t.noneOf?.length ? { noneOf: [...t.noneOf] } : {}) } };
}

/**
 * Both narrowings apply: anyOf lists intersect, noneOf lists unite (v1 capabilityNarrowing merge, tags only). Tags are
 * compared after the shared `normalizeTag` (SDK-API §18.1). Disjoint anyOf lists give `anyOf: []` = nothing passes (C115).
 */
export function mergeNarrowing(a: Narrowing | null, b: Narrowing | null): Narrowing | null {
  if (!a) return b;
  if (!b) return a;
  const x = a.memoryTags ?? {};
  const y = b.memoryTags ?? {};
  const norm = (list: readonly string[] | undefined) => (list ? [...new Set(list.map(normalizeTag))] : undefined);
  const xa = norm(x.anyOf);
  const ya = norm(y.anyOf);
  const any = xa && ya ? xa.filter((t) => ya.includes(t)) : (xa ?? ya);
  const none = [...new Set([...(norm(x.noneOf) ?? []), ...(norm(y.noneOf) ?? [])])];
  return { memoryTags: { ...(any ? { anyOf: any } : {}), ...(none.length ? { noneOf: none } : {}) } };
}

/** The decision for one call. `rules` must already be in evaluation order (see `order`). */
export function evaluate(ordered: readonly Rule[], facts: CallFacts): Verdict {
  const withClaim = verdictOf(firstMatch(ordered, facts, true));
  if (!facts.claim || facts.claimVerified || !withClaim.viaClaim) return withClaim;
  // Unverified claim: never wider than the decision without claim-dependent rules (C82).
  const base = verdictOf(firstMatch(ordered, facts, false));
  const strict = SEVERITY[withClaim.decision] >= SEVERITY[base.decision] ? withClaim : base;
  if (strict.decision !== "allow") return strict;
  return { ...strict, narrowing: mergeNarrowing(withClaim.narrowing, base.narrowing) };
}

/** Per-rule explanation for the dry run. */
export function explain(ordered: readonly Rule[], facts: CallFacts): Step[] {
  return ordered.map((r) => {
    const j = judge(r.spec, facts, true);
    return { ruleId: r.id, title: r.spec.title, matched: j.why === "", why: j.why || (j.closed ? "matches: Fleet facts are unavailable, so this rule applies (fail closed)" : "matches") };
  });
}

/** True when Rules must record this call's decision: a default-gated effect, or a rule decided it. */
export function recorded(facts: CallFacts, v: Verdict): boolean {
  return GATED_EFFECTS.has(facts.target.effect) || v.rule !== null;
}

/** Tags pass the narrowing: THE G5 comparison, the manifest package's `tagsMatch` (Knowledge uses the same function, L1). */
export function tagsPass(tags: readonly string[], n: Narrowing): boolean {
  return tagsMatch(n.memoryTags, tags);
}

const MAX_NODES = 20_000;
const MAX_DEPTH = 32;

/**
 * JSON pointers of every object in `output` that carries `tags: string[]` failing the narrowing (results carry tags[],
 * spec 0.1.13 G5). Throws on outputs too large or deep to scan, so the after hook fails and the output is withheld.
 */
export function redactionsFor(output: unknown, n: Narrowing): string[] {
  const out: string[] = [];
  let nodes = 0;
  const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");
  const walk = (v: unknown, ptr: string, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error("output too large to filter");
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        walk(x, `${ptr}/${i}`, depth + 1);
      });
      return;
    }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.tags) && o.tags.every((t) => typeof t === "string") && ptr !== "" && !tagsPass(o.tags as string[], n)) {
      out.push(ptr);
      return;
    }
    for (const [k, x] of Object.entries(o)) walk(x, `${ptr}/${esc(k)}`, depth + 1);
  };
  walk(output, "", 0);
  // Remove array items from the end first so earlier pointers stay valid if the consumer applies them in order.
  return out.reverse();
}

/**
 * The canonical handle of a claim id, or null (G-4: the ONE shared `normalizeHandle` of @opt2-tealbrick/manifest; null
 * means "no match", never the raw input).
 */
export function handleOf(id: string): string | null {
  return sharedNormalizeHandle(id);
}

/**
 * Fleet member key for a claim: `contact:<id>` (a person claim names a directory contact), `agent:<id>`,
 * `handle:<canonical handle>`. A channel sender whose id is not a valid handle has no key (null).
 */
export function claimKey(c: Claim): string | null {
  if (c.kind === "channel_sender") {
    const h = handleOf(c.id);
    return h ? `handle:${h}` : null;
  }
  return c.kind === "person" ? `contact:${c.id}` : `agent:${c.id}`;
}

/** Problems a JSON schema cannot express. "" = fine. */
export function specProblem(spec: RuleSpec): string {
  if (spec.narrowing && spec.outcome.decision !== "allow") return "narrowing applies only to rules that allow";
  const t = spec.narrowing?.memoryTags;
  if (t && !t.anyOf && !(t.noneOf?.length)) return "narrowing.memoryTags needs anyOf or noneOf";
  // Writer strict (L24, C115): an owner-written empty anyOf would hide every memory; name at least one tag.
  if (t?.anyOf && !t.anyOf.some((tag) => normalizeTag(tag))) return "narrowing.memoryTags.anyOf needs at least one tag";
  const m = spec.match;
  if (m.operations?.length && !m.products?.length) return "operations need products (an operation id is unique only within one app)";
  return "";
}
