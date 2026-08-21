# Design: A Session-Intent Signal From First Prompts

> Deliverable of **plan 084**. Spike output: architecture analysis, offline
> prototype results on this machine's real store, and a recommendation. No
> production code, schema, or bundle version was changed.
>
> Written at `bc251748` (base `5e4cf954`). The plan's drift check over
> `usage-row.ts`, `types.ts`, `merge-bundle.ts` and `local-collectors/src/`
> returned empty — the "Current state (verified)" excerpts still hold.
>
> **Privacy discipline observed throughout:** every prototype ran locally
> against the store opened `readonly`, sent nothing over any network, used no
> embedding or inference service, and wrote only to the session scratchpad.
> This document quotes no prompt text; the only prompt-derived strings below
> are single-word cluster labels, which is what the plan permits.

---

## Verdict

**Do not build prompt-derived intent clustering.** This is plan 084's
anticipated "not worth building" outcome. Three measurements support it; the
second is decisive on its own, and the other two are corroborating rather
than independently fatal:

| Measurement | Result | Why it is fatal |
|---|---|---|
| **Coverage** | **Attainable**, not just realised (§2.1a): Codex's own cache holds a usable first prompt for **17.2%** of cached sessions; Claude's history yields **≤165** sessions; Cursor is unmeasured. Best measured total ≈ **14.5%** of rows, upper bound ≈34% if Cursor delivered perfectly | An aggregate like "40% of this month was refactoring" would be computed from a seventh of the work, silently |
| **Novelty over titles** | Top-term **recall 86–99%** wherever clusters are coherent — on raw first prompts as much as on titles (§2.7) | A coherent cluster essentially never contains a session that lacks the cluster's own label word. It cannot group two sessions with the same intent and different vocabulary — which is the entire job |
| **Raw prompts are worse input than the derived label** | Same 89 sessions: raw text averages 180.6 content tokens vs. 14.7 for the 200-char derivation, and produces **more** singletons (17 vs 5) and **worse** usable coverage (48.3% vs 68.2%) | The extra text is IDE context, pasted logs, and URLs. Architecture A would ship more prompt text for a *weaker* signal |

**Two claims from the first draft are retracted here**, both after
adversarial review, and both corrected in place so the record shows what the
evidence supports:

1. *Stability is not a third killer.* It was presented as one on the strength
   of ARI figures from k-means. Direct measurement (§2.8) shows churn of
   **≥6.7%** under deterministic leader clustering — not the two-thirds the
   ARI reading implied. Stability is a constraint on *algorithm choice*
   (k-means is disqualified; a per-session classifier is stable by
   construction), not a reason the direction fails.
2. *Coherent clusters are not literally keyword searches.* They have ~50%
   precision against the equivalent search (§2.6), so a cluster is a strict
   subset, not the same set. The surviving — and sharper — claim is the
   **recall** figure: a coherent cluster essentially never groups a session
   that lacks the cluster's own label word.

The plan's own framing anticipated a "B, probably" answer. The data says the
question is upstream of the privacy fork: **there is not enough signal to be
worth a privacy decision at all.** Section 5 proposes the thing the data
*does* support instead, which needs no privacy decision.

The standing deferral in `plans/README.md` — *"Campaigns grouped by user
intention require a separate privacy and domain-model decision; no heuristic
classification is added"* — should be **upheld and closed**, converting it
from an open caution into a settled, evidenced decision.

---

## 1. Step 1 — the privacy fork, with privacy analysis per architecture

### The boundary as written

`README.md:236`: *"Detailed prompt bodies are read only on demand from the
source machine's local history and may be truncated by safety budgets; that
separate prompt collection is **not added to report revisions, snapshots,
sync payloads, or exports**. Normal session names can still come from
source-provided or prompt-derived titles and are portable report fields."*

`docs/session-analysis-sources.md:376–383` is more explicit still: *"This
boundary does not mean portable reports contain no prompt-derived text… Session
names are normal report fields and can therefore appear in revisions,
snapshots, merge bundles, JSON, and CSV."*

So the boundary is not "no prompt-derived text is portable". It is a
**class distinction**: *title-class* (bounded, derived, one line) is portable;
*body-class* (the prompt itself, budget-truncated) is local and on-demand.
Every architecture below is judged against that distinction.

### A. Portable truncated prompt on the row

`firstPrompt` (≈200 chars, opt-out flag) on `UsageRowInput`/`UsageRow`,
bundle v4, optionally in CSV.

