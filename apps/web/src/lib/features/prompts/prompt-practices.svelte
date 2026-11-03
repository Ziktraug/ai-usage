<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { buildPractices, PRACTICES, type PracticeId, practiceDraft } from './practices-model';
  import type { ExplorationPrompt } from './prompt-exploration';
  import type { SemanticFamily } from './semantic-model';
  import SessionEvidence from './session-evidence.svelte';

  let {
    families,
    entries,
    revision,
    onOpen,
    synthetic = false,
    corpusScope = '',
  }: {
    families: readonly SemanticFamily[];
    entries: readonly ExplorationPrompt[];
    revision: string;
    onOpen: (entry: ExplorationPrompt) => void;
    synthetic?: boolean;
    corpusScope?: string;
  } = $props();
  let selected = $state<PracticeId>('review');
  let project = $state('');
  let omitted = $state<ReadonlySet<string>>(new Set());
  let notes = $state<Record<string, string>>({});
  let first = $state('');
  let second = $state('');
  const available = $derived(buildPractices(families, entries));
  const practices = $derived(buildPractices(families, entries, omitted));
  const practice = $derived(practices.find((item) => item.id === selected) ?? practices[0]);
  const original = $derived(available.find((item) => item.id === selected));
  const projects = $derived([...new Set(entries.map((entry) => entry.project))].sort());
  const cases = $derived(practice?.cases.filter((item) => !project || item.start.project === project) ?? []);
  const left = $derived(cases.find((item) => item.start.rowId === first) ?? cases[0]);
  const right = $derived(
    cases.find((item) => item.start.rowId === second && item.start.rowId !== left?.start.rowId) ??
      cases.find((item) => item.start.rowId !== left?.start.rowId),
  );
  const outcomes = $derived(
    [
      ...PRACTICES.map((item) => ({
        id: item.id,
        label: item.title,
        count: cases.filter((candidate) => candidate.nextPractice === item.id).length,
      })),
      {
        id: 'unclassified',
        label: 'Following prompt observed, not classified',
        count: cases.filter((item) => item.following.length > 0 && item.nextPractice === null).length,
      },
      {
        id: 'unobserved',
        label: 'No adjacent following prompt observed',
        count: cases.filter((item) => item.following.length === 0).length,
      },
    ].filter((item) => item.count > 0),
  );
  const toggle = (id: string) => {
    const key = `${selected}:${id}`;
    const next = new Set(omitted);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    omitted = next;
  };
  const download = () => {
    if (!practice) {
      return;
    }
    const content = practiceDraft({ ...practice, cases }, revision, notes[selected] ?? '', {
      project,
      corpusScope,
      omittedFamilies: [...omitted].filter((key) => key.startsWith(`${selected}:`)),
      comparisonRowIds: [left, right].flatMap((item) => (item ? [item.start.rowId] : [])),
    });
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `practice-${selected}.md`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const panel = css({ display: 'grid', gap: '18px', minW: 0, borderTop: '1px solid token(colors.line)', pt: '24px' });
  const muted = css({ color: 'muted', fontSize: '13px', lineHeight: 1.6 });
  const table = css({
    w: 'full',
    fontSize: '13px',
    borderCollapse: 'collapse',
    textAlign: 'left',
    '& th, & td': { p: '8px', borderBottom: '1px solid token(colors.line)', overflowWrap: 'anywhere' },
  });
  const button = css({
    p: '10px',
    color: 'ink',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
    cursor: 'pointer',
    _disabled: { opacity: 0.5 },
    _focusVisible: { outline: '2px solid token(colors.accent)', outlineOffset: '2px' },
  });
  const input = css({
    p: '10px',
    maxW: 'full',
    color: 'ink',
    bg: 'surface',
    border: '1px solid token(colors.line)',
    borderRadius: 'sm',
  });
  const row = css({ display: 'flex', flexWrap: 'wrap', gap: '12px' });
  const comparison = css({
    display: 'grid',
    gridTemplateColumns: { base: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' },
    gap: '20px',
    minW: 0,
  });
  const column = css({ display: 'grid', alignContent: 'start', gap: '12px', minW: 0 });
  const quote = css({
    m: 0,
    borderLeft: '2px solid token(colors.line)',
    pl: '12px',
    fontSize: '13px',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  });
  const scroll = css({ overflowX: 'auto', maxW: 'full' });
</script>

<section aria-label="Editorial practices" class={panel}>
  <h2>Practices: map, observe, compare</h2>
  <p class={muted}>
    Seven editorial groupings suggested from the current families using explicit vocabulary. They are neither discovered
    universal categories nor a complete account of your work. A session may belong to several practices; counts do not
    add up. Source texts and family membership remain inspectable.
  </p>
  <div class={row}>
    <label
      >Practice
      <select aria-label="Practice" class={input} bind:value={selected}>
        {#each PRACTICES as option (option.id)}
          <option value={option.id}>{option.title}</option>
        {/each}
      </select></label
    ><label
      >Project
      <select aria-label="Project" class={input} bind:value={project}>
        <option value="">All loaded projects</option>
        {#each projects as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select></label
    >
  </div>
  <div class={scroll}>
    <table class={table}>
      <caption>
        Projects × proposed practices · distinct loaded sessions
      </caption>
      <thead>
        <tr>
          <th scope="col">Project</th>
          {#each practices as item (item.id)}
            <th scope="col">{item.title}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each projects as name (name)}
          <tr>
            <th scope="row">{name}</th>
            {#each practices as item (item.id)}
              {@const count = item.cases.filter((candidate) => candidate.start.project === name).length}
              <td>
                <button
                  aria-label={`${name}: ${item.title}, ${count} sessions`}
                  class={button}
                  disabled={count === 0}
                  onclick={() => {
                    project = name;
                    selected = item.id;
                  }}
                  type="button"
                >
                  {count}
                </button>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if practice}
    <h3>{practice.title} · {cases.length} sessions in this selection</h3>
    <details>
      <summary>Inspect and adjust this proposed grouping</summary>
      <p class={muted}>
        {practice.description}
        Negated formulations are left unresolved. Exclusions below affect this practice only; semantic inclusion
        decisions above affect all practices.
      </p>
      {#each original?.families ?? [] as item (item.reference.id)}
        <label class={row}
          ><input
            checked={!omitted.has(`${selected}:${item.reference.id}`)}
            onchange={() => toggle(item.reference.id)}
            type="checkbox"
          >{item.reference.text}</label
        >
      {/each}
    </details>
    {#if cases.length}
      <table class={table}>
        <caption>
          First recognized practice in the next three adjacent loaded prompts
        </caption>
        <thead>
          <tr>
            <th scope="col">Observed follow-up</th>
            <th scope="col">Sessions / selected sessions</th>
            <th scope="col">Share · 0–100%</th>
          </tr>
        </thead>
        <tbody>
          {#each outcomes as outcome (outcome.id)}
            <tr>
              <th scope="row">{outcome.label}</th>
              <td>{outcome.count} / {cases.length}</td>
              <td>
                <meter
                  aria-label={outcome.label}
                  max="100"
                  min="0"
                  value={(100 * outcome.count) / cases.length}
                ></meter> {Math.round((100 * outcome.count) / cases.length)}%
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class={muted}>
        The first visible occurrence per session is used. Missing ordinals stop the follow-up sequence. Categories are
        exclusive; they do not establish success, failure or causality. No following prompt may mean missing data.
      </p>
      <h3>Compare two observed sessions</h3>
      <div class={row}>
        <label
          >First session
          <select
            aria-label="First session"
            class={input}
            onchange={(event) => {
              first = event.currentTarget.value;
            }}
            value={left?.start.rowId ?? ''}
          >
            {#each cases as item (item.start.rowId)}
              <option value={item.start.rowId}>
                {item.start.project}
                · {item.start.at.slice(0, 10)} · {item.start.sessionId}
              </option>
            {/each}
          </select></label
        ><label
          >Second session
          <select
            aria-label="Second session"
            class={input}
            onchange={(event) => {
              second = event.currentTarget.value;
            }}
            value={right?.start.rowId ?? ''}
          >
            {#if !right}
              <option value="">No second session in this selection</option>
            {/if}
            {#each cases.filter((item) => item.start.rowId !== left?.start.rowId) as item (item.start.rowId)}
              <option value={item.start.rowId}>
                {item.start.project}
                · {item.start.at.slice(0, 10)} · {item.start.sessionId}
              </option>
            {/each}
          </select></label
        >
      </div>
      <div class={comparison}>
        {#each [left, right] as item, index (index)}
          <section aria-label={`Comparison session ${index + 1}`} class={column}>
            {#if item}
              <h4>Session {index + 1} · {item.start.project}</h4>
              <p class={muted}>{item.start.at} {item.start.partial ? '· partial history' : ''}</p>
              <blockquote class={quote}>{item.start.text}</blockquote>
              <ol>
                {#each item.following as next (`${next.rowId}:${next.id}`)}
                  <li><p class={quote}>{next.text}</p></li>
                {/each}
              </ol>
              <button class={button} onclick={() => onOpen(item.start)} type="button">
                Read original session {index + 1} and available results
              </button>
              {#key item.start.rowId}
                <SessionEvidence {revision} rowId={item.start.rowId} {synthetic} />
              {/key}
            {:else}
              <p class={muted}>A second distinct session is not present in this selection.</p>
            {/if}
          </section>
        {/each}
      </div>
      <p class={muted}>
        These cases are selected for inspection, not as a controlled experiment. Recorded results cover each selected
        session; they are not attributed to the displayed prompt without a canonical native turn reference.
      </p>
    {:else}
      <p class={muted}>
        No included family matches this proposed practice in the selection. Inspect another practice or broaden the
        loaded corpus.
      </p>
    {/if}
    <label class={column}
      >Observation notes<textarea
        class={input}
        maxlength="4000"
        oninput={(event) => {
          notes = { ...notes, [selected]: event.currentTarget.value };
        }}
        rows="4"
        value={notes[selected] ?? ''}
      ></textarea></label
    >
    <button class={button} onclick={download} type="button">Export practice dossier</button>
    <p class={muted}>
      Notes and grouping choices stay in this visit. Export before reloading. No skill or AGENTS.md is changed.
    </p>
  {/if}
</section>
