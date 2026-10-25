# ADR 0054: Jira issue facts: explicit keys only, read through the operator's CLI session, never written

- **Status**: Accepted
- **Date**: 2026-10-22
- **Extends**: 0009, 0050, 0051

## Context

The Work view confronts what a Session declared with dated facts from GitHub
and from the disk (ADR 0051). A third source carries the same kind of signal:
the Jira ticket a piece of work was done for. The useful event is narrow: "a
reply arrived on the linked ticket after the last investigation this machine
knows about". It is not "you have not read it": the operator may have read the
ticket in a browser, and nothing on this machine can tell.

Two risks shape the design. Linking the wrong ticket to a Session would attach
a certainty the data does not carry; a ticket key appears in titles, prompts
and paths for many reasons. And a Jira integration that writes anything (a
comment, a transition, a tag, a sprint change) would act on the operator's
behalf from a background process.

The Atlassian CLI (`acli`) was **not installed on the machine where this was
built**. Everything below was proven against a fake `acli` on a temporary
PATH; no live read was exercised.

## Decision

A third fact producer, `jira.issues` (every 10 minutes, enrichments group),
runs beside `github.pull-requests`:

- **Explicit links only.** A key is linked to a Desktop session family when it
  appears as a whole `/`-separated segment of a branch name the session wrote:
  `writtenBranches[]`, its own `branch` and `sourceBranch`, or the branch of a
  pull request it declared (`feat/XLB-2090/slug`, `fix/XLB-2091/nav`,
  `XLB-2092`). The title, the working directory, the transcript and a bare
  number (`pr/user/123`) never link. `<PROJECT>-0` is the local "no ticket"
  placeholder and is ignored. The rule is the pure `explicitJiraKeys` in
  `report-core`; the engine and the read model share it.
- **Read through the operator's CLI session, never a token.** The engine runs
  `acli jira workitem view <KEY> --json` through the shared bounded runner (no
  shell, allow-listed environment, deadline, output ceiling, stderr drained).
  It never reads, stores or forwards a credential; `acli`'s own sign-in is
  what answers. **The command shape is assumed from the Atlassian CLI
  documentation, not exercised on this machine**; the JSON mapping is
  tolerant on unknown keys and strict on the types it uses, so a different
  real shape yields `invalid` observations rather than wrong facts. Only
  `view` is ever issued: no create, comment, transition, assign or sprint
  command exists in the code.
- **Outcomes, not preconditions.** A missing binary is `disabled` (message
  `acli not installed`); a non-zero exit with a JSON error body carrying HTTP
  401 or 403 is `unauthenticated` ("sign in to Jira (acli jira auth login)"),
  404 is `not-found`, anything else is `network`; a deadline is `timeout`; an
  unreadable success body is `invalid`. A run-halting failure records the
  remaining keys without another spawn. `jira.enabled: false` (user-home
  config only; refused in repository config) records a disabled run.
- **Store like the other facts.** `jira_issue_observations` keeps dated rows
  (status, status category, summary, assignee label, sprint, parent key,
  comment count and the ten newest comments as JSON), re-validated on read,
  with the latest observation and the latest successful one kept apart and a
  retention of five rows per key plus the newest success. An author is a
  display label, never an e-mail address: an address keeps only its local
  part. The table is outside the served revision, the export and the
  replication outbox.
- **Interpretation names its uncertainty.** `newCommentsSince` counts the
  kept comments created after the latest activity on the key: the most
  recent `lastActivityAt` among every session family (roots and children)
  that wrote the key explicitly, on that machine. When it is positive, the
  family that was last active on the key is a human request ("N comment(s)
  arrived on KEY after this session family's last activity (date); no
  resumption observed. You may have read them in Jira; this view cannot
  tell"); an older family on the same key carries the dated status and is
  only told where the reply is carried (`jira-reply-elsewhere`: "… the most
  recent family on this key is <title>, which carries the request"), never
  promoted, so a ticket relayed from branch to branch does not leave a
  permanent request on every family that once wrote it. When the key was
  relayed after the newest comment, nothing is said. A To Do ticket beside an
  open or merged pull request is "a different status is not automatically an
  error". An unauthenticated read keeps the last dated success beside it and
  names the exact action.

## Consequences

- The Work view can show, per root, the ticket's dated state and whether a
  reply arrived since the family last worked, with Jira as its own provenance.
- `coverage.jira` reports the producer's last run and its reason when it
  recorded itself disabled. A source that was never detected (no `acli`)
  leaves no run; the gap then reads "not observed", and the observations'
  `disabled` outcome carries the reason when the binary left after detection.
- Limits accepted in this version: the command shape and JSON mapping are
  unverified against a live `acli`; the `site` config field is recorded for
  the operator and not passed to the CLI; `url` on the fact is `null` because
  the observation does not carry the site; the ten newest comments bound the
  arrival count; one Jira site per machine is assumed.
- Rejected alternatives: linking keys found in titles or prompts (certain to
  attach wrong tickets); reading a Jira token from the environment or a config
  file (the engine would hold a credential it does not need); a REST client of
  its own (the CLI already owns sign-in and the operator's identity); any
  write command, even behind a flag.

## Evidence

- `packages/report-core/src/work-attention.ts` (`JiraIssueObservation`, the
  `jira-issue` fact, `coverage.jira`) and `work-attention-facts.ts`
  (`explicitJiraKeys`, `jiraIssueFact`, `interpretJiraFacts`) with their tests.
- `packages/local-collectors/src/jira-issues.ts` and its test against
  `src/test-fixtures/fake-acli.ts` (the six outcomes, no token in the child
  environment, no address in an observation).
- `packages/usage-store/src/work-fact-store.ts` (table, import, read, run
  state) and `docs/local-store-upgrade.md`.
- `packages/usage-engine-runtime/src/source-adapters.ts` (`jira.issues`
  source, detection by executable, Desktop-linked keys) and its test.
- `packages/report-data/src/work-attention-read.ts` (attachment by family
  key, `newCommentsSince`, attention) and its test; the web contract, client
  and e2e composition under `apps/web`.
