# Phase 5 Publisher Contract

## Shared publisher interface

Core helper:
- `/home/htaf/pyash/program/publisher-interface.mjs`

Functions:
1. `resolvePublishCommand(env, order)`
- Resolves submit command from ordered env names.
- Returns `{ command, source_env }`.

2. `normalizePublishConfig({ env, adapter, fallbackCommand })`
- Produces normalized publish config:
  - `command`
  - `command_source_env`
  - `community_name`
  - `dry_run`
  - `command_env_order`

3. `applyPublishEnvNormalization({ env, adapter, fallbackCommand })`
- Applies normalized publish inputs at boundary:
  - sets `MEETING_POST_COMMAND` if resolved
  - sets `MEETING_PUBLISH_COMMUNITY_NAME` if missing
- Returns `{ env, publish }`.

## Adapter-provided publisher inputs

Each writer adapter provides `publish` block:
- `community_name`
- `command_env_order`

Grey:
- `['GREY_LEMMY_POST_COMMAND', 'MEETING_POST_COMMAND']`

Owen:
- `['OWEN_LEMMY_POST_COMMAND', 'MEETING_POST_COMMAND']`

## Compatibility and unchanged semantics
- Existing env names remain valid.
- Mapping is normalized immediately at adapter boundary.
- No changes to payload content generation.
- No changes to create/update/idempotency logic inside `publish-meeting-to-helpos-from-payload.mjs`.
- No changes to destination semantics beyond boundary normalization.

## Observability
- Grey `run.report.pya` now records publish status flags:
  - `publish_mode`
  - `publish_dry_run`
  - `publish_has_command`
- Top-level `publish` object is included with normalized values (non-secret fields only).