**Privacy analysis — the strongest reason to refuse.** A 200-char prefix of a
raw prompt is *body-class*, not title-class: it is the user's words
verbatim, cut at a byte offset with no derivation. It would travel into
`served_report_revisions`, snapshots, `/sync` merge bundles, JSON output, and
— once a column is added — CSV. That is precisely the sentence at
`README.md:236` and the checklist item at
`docs/session-analysis-sources.md:407–408` ("Verify that report revisions,
snapshots, sync, merge bundles, JSON, and CSV contain no detailed prompt
collection"). It also *auto-leaks*: `serializeUsageRow`
(`report-data.ts:369`) spreads the row, and `enrichSessionPresentationRow`
(`session-query.ts:956`) spreads the serialized row, so the field reaches
revisions and the session projection with no further edit. Only the CSV is
opt-in (`csv.ts:23–61` is an explicit closed column list).

**And it buys almost nothing here — for two separate reasons.**

*For Codex,* `session.firstUser` is *already*
`deriveSessionLabelFromPrompt(text)` (`internal/codex-history.ts:546`) — the
first sentence, bounded to 200 characters — and that value is *already*
portable as `row.name` (`codex-history.ts:442`). Measured: **only 6.3% of
first-prompt titles reach 199+ characters**, so for 94% of those rows the
existing title is the complete derived first sentence, not a truncation. A
new 200-char field would duplicate a field that already ships.

*For Claude,* where no prompt-derived title exists, a raw prompt genuinely
would be new text — **51.6% of Claude first prompts exceed 200 characters**
(§2.7). But §2.7 also measures what that extra text is worth, and the answer
is *negative*: on the same 89 sessions, clustering the raw prompts produced
more singletons and worse coverage than clustering their 200-char
derivations, because the surplus is IDE-context boilerplate, pasted logs, and
URLs. Architecture A would move more sensitive text into portable payloads in
exchange for a measurably weaker signal.

**Recommendation: refuse.** Maximum privacy cost; duplicative on the harness
that has the signal, and actively counter-productive on the harness that
does not.

### B. Local-only derived label as an enrichment contribution

An enricher persists a short derived label + content hash into
`usage_row_enrichments`; the raw prompt never enters a row.

**Privacy analysis — and a correction to the plan's own framing of this
option.** The pattern is load-bearing: `CONTEXT.md:47–49` defines an
*enrichment contribution* as "a versioned, validated value owned by one
enricher and keyed to a stable base usage-row identity", and `rtk.savings`
(`packages/usage-store/src/index.ts:866–988`) implements it.

**But "local-only" does not follow from "enrichment contribution", and the
plan's option-B description is wrong on this point.** What
`prepareMergeRow` (`index.ts:918–929`) and `stripRtkSavings`
(`index.ts:902–913`) keep out is the *base row's `contentHash`* — i.e. the
row's **identity**, so an enrichment never re-supersedes a row across the
fleet. The value itself travels:

- `readReportRows` composes `{ ...base, ...contribution }` (`index.ts:2516–2517`);
- `exportLocalMergeBundle` (`index.ts:3255–3270`) is *defined as*
  `queryReportRows(...)` piped into `createUsageMergeBundle` — so it exports
  the **composed** rows;
- `serializeUsageRow` spreads the row (`report-data.ts:369`), and
  `enrichSessionPresentationRow` spreads the serialized row
  (`session-query.ts:956`), so the value reaches revisions and the session
  projection too.

The proof is `rtk.savings` itself: its four fields sit on `UsageRow`
(`types.ts:73–76`), are allow-listed in `SERIALIZED_USAGE_ROW_KEYS`
(`serialized-usage-validation.ts:17–61`), and are emitted as five CSV columns
(`csv.ts:23–61`). RTK enrichments are fully portable today, by design.

So architecture B as specified in plan 084 has **two** sub-variants, and the
maintainer must pick one:

- **B1 — portable derived label.** Same exposure surface as a title-class
  field: revisions, snapshots, merge bundles, JSON, CSV. Needs the
  `SERIALIZED_USAGE_ROW_KEYS` entry and a `hasValidSerializedUsageFields`
  predicate, and the **merge-bundle v4 ladder after all** (adding an unknown
  key to an exported row fails `hasOnlyKeys` on a peer running the old
  version). Defensible only if the label is a closed enum.
- **B2 — genuinely local-only.** Requires an explicit
  `stripSessionIntent(row)` at the composition boundary for every
  *portable* consumer — `exportLocalMergeBundle`, the snapshot writer, and
  the CSV column list — while leaving it composed for the in-app read path.
  That is a new, deliberately asymmetric seam, and asymmetric strip rules are
  exactly the kind of thing that rots silently: a future export path added
  without the strip leaks the field with no test failing.

Either way, **B is not free of the portability question**, and B2's cost is
higher than the plan assumed. The one genuinely free part survives: a
`CollectionSourceDefinition` with `kind: 'enricher'`
(`source-control.ts:93–100`) makes the enricher toggleable through the
existing `sourcePolicies` override (`source-control.ts:137–176`) with zero
config-schema work.

**Recommendation: B1 with a closed enum if intent is ever built — and do not
build it now, because §2 shows the label it would carry is not worth
carrying.** B1 over B2 because an honest portable field with a validated
closed vocabulary is safer than an asymmetric strip nobody will maintain. §3
specifies the slice on that basis.

### C. On-demand analysis, never persisted

Intent computed when the user asks, like prompt bodies in the drawer today.

**Privacy analysis: no change at all.** The path already exists and is fully
bounded — `sessionContract.detail` (`packages/web-contract/src/session.ts:116–120`)
→ `getLocalSessionDetailForServer` (`apps/web/src/server/session-detail.server.ts:54–119`),
gated by `authorizeLocalSessionAnchor` on `sourceAuthority === 'local-observed'`
(`apps/web/src/server/local-session-authority.server.ts:11`), anchored to an
immutable revision, with the server — not the browser — choosing the local
target.

**But it cannot answer the question the feature exists for.** Aggregates
("40% of this month was …") are impossible over a per-session on-demand read.
C is what ships today; it is correct and it is not intent.

### Recommendation on the fork

**C (status quo) stands; A is refused; B is the right shape but is not worth
building for this signal.** The fork is real, but the prototype moved the
decision upstream of it: no architecture is worth adopting when the payload
is the payload measured in §2.

---

## 2. Step 2 — prototype results on real local data

**Method.** `usage-store.sqlite` opened `readonly`; `row_json` parsed for
`name`, `titleSource`, `harness`, `subagent`, `source.rootSourceSessionId`
only. Three techniques and two baselines, all implemented from scratch in
TypeScript with no dependencies, no network, no inference. Scripts in the
session scratchpad, not committed.

### 2.1 What signal exists at all

8,082 active rows, 2025-06-10 → 2026-08-20, four harnesses.

| `titleSource` | rows | share |
|---|---|---|
| `id` | 2,414 | 29.9% |
| `agent-role` | 2,115 | 26.2% |
| *(absent)* | 1,461 | 18.1% |
| `ai` | 1,089 | 13.5% |
| **`first-prompt`** | **1,003** | **12.4%** |

Broken down by harness, the concentration is total:

| harness / source | rows |
|---|---|
| Codex / `first-prompt` | **1,003** |
| Codex / `id` | 2,033 |
| Codex / `agent-role` | 1,700 |
| Cursor / *(absent)* | 1,460 |
| OpenCode / `ai` | 952 |
| Claude Code / `agent-role` | 415 |
| Claude Code / `id` | 381 |
| Cursor / `ai` | 137 |

**Every prompt-derived title in this store is Codex.** Cursor's
`cursorTitleSource` (`collectors/cursor.ts:27–33`) *can* emit
`'first-prompt'`, but 1,460 of its 1,597 rows carry no `titleSource` at all
and 137 carry `'ai'` — its composer names win. Claude structurally cannot
emit it (`ClaudeReportFacts['titleSource']` is narrowed to
`'agent-role' | 'ai' | 'id'` at `claude-session-facts.ts:48`). OpenCode never
reads a first prompt in the collector at all.

Clusterable corpus after dropping titles with <2 content tokens: **963**
(2026-02-14 → 2026-08-20). Vocabulary after pruning hapax and >40%-document
terms: 606 of 2,367 raw terms; 99.7% of documents retain ≥1 in-vocabulary
term.

### 2.1a Attainable coverage, not just realised title provenance

The 12.4% above measures *which title source won*, which is not the same as
*where a first prompt exists*. The attainable denominator matters because it
is the coverage the rejected architecture would actually get, so it was
measured separately.

| Harness | rows | subagent | realised `first-prompt` | attainable prompt signal |
|---|---|---|---|---|
| Codex | 4,736 | 1,900 | 1,003 | **17.2% of cached sessions** hold a non-empty `firstUser` (669 of 3,898 cached; 1,551 carry an agent nickname instead) |
| Cursor | 1,597 | 0 | 0 | **unmeasured** — see §7 |
| OpenCode | 952 | 0 | 0 | **0 prompts.** 952 harness-authored `session.title` values, which are a title signal but not a prompt |
| Claude Code | 797 | 415 | 0 | **≤165 sessions** — 165 of 174 retained transcripts yield a usable first prompt (§2.7), but the store holds 797 Claude rows, so most have no retained transcript |

**Attainable ≈ realised for Codex**: its cache holds a usable first prompt
for 17.2% of sessions, and 17.2% is almost exactly what already surfaces as
`first-prompt` titles. Wiring Codex harder buys nothing; the prompt simply
is not there for the other 83%, because most of those sessions are subagent
invocations with a nickname instead.

Best measured total for a *prompt-derived* signal: ~1,003 (Codex) + ≤165
(Claude) ≈ **14.5% of rows**. Upper bound if every Cursor row also delivered
a first prompt: ≈34%. Either figure is far from the ~50% §4.1 names as the
threshold where an aggregate stops being misleading.

This is a weaker coverage argument than the first draft's flat 12.4%, and it
is stated as a range on purpose. **Coverage alone would not close the
question; §2.6 is what closes it.**

### 2.2 Baselines — what "grouping by existing titles" already gives

| Baseline | clusters | largest | singletons | in clusters ≥10 |
|---|---|---|---|---|
| B0 — group by the title's first content word | 212 | 189 | 126 | 61.8% |
| B1 — group by exact normalised title | 836 | 18 | 782 | 3.0% |

B0 is the bar any technique must clear: it is free, deterministic, and needs
no privacy decision whatsoever.

### 2.3 Technique A — intent verb lexicon (12 intents, first match wins)

13 buckets, no singletons, 96.5% of items in buckets ≥10 — the best coverage
of anything tested. And useless:

```
(unmatched) 371   review 361   release 90   add 36   fix 30   update 17
ask 13   plan 11   document 8   refactor 7   remove 7   test 6   analyze 6
```

**Two buckets hold 76% of the corpus** ("unmatched" 38.5%, "review" 37.5%);
the ten intents a user would actually want to compare hold 3–9% *combined*.
Lexicon coverage is 61.5% of titles, and only 58.8% of those matches were the
title's first token — i.e. 41% of the time the "intent verb" was found
somewhere in the middle of a sentence, which is how "review" swallowed a
third of the corpus. Coherence margin (mean intra-cluster cosine minus mean
inter-cluster) is **0.025** — essentially none.

NMI with B0 = 0.457, ARI = 0.226.

### 2.4 Technique B — TF-IDF + spherical k-means

| k | clusters | largest | coherence margin | NMI vs B0 | ARI vs B0 |
|---|---|---|---|---|---|
| 6 | 7 | 347 | 0.047 | 0.325 | 0.073 |
| 10 | 11 | 153 | 0.099 | 0.401 | 0.105 |
| 14 | 15 | 166 | 0.080 | 0.379 | 0.075 |
| **20** | 21 | 116 | **0.169** | 0.448 | 0.103 |
| 30 | 31 | 80 | 0.149 | 0.518 | 0.189 |

Then the top-3 terms of the largest clusters at the best k:

```
n=116  "cette branche review"     n=90  "moi est dis"
n=66   "je mon viens"             n=64  "implement mattpocock-skills …"
n=59   "la rewrite effect"        n=54  "projet ai fais"
n=51   "le dans commit"           n=50  "des de ai"
```

**Half the largest clusters are named by pronouns and articles.** The corpus
is bilingual — a function-word probe finds French tokens in **81.1%** of
clusterable titles — and TF-IDF over a bilingual corpus separates *language
and phrasing habit* before it separates work type. A cluster called `cette`
is not a facet a person can use; it is a stylistic artefact.

This is fixable in principle (bilingual stoplists, stemming per language),
but it is a standing maintenance cost on a signal that already fails on
coverage and stability, and every fix pushes the clusters further toward
§2.6's finding.

### 2.5 Technique C — embedding-free lexical agglomerative (average-link)

| threshold | clusters | singletons | in clusters ≥10 | coherence margin | NMI vs B0 |
|---|---|---|---|---|---|
| 0.2 | 124 | 12 | 58.5% | 0.336 | 0.586 |
| 0.3 | 255 | 69 | 30.6% | 0.496 | 0.662 |
| 0.4 | 432 | 236 | 18.6% | 0.580 | 0.717 |
| 0.5 | 567 | 410 | 12.3% | 0.807 | 0.747 |

Read the last two columns together: **coherence and novelty move in
lockstep, in opposite directions from usefulness.** Every increment of
cluster quality is an increment of agreement with the free first-word
baseline, and a collapse in coverage. At the only threshold with usable
coverage (0.2), 12 singletons and a 107-item catch-all; at the threshold
where clusters are trustworthy (0.4–0.5), 25–43% of sessions are singletons
and only 12–19% land in a group big enough to say anything about.

### 2.6 The decisive test — what does a cluster add over a keyword search?

Take each cluster of ≥5 members and its single highest-weighted term, then
compare the cluster against the set of all documents containing that term:

- **recall** = share of the *cluster* the keyword search also finds;
- **precision** = share of the *search result* that is inside the cluster;
- **Jaccard** = overlap of the two sets.

| Clustering (agglomerative) | clusters ≥5 | recall | precision | Jaccard |
|---|---|---|---|---|
| th=0.2 | 59 | 86.4% | 54.3% | 48.8% |
| th=0.3 | 51 | 94.7% | 53.0% | 51.1% |
| th=0.4 | 36 | **98.3%** | 50.6% | 49.9% |
| th=0.5 | 20 | **98.6%** | 42.7% | 42.3% |

Per-cluster at th=0.4: `cette` r100/p30, `pr` r100/p21, `message` r100/p56,
`rebase` r86/p63, `ci` r100/p76, `changes` r100/p52.
(k-means for comparison: recall 56.6% at k=10, 59.5% at k=20 — but those are
the incoherent clusters of §2.4, named after pronouns.)

**The first draft over-claimed here and is corrected.** It said the coherent
clusters "*are*" keyword searches. Precision of ~50% shows they are not: the
keyword search returns roughly twice as many sessions as the cluster, so the
cluster is a *strict subset*, not the same set.

What the numbers actually establish is narrower and still decisive:

> **Recall approaches 100%. A coherent cluster essentially never contains a
> session that does not already carry the cluster's own label word.**

That is the property that matters for the feature. An intent facet is
supposed to group *"add retry to the uploader"* with *"make the upload
survive a flaky network"* — same intent, no shared vocabulary. Lexical
clustering provably cannot: every member it groups already shares the word.
It is a **sub-division of a keyword search**, splitting a term's matches
roughly in half on secondary vocabulary — which is a refinement of search,
not a discovery of intent, and it produces buckets whose boundary a user
cannot predict or name.

So the answer to `docs/future-work.md`'s decisive question is: clusters do
not beat the titles in the way an intent feature needs. They cannot reach
past the words already present.

### 2.7 The control experiment — clustering ACTUAL first prompts

§2.2–2.6 clustered stored titles. For Codex that is not a proxy — the title
*is* `deriveSessionLabelFromPrompt(firstPrompt)` — but it says nothing about
the harnesses whose prompts are hidden behind a different title source. So
the decisive tests were re-run against **raw first prompts read directly from
local Claude history**, read-only, under the documented budgets.

**Measured read cost** (the plan's STOP condition asks for this rather than
raised budgets — no budget was raised, and none needed to be):

| | |
|---|---|
| Transcript files | 174 |
| Total bytes | 280.5 MiB (byte budget 1 GiB — `history-budgets.ts:2`) |
| Per-file | p50 452 KiB, p90 5.0 MiB, max 19.8 MiB (line budget 8 MiB) |
| Files over the 1 GiB byte budget | **0** |
| Files dropped by the 100,000-record cap (`claude-session-facts.ts:23,649`) | **0** |
| Wall time to read all of it and extract first prompts | **230 ms** |
| Sessions with a usable first human prompt | 165 (74 sidechain, **91 root**) |
| Files with no usable human prompt | 9 |

So Claude first prompts *are* obtainable inside the documented bounds, at
negligible cost. That is the one attractive fact in the spike, and it is why
the rest of this section matters so much.

**Raw prompt length vs. the 200-char derived label** (91 root sessions):
min 4, p25 92, **p50 212**, p75 392, p90 5,256, max 26,415 characters.
**51.6% exceed 200 characters** — so for Claude, unlike Codex, a raw prompt
really would carry text the derived label does not.

**And that surplus text makes clustering worse.** Both views of the *same* 89
clusterable sessions, same algorithm, same thresholds:

| | raw first prompts | 200-char derivation of the same prompts |
|---|---|---|
| mean content tokens/doc | **180.6** | 14.7 |
| vocabulary | 946 | 120 |
| th=0.2: clusters / singletons | 33 / **17** | 21 / **5** |
| th=0.2: coverage in clusters ≥5 | **48.3%** | **68.2%** |
| th=0.2: top-term recall | **90.7%** | 83.3% |
| th=0.4: top-term recall | **94.1%** | **100.0%** |
| baseline B0 (first token) coverage ≥10 | 34.8% | 34.8% |

Two readings, both bad for the direction:

1. **Top-term recall is 83–100% on raw prompts too.** §2.6's finding is not
   an artefact of clustering titles. Feeding the clusterer twelve times more
   text does not stop its clusters from being keyword filters. The largest
   raw-prompt clusters are labelled `ide opened file`, `http 127.0.0.1 …`,
   `git doit ##` — IDE context boilerplate, a localhost URL, and a markdown
   heading marker.
2. **The extra text is noise.** Raw prompts produce three times as many
   singletons and 20 points less usable coverage than their own truncations.
   This is the measurement that turns "architecture A is a privacy cost" into
   "architecture A is a privacy cost *and* a quality regression".

**Sample-size caveat, stated plainly:** 91 root sessions is small, and it is
all this machine's Claude history holds. It is enough to refute "raw prompts
will cluster better than titles" — the effect runs the wrong way and is
large — but it is not enough to characterise raw-prompt clustering in
general.

### 2.8 Stability — a first-draft claim, corrected

The first draft reported ARI 0.209 (two k-means initialisations on identical
data) and ARI 0.330 (older-half labels after the corpus grows) and concluded
that "adding new sessions rewrites roughly two-thirds of existing labels".
**That inference was wrong, and it is retracted.** ARI measures adjusted
pairwise agreement between partitions, not the share of items whose label
changed, and it was measured on a stochastic algorithm.

Measured directly instead — cluster the older half, cluster the full corpus,
then map each older-half cluster to the full-corpus cluster it overlaps most
(**greedy best-overlap matching, one pass, not a globally optimal
assignment**) and count sessions that keep their label:

| Test | Result |
|---|---|
| Older-half labels surviving after the corpus doubles (deterministic leader clustering, greedy best-overlap matching) | **93.3% keep their label → 6.7% churn** |
| Two k-means runs, identical data, different initialisation | ARI **0.209** |

Greedy matching can map two old clusters onto the same new cluster, so 93.3%
is an **upper bound** on retention and 6.7% is a **lower bound** on churn —
the unfavourable direction for the "churn is low" reading, so it is stated
rather than glossed. True churn is somewhere between 6.7% and whatever a
one-to-one (Hungarian) assignment would give, and that assignment was not
computed.

What this does support: churn is nowhere near the two-thirds the retracted
ARI reading implied, so **stability is not an independent disqualifier**. What
it does not support: a precise stability figure. If the maintainer ever wants
stability to be decisive in either direction, it needs the one-to-one
measurement.

So: **deterministic leader clustering is stable enough**; k-means is not.
Stability is a constraint on algorithm choice, not an independent reason to
abandon the direction. The verdict rests on §2.1 (coverage) and
§2.6/§2.7 (novelty), both of which are unaffected.

### 2.9 A cross-check that turned out not to be measurable

Campaign lineage was checked as a possible existing grouping. Every one of
the 963 first-prompt sessions is its own `rootSourceSessionId` — which makes
sense (the first prompt *is* the campaign root; the children are subagents
carrying `agent-role` titles). NMI against an all-singleton partition is a
degenerate quantity and is **not reported as a finding**; the usable
observation is simply that campaigns and this corpus are orthogonal by
construction.

### 2.10 Read-budget cost — measured, not raised

§2.7 measures the *standalone* cost (280.5 MiB, 230 ms, zero budget hits).
In production the cost would be lower still — **zero incremental** — because
`collectClaudePrompts` already runs unconditionally inside
`parseClaudeSessionFacts` (`packages/local-machine/src/claude-session-facts.ts:660`),
which the collector already calls during normal collection
(`packages/local-collectors/src/collectors/claude.ts:323`). The 1 GiB byte
budget (`history-budgets.ts:2`) and the 100,000-record cap
(`claude-session-facts.ts:23,649`) are already applied on that path. Claude's
first prompt is *extracted today and discarded* — it never reaches `report`
(`claude-session-facts.ts:762–780`).

No budget needs raising, and none was raised. This is the one genuinely
attractive fact in the whole spike, and §4 records what would have to be true
for it to matter.

---

## 3. Step 3 — minimal end-to-end slice (specified, not recommended)

Recorded so the maintainer can override the verdict without a second spike.
**Architecture B**, as an enrichment contribution.

- **Field(s) and bounds.** Portable part:
  `{ intent: IntentLabel; confidence: number }` where `IntentLabel` is a
  **closed enum**, never free text — free text derived from a prompt is
  body-class in miniature and reopens §1.A. Bounds: an enum member and a
  finite `[0,1]` number.
- **The invalidation digest must stay local.** A cache-invalidation
  `sourceDigest` (sha256 of the derived input, so an edited prompt
  invalidates the label) is needed, but it **must not be part of the portable
  row**. An unsalted hash of a bounded prompt-derived string is an equality
  oracle across machines and reports — two sessions with the same opening
  line become linkable — and, because the input space of an opening sentence
  is small and guessable, it is offline-attackable. The closed-enum argument
  protects `intent`; it does not protect a digest. **Keep `sourceDigest` in
  the `usage_row_enrichments` payload only** (which is where RTK's
  `enrichmentContentHash` already lives, `index.ts:915–916`), never in the
  composed row, and never in `SERIALIZED_USAGE_ROW_KEYS`. If a portable
  digest is ever wanted, it must be an HMAC under a per-machine key that
  never leaves the machine — and that is a separate decision.
- **Storage.** `usage_row_enrichments` with
  `SESSION_INTENT_SOURCE_ID = 'session.intent'` and
  `SESSION_INTENT_SCHEMA_VERSION = 1`, mirroring
  `RTK_SAVINGS_SOURCE_ID`/`RTK_SAVINGS_SCHEMA_VERSION`
  (`packages/usage-store/src/index.ts:866–867`). An `isSessionIntentContribution`
  guard beside `isRtkSavingsContribution` (`:875–885`), an upsert beside
  `upsertRtkContribution` (`:953–988`), and a compose step in
  `readReportRows` (`:2472–2517`).
- **Import must round-trip as a contribution, not as base-row data.** This is
  the half the plan's option-B sketch omits, and getting it wrong silently
  converts an enrichment into collector-owned data. Mirror RTK exactly:
  extend `stripSessionIntent`/`stripRtkSavings` (`index.ts:902–913`) so
  `prepareMergeRow` (`:918–929`) **strips the intent fields off an incoming
  peer row and recomputes the base `contentHash` without them** — otherwise
  the same session labelled differently on two machines produces two
  different content hashes and the rows fight over supersession — and extend
  `writeClassifiedMergeRows` (`:2009–2015`) to upsert the *extracted*
  contribution, bumping the store generation only when an active row's
  contribution actually changed. Without both edits, an imported label
  mutates the base row.
- **Which collectors can supply it**, per the plan's Step 3 list:

  | Collector | Source | Status |
  |---|---|---|
  | Codex | `session.firstUser` (`internal/codex-history.ts:546`) | Available; already a 200-char derived label. 12.4% of rows. |
  | Claude | `collectClaudePrompts` (`claude-session-facts.ts:660`) | Available at zero extra read cost (§2.10), but the first prompt must be allowed to reach `report`, which today it deliberately does not (`claude-session-facts.ts:762–780`). 91 root sessions measured. |
  | Cursor | `naming.first` (`collectors/cursor.ts:207`) | Available, **but it is the whole first bubble body**, not a derived label — it must pass through `deriveSessionLabelFromPrompt` before anything else touches it. |
  | OpenCode | `session.title` (`collectors/opencode.ts:63,123,318–330`) | **Available, and it is not a prompt at all.** |

  The OpenCode row deserves its own sentence, because it is the only source
  in the list that sits *outside* this memo's privacy question. OpenCode
  never reads a user prompt: `classifyOpenCodeTitle`
  (`collectors/opencode.ts:318–330`) takes the harness-authored `session.title`
  column and emits `titleSource: 'ai'` (952 rows here). That title is
  harness-authored text the user did not write, already portable, already
  read at collection time, and it needs **no** redaction step, **no** opt-out,
  and **no** derived-label pass. If a classifier is ever built, OpenCode
  should feed it directly from `session.title` and be exempted from the
  prompt-handling rules that govern the other three — conflating "has a title
  signal" with "has a first-prompt signal" would impose a privacy control on
  data that raises no privacy question.
- **Redaction/truncation.** The enricher consumes the *derived label*, never
  the body: `usablePrompt` then `deriveSessionLabelFromPrompt`
  (`packages/local-machine/src/session-label.ts:115–124`, bounded to 200
  chars) as the sole input, and emits only the enum member. The prompt text
  never leaves the collector process.
- **Opt-out.** Register a `CollectionSourceDefinition`
  (`packages/report-core/src/source-control.ts:5–14, 40–108`) with
  `kind: 'enricher'`, `defaultEnabled: false`. That yields a per-user toggle
  through the existing `sourcePolicies` override with **no `AiUsageConfig`
  schema change** (`source-control.ts:137–176`). `defaultEnabled: false` is
  deliberate: a prompt-derived signal should be opt-**in**.
- **Serialization/validation touch points — required, contrary to the plan's
  assumption.** Because `exportLocalMergeBundle` exports the *composed* row
  (§1.B), the field must be allow-listed like RTK is: an entry in
  `SERIALIZED_USAGE_ROW_KEYS` (`serialized-usage-validation.ts:17–61`) and a
  predicate line in `hasValidSerializedUsageFields` (`:222–270`). That one
  file's edit automatically widens `MERGE_ROW_KEYS` (`merge-bundle.ts:57`),
  the snapshot row check (`snapshot.ts:233`), and
  `SESSION_PRESENTATION_ROW_KEYS` (`session-query.ts:319–343`).
- **Bundle-version implications — a v4 is required for B1.** The full
  checklist: `merge-bundle.ts:21–23` (version constants), `:194–197`
  (widen `isSerializedMergeRowForVersion`), `:260–266` (accept 3 in the gate),
  `:283–288` (add the "legacy v≤3 rows cannot contain this field" negative
  guard, mirroring the `source.vcs` guard), `:226–244` (a v3→v4 migration
  branch), `:329–365` (`deserializeMergeRow` is field-by-field, not a spread),
  plus a matching snapshot v4 at `snapshot.ts:18–20,142–180,345`. Note
  especially `merge-bundle.ts:86–99`: the field must **never** join
  `identityParts`, or every `sourceFingerprint` changes and the whole fleet
  re-supersedes. `titleSource` is already excluded there and is the precedent.
- **The trap, and it applies to B1 as much as to A.**
  `packages/usage-store/src/index.ts:2515` re-validates every stored row on
  every read and **silently skips** (`skipped += 1`) any row carrying an
  unrecognised key. Writing a new field into `row_json`, or exporting a
  composed row carrying one, before the validator learns about it deletes
  those rows from a report — or from a peer's report — with no error. The
  allow-list edit must land *before* the enricher writes anything, and a peer
  running an older version must be handled by the v4 gate rather than by
  silent row loss.
- **First UI consumer.** An **intent facet on the Sessions filter bar**, not a
  new chart — `filterOptions` today carries only `harness` and `machine`
  (`focused-report-query.ts:374`), so the facet slot is the natural home and
  "hierarchize ruthlessly" says do not add a panel. It must render `unknown`
  as a first-class value, never as an exclusion: an 87.6%-unknown facet whose
  default hides unknowns would misreport the whole report.

---

## 4. What would change the verdict

Stated concretely so this can be re-decided on evidence rather than
re-litigated.

1. **Coverage crosses ~50% of rows.** Claude and OpenCode would both have to
   contribute. §2.7 shows Claude's local history yields 91 root sessions with
   a usable first prompt against 796 Claude rows in the store — most Claude
   rows are subagents or have no retained transcript — so even a fully-wired
   Claude does not obviously move 12.4% past 50%. Counting how many *rows*
   (not files) a wired Claude collector would label is the next cheap
   measurement, and it needs no schema change.
2. **A closed-vocabulary classifier beats B0 on a labelled sample.** The
   right test is not clustering at all: hand-label ~200 sessions with a fixed
   intent enum, then measure whether *any* local classifier beats "the
   title's first word" on that labelled set. §2.6 and §2.7 say free
   clustering cannot; supervised classification against a fixed vocabulary is
   a different question and was **not** tested here. This is the single
   experiment most likely to overturn the verdict.
3. **Algorithm choice is settled by §2.8, not open.** A per-session
   classifier is stable by construction; deterministic leader clustering
   churns 6.7%; k-means churns badly. Anything built here must be
   classification or a deterministic assignment — never k-means.
4. **The corpus stops being bilingual, or the pipeline becomes
   language-aware.** 81.1% French-token presence is the single largest
   confound in §2.4 and it is a property of this user, not of the domain — a
   second machine's corpus would settle how much of §2.4's failure is
   language and how much is signal.

Item 2 is the honest reframing: **the future-work entry asks for clustering;
every measurement here says clustering produces keyword filters, and only
classification against a chosen vocabulary could work — but choosing that
vocabulary is a product decision, not a spike.**

---

## 5. What the data *does* support — and it needs no privacy decision

The store contains an intent-shaped signal that nobody surfaces, and it is
already portable, already stable, and already inside every boundary:

- **`titleSource: 'agent-role'` covers 2,115 rows (26.2%) with only 154
  distinct labels** across the 5,000-row sample — a naturally clustered,
  low-cardinality categorical field. A subagent's role *is* its intent, stated
  by the harness rather than inferred from a prompt.
- **Subagents are 39.4% of rows.** Codex contributes 1,700 `agent-role` rows
  and Claude Code 415.
- `titleSource` is already on `UsageRow` (`types.ts:78`), already validated
  (`serialized-usage-validation.ts:261`), already portable, and already
  rendered as provenance (`provenance.ts:198–212`, "Derived title").
- `filterOptions` exposes only `harness` and `machine` today
  (`focused-report-query.ts:374`), so there is a facet slot and no facet.

**Recommendation: if the maintainer wants a "what kind of work" axis, ship a
facet over agent role / `titleSource`, and drop the prompt direction.** It is
a small plan (a new `FocusedFilterOption[]` in the support payload plus a
filter-bar control), it reuses a field that already exists end to end, it has
26% coverage against the prompt path's 12.4%, its labels are authored by the
harness rather than inferred, and it raises **no privacy question at all** —
`agent-role` names are agent nicknames, not user text.

It is deliberately *not* the same feature. It answers "which agent did this
work", not "what was I trying to do". But it is the only version of the
question this store can answer honestly today, and it should be written as
its own plan rather than folded in here.

---

## 6. Decisions this memo asks the maintainer to make

1. **Uphold and close** the deferred decision *"Campaigns grouped by user
   intention require a separate privacy and domain-model decision; no
   heuristic classification is added"* — now evidenced, not merely cautious.
   Move it from "explicitly deferred" to a rejected finding with this
   document as the rationale.
2. **Refuse architecture A permanently.** A 200-char raw prompt prefix is
   body-class text in portable payloads, and it duplicates `row.name` for
   94% of the rows that have the signal.
3. **Record architecture B's slice (§3) as the design of record** should
   intent ever be revisited — so a future plan starts from "enrichment
   contribution, closed enum, opt-in" rather than re-deriving it.
4. **Decide whether §5's agent-role facet is worth its own plan.**
   Recommended: yes, P3, size S–M.

## 7. Where this spike is uncertain

- **One machine, one user, one dominant harness.** Every number here comes
  from a store where Codex is 59% of rows and the prompts are 81% bilingual.
  A second machine could move coverage and the §2.4 language confound
  substantially. It would not move §2.6/§2.7 (top-term recall) — that is a
  property of lexical clustering, not of this corpus.
- **The raw-prompt control is small: 89 clusterable root sessions** (§2.7).
  That is enough to refute "raw prompts will cluster better than titles" —
  the effect runs the wrong way and is large — but not enough to characterise
  raw-prompt clustering in general. A machine with heavier Claude use would
  strengthen or weaken it.
- **Two first-draft claims were retracted after adversarial review**, and
  the coverage argument was weakened, all corrected in place rather than
  removed so the record shows what the evidence supports: ARI figures were
  misread as label-churn percentages (§2.8); coherent clusters were called
  keyword searches when precision is only ~50% (§2.6); and the headline
  coverage figure measured realised title provenance rather than attainable
  signal (§2.1a). The verdict survived all three because it rests on
  **recall**, which none of them touch — but a reader should weigh it on that
  one measurement, not on the count of arguments.
- **Clustering was tested; classification was not.** §4.2 names the
  experiment that would settle it. This spike deliberately did not run it,
  because a supervised classifier needs a chosen intent vocabulary and
  choosing one is the product decision the deferral is about. **If the
  maintainer disagrees with any part of this verdict, that is the experiment
  to commission — not a re-run of the clustering.**
- **Cursor was not measured at all** (1,597 rows, 19.8% of the store). Only
  `titleSource`. 1,460 Cursor rows carry no `titleSource` at all, which is
  consistent with composer names winning — but whether Cursor's local
  Composer DB would yield first prompts for those rows was not tested, and
  doing so would have meant reading prompt bodies for a measurement that
  §2.6 and §2.7 already decide.
