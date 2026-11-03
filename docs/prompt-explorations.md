# Prompt explorations

`/prompts` connects the native prompt reader, lexical observations, optional local
semantic families, and seven editable editorial practice groupings. The same
loaded corpus and source-session links underpin these views. No private One Shot
snapshot is an application input.

## Reading the results

Search, project label, harness and date filters belong to the native corpus
reader. Continue loading pages to expand the sample. Exploration independently
caps analysis at 500 prompts; semantic computation additionally caps the distinct
formulations at 160. Coverage, clipping and omissions remain visible. Session
shares use distinct sessions within the loaded sample, not all historical work.
Weekly bins use UTC calendar weeks.

Repeated wording is lexical evidence. Semantic families require the explicit
model preparation and local analysis actions described in [ADR 0087](adr/0087-local-prompt-explorations.md).
The reference, source formulations, cosine scores, character-trigram Jaccard
scores, and inclusion decisions remain inspectable. Model files may remain in the
browser cache; prompts, embeddings and editorial decisions are not persisted.
Changing the loaded corpus clears the semantic analysis. Export decisions before
reloading.

The seven practices are editorial vocabulary suggestions over those families:
review, corrections, opinion, commit/push, handoff, status and continuation.
Their vocabulary is displayed alongside each grouping. They are neither an
exhaustive intention classifier nor evidence of successful outcomes. A session
may occur in multiple practices. Group exclusions can be edited separately for
each practice.

The dossier starts at the first visible occurrence in each session. It examines
up to three adjacent loaded prompt ordinals, stopping at any gap. The first
recognized subsequent practice determines one exclusive follow-up category;
otherwise the category is unclassified or no adjacent prompt observed. Missing
history and the chosen period can explain missing follow-ups.

The comparison lets the reader select two distinct sessions. Each column loads
its bounded native responses and tool records only after an explicit click.
Changing the selected session resets that request. These records cover the
session, not necessarily the displayed prompt: canonical native turn attribution
is shown when available. Tool requests do not prove applied changes, successful
tests, or a merged PR. Original rounds remain available from each source button.
Dossier exports record filters, selected project, compared source IDs, included
and excluded families, and editable notes.

## One Shot A–N destinations

The explorations converge on one page. The following table distinguishes the
retained product behavior from visual or methodological variants that remain in
the disposable One Shot laboratory.

| Study | Product destination | Convergence and laboratory remainder |
| --- | --- | --- |
| A · Compare | Native prompt list, rounds reader, two-session comparison | Sources and recorded results replace an inferred result summary. No generated session account is restored. |
| B · Map | Projects × proposed practices matrix | The comparative matrix is retained with explicit editorial vocabulary. The original broader intention classifier stays in the laboratory. |
| C · Evolve | Weekly loaded-prompt activity bars | UTC periods and counts are retained. An automatic intention breakdown of every prompt stays in the laboratory. |
| D · Network | Project prevalence for a lexical motif; selected semantic-family graph | Project membership and sources stay inspectable. The full lexical project–motif graph stays in the laboratory. |
| E · Journey | Actual adjacent follow-up examples; practice dossier branches | The source sequences and exclusive follow-up counts are retained. The full global branching tree stays in the laboratory. |
| F · Waves | Weekly motif prevalence with denominators | Bars replace the multi-project wave layout; project comparison is adjacent to the series. |
| G · Contrasts | Matched sessions / loaded sessions for each project | Counts and comparable 0–100% prevalence remain visible. No significance or causal claim is added. |
| H · Workshop | Editable observation and dossier exports | Questions and source IDs can be exported. Automatic rule, skill or AGENTS.md publication is absent. |
| I · Semantic network | Selected family linked to up to seven projects | Direct-reference membership and original sources are retained; the global all-family network stays in the laboratory. |
| J · Pairs | Inspectable cosine / trigram table with inclusion controls | The table retains exact texts and decisions. The scatterplot stays in the laboratory. Jaccard is explicitly different from the prototype's PostgreSQL pg_trgm metric. |
| K · Semantic evolution | Family prevalence by project and UTC week; decision export | Counts and denominators are retained as tables with bars. Observation drafts are shared with the lexical/practice sections. |
| L · Practices map | Seven-practice project matrix | Current-corpus vocabulary replaces fixed private family IDs. The original practice network layout stays in the laboratory. |
| M · Dossier | Editable family grouping, observed follow-up fractions, notes | Cases remain selectable and source-linked. Prototype automatic example preferences are replaced by explicit session selectors. |
| N · Comparison | Two distinct sessions with independently loaded native traces | Prompt sources, subsequent prompts, canonical attribution and coverage are inspectable. No inferred completion or merge status is introduced. |

This is a record of deliberate convergence, not a claim that all fourteen
prototype screens or their calculations were copied unchanged.
