# Phase 1 Scaffolding Note

## What was added

1. Shared artifact contract helper
- `program/shared/artifact-contracts.mjs`
- Provides additive helpers for:
  - artifact naming map (`buildGreyTranscriptArtifacts`)
  - JSON load/save wrappers
  - artifact existence/state metadata capture

2. Shared stage-runner scaffold
- `program/shared/stage-runner.mjs`
- Encapsulates stage execution metadata:
  - stage name
  - started/finished timestamps
  - duration
  - status (`ok`/`skipped`/`warn`/`error`)
  - input/output artifact registration
  - validation flags and optional notes/errors

3. Grey full pipeline wiring (additive)
- `program/run-full-transcript-pipeline.mjs`
- Uses shared artifact map for path construction.
- Uses stage-runner for stage records.
- Keeps existing legacy stage status array (`stages`) for compatibility.
- Adds standardized stage detail array (`stage_runs`) in report.
- Adds top-level report metadata fields:
  - `report_version`
  - `writer`
  - `source`
  - `meeting_id`
  - `run_id`
  - `validation_flags`

## Why this is intended no-behaviour-change

- Stage order and stage commands are unchanged.
- Prompt calls and prompt inputs are unchanged.
- Publish command and payload semantics are unchanged.
- Existing legacy report fields are preserved.
- New report fields are additive.
- Canonical run report artifact format is `.pya` (`*.full-pipeline.report.pya`).

## Phase 0 fixture check (compatibility)

Fixture tested:
- Grey frozen fixture: `2026-03-26_committee-of-the-whole_43ec8be4`

Validation outcome:
- Pipeline completed successfully.
- Existing artifacts remained present at expected paths.
- Legacy `stages` array still emitted.
- New `stage_runs` metadata emitted with per-stage I/O/timing/status.

Observed mismatch risk:
- None identified for output compatibility in this fixture run.

## Parity gaps still present (expected)

These are pre-existing and not changed in Phase 1:
- Owen pre-stage `augment-roster-from-agenda`.
- `agenda-summary.json` key mismatch across houses.
- Publish command env naming split (`GREY_*` vs `OWEN_*`).

## Top candidates for Phase 2 extraction

1. Wise chips stage
- `program/wise-chunk-grey-county-agenda-aware-from-transcript-folder.mjs`

2. Section summary stage
- command-level summarizer currently called by `agenda-section-summaries` stage.

3. Whole-meeting synthesis stage
- command-level summarizer currently called by `whole-meeting-summary` stage.

These three are the cleanest semantic units to extract after Phase 1 scaffolding.
