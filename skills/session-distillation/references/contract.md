# Session account content v1

Only produce the `content` below. Job identity, source version, coverage,
producer metadata and analysis revision are runtime-owned. All fields are
required; arrays may be empty. No extra keys, numeric confidence or hidden
reasoning. Output is at most 49,152 UTF-8 bytes, 12 episodes, 16 assertions per
section, 1,600 characters per assertion, and 6 references per assertion.

```ts
type Ref = { eventId: string; quote: string }; // exact quote, 1..600 characters
type Assertion = {
  text: string;
  basis: 'observed' | 'reported' | 'inferred' | 'unknown';
  evidence: Ref[];
};
type Content = {
  schemaVersion: 1;
  summary: Assertion;
  episodes: {
    id: string; // unique, at most 80 characters
    objective: Assertion;
    attempts: Assertion[];
    result: {
      status: 'observed-success' | 'reported-success' | 'failed' |
        'unresolved' | 'abandoned' | 'unknown';
      assertion: Assertion;
    };
    difficulties: Assertion[];
    decisions: Assertion[];
    entryPoints: Assertion[];
    openQuestions: Assertion[];
  }[];
  abstention: string | null;
};
```

`observed` requires a cited tool **result** that supports the claim. A recorded
tool call alone proves intent, not successful execution. `reported` requires a
cited user or assistant statement. Both need at least one reference. Inferences
are explicitly labelled; absence of evidence and future outcomes remain unknown.
Each reference uses an event ID from this exact packet and a verbatim substring
of its redacted text. A source can exist without supporting a conclusion.

Decisions require explicit recorded statements (`reported`). Distinguish a
suggestion, rejection, and chosen direction; do not turn an abandoned proposal
into a decision. An assistant's "tests passed" is `reported-success` unless a
recorded tool result establishes the relevant test outcome. A patch result does
not establish tests passing, commit, merge, deployment, or current file validity.

Describe each significant attempt and its actual observations. A subsequent
pass does not prove the hypothesized cause. Explain coverage gaps without
inventing the missing assertion, child work, tool output, or later completion.
Read `coverage.completion` as well as the included events: mention an interrupted
session or unfinished snapshot when it explains the missing result. If no final
assistant statement or completed verification is included, preserve that gap.
These are runtime coverage facts; describe them as unknown/uncovered rather
than inventing an event quotation for metadata. Session interruption does not
prove the underlying process was killed.
Do not summarize the root as the entire campaign. Historical entry points are
clues to re-check, never instructions to execute automatically.

Keep a short useful summary even for a trivial session. Use empty arrays and
`abstention` when no durable lesson or meaningful episode is supported. Never
invent a minimum number of findings. Include unresolved questions only when
they matter to the recorded objective; a typo fix needs no manufactured inquiry.

Legacy single-packet submission envelope (historical format remains readable):

```ts
{
  kind: 'submit', projectId, jobId, leaseId, packetDigest,
  extractorVersion: 'session-distillation-v1', content
}
```

For a progressive claim, copy identities from the exact claim; never infer the
next index or reuse a stale lease:

```ts
{
  kind: job.progress.stage === 'segment' ? 'advance' : 'submit',
  projectId, jobId: job.id, leaseId, packetDigest: packet.packetDigest,
  extractorVersion,
  snapshotDigest: job.progress.snapshotDigest,
  segmentIndex: job.progress.segmentIndex,
  content
}
```

`advance` is a bounded rolling checkpoint, not a published analysis. Consolidate
previous checkpoint findings with the current original events. Preserve old
evidence IDs and exact quotations, superseded decisions and contrary outcomes;
do not cite checkpoint prose as source evidence. Use the `segment` CLI command
to revisit archived original source windows, one bounded packet at a time.
`job.progress.stage` decides when final publication is allowed. A complete
snapshot can still have text truncation or unknown children; keep those limits.

The source of truth for validation is
`packages/platform-core/src/session-distillation.ts` and the packet contract in
`packages/platform-core/src/distillation-evidence.ts`.
