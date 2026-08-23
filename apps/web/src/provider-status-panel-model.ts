import { compareProviderStatusStates, type ProviderStatusState } from '@ai-usage/report-core/provider-status';
import type { ProviderStatusView } from './provider-status-model';

export interface ProviderStatusPanelSummary {
  criticalProvidersWithoutQuota: ProviderStatusView[];
  providersWithoutQuotaSource: ProviderStatusView[];
  quotaProviders: ProviderStatusView[];
  /**
   * Every view, in the order `buildProviderStatusViews` ranked them. The three partitions above are
   * disjoint slices of this list and cannot reconstruct its interleaving, so the panel keeps the
   * ranked list to render detail cards in the order a reader already saw them ranked.
   */
  rankedProviders: ProviderStatusView[];
}

export interface ProviderMachineLine {
  readonly key: string;
  readonly machineLabel: string | null;
  readonly providers: ProviderStatusView[];
  readonly text: string;
}

interface ProviderStateGroup {
  readonly labels: string[];
  readonly state: ProviderStatusState;
}

export const buildProviderStatusPanelSummary = (providers: ProviderStatusView[]): ProviderStatusPanelSummary => {
  const quotaProviders: ProviderStatusView[] = [];
  const criticalProvidersWithoutQuota: ProviderStatusView[] = [];
  const providersWithoutQuotaSource: ProviderStatusView[] = [];

  for (const provider of providers) {
    if (provider.windowGroups.length > 0) {
      quotaProviders.push(provider);
      continue;
    }
    if (provider.tone === 'critical') {
      criticalProvidersWithoutQuota.push(provider);
      continue;
    }
    providersWithoutQuotaSource.push(provider);
  }

  return {
    criticalProvidersWithoutQuota,
    providersWithoutQuotaSource,
    quotaProviders,
    rankedProviders: [...providers],
  };
};

const isFlagged = (view: ProviderStatusView): boolean =>
  (view.provider.warnings?.length ?? 0) > 0 || view.creditsSummary !== null;

const carriesDetail = (view: ProviderStatusView): boolean =>
  view.windowGroups.length > 0 || view.tone === 'critical' || isFlagged(view);

/**
 * Providers that carry something a reader can act on: a limit reading, a critical tone, a warning,
 * or a credits summary. A provider that only says "no limit reading" is already covered by the
 * machine lines, so a card of its own turns the disclosure into a wall of identical dead ends.
 * Filtered out of the ranked input, never out of the partitions: concatenating the partitions would
 * put a provider with windows ahead of a critical one, the opposite of how the views were ranked.
 */
export const detailedProviders = (summary: ProviderStatusPanelSummary): ProviderStatusView[] =>
  summary.rankedProviders.filter(carriesDetail);

// `partial` and `unsupported` lead because they are what a machine with no limit reading almost
// always reports; the remaining states keep the shared severity order from report-core.
const LEADING_STATES: readonly ProviderStatusState[] = ['partial', 'unsupported'];

const leadingRank = (state: ProviderStatusState): number => {
  const index = LEADING_STATES.indexOf(state);
  return index < 0 ? LEADING_STATES.length : index;
};

const compareLineStates = (left: ProviderStatusState, right: ProviderStatusState): number => {
  const byLeading = leadingRank(left) - leadingRank(right);
  return byLeading === 0 ? compareProviderStatusStates(left, right) : byLeading;
};

const readableState = (state: ProviderStatusState): string => state.replaceAll('-', ' ');

const statesInLineOrder = (providers: readonly ProviderStatusView[]): ProviderStatusState[] =>
  [...new Set(providers.map((view) => view.provider.state))].sort(compareLineStates);

/**
 * De-duplicates by provider **key**, never by label: two providers can carry the same display name,
 * and collapsing them would print fewer names than the sentence counts. Even so this is only ever
 * correct within one machine group, because the same provider on two machines is ordinary data
 * under this repo's partial-data rule. Panel-wide counting uses `countByState`, which counts views.
 */
const groupByState = (providers: readonly ProviderStatusView[]): ProviderStateGroup[] =>
  statesInLineOrder(providers).map((state) => {
    const byKey = new Map<string, string>();
    for (const view of providers.filter((candidate) => candidate.provider.state === state)) {
      byKey.set(view.provider.key, view.provider.label);
    }
    return { labels: [...byKey.values()].sort((left, right) => left.localeCompare(right)), state };
  });

