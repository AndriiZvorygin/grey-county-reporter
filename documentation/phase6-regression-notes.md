# Phase 6 Regression Notes

## Scope
- Unified operator surface added at `command/unified-writer-cli.mjs`.
- Grey and Owen `run-next-story.sh` now forward to unified CLI.
- Intended as interface-only/wrapper-only changes; no content or publish semantic redesign.

## Safe-path checks
- `node /home/htaf/pyash/command/unified-writer-cli.mjs list --writer grey`
- `node /home/htaf/pyash/command/unified-writer-cli.mjs next --writer grey --pick-only`
- `node /home/htaf/pyash/command/unified-writer-cli.mjs list --writer owen`
- `node /home/htaf/pyash/command/unified-writer-cli.mjs next --writer owen --pick-only`
- Legacy wrappers:
  - `./run-next-story.sh --list`
  - `./run-next-story.sh --pick-only`

## Observed parity
- Both writers are runnable from one command grammar.
- Listing and pick-only behavior execute through shared dispatcher.
- Meeting selection is normalized (`--meeting` by index/id/url/fragment).
- Publish intent flags are normalized (`--post`/`--no-post`/`--dry-run`) at operator boundary.

## Residual debt for Phase 7
- Discovery and normalization still assume eScribe-like source payloads in downstream runners.
- Stage names are unified at CLI level, but stage internals still vary by writer runner implementation.
- `inspect` is filesystem/report oriented; cross-source abstract inspection model is not yet formalized.
- Non-eScribe onboarding will still need discovery/normalization adapter expansion.
