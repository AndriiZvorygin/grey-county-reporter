# Phase 3 Verifiers

All verifier outputs are integrated into canonical run report `.pya` (`*.full-pipeline.report.pya`) under:
- top-level `validation_flags`
- top-level `verifier_results`
- stage-level `quality-verifiers` record in `stage_runs`

## Checks

1. `required_sections`
- Checks expected headings in `meeting-summary.md`:
  - `# Whole Meeting Summary`
  - `## Top Newsworthy Developments`
  - `## Why It Matters`
  - `## Watch Next`
- Checks `agenda-summary.json` has non-empty `sections` array.
- Behavior:
  - Missing headings/sections => `error`

2. `truncation`
- Checks for practical cut-off indicators:
  - trailing ellipsis in meeting summary lines
  - empty bullet shells (`-` or `*` with no content)
  - trailing ellipsis in agenda section summaries
- Behavior:
  - currently warning-oriented (`warn`) to avoid over-blocking

3. `tense`
- Heuristic tense consistency check based on configured mode (`AGENDA_SUMMARY_TIME_MODE`):
  - `upcoming`: warns on strong past-tense dominance
  - `standard`: warns on strong future-tense dominance
- Behavior:
  - warning-oriented (`warn`) unless later promoted

4. `identity_scoping`
- Detects cross-writer/jurisdiction bleed in meeting summary text:
  - Owen terms in Grey output
  - Grey terms in Owen output
  - jurisdiction/body label bleed indicators
- Behavior:
  - warning-oriented (`warn`)

## Blocking vs warning model
- `required_sections` may emit `error` and set `verifier_has_error=true`.
- `truncation`, `tense`, `identity_scoping` currently emit warnings only.
- No publish semantic changes are introduced in this phase.

## Known limits
- Tense and identity checks are heuristic text checks, not full semantic proofs.
- Some false positives are possible when a meeting references another jurisdiction by name.
- Truncation check detects practical cues but does not guarantee full completeness.
