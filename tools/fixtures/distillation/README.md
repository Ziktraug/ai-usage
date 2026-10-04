# Synthetic distillation corpus

These nine compact Codex JSONL sessions and their independent factual
expectations were authored before model generation. Every path, project,
session, command result, and credential-shaped string is synthetic. A recorded
command is data: this corpus does not execute those commands.

Check source identities, digests, bounded sizes, tool-call/result pairing, and
expectation references without a provider or real local store:

```sh
bun tools/fixtures/distillation/check-corpus.ts
```

`corpus.json` contains review checkpoints rather than expected model answers.
Each positive checkpoint points to exact source events. Each event mapping has
a fixture identity and one-based source line; the Codex native identity remains
`session_meta.payload.id`, and calls retain their native `call_id`. Top-level
event IDs are fixture annotations, not a claim that Codex always supplies an
event identity. Runtime evidence IDs must be mapped back to these source events.

| Case | Distinction under evaluation |
| --- | --- |
| `multi-attempt` | Initial failure, insufficient first patch, second patch, observed focused pass; production cause remains unverified. |
| `unresolved-failure` | Dependency and registry failures prevent reproducing the originally reported parser defect. |
| `explicit-decision` | The operator makes a decision; its document is added; runtime enforcement remains deferred. |
| `abandoned-proposal` | The suggested vector index is rejected; the operator chooses existing FTS without implementation. |
| `claimed-success` | The patch is observed; the assistant's test-pass claim has no recorded test command or result. |
| `trivial-no-lessons` | A spelling fix warrants no manufactured lesson, decision, or Memory candidate. |
| `interrupted` | A command is running when the session is interrupted; its eventual outcome remains unknown. |
| `truncated-output` | Exit code one and a failing test are visible; the actual assertion is absent from truncated output. |
| `malicious-data` | Hostile instructions remain tool-result data; a fake secret must be redacted before transmission and persistence. |

For the extraction spike, prepare evidence through the production normalizer
and redactor, then send only the evidence and extraction contract to the active
model. Keep this expectation manifest outside that generation prompt. Never
send the raw malicious-data fixture before its fake-secret canary is redacted.

After generation, review each checkpoint against both the structured analysis
and the source event. Record supported, missed, contradicted, or not assessable,
with the relevant generated claim and evidence IDs. Existing references alone
do not demonstrate support. Useful entry points must retain recorded filenames,
commands, and errors when relevant; their current validity is unknown.

The integrity command does not evaluate an extractor, prove semantic accuracy,
or prove that a live-store upgrade is safe. A real generation is required for
the spike. A second model's agreement is a review aid, not independent ground
truth or a calibrated precision measurement. These small, deliberate cases do
not establish product quality on real sessions.

The first real active-harness generations and their checkpoint review are
recorded in `evaluation.md` and `evaluation.json`. `generated/initial/` retains
the unchanged model outputs and explicitly labeled review-time packets; its
manifest records hashes and the unavailable initial-input provenance.
