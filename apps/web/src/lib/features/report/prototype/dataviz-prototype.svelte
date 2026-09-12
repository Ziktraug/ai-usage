<!-- Throwaway real-data UI prototype: three compositions on /?variant=parcours|activite|campagnes. -->
<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import { webQueryPolicies } from '../../../query/policies';
  import { createBrowserWebRpcClient } from '../../../rpc/client';
  import {
    alluvial,
    campaignArcs,
    campaignOptions,
    campaignPartition,
    exact,
    filterRows,
    fmt,
    rankedModels,
    ridgeline,
    short,
    sumTokens,
    temporal,
  } from './dataviz-model';
  import PrototypePlot from './prototype-plot.svelte';

  const pressedAria = (pressed: boolean): { readonly 'aria-pressed': 'false' | 'true' } => ({
    'aria-pressed': pressed ? 'true' : 'false',
  });
  const client = browser ? createBrowserWebRpcClient('dataviz-prototype') : null;
  const query = createQuery(() => ({
    ...webQueryPolicies.immutableRevision,
    queryKey: ['prototype', 'dataviz', 'fixed-local-snapshot'],
    enabled: browser,
    queryFn: ({ signal }) => {
      if (!client) {
        throw new Error('Browser unavailable.');
      }
      return client.datavizPrototype.snapshot({}, { signal });
    },
  }));
  const variants = [
    { key: 'parcours', label: 'Parcours des tokens' },
    { key: 'activite', label: 'Paysage et trajectoires' },
    { key: 'campagnes', label: 'Campagnes et délégation' },
  ] as const;
  let variantOverride = $state<string | null>(null);
  const variant = $derived(variantOverride ?? page.url.searchParams.get('variant') ?? 'parcours');
  let days = $state(30);
  let project = $state('');
  let highlighted = $state('');
  let activity = $state<'stream' | 'bump' | 'ridge'>('stream');
  let campaignKey = $state('');
  let zoom = $state('');
  let campaignMode = $state<'icicle' | 'arcs'>('icicle');
  let round = $state(2000);
  const snapshot = $derived(query.data);
  const rows = $derived(snapshot ? filterRows(snapshot, days, project) : []);
  const campaigns = $derived(campaignOptions(rows));
  const effectiveCampaign = $derived(
    campaigns.some((c) => c.key === campaignKey) ? campaignKey : (campaigns[0]?.key ?? ''),
  );
  const allMembers = $derived(snapshot?.rows.filter((r) => r.campaign === effectiveCampaign) ?? []);
  const root = $derived(allMembers.find((r) => r.root));
  const detail = $derived(snapshot?.details.find((d) => d.rowId === root?.id));
  const maxRound = $derived(detail?.rounds.length ?? 0);
  const modelNames = $derived(rankedModels(rows).slice(0, 5));
  const projects = $derived.by(() => {
    const byKey = new Map<string, string>();
    for (const row of snapshot?.rows ?? []) {
      byKey.set(row.project, row.projectLabel);
    }
    return [...byKey].sort((a, b) => a[1].localeCompare(b[1]));
  });
  const plot = $derived.by(() => {
    if (!(snapshot && rows.length)) {
      return null;
    }
    if (variant === 'campagnes') {
      return campaignMode === 'arcs'
        ? campaignArcs(snapshot, effectiveCampaign, Math.min(round, maxRound))
        : campaignPartition(snapshot.rows, effectiveCampaign, zoom);
    }
    if (variant === 'activite') {
      return activity === 'ridge' ? ridgeline(rows) : temporal(rows, activity, highlighted);
    }
    return alluvial(rows, highlighted);
  });
  const selectedVariant = $derived(variants.find((v) => v.key === variant) ?? variants[0]);
  const switchVariant = (key: string) => {
    const url = new URL(page.url);
    url.searchParams.set('variant', key);
    replaceState(url, page.state);
    variantOverride = key;
    highlighted = '';
  };
  const cycle = (offset: number) =>
    switchVariant(
      variants[(variants.findIndex((v) => v.key === selectedVariant.key) + offset + variants.length) % variants.length]
        ?.key ?? 'parcours',
    );
  const keyboard = (event: KeyboardEvent) => {
    if (!(event.key === 'ArrowLeft' || event.key === 'ArrowRight') || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.closest(
        'input,textarea,select,button,[contenteditable=true],[role=slider],.plot-scroll,.table-scroll',
      )
    ) {
      return;
    }
    event.preventDefault();
    cycle(event.key === 'ArrowRight' ? 1 : -1);
  };
  onMount(() => {
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
</script>

<section aria-label="Prototype dataviz avec données réelles" class="prototype" data-dataviz-prototype>
  <div class="intro">
    <div>
      <span class="eyebrow">EXPLORATIONS / DONNÉES RÉELLES</span>
      <h1>{selectedVariant.label}</h1>
      <p class="muted">
        {#if variant==='parcours'}
          Suivre les contributions entre harness, modèle et projet.
        {:else if variant==='activite'}
          Lire les changements de composition, de classement et de forme des sessions.
        {:else}
          Explorer les branches et les relations observées dans une campagne.
        {/if}
      </p>
    </div>
    <span class="badge">Prototype local</span>
  </div>
  {#if query.isPending}
    <p role="status">Chargement de la capture réelle…</p>
  {:else if query.error}
    <p role="alert">La capture ne peut pas être chargée : {query.error.message}</p>
    <button onclick={()=>query.refetch()} type="button">Réessayer</button>
  {:else if snapshot}
    <div class="filters">
      <label
        >Période<select onchange={()=>{highlighted='';zoom='';}} bind:value={days}>
          <option value={14}>14 derniers jours</option>
          <option value={30}>30 derniers jours</option>
          <option value={90}>90 derniers jours</option>
          <option value={0}>Tout l’historique</option>
        </select></label
      ><label
        >Projet<select onchange={()=>{highlighted='';zoom='';}} bind:value={project}>
          <option value="">Tous les projets</option>
          {#each projects as [ key, label ]}
            <option value={key}>{label}</option>
          {/each}
        </select></label
      >
      <p class="capture">
        Capture du {new Date(snapshot.capturedAt).toLocaleString('fr-FR')}<br>Rapport du
        {new Date(snapshot.generatedAt).toLocaleString('fr-FR')}
      </p>
    </div>
    <div class="metrics">
      <div><strong>{fmt(sumTokens(rows))}</strong><span>tokens traités</span></div>
      <div><strong>{exact(rows.length)}</strong><span>sessions individuelles</span></div>
      <div><strong>{new Set(rows.map(r=>r.project)).size}</strong><span>projets</span></div>
      <div><strong>{rows.filter(r=>r.partial).length}</strong><span>sessions partielles / indisponibles</span></div>
    </div>
    <p class="scope">
      {days ? `${days} jours jusqu’à la dernière date enregistrée` : 'Toutes les dates enregistrées'}
      · {rows.flatMap(r=>r.day?[r.day]:[]).sort()[0]??'—'} → {rows.flatMap(r=>r.day?[r.day]:[]).sort().at(-1)??'—'} ·
      Les sessions contribuent selon la date du rapport, pas selon une ventilation de leurs appels dans le temps.
    </p>
    <div class="view-controls">
      {#if variant==='activite'}
        <fieldset aria-label="Représentation de l’activité" class="segments">
          {#each [{key:'stream',label:'Streamgraph'},{key:'bump',label:'Bump chart'},{key:'ridge',label:'Ridgeline'}] as mode}
            <button
              {...pressedAria(activity===mode.key)}
              onclick={()=>{activity=mode.key as typeof activity;highlighted='';}}
              type="button"
            >
              {mode.label}
            </button>
          {/each}
        </fieldset>
        {#if activity!=='ridge'}
          <label
            >Mettre en évidence<select bind:value={highlighted}>
              <option value="">Tous les modèles</option>
              {#each modelNames as name}
                <option value={name}>{name}</option>
              {/each}
            </select></label
          >
        {/if}
      {:else if variant==='campagnes'}
        <label class="campaign-choice"
          >Campagne<select onchange={()=>{zoom='';round=2000;}} bind:value={campaignKey}>
            <option value="">Campagne dominante de la sélection</option>
            {#each campaigns.slice(0,100) as c}
              <option value={c.key}>
                {snapshot.details.some(d=>d.rowId===c.rootId && d.interactions.length>0)?'↗ ':''}{short(c.label,85)}
                · {c.count} sessions · {fmt(c.tokens)}
              </option>
            {/each}
          </select></label
        >
        <div class="segments">
          <button {...pressedAria(campaignMode==='icicle')} onclick={()=>campaignMode='icicle'} type="button">
            Icicle
          </button><button
            {...pressedAria(campaignMode==='arcs')}
            onclick={()=>{campaignMode='arcs';const candidate=campaigns.find(c=>snapshot?.details.some(d=>d.rowId===c.rootId && d.interactions.length>0));if(candidate){campaignKey=candidate.key;round=2000;}}}
            type="button"
          >
            Arcs
          </button>
        </div>
      {:else}
        <label
          >Mettre en évidence un projet (petits projets regroupés)<select bind:value={highlighted}>
            <option value="">Tous les chemins</option>
            {#each [...new Map(rows.map(r=>[r.project,r.projectLabel]))] as [ key, label ]}
              <option value={key}>{label}</option>
            {/each}
          </select></label
        >
      {/if}
    </div>
    {#if variant==='campagnes'}
      <p class="campaign-context">
        {campaigns.find(c=>c.key===effectiveCampaign)?.label ?? 'Aucune campagne avec plusieurs sessions'}
        · {allMembers.length} membres sur tout l’historique · {fmt(sumTokens(allMembers))} tokens. La sélection
        ci-dessus classe les campagnes dans la période ; le détail inclut tous leurs membres.
      </p>
      {#if campaignMode==='icicle' && allMembers.length}
        <label
          >Zoom sur une session<select bind:value={zoom}>
            <option value="">Toute la campagne</option>
            {#each allMembers as member}
              <option value={member.id}>{short(member.label,90)} · {fmt(member.tokens)} propres</option>
            {/each}
          </select></label
        >
      {:else if maxRound>0}
        <label
          >Interactions jusqu’au round {Math.min(round,maxRound)} / {maxRound}
          <input
            max={maxRound}
            min="1"
            oninput={e=>round=Number(e.currentTarget.value)}
            type="range"
            value={Math.min(round,maxRound)}
          ></label
        >
      {/if}
    {/if}
    {#if plot && (variant!=='campagnes'||allMembers.length)}
      <div class="chart"><PrototypePlot {plot} /></div>
    {:else}
      <p role="status">Aucune donnée pour cette sélection. Élargis la période ou change de projet.</p>
    {/if}
    <p class="footnote">
      Capture figée de {exact(snapshot.rows.length)} sessions ·
      {snapshot.details.filter(d=>d.status==='available').length}
      détails de racine disponibles sur
      {snapshot.details.length}
      capturés · aucune donnée fictive. Les relations sans preuve restent non attribuées.
    </p>
  {/if}
  <nav aria-label="Variantes du prototype" class="switcher">
    <button aria-label="Variante précédente" onclick={()=>cycle(-1)} type="button">←</button>
    {#each variants as v}
      <button {...pressedAria(selectedVariant.key===v.key)} onclick={()=>switchVariant(v.key)} type="button">
        {v.label}
      </button>
    {/each}
    <button aria-label="Variante suivante" onclick={()=>cycle(1)} type="button">→</button>
  </nav>
</section>
<style>
  .prototype {
    padding-bottom: 100px;
    color: var(--colors-ink);
  }
  .intro {
    display: flex;
    gap: 20px;
    align-items: start;
    justify-content: space-between;
    padding-top: 25px;
    border-top: 1px solid var(--colors-line);
  }
  .eyebrow {
    font-size: 10px;
    color: var(--colors-accent);
    letter-spacing: 1.4px;
  }
  h1 {
    margin: 8px 0 10px;
    font-size: 28px;
    font-weight: 500;
    letter-spacing: -0.7px;
  }
  .muted {
    font-size: 14px;
    color: var(--colors-muted);
  }
  .badge {
    padding: 4px 9px;
    font-size: 11px;
    white-space: nowrap;
    border: 1px solid var(--colors-line);
    border-radius: 25px;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: end;
    margin: 28px 0 24px;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-width: 100%;
    font-size: 11px;
    color: var(--colors-muted);
  }
  select,
  button {
    min-height: 40px;
    padding: 9px 12px;
    font: inherit;
    font-size: 12px;
    color: var(--colors-ink);
    background: var(--colors-surface);
    border: 1px solid var(--colors-line);
    border-radius: 5px;
  }
  select {
    max-width: 100%;
  }
  button {
    cursor: pointer;
  }
  button[aria-pressed="true"] {
    color: var(--colors-canvas);
    background: var(--colors-accent);
  }
  :is(button, select, input):focus-visible {
    outline: 2px solid var(--colors-accent);
    outline-offset: 3px;
  }
  .capture {
    margin-left: auto;
    font-size: 11px;
    color: var(--colors-muted);
    text-align: right;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 20px;
    padding: 22px 0;
    border-top: 1px solid var(--colors-line);
    border-bottom: 1px solid var(--colors-line);
  }
  .metrics div {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .metrics strong {
    font-size: 29px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .metrics span {
    font-size: 11px;
    color: var(--colors-muted);
  }
  .scope,
  .footnote {
    margin: 12px 0 24px;
    font-size: 11px;
    line-height: 1.7;
    color: var(--colors-muted);
  }
  .view-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    align-items: end;
    justify-content: space-between;
    margin: 28px 0 14px;
  }
  .segments {
    display: flex;
    gap: 6px;
  }
  .campaign-choice {
    flex: 1;
    min-width: 240px;
  }
  .campaign-context {
    margin: 16px 0;
    font-size: 12px;
    line-height: 1.7;
  }
  .chart {
    padding: 18px 0;
    margin-top: 18px;
    border-top: 1px solid var(--colors-line);
  }
  .switcher {
    position: fixed;
    bottom: 18px;
    left: 50%;
    z-index: 40;
    display: flex;
    gap: 4px;
    max-width: calc(100vw - 24px);
    padding: 5px;
    overflow-x: auto;
    background: var(--colors-canvas);
    border: 1px solid var(--colors-line);
    border-radius: 9px;
    transform: translateX(-50%);
  }
  .switcher button {
    white-space: nowrap;
  }
  .footnote {
    margin-top: 24px;
  }
  input[type="range"] {
    width: 100%;
    max-width: 480px;
    accent-color: var(--colors-accent);
  }
  @media (max-width: 700px) {
    .metrics {
      grid-template-columns: repeat(2, 1fr);
    }
    .capture {
      margin-left: 0;
      text-align: left;
    }
    .switcher {
      bottom: 78px;
    }
    .switcher button {
      padding: 7px;
      font-size: 10px;
    }
    h1 {
      font-size: 23px;
    }
    .prototype {
      padding-bottom: 150px;
    }
  }
</style>
