import {
  type AnalysisRevisionMetadata,
  type DistillationCandidate,
  DistillationError,
  type DistillationJobView,
  type DistillationSearchResult,
  type DistillationSelection,
  type DistillationStatus,
  distillationInteger,
  distillationJsonBytes,
  distillationObject,
  distillationText,
  parseAnalysisRevisionMetadata,
  parseDistillationStatus,
} from './session-distillation';

export interface DistillationProject {
  checkouts: { path: string; projectSourceId: string; acknowledgedAt: string }[];
  displayName: string;
  projectId: string;
}
export interface DistillationProjectSelector {
  kind: 'checkout' | 'project';
  value: string;
}
export interface DistillationBrowseRequest {
  cursor: string | null;
  kind: 'browse';
  limit: number;
  projectId: string | null;
  query: string;
  since: string | null;
  until: string | null;
}
export interface DistillationBrowseItem extends AnalysisRevisionMetadata {
  coverage: 'complete' | 'partial';
  episodeIds: string[];
  projectName: string;
  sessionDate: string | null;
  summary: string;
}
export interface DistillationBrowseResult {
  items: DistillationBrowseItem[];
  nextCursor: string | null;
}
export interface DistillationDiscoveryResult {
  candidates: (DistillationCandidate & { label: string; sessionDate: string | null; status: DistillationStatus })[];
  createdAt: string;
  prepareCommand: string;
  projectId: string;
  projectName: string;
  revision: string;
  selectionDigest: string;
  selections: DistillationSelection[];
  selectionToken: string;
  version: 1;
}
export interface DistillationJobsResult {
  items: (DistillationJobView & { nativeSessionId: string; updatedAt: string })[];
  nextCursor: string | null;
}
export interface DistillationProjectsPage {
  items: DistillationProject[];
  nextCursor: string | null;
}
export interface DistillationHistoryPage {
  items: AnalysisRevisionMetadata[];
  nextCursor: string | null;
}
export type DistillationDiscoveryPreview = DistillationDiscoveryResult;
export type DistillationBrowsePage = DistillationBrowseResult;
export interface DistillationCatalog {
  browse(request: DistillationBrowseRequest): Promise<DistillationBrowseResult>;
  history(
    projectId: string,
    analysisId: string,
    limit: number,
    cursor: string | null,
  ): Promise<DistillationHistoryPage>;
  jobs(projectId: string, limit: number, cursor: string | null): Promise<DistillationJobsResult>;
  projects(
    limit: number,
    cursor: string | null,
    selector?: DistillationProjectSelector,
  ): Promise<DistillationProjectsPage>;
  search(projectId: string, query: string, limit: number, mode?: 'literal' | 'task'): Promise<DistillationSearchResult>;
}
export type DistillationDiscoveryRequest =
  | { kind: 'history'; projectId: string; analysisId: string; limit: number; cursor: string | null }
  | { kind: 'projects'; limit: number; cursor: string | null }
  | {
      kind: 'discover';
      selector: DistillationProjectSelector;
      since: string | null;
      until: string | null;
      limit: number;
    }
  | {
      kind: 'prepare-selection';
      selectionToken: string;
      providerProcessingAuthorized: true;
      producerSessionId: string | null;
      revisionKey: string | null;
      chosenRowIds?: string[];
    }
  | { kind: 'jobs'; projectId: string; limit: number; cursor: string | null }
  | DistillationBrowseRequest;

const nullableText = (value: unknown, maximum = 512): string | null =>
  value === null ? null : distillationText(value, maximum);
const ISO_INSTANT_PREFIX = /^\d{4}-\d{2}-\d{2}T/u;
const date = (value: unknown): string | null => {
  const result = nullableText(value, 64);
  if (result !== null && !(ISO_INSTANT_PREFIX.test(result) && Number.isFinite(Date.parse(result)))) {
    throw new DistillationError('invalid-date');
  }
  return result === null ? null : new Date(result).toISOString();
};
const keys = (entry: Record<string, unknown>, expected: string[]): void => {
  if (Object.keys(entry).length !== expected.length || expected.some((key) => !(key in entry))) {
    throw new DistillationError('invalid-fields');
  }
};
export const isDistillationDiscoveryRequest = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'kind' in value &&
      ['projects', 'discover', 'prepare-selection', 'browse', 'jobs', 'history'].includes(String(value.kind)),
  );
