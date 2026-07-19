# Session analysis data sources

This document records what the session report and the on-demand session
analysis can truthfully derive from each local harness. The implementation
status and structural audits below are current as of **2026-07-19**.

The important distinction is:

- **report metrics** are normalized rows that may be persisted, included in
  report revisions, snapshots, merge bundles, JSON, and CSV;
- **local detail** is read from the source machine only after the user opens a
  supported session analysis. It is not part of the report revision.

## Quality vocabulary

| Quality | Meaning |
| --- | --- |
| Recorded | The harness stores the metric directly with the relevant event. |
| Derived | The metric is computed from recorded fields with a deterministic rule. |
| Partial | Only part of the history or metric is available locally. |
| Estimated | A useful approximation exists, but the source cannot support exact wording. |
| Unavailable | The local source does not expose enough information. |

An unavailable or estimated metric must not be presented as an exact zero or
as a default setting.

API-value rows preserve the subtotal of every segment whose model has known
pricing. A fully priced row is displayed as `$x`; a partially priced row is
displayed as `≥ $x`, because the subtotal is a lower bound; a row with no
priced segment is displayed as `—`. `costKnown` is true only when every
token-bearing segment is priced, while `costApprox` retains that known
subtotal even when `costKnown` is false.

Overall report summaries intentionally total only fully priced sessions and
expose their priced-session coverage; they do not mix lower bounds into means.
Session rows and grouped campaign rows retain and display their own lower
bounds. Breakdown panels also expose priced-session coverage; their percentages
are shares of the known-price subtotal, not shares of an unknown final bill.

Provenance markers have two visual levels. A neutral `i` is informational: for
example, `title-derived` means the label came from the first prompt or other
session metadata rather than an explicit AI title. An orange `!` is a real
data-quality warning, such as partial usage, unavailable counters, ambiguous
reconciliation, or missing model pricing. The marker describes the affected
metric; it does not mean that the whole source run failed.

## Collection freshness

The served report has two durable steps: a source run replaces that source's
stored contribution, then publication creates an immutable report revision.
On-demand local detail is read independently from the current source after the
server resolves the selected row's machine, harness, source session, and
projection facts from the requested immutable revision. The browser sends only
the revision and report row identity; it does not choose the local provenance.
This keeps detailed prompts outside the revision while binding the comparison
to the report that the user is viewing.

The resulting consistency has three precise meanings:

- `matches-report`: every comparable projection metric, including available
  token counters, agrees with the report revision;
- `differs-from-report`: at least one comparable metric differs;
- `cannot-compare`: the row lacks enough comparable facts to claim a match,
  even though some fields may still have been checked.

A divergence does not prove that the local source is newer. It can also result
from an enriched source, a corrected parser, or comparison with an older
revision. Partial duration or turn coverage, unavailable usage, and unknown
pricing remain limitations of their individual metrics rather than a global
quality status. A successful source status with no source warnings only proves
that its adapter completed; it does not prove that an older long-lived process
loaded the newest collector implementation.

In development, the source-control runtime persists across scheduled runs.
The workspace packages used by that runtime must stay inside Nitro's server
module graph, and a full reload must dispose or replace the installed runtime
before the plugin is evaluated again. Parser cache versions are part of the
same contract: any change to attribution or serialized session semantics must
bump the cache version so records produced by an older parser cannot be reused
under the new rules.

Portable usage snapshots and merge bundles write schema version 2 when they
carry per-model attribution. Readers migrate genuine version-1 files that do
not contain `modelSegments`; a version-1 file containing that version-2 field
is rejected instead of being accepted under a misleading contract version.

## Support matrix

