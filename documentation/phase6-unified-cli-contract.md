# Phase 6 Unified Operator CLI Contract

## Canonical entry
- `node /home/htaf/pyash/command/unified-writer-cli.mjs <command> --writer <grey|owen> [flags]`

## Commands
- `list`: list local meeting workspaces and stage.
- `next` / `pick-next`: run next-candidate flow (`--pick-only` supported).
- `run`: run a specific meeting (`--meeting` required).
- `rerun-stage`: rerun stage for a specific meeting (`--meeting`, `--stage` required).
- `verify`: verification-oriented rerun path for a meeting.
- `publish`: publish-oriented rerun path for a meeting.
- `inspect`: print selected meeting dirs/report artifacts.

## Common flags
- `--writer <grey|owen>` required.
- `--meeting <selector>` supports index, 8-char id, full id/url, or folder fragment.
- `--refresh` forces calendar refresh.
- `--pick-only` performs candidate selection only.
- `--force <stage>` repeatable (`prep|full|image`).
- `--skip <stage>` repeatable (`prep|full|image`).
- `--stage <name>` for `rerun-stage` (`prep|full|image|verify|publish`).
- `--post`, `--no-post`, `--dry-run` normalize publish intent.

## Compatibility wrappers
- `world/house/grey-county-reporter/run-next-story.sh`
- `world/house/owen-sound-reporter/run-next-story.sh`

Both wrappers are thin shims into the unified CLI (`next --writer <id>`), preserving existing operator entry points while moving command semantics into one shared dispatcher.

## Intentionally unchanged
- Summarization/content semantics.
- Adapter identity/destination semantics.
- Publisher create/update/idempotency semantics.
- Existing house runner internals (`run-*-meeting-from-ref.mjs`) remain the execution engine.
