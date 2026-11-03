<script lang="ts">
  import { ghostButton } from '@ai-usage/design-system/report';
  import type { Constellation } from '@ai-usage/report-core/constellation';
  import { fmtCompact } from '../../foundation/presentation/format';
  import { constellationPositions, projectConstellation } from './constellation-layout';

  let { map, sessionHref }: { map: Constellation; sessionHref: (id: string) => string } = $props();
  let mode = $state<'2d' | '3d'>('2d');
  let yaw = $state(0);
  let pitch = $state(0);
  let zoom = $state(1);
  let selectedId = $state('');
  let dragging = $state<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const points = $derived(constellationPositions(map));
  const projected = $derived(projectConstellation(points, mode, yaw, pitch, zoom));
  const byId = $derived(new Map(projected.map((point) => [point.node.id, point])));
  const selected = $derived(map.nodes.find((node) => node.id === selectedId) ?? map.nodes[0]);
  const projects = $derived([
    ...new Map(
      projected.map((point) => [
        point.node.projectKey,
        { key: point.node.projectKey, label: point.node.projectLabel, x: point.x, y: point.y },
      ]),
    ).values(),
  ]);
  const pointerDown = (event: PointerEvent) => {
    if (mode !== '3d' || event.target !== event.currentTarget) {
      return;
    }
    dragging = { x: event.clientX, y: event.clientY, yaw, pitch };
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent) => {
    if (!dragging) {
      return;
    }
    yaw = dragging.yaw + (event.clientX - dragging.x) / 140;
    pitch = Math.max(-1.2, Math.min(1.2, dragging.pitch + (event.clientY - dragging.y) / 140));
  };
</script>
<section aria-label="Session constellation" class="panel">
  <h2>Sessions in perspective</h2>
  <p class="muted">
    {map.nodes.length}
    of {map.totalSessions} matching sessions shown, largest recorded token volumes first. Global token-flow totals above
    include the full selection.
  </p>
  <div class="controls">
    <label
      >Projection<select bind:value={mode}>
        <option value="2d">2D</option>
        <option value="3d">3D</option>
      </select></label
    >
    <label
      >Zoom<input aria-label="Constellation zoom" max="1.5" min="0.6" step="0.05" type="range" bind:value={zoom}></label
    >
    {#if mode === '3d'}
      <button class={ghostButton} onclick={() => (yaw -= Math.PI / 8)} type="button">Rotate left</button>
      <button class={ghostButton} onclick={() => (yaw += Math.PI / 8)} type="button">Rotate right</button>
      <label
        >Tilt<input
          aria-label="Constellation tilt"
          max="1.2"
          min="-1.2"
          step="0.1"
          type="range"
          bind:value={pitch}
        ></label
      >
    {/if}
    <button
      class={ghostButton}
      onclick={() => {
        yaw = 0;
        pitch = 0;
        zoom = 1;
      }}
      type="button"
    >
      Reset view
    </button>
  </div>
  <!-- biome-ignore lint/a11y/useSemanticElements: An SVG group of native links has no fieldset equivalent. -->
  <svg
    aria-label="Sessions grouped by project with declared parent links; use the session selector below for an equivalent list"
    class="graphic"
    onpointercancel={() => (dragging = null)}
    onpointerdown={pointerDown}
    onpointermove={pointerMove}
    onpointerup={() => (dragging = null)}
    role="group"
    viewBox="0 0 800 500"
  >
    <title>Session constellation</title>
    {#each projected as point (point.node.id)}
      {@const parent = point.node.parentId ? byId.get(point.node.parentId) : null}
      {#if parent}
        <line opacity="0.22" stroke="currentColor" x1={point.x} x2={parent.x} y1={point.y} y2={parent.y} />
      {/if}
    {/each}
    {#each projected as point (point.node.id)}
      <a aria-label={`Open session ${point.node.title}`} href={sessionHref(point.node.id)}>
        <circle
          cx={point.x}
          cy={point.y}
          data-constellation-node={point.node.id}
          fill="currentColor"
          opacity={point.node.partial ? 0.45 : 0.85}
          r={point.radius}
          stroke={selected?.id === point.node.id ? 'currentColor' : 'none'}
          stroke-width="3"
        >
          <title>
            {point.node.title}
            · {point.node.projectLabel} · {fmtCompact(point.node.tokens)} tokens{point.node.partial
              ? ' · incomplete usage'
              : ''}
          </title>
        </circle>
      </a>
    {/each}
    {#each projects as project (project.key)}
      <text
        class="label"
        pointer-events="none"
        x={Math.max(5, Math.min(650, project.x))}
        y={Math.max(20, Math.min(480, project.y - 24))}
      >
        {project.label.slice(0, 25)}
      </text>
    {/each}
  </svg>
  <p class="muted">
    Proximity groups projects; it does not establish collaboration. Lines show declared parents among displayed
    sessions. Radius follows √tokens; 3D perspective changes apparent size. Drag the background in 3D or use rotation
    and tilt controls. The view does not animate automatically.
  </p>
  {#if map.unresolvedParents}
    <p class="muted" role="status">
      {map.unresolvedParents}
      declared parent links are outside this view, ambiguous or cyclic; no replacement link is inferred.
    </p>
  {/if}
  {#if selected}
    <div class="controls">
      <label
        >Inspect a session<select bind:value={selectedId}>
          <option value="">Choose a displayed session</option>
          {#each map.nodes as node (node.id)}
            <option value={node.id}>{node.projectLabel} · {node.title}</option>
          {/each}
        </select></label
      >
    </div>
    <div class="inspector">
      <strong>{selected.title}</strong
      ><span
        >{selected.harness}
        · {fmtCompact(selected.tokens)} tokens{selected.partial ? ' · incomplete usage' : ''}</span
      ><a class={ghostButton} href={sessionHref(selected.id)}>Open selected session</a>
    </div>
  {/if}
</section>

<style>
  .panel {
    display: grid;
    gap: 16px;
    min-width: 0;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
  }
  .controls label {
    display: grid;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    font-size: 12px;
  }
  .controls select {
    max-width: 100%;
    padding: 8px;
    color: var(--colors-ink);
    background: var(--colors-surface);
    border: 1px solid var(--colors-line);
  }
  .graphic {
    width: 100%;
    min-height: 280px;
    max-height: 600px;
    color: var(--colors-accent);
    touch-action: pan-y;
    background: var(--colors-surface-muted);
    border: 1px solid var(--colors-line);
    border-radius: var(--radii-md);
  }
  .label {
    font-size: 12px;
    fill: var(--colors-ink);
    stroke: var(--colors-surface);
    stroke-width: 3px;
    paint-order: stroke;
  }
  .muted {
    font-size: 13px;
    line-height: 1.6;
    color: var(--colors-muted);
  }
  .inspector {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    padding-top: 12px;
    border-top: 1px solid var(--colors-line);
  }
</style>
