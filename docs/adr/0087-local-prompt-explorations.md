# ADR 0087: Prompt explorations use a bounded corpus and optional browser-local inference

- **Status**: Accepted
- **Date**: 2026-11-03
- **Extends**: 0009, 0010, 0012, 0040, 0084

## Context

The prompt reader makes native, provenance-qualified prompts available through
the existing Session authority. The One Shot explorations compared repeated
wording, semantic families and editorial practices. Their private snapshots,
temporary PostgreSQL service and fixed family IDs cannot be product inputs.
Accepted Memory and generated Session accounts remain retired (ADR 0084).

## Decision

- Explorations consume only the prompts already loaded by the reader. Session
  counts are distinct within that sample, and missing pages, partial histories
  and independent analysis budgets remain visible. A missing follow-up never
  means completion. Native prompt ordinals establish adjacency.
- Lexical analysis is deterministic and bounded to 500 prompts, 80 words per
  prompt, 12,000 candidates and 60 displayed motifs. It excludes recognized
  context and code. It is explicitly not semantic analysis.
- Semantic analysis is optional. A button prepares a version-pinned MiniLM
  multilingual model through Transformers.js 3.8.1 in a dedicated Web Worker.
  Preparation may download public model files from Hugging Face and the pinned
  WASM runtime from jsDelivr. Opening the page does not initiate those downloads.
  The model cache is the browser cache; no embeddings or prompts are persisted.
- The worker accepts only GET downloads of those pinned public assets, with
  credentials and referring-page information omitted. Once preparation succeeds,
  its fetch capability is disabled before any prompt text is sent to it. Inference
  has no network fallback. Cancel terminates the worker; it does not erase already
  downloaded public model assets from browser storage.
- A separate explicit action computes normalized mean-pooled, 384-dimensional
  embeddings locally, bounded to 160 formulations, 48 words/600 characters per
  fragment and 128 model tokens. Every member must match its reference directly
  at cosine 0.84 and pass conservative action/negation guards. The threshold is
  exploratory, not a probability or independently validated semantic judgement.
  Text overlap is character-trigram Jaccard, labelled as such; it does not claim
  PostgreSQL `pg_trgm` equivalence.
- Inclusion decisions are inspectable, ephemeral and exportable with model and
  corpus provenance. Changing the loaded corpus invalidates the analysis. The
  engine remains the sole usage-store writer; no new store, service or Memory
  lifecycle is introduced.

## Consequences

Inference does not occupy the UI thread, needs no provider account and does not
send prompts to a hosted model. The optional initial download is substantial;
network, browser storage or WASM failure is visible and leaves lexical analysis
available. Worker/model code is loaded lazily and excluded from the initial
report dependency closure. Device performance and approximate grouping quality
remain limits of this exploratory feature.

## Rejected alternative

Copying One Shot's private snapshot and temporary PostgreSQL process would make
the result stale and machine-specific. Restoring the retired Memory system would
add a second data authority without being necessary for descriptive exploration.
Neither is part of this feature.

## Evidence

- [Lexical projection](../../apps/web/src/lib/features/prompts/prompt-exploration.ts)
- [Semantic model and grouping](../../apps/web/src/lib/features/prompts/semantic-model.ts)
- [Worker](../../apps/web/src/lib/features/prompts/semantic.worker.ts)
- [Download boundary](../../apps/web/src/lib/features/prompts/semantic-network.ts)
- [Transformers.js model configuration](https://huggingface.co/docs/transformers.js/v3.8.1/custom_usage)
- [Transformers.js environment](https://huggingface.co/docs/transformers.js/v3.8.1/api/env)
