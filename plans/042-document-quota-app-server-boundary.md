# Plan 042: Document the quota app-server boundary

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat 96b3dff..HEAD -- README.md CONTEXT.md apps/cli/README.md apps/cli/src/main.ts apps/cli/src/quota.ts apps/cli/src/main.integration.test.ts packages/report-data/README.md packages/report-data/src/one-shot-sources.ts packages/report-data/src/provider-quota.ts`
> If an in-scope file changed, compare the current-state excerpts below with the
> live documentation. Any semantic mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `96b3dff`, 2026-07-26

## Why this matters

The CLI documentation says `quota` reads the newest local snapshot and the
domain context says CLI output never calls provider APIs. The command actually
runs a one-shot quota source that may launch `codex app-server`, which owns
provider communication and authentication refresh. The implementation keeps a
good credential boundary, but users need to know when a command is not a
purely local history read.

## Current state

- `README.md:5` accurately describes the optional served Codex usage-limit
  source as the narrow `codex app-server` exception.
- `README.md:58-62` describes `bun run cli -- quota` only as reading the newest
  local rate-limit snapshot.
- `CONTEXT.md:3` says the CLI produces quota output without calling provider
  APIs; `CONTEXT.md` later defines local history as provider-free.
- `apps/cli/src/main.ts:88-94` calls `runOneShotQuotaAndReadLatest`.
- `packages/report-data/src/one-shot-sources.ts:245-258` executes the
  `codex.usage-limits` source before reading durable quota.
- `packages/report-data/src/provider-quota.ts:133-138` defaults the live source
  to Codex app-server.
- `apps/cli/src/main.integration.test.ts:254-300` fixes the unavailable-refresh
  fallback when durable data exists: `quota` exits 0, renders the stored
  observation without stderr noise, and records a degraded `cli.quota`
  boundary.
- `apps/cli/src/main.integration.test.ts:302-333` fixes the no-data fallback:
  `quota` still exits 0, renders
  `No stored Codex usage-limit observation is available.`, keeps stderr empty,
  and records a failed boundary with a provider warning.
- `apps/cli/src/main.integration.test.ts:227-251` fixes the distinct paused
  policy contract: the command exits 1 and reports that collection is paused
  without invoking the provider.
- `packages/report-data/README.md` already names explicit timer-free CLI
  workflows and the provider-quota owner; preserve that ownership vocabulary.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Residue check | `grep -En "quota output without calling provider APIs|quota \\(5h / 7d windows\\) from the newest local" README.md CONTEXT.md` | exit 1, no matches |
| Contract tests | `bun test apps/cli/src/main.integration.test.ts` | exit 0 |
| Format check | `bun run check` | exit 0 |
| Docs links/residue | `bun run lint` | exit 0 |
| Diff safety | `git diff --check` | exit 0, no output |

## Scope

**In scope**:

- `README.md`
- `CONTEXT.md`
- `apps/cli/README.md`
- `packages/report-data/README.md`

**Out of scope**:

- source behavior, CLI flags, output shape, or source policy;
- direct provider HTTP calls or credential handling;
- changing `quota` into a cached-only command;
- broad architecture-document rewrites.

## Git workflow

- Branch: `docs/042-quota-app-server-boundary`
- Use one documentation commit, for example
  `Document the quota app-server boundary`.
- Do not push or open a pull request unless explicitly requested.

## Steps

### Step 1: Correct the user-facing quota command description

Update the quota section in `README.md` to say that the command first requests a
fresh Codex usage-limit observation through the installed
`codex app-server`, then reads the newest durable local observation. State
clearly:

- `ai-usage` does not read Codex credentials;
- app-server owns provider communication/authentication refresh;
- if refresh fails and a durable observation exists, the command renders that
  observation successfully and the diagnostic boundary is degraded;
- if refresh fails without durable data, the command exits successfully with
  the explicit no-observation message while diagnostics record the failed
  refresh;
- a user-paused source is different from provider unavailability: it exits 1
  with the paused-policy message.

Keep the command example unchanged.

**Verify**: `grep -En "codex app-server|quota" README.md` → the root introduction
and CLI quota section both describe the same narrow exception.

### Step 2: Separate local-history and quota-source vocabulary

Rewrite the opening sentence of `CONTEXT.md` so ordinary session reports remain
local-history based while quota collection is explicitly the app-server-owned
exception. Keep the **Local history** definition provider-free; do not redefine
provider communication as local history.

Clarify **Quota snapshot** as a durable local observation that can be populated
from recorded Codex events and/or the explicit app-server usage-limit source,
matching the live implementation.

**Verify**:

```sh
grep -En "Local history|Quota snapshot|app-server" CONTEXT.md
```

The three concepts are distinct and no sentence claims all quota output is
provider-free.

### Step 3: Record ownership at the package boundaries

Add one concise sentence to `apps/cli/README.md`'s data boundary: the `quota`
command invokes report-data's one-shot provider-quota workflow and renders its
durable result; CLI does not own credentials or provider transport.

In `packages/report-data/README.md`, state that the provider-quota adapter may
launch the installed Codex app-server and that this adapter, not the CLI or web
renderer, owns that boundary. Do not duplicate implementation details or
private protocol payloads.

**Verify**:

```sh
grep -En "app-server|provider-quota|quota" apps/cli/README.md packages/report-data/README.md
```

Each package describes only its own responsibility.

### Step 4: Run documentation gates

**Verify**:

```sh
! grep -En "quota output without calling provider APIs|quota \\(5h / 7d windows\\) from the newest local" README.md CONTEXT.md
bun test apps/cli/src/main.integration.test.ts
bun run check
bun run lint
git diff --check
```

All commands exit 0.

## Test plan

This is a documentation-only change. Verify wording against the named source
symbols and the three existing CLI integration cases at
`apps/cli/src/main.integration.test.ts:227-333`, then run
formatting/lint/residue gates. Do not add a brittle source-string test solely
for prose.

## Done criteria

- [ ] The root README explains the refresh-then-read behavior.
- [ ] `CONTEXT.md` keeps local history provider-free and names quota as the
      explicit app-server exception.
- [ ] CLI and report-data package docs describe their respective ownership.
- [ ] The docs distinguish durable-data fallback, no-data fallback, and a
      paused source without promising a successful live refresh.
- [ ] No text says the quota command is always a local-only read.
- [ ] Existing CLI quota contract tests, format, lint, and diff checks pass.
- [ ] This plan's row in `plans/README.md` is `DONE`.

## STOP conditions

Stop and report if:

- live source behavior differs from the current-state evidence;
- the actual unavailable-refresh fallback cannot be established from code/tests;
- accurate wording would require documenting private credentials or payloads;
- the change expands into source behavior or broad architecture revision;
- a verification command fails twice after one reasonable correction.

## Maintenance notes

Future quota providers should keep the same vocabulary split: a durable local
observation is data at rest, while its refresh adapter owns any provider-facing
communication. User docs should describe both when a command performs refresh
and what it reads afterward.
