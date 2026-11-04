<script lang="ts">
  import { css } from '@ai-usage/design-system/css';
  import { flowTokens, type TokenFlow } from '@ai-usage/report-core/observatory';
  import { fmtCompact } from '../../foundation/presentation/format';
  import { layoutTokenFlow } from './token-flow-layout';

  let { flow }: { flow: TokenFlow } = $props();
  const layout = $derived(layoutTokenFlow(flow));
  const panel = css({ minW: 0, display: 'grid', gap: '16px' });
  const scroll = css({
    overflowX: 'auto',
    maxW: 'full',
    border: '1px solid token(colors.line)',
    borderRadius: 'md',
    p: '12px',
    color: 'accent',
  });
  const svg = css({ minW: '900px', w: 'full', display: 'block' });
  const label = css({ fill: 'ink', fontSize: '12px' });
  const muted = css({ color: 'muted', fontSize: '13px', lineHeight: 1.6 });
  const table = css({
    w: 'full',
    fontSize: '12px',
    borderCollapse: 'collapse',
    '& th, & td': { textAlign: 'start', p: '10px', borderBottom: '1px solid token(colors.line)', whiteSpace: 'nowrap' },
  });
</script>
<section aria-label="Token flow" class={panel}>
  <h2>Where the tokens went</h2>
  <p class={muted}>
    {fmtCompact(flow.total)}
    observed tokens across {flow.sessions} sessions. Width encodes tokens on one scale. Project → model → token
    category.
  </p>
  {#if flow.partialSessions}
    <p class={muted} role="status">
      {flow.partialSessions}
      sessions have incomplete usage. These totals describe recorded usage, not complete consumption.
    </p>
  {/if}
  {#if flow.total > 0}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard scrollable overflow region) -->
    <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll this overflow region -->
    <section aria-label="Scrollable token flow diagram" class={scroll} tabindex="0">
      <svg
        aria-label="Token flow from projects through models to fresh input, cache and output"
        class={svg}
        role="img"
        viewBox={`0 0 1040 ${layout.height}`}
      >
        <title>Observed tokens by project, model and category</title>
        {#each ['Project', 'Model', 'Token category'] as title, index}
          <text class={label} x={20 + index * 390} y="18">{title}</text>
        {/each}
        {#each layout.ribbons as ribbon (ribbon.key)}
          <path d={ribbon.path} fill="currentColor" opacity="0.2">
            <title>{ribbon.from} → {ribbon.to}: {ribbon.tokens.toLocaleString('en-US')} tokens</title>
          </path>
        {/each}
        {#each layout.nodes as node (node.key)}
          <rect fill="currentColor" height={node.height} width="8" x={node.x} y={node.y} />
          <text class={label} x={node.x + 13} y={node.y + 13}>
            {node.label.length > 29 ? `${node.label.slice(0, 28)}…` : node.label}
            <title>{node.label}: {node.tokens.toLocaleString('en-US')} tokens</title>
          </text>
        {/each}
      </svg>
    </section>
    <p class={muted}>
      Eight largest projects and twelve largest models are named. Remaining groups stay in the totals. Cache categories
      are disjoint; token volume is not a billed amount.
    </p>
    <details>
      <summary>Exact flow values</summary>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard scrollable overflow region) -->
      <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to scroll this overflow region -->
      <section aria-label="Scrollable exact token values" class={scroll} tabindex="0">
        <table class={table}>
          <caption>
            Observed tokens for each project and model
          </caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Model</th>
              <th scope="col">Input</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache written</th>
              <th scope="col">Output</th>
              <th scope="col">Total tokens</th>
            </tr>
          </thead>
          <tbody>
            {#each flow.links as link (JSON.stringify([link.projectKey, link.model]))}
              <tr>
                <th scope="row">{link.projectLabel}</th>
                <td>{link.model ?? 'Other models (grouped)'}</td>
                <td>{link.input}</td>
                <td>{link.cacheRead}</td>
                <td>{link.cacheWrite}</td>
                <td>{link.output}</td>
                <td>{flowTokens(link)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    </details>
  {:else}
    <p>No recorded tokens match these filters.</p>
  {/if}
</section>
