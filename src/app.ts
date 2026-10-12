// App definition (SDK-API §3). The manifest is the only source: the SDK derives routes, input/output validation,
// OpenAPI, receipts, holds, idempotency, backups and status from it. This file registers exactly one handler per
// manifest operation id and one handler per manifest hook id. Op ids and I/O types come from the generated kit (`#kit`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type AppDefinition, defineApp, type HandlerSpec, type OpContext, type SdkAppDefinition, TbError } from "@opt2-tealbrick/miniapp-sdk";
import {
  type DecisionsListInput,
  type DecisionsListOutput,
  type DraftDecideInput,
  type DraftDecideOutput,
  type DraftsListInput,
  type DraftsListOutput,
  type FleetStatusInput,
  type FleetStatusOutput,
  OP,
  type OpId,
  type RuleDraftSubmitInput,
  type RuleDraftSubmitOutput,
  type RulesDeleteInput,
  type RulesDeleteOutput,
  type RulesExplainInput,
  type RulesExplainOutput,
  type RulesGetInput,
  type RulesGetOutput,
  type RulesListInput,
  type RulesListOutput,
  type RulesPreviewInput,
  type RulesPreviewOutput,
  type RulesSetInput,
  type RulesSetOutput,
} from "#kit";
import { type CallFacts, claimKey, evaluate, explain, order, type Rule, specProblem } from "./engine.ts";
import { type CallApp, refreshIfStale, startFleetTimer, syncFleet } from "./fleet.ts";
import { gateAnswer, HOLD_SUPPORTED, makeHooks } from "./hooks.ts";
import {
  decideDraft,
  deleteRule,
  fleetIndex,
  fleetState,
  fleetTeams,
  getRule,
  listDecisions,
  listDrafts,
  listRules,
  liveRules,
  markFleetStale,
  pendingDraftCount,
  saveRule,
  submitDraft,
} from "./store.ts";

export const manifest = JSON.parse(readFileSync(new URL("../tealbrick.manifest.json", import.meta.url), "utf8")) as AppDefinition["manifest"];
export const migrationsDir = fileURLToPath(new URL("../migrations", import.meta.url));

/** Typed handler. The SDK validates `input` against the manifest schema before `run` and the output after it. */
function op<I, O>(spec: HandlerSpec<I, O>): HandlerSpec {
  return spec as unknown as HandlerSpec;
}

function person(ctx: OpContext): string {
  if (ctx.caller.type !== "person") throw new TbError("forbidden", "only the owner may do this", 403);
  return ctx.caller.id;
}

/** Companion read through the op's own context (person ops); outside handlers once C85 lands (see onStart). */
const opCallApp =
  (ctx: OpContext): CallApp =>
  (product, opId, input) =>
    ctx.callApp(product, opId, input) as ReturnType<CallApp>;

async function freshFleet(ctx: OpContext, force = false): Promise<void> {
  if (force) markFleetStale(ctx.db);
  try {
    await refreshIfStale(ctx.db, opCallApp(ctx));
  } catch (e) {
    ctx.log.warn("fleet refresh failed", { error: e instanceof Error ? e.message : "unknown" });
  }
}

