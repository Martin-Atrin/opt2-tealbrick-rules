# opt2-tealbrick-rules

Teal Brick opt2: **Rules & Approvals** (product id `rules`), the per-workspace policy: it gates other apps' calls with allow, deny or hold, always with a recorded reason.

**Status: opt2 build (clean-room v2 of Teal Brick), work in progress.** This repository is part of the opt2 build and lives under `Martin-Atrin` during the build; it moves to the Teal Brick organisation as one clean commit when opt2 is released. It is not the current production system.

Owner lane: Lead · Rules.

## No secrets policy

This repository is public. It must never contain secrets or personal data:

- No API keys, tokens, passwords, private keys, deployment secrets, `.env` files or connection strings. Use `.env.example` with placeholder values only.
- Runtime secrets live in the deployment platform (Railway variables) and are copied between services without printing them.
- No personal names, private agent configurations or customer data.
- Every push runs a secret scan (Woodpecker `secret-scan` step, gitleaks). GitHub secret scanning with push protection is enabled. Optional local guard: `pre-commit install`.
- If a secret is committed anyway: rotate it first, then remove it from history.

## App

A Teal Brick opt2 miniapp (product id `rules`), built on `@opt2-tealbrick/miniapp-sdk`.

`tealbrick.manifest.json` is the only description of the app. The SDK derives the routes, input and output
validation, OpenAPI, receipts, holds, idempotency, scopes, backups and status from it. You write handlers by
operation id (`src/app.ts`) and plain migrations (`migrations/`).

## What Rules does

- **Gate (`rules_gate`, before hook, every product):** the first active rule that matches the call decides (lower
  priority first): allow, refuse or hold, always with the rule's reason. No matching rule = allow (C84). Answers from
  local cached tables only (no app call, no model call), with an own budget of 250 ms (hook limit 1 s); any error or
  overrun refuses (fail closed). Outward, destructive and money calls, and every call a rule decided, are recorded as
  decision traces keyed by the bridge `callId` (join with the target app's receipts).
- **Hold:** needs spec 0.1.13 (before-hook hold verdict, family `policy`). Feature check on the spec vocabulary; until
  then a hold rule refuses with its reason.
- **Context (`rules_context`):** `rules.narrowing` v1 `{v, ruleId, reason, memoryTags {anyOf, noneOf}}` (Knowledge
  reads it), `rules.matched`, `rules.onBehalfOf`.
- **After (`rules_filter`, reads):** redacts result objects whose `tags[]` fail the narrowing.
- **On behalf of:** the bridge copies the runner's claim into `tb.onBehalfOf` (unverified). Rules resolves it to Fleet
  teams; a claim can only make a decision stricter, never wider (C82).
- **Fleet read model (C81 G2):** Fleet `directory_get` through the companion grant, outside calls: every 60 s once the
  SDK offers background companion calls (C85, feature check), and from owner pages when older than 60 s. No Fleet =
  no teams.
- **English rules (C84):** the owner's own agent translates and calls `rule_draft_submit` (a draft only); the owner
  approves it on the Drafts page. Rules never calls a model.

## Layout

| Path | Content |
|---|---|
| `tealbrick.manifest.json` | the only description: ops (person: rules, drafts, decisions, preview, teams; agent: `rules_explain`, `rule_draft_submit`), hooks, Fleet companion |
| `src/engine.ts` | pure rule engine: match, first match, narrow-only claims, narrowing merge, redaction pointers |
| `src/hooks.ts` | the three hook handlers (fail closed) |
| `src/store.ts` | tables: rules + revisions, drafts, decision traces, Fleet copy (cached for the gate) |
| `src/fleet.ts` | Fleet read model sync |
| `src/app.ts` | `defineApp`: one typed handler per operation, hooks, events, `onStart` |
| `src/ui/` | owner UI in `<AppShell>`: Rules (editor + dry run), Drafts, Decisions, Teams, Holds, Agents |
| `migrations/0001_init.sql` | baseline; forward-only, never edit a released file |
| `skills/use-rules/SKILL.md` | the agent skill: refusals, explain, drafting rules from English |
| `scripts/build-ui.ts` | UI build without a bundler (tsc output + vendored modules + import map) |
| `gen/` (not committed) | `tb-gen` output; `node --run kit` generates the kit and compiles it to `dist/kit` (`#kit` import) |
| `Dockerfile` | the one opt2 app Dockerfile pattern |
| `.woodpecker/ci.yaml` | the opt2 CI template, byte-identical copy (do not edit) |
| `tealbrick-ci.json` | CI settings: kind `miniapp`, one image |

## Develop

```sh
pnpm install          # commit pnpm-lock.yaml: CI installs with --frozen-lockfile
# typecheck, test, conformance, build and start first run `tb-gen kit` (op ids + I/O types from the manifest)
pnpm typecheck && pnpm lint && pnpm test
pnpm build            # server to dist/, UI to dist/ui
pnpm conformance      # SDK conformance suite against this app
TB_STANDALONE=1 TB_DATA_DIR=.data pnpm start   # app-alone mode: person UI only, no agent calls
```

## Environment

The SDK reads only `TB_*` variables (SDK-API §13). The deploy recipe sets them: `TB_INSTANCE_ID`,
`TB_ENROL_CODE`, `TB_BRIDGE_URL`, `TB_PORTAL_KEYS`, `TB_KEK`, `TB_DATA_DIR` (the `data` volume mount, `/data`)
and `TB_BACKUP_DIR` (`/data/backup`: one volume per service). Optional: `TB_LOG_LEVEL`, `TB_RESTORE_FROM`,
`TB_STANDALONE`. The listen port is the manifest `runtime.port`.

## Release

1. Set the same version in `package.json` and `tealbrick.manifest.json`.
2. Tag `v<semver>` (for example `v0.1.0`) and push the tag.
3. CI builds and publishes the image, then writes the signed release record from the manifest.

Before the first push, check `publisher` and `source.repo` in the manifest. The repository name must match the
image name in `tealbrick-ci.json` (`opt2-tealbrick-rules`).

## Dependency pins and caching
- `pnpm-lock.yaml` carries the sha512 integrity of every GitHub-release tarball (CI rule ci-v8). After changing an `@opt2-tealbrick/*` dependency run `pnpm install`, then `node <opt2-tealbrick-platform>/ci/tb-ci.ts pin-tarballs .`, then `pnpm install --frozen-lockfile`, and commit the lockfile. Image builds run `pnpm install --frozen-lockfile --ignore-scripts`.
- `pnpm build` writes the UI to `dist/ui/index.html` + `dist/ui/assets-<content hash>/`; the SDK serves index.html `no-cache` and the hashed directory immutable, so a deploy is visible at once (C61).
