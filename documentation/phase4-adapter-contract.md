# Phase 4 Adapter Contract

## Adapter interface (explicit)

A writer adapter is a small explicit object validated by `defineWriterAdapter(...)`.

Required fields:
- `writer_id`
- `source_id`
- `house_root`
- `artifacts_slug`
- `refresh_calendar_cmd`
- `run_meeting_from_ref_cmd`
- `send_dm_cmd`
- `identity`
- `defaults`

Identity block:
- `jurisdiction`
- `default_body`
- `community_name`

Defaults block:
- `base_prefix`
- `focus`
- `jurisdiction`
- `body`
- `site_url`
- `discussion_url`
- `exec_mxid`
- `community_name`
- `timezone`
- `transcript_jurisdiction_slug`

## Shared helper
- `program/shared/writer-adapter-interface.mjs`
- Provides:
  - `defineWriterAdapter(spec)`
  - `buildRunNextConfig(adapter, options)`

## Grey adapter
- `program/writer-adapter-grey-county.mjs`
- Grey wrappers now consume adapter defaults/config instead of re-embedding constants.

## Owen adapter model
- Mirrored in Owen house:
  - `program/shared-writer-adapter-interface.mjs`
  - `program/writer-adapter-owen-sound.mjs`
  - `program/run-next-unposted-story.mjs` uses adapter-config builder.

## Boundary goals achieved
- Writer/source identity and command wiring are explicit adapter concerns.
- Shared summarization + verifier logic remains source-agnostic.
- House wrappers are thinner and no longer rely on ad-hoc config blobs.

## Remaining architectural debt (for Phase 5)
- Owen full transcript pipeline is not yet using the same stage-runner/report stack as Grey.
- Publish command wiring still differs by house env naming.
- First non-eScribe source still needs discovery/normalization adapter methods beyond run-next config.
