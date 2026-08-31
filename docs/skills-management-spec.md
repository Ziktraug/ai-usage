# Skills management specification

## Status and scope

This document specifies the Skills management work delivered alongside, but independently from, the application-audit follow-ups recorded in `docs/app-audit-2026-07-10.md`. The requirements remain binding; the package-boundary paths below were updated on 2026-08-25 to the post-SvelteKit layout (plan 068). `docs/skills-management.md` is the living feature overview.

The feature provides a local control plane for inspecting, editing, enabling, and projecting agent skills. It does not derive inventory from portable or manually imported usage data and does not mutate native project skill directories or unmanaged runtime entries.

## Requirements

### Configuration and discovery

- Configure one source repository and optional explicit project paths through the existing user-local ai-usage config.
- Discover project roots only from explicit configuration or one focused query of locally observed project sources that pass project-marker and safety checks. The query must not construct a complete report payload or include imported machines.
- Keep source state as JSON in the source repository; do not load executable configuration.
- Bound filesystem traversal and text reads, and report diagnostics instead of failing the complete inventory.

### Inventory and diagnostics

- Scan source skills, configured runtime targets, and eligible project-local skill directories.
- Validate `SKILL.md` frontmatter, name consistency, reference readability, and configured token thresholds.
- Treat frontmatter fields documented by Claude Code, the Agent Skills specification, or Cursor (`disable-model-invocation`, `paths`) as known extensions; only undocumented keys raise `UnknownFrontmatterField`.
- Distinguish managed symlinks, missing projections, unmanaged files/directories, invalid skills, and warning-only skills.
- Keep project-local observations read-only.

### Mutations

- Allow source skills to be enabled or disabled through source-state JSON.
- Preview bulk reconciliation before applying it.
- Create configured target directories only after an explicit user action.
- Reconcile valid enabled skills as managed symlinks and unlink only managed projections for disabled skills.
- Revalidate the current enabled state while holding the source-state lock before applying a planned projection
  mutation; acquire that lock before the target projection lock.
- Refuse to overwrite copied directories, unmanaged files, changed observations, or paths that escape configured roots.
- Serialize source-state and Markdown writes across processes and publish them atomically.

### Skill observations

The inventory answers *what exists*. Skill observations add invocation evidence
and availability signals, which turn the inventory into a decision without
pretending that being offered to a model means being used. The model is
specified by [ADR 0022](adr/0022-skill-observation-tiers-and-observability.md);
the requirements below are what the surface must honour.

- Every rendered count carries its **observation tier** and the harness that
  produced it. `declared` means the harness recorded the invocation as a skill
  call; `inferred` means it was reconstructed from a weaker trace; `exposed`
  means the skill was offered to the model with no evidence it was used. A
  number that adds two tiers together is a defect, and the wire shape has no
  field to put one in.
- **Per-harness observability is part of the presented model.** A harness with
  no collector renders as *not observable*, never as `0`. "Observed nothing" and
  "cannot observe" are different sentences and the surface says both.
- **Counts are per skill *name*, and the surface says so.** A harness records the
  name it was asked for and only sometimes a resolved directory — OpenCode
  normally discloses one in `state.metadata.dir`, while Claude Code does so for
  about 70% of invocations — so
  one set of counts covers every installation sharing a name. Each per-skill
  detail states this beside the numbers, with the resolved-path list underneath
  corroborating it whenever a name really did resolve to several directories.
  Where a project-local install shares its name with a managed skill, the
  managed-or-unmanaged verdict and the deletion candidacy belong to the *other*
  installation: the surface names the collision and withholds them rather than
  attributing them to what is selected. A project-only name keeps its adoption
  verdict, because not being in the managed repository is a fact about the name.
  Attributing counts per installation is a separate piece of work and would need
  an explicit unattributable bucket.
- **Observations that resolve to no inventory entry are retained and grouped.**
  Harness-bundled and plugin-provided skills are exactly that population, and
  they carry the *observed but unmanaged* (adoption candidate) verdict.
- **An unmanaged name also carries its residence**, decided at the join from
  data the read already has: `runtime-installed` when the name has an unmanaged
  entry in a runtime skills directory (the adoptable backlog),
  `project-owned` when a resolved directory sits inside a known project
  (deliberately scoped), `external` otherwise (harness-bundled,
  plugin-provided, or gone). Residence segments and words the adoption
  presentation — three populations, three treatments — and never alters the
  verdict, which stays a fact about the name.
