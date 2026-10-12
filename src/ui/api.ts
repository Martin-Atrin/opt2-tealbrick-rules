// Typed person-op calls (op ids and I/O types from the generated kit; type-only import, erased at build).
import { callOp } from "@opt2-tealbrick/miniapp-sdk/client";
import type { PersonOps } from "#kit";

export type In<K extends keyof PersonOps> = PersonOps[K]["input"];
export type Out<K extends keyof PersonOps> = PersonOps[K]["output"];
export type RuleRow = Out<"rules_list">["rules"][number];
export type RuleSpec = RuleRow["spec"];
export type DraftRow = Out<"drafts_list">["drafts"][number];
export type DecisionRow = Out<"decisions_list">["items"][number];
export type Team = Out<"fleet_status">["teams"][number];

export function run<K extends keyof PersonOps>(op: K, input: In<K>): Promise<Out<K>> {
  return callOp<Out<K>>(op, input as never);
}

export const EFFECTS = ["read", "write", "outward", "destructive", "money"] as const;
export const DECISION_TONE = { allow: "ok", deny: "blocked", hold: "action", narrow: "progress", redact: "progress" } as const;

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "something went wrong";
}
export function when(isoTime: string | null): string {
  return isoTime ? new Date(isoTime).toLocaleString() : "never";
}
/** "a, b ,c" → ["a","b","c"]; empty → undefined (= any). */
export function list(s: string): string[] | undefined {
  const xs = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return xs.length ? [...new Set(xs)] : undefined;
}
export const joinList = (xs: readonly string[] | undefined) => (xs ?? []).join(", ");

export function emptySpec(): RuleSpec {
  return { title: "", active: true, priority: 100, match: {}, outcome: { decision: "deny", reason: "" } };
}

/** One line that says what a rule matches, for lists. */
export function matchText(s: RuleSpec, teamName: (id: string) => string, agentName: (id: string) => string): string {
  const m = s.match;
  const parts: string[] = [];
  if (m.agents?.length) parts.push(`callers ${m.agents.map(agentName).join(", ")}`);
  if (m.modes?.length) parts.push(`${m.modes.join("/")} agents`);
  if (m.products?.length) parts.push(`apps ${m.products.join(", ")}`);
  if (m.operations?.length) parts.push(`operations ${m.operations.join(", ")}`);
  if (m.effects?.length) parts.push(`effects ${m.effects.join(", ")}`);
  const o = m.onBehalfOf;
  if (o?.teams?.length) parts.push(`on behalf of team ${o.teams.map(teamName).join(", ")}`);
  if (o?.ids?.length) parts.push(`on behalf of ${o.ids.join(", ")}`);
  if (o?.kinds?.length) parts.push(`requester kind ${o.kinds.join(", ")}`);
  return parts.length ? parts.join("; ") : "every call";
}
