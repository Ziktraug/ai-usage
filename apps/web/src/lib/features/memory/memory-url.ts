export type MemoryView = 'analyses' | 'review' | 'knowledge';
export interface MemoryLocation {
  analysisId: string | null;
  analysisProjectId: string | null;
  cursor: string | null;
  elementKey: string | null;
  episodeId: string | null;
  periodError: string | null;
  projectId: string | null;
  query: string;
  since: string;
  until: string;
  view: MemoryView;
}
export const memoryLocation = (address: string): MemoryLocation => {
  const params = new URL(address, 'http://memory.invalid').searchParams;
  const view = params.get('view');
  const elementKey = params.get('element');
  const since = params.get('since') ?? '';
  const until = params.get('until') ?? '';
  return {
    view: view === 'review' || view === 'knowledge' ? view : 'analyses',
    projectId: params.get('project'),
    analysisId: params.get('analysis'),
    analysisProjectId: params.get('analysisProject') ?? params.get('project'),
    episodeId:
      params.get('episode') ?? (elementKey && elementKey !== 'summary' ? elementKey.replace(ELEMENT_SUFFIX, '') : null),
    elementKey,
    periodError: memoryPeriodError(since, until),
    query: params.get('q') ?? '',
    since,
    until,
    cursor: params.get('cursor'),
  };
};
export const memoryHref = (address: string, changes: Record<string, string | null>): string => {
  const url = new URL(address, 'http://memory.invalid');
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === '') {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return `/memory${url.search}${url.hash}`;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ELEMENT_SUFFIX = /:result$|:decision:\d+$/u;
export const memoryDateBound = (value: string): string | null => {
  if (!DATE.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return date.toISOString();
};
export const memoryPeriodError = (since: string, until: string): string | null => {
  if ((since && !memoryDateBound(since)) || (until && !memoryDateBound(until))) {
    return 'The URL contains an invalid date. Choose a valid period before reading accounts.';
  }
  return since && until && since >= until ? 'The end date must be after the start date.' : null;
};
const TITLE_BOUNDARY = /\n|(?<=[.!?])\s/u;
export const analysisTitle = (summary: string): string => {
  const first = summary.split(TITLE_BOUNDARY)[0] ?? summary;
  return first.length > 112 ? `${first.slice(0, 109)}…` : first;
};
