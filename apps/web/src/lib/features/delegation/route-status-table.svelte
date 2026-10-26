<script lang="ts">
  import { cx } from '@ai-usage/design-system/css';
  import { statusPill, statusPillDanger, statusPillInfo, statusPillWarn } from '@ai-usage/design-system/svelte';
  import type { DelegationRouteStatus } from './delegation-contract';
  import {
    availabilityText,
    contextText,
    harnessDisplayName,
    identityText,
    quotaWindowText,
    subscriptionText,
  } from './delegation-model';
  import {
    cardList,
    cellMono,
    compactList,
    entryCard,
    entryTitle,
    factList,
    factTerm,
    factValue,
    monoText,
    rowHeader,
    statusTable,
    tableCaption,
    tableFrame,
    workMuted,
  } from './delegation-styles';

  let { routes }: { routes: readonly DelegationRouteStatus[] } = $props();

  const routeLine = (route: DelegationRouteStatus): string =>
    `${harnessDisplayName(route.harness)} · ${route.model ?? 'model unknown'} · effort ${route.effort ?? 'unknown'}`;
  const checkedLine = (route: DelegationRouteStatus): string => `last checked ${route.lastCheckedAt ?? 'never'}`;
</script>

{#if routes.length === 0}
  <p aria-live="polite" class={workMuted} data-delegation-routes="empty">
    No route yet: declare an executor below, then give it a context.
  </p>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -- a horizontally scrollable region must be keyboard-reachable -->
  <!-- biome-ignore lint/a11y/noNoninteractiveTabindex: axe requires a scrollable region to be keyboard-focusable -->
  <section aria-label="Route status table" class={tableFrame} data-delegation-routes="table" tabindex="0">
    <table class={statusTable}>
      <caption class={tableCaption}>
        One row per declared executor and model; models of one account share one pool.
      </caption>
      <thead>
        <tr>
          <th scope="col">Route</th>
          <th scope="col">Context</th>
          <th scope="col">Provider</th>
          <th scope="col">Account and pool</th>
          <th scope="col">Identity</th>
          <th scope="col">Availability</th>
          <th scope="col">Quota windows</th>
          <th scope="col">Missing data</th>
        </tr>
      </thead>
      <tbody>
        {#each routes as route (route.routeId)}
          {@const context = contextText(route.context)}
          <tr data-delegation-route={route.routeId}>
            <th class={rowHeader} scope="row">
              <span class={entryTitle}>{route.label}</span>
              <span class={cellMono}>{routeLine(route)}</span>
            </th>
            <td>
              <span class={cx(statusPill, context.admissible ? statusPillInfo : statusPillDanger)}>{context.text}</span>
            </td>
            <td>{route.provider} · {subscriptionText(route.subscription)}</td>
            <td>{route.accountScope}<span class={cellMono}>pool {route.poolId}</span></td>
            <td>{identityText(route.identity)}</td>
            <td>{availabilityText(route.availability)}<span class={cellMono}>{checkedLine(route)}</span></td>
            <td>
              {#if route.quota.windows.length === 0}
                no quota observed
              {:else}
                {#if route.quota.provenance === 'stale'}
                  <span class={cx(statusPill, statusPillWarn)}>stale</span>
                {/if}
                <ul class={compactList}>
                  {#each route.quota.windows as window (window.label)}
                    <li>{quotaWindowText(window, route.quota.provenance)}</li>
                  {/each}
                </ul>
              {/if}
            </td>
            <td>
              {#if route.missing.length === 0}
                —
              {:else}
                <ul class={compactList}>
                  {#each route.missing as action, index (index)}
                    <li>{action}</li>
                  {/each}
                </ul>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
  <div class={cardList} data-delegation-routes="cards">
    {#each routes as route (route.routeId)}
      {@const context = contextText(route.context)}
      <article aria-labelledby="route-card-{route.routeId}" class={entryCard} data-delegation-route={route.routeId}>
        <h3 class={entryTitle} id="route-card-{route.routeId}">{route.label}</h3>
        <p class={monoText}>{routeLine(route)}</p>
        <dl class={factList}>
          <div>
            <dt class={factTerm}>Context</dt>
            <dd class={factValue}>
              <span class={cx(statusPill, context.admissible ? statusPillInfo : statusPillDanger)}>{context.text}</span>
            </dd>
          </div>
          <div>
            <dt class={factTerm}>Provider</dt>
            <dd class={factValue}>{route.provider} · {subscriptionText(route.subscription)}</dd>
          </div>
          <div>
            <dt class={factTerm}>Account and pool</dt>
            <dd class={factValue}>{route.accountScope} · pool {route.poolId}</dd>
          </div>
          <div>
            <dt class={factTerm}>Identity</dt>
            <dd class={factValue}>{identityText(route.identity)}</dd>
          </div>
          <div>
            <dt class={factTerm}>Availability</dt>
            <dd class={factValue}>{availabilityText(route.availability)} · {checkedLine(route)}</dd>
          </div>
          <div>
            <dt class={factTerm}>Quota windows</dt>
            <dd class={factValue}>
              {#if route.quota.windows.length === 0}
                no quota observed
              {:else}
                <ul class={compactList}>
                  {#each route.quota.windows as window (window.label)}
                    <li>{quotaWindowText(window, route.quota.provenance)}</li>
                  {/each}
                </ul>
              {/if}
            </dd>
          </div>
          <div>
            <dt class={factTerm}>Missing data</dt>
            <dd class={factValue}>
              {#if route.missing.length === 0}
                —
              {:else}
                <ul class={compactList}>
                  {#each route.missing as action, index (index)}
                    <li>{action}</li>
                  {/each}
                </ul>
              {/if}
            </dd>
          </div>
        </dl>
      </article>
    {/each}
  </div>
{/if}