export const parseDistillationDiscoveryRequest = (value: unknown): DistillationDiscoveryRequest => {
  if (distillationJsonBytes(value) > 64 * 1024) {
    throw new DistillationError('request-too-large');
  }
  const entry = distillationObject(value);
  if (entry.kind === 'history') {
    keys(entry, ['kind', 'projectId', 'analysisId', 'limit', 'cursor']);
    return {
      kind: entry.kind,
      projectId: distillationText(entry.projectId, 128),
      analysisId: distillationText(entry.analysisId),
      limit: distillationInteger(entry.limit, 1, 50),
      cursor: nullableText(entry.cursor, 4096),
    };
  }
  if (entry.kind === 'projects' || entry.kind === 'jobs') {
    keys(entry, entry.kind === 'projects' ? ['kind', 'limit', 'cursor'] : ['kind', 'projectId', 'limit', 'cursor']);
    const base = { limit: distillationInteger(entry.limit, 1, 50), cursor: nullableText(entry.cursor, 4096) };
    return entry.kind === 'projects'
      ? { kind: entry.kind, ...base }
      : { kind: entry.kind, ...base, projectId: distillationText(entry.projectId, 128) };
  }
  if (entry.kind === 'prepare-selection') {
    keys(entry, [
      'kind',
      'selectionToken',
      'providerProcessingAuthorized',
      'producerSessionId',
      'revisionKey',
      ...('chosenRowIds' in entry ? ['chosenRowIds'] : []),
    ]);
    if (entry.providerProcessingAuthorized !== true) {
      throw new DistillationError('provider-permission-required');
    }
    const chosenRowIds =
      'chosenRowIds' in entry ? array(entry.chosenRowIds, 10).map((id) => distillationText(id, 4096)) : undefined;
    if (chosenRowIds && (chosenRowIds.length === 0 || new Set(chosenRowIds).size !== chosenRowIds.length)) {
      throw new DistillationError('invalid-selection');
    }
    return {
      kind: entry.kind,
      selectionToken: distillationText(entry.selectionToken, 32 * 1024),
      providerProcessingAuthorized: true,
      producerSessionId: nullableText(entry.producerSessionId),
      revisionKey: nullableText(entry.revisionKey, 128),
      ...(chosenRowIds ? { chosenRowIds } : {}),
    };
  }
  if (entry.kind === 'discover' || entry.kind === 'browse') {
    keys(
      entry,
      entry.kind === 'discover'
        ? ['kind', 'selector', 'since', 'until', 'limit']
        : ['kind', 'projectId', 'since', 'until', 'query', 'cursor', 'limit'],
    );
    const since = date(entry.since);
    const until = date(entry.until);
    if (since && until && since >= until) {
      throw new DistillationError('invalid-period');
    }
    const limit = distillationInteger(entry.limit, 1, entry.kind === 'discover' ? 10 : 50);
    if (entry.kind === 'browse') {
      return {
        kind: entry.kind,
        projectId: nullableText(entry.projectId, 128),
        since,
        until,
        limit,
        query: entry.query === '' ? '' : distillationText(entry.query, 1000),
        cursor: nullableText(entry.cursor, 4096),
      };
    }
    const selector = distillationObject(entry.selector);
    keys(selector, ['kind', 'value']);
    if (selector.kind !== 'checkout' && selector.kind !== 'project') {
      throw new DistillationError('invalid-selector');
    }
    return {
      kind: entry.kind,
      selector: { kind: selector.kind, value: distillationText(selector.value, 4096) },
      since,
      until,
      limit,
    };
  }
  throw new DistillationError('unsupported-operation');
};

const array = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new DistillationError('invalid-array');
  }
  return value;
};
export const parseDistillationProjectsPage = (value: unknown): DistillationProjectsPage => {
  const entry = distillationObject(value);
  return {
    nextCursor: nullableText(entry.nextCursor, 4096),
    items: array(entry.items, 50).map((value) => {
      const project = distillationObject(value);
      return {
        projectId: distillationText(project.projectId, 128),
        displayName: distillationText(project.displayName, 256),
        checkouts: array(project.checkouts, 100).map((value) => {
          const checkout = distillationObject(value);
          return {
            path: distillationText(checkout.path, 4096),
            projectSourceId: distillationText(checkout.projectSourceId, 4096),
            acknowledgedAt: distillationText(checkout.acknowledgedAt, 64),
          };
        }),
      };
    }),
  };
};
export const parseDistillationHistoryPage = (value: unknown): DistillationHistoryPage => {
  const entry = distillationObject(value);
  return {
    items: array(entry.items, 50).map(parseAnalysisRevisionMetadata),
    nextCursor: nullableText(entry.nextCursor, 4096),
  };
};
export const parseDistillationBrowsePage = (value: unknown): DistillationBrowsePage => {
  const entry = distillationObject(value);
  return {
    nextCursor: nullableText(entry.nextCursor, 4096),
    items: array(entry.items, 50).map((value) => {
      const item = distillationObject(value);
      if (item.coverage !== 'complete' && item.coverage !== 'partial') {
        throw new DistillationError('invalid-coverage');
      }
      return {
        ...parseAnalysisRevisionMetadata(item),
        projectName: distillationText(item.projectName, 256),
        summary: distillationText(item.summary, 1600),
        coverage: item.coverage,
        episodeIds: array(item.episodeIds, 12).map((id) => distillationText(id, 80)),
        sessionDate: date(item.sessionDate),
      };
    }),
  };
};
export const parseDistillationDiscoveryPreview = (value: unknown): DistillationDiscoveryPreview => {
  const entry = distillationObject(value);
  if (entry.version !== 1) {
    throw new DistillationError('selection-version-mismatch');
  }
  const selections = array(entry.selections, 10).map((value) => {
    const selection = distillationObject(value);
    return { revision: distillationText(selection.revision), rowId: distillationText(selection.rowId, 4096) };
  });
  return {
    version: 1,
    projectId: distillationText(entry.projectId, 128),
    projectName: distillationText(entry.projectName, 256),
    revision: distillationText(entry.revision),
    createdAt: distillationText(entry.createdAt, 64),
    selectionDigest: distillationText(entry.selectionDigest, 64),
    selectionToken: distillationText(entry.selectionToken, 32 * 1024),
    prepareCommand: distillationText(entry.prepareCommand, 40 * 1024),
    selections,
    candidates: array(entry.candidates, 10).map((value) => {
      const candidate = distillationObject(value);
      const selection = distillationObject(candidate.selection);
      if (typeof candidate.eligible !== 'boolean') {
        throw new DistillationError('invalid-candidate');
      }
      return {
        projectId: distillationText(candidate.projectId, 128),
        machineId: String(candidate.machineId),
        nativeSessionId: String(candidate.nativeSessionId),
        eligible: candidate.eligible,
        reason: nullableText(candidate.reason),
        label: distillationText(candidate.label, 1024),
        sessionDate: date(candidate.sessionDate),
        status: parseDistillationStatus(candidate.status),
        selection: { revision: distillationText(selection.revision), rowId: distillationText(selection.rowId, 4096) },
      };
    }),
  };
};