const countByState = (providers: readonly ProviderStatusView[]): { count: number; state: ProviderStatusState }[] =>
  statesInLineOrder(providers).map((state) => ({
    count: providers.filter((view) => view.provider.state === state).length,
    state,
  }));

interface MachineGroup {
  readonly id: string;
  readonly label: string | null;
  readonly views: ProviderStatusView[];
}

/**
 * Unscoped last, then by the visible label, then by id so two machines that share a label keep a
 * stable order instead of swapping between renders.
 */
const compareMachineGroups = (left: MachineGroup, right: MachineGroup): number => {
  if (left.label === null || right.label === null) {
    if (left.label === right.label) {
      return left.id.localeCompare(right.id);
    }
    return left.label === null ? 1 : -1;
  }
  const byLabel = left.label.localeCompare(right.label);
  return byLabel === 0 ? left.id.localeCompare(right.id) : byLabel;
};

/**
 * One line per machine, grouped on the **stable machine id** and only labelled with
 * `machineContext`. Two machines are allowed to share a display name, and grouping on that name
 * collapsed them into one line while the summary sentence still counted both — the panel would say
 * "2 providers" over a single visible "Cursor". This repo settles that the id is the identity and
 * the duplicate label is shown twice (`dashboard-model.test.ts`, "filters duplicate machine labels
 * by stable machine ID"). The whole sentence is built here rather than in the template: a flex
 * container drops the whitespace text nodes between its items, which is what turned
 * "Codex · MacBook-Pro" into "Codex· MacBook-Pro".
 */
export const providerMachineLines = (providers: readonly ProviderStatusView[]): ProviderMachineLine[] => {
  const byMachine = new Map<string, MachineGroup>();
  for (const view of providers) {
    const id = view.provider.machineId ?? '';
    const group = byMachine.get(id) ?? { id, label: view.machineContext, views: [] };
    group.views.push(view);
    byMachine.set(id, group);
  }
  return [...byMachine.values()].sort(compareMachineGroups).map(({ id, label, views }) => {
    const clauses = groupByState(views).map(({ labels, state }) => `${labels.join(', ')} — ${readableState(state)}`);
    return {
      key: id,
      machineLabel: label,
      providers: views,
      text: `${label === null ? '' : `${label} · `}${clauses.join(' · ')}`,
    };
  });
};

const providerCountLabel = (count: number): string => `${count} provider${count === 1 ? '' : 's'}`;

const stateBreakdown = (providers: readonly ProviderStatusView[]): string =>
  countByState(providers)
    .map(({ count, state }) => `${count} ${readableState(state)}`)
    .join(', ');

/**
 * The single sentence that replaced five counter chips. `total = quota + withoutSource + critical`
 * is the identity a reader can check; the flagged count is a subset of `withoutSource` and is
 * therefore appended as a qualifier, never as a fourth term of the sum.
 *
 * Says "usage limit", not "quota window": plan 086's copy rule replaces internal mechanism names
 * with what the reader can act on, and binds every child plan regardless of the grammar a child's
 * own step proposed.
 */
export const describeProviderStatusSummary = (summary: ProviderStatusPanelSummary): string => {
  const quotaCount = summary.quotaProviders.length;
  const criticalCount = summary.criticalProvidersWithoutQuota.length;
  const withoutSourceCount = summary.providersWithoutQuotaSource.length;
  const flaggedCount = summary.providersWithoutQuotaSource.filter(isFlagged).length;
  const breakdown = withoutSourceCount > 0 ? ` (${stateBreakdown(summary.providersWithoutQuotaSource)})` : '';
  const critical = criticalCount > 0 ? ` · ${criticalCount} critical` : '';
  const flagged = flaggedCount > 0 ? ` · ${flaggedCount} with warnings` : '';
  return `${providerCountLabel(quotaCount + criticalCount + withoutSourceCount)} · ${quotaCount} reporting a usage limit · ${withoutSourceCount} with no limit reading${breakdown}${critical}${flagged}`;
};
