# Phase 2 Extraction Note

## Scope completed
- Extracted agenda-wise chips into shared module:
  - `program/shared/agenda-wise-chunks.mjs`
  - Grey adapter: `program/wise-chunk-grey-county-agenda-aware-from-transcript-folder.mjs`
- Extracted section-summary generation into shared module + Grey wrapper:
  - `program/shared/agenda-section-summaries.mjs`
  - `program/summarize-agenda-wise-sections-from-transcript-folder.mjs`
- Extracted whole-meeting synthesis into shared module + Grey wrapper:
  - `program/shared/whole-meeting-synthesis.mjs`
  - `program/summarize-whole-meeting-from-agenda-summary.mjs`
- Rewired Grey pipeline callers to local wrappers (instead of `/home/htaf/pyash/command/*`):
  - `program/run-full-transcript-pipeline.mjs`
  - `program/run-shared-transcript-pipeline-from-folder.mjs`
  - `program/run-grey-county-meeting-from-ref.mjs`

## Intended behavior impact
- Intended as no-behavior-change for artifact names and output JSON/MD paths.
- Prompt text and publish semantics were not changed in this phase.

## Parity checks against frozen fixture
- Wise-chips stage executed successfully on frozen fixture (`2026-03-26 committee-of-the-whole`) and produced expected artifact shapes.
- Section summaries + whole-meeting synthesis parity execution was blocked by runtime backend availability:
  - `TypeError: fetch failed` calling Ollama from extracted shared modules.
- Because backend was unavailable, semantic parity for those two stages is **not fully verified** in this run.

## Shared vs Grey-specific boundaries
- Shared now contains stage logic for:
  - agenda-wise chunk generation
  - section-summary generation
  - whole-meeting synthesis
- Grey-specific remains in adapters/pipeline wiring for:
  - transcript-folder/prefix resolution
  - local file paths and stage invocation order
  - meeting identity/context wiring in Grey pipelines

## Remaining source coupling / blockers for Owen adoption
- Environment variable names still include legacy Owen/Grey aliases inside shared summarizers.
- Roster file discovery still assumes current house/artifact layout conventions.
- Validation and verifier behavior still depends on live Ollama availability for parity testing.

## Phase 2 next extraction candidates
1. Split roster/context resolution into a fully source-agnostic helper package.
2. Normalize prompt-contract builders so section and whole-meeting stages share one contract layer.
3. Move summary score/verification helpers to a shared verifier module used by both stages.

## Verification Addendum (2026-03-31)

Format correction:
- Canonical run report format is `.pya` (`*.full-pipeline.report.pya`).
- JSON run report is not part of the canonical artifact contract.

### Fixture and backend
- Fixture used: `grey-2026-03-26-cotw-43ec8be4`
- Transcript dir:
  `/home/htaf/pyash/world/house/grey-county-reporter/artifacts/grey-county/meetings/2026-03-26_committee-of-the-whole_43ec8be4/transcript`
- Live backend used: `OLLAMA_HOST=http://mriczo:11434`

### What was verified
- Section-summary stage completed successfully via extracted wrapper:
  - `program/summarize-agenda-wise-sections-from-transcript-folder.mjs`
- Whole-meeting synthesis stage completed successfully via extracted wrapper:
  - `program/summarize-whole-meeting-from-agenda-summary.mjs`
- Artifact presence confirmed:
  - `meeting-qwen-auto-normalized.agenda-summary.json`
  - `meeting-qwen-auto-normalized.agenda-summary.md`
  - `meeting-qwen-auto-normalized.meeting-summary.json`
  - `meeting-qwen-auto-normalized.meeting-summary.md`
- Shape compatibility confirmed against frozen Phase 0 snapshots:
  - agenda-summary keys exactly match `documentation/phase0/snapshots/grey-2026-03-26.agenda-summary.shape.json`
  - meeting-summary keys exactly match `documentation/phase0/snapshots/grey-2026-03-26.meeting-summary.shape.json`
- Required whole-meeting headings present:
  - `# Whole Meeting Summary`
  - `## Top Newsworthy Developments`
  - `## Why It Matters`
  - `## Watch Next`
- Truncation sanity:
  - no section summaries ending in `...` in the verified run.

### Semantic parity status
- There is no fully deterministic frozen semantic baseline artifact content in Phase 0 to diff against.
- To bound extraction risk, old command implementations were re-run and compared with extracted shared modules:
  - structural outputs remained compatible (same keys, same section counts, same required headings).
  - textual content drift occurred across runs, including score differences.
- Classification of that drift: **model variance / runtime stochasticity**, not extraction-logic drift.
  - Evidence: extracted shared modules are functionally equivalent to legacy command scripts except wrapper/entrypoint/path handling and logging/return plumbing.
  - Direct file diff confirms no prompt/semantic rule rewrites were introduced in extraction logic.

### What remains only structurally verified
- Bit-for-bit semantic equivalence for generated prose remains unprovable without deterministic model controls (seeded deterministic backend or frozen cached model responses).

### Verdict
- Phase 2 is verified as **contract-compatible and operationally complete** for Grey.
- Residual risk is limited to normal LLM output variability rather than shared-module extraction defects.
- Phase 3 can proceed safely, with focus on explicit verifier hardening (tense, required sections, truncation, identity scoping) as planned.

## Stage Rewrite Addendum (Strict 3-Stage Contract)

### New shared stage boundaries
- Stage 1 (gross semantic chunking): `program/library/reporter_shared/agenda-stage1-gross-chunking.mjs`
- Stage 2 (agenda reconciliation / grounding): `program/library/reporter_shared/agenda-stage2-grounding.mjs`
- Stage 3 (summary rendering): `program/library/reporter_shared/agenda-stage3-summary-renderer.mjs`
- Shared contract + validators: `program/library/reporter_shared/agenda-stage-contracts.mjs`

### Canonical artefacts (pya-first)
- `*.agenda.gross-chunks.pya` (Stage 1 output)
- `*.agenda.matches.pya` (Stage 2 output)
- `*.agenda-wise.series.pya` (Stage 2 output)
- `*.agenda.section-grounding.pya` (Stage 2 canonical truth)
- `*.agenda-summary.pya` (Stage 3 output)
- `*.agenda-summary.md` (Stage 3 output)

### Transitional compatibility shims (temporary)
- `*.agenda.matches.json` and `*.agenda-summary.json` are still written as thin shims for existing downstream readers.
- Internal producer flow is now `.pya` contract-first.

### Authoritative contract behavior
- Stage 1 validates gross chunk schema, ordering, and row coverage continuity.
- Stage 2 is the only grounding authority and emits `section-grounding.pya`.
- Stage 3 is pure rendering from `section-grounding.pya` and does not recompute grounding.

### What remains to remove
- Renderer and some checkpoint logic still read JSON shims; these should be switched to `.pya` consumers, then shim writes can be removed.