| Harness | Detailed drawer | Recorded time / session span / gaps | Models and effort | Turns, tools, and prompts | Lineage |
| --- | --- | --- | --- | --- | --- |
| Codex | Supported locally on demand | Completed task durations and bounded open-task windows are combined as a union; session span and between-task time are derived | Ordered model and effort phases are recorded | Recorded turns and tools; prompt bodies available locally on demand | Cross-session parent IDs are available; a grouped campaign analysis explicitly scopes itself to the root rollout |
| OpenCode | Supported locally on demand | Assistant time is the union of completed assistant intervals; session span and outside-assistant time are derived | Ordered provider/model phases are available; `variant` is recorded when present and effort is explicitly unavailable otherwise | Assistant activity is grouped by parent user message; tools and non-synthetic user text parts are available locally | Native session parent IDs are available |
| Claude Code | Not supported by the detailed drawer | Elapsed is available; exact active duration exists only for some recent turns, so whole-session active/idle is mixed or estimated | Report usage is segmented by recorded message model; no explicit effort field was found | Turns, tools, tokens, and prompt records exist locally | Subagent-to-root inference is available for agent files; Codex-equivalent cross-root lineage is not |
| Cursor | Not supported by the detailed drawer | Elapsed is available for sessions retaining timestamps; RPC intervals and explicit turn durations are partial | Optional CSV usage is segmented by model; the DB fallback has only a partial model history, and Max Mode is not retained | Prompt history is retained for only part of the composer set; local token history is partial | No trustworthy cross-session parent relation is currently collected |

Claude Code and Cursor remain report sources, but the table does **not** claim
that their prompt or timeline detail is available in the UI.

## Codex

### Source and derivation

Codex session analysis reads the matching rollout JSONL under
~/.codex/sessions through the hardened local-history reader:

- completed task-open windows use the source duration field, while an open task
  is bounded by the last locally observed event rather than discarded;
- model and effort changes come from turn context;
- cumulative token observations are converted into non-negative deltas and
  assigned to their model/effort phase;
- replayed parent history in forked rollouts is excluded unless a task is
  anchored by the child rollout's own context;
- prompt events are deduplicated and bounded before being returned.

Forked rollouts can stamp copied `task_started` events at replay time while
preserving their original, second-resolution `started_at`. A lag over two
seconds is considered replay only when that original start also predates the
rollout itself; delayed local events inside the rollout remain local work. A
replayed token snapshot still advances the cumulative baseline, but it does not
create local tokens, phases, models, turns, tools, prompts, or task duration.
Histories without modern local token snapshots attributable to a task context
retain the legacy cumulative-snapshot fallback.

Task-open time is the union of bounded local task windows: completed tasks use
their recorded durations and open tasks end at the last observed local event.
Overlapping windows are counted once. The metric includes time a request
remains open while Codex waits for tools or subagents, so it must not be
described as model runtime. Session span is the first local task start to the
last observed local task event, and between-task time is the remainder. A
grouped campaign displays the root rollout's task-open time rather than summing
overlapping children. Tokens remain observed counters and API cost remains an
estimate from the pricing table, not an invoice.

### Sanitized audit observation

One real rollout used to validate the parser contained seven completed turns
and seven deduplicated prompts. It changed from one GPT-5.6 variant at ultra
effort to another at high effort, with 94,279,695 observed tokens. Its recorded
task-open time was 16,361,730 ms, compared with a 31,009,000 ms session span and
14,647,270 ms between tasks. The segmented API-value estimate was about $68.09.

The same sanitized campaign contained 16 rollouts. After replay snapshots were
used only as baselines, it contained 157,086,669 attributable tokens and 37
local turns, with a fully priced API-value estimate of about $125.84. The child
that exposed the bug retained one local GPT-5.6 Sol phase, 1,326,997 tokens,
one turn, 25 tools, 317,750 ms of task-open time, and about $1.21 of API value;
the copied placeholder-model and task history disappeared.

The same audit also contained guardian approval sessions whose recorded model
was `codex-auto-review`. They carry observed tokens, but that internal model has
no public API-price entry. Their API value therefore remains unknown (`—` with
a warning) instead of borrowing the Sol or Terra price. A separate interrupted
rollout emitted `token_count` with `info: null`; its `usage-unavailable`
warning is likewise intentional.

