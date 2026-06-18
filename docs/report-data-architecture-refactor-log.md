# Report Data Architecture Refactor Log

## Goal

Move report data generation out of app adapters and into a shared reporting layer. Preserve existing behavior first, then split the global payload into finer server function/query boundaries.

## Working Rules

- Implement one small slice at a time.
- Run the narrowest meaningful checks before each commit.
- Document decisions, surprises, and follow-ups in this file before each commit.
- Keep app adapters thin: CLI renders terminal/static outputs; report app owns web server functions and UI.
- Do not remove the global payload until the interactive web flow has migrated to fine-grained queries.

## Slices

### Slice 0: Planning Baseline

Status: in progress

Changes:

- Added the implementation plan for the report data architecture refactor.
- Added this tracking log.

Decisions:

- First implementation milestone is compatibility-only: remove `apps/report -> apps/cli` while keeping the current global payload contract.
- Later milestones can introduce harness-level result envelopes and fine-grained server functions.

Difficulties:

- None yet.

Checks:

- Not run; documentation-only slice.

Commit:

- Pending.
