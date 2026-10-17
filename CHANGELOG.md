# Changelog

Versions follow `package.json` and `tealbrick.manifest.json` (product id `rules`).

## 0.3.0 - Unreleased

Governance feed contract, G-3 (decisions C230, C166, C236). Not tagged: the release order is Governance 0.2.0 on qa1, then Rules 0.3.0, then Governance 0.2.1. Rules 0.3.0 reads `directory_feed`, which Governance 0.2.0 adds; against Governance 0.1.x it finds no such op, so its Fleet facts are unavailable (see "Fail closed").

### Added
- Match criterion `callerTeams` (list of Governance team ids): the CALLING agent is a member of one of them.
- Match criterion `onBehalfOf.trust` (list of `unreviewed`, `trusted`, `limited`, `blocked`): the trust of the claimed requester, read from the feed by contact id (claim kind `person`), canonical handle (`channel_sender`) or agent id (`agent`). A requester the directory does not know (unknown handle or id, a contact or agent the producer left out) is `unreviewed`. An unverified claim may only narrow (C82): a deny or hold by trust applies, an allow by trust never beats a later deny.
- Both criteria are in every rule schema of the manifest (`rules_set`, `rule_draft_submit`, the drafts, preview), `rules_preview` (answers `callerTeams`, `trust`, `fleetAvailable`), the step explanations, `fleet_status` (`available`), the editor, the rule list and the Teams page.
- Operation `draft_status {draftId}` (agent audience; an app with a companion grant may call it): `{draftId, status, submittedAt, decidedAt, ruleCount}`. It answers only for drafts the caller itself submitted; any other id, and an id that does not exist, give the same `not_found` (404).
- `rule_draft_submit` records `source` on the draft: `{kind: "agent"}` or `{kind: "app", name, instance}`. The SDK 0.1.25 names an app caller by instance id and manifest name only (there is no `Caller.product`), so `product` is recorded only when verified, which is never today (SDK request filed). The Drafts page says "proposed by an app named <name> (unverified)".
- `rules_explain` adds `fleetUnavailable` per decision (true when a deny or hold rule applied only because the Fleet facts were unavailable).
- Contract files `test/contracts/fleet.directory_feed.1.schema.json` and `.json` (spec tag `spec-v0.1.42`, sha256 in `test/contracts/PROVENANCE.md`, same bytes as the Governance copy); the runtime schema `src/contracts/fleet.directory_feed.1.schema.json` is a second byte copy (the image has no `test/`). Tests run every fixture through the real reader.
- Migrations 0003 and 0004 (`migrations/0003_feed.sql`, `migrations/0004_feed_sets.sql`): table `fleet_trust` (with `gone`), `fleet_sync.usable`, `fleet_members.active`, `drafts.source`. They clear the 0.2.x Fleet copy (its `person:<id>` keys are gone) and forget the revision, so the first read after the update is a full one. Rules, drafts and decisions stay. There is no down migration; a failed update is rolled back by the SDK pre-update snapshot.

### Changed
- The companion is `fleet.directory_feed` (read), not `directory_get`. Every answer is validated against the vendored schema (`validateAgainstSchema` of `@opt2-tealbrick/manifest`) and every handle must satisfy `normalizeHandle(h) === h`. A mismatch is a refusal: the error shows in `fleet_status`, the copy is cleared, nothing of the answer is read. An `unchanged` answer is believed only for the `sinceRevision` that was sent. The 503 `feed_too_large` is transient (the last copy stays up to 10 minutes).
- Mapping: team keys `agent:<id>`, `contact:<id>` and `handle:<canonical>`, in TWO sets per team. Deny and hold rules see EVERY member (blocked, departed and removed ones too, and members the producer left out of `contacts`/`agents`); allow rules see only members that count (a paused agent counts). Keys are dropped per contact: an active contact keeps a handle it shares with a departed one. A blocked requester therefore never gains access from a team-scoped allow rule, and a team-scoped deny rule still reaches it (same effect as Governance's `resolve_sender` for allow). Live team facts (`fleet.requesterTeams`) obey the same rule: they never open an allow rule for a requester the copy knows to be gone. Trust keys are `contact:<id>`, every handle of the contact and `agent:<id>`; a gone (departed or removed) `trusted` entry becomes `unreviewed`; blocked, limited and unreviewed stay. When entries share a key the STRICTER trust wins (order blocked > limited > unreviewed > trusted). A team, contact or agent id listed twice is a `feed_invalid` refusal.
- Handles use the one shared `normalizeHandle` of `@opt2-tealbrick/manifest` 0.1.19 (G-4); a claim id that is not a valid handle has no handle (no match, never the raw text). The local normaliser is gone.
- UI and manifest text say "Governance" where they said "Organization Plane".
- Dependencies: manifest 0.1.19 (was 0.1.18); miniapp-sdk 0.1.25, conformance 0.1.18 and ui 0.2.4 unchanged. Lockfile integrity re-pinned.

### Fail closed (C230, C236)
- Before, an empty or old Fleet copy made team rules match nobody, so a deny or hold rule that names teams stopped applying. Now, while the Fleet facts are unavailable (never read, refused or invalid, or no successful read for 10 minutes), a deny or hold rule that names Fleet facts (`callerTeams`, `onBehalfOf.teams`, `onBehalfOf.trust`) applies, and an allow rule that names them does not. Other criteria still decide first, and `onBehalfOf` still needs a claim. The A2A-9 rule stays: stale membership is never used.
- An allow rule skipped for that reason still narrows: while the facts are unavailable the narrowing of every skipped allow rule that precedes the decisive rule is merged strictly into the verdict (so the call never gets a wider result than with the facts), emitted as `rules.narrowing` and recorded. The before phase pins the narrowing it decided per call id (read calls; at most 20 000, 92 s); `rules_filter` redacts by that pin. With no pin (restart, expiry, eviction) it applies the strictest narrowing that could apply.
- The decision trace of such a call carries `detail {fleetUnavailable: true}`; the dry run says so per rule. The Rules pages show "Governance data unavailable — team rules apply strictly".
- Operations note: an owner who has deny or hold rules on teams sees them apply to every matching call while Governance is down or older than 0.2.0. That is the intent.

### Sync
- The copy is written in transactions of at most 4 000 rows with a yield between them (measured for 200 teams x 350 members: longest transaction under 6 ms; the whole write about 0.2 to 0.4 s), the gate's index is built during the write, and a crash half way leaves the copy unusable (fail closed). `markFleetStale` during a read triggers one more full read.

### Not in this release
- Agent trust (`agents[].trust`) is not a match criterion.