This observation validates the parsing rules; it is not a benchmark or a
billing statement.

## OpenCode

### Source and derivation

OpenCode stores sessions, messages, and parts in its local SQLite databases.
The analysis uses a read-only transaction and derives:

- assistant time from the union of completed assistant intervals, preventing
  overlapping messages from being double-counted;
- session span and outside-assistant time from the session event span;
- ordered phases from the provider/model pair and recorded variant on assistant
  messages;
- token and reported-cost totals from assistant message records;
- report token buckets and API-value estimates segmented by provider/model at
  each assistant message timestamp;
- tools and user prompt text from message parts;
- lineage from the native session parent ID.

Reasoning-token counters are usage metrics, not an effort level. When an
assistant message has no `variant`, the analysis displays effort as unavailable
instead of inferring it from reasoning tokens or undocumented fields. Multiple
assistant messages sharing a parent user message form one displayed turn; the
model and effort on that turn are token-weighted summaries while the phase
timeline preserves the exact changes. The activity timeline keeps each merged
assistant interval as a separate segment, so pauses inside a logical turn stay
visible.

Assistant messages associated with an internal user-role parent remain visible
as prompt-less turns. Their tokens, tools, and intervals therefore reconcile
with the phase and activity timelines, while turn attribution is marked partial
because no human prompt association is available. Legacy OpenCode 0.15.x
records can also lack a resolvable assistant-to-parent association; they remain
visible without an invented prompt association and are likewise marked partial.

### Sanitized audit observations

The live database audit found 519 sessions, 18,871 messages, and 83,513 parts;
the stable database contained 219 sessions, 8,248 messages, and 40,998 parts.
Of 25,053 assistant records across both databases, 25,006 had completed
intervals and 47 remained open.

There were 626 sessions eligible for active-duration derivation: 422 in the
live database and 204 in the stable database. For 148 of them, elapsed time was
more than twice active time. The elapsed/active ratio at the 90th percentile
was 5.85× in the live database and 7.31× in the stable database. Twenty-four
sessions used multiple models and fifteen used multiple providers.

These duration observations are reproducible from aggregate metadata alone.
For each session with non-zero active time, elapsed time is the span between
the earliest and latest valid created/completed timestamps across all messages;
active time is the union of valid completed assistant intervals. Each
database's P90 uses the nearest-rank value at `ceil(0.9 × session_count)`.

The audit found 1,925 direct, non-synthetic user text parts. A separate
message-level query found 1,921 distinct direct user messages with at least one
eligible text or file part; those two units are not interchangeable. The
largest single prompt part was about 55 KB, which is why prompt count,
per-prompt size, and total response budgets are required. It also found 651
legacy assistant records without a resolvable parent, all from observed 0.15.x
formats.

## Claude Code

### Feasible data and limits

Claude project JSONL contains enough structure for a future local detail
adapter to expose ordered models, token buckets, tool calls, user turns, prompt
timestamps, and elapsed time. Recent versions also emit some
system.turn_duration records.

It does not currently support trustworthy detail parity with Codex:

- exact turn duration is present for only a subset of recent root turns;
- no explicit effort key was found, so thinking blocks must not be translated
  into low, medium, or high effort;
- normal files do not expose a Codex-equivalent cross-root parent pointer;
- the report collector segments token buckets and API value by recorded
  `message.model`; the dominant model is retained only as a compact row label;
- the current Claude API versus subscription label is inferred from current
  configuration, not recorded per historical session.

Until a quality-aware detail contract is available, Claude remains unsupported
by the detailed drawer. A future adapter must label older active time as mixed
or estimated rather than silently treating the first-to-last span as work.

### Sanitized audit observations

