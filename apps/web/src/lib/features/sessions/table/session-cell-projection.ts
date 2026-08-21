import type { UsageMetricKey, UsageRowProvenance } from '@ai-usage/report-core/provenance';
import { provenanceForMetric } from '@ai-usage/report-core/provenance';
import {
  campaignBadgeLabelForSessionRow,
  classifierRollupLabelForSessionRow,
  type SessionPresentationRow,
  sessionOriginLabel,
} from '@ai-usage/report-core/session-query';
import { rtkSavedTitle } from '../../../../dashboard-sort';
import { sessionDurationSemantics } from '../../../../session-analysis-model';
import { boundedSessionListLabel, caseInsensitiveLiteralMatches } from '../../../../session-list-label';
import type { SessionColumnId } from '../../../../session-table-schema';
import { fmtCompact } from '../../../foundation/presentation/format';
import {
  aggregateApiValuePresentation,
  apiValuePresentation,
  USAGE_UNAVAILABLE_HINT,
} from '../../../foundation/presentation/report-value';
import type { TableSortingState } from '../../../foundation/table/state';
import { sessionColumnById } from './session-columns';

export interface SessionHighlightSegment {
  readonly match: boolean;
  readonly text: string;
}

export type SessionCellProjection =
  | {
      readonly kind: 'harness-filter';
      readonly label: string;
      readonly title: string;
      readonly value: string;
    }
  | {
      readonly field: 'model' | 'project' | 'provider';
      readonly kind: 'field-filter';
      readonly label: string;
      readonly title: string;
      readonly value: string;
    }
  | {
      readonly campaignLabel: string | null;
      readonly classifierLabel: string | null;
      readonly inheritedTitle: string | null;
      readonly kind: 'session';
      readonly originLabel: string | null;
      readonly provenanceFacts: readonly UsageRowProvenance[];
      readonly segments: readonly SessionHighlightSegment[];
    }
  | {
      readonly kind: 'value';
      readonly label: string;
      readonly provenanceFacts: readonly UsageRowProvenance[];
      readonly title: string | undefined;
    };

const TEXT_COLUMNS = new Set<SessionColumnId>(['session', 'harness', 'machine', 'provider', 'project', 'model']);
const USAGE_UNAVAILABLE_COLUMNS = new Set<SessionColumnId>([
  'tokIn',
  'tokOut',
  'cache',
  'tokCw',
  'fresh',
  'total',
  'cost',
  'actual',
  'quota',
  'calls',
  'tools',
]);
const API_PRICE_PROVENANCE_KINDS = new Set(['partial-api-price', 'unknown-api-price']);

export const sessionSortDescendingByDefault = (id: SessionColumnId): boolean => !TEXT_COLUMNS.has(id);
export const sessionSortForColumnChange = (sorting: TableSortingState, id: SessionColumnId): TableSortingState => [
  {
    desc: sorting[0]?.desc ?? sessionSortDescendingByDefault(id),
    id,
  },
];
export const shouldSelectSessionRowForKey = (key: string, nativeButton: boolean): boolean =>
  !nativeButton && (key === 'Enter' || key === ' ');

export const applySessionFieldFilter = (
  event: Pick<Event, 'stopPropagation'>,
  onFilter: (field: 'model' | 'project' | 'provider', value: string) => void,
  field: 'model' | 'project' | 'provider',
  value: string,
): void => {
  event.stopPropagation();
  onFilter(field, value);
};

const highlightedSegments = (text: string, query: string): readonly SessionHighlightSegment[] => {
  const bounded = boundedSessionListLabel(text, query);
  const matches = caseInsensitiveLiteralMatches(bounded, query);
  if (matches.length === 0) {
    return [{ match: false, text: bounded }];
  }
  const segments: SessionHighlightSegment[] = [];
  let index = 0;
  for (const match of matches) {
    if (match.start > index) {
      segments.push({ match: false, text: bounded.slice(index, match.start) });
    }
    segments.push({ match: true, text: bounded.slice(match.start, match.end) });
    index = match.end;
  }
  if (index < bounded.length) {
    segments.push({ match: false, text: bounded.slice(index) });
  }
  return segments;
};

/**
 * A generic title is one the harness never declared: the collectors fall back to
 * `subagent <id>` / `claude <id>` and record `agent-role` or `id` as the source.
 * An absent `titleSource` means nothing was declared about the title at all — do
 * not guess that such a row is generic.
 */
export const sessionTitleIsGeneric = (row: SessionPresentationRow): boolean =>
  row.titleSource === 'agent-role' || row.titleSource === 'id';

/**
 * Display-only campaign title inheritance. The caller passes the campaign root
 * label for child rows only, so `depth > 0` is enforced at the call site; this
 * helper adds the remaining conditions. The child keeps its own `sessionLabel`
 * in `segments`, so search, sort, and CSV projections are untouched.
 */