- **Presentation reads in evidence order and folds the catalogue.** The
  overview table carries managed names and names with invocation evidence,
  strongest tier first and most recent signal first — never alphabetically,
  which buried the strongest invocation evidence among catalogue entries. Names seen only at the
  `exposed` tier are folded into one expandable row per catalogue (plugin
  prefix, or a standalone group), because every entry of one catalogue carries
  the same single fact. A harness that cannot observe is named once per
  surface, in the coverage roster, rather than once per row.
- The deletion verdict requires more than managed-ness: a skill earns it only
  when it is **projected to every enabled runtime** and complete invocation
  history contains no recorded invocation.
  A skill that is not actually installed everywhere has a mundane reason to be
  unused, and proposing its deletion on that evidence would be wrong. Such a
  skill stays in the table rather than disappearing from it.
- **Being offered is not being used.** The adoption verdict requires `declared`
  or `inferred` evidence. A skill seen only at the `exposed` tier was listed in
  a catalogue the harness injects wholesale; it is reported under its own
  heading, because it is a fact about offering rather than about use.
- **A bounded or partially unreadable read cannot prove absence — but only the
  right kind of bound.** Every absence verdict here is a claim about `declared`
  and `inferred` evidence, so it is the *invocation* bound that qualifies it, not
  the pooled one. A read that carried every recorded invocation and stopped short
  of the exposure catalogue has proved exactly what those verdicts assert, and
  says so; that is the ordinary state of a store with real Codex history, and
  hedging it would attach a caveat that could never come off. When the invocation
  read does trip its own budget, or rows fail re-validation, every verdict that
  rests on absence is marked provisional and says what it actually knows ("no
  invocation in loaded history"), and both the deletion group and the
  per-skill deletion sentence carry the same qualification — the deletion
  proposal most of all, since it is the one verdict acted on destructively.
  Verdicts that rest on presence are unaffected: an invocation seen is an
  invocation that happened.
- **A bound is scoped to the harness that lost the evidence; a cross-harness
  claim is not.** Each rendered count belongs to one harness, so it is qualified
  by that harness's own collection answer: a Codex rejection makes Codex's counts
  floors and leaves Claude Code's exact, and "no signal recorded for Claude Code"
  stays an exact statement while "no signal in loaded history for Codex" sits
  beside it. The deletion, never-observed and offered-only verdicts keep reading
  the global bound, because each claims a skill was invoked in *no* observable
  harness and one harness's short evidence makes that unprovable. A loss that
  cannot name a harness — a read that stopped at its bound, a re-validation
  refusal, a producer answer reporting a loss without saying whose — hedges every
  harness (ADR 0022).
- Producer-side truncations and rejections follow the same rule. Each observable
  harness persists invocation and exposure completeness with the batch, even
  when that batch contains zero observations. The global proof always requires
  Claude, Codex, and OpenCode: disabling one marks it incomplete rather than
  removing it from the roster. Each answer must also be no more than five
  minutes old. Missing, stale, disabled, malformed, rejected, truncated, or
  bounded-away producer state keeps every absence-derived verdict provisional;
  exposure-only rejection or truncation still weakens exposure counts without
  weakening invocation evidence (ADR 0037). A producer answer names the harness
  it failed for, so its rejection or truncation qualifies that harness's own
  counts rather than every harness's; missing producer state names no one and
  therefore marks every expected producer. The surface describes this as a
  complete recent collection not yet being available, never as a zero. The
  server carries the proof's absolute expiry through the inventory join; stale
  or in-flight retained browser data is qualified as provisional even while
  TanStack keeps displaying its last successful payload.
- Invocation observations are durable. The 400-day age window and rescan cutoff
  apply only to the high-volume `exposed` catalogue stream; `declared` and
  `inferred` history remains available for absence-derived decisions (ADR 0037).
- Provenance is per metric — per *harness* as well as per section. There is no
  page-level data-quality banner, and no response-wide hedge on a number that
  belongs to a harness whose collection was complete; a failed observation read
  reports itself in the observation section alone.
- Tier and observability are conveyed textually. Colour may reinforce them and
  may never be their only carrier.
- Wiring an "adopt into the source repository" action for an unmanaged observed
  skill is **out of scope here** and remains the adoption workflow's.

#### Per-harness coverage

| Harness | Tiers produced | What is recoverable | Why |
| --- | --- | --- | --- |
| Claude Code | `declared` | name, timestamp, cwd, session, success, and a resolved base directory for most invocations | a first-class `Skill` tool call in the transcript |
| OpenCode | `declared` | name, status, session, timestamp, and the resolved directory when `state.metadata.dir` is present | a `skill` tool part in its database; missing metadata remains an explicit unresolved state |
| Codex | `exposed`, `inferred` | the skill catalogue injected into every system prompt, plus `exec` commands that read a `SKILL.md` | Codex has no skill tool; the two streams come from two separate extractors and are never combined |
| Cursor | none — **not observable** | nothing | its state database contains zero `skill` tool keys and its tracking database has no relevant table |

**Cursor is unobservable, and that is a finding rather than a gap.** This product
projects skills into `~/.cursor/skills`, so Cursor genuinely exposes them — it
simply records nothing about their use. Rendering `0` for Cursor would assert
that its projected skills go unused, which no data supports. It therefore renders
as *not observable* and is never included in a denominator that would make the
other harnesses look complete.

Skill arguments are never persisted. They are user prose and have been measured
to contain client names and business context; only their presence is recorded.

### Web experience

- Expose Skills as a first-class web route with global and project scopes, a runtime matrix, diagnostics, configuration, and reconciliation controls.
- Open each managed global `SKILL.md` as a directly editable source document without a preview-first mode or Edit button.
- Keep Save explicit through the document toolbar and `Ctrl+S` / `Cmd+S`. Saving updates the source repository only; installing or repairing runtime projections remains a separate action in the Inspector.
- Surface unchanged, saved (this session), unsaved, saving, validation-error, and changed-on-disk states while preserving the exact local draft after revision conflicts or other save failures.
- Preserve dirty Markdown drafts across selection, refresh, and disk-reload operations. If a new snapshot removes the edited skill, require explicit discard before replacing the snapshot.
- Give the editor priority in the responsive layout: tree, document, then Inspector on wide screens; tree and document with the Inspector stacked after it at intermediate widths; compact picker, document, then Inspector on narrow screens.
- Keep project-owned `SKILL.md` documents read-only until a separate adoption workflow creates a canonical source document.
- Keep snapshot replacement, notices, dependent inventory refresh, and editor refresh behind one route-controller workflow.
- Provide deterministic desktop and narrow-viewport browser coverage for immediate editing, pointer and keyboard Save, source/runtime separation, conflict and discard protection, Inspector action ownership, configuration, filtering, reconciliation, project inventory, and unmanaged entries.

## Package boundaries

- `@ai-usage/skills` owns contracts, validation, bounded filesystem operations, scans, projections, Markdown IO, and workflows. It is a filesystem-projection domain and must never gain a `@ai-usage/usage-store` dependency.
- `apps/web/src/server/skills*` owns server-side validation and adaptation behind the oRPC contract, and is the only place the inventory meets skill observations — through the read-only `UsageReadModel` seam (ADR 0009).
- `apps/web/src/server/skill-observation-join.ts` owns the inventory↔observation join: managed-ness, projection completeness, and every verdict are decided on the server and travel as facts. Browser presentation consumes those verdicts without independently resolving inventory against observations.
- `@ai-usage/report-core/skill-observation-evidence` owns tier capability and the pure policy that turns producer, read, refusal, and clamp loss into claim readiness. `@ai-usage/report-core/skill-observation-summary` owns the pure fold from observations into the presented dataset; `@ai-usage/report-data/skill-observation-read` owns the one bounded read that every consumer shares.
- `apps/web/src/lib/features/skills/presentation.ts` owns the one immutable presentation projection shared by workspace, global, health, Project, and observation renderers.
- `apps/web/src/lib/features/skills/shell` owns snapshot replacement policy (see its `INTEGRATION.md`); its shell-lived management-operation episode owns one Query mutation lifecycle from contract dispatch through publication, invalidation, pending state, reconcile plan, and outcome presentation.
- `apps/web/src/routes/skills/` composes route presentation and URL-backed selection; `apps/web/src/lib/features/skills/{editor,management}` own the editor and management surfaces.
- Browser-safe clients must use the documented `@ai-usage/skills/config` and `@ai-usage/skills/shared` exports and must not import server modules.

## Verification contract

- `bun x ultracite check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run test:tools`
- `bun run build`
- `bun run test:web-production`
- `bun run test:setup-loopback`
- `bun run test:e2e`, including `apps/web/e2e/skills.spec.ts`

The filesystem tests must use temporary directories and cover traversal limits, unsafe symlinks, concurrent writers, atomic replacement, stale observations, and unmanaged mutation refusal.