The structural audit covered 107 JSONL files (about 135.6 MB) and 24,136
records: 61 root files and 46 agent files. It identified 403 candidate direct
user prompts without retaining their text.

Only 21 source turn-duration records were present, across seven root sessions.
Seventeen of the 61 root sessions contained a silent event gap longer than one
hour, five exceeded eight hours, and the largest exceeded eight days. Treating
the whole span as active time therefore produces visibly misleading results.

Six of 53 root sessions with real model observations changed model. Pricing all
their tokens at the dominant model produced a combined estimate of $97.99,
versus $83.78 when segmented by model: a 17.0% overstatement for that audited
set. The report collector now applies the segmented rule. No explicit effort
field was found.

## Cursor

### Feasible data and limits

Cursor's local state database can retain composer metadata, some bubble
history, prompt text, model observations, token counters, RPC intervals, and
occasional explicit turn durations. Availability differs substantially by
session and over time.

The optional dashboard CSV is the more trustworthy source for historical
model, token, and cost rows. Its report rows preserve per-model token and API
value segments. The export also contains Max Mode, but the current CSV parser
does not retain that field. A numeric thinking-style field has no stable
documented meaning and must not be mapped to an effort label.

Cursor remains unsupported by the detailed drawer because whole-session active
and idle time cannot currently be stated authoritatively. Any future adapter
must carry partial coverage per metric and reconcile local bubble data with CSV
without duplicating usage.

### Sanitized audit observations

The audited local state database was about 144 MB and contained 342 composer
records. Bubble history remained for 85 sessions, including user prompts in 83
sessions: 402 prompt rows in total, 342 with timestamps. Seventy of those 85
groups retained usable event timestamps.

Model information was observed for 52 groups, including 16 multi-model groups.
The audit found 397 valid client RPC send/end intervals but only five explicit
turn-duration values. Local non-zero token counters existed on 331 bubbles and
ended on 2026-01-26; only two token-bearing rows overlapped usable model
metadata. No configured CSV file was available during the probe.

## Prompt confidentiality and portability

Detailed prompt bodies for supported harnesses are read only after the user
requests local analysis. JSONL reads are bounded, reject symlinked history
inputs, and use strict UTF-8 decoding; SQLite adapters use read-only database
transactions and parameter-bound session lookups. Every response is bounded
and resolves the requested source machine and session before returning data.
The response travels to the local browser and remains in client memory until
the analysis is closed or another row is selected.

The detailed prompt collection is separate from report publication and is not
written to report revisions, snapshots, merge bundles, sync payloads, JSON, or
CSV. Per-prompt and total-response budgets can truncate the returned text, so
documentation should say **detailed prompt bodies**, not promise that every
body is complete.

This boundary does not mean portable reports contain no prompt-derived text.
The normal collectors can use a first or last prompt as a fallback session
name, notably for some Claude and Cursor rows. Session names are normal report
fields and can therefore appear in revisions, snapshots, merge bundles, JSON,
and CSV. Treat exported reports as potentially containing prompt-derived
titles even though the separate detailed prompt list is local-only.

## Maintenance checklist

When adding or changing a harness adapter:

1. Record whether every metric is recorded, derived, partial, estimated, or
   unavailable.
2. Preserve source-reported active duration separately from elapsed span.
3. Segment tokens and API-value estimates by the model that produced them.
4. Never infer effort from reasoning tokens, thinking blocks, or undocumented
   numeric flags.
5. Keep prompt bodies behind the local on-demand endpoint with explicit item,
   byte, and response budgets.
6. Add source-appropriate fixtures for malformed metrics, open turns, repeated
   events, model changes, lineage gaps, query binding, strict UTF-8, size
   limits, and symlink rejection.
7. Verify that report revisions, snapshots, sync, merge bundles, JSON, and CSV
   contain no detailed prompt collection.
8. Bump the relevant local parser cache version whenever normalized counters,
   lineage, phases, or replay attribution can change for an unchanged source
   file.
