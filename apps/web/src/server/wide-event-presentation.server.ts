import {
  genericPrettyWideEventProjector,
  type LogValue,
  type PrettyWideEventProjector,
  type PrettyWideEventView,
  type WideEventSnapshot,
} from '@ai-usage/effect-runtime/node';

type KnownBoundary = 'publication' | 'source.run' | 'web.sessions.read';

const knownBoundaries = new Set<string>(['publication', 'source.run', 'web.sessions.read']);

const isKnownBoundary = (boundary: string): boundary is KnownBoundary => knownBoundaries.has(boundary);

const stringField = (annotations: Readonly<Record<string, LogValue>>, key: string): string | undefined => {
  const value = annotations[key];
  return typeof value === 'string' ? value : undefined;
};

const numberField = (annotations: Readonly<Record<string, LogValue>>, key: string): number | undefined => {
  const value = annotations[key];
  return typeof value === 'number' ? value : undefined;
};

const booleanField = (annotations: Readonly<Record<string, LogValue>>, key: string): boolean | undefined => {
  const value = annotations[key];
  return typeof value === 'boolean' ? value : undefined;
};

const abbreviated = (value: string): string => (value.length <= 12 ? value : `${value.slice(0, 8)}…`);

const changedSummary = (event: WideEventSnapshot): string | undefined => {
  const changed = booleanField(event.annotations, 'changed');
  if (changed === undefined) {
    return;
  }
  return changed ? 'changed' : 'unchanged';
};

const hasMoreSummary = (event: WideEventSnapshot): string | undefined => {
  const hasMore = booleanField(event.annotations, 'hasMore');
  if (hasMore === undefined) {
    return;
  }
  return hasMore ? 'more' : 'complete';
};

const compact = (values: readonly (string | undefined)[]): string[] =>
  values.filter((value): value is string => value !== undefined);

const projectSourceRun = (event: WideEventSnapshot): PrettyWideEventView => {
  const inputCount = numberField(event.annotations, 'inputCount');
  const outputCount = numberField(event.annotations, 'outputCount');
  const queueDelayMs = numberField(event.annotations, 'queueDelayMs');
  const warningsCount = numberField(event.annotations, 'warningsCount');
  return {
    subject: stringField(event.annotations, 'sourceId') ?? event.boundary,
    summary: compact([
      changedSummary(event),
      inputCount === undefined || outputCount === undefined ? undefined : `${inputCount}→${outputCount}`,
      queueDelayMs === undefined ? undefined : `queue=${queueDelayMs}ms`,
      warningsCount === undefined || warningsCount === 0 ? undefined : `warnings=${warningsCount}`,
    ]),
  };
};

const projectPublication = (event: WideEventSnapshot): PrettyWideEventView => {
  const revision = stringField(event.annotations, 'revision');
  const queueDelayMs = numberField(event.annotations, 'queueDelayMs');
  return {
    subject: 'publication',
    summary: compact([
      changedSummary(event),
      revision === undefined ? undefined : `revision=${abbreviated(revision)}`,
      queueDelayMs === undefined ? undefined : `queue=${queueDelayMs}ms`,
    ]),
  };
};

const projectSessionsRead = (event: WideEventSnapshot): PrettyWideEventView => {
  const itemCount = numberField(event.annotations, 'itemCount');
  const sessionCount = numberField(event.annotations, 'sessionCount');
  return {
    subject: 'sessions',
    summary: compact([
      itemCount === undefined ? undefined : `items=${itemCount}`,
      sessionCount === undefined ? undefined : `sessions=${sessionCount}`,
      hasMoreSummary(event),
    ]),
  };
};

export const projectWebWideEvent: PrettyWideEventProjector = (event) => {
  if (!isKnownBoundary(event.boundary)) {
    return genericPrettyWideEventProjector(event);
  }
  switch (event.boundary) {
    case 'source.run':
      return projectSourceRun(event);
    case 'publication':
      return projectPublication(event);
    case 'web.sessions.read':
      return projectSessionsRead(event);
    default:
      return genericPrettyWideEventProjector(event);
  }
};
