# ai-usage Context

This context describes the local AI usage reporting domain. The CLI reads local history from installed AI coding tools and turns it into usage rows, analytics, CSV, and quota output without calling provider APIs.

## Language

**Harness**:
An installed AI coding tool whose local history can be collected, such as Claude Code, Codex, OpenCode, or Cursor.
_Avoid_: source, tool, integration

**Collection source**:
An independently detected, scheduled, and policy-controlled contribution to the normalized local store. A harness may expose more than one collection source: Codex sessions and Codex usage limits have separate policy and cadence.
_Avoid_: harness, refresh task, report loader

**Source policy**:
The persisted enabled/disabled choice for one collection source. Policy is independent from whether input is detected, whether work is running, and how the last run ended. Disabling pauses future collection and never deletes stored contributions.
_Avoid_: availability, lifecycle, deletion

**Source publication**:
The separate stored-only job that reconciles durable contributions into an immutable served report revision. Requests advance monotonic demand even while publication is queued or running; only a successful attempt acknowledges the generations it captured. A source run may be successful without changing the semantic revision.
_Avoid_: collection run, browser refresh

**Enrichment contribution**:
A versioned, validated value owned by one enricher and keyed to a stable base usage-row identity. Report reads compose it with the producer-owned base row; neither writer replaces the other's durable data.
_Avoid_: JSON patch, enriched base row

**Local history**:
The files or databases written by a harness on this machine. It is the only live collection input; a caller may also supply an explicit portable snapshot or previously imported merge bundle. Provider APIs are not called.
_Avoid_: remote usage, cloud billing data

**Session**:
A single conversation or agent run found in local history. A session can include child sessions, such as Codex subagent threads.
_Avoid_: chat, transcript, thread

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

**Project source**:
A machine-scoped project path carried by a usage row. Locally observed paths may be canonicalized and inspected; paths from snapshots or merge bundles are opaque labels and never authorize local filesystem access. Its identity combines the machine and source path so similarly named folders stay distinct.
_Avoid_: project group, repository scan root

**Project group**:
An explicit local configuration that presents multiple project sources as one named project in reports.
_Avoid_: project source, inferred alias

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

**Provider**:
The billing or subscription route inferred for a usage row, such as Claude API, Claude sub, Codex API, Codex sub, or Cursor sub.
_Avoid_: vendor, platform

**Cost approximation**:
A hypothetical API-rate cost calculated from local token counters and the editable pricing table. Subscription products bill differently, and unknown public rates remain unpriced.
_Avoid_: bill, invoice, actual spend

**Quota snapshot**:
The newest local Codex `token_count.rate_limits` event used to render subscription quota windows.
_Avoid_: billing limit, provider quota API
