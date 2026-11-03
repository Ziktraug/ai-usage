<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { onDestroy } from 'svelte';
  import { type ExplorationPrompt, entryBreakdown } from './prompt-exploration';
  import {
    groupSemanticFamilies,
    SEMANTIC_MODEL,
    type SemanticFamily,
    type SemanticWorkerResponse,
    semanticFormulations,
  } from './semantic-model';

  let {
    entries,
    revision,
    onOpen,
    onFamilies = () => undefined,
  }: {
    entries: readonly ExplorationPrompt[];
    revision: string;
    onOpen: (entry: ExplorationPrompt) => void;
    onFamilies?: (families: readonly SemanticFamily[]) => void;
  } = $props();
  const corpus = $derived(semanticFormulations(entries));
  const identity = $derived(
    JSON.stringify([
      revision,
      corpus.formulations.map((item) => [item.id, item.entries.map((entry) => [entry.rowId, entry.id])]),
    ]),
  );
  let worker: Worker | undefined;
  let status = $state<'idle' | 'preparing' | 'ready' | 'running' | 'done' | 'error'>('idle');
  let message = $state('');
  let families = $state<readonly SemanticFamily[]>([]);
  let excluded = $state<ReadonlySet<string>>(new Set());
  let selected = $state('');
  const visibleFamilies = $derived(
    families
      .map((candidate) => ({
        ...candidate,
        members: candidate.members.filter((member) => !excluded.has(member.formulation.id)),
      }))
      .filter((candidate) => candidate.members.length),
  );
  const family = $derived(families.find((item) => item.reference.id === selected) ?? families[0]);
  const activeEntries = $derived(
    family?.members
      .filter((member) => !excluded.has(member.formulation.id))
      .flatMap((member) => member.formulation.entries) ?? [],
  );
  const breakdown = $derived(entryBreakdown(activeEntries, entries));
  const projectLinks = $derived(
    breakdown.projects
      .filter((item) => item.matched > 0)
      .sort((left, right) => right.matched - left.matched || left.name.localeCompare(right.name))
      .slice(0, 7),
  );
  const graphHeight = $derived(Math.max(120, projectLinks.length * 44 + 40));
  const stop = () => {
    worker?.terminate();
    worker = undefined;
  };
  const reset = () => {
    stop();
    status = 'idle';
    message = '';
    families = [];
    excluded = new Set();
    selected = '';
  };
  let activeIdentity = '';
  $effect(() => {
    if (identity !== activeIdentity) {
      activeIdentity = identity;
      reset();
    }
  });
  $effect(() => {
    onFamilies(visibleFamilies);
  });
  onDestroy(stop);

  const prepare = () => {
    stop();
    status = 'preparing';
    message = 'Preparing the pinned model. The first download can take several minutes.';
    const requestedIdentity = identity;
    try {
      worker = new Worker(new URL('./semantic.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      status = 'error';
      message = 'This browser could not start the local analysis worker. No remote fallback is used.';
      return;
    }
    worker.onerror = () => {
      stop();
      status = 'error';
      message = 'The local analysis worker stopped. Retry preparation; no remote inference fallback is used.';
    };
    worker.onmessage = (event: MessageEvent<SemanticWorkerResponse>) => {
      if (requestedIdentity !== identity) {
        return;
      }
      const response = event.data;
      if (response.kind === 'ready') {
        status = 'ready';
        message = 'Model ready. Prompt text has not been sent to the worker yet.';
      } else if (response.kind === 'progress') {
        message = `Analyzed ${response.done} of ${response.total} formulations locally.`;
      } else if (response.kind === 'error') {
        status = 'error';
        message = response.message;
        stop();
      } else if (response.kind === 'result') {
        try {
          families = groupSemanticFamilies(corpus.formulations, response.vectors);
          selected = families[0]?.reference.id ?? '';
          status = 'done';
          message = `${families.length} candidate families found in the loaded sample.`;
        } catch {
          status = 'error';
          message = 'The embedding result was invalid. No lexical substitution was made.';
        }
      }
    };
    worker.postMessage({ kind: 'prepare' });
  };
  const analyze = () => {
    if (!worker || status !== 'ready') {
      return;
    }
    status = 'running';
    message = 'Computing embeddings in this browser.';
    worker.postMessage({ kind: 'analyze', texts: corpus.formulations.map((item) => item.text) });
  };
  const toggle = (id: string) => {
    const next = new Set(excluded);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    excluded = next;
  };
  const download = () => {
    const content = JSON.stringify(
      {
        method: SEMANTIC_MODEL,
        revision,
        formulations: corpus.formulations.map((item) => ({
          id: item.id,
          sources: item.entries.map((entry) => ({ id: entry.id, rowId: entry.rowId })),
        })),
        families: families.map((item) => ({
          reference: item.reference.id,
          members: item.members.map((member) => ({
            id: member.formulation.id,
            cosine: member.cosine,
            lexicalJaccard: member.lexical,
          })),
        })),
        excluded: [...excluded],
      },
      null,
      2,
    );
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'prompt-family-decisions.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const panel = css({ display: 'grid', gap: '14px', minW: 0, borderTop: '1px solid token(colors.line)', pt: '24px' });
  const muted = css({ color: 'muted', fontSize: '13px', lineHeight: 1.6 });
  const controls = css({ display: 'flex', flexWrap: 'wrap', gap: '10px' });
  const button = css({
    p: '10px',
    color: 'ink',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    cursor: 'pointer',
    _disabled: { opacity: 0.5, cursor: 'not-allowed' },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const select = css({ p: '10px', maxW: 'full', color: 'ink', bg: 'surface', border: '1px solid token(colors.line)' });
  const table = css({
    w: 'full',
    fontSize: '13px',
    borderCollapse: 'collapse',
    textAlign: 'left',
    '& th, & td': { p: '8px', borderBottom: '1px solid token(colors.line)', overflowWrap: 'anywhere' },
  });
  const scroll = css({ overflowX: 'auto', maxW: 'full' });
  const graph = css({ w: 'full', h: 'auto', fill: 'ink' });
  const graphLink = css({ stroke: 'accent' });
</script>

<section aria-label="Local semantic exploration" class={panel}>
  <h2>Similar meaning, inspectable sources</h2>
  <p class={muted}>
    Optional local analysis of {corpus.formulations.length} formulations. {corpus.omitted} additional formulations
    omitted; {corpus.clipped} fragments shortened. The analysis uses only loaded prompts and changes when that sample
    changes.
  </p>
  <details>
    <summary>Model, downloads and limits</summary>
    <p class={muted}>
      Preparing downloads the pinned MiniLM model from Hugging Face and the pinned WASM runtime from jsDelivr. These
      public files may be cached by your browser. Prompt text is processed in a local Web Worker; it is not sent for
      cloud inference. Preparation is optional and never starts when this page opens. Cancel terminates the worker. This
      does not remove model files already cached by the browser.
    </p>
    <p class={muted}>
      Model: {SEMANTIC_MODEL.id}, revision {SEMANTIC_MODEL.revision}. Mean pooled normalized 384-dimensional embeddings,
      q8, maximum 128 tokens. At most 160 formulations, 48 words and 600 characters per fragment. Families require two
      observed sessions. Cosine threshold 0.84 is exploratory, not a probability. Recognized action and negation guards
      are conservative and incomplete. Each member matches its reference directly. Lexical comparison uses
      character-trigram Jaccard overlap, not PostgreSQL pg_trgm.
    </p>
  </details>
  <div class={controls}>
    <button class={button} disabled={status === 'preparing' || status === 'running'} onclick={prepare} type="button">
      Prepare local model
    </button>
    <button
      class={button}
      disabled={status !== 'ready' || corpus.formulations.length === 0}
      onclick={analyze}
      type="button"
    >
      Analyze loaded prompts locally
    </button>
    {#if status === 'preparing' || status === 'running'}
      <button class={button} onclick={reset} type="button">Cancel local analysis</button>
    {/if}
    {#if families.length}
      <button class={button} onclick={download} type="button">Export family decisions</button>
    {/if}
  </div>
  <p aria-live="polite" class={muted} role="status">
    {message || 'No model has been prepared. Lexical exploration remains available.'}
  </p>
  {#if family}
    <label
      >Candidate family
      <select aria-label="Candidate family" class={select} bind:value={selected}>
        {#each families as option (option.reference.id)}
          <option value={option.reference.id}>{option.reference.text}</option>
        {/each}
      </select></label
    >
    <figure>
      <svg
        aria-label="Projects connected to the selected family; link width follows the square root of distinct sessions"
        class={graph}
        role="img"
        viewBox={`0 0 720 ${graphHeight}`}
      >
        <title>Projects contributing sessions to the selected family</title>
        {#each projectLinks as item, index (item.name)}
          <path
            class={graphLink}
            d={`M 200 ${index * 44 + 30} C 360 ${index * 44 + 30}, 360 ${graphHeight / 2}, 510 ${graphHeight / 2}`}
            fill="none"
            opacity="0.55"
            stroke-width={Math.sqrt(item.matched) * 3}
          />
          <text font-size="13" x="0" y={index * 44 + 34}>{item.name.slice(0, 24)} · {item.matched}</text>
        {/each}
        <text font-size="13" x="525" y={graphHeight / 2 + 4}>Selected family</text>
      </svg>
      <figcaption class={muted}>
        Up to seven projects with matching sessions. Links encode observed membership, not causality. Use the
        original-session buttons below to inspect sources.
      </figcaption>
    </figure>
    <details>
      <summary>Family prevalence by project and time</summary>
      <table class={table}>
        <caption>
          Distinct sessions with included formulations / loaded sessions per project
        </caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Sessions</th>
            <th scope="col">Share · 0–100%</th>
          </tr>
        </thead>
        <tbody>
          {#each breakdown.projects as item (item.name)}
            <tr>
              <th scope="row">{item.name}</th>
              <td>{item.matched} / {item.total}</td>
              <td>
                <meter
                  aria-label={`Family prevalence in ${item.name}`}
                  max="100"
                  min="0"
                  value={item.total ? (100 * item.matched) / item.total : 0}
                ></meter>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <table class={table}>
        <caption>
          Family prevalence by UTC week · distinct loaded sessions
        </caption>
        <thead>
          <tr>
            <th scope="col">Week beginning</th>
            <th scope="col">Matched / loaded sessions</th>
            <th scope="col">Share · 0–100%</th>
          </tr>
        </thead>
        <tbody>
          {#each breakdown.weeks as item (item.name)}
            <tr>
              <th scope="row">{item.name}</th>
              <td>{item.matched} / {item.total}</td>
              <td>
                <meter
                  aria-label={`Family prevalence in week ${item.name}`}
                  max="100"
                  min="0"
                  value={item.total ? (100 * item.matched) / item.total : 0}
                ></meter>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </details>
    <p class={muted}>
      Inclusion decisions apply to the practices below and can be exported. They are cleared when the corpus changes or
      the page reloads.
    </p>
    <div class={scroll}>
      <table class={table}>
        <caption>
          Formulations compared with “{family.reference.text}”
        </caption>
        <thead>
          <tr>
            <th scope="col">Include</th>
            <th scope="col">Formulation</th>
            <th scope="col">Cosine</th>
            <th scope="col">Trigram overlap</th>
            <th scope="col">Sources</th>
          </tr>
        </thead>
        <tbody>
          {#each family.members as member (member.formulation.id)}
            <tr>
              <td>
                <input
                  aria-label={`Include ${member.formulation.text}`}
                  checked={!excluded.has(member.formulation.id)}
                  onchange={() => toggle(member.formulation.id)}
                  type="checkbox"
                >
              </td>
              <th scope="row">{member.formulation.text}</th>
              <td>{member.cosine.toFixed(3)}</td>
              <td>{member.lexical.toFixed(3)}</td>
              <td>
                {#each member.formulation.entries.slice(0, 3) as entry (`${entry.rowId}:${entry.id}`)}
                  <button class={button} onclick={() => onOpen(entry)} type="button">
                    {entry.project}
                    · {entry.at.slice(0, 10)}
                  </button>
                {/each}
                {#if member.formulation.entries.length > 3}
                  <span>{member.formulation.entries.length - 3} more occurrences in export</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>
