# ai-usage Context

This context describes the local AI usage reporting domain. The CLI turns provider-free local history from installed AI coding tools into usage rows, analytics, and CSV. Quota collection is the explicit exception: the usage engine may ask the installed `codex app-server` or the experimental Claude Agent SDK for a fresh usage-limit observation before readers project the durable local result. Those provider clients own communication and authentication.

The product is local-only; plan 120 removes the connected platform. Terms that
only the dormant replication client still uses (Device enrollment state and
credential, Replication outbox, Replication generation, Capture context) and the
accepted Memory vocabulary stay until its phase B deletes that code; Work thread
and Work handoff name a feature that was never built. A term's presence records
the settled vocabulary, not feature availability;
[`plans/README.md`](plans/README.md) is the implementation-status authority.

## Language

**Harness**:
An installed AI coding tool whose local history can be collected, such as Claude Code, Codex, OpenCode, or Cursor.
_Avoid_: source, tool, integration

**Collection source**:
An independently detected, scheduled, and policy-controlled contribution to the normalized local store. A harness may expose more than one collection source: Codex and Claude sessions and their respective usage limits have separate policy and cadence.
_Avoid_: harness, refresh task, report loader

**Source policy**:
The persisted enabled/disabled choice for one collection source. Policy is independent from whether input is detected, whether work is running, and how the last run ended. Disabling pauses future collection and never deletes stored contributions.
_Avoid_: availability, lifecycle, deletion

**Source publication**:
The separate stored-only job that reconciles durable contributions into an immutable served report revision. Requests advance monotonic demand even while publication is queued or running; only a successful attempt acknowledges the generations it captured. A source run may be successful without changing the semantic revision.
_Avoid_: collection run, browser refresh

**Usage engine**:
The sole production owner of usage-domain writes, migrations, checkpoints,
collection, enrichment, scheduling, publication, retention, and mutations. Its
HTTP listener is an operational command/status/event seam, not a report data
service.
_Avoid_: web runtime, report API, background compatibility writer

**Served revision**:
One complete immutable report projection stored under a revision key in the
durable SQLite database. Its metadata may be renewed when an unchanged capture
remains current, but its projected content is not rewritten. Exact readers name
the revision and never silently switch to current.
_Avoid_: copied database, artifact directory, live unversioned query

**Data plane**:
The durable storage authorities behind explicit application and reader ports.
The existing usage SQLite database remains the report data plane queried
directly by Web and CLI through read-only/query-only connections. The dedicated
local Memory SQLite database is a separate authority; its presence does not
authorize Web, CLI, or MCP to open write-capable connections or imply that one
reader queries both.
_Avoid_: control HTTP, report endpoint, one undifferentiated database

**Control plane**:
The authenticated numeric-loopback usage-engine surface carrying only commands,
status, and bounded sanitized SSE events.
It is not the Memory service/IPC seam.
_Avoid_: data API, report transport, remote service, platform API

**Memory service**:
The separately named, authenticated numeric-loopback application-service seam
for local Memory-domain reads and mutations. Its protocol, bearer token,
rendezvous, and lifecycle are independent from the usage-engine control plane.
Its accepted surface keeps Project resolution, Memory proposal review, and
explicit import/export behind application services rather than implicit file
synchronization.
_Avoid_: control plane, report API, public platform endpoint

**Enrichment contribution**:
A versioned, validated value owned by one enricher and keyed to a stable base usage-row identity. Report reads compose it with the producer-owned base row; neither writer replaces the other's durable data.
_Avoid_: JSON patch, enriched base row

**Local history**:
The files or databases written by a harness on this machine. It is the live collection input for ordinary sessions; a caller may also supply an explicit portable snapshot or previously imported merge bundle. Reading local history never calls provider APIs.
_Avoid_: remote usage, cloud billing data

**Session**:
A single conversation or agent run found in local history. A session can include child sessions, such as Codex subagent threads.
_Avoid_: chat, transcript, thread

**Round**:
One prompt-led unit of activity inside a session: the user prompt that opened it, the calls and tool activity attributable to it until the next prompt, and the child sessions it launched or messaged. A round is derived once from the harness's native units (Claude turns, Codex tasks, OpenCode message groups), which stay in the evidence. Activity that no prompt owns remains a round of its own rather than disappearing.
_Avoid_: turn (as the reading unit), task, exchange, step

**Child session**:
A session launched from another session, such as a Claude sub-agent, a Codex spawned thread, or an OpenCode child session. The link carries its evidence kind; a message sent to an existing child continues that same child session instead of creating a new one.
_Avoid_: subagent run, agent instance, worker

