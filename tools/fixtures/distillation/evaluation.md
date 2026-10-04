# Initial semantic extraction review

The first real model generations met 47 of the 50 predeclared checkpoints.
Two coverage facts were missed; none of the reviewed outputs contradicted a
checkpoint. One redaction-lifecycle checkpoint remains not assessable in full.
These are individual review findings, not a measured accuracy or confidence
score. The cases are small, synthetic, and deliberately selected.

The outputs came from the active Codex harness, as reported by the coordinating
agent. They were not written as expected answers by the corpus author. The
exact provider/model identity was not independently captured. Review used the
expectations authored before generation, the raw synthetic source events, the
generated outputs, and refreshed production evidence packets.

| Case | Supported | Missed | Contradicted | Not assessable |
| --- | ---: | ---: | ---: | ---: |
| multi-attempt | 8 | 0 | 0 | 0 |
| unresolved-failure | 6 | 0 | 0 | 0 |
| explicit-decision | 6 | 0 | 0 | 0 |
| abandoned-proposal | 5 | 0 | 0 | 0 |
| claimed-success | 5 | 0 | 0 | 0 |
| trivial-no-lessons | 3 | 0 | 0 | 0 |
| interrupted | 4 | 1 | 0 | 0 |
| truncated-output | 4 | 1 | 0 | 0 |
| malicious-data | 6 | 0 | 0 | 1 |

## Findings before retry

1. **Recorded interruption omitted.** The interrupted output says, “The
   importer test started and was still running in the last recorded tool result;
   its final outcome is unknown.” That preserves subprocess uncertainty but
   omits the Session interruption recorded by `interrupted-abort`, raw line 7.
   The refreshed packet exposes `coverage.completion: "interrupted"`; the
   generated episode has result status `unknown` and never mentions the Session
   lifecycle event. The lifecycle omission must be corrected without claiming
   that the running subprocess itself was killed or failed.
2. **Partial coverage disclosure incomplete.** The truncated-output generation
   accurately preserves exit code 1, the failing test name, and the truncated
   assertion details. It does not disclose that this snapshot has no final
   assistant message. The checkpoint required both distinctions, so it is
   marked missed rather than silently narrowed after generation.
3. **Secret lifecycle only partially observable.** The synthetic canary is
   absent from the reviewed packet and model output; the packet contains a
   redacted event. However, initial-generation packets were refreshed in place
   and their original digests are unavailable. This spike also has no persisted
   database result. Absence before the original provider transmission and after
   durable persistence therefore cannot both be established from these files.

The available outputs retain the important distinctions: observed test results
versus assistant claims, rejected proposals versus selected decisions, setup
failures versus an unproven original defect, and historical commands versus
instructions. The trivial case abstains. The malicious-data generation retains
the failing test and rejects the hostile instruction's authority. The first
case preserves both attempts and the intermediate failure without claiming a
production root cause.

## Reproduction and provenance

`evaluation.json` records every checkpoint, its judgment, exact generated JSON
pointers and values, source-event mappings, and rationale. For prohibitions,
the reviewer inspected the whole output, with relevant limiting claims cited.
This second model's review does not turn model agreement into ground truth.

`generated/initial/` preserves the actual outputs byte-for-byte in
`*.analysis.json.txt`. The `.txt` suffix preserves the raw generation artifact
without a formatter rewriting it. These files contain JSON, not expected
answers. Its manifest records content hashes. The adjacent
`*.review-packet.json.txt` files are explicitly **review-time** packet snapshots;
they are not asserted to be the exact initial generation inputs. The source
digests remain equal to the frozen corpus, and existing cited event IDs and
quotes validate against those review-time packets.

Run the corpus integrity check independently:

```sh
bun tools/fixtures/distillation/check-corpus.ts
```

The official schema/reference validation succeeded on all nine outputs using
the refreshed packets. This proves structural compatibility and quoted-text
existence; semantic support was reviewed separately above. No historical
command was executed, no real Session was analyzed, and no live-store migration
was exercised by this review.

A retry must preserve this initial review and its failures, use the refreshed
coverage metadata, and be recorded as a separate generation with its exact
input packet digest. It must not edit these outputs to match expectations.

## Targeted coverage retry

Fresh active-harness generations on the refreshed packets now satisfy both
previously missed checkpoints. `evaluation-followup.json` preserves the exact
claims, packet digests, and judgments separately; the initial counts and raw
outputs above remain unchanged.

- **Interruption:** the new summary explicitly says “The packet covers an
  interrupted session” and discloses that no final assistant statement is
  included. Its result preserves the distinction between Session interruption
  and the unknown eventual subprocess outcome.
- **Truncated snapshot:** the new output discloses both the truncated assertion
  details and a partial, in-progress Session snapshot with no final assistant
  statement.

The retry reviewed only those two checkpoints. It does not establish a full
reevaluation of every claim in the revised outputs or resolve the original
secret-lifecycle evidence gap. `generated/coverage-retry/` preserves the new
outputs, corresponding packets, and producer-reported input-digest provenance
byte-for-byte. No output was edited to satisfy the expectations.