const inheritedCampaignTitle = (row: SessionPresentationRow, campaignRootLabel: string | undefined): string | null => {
  if (!(campaignRootLabel && sessionTitleIsGeneric(row)) || campaignRootLabel === row.sessionLabel) {
    return null;
  }
  return campaignRootLabel;
};

const provenanceFacts = (
  row: SessionPresentationRow,
  metric: UsageMetricKey,
  excludeKinds: ReadonlySet<string> = new Set(),
): readonly UsageRowProvenance[] => provenanceForMetric(row, metric).filter((fact) => !excludeKinds.has(fact.kind));

const metricForColumn = (id: SessionColumnId): UsageMetricKey | undefined => {
  if (['tokIn', 'tokOut', 'cache', 'tokCw', 'fresh', 'total'].includes(id)) {
    return 'tokens';
  }
  if (id === 'actual') {
    return 'actual-cost';
  }
  if (id === 'quota') {
    return 'subscription-value';
  }
  if (id === 'duration') {
    return 'duration';
  }
  if (id === 'calls') {
    return 'calls';
  }
  if (id === 'turns') {
    return 'turns';
  }
  if (id === 'tools') {
    return 'tools';
  }
  if (id === 'lines') {
    return 'lines';
  }
  return;
};

const valueTitle = (row: SessionPresentationRow, id: SessionColumnId): string | undefined => {
  if (row.usageUnavailable && USAGE_UNAVAILABLE_COLUMNS.has(id)) {
    return USAGE_UNAVAILABLE_HINT;
  }
  return id === 'rtkSaved' ? rtkSavedTitle(row) : undefined;
};

const valueProjection = (row: SessionPresentationRow, id: SessionColumnId): SessionCellProjection => {
  if (id === 'cost') {
    const presentation = row.priceMeasurement
      ? aggregateApiValuePresentation(row.priceMeasurement)
      : apiValuePresentation(row);
    return {
      kind: 'value',
      label: row.usageUnavailable ? '—' : presentation.label,
      provenanceFacts: provenanceFacts(row, 'api-value', API_PRICE_PROVENANCE_KINDS),
      title: row.usageUnavailable ? USAGE_UNAVAILABLE_HINT : presentation.title,
    };
  }
  if (id === 'duration') {
    const rootSessionOnly = row.campaignTotalCount !== undefined;
    const semantics = sessionDurationSemantics(row.source?.harnessKey, rootSessionOnly);
    return {
      kind: 'value',
      label: `${sessionColumnById(id).meta.format(row)}${rootSessionOnly ? ' root-session time' : ''}`,
      provenanceFacts: provenanceFacts(row, 'duration'),
      title: semantics.metricHint,
    };
  }
  const metric = metricForColumn(id);
  return {
    kind: 'value',
    label: sessionColumnById(id).meta.format(row),
    provenanceFacts: metric ? provenanceFacts(row, metric) : [],
    title: valueTitle(row, id),
  };
};

export const projectSessionCell = (
  row: SessionPresentationRow,
  id: SessionColumnId,
  query: string,
  campaignRootLabel?: string,
): SessionCellProjection => {
  if (id === 'harness') {
    return { kind: 'harness-filter', label: row.harness, title: `Filter by ${row.harness}`, value: row.harness };
  }
  if (id === 'provider') {
    return {
      field: 'provider',
      kind: 'field-filter',
      label: row.providerDisplay,
      title: `Filter by ${row.providerDisplay}`,
      value: row.providerDisplay,
    };
  }
  if (id === 'project') {
    const projectLabel = row.projectLabel === '(unknown)' ? 'No project' : row.projectLabel;
    return {
      field: 'project',
      kind: 'field-filter',
      label: row.projectLabel === '(unknown)' ? '—' : projectLabel,
      title: `Filter by ${projectLabel}`,
      value: row.projectKey,
    };
  }
  if (id === 'model') {
    return {
      field: 'model',
      kind: 'field-filter',
      label: row.modelLabel,
      title: `Filter by ${row.modelKey}`,
      value: row.modelKey,
    };
  }
  if (id === 'session') {
    const classifierRollup = classifierRollupLabelForSessionRow(row);
    return {
      campaignLabel: campaignBadgeLabelForSessionRow(row),
      classifierLabel:
        classifierRollup === null
          ? null
          : `${classifierRollup} · ${fmtCompact(row.campaignClassifierFreshTokens ?? 0)} fresh`,
      inheritedTitle: inheritedCampaignTitle(row, campaignRootLabel),
      kind: 'session',
      originLabel: row.origin === 'classifier' ? sessionOriginLabel(row.origin) : null,
      provenanceFacts: provenanceFacts(row, 'title'),
      segments: highlightedSegments(row.sessionLabel, query),
    };
  }
  return valueProjection(row, id);
};
