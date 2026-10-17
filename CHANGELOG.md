# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `rules`).

## 0.3.0 - Unreleased

Governance feed contract, G-3 (decisions C230, C166, C236). Not tagged: the release order is Governance 0.2.0 on qa1, then Rules 0.3.0, then Governance 0.2.1. Rules 0.3.0 reads `directory_feed`, which Governance 0.2.0 adds; against Governance 0.1.x it finds no such op, so its Fleet facts are unavailable (see "Fail closed").

### Added
- Match criterion `callerTeams` (list of Governance team ids): the CALLING agent is a member of one of them.
- Match criterion `onBehalfOf.trust` (list of `unreviewed`, `trusted`, `limited`, `blocked`): the trust of the claimed requester, read from the feed contact found by contact id (claim kind `person`) or canonical handle (claim kind `channel_sender`). A requester the directory does not know has no trust, so a trust list does not match it. An unverified claim may only narrow (C82): a deny or hold by trust applies, an allow by trust never beats a later deny.
- Both criteria are in every rule schema of the manifest (`rules_set`, `rule_draft_submit`, the drafts, preview), `rules_preview` (answers `callerTeams`, `trust`, `fleetAvailable`), the step explanations, `fleet_status` (`available`), the editor, the rule list and the Teams page.
- Operation `draft_status {draftId}` (agent audience; an app with a companion grant may call it): `{draftId, status, submittedAt, decidedAt, ruleCount}`. It answers only for drafts the caller itself submitted; any other id, and an id that does not exist, give the same `not_found` (404).
- `rule_draft_submit` records `source` on the draft: `{kind: "agent"}` or `{kind: "app", product?, name, instance}`. The SDK 0.1.25 names an app caller by instance id and manifest name only (the product id is not on the context), so `product` comes from a small table of Tealbrick app names and is left out for an unknown app. The Drafts page says "proposed by <app>".
- `rules_explain` adds `fleetUnavailable` per decision (true when a deny or hold rule applied only because the Fleet facts were unavailable).
- Contract files `test/contracts/fleet.directory_feed.1.schema.json` and `.json` (spec tag `spec-v0.1.42`, sha256 in `test/contracts/PROVENANCE.md`, same bytes as the Governance copy); the runtime schema `src/contracts/fleet.directory_feed.1.schema.json` is a second byte copy (the image has no `test/`). Tests run every fixture through the real reader.
- Migration 0003 (`migrations/0003_feed.sql`): table `fleet_trust`, `fleet_sync.usable`, `drafts.source`. It clears the 0.2.x Fleet copy (its `person:<id>` keys are gone) and forgets the revision, so the first read after the update is a full one. Rules, drafts and decisions stay. There is no down migration; a failed update is rolled back by the SDK pre-update snapshot.

### Changed
- The companion is `fleet.directory_feed` (read), not `directory_get`. Every answer is validated against the vendored schema (`validateAgainstSchema` of `@opt2-tealbrick/manifest`) and every handle must satisfy `normalizeHandle(h) === h`. A mismatch is a refusal: the error shows in `fleet_status`, the copy is cleared, nothing of the answer is read. An `unchanged` answer is believed only for the `sinceRevision` that was sent. The 503 `feed_too_large` is transient (the last copy stays up to 10 minutes).
- Mapping: team keys `agent:<id>`, `contact:<id>` and `handle:<canonical>`. A departed contact, a blocked contact and a removed agent carry no team (a blocked requester never gains access from a team-scoped allow rule; same as Governance's `resolve_sender`); a paused agent keeps its teams. Trust keys are `contact:<id>` and every handle of the contact; a departed contact keeps its trust unless it is `trusted`; when two contacts share a handle the stricter trust wins.
- Handles use the one shared `normalizeHandle` of `@opt2-tealbrick/manifest` 0.1.19 (G-4); a claim id that is not a valid handle has no handle (no match, never the raw text). The local normaliser is gone.
- UI and manifest text say "Governance" where they said "Organization Plane".
- Dependencies: manifest 0.1.19 (was 0.1.18); miniapp-sdk 0.1.25, conformance 0.1.18 and ui 0.2.4 unchanged. Lockfile integrity re-pinned.

### Fail closed (C230, C236)
- Before, an empty or old Fleet copy made team rules match nobody, so a deny or hold rule that names teams stopped applying. Now, while the Fleet facts are unavailable (never read, refused or invalid, or no successful read for 10 minutes), a deny or hold rule that names Fleet facts (`callerTeams`, `onBehalfOf.teams`, `onBehalfOf.trust`) applies, and an allow rule that names them does not. Other criteria still decide first, and `onBehalfOf` still needs a claim. The A2A-9 rule stays: stale membership is never used.
- The decision trace of such a call carries `detail {fleetUnavailable: true}`; the dry run says so per rule. The Rules pages show "Governance data unavailable — team rules apply strictly".
- Operations note: an owner who has deny or hold rules on teams sees them apply to every matching call while Governance is down or older than 0.2.0. That is the intent.

### Not in this release
- Agent trust (`agents[].trust`) is not a match criterion.
