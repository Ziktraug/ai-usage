# ADR 0063: Durable Work threads carry the operator's follow-up

- **Status:** Accepted
- **Date:** 2026-10-24
- **Extends:** [0050](0050-work-attention-facts-outside-the-served-revision.md), [0051](0051-engine-read-only-github-and-checkout-observation.md), [0054](0054-jira-issue-facts-explicit-keys-read-only.md)
- **Plan:** [123](../../plans/123-work-thread-convergence.md)

## Context

The Work view listed one row per session family. A pull request with no local
session never appeared, an investigation vanished once its sessions aged out,
and nothing recorded that the operator had finished with a piece of work. The
approved "Unité de travail v3" reference asks for one row per task, from first
exploration to the end of the operator's follow-up, with sessions, branches,
pull requests and Jira issues as markers of that same task.

CONTEXT.md already defines the **Work thread** as a durable continuity container
across Sessions and harnesses. It existed only as an authorization resource of
the connected platform.

## Decision

- A **Work thread** is stored locally in the usage store (`work_threads`,
  `work_thread_links`, `work_thread_events`), additive under the current
  `user_version`, outside the served revision, the publication and the
  replication outbox. Only the usage engine writes it, through the
  `work-thread` control-plane command; the web and the CLI read it through
  `query_only` connections.
- Its **follow state** is the operator's: Following, Waiting or Done. It changes
  only by explicit, idempotent commands (a client `commandId`; a replay returns
  the recorded answer) that name the revision they were decided on; a stale
  revision is a typed `revision-conflict`. Every change is an event. No
  collection, projection rebuild, session end, CI result, approval or merge
  changes it. Ending a follow-up changes nothing in GitHub, Jira, a session, an
  agent or a file; known remainders are shown first and the acknowledged ones
  are recorded with the event.
- A **link** joins a thread to one qualified key: pull request
  `host/owner/repo#n`, Jira `jira:<site>/<KEY>`, session
  `session:<machine>/<harness>/<id>`, branch `branch:<host>/<owner>/<repo>@<ref>`.
  Pull request and branch authorities compare case-insensitively. A link is
  detached, never deleted, and a detached key is not resurrected by lineage or
  discovery. Sessions link only by explicit keys; a shared checkout, time
  proximity or lineage never links one. Sessions a linked session delegated nest
  under it and count as sessions of the thread, never as separate threads.
- **Discovery seeds threads.** The `github.pull-requests` source also searches
  the operator's open pull requests (author, review requested) through `gh`,
  bounded per account, with one token read for the active or configured
  account. The `jira.issues` source searches assigned unfinished issues through
  `acli` (shape assumed, fixture-tested). A discovered key becomes one Following
  thread keyed by `origin_key`; a key already linked to a thread, or seeded
  before, creates nothing. Active links of non-Done threads remain collection
  candidates until a merged observation exists, so a linked pull request keeps
  being observed after it leaves the search results.
- **Activity is source change time** (pull request update or merge, Jira update,
  a changed checkout, session activity), never the collection date, so a Done
  thread does not accumulate "newer" activity from polling.

### Provisional

A new fact after a thread is Done keeps it Done; the thread shows the change and
the operator may reopen it.

A wait that names a linked pull request review or Jira issue returns the thread
to Following once, by the engine, when a successful observation proves it: a
merge, or a review decision or Jira status that differs from a successful
baseline observed since the wait began. The transition is guarded by the
current state and revision and records a `wait-satisfied` event naming the
evidence. A comment, an update time alone or an agent review never qualifies;
without a baseline the wait stays and says why.

Whether a linked session is still running is unknown: no native lifecycle
evidence is stored yet, so no "in progress" hint is derived from real sessions.

## Consequences

- `/work` lists Work threads; the session attention board moves to
  `/work/sessions` as the intake from which a session can start a task.
- The engine contacts GitHub through the operator's `gh` on its existing cadence
  even with no linked pull request, whenever `gh` is detected and the source is
  enabled. Tests and fixtures must inject process stand-ins.
- Existing stores gain the tables and nullable columns on the engine's next
  start; there is no downgrade (docs/local-store-upgrade.md).
