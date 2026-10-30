# Phase 0 Prompt I/O Map

This records current prompt-bearing stages for frozen fixtures without changing behavior.

## Shared Prompt Stages (Grey + Owen)

1. `agenda-aware-wise-chunks`
- Input artifacts:
  - `{norm}.sentences.speaker.sentence.srt`
  - agenda docs (`source/agenda-*.pdf|html`, `converted/agenda-*.md`)
  - roster file
- Prompt inputs:
  - agenda item title/order
  - transcript paragraph stream
  - optional LLM range matching context (`*_AGENDA_USE_LLM_RANGE=1`)
- Outputs:
  - `{norm}.agenda-wise.series.pya`
  - `{norm}.agenda.matches.json`

2. `agenda-section-summaries`
- Input artifacts:
  - `{norm}.agenda-wise.series.pya`
  - `{norm}.agenda.matches.json`
  - `focus`
- Prompt inputs:
  - per section/chip text
  - writer focus string
- Outputs:
  - `{norm}.agenda-summary.json`
  - `{norm}.agenda-summary.md`

3. `whole-meeting-summary`
- Input artifacts:
  - `{norm}.agenda-summary.json`
  - `focus`
- Prompt inputs:
  - section summaries
  - focus lens
- Outputs:
  - `{norm}.meeting-summary.json`
  - `{norm}.meeting-summary.md`

4. `meeting-hook`
- Input artifacts:
  - `{norm}.meeting-summary.json`
  - `focus`, `jurisdiction`, `body`
- Prompt inputs:
  - whole summary + metadata
- Outputs:
  - `{norm}.meeting-hook.json`
  - `{norm}.meeting-hook.txt`

## Non-prompt stages using prompt outputs

5. `lemmy-payload`
- Consumes:
  - `{norm}.meeting-summary.md`
  - `{norm}.meeting-hook.txt`
  - meeting metadata (`meeting.json`)
- Produces:
  - `{norm}.lemmy-post.json`
  - `{norm}.lemmy-post.md`

## Identity/Community assumptions check

- Summarization stages above do **not** include publish identity values.
- Identity/community assumptions currently appear in wrapper + publish command selection env vars.
- This separation should be preserved in core extraction.