**Session analysis**:
On-demand inspection of a Session through its native harness history: rounds,
metrics, tool activity and timeline with the reader's explicit coverage limits.
This remains available after retirement of generated Session accounts.
_Avoid_: generated account, accepted guidance, productivity score

**Historical Session account**:
An immutable generated interpretation retained from the retired Session
distillation feature. Existing content, source references and promotion
provenance remain stored; the account library and generation flow are withdrawn
under ADR 0049. Historical interpretations do not become accepted Memory.
_Avoid_: native Session analysis, accepted guidance, current library

**Work episode (historical)**:
An interpreted unit within a historical Session account, retaining its objective,
attempts, qualified outcome and evidence references. It is not the
harness-derived Round, an observed Campaign or a durable Work thread.
_Avoid_: Round, task, Work thread, execution grouping

**Campaign**:
An observed execution grouping: a root Session and the related Sessions resolved
by collected lineage within the same machine and harness. A standalone Session
is a one-session Campaign. Campaign identity comes from the served revision's
existing session grouping; proximity in time, a shared project, or similar
titles do not establish a parent relationship. A Campaign is distinct from a
durable Work thread.
_Avoid_: work thread, inferred task, active agent fleet

**Session origin**:
The declared way a session was started, with three values: human, delegated, or automated review. It is absent when the harness did not declare one. An absent attribute is expressed by provenance, never by a sentinel value in its own domain.
An automated review with a declared parent contributes to that parent's campaign. A review shape that declares no parent remains a standalone one-session review campaign; a declared but unresolved parent remains an integrity error.
_Avoid_: unknown origin, origin unknown, undeclared as a category

**Native outcome**:
What a Session declared about itself at its last turn end, as its harness
recorded it: a status (blocked, completed, review ready), the action it asked
for, and short reports. It is dated by the Session and read later by this
product, so it is a declaration from that moment, never the Session's current
state; nothing newer than the declaration is implied by showing it.
_Avoid_: current state, live status, session state

**Fact**:
One dated observation of one source with its coverage: a native outcome, a
declared or observed pull request, a checkout status. Facts are stored and
re-validated on read; they carry provenance and never a verdict.
_Avoid_: finding, verdict, status, truth

**Interpretation**:
A reading computed on request that confronts a Session's declarations with the
facts gathered around it and names its own uncertainty, such as "request open"
or "possibly answered elsewhere". It is never persisted and never shown as a
fact; a changed rule re-reads the same facts differently. An interpretation
never closes a request by inference. Only native evidence attributed to the
exact request can establish its answer; a later message date or a completed
child session cannot. Archiving removes current attention without claiming
a decision or delivery. A replacing native declaration supersedes the earlier
declaration without proving its answer. A later message, pull request, or work
continued in a linked session, including a completion, makes the root an older
declaration to reconsider, and the question stays the operator's. What may
reconsider a request through a pull request is narrow: a pull request a child
session listed from another checkout while active after the question, or a
GitHub observation showing a pull request merged after it. The root's own
listed pull request mirrors the branch of the checkout it sits in and counts
only through such a GitHub observation dated after the question, never through
the listing itself.
_Avoid_: fact, inferred state, conclusion, task status

**Proposal**:
A suggestion a Session's harness offered for a follow-up, with its title and a
short synopsis; the brief itself is never collected. "Started" and "dismissed"
are observed states without a recorded reason. An offer past its native expiry
is no longer presented as pending; a later message alone does not supersede,
accept or reject it. A proposal is not a task, has no owner and no deadline, and is never
ranked above a question a person was asked.
_Avoid_: task, todo, backlog item, pending action

**Delegation**:
A bounded task that a caller (any MCP client or the CLI) hands to AI Usage,
which decides from its own rules and fresh observations which routes may run
it. This version executes one action, a read-only review of a commit or an
explicit commit range in an admitted local checkout. The caller's name and
session are metadata; they never authorize, route or bill (ADR 0077).
_Avoid_: handoff, leader, sub-agent call, work thread

**Route**:
One explicit way to run a delegation: machine, executor harness, account,
quota pool, model and effort, declared by the operator under
`routing.executors[]` with a context (professional or personal). Models of one
account share one pool. A route is admissible only when every rule and
observation allows it now.
_Avoid_: provider, harness alone, best model

**Qualification**:
The engine's dated, versioned answer to a delegation request: the admissible
routes with factual advantages and limits, the excluded ones with their
blockers, the applied rules and assumptions, and how long it holds. A start
re-qualifies with the same function and refuses what changed.
_Avoid_: recommendation, ranking, simulation result presented as a decision

