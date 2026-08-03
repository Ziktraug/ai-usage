# P10 Skills management integration request

P10 does not edit coordinator-owned route or P5 shell files. At X0, fill P5's
unchanged `healthSlot(context)` with `SkillsHealthSlot` and
`matrixSlot(context)` with `SkillsMatrixSlot` from this directory. Keep the
exact `SkillsShellSlotContext`; do not introduce a second snapshot owner.

Both slot components publish successful mutation snapshots only with
`queryClient.setQueryData(skillsSnapshotKey(), snapshot)`. The P5 shell remains
the sole accepted-snapshot/draft-decision owner and therefore observes the
smallest-key update before replacing any dirty editor state. Keep the P9 editor
slot alongside these two P10 slots.

The route composition must choose deterministic demo/E2E data before mounting
live acquisition. P10's browser RPC client is lazy and is constructed only by
an explicit management action; it must never run during SSR or demo rendering.
The unmanaged backlog remains presentation-only: its review action navigates
to `/skills/matrix`; only the existing typed `skills.*` reconcile procedures
may mutate filesystem state, and their returned snapshot stays authoritative.