export const handlers = {
  [OP.rulesList]: op<RulesListInput, RulesListOutput>({
    async run(input, ctx) {
      person(ctx);
      return { rules: listRules(ctx.db, input.includeDeleted ?? false), holdSupported: HOLD_SUPPORTED, defaultDecision: "allow" };
    },
  }),
  [OP.rulesGet]: op<RulesGetInput, RulesGetOutput>({
    async run(input, ctx) {
      person(ctx);
      return getRule(ctx.db, input.id);
    },
  }),
  [OP.rulesSet]: op<RulesSetInput, RulesSetOutput>({
    async run(input, ctx) {
      const actor = person(ctx);
      return { rule: saveRule(ctx.db, { id: input.id, expectedRev: input.expectedRev, spec: input.rule, actor }) };
    },
  }),
  [OP.rulesDelete]: op<RulesDeleteInput, RulesDeleteOutput>({
    async run(input, ctx) {
      return deleteRule(ctx.db, { id: input.id, expectedRev: input.expectedRev, actor: person(ctx) });
    },
  }),
  [OP.rulesPreview]: op<RulesPreviewInput, RulesPreviewOutput>({
    async run(input, ctx) {
      person(ctx);
      await freshFleet(ctx);
      if (input.candidate) {
        const p = specProblem(input.candidate);
        if (p) throw new TbError("input_invalid", p, 400);
      }
      const rules: Rule[] = order([...liveRules(ctx.db), ...(input.candidate ? [{ id: "candidate", rev: 0, spec: input.candidate, updatedAt: Date.now() }] : [])]);
      const claim = input.call.onBehalfOf ?? null;
      const facts: CallFacts = {
        caller: { type: input.call.caller.type, id: input.call.caller.id, mode: input.call.caller.mode ?? null },
        target: { ...input.call.target },
        claim,
        claimVerified: false,
        claimTeams: claim ? (fleetIndex(ctx.db).get(claimKey(claim)) ?? []) : [],
      };
      const v = evaluate(rules, facts);
      return {
        decision: v.decision,
        answered: gateAnswer(v).answered,
        reason: v.reason,
        ruleId: v.rule?.id ?? null,
        ruleTitle: v.rule?.title ?? null,
        narrowing: v.narrowing,
        teams: [...facts.claimTeams],
        steps: explain(rules, facts),
      };
    },
  }),
  [OP.decisionsList]: op<DecisionsListInput, DecisionsListOutput>({
    async run(input, ctx) {
      person(ctx);
      return listDecisions(ctx.db, { ...input, limit: input.limit ?? 50 }) as DecisionsListOutput;
    },
  }),
  [OP.draftsList]: op<DraftsListInput, DraftsListOutput>({
    async run(input, ctx) {
      person(ctx);
      return { drafts: listDrafts(ctx.db, input.status, input.limit ?? 50) };
    },
  }),
  [OP.draftDecide]: op<DraftDecideInput, DraftDecideOutput>({
    async run(input, ctx) {
      const draft = decideDraft(ctx.db, { id: input.id, decision: input.decision, actor: person(ctx) });
      ctx.statusChanged();
      return { draft };
    },
  }),
  [OP.fleetStatus]: op<FleetStatusInput, FleetStatusOutput>({
    async run(input, ctx) {
      person(ctx);
      await freshFleet(ctx, input.refresh === true);
      const st = fleetState(ctx.db);
      const teams = fleetTeams(ctx.db);
      return {
        source: st.revision != null || teams.length > 0 ? "fleet" : "none",
        revision: st.revision,
        syncedAt: st.syncedAt == null ? null : new Date(st.syncedAt).toISOString(),
        error: st.error,
        teams,
      };
    },
  }),
  [OP.rulesExplain]: op<RulesExplainInput, RulesExplainOutput>({
    // An agent sees only its own calls' decisions (caller id is bound by the grant, never by input).
    async run(input, ctx) {
      const { items } = listDecisions(ctx.db, { caller: ctx.caller.id, callId: input.callId, limit: input.limit ?? 10 });
      return {
        decisions: items.map((d) => ({
          callId: d.callId,
          at: d.at,
          product: d.target.product,
          op: d.target.op,
          decision: d.decision,
          answered: d.answered,
          reason: d.reason,
          ruleId: d.ruleId,
          ruleTitle: d.ruleTitle,
        })),
      };
    },
  }),
  [OP.ruleDraftSubmit]: op<RuleDraftSubmitInput, RuleDraftSubmitOutput>({
    // Creates a DRAFT only; the owner approves it in the UI (C84). Rules itself never calls a model.
    redact: (input) => `rule draft (${input.rules.length} rule${input.rules.length === 1 ? "" : "s"}): ${input.text.slice(0, 200)}`,
    async run(input, ctx) {
      const d = submitDraft(ctx.db, { text: input.text, note: input.note, rules: input.rules, by: { type: ctx.caller.type, id: ctx.caller.id, name: ctx.caller.name } });
      ctx.receipt.meta({ draftId: d.id });
      ctx.statusChanged();
      return { draftId: d.id, status: "pending" as const };
    },
  }),
} satisfies Record<OpId, HandlerSpec>;

export const hooks = makeHooks(manifest.id);

export const definition: SdkAppDefinition = {
  manifest,
  handlers,
  hooks,
  migrations: migrationsDir,
  events: {
    // A changed agent list may change Fleet's teams: mark the copy stale and refresh now (app-initiated call, C85).
    async agentsChanged(_agents, ctx) {
      markFleetStale(ctx.db);
      void syncFleet(ctx.db, ctx.callApp as CallApp);
    },
  },
  // Pending English drafts count toward the app's pendingHolds (TBD badge, C86).
  async pendingCount(db) {
    return pendingDraftCount(db);
  },
  // Fleet read model: refresh now and every 60 s with an app-initiated companion call (C85), never inside a hook.
  async onStart(ctx) {
    startFleetTimer(ctx.db, ctx.callApp as CallApp);
  },
};

export const app = defineApp(definition);
