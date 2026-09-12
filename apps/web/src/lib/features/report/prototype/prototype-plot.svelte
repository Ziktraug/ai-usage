<script lang="ts">
  import type { Plot } from './dataviz-model';

  let { plot }: { plot: Plot } = $props();
</script>
<!-- svelte-ignore a11y_no_noninteractive_tabindex (overflow regions need keyboard scrolling) -->
<!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll the overflowing chart. -->
<section aria-label="Graphique défilant" class="plot-scroll" tabindex="0">
  <svg aria-label={plot.label} role="img" viewBox={`0 0 1060 ${plot.height}`}>
    {#each plot.marks as mark, index (index)}
      {#if mark.kind === 'path'}
        <path
          d={mark.d}
          fill={mark.stroke?'none':mark.color}
          opacity={mark.opacity??1}
          stroke={mark.stroke?mark.color:undefined}
          stroke-dasharray={mark.dash}
          stroke-width={mark.width}
        >
          <title>{mark.title??plot.label}</title>
        </path>
      {:else if mark.kind === 'rect'}
        <rect fill={mark.color} height={mark.height} opacity={mark.opacity??1} width={mark.width} x={mark.x} y={mark.y}>
          <title>{mark.title??plot.label}</title>
        </rect>
      {:else if mark.kind === 'circle'}
        <circle cx={mark.x} cy={mark.y} fill={mark.color} r={mark.r}><title>{mark.title??plot.label}</title></circle>
      {:else}
        <text text-anchor={mark.anchor??'start'} x={mark.x} y={mark.y}>{mark.text}</text>
      {/if}
    {/each}
  </svg>
</section>
<ul class="legend">
  {#each plot.legend as item}
    <li><span style:background={item.color}></span>{item.label}</li>
  {/each}
</ul>
<p class="note">{plot.note}</p>
<details>
  <summary>Données et lecture détaillée</summary>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex (overflow regions need keyboard scrolling) -->
  <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must scroll the overflowing data table. -->
  <section aria-label="Données du graphique" class="table-scroll" tabindex="0">
    <table>
      <thead>
        <tr>
          {#each plot.headers as label}
            <th scope="col">{label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each plot.rows as row}
          <tr>
            {#each row as cell, i}
              {#if i===0}
                <th scope="row">{cell}</th>
              {:else}
                <td>{cell}</td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</details>
<style>
  .plot-scroll,
  .table-scroll {
    max-width: 100%;
    overflow-x: auto;
  }
  svg {
    display: block;
    width: 100%;
    min-width: 720px;
    height: auto;
  }
  svg text {
    font:
      12px system-ui,
      sans-serif;
    fill: var(--colors-ink);
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    padding: 0;
    margin: 8px 0;
    font-size: 12px;
    color: var(--colors-muted);
    list-style: none;
  }
  .legend li {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .legend span {
    width: 9px;
    height: 9px;
    border-radius: 2px;
  }
  .note {
    margin: 14px 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--colors-muted);
  }
  details {
    margin-top: 14px;
    font-size: 12px;
  }
  summary {
    color: var(--colors-muted);
    cursor: pointer;
  }
  table {
    width: 100%;
    margin-top: 14px;
    border-collapse: collapse;
  }
  th,
  td {
    padding: 9px 12px;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid var(--colors-line);
  }
  th {
    font-weight: 500;
  }
  tbody th {
    min-width: 180px;
    white-space: normal;
  }
</style>
