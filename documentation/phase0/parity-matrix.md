# Phase 0 Parity Matrix

## Fixture Pair
- Grey fixture: `grey-2026-03-26-cotw-43ec8be4`
- Owen fixture: `owen-2026-03-23-council-f3b0c55c`

## Stage Names and Order

| Order | Grey stage | Owen stage | Parity | Classification |
|---|---|---|---|---|
| 1 | `transcribe+merge` | `augment-roster-from-agenda` | mismatch | accidental drift |
| 2 | `normalize-transcript` | `transcribe+merge` | mismatch | accidental drift |
| 3 | `merge-normalized-sentence-srt` | `normalize-transcript` | mismatch | accidental drift |
| 4 | `diarize-speakers` | `merge-normalized-sentence-srt` | mismatch | accidental drift |
| 5 | `auto-assign-speakers-from-callouts` | `diarize-speakers` | mismatch | accidental drift |
| 6 | `relabel-speakers` | `auto-assign-speakers-from-callouts` | mismatch | accidental drift |
| 7 | `sync-speaker-artifacts-to-global-voices` | `relabel-speakers` | mismatch | accidental drift |
| 8 | `agenda-aware-wise-chunks` | `sync-speaker-artifacts-to-global-voices` | mismatch | accidental drift |
| 9 | `agenda-section-summaries` | `agenda-aware-wise-chunks` | mismatch | accidental drift |
| 10 | `whole-meeting-summary` | `agenda-section-summaries` | mismatch | accidental drift |
| 11 | `meeting-hook` | `whole-meeting-summary` | mismatch | accidental drift |
| 12 | `render-html` | `meeting-hook` | mismatch | accidental drift |
| 13 | `draw-meeting-image` | `render-html` | mismatch | accidental drift |
| 14 | `lemmy-payload` | `draw-meeting-image` | mismatch | accidental drift |
| 15 | (none) | `lemmy-payload` | extra in Owen sequence due to stage #1 offset | accidental drift |

Notes:
- Owen has one extra stage at the front: `augment-roster-from-agenda`.
- Core stage sequence otherwise semantically matches; index offset is not a real execution logic difference.

## Artifact Filenames

### Core output artifacts (both)
- `{norm}.plain.txt`
- `{norm}.normalize.metadata.json`
- `{norm}.sentences.merged.srt`
- `{norm}.sentences.speaker.sentences.json`
- `{norm}.sentences.speaker.sentence.srt`
- `{norm}.agenda-wise.series.pya`
- `{norm}.agenda.matches.json`
- `{norm}.agenda-summary.json`
- `{norm}.meeting-summary.md`
- `{norm}.meeting-hook.txt`
- `{norm}.lemmy-post.json`
- `{norm}.lemmy-post.md`
- `transcript-page.html`
- `meeting-cover.png`
- `{norm}.full-pipeline.report.json` (historical Phase 0 snapshot)

Correction for current contract:
- Canonical run report artifact is `{norm}.full-pipeline.report.pya`.

### House-specific or drift artifacts
- Owen-only: `{norm}.lemmy-post.update-*.json` (update workflow leftovers)
- Owen-only: `meeting-qwen-auto.wise.series.pya` (legacy/non-normalized wise output)
- Grey-only: `voices-working/` frequently present in fixture

Classification:
- Core artifacts: candidate for unification as contract baseline.
- Extra legacy/debug/update artifacts: accidental drift, not required by core semantics.

## JSON/Data Shapes

### `*.lemmy-post.json` keys
Exact key parity in both fixtures:
- `title`, `body_markdown`, `transcript_url`, `local_transcript_html`, `local_cover_image`, `jurisdiction`, `body`, `date_iso`, `hook`, `focus`, `source`, `discussion_url`, `generated_at_utc`.

### `*.meeting-summary.json` keys
Exact key parity in both fixtures:
- `focus`, `headings`, `markdown`, `score`, `source_agenda_summary`, `verifier_feedback`.

### `*.meeting-hook.json` keys
Exact key parity in both fixtures:
- `body`, `fallback_used`, `focus`, `hook`, `jurisdiction`, `model`, `score`, `source_meeting_summary`, `source_scope`, `verifier_feedback`.

### `*.agenda-summary.json` keys
- Grey: `body_label`, `focus`, `jurisdiction`, `roster_file`, `sections`, `source_series`
- Owen: `focus`, `roster_file`, `sections`, `source_series`

Classification:
- `agenda-summary.json` schema mismatch is accidental drift; either add `body_label/jurisdiction` everywhere or omit everywhere via contract versioning.

## Prompt Inputs/Outputs

### Shared prompt-flow shape
1. Agenda-wise chunks prompt input: transcript + agenda-aware ranges.
2. Section summary prompt input: wise chips + `focus` string.
3. Whole meeting summary prompt input: section summaries + `focus`.
4. Hook prompt input: meeting summary + `focus` + `jurisdiction` + `body`.

### Prompt parameter differences
- Grey focus default in fixture: neutral, source-faithful reporting of agenda topics, evidence, decisions, and next steps.
- Owen focus default in fixture: neutral, source-faithful reporting of consequential decisions, proposals, and public concerns.

Classification:
- This is a true writer-config difference (intended).

## Publish-related Fields and Semantics

Shared payload fields and canonical URL shape are aligned.

Embedded assumptions / drift:
- Grey submit command source: `GREY_LEMMY_POST_COMMAND` or `MEETING_POST_COMMAND`.
- Owen submit command source: `OWEN_LEMMY_POST_COMMAND`.
- Identity defaults are house-script-specific, not in core pipeline.

Classification:
- Command-env naming divergence is accidental drift and unification candidate.
- Identity/community values are true writer differences and should remain adapter config, not stage logic.

## Behavioural Mismatches and Identity Assumptions

### True source differences
- Grey adapter infers body label from meeting type (`Committee of the Whole`, etc.).
- Owen adapter includes roster augmentation stage from agenda extraction.
- Different roster file paths and source URLs.

### Accidental drift
- Stage list mismatch due to Owen pre-stage and naming divergence in helper programs.
- `agenda-summary.json` field set inconsistency.
- Publish command environment variable split (`GREY_*` vs `OWEN_*`).
- Wrapper capability divergence (`run-next-story.sh` in Grey has list/targeted-rerun controls; Owen wrapper still basic).

### Likely core-unification targets
1. Standard artifact schema for agenda summary + run reports.
2. Shared stage-runner metadata contract.
3. Shared env contract for submit command and publish metadata.
4. Shared wrapper feature set (`list`, `meeting selection`, force/skip stage controls) with writer config injection.

## Identity/Community Assumptions Embedded in Summarization Stages

Current finding:
- No direct Grey/Owen reporter identity assumptions inside the summary/hook generation stages themselves.
- Identity/community assumptions are concentrated in wrapper + publish command selection.

Risk points to track in Phase 1/2:
- Any future summarizer prompt should not include hardcoded community/account identity.
- Keep identity fields scoped to publish payload stage only.
