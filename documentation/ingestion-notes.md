# Grey County Reporter: Ingestion Notes

## Source page

Primary meetings index:
- https://www.grey.ca/government/council-meetings-administration/agendas-and-minutes

## Expected intake artifacts per meeting

Store under:
- `artifacts/grey-county/meetings/<date>_<body>_<id>/`

Recommended subfolders:
- `raw/` : downloaded agenda/minutes/source html/json
- `converted/` : markdown/plain converted documents
- `transcript/` : audio, merged srt/plain, speaker outputs, summaries, html, publish payload

## Video

Grey County typically references YouTube for recordings.

Recommended persisted values in meeting metadata:
- `source_url` (official meeting page)
- `source_recording_url` (YouTube URL)
- `agenda` and `minutes` link arrays

## Roster

Roster file:
- `artifacts/grey-county/2022-2026-council.txt`

Update this continuously with councillors, staff presenters, deputants.
Speaker assignment quality depends on this file.

## Downstream handoff contract

Before running shared transcript pipeline, ensure transcript folder has:
- `<prefix>.timing.srt`
- `<prefix>.plain.txt`
- `<prefix>.merged.srt`
- `<prefix>-normalized.sentences.merged.srt`
- `<prefix>-normalized.agenda-wise.series.pya` (if agenda-aware summarization is expected)

Then run `run-shared-transcript-pipeline-from-folder`.

## eScribe subreport extraction surface

Reusable Pyash surface (base):

```bash
cd /home/htaf/pyac/pyash
./run program/extract-subreports-fromstate-wo-escribe.pya <agenda.md> <output_dir>
```

House-local wrapper:

```bash
cd /home/htaf/pyac/pyash/world/house/grey-county-reporter
pyash run program/extract-subreports-fromstate-wo-escribe.pya <agenda.md> <output_dir>
```

Full signature (recommended when agenda HTML and source URL are available):

```bash
pyash run program/extract-subreports-fromstate-wo-escribe-full.pya \
  <agenda.md> <output_dir> <output_index.json> <agenda.html> <source_meeting_url>
```

Notes:
- This extractor parses eScribe agenda HTML attachment groups and normalizes links to the correct host (for example `pub-grey.escribemeetings.com`).
- Prefer the full signature in automation so host detection is deterministic.
