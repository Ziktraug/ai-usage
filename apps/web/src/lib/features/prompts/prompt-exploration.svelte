<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import {
    analyzePrompts,
    type ExplorationPrompt,
    explorationDraft,
    followingPrompts,
    motifBreakdown,
  } from './prompt-exploration';
  import PromptSemantics from './prompt-semantics.svelte';

  let {
    entries,
    complete,
    revision,
    onOpen,
    synthetic = false,
    corpusScope = '',
  }: {
    entries: readonly ExplorationPrompt[];
    complete: boolean;
    revision: string;
    onOpen: (entry: ExplorationPrompt) => void;
    synthetic?: boolean;
    corpusScope?: string;
  } = $props();
  let selected = $state('');
  let notes = $state<Record<string, string>>({});
  const corpus = $derived(analyzePrompts(entries));
  const weeklyMaximum = $derived(Math.max(1, ...corpus.weeks.map((week) => week.prompts)));
  const motif = $derived(corpus.motifs.find((candidate) => candidate.id === selected) ?? corpus.motifs[0]);
  const breakdown = $derived(motif ? motifBreakdown(motif, corpus.entries) : null);
  const draft = $derived(motif ? explorationDraft(motif, revision, notes[motif.id] ?? '', corpusScope) : '');
  const exportDraft = () => {
    const url = URL.createObjectURL(new Blob([draft], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'prompt-observation.md';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const panel = css({ display: 'grid', gap: '18px', minW: 0, borderTop: '1px solid token(colors.line)', pt: '24px' });
  const muted = css({ color: 'muted', fontSize: '13px', lineHeight: 1.6 });
  const heading = css({ color: 'ink', fontSize: '20px', fontWeight: 650, m: 0 });
  const layout = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', lg: 'minmax(220px, 0.8fr) minmax(0, 1.6fr)' },
    gap: '24px',
    minW: 0,
  });
  const section = css({ display: 'grid', gap: '12px', minW: 0, alignContent: 'start' });
  const list = css({ listStyle: 'none', m: 0, p: 0, display: 'grid', gap: '8px', minW: 0 });
  const button = css({
    textAlign: 'left',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    p: '10px',
    color: 'ink',
    bg: 'surface',
    cursor: 'pointer',
    overflowWrap: 'anywhere',
    _hover: { bg: 'accentTint' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const table = css({
    w: 'full',
    fontSize: '13px',
    borderCollapse: 'collapse',
    textAlign: 'left',
    '& th, & td': {
      p: '8px',
      borderBottom: '1px solid token(colors.line)',
      verticalAlign: 'top',
      overflowWrap: 'anywhere',
    },
  });
  const quote = css({
    m: 0,
    borderLeft: '2px solid token(colors.line)',
    pl: '12px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    fontSize: '13px',
  });
  const input = css({
    w: 'full',
    minW: 0,
    p: '10px',
    color: 'ink',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    fontSize: '13px',
  });
</script>

<section aria-label="Prompt explorations" class={panel}>
  <h2 class={heading}>Patterns in the loaded prompts</h2>
  <p class={muted}>
    {corpus.analyzed}
    prompts · {corpus.sessions} distinct sessions.
    {complete
      ? 'All pages in the selected corpusScope are loaded.'
      : 'Only loaded pages are included; load more prompts to extend the sample.'}
    {corpus.excluded}
    command or context-only prompts excluded; {corpus.clipped} partial or clipped prompts.
    {#if corpus.omitted > 0}
      {corpus.omitted}
      prompts exceed the 500-prompt analysis limit.
    {/if}
    {#if corpus.candidateLimit}
      The candidate limit was reached; additional formulations were not indexed.
    {/if}
    Counts describe this sample, not prompt quality or work success.
  </p>
  <details>
    <summary>Corpus over time and method</summary>
    <p class={muted}>
      UTC weeks; distinct sessions in each week may overlap across weeks. Exact short formulations require two sessions;
      phrases of 3–7 words require four. Code, commands and recognized injected context are excluded. Up to 80 words per
      prompt and 60 motifs are shown. This is lexical matching, not semantic interpretation.
    </p>
    <table class={table}>
      <caption>
        Loaded prompt activity by UTC week
      </caption>
      <thead>
        <tr>
          <th scope="col">Week beginning</th>
          <th scope="col">Prompts · scale 0–{weeklyMaximum}</th>
          <th scope="col">Distinct sessions</th>
        </tr>
      </thead>
      <tbody>
        {#each corpus.weeks as week (week.name)}
          <tr>
            <th scope="row">{week.name}</th>
            <td>
              <meter
                aria-label={`Prompts in week ${week.name}`}
                max={weeklyMaximum}
                min="0"
                value={week.prompts}
              ></meter> {week.prompts}
            </td>
            <td>{week.sessions}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
  {#if motif && breakdown}
    <div class={layout}>
      <div class={section}>
        <h3>Repeated formulations</h3>
        <ul class={list}>
          {#each corpus.motifs as candidate (candidate.id)}
            <li>
              <button
                aria-pressed={motif.id === candidate.id}
                class={button}
                onclick={() => {
                  selected = candidate.id;
                }}
                type="button"
              >
                {candidate.text} <span class={muted}>· {candidate.sessions} sessions · {candidate.kind}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
      <div class={section}>
        <h3>{motif.text}</h3>
        <table class={table}>
          <caption>
            Project prevalence in the loaded sample
          </caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Sessions with motif</th>
              <th scope="col">Loaded sessions</th>
              <th scope="col">Share</th>
            </tr>
          </thead>
          <tbody>
            {#each breakdown.projects as project (project.name)}
              <tr>
                <th scope="row">{project.name}</th>
                <td>{project.matched}</td>
                <td>{project.total}</td>
                <td>
                  <meter
                    aria-label={`Session share for ${project.name}`}
                    max="100"
                    min="0"
                    value={project.total ? (100 * project.matched) / project.total : 0}
                  ></meter> {project.total ? Math.round((100 * project.matched) / project.total) : 0}%
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <details>
          <summary>Weekly prevalence</summary>
          <table class={table}>
            <caption>
              Sessions containing this formulation per UTC week
            </caption>
            <thead>
              <tr>
                <th scope="col">Week</th>
                <th scope="col">Matched / loaded sessions</th>
              </tr>
            </thead>
            <tbody>
              {#each breakdown.weeks as week (week.name)}
                <tr>
                  <th scope="row">{week.name}</th>
                  <td>
                    <meter
                      aria-label={`Session share in week ${week.name}`}
                      max="100"
                      min="0"
                      value={week.total ? (100 * week.matched) / week.total : 0}
                    ></meter> {week.matched} / {week.total}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </details>
        <h3>Examples and observed follow-ups</h3>
        <ul class={list}>
          {#each motif.entries.slice(0, 12) as entry (`${entry.rowId}:${entry.id}`)}
            {@const following = followingPrompts(entry, corpus.entries)}
            <li class={section}>
              <button class={button} onclick={() => onOpen(entry)} type="button">
                Open session · {entry.project} · {entry.at.slice(0, 10)}{entry.partial ? ' · partial' : ''}
              </button>
              <blockquote class={quote}>{entry.text}</blockquote>
              {#if following.length}
                <details>
                  <summary>{following.length} adjacent following prompts observed</summary>
                  <ol>
                    {#each following as next (`${next.rowId}:${next.id}`)}
                      <li><p class={quote}>{next.text}</p></li>
                    {/each}
                  </ol>
                </details>
              {:else}
                <p class={muted}>
                  No adjacent following prompt in the loaded sample. This does not establish completion.
                </p>
              {/if}
            </li>
          {/each}
        </ul>
        {#if motif.entries.length > 12}
          <p class={muted}>
            Showing 12 of {motif.entries.length} occurrences. All source identities are included in the export.
          </p>
        {/if}
        <label class={section}
          >Question to investigate<textarea
            class={input}
            maxlength="4000"
            oninput={(event) => {
              if (motif) {
                notes[motif.id] = event.currentTarget.value;
              }
            }}
            placeholder="What context would you compare before changing a practice?"
            rows="4"
            value={notes[motif.id] ?? ''}
          ></textarea></label
        >
        <button class={button} onclick={exportDraft} type="button">Export observation draft</button>
        <p class={muted}>An editable observation, not an automatic rule. No skill or AGENTS.md is changed.</p>
      </div>
    </div>
  {:else}
    <p class={muted}>No repeated formulation meets the thresholds in the loaded sample.</p>
  {/if}
</section>

<PromptSemantics {corpusScope} entries={corpus.entries} {onOpen} {revision} {synthetic} />