**Selector**:
Whoever chooses one admissible route or abstains. In this version it is the
calling model; its stated confidence is its own statement, never a measured
probability of success.
_Avoid_: router, policy, judge

**Delegation job**:
The durable record of one delegation decision and its execution: request,
cited and launch qualifications, selection, route, frozen scope, process
facts, bounded result and evaluations. It belongs to AI Usage, not to the
caller's connection; it is not a Round or a Session. Jobs and the Work view's
review attempts pass one admission policy and share one target and pool
reservation rule.
_Avoid_: attempt (the session review of ADR 0053), task, thread

**Delegation evaluation**:
A dated statement about a finished job, kept apart from its execution: a
structural `automated-check` by the engine, a `verification` by the calling
model, or an `acceptance` by the operator in the Work view. A model or a check
never records an acceptance.
_Avoid_: success, score, approval inferred from an exit code

**Collected session**:
An intermediate collector result that preserves harness-specific local history details before normalization into a usage row. It is the seam used by collectors that need shared row conversion.
_Avoid_: raw event, source row

**Usage row**:
The normalized per-session record consumed by table, CSV, JSON, and analytics output. It includes tokens, model, harness, provider, project, cost approximation, and optional partial/subagent markers.
_Avoid_: raw event, database row

**Collected dataset**:
A named set of collected and enriched report data transported alongside usage rows, such as provider status or Cursor commit attribution. Skill inventory is a separate local control-plane query, not a collected report dataset.
_Avoid_: facet, metadata blob, app state

**Report payload**:
The complete JSON-serializable compatibility aggregate used by CLI output and compatible consumers. It contains serialized usage rows, filters, analytics, collected datasets, and optional local history warnings. The served report app reads exact-revision focused results instead of transporting this complete aggregate during refresh.
_Avoid_: app state, served refresh response

**Focused report result**:
A JSON-safe, request-fingerprinted projection for one served destination over an immutable report revision, such as Overview, Breakdown, support, a Sessions page, campaign children, or drawer neighbors. The support result is a bounded bootstrap summary and reports exact omission counts when filter options, provider representatives, provider statuses, or warnings do not fit.
_Avoid_: report payload, live database view, unversioned server response

**Usage snapshot**:
A portable multi-machine export of usage rows and machine provenance that can be merged with other snapshots or local history.
_Avoid_: backup, provider export

**Merge bundle**:
A portable, versioned file of normalized machine-scoped usage facts. The `/sync` file-transfer workspace exports and imports merge bundles through the local usage store.
_Avoid_: usage snapshot, database backup, report payload

**Manual transfer**:
An explicit export, out-of-band file copy, and import. It does not imply discovery, a listener available to another machine, or background synchronization.
_Avoid_: pairing, replication, automatic transfer

**Person**:
The stable domain identity of one human. A Person is independent of Devices and
display handles, and owns one personal Space in the identity kernel.
_Avoid_: user account, GitHub user, device owner record

**Device**:
A stable identity for one local ai-usage runtime. Its Person owner, owning
Space, label, enrollment state, and credential are separate facts; a hostname
or existing usage-machine record is not silently promoted to a Device.
_Avoid_: machine label, hostname, credential

**Replication outbox**:
The Device-local, transactional queue of immutable fact events awaiting
outbound publication, one per owning SQLite authority. It preserves generation
order and replay identity; it is not a cache, a sync log the server can read,
or a second mutation authority.
_Avoid_: sync queue, event log, pending changes

**Space**:
The explicit personal ownership and authorization root of the local Person. A
resource is assigned to a Space before storage; repository, path, or Device
observations never infer another Space later.
_Avoid_: tenant guessed from repository, project group, organization login

**Authorizer**:
The application-owned port for tri-state permission checks, bounded ordinary
resource listing, and complete opaque authorized-resource scope. It separates
allow, deny, and operational error and is the only permission seam used by
application services.
_Avoid_: route guard, UI filter, database role, authentication provider

**Authorized-resource scope**:
A complete, opaque, request-scoped representation of every resource authorized
for one principal, permission, resource kind, model version, and active Space.
Application/edge code cannot inspect it as an ACL array. Persistence queries
consume it before result limiting or ranking and must revalidate current
relations when consistency requires it.
_Avoid_: permission page, truncated ID list, post-filter, search-result ACL

