# Phase 2.5 Run Report Migration (.pya Canonical)

## Inventory: JSON run-report usage audited

1. `program/shared/artifact-contracts.mjs`
- Purpose: shared artifact path contract + artifact serialization helpers.
- Status: shared.
- Change: replaced canonical `full_pipeline_report_json` contract key with `full_pipeline_report_pya`; added `.pya` report serializer helper.

2. `program/run-full-transcript-pipeline.mjs`
- Purpose: Grey full pipeline execution + final run report emission.
- Status: writer-specific (Grey pipeline), uses shared stage-runner.
- Change: switched report emission from JSON helper to `.pya` helper; canonical output now `*.full-pipeline.report.pya`; legacy `*.full-pipeline.report.json` is removed if present.

3. `documentation/core-unification-plan.md`
- Purpose: architecture roadmap.
- Status: shared design doc.
- Change: canonical run report format corrected from `run.report.json` to `run.report.pya`.

4. `documentation/phase1/phase1-scaffolding-note.md`
- Purpose: Phase 1 implementation notes.
- Status: historical doc.
- Change: corrected canonical report statement to `.pya`.

5. `documentation/phase2-extraction-note.md`
- Purpose: Phase 2 extraction + verification notes.
- Status: historical doc.
- Change: added explicit format correction note that run reports are `.pya` canonical.

6. `documentation/phase0/parity-matrix.md`
- Purpose: Phase 0 baseline parity matrix.
- Status: historical baseline doc.
- Change: added correction note that current canonical run report is `.pya` (baseline row remains historical).

## Canonical format rule
- Universal artifact rule for run reports: `.pya`.
- Canonical run report artifact: `run.report.pya` conceptually, implemented in current Grey pipeline as `{norm}.full-pipeline.report.pya`.
- JSON run report is no longer canonical and is removed by pipeline emission logic.

## Verification (frozen Grey fixture)
- Fixture rerun:
  - `2026-03-26_committee-of-the-whole_43ec8be4`
  - command path: `program/run-full-transcript-pipeline-from-meeting-folder.mjs`
  - env: `OLLAMA_HOST=http://mriczo:11434 GREY_PIPELINE_SKIP_IMAGE=1 PIPELINE_SKIP_POST=1`
- Result:
  - pipeline completed successfully
  - `meeting-qwen-auto-normalized.full-pipeline.report.pya` emitted
  - `meeting-qwen-auto-normalized.full-pipeline.report.json` absent
  - stage metadata retained (`stage_runs`, timing/status, validation flags, notes/errors payload content preserved)
