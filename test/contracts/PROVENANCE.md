# Provenance of the contract files in this folder

These files are byte copies. Do not edit them. To update, copy the files from a newer spec tag and change this header in
the same commit. `test/feed.test.ts` fails when a file no longer matches the sha256 below.

- Source repo: `Tealbrick/opt2-tealbrick-specs` (private)
- Tag: `spec-v0.1.42` (annotated tag object `0e1b92c2c962b728588e1aeccd1bd721cfe7e726`, commit `e2e05cdf9eb49bdaf726b6180779964d3cb3e506`)
- Contract: `fleet.directory_feed/1` (producer: Governance, product id `fleet`, op `directory_feed`; consumer: this app, Rules & Approvals). Decision C230.
- Copied from the vendored copy in `opt2-tealbrick-fleet/test/contracts/` (same bytes, same sha256).

| File here | Path in the source repo (at the tag) | sha256 |
|---|---|---|
| `fleet.directory_feed.1.schema.json` | `packages/spec/schemas/contracts/fleet.directory_feed.1.schema.json` | `18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724` |
| `fleet.directory_feed.1.json` | `packages/spec/examples/contracts/fleet.directory_feed.1.json` | `339d4b8c9377b0c035fd8937518565aac368bc4a3e8a3bb468559aedc7b4db71` |
| `../../src/contracts/fleet.directory_feed.1.schema.json` (runtime copy: the image has no `test/`) | same as the schema above | `18d49f48f1196af77223acb38ea9b95f5786c587019b4688cd9417f5708df724` |

How this app uses them: `src/fleet.ts` validates EVERY `directory_feed` answer against the schema with the JSON Schema 2020-12
validator that `@opt2-tealbrick/manifest` exports (`validateAgainstSchema`, ajv 8, formats as annotations) and applies the
extra reader rule `normalizeHandle(h) === h` for every handle. A mismatch is a refusal (the error is recorded, the copy is
cleared, nothing of the answer is read). The fixtures `valid`, `invalid` and `invalidByNormalizeHandle` run through the same
reader in `test/feed.test.ts`.
