# Phase 4 Parity and Regression Notes

## Regression checks run

### Grey
- Syntax checks:
  - `program/shared/writer-adapter-interface.mjs`
  - `program/writer-adapter-grey-county.mjs`
  - `program/run-next-unposted-story.mjs`
  - `program/run-grey-county-meeting-from-ref.mjs`
  - `program/run-full-transcript-pipeline.mjs`
- Runtime check:
  - `./run-next-story.sh --pick-only`
  - Result: success, candidate picked and `next-story.pick.json` written.

### Owen
- Syntax checks:
  - `program/shared-writer-adapter-interface.mjs`
  - `program/writer-adapter-owen-sound.mjs`
  - `program/run-next-unposted-story.mjs`
- Runtime check:
  - `./run-next-story.sh --pick-only`
  - Result: success, candidate picked and `next-story.pick.json` written.

## Stage flow / artifact compatibility
- Grey stage flow remains unchanged (adapter wiring only in wrapper/default identity references).
- Grey artifact compatibility preserved, including Phase 2.5 `.pya` run report and Phase 3 verifier integration.
- Owen `run-next` orchestration config now comes from explicit adapter contract; no publish semantic change.

## Identity scoping
- Grey run report still records Grey writer/source identity via adapter (`writer_id`, `source_id`).
- Owen run-next now binds writer identity via adapter defaults and explicit contract fields.
- No cross-writer contamination observed in pick-only checks.

## True adapter concerns vs architectural debt

Adapter concerns now isolated:
- writer identity/defaults
- house artifact slug/path roots
- source discovery commands
- per-writer run-next config shaping

Remaining architectural debt (not hidden):
- Owen full transcript pipeline has not yet been migrated to the same stage-runner/report stack used by Grey.
- Publish wiring env names remain house-specific (`GREY_*` vs `OWEN_*`).
- Adapter contract currently covers run-next and wrapper identity/config; discovery/normalization for first non-eScribe source still needs one more contract pass.

## Phase 5 readiness recommendation
- Ready to begin Phase 5 publisher interface extraction.
- Recommended first Phase 5 step: unify publish command/env mapping through adapter contract while preserving current semantics.