**Repository**:
A stable Space-scoped source-control identity with provider identifiers and
historical remote aliases as locators. A Repository may be renamed or
transferred without becoming a different Project.
_Avoid_: Project, Checkout, remote URL as primary identity

**Project**:
A stable cross-device identity for work, optionally linked to a Repository and
monorepo subpath. Non-Git Projects are first-class. It is distinct from the
machine-scoped Project source and the local presentation-only Project group.
_Avoid_: project source, project group, repository URL, checkout path

**Checkout**:
A Device-local observation of a working path, optionally resolved to a Project
and Repository. Its path and remote are locators and provenance, never tenant
or filesystem authority on another Device.
_Avoid_: Project, Repository, capture authority

**Resolution review**:
The Person-facing decision that binds one observed Checkout to a Project (or
leaves it explicitly unassigned) when repository resolution cannot decide
alone. It records the chosen source and never infers another Space.
_Avoid_: auto-assignment, project guess, unresolved warning

**Capture context**:
The explicit Device, Person, Space, optional Project, and optional SCM account
or installation context attached before or during replication publication of a
fact. The replication protocol carries the SCM fields until phase B removes it;
local producers always leave them empty. Its assignment source is
recorded; unresolved work stays personal or explicitly unassigned rather than
being reassigned later from repository or Device clues.
_Avoid_: inferred tenant, post-storage ownership repair, project source

**Replication generation**:
A monotonic position in one Device and replication stream. A server
acknowledges it only after durable apply. It is distinct from logical fact
identity, publication event identity, exact content identity, and report
publication generations.
_Avoid_: batch ID, event ID, content hash, report generation

**Project source**:
A machine-scoped project path carried by a usage row. Locally observed paths may be canonicalized and inspected; paths from snapshots or merge bundles are opaque labels and never authorize local filesystem access. Its identity combines the machine and source path so similarly named folders stay distinct.
_Avoid_: project group, repository scan root

**Project group**:
An explicit local configuration that presents multiple project sources as one named project in reports.
_Avoid_: project source, inferred alias

**Memory observation**:
Immutable, provenance-bearing evidence captured or imported for possible use by
Agent Memory. It is not active guidance and is never accepted implicitly.
_Avoid_: Memory item, proposal, raw prompt dump

**Memory proposal**:
Candidate guidance derived from explicit input or linked Memory observations
and awaiting Person review. Generated content stays labelled and cannot accept
itself.
_Avoid_: accepted memory, autonomous distillation, mutable draft item

**Memory item**:
The stable identity of accepted Agent Memory guidance in one Space, with scope,
kind, trust, sensitivity, lifecycle status, and a current Memory revision.
_Avoid_: observation, proposal, Markdown file, revision row

**Memory revision**:
One immutable version of a Memory item. Revising appends a new revision and
advances the current pointer atomically; exact older revisions remain
addressable.
_Avoid_: in-place edit, file version, proposal

**Work thread**:
A durable continuity container across Sessions and harnesses, with an explicit
intent and lifecycle and an optional Project. It is not a Session, Project,
issue, branch, pull request, or campaign. The Work view calls it a task; its
sessions, branch, pull requests and Jira issues are links, and it carries the
operator's follow state (ADR 0063).
_Avoid_: session thread, campaign, task inferred from prompts

**Jira intake**:
Issues Jira assigns to the operator that no open Work thread follows yet, listed
above the tasks until the operator follows, attaches or dismisses each one.
Assignment alone never creates a Work thread (ADR 0079).
_Avoid_: backlog task, inbox, auto-followed ticket

**Combined task**:
A Work thread whose members, other threads following the same ticket, read as
part of it until the operator separates them. Members keep their links and
history; they are not ended (ADR 0080).
_Avoid_: merged task, duplicate, absorbed (in UI copy)

**Follow state**:
The operator's own standing on a Work thread: Following, Waiting or Done. Only
explicit commands change it. Ending a follow-up closes the operator's
responsibility, never a pull request, issue, session or agent; "to resume",
"in progress" and "ready to close" are derived hints, not states.
_Avoid_: task status, closed, resolved, archived

**Work handoff**:
An immutable, evidence-labelled `WorkHandoff` revision that transfers reviewed
continuation context within a Work thread. Acceptance by a Person advances the
thread's current Work handoff; the target starts a normal new harness Session.
It is distinct from `UsageEngineHandoff*` staged-file transport and imported
Memory `kind: "handoff"`.
_Avoid_: Handoff, native session conversion, generated summary presented as fact

**Skill source repository**:
The configured local repository containing canonical managed Agent Skill documents and portable JSON source state.
_Avoid_: runtime target, project skill directory

