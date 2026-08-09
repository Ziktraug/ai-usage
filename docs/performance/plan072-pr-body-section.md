## Plan 072 — Deferred Session optimizations

The second review recalculated all three decisions from corrected evidence.

- **A — rejected at STOP A1.** The corrected fixtures contain 5,000
  sessions / 4,999 campaigns and 20,000 sessions / 19,996 campaigns. Full
  date-desc traversals cover 25 and 100 pages with no missing or duplicate
  identity. Projection slicing represents 0.0298% and 0.0147% of residual
  SQLite work and grows only 2.10x for a 4x fixture increase, so a public
  keyset cursor remains unjustified.
- **B — rejected and removed.** After restoring the global Ark Popover and
  Tooltip and limiting the no-Ark trial to the local column disclosure, the
  same-machine seven-sample comparison reduces initial gzip by only 7,311 B,
  below the required 10 KiB. Drawer-open median regresses from 97.021 ms to
  122.689 ms (+26.46%), above the 10% ceiling. Cumulative gzip through Drawer
  grows by 1.739% and Ark/Zag duplication stays zero, but every gate is
  mandatory; granular exports and the local disclosure are therefore absent
  from the final source.
- **C — no new optimization retained.** The existing direct-destination
  prefetch remains the sole TanStack Query owner. The no-prefetch trial did not
  produce a stable 10% first-usable improvement and introduced a Session RPC
  before first scroll.

The corrected artifacts include explicit disjoint initial/lazy chunk sets,
Overview, Sessions, Breakdown, and Sessions-after-Drawer closures, all raw B
samples, and SHA-256 values. The final 5,000-session proof traverses all 4,999
top-level campaigns in 25 pages, expands the fixture child, and therefore
proves all 5,000 session identities with no missing or duplicate identity. Its
reviewed median desktop traversal is 3,823.692 ms. The whitespace repair is now
committed on the branch, the auditable matrix is green, and Plan 072 is DONE.
