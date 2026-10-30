# Grey County Reporter Flows

## Read this first

- `documentation/start-here.md` : role, repo orientation, end-to-end goals
- `documentation/ingestion-notes.md` : calendar/video/agenda intake contract
- `documentation/publishing.md` : Helpos/Lemmy publishing contract

## Scope

The Grey County reporter reuses shared base `pyash` commands for most post-transcription stages.

Current split:
- Shared/base (`/home/htaf/pyac/pyash/command`): diarize, auto-assign, relabel, section summaries, whole-meeting summary, hook, transcript HTML render.
- House-specific (`world/house/grey-county-reporter/program`): orchestration, Grey roster defaults, Grey source links.

## Daily orchestration

Prepare workspaces for today + upcoming window (`GREY_TODAY_LOOKAHEAD_DAYS`, default `1`):

```bash
pyash run program/prepare-today-meeting-workspaces.pya
```

Run full pipelines for prepared meetings:

```bash
pyash run program/run-today-meeting-pipelines.pya
```

Behavior:
1. refresh monthly calendar cache
2. select meetings in today/upcoming window
3. prepare workspace (agenda/minutes/subreports/audio)
4. run full transcript pipeline
5. write summaries:
   - `artifacts/grey-county/meetings/<day>.today.json`
   - `artifacts/grey-county/meetings/<day>.run-summary.json`

Checkpoint notes:
- prep reruns skip already prepared meetings unless forced (`GREY_PREP_FORCE=1`)
- run reruns skip meetings with payload already present unless forced (`GREY_TODAY_FORCE=1`)

## One-command postprocess flow

Input requirement:
- transcript folder already exists and contains `<prefix>-normalized.sentences.merged.srt`

Run:

```bash
pyash run program/run-shared-transcript-pipeline-from-folder.pya \
  artifacts/grey-county/meetings/<meeting>/transcript/ --verbose
```

What it does:
1. speaker diarization
2. auto-assignment from callouts + agenda context
3. relabel speaker sentence SRT
4. agenda section summaries (if agenda-wise series exists)
5. whole-meeting summary (if agenda summary exists)
6. hook generation (if whole summary exists)
7. transcript HTML render

## Single meeting flow

Run one meeting by meeting URL/UUID/prefix:

```bash
pyash run program/run-grey-county-meeting-from-ref.pya \
  "https://pub-grey.escribemeetings.com/MeetingsCalendarView.aspx/Meeting?Id=<uuid>"
```

What it does:
1. refresh monthly cache
2. resolve meeting + resolve eScribe video player URL(s) to direct media when available
3. write meeting metadata (`meeting.json`, `video-resolution.json`)
4. prepare workspace and download artifacts
5. run full transcript pipeline and payload generation

## Notes for Grey County

- Calendar source:
  - https://www.grey.ca/government/council-meetings-administration/agendas-and-minutes
- Video source currently resolves through eScribe (`pub-grey.escribemeetings.com`) with direct-media fallback.
- Keep `artifacts/grey-county/2022-2026-council.txt` updated; speaker assignment quality depends heavily on roster quality.

## Optional submit hook

Payload generation always runs. To auto-submit after payload creation, set:

```bash
export GREY_LEMMY_POST_COMMAND='node /home/htaf/pyac/pyash/world/house/grey-county-reporter/program/publish-meeting-to-helpos-from-payload.mjs'
```

Alternative shared var is also accepted:

```bash
export MEETING_POST_COMMAND='node /home/htaf/pyac/pyash/world/house/grey-county-reporter/program/publish-meeting-to-helpos-from-payload.mjs'
```

## Matrix (minimal)

Matrix is optional for this role and should not block transcript/publishing work.
Use direct executive DM helper when needed:

```bash
pyash run program/send-executive-dm.pya "Grey County pipeline update."
```
