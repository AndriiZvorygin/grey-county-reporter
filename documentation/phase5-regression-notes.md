# Phase 5 Regression Notes

## Checks run

### Grey
- Syntax checks passed for:
  - `program/run-next-unposted-story.mjs`
  - `program/run-full-transcript-pipeline.mjs`
  - `program/run-grey-county-meeting-from-ref.mjs`
  - `program/writer-adapter-grey-county.mjs`
  - `/home/htaf/pyash/program/publisher-interface.mjs`
- Runtime check:
  - `./run-next-story.sh --pick-only` passed.

### Owen
- Syntax checks passed for:
  - `program/run-next-unposted-story.mjs`
  - `program/run-full-transcript-pipeline.mjs`
  - `program/run-owen-sound-meeting-from-ref.mjs`
  - `program/writer-adapter-owen-sound.mjs`
  - `/home/htaf/pyash/program/publisher-interface.mjs`
- Runtime check:
  - `./run-next-story.sh --pick-only` passed.

## Semantic preservation statement
- Publisher command resolution is now adapter-driven through shared normalization.
- Existing writer-specific env names remain honored.
- Publish/create/update/idempotency behavior remains unchanged in publisher scripts.
- No payload semantic changes were introduced.

## Remaining Phase 6/7 blockers
- Owen full pipeline still emits JSON report; not yet aligned to Grey `.pya` report stack.
- CLI surfaces remain partially split (`GREY_*` and `OWEN_*` wrappers still exist).
- Non-eScribe sources still need adapter methods for discovery/normalization before shared pipeline reuse is turnkey.