**Runtime**:
An agent environment that consumes projected skills, such as Codex or Claude Code. Harness remains the term for usage collection.
_Avoid_: harness, provider

**Projection**:
A managed exposure of a source skill in a configured runtime target, normally a verified symbolic link. A plan captures target identity; application revalidates it under a cooperating-process lock before mutation.
_Avoid_: copy, source skill, installation package

**Unmanaged runtime entry**:
A file or directory found in a runtime target that is not a verified projection managed by ai-usage. It is reported for consolidation but never overwritten automatically.
_Avoid_: broken projection, source skill

**Skill observation**:
One record that a named skill was invoked, or offered, in one session of one harness. It is an auxiliary fact keyed to the harness, the session, and a timestamp — never a column on a usage row, because a session produces many of them. It carries an observation tier, and it carries the skill name as the harness wrote it, before any resolution.
_Avoid_: skill usage, skill invocation count, skill run

**Observation tier**:
The strength of the evidence behind one skill observation, with three values. `declared` — the harness recorded the invocation as such (Claude Code's `Skill` tool call, OpenCode's `skill` tool part). `inferred` — reconstructed from a weaker trace that was never meant to record an invocation (a Codex `exec` command that reads a SKILL.md). `exposed` — the skill was offered to the model in that session, with no evidence it was used (the Codex catalogue). The tier is part of the fact and travels with every count derived from it. Tiers are never silently merged, and a total that adds `declared` to `inferred` without saying so is a defect.
_Avoid_: confidence score, invocation quality, provisional

**Skill resolution**:
The join from an observed skill name to an entry in the skill inventory. It may legitimately fail: harness-bundled and plugin-provided skills are real, invoked, and outside the managed source repository. An unresolved observation is retained and labelled as unresolved — it is the evidence for the "invoked but unmanaged" verdict, so dropping it would erase the finding.
_Avoid_: orphan observation, invalid skill, unknown skill

**Observability**:
Whether a harness can report skill observations at all. Claude Code and OpenCode declare invocations; Codex exposes a catalogue and leaves only an inferable trace; Cursor records nothing and is therefore not observable. A harness that cannot report renders as *not observable*, never as `0` — a zero would assert that its projected skills go unused, which no data supports.
_Avoid_: zero invocations, unused, no data (as a count)

**Skill residence**:
Where an unmanaged observed name lives, decided at the inventory↔observation join from data already read. `runtime-installed` — the name has an unmanaged entry in a runtime skills directory: the adoptable backlog. `project-owned` — a resolved directory sits inside a known project: deliberately scoped, not missing. `external` — everything else: harness-bundled, plugin-provided, or since deleted. Residence refines how the adoption verdict is presented and worded; it never changes the verdict itself, which remains a fact about the name.
_Avoid_: skill origin (that is the install-source axis), orphan class

**Provider**:
The billing or subscription route inferred for a usage row, such as Claude API, Claude sub, Codex API, Codex sub, or Cursor sub.
_Avoid_: vendor, platform

**Cost approximation**:
A hypothetical API-rate cost calculated from local token counters and the editable pricing table. Subscription products bill differently, and unknown public rates remain unpriced.
_Avoid_: bill, invoice, actual spend

**Quota snapshot**:
A durable local Codex usage-limit observation used to render subscription quota windows. It can be populated from recorded Codex `token_count.rate_limits` events and/or the explicit `codex app-server` usage-limit source; app-server refresh is provider-facing collection, not local history.
_Avoid_: billing limit, provider quota API

**Wide event**:
One sanitized, bounded, schema-v2 structured observability record emitted exactly once at the end of an Effect program execution so an operator can see what ran, its business outcome, how long it took, allowlisted local context (for example which collector), and process-scoped producer provenance without requiring an OpenTelemetry exporter. The exhaustive NDJSON/JSON record remains one physical line; a severity-aware application projector may render a concise multi-line TTY view. Same ecosystem pattern as Stripe canonical log lines / Observability 2.0 structured events.
_Avoid_: boundary log, harness history event, SSE publication event, scattered per-step log lines, OTel-required setup

**Effect program execution**:
A fresh, scoped application or control-plane boundary that runs one complete job or adapter entry to a business outcome. The scope may run inside a long-lived worker fiber, but its wide-event controller, annotations, and hop parent state never survive into the next execution. Queue admission, stale/skipped jobs, reusable helpers, and long-lived worker loops are not executions and do not emit their own event.
_Avoid_: carrier fiber identity, enqueue-only command, nested Effect.gen helper, source-control-only logging
