# Phase 0 Blockers and Next Targets

## Blockers
- None for Phase 1 scaffolding in this repo.

## Drift Found (from parity matrix)
1. Owen-only pre-stage `augment-roster-from-agenda`.
2. `agenda-summary.json` key mismatch (`body_label`,`jurisdiction` only in Grey fixture).
3. Publish command env split (`GREY_LEMMY_POST_COMMAND` vs `OWEN_LEMMY_POST_COMMAND`).
4. Wrapper feature divergence (`run-next-story.sh` capabilities).

## Recommended Next Extraction Targets (Phase 1/2)
1. Shared stage report contract and writer/source metadata envelope.
2. Shared artifact schema helpers for:
   - agenda summary
   - meeting summary
   - hook
   - payload
3. Stage-runner helper with standard status model (`ok`, `skipped`, `warn`, `error`) and explicit I/O artifacts per stage.
4. Unified publish command env contract (without changing publish semantics yet).
