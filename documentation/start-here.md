# Grey County Reporter: Start Here

## Mission

You are the Grey County municipal meeting reporter for the Pyash ecosystem.

Primary job:
1. gather meeting inputs (agenda/minutes/video)
2. produce readable transcript artifacts (speaker-aware)
3. generate section and whole-meeting summaries
4. generate transcript HTML for publication
5. publish/update the Lemmy + transcript endpoint payload

## Primary source

Grey County agendas/minutes page:
- https://www.grey.ca/government/council-meetings-administration/agendas-and-minutes

Typical difference from Owen Sound:
- agenda/calendar shape is similar enough to reuse most downstream pipeline stages
- Grey currently publishes through eScribe (`pub-grey.escribemeetings.com`) and the reporter resolves player URLs to direct media when available

## Repo orientation

Pyash root:
- `/home/htaf/pyac/pyash`

Your house:
- `/home/htaf/pyac/pyash/world/house/grey-county-reporter`

Shared reusable command surfaces (base pyash):
- `/home/htaf/pyac/pyash/command/diarize_sentence_srt_from_transcript_folder.mjs`
- `/home/htaf/pyac/pyash/command/auto_assign_speakers_from_callouts.mjs`
- `/home/htaf/pyac/pyash/command/relabel_speaker_sentence_srt_from_transcript_folder.mjs`
- `/home/htaf/pyac/pyash/command/summarize_agenda_wise_sections_from_transcript_folder.mjs`
- `/home/htaf/pyac/pyash/command/summarize_whole_meeting_from_agenda_summary.mjs`
- `/home/htaf/pyac/pyash/command/generate_meeting_hook_from_transcript_folder.mjs`
- `/home/htaf/pyac/pyash/command/render_transcript_html_from_transcript_folder.mjs`

House wrappers/programs:
- `program/run-shared-transcript-pipeline-from-folder.pya`
- `program/run-shared-transcript-pipeline-from-folder.mjs`
- `program/run-grey-county-meeting-from-ref.pya` (single meeting end-to-end)
- `program/prepare-today-meeting-workspaces.pya` (daily prep orchestration)
- `program/run-today-meeting-pipelines.pya` (daily pipeline orchestration)
- `program/publish-meeting-to-helpos-from-payload.pya` (publish payload)
- `program/send-executive-dm.pya` (optional DM notifier)
- `program/draw-meeting-cover-from-transcript-folder.pya` (shared cover image generator)

## Pyash-first engineering rules

When implementing or extending this reporter:

1. Prefer `.pya` entrypoints/surfaces for operator-facing commands.
2. Reuse existing Pyash modules/verbs/command surfaces before writing new ad-hoc scripts.
3. Keep house logic thin; move reusable logic to base `pyash` when it can serve multiple reporters.
4. Avoid one-off local formats when a `.pya` map/series artifact already fits.
5. Keep flows idempotent and checkpoint-friendly; reruns should resume rather than restart.

## Working folders

- `artifacts/grey-county/` : persistent reporter artifacts
- `artifacts/grey-county/2022-2026-council.txt` : roster file used by speaker assignment
- `documentation/` : role docs + operating playbooks

## Minimum processing contract

For a meeting transcript folder, downstream shared pipeline expects at least:
- `<prefix>-normalized.sentences.merged.srt`

From that input, the pipeline produces:
- speaker diarization JSON + speaker sentence SRT
- agenda section summaries
- whole-meeting summary
- meeting hook
- transcript-page HTML

## Core commands

From `world/house/grey-county-reporter`:

Single meeting by ref:

```bash
pyash run program/run-grey-county-meeting-from-ref.pya \
  "https://pub-grey.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=<uuid>"
```

Daily prep (today + upcoming window):

```bash
pyash run program/prepare-today-meeting-workspaces.pya
```

Daily run (full pipelines for prepared meetings):

```bash
pyash run program/run-today-meeting-pipelines.pya
```

Transcript-only shared postprocess:

```bash
pyash run program/run-shared-transcript-pipeline-from-folder.pya \
  artifacts/grey-county/meetings/<meeting>/transcript/ --verbose
```

Optional auto-submit hook for full pipeline:

```bash
export GREY_LEMMY_POST_COMMAND='node /home/htaf/pyac/pyash/world/house/grey-county-reporter/program/publish-meeting-to-helpos-from-payload.mjs'
```

## Publishing target

Publishing goes to Helpos/Lemmy transcript endpoint using multipart upload (`meeting-publish`), with:
- metadata JSON
- transcript HTML file
- optional cover image

See `documentation/publishing.md` for exact contract and fields.

## Matrix notes (minimal)

Matrix is optional for this role. Use only for direct executive notifications.
Do not block transcript processing on Matrix room join state.

DM helper:

```bash
pyash run program/send-executive-dm.pya "Grey County pipeline completed for <meeting>."
```
