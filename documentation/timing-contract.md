# Transcript Timing Contract (Regression Guard)

This note captures the non-negotiable timing rules for the Grey/Owen transcript flow.

## Scope Separation

- `normalize-transcript` is text-only.
- Normalization may fix words/names/acronyms/punctuation.
- Normalization must never invent or shift timestamps.

## Timing Source of Truth

- Timing comes from source audio via `<prefix>.timing.srt`.
- Build one canonical merged timeline first (de-overlap from chunked ASR output), then align sentence rows to that timeline.
- Post-merge logic must not "improve" sentence timestamps by re-scaling/compressing timeline.

## Canonical Transcript Assembly Order

The required order is:

1. Qwen single-pass outputs timing + raw chunk text
2. De-overlap merge into one canonical timed transcript stream
3. Build sentence-level timeline from the merged output
4. Paragraphize from sentence timing gaps (not from raw chunk boundaries)
5. Apply text normalization (words/names/acronyms/punctuation only; no timing edits)

Notes:

- The canonical text product is a grammatical plain transcript (`<prefix>.plain.txt`) derived from merged/sentence-aligned content.
- Paragraph boundaries are downstream presentation structure; sentence timing alignment is upstream truth.

Reference implementation paths:

- Shared alignment logic: `/home/htaf/pyash/command/lyrics_to_srt_from_timing.mjs`
- Grey/Owen sentence-builder wrapper: `program/sentence_srt_from_timing_srt.mjs`
- Pipeline wiring: `program/run-full-transcript-pipeline.mjs` (`merge-normalized-sentence-srt` stage)

## Sentence-Cue Rules

- In `--sentence-cues` mode, keep matched source-anchored times.
- Do not apply global timeline rescale in sentence mode.
- Do not force monotonic cursor shifts that rewrite matched source times.
- Duplicate-text collapse is presentation-only and must not alter timing truth.

## Hard Failure Rule

- If aligned sentence rows drift more than `1.5s` from matched source anchors, fail merge:
  - `lyrics to srt defective: timing drift ...`
- On failure, pipeline must stop before publish.

Environment override:

- `PYA_SRT_MAX_DRIFT_SECONDS` (default `1.5`)

## Operational Expectation

- A run is considered valid only if merge passes drift gate.
- If drift gate fails, fix merge/alignment code first; do not publish.
- If timing regresses in future, debug `timing.srt -> normalized.sentences.merged.srt` first, before diarization or HTML rendering.
