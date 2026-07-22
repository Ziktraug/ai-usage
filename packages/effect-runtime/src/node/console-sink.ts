import { Effect, Ref } from 'effect';
import type { BoundaryOutcome, LogValue, ServiceHop, WideEventSnapshot } from '../model';
import { serializeWideEventSnapshot } from '../sanitize';
import { makeEmptyWideEventSinkDiagnostics, type WideEventSinkShape } from '../sink';

export type ConsoleLogFormat = 'json' | 'pretty';
export type ConsoleLogLevel = 'debug' | 'error' | 'info' | 'warn';
export type ConsoleSeverity = 'error' | 'info' | 'warn';

export interface PrettyWideEventView {
  readonly details?: readonly string[];
  readonly subject: string;
  readonly summary?: readonly string[];
}

export type PrettyWideEventProjector = (event: WideEventSnapshot) => PrettyWideEventView;
export type ConsoleWideEventWriter = (line: string, severity: ConsoleSeverity) => void;

const ANSI_RESET = '\u001B[0m';
const ANSI_RED = '\u001B[31m';
const ANSI_YELLOW = '\u001B[33m';
const ANSI_GREEN = '\u001B[32m';
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:0|31|32|33)m`, 'g');
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2}\.\d{3})Z$/;
const WHITESPACE = /\s/;
const MAX_PRETTY_ANNOTATIONS = 12;
const MAX_PRETTY_HOPS = 32;
const MAX_PRETTY_VALUE_LENGTH = 120;

const formatDuration = (value: number): string => `${value.toFixed(1)}ms`;

const truncatePrettyValue = (value: string): string =>
  value.length <= MAX_PRETTY_VALUE_LENGTH ? value : `${value.slice(0, MAX_PRETTY_VALUE_LENGTH - 1)}…`;

const renderLogValue = (value: LogValue): string => {
  if (typeof value === 'string') {
    return truncatePrettyValue(WHITESPACE.test(value) ? JSON.stringify(value) : value);
  }
  return truncatePrettyValue(JSON.stringify(value) ?? 'null');
};

const renderAnnotations = (annotations: Readonly<Record<string, LogValue>>): string | null => {
  const entries = Object.entries(annotations).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return null;
  }
  const fields = entries.slice(0, MAX_PRETTY_ANNOTATIONS).map(([key, value]) => `${key}=${renderLogValue(value)}`);
  if (entries.length > MAX_PRETTY_ANNOTATIONS) {
    fields.push(`+${entries.length - MAX_PRETTY_ANNOTATIONS} fields`);
  }
  return fields.join(' ');
};

const renderEventTime = (emittedAt: string): string => {
  const match = emittedAt.match(ISO_TIMESTAMP);
  return match?.[1] ? `${match[1]}Z` : truncatePrettyValue(emittedAt);
};

const renderEventId = (eventId: string): string => (eventId.length <= 8 ? eventId : eventId.slice(0, 8));

const severityForOutcome = (outcome: BoundaryOutcome): ConsoleSeverity => {
  if (outcome === 'failure') {
    return 'error';
  }
  return outcome === 'success' ? 'info' : 'warn';
};

const outcomeSymbol = (outcome: BoundaryOutcome): string => {
  if (outcome === 'success') {
    return `${ANSI_GREEN}✓${ANSI_RESET}`;
  }
  if (outcome === 'failure') {
    return `${ANSI_RED}✗${ANSI_RESET}`;
  }
  return `${ANSI_YELLOW}!${ANSI_RESET}`;
};

const renderError = (event: WideEventSnapshot): string | null => {
  if (event.error === null) {
    return null;
  }
  const code = event.error.code === undefined ? '' : `/${event.error.code}`;
  const message = event.error.message === undefined ? '' : `: ${renderLogValue(event.error.message)}`;
  return `error ${event.error.tag}${code}${message}`;
};

const shouldSuppressRepeatingHop = (event: WideEventSnapshot): boolean => {
  const [only] = event.services;
  return (
    event.services.length === 1 &&
    only !== undefined &&
    only.outcome === event.outcome &&
    only.annotations === undefined &&
    (only.children?.length ?? 0) === 0 &&
    only.durationMs >= event.durationMs * 0.9
  );
};

const containsAnomalousHop = (hop: ServiceHop): boolean =>
  hop.outcome !== 'success' || (hop.children?.some(containsAnomalousHop) ?? false);

const renderHopTree = (services: readonly ServiceHop[], includeAll: boolean, anomaliesOnly = false): string[] => {
  const lines: string[] = [];
  let omitted = false;
  let rendered = 0;
  const visit = (hop: ServiceHop, prefix: string, isLast: boolean): void => {
    if (rendered >= MAX_PRETTY_HOPS) {
      omitted = true;
      return;
    }
    rendered += 1;
    const annotations = renderAnnotations(hop.annotations ?? {});
    lines.push(
      `${prefix}${isLast ? '└─' : '├─'} ${outcomeSymbol(hop.outcome)} ${truncatePrettyValue(hop.name)} ${formatDuration(hop.durationMs)}${annotations === null ? '' : `  ${annotations}`}`,
    );
    if (!includeAll) {
      return;
    }
    const children = anomaliesOnly ? (hop.children ?? []).filter(containsAnomalousHop) : (hop.children ?? []);
    for (const [index, child] of children.entries()) {
      visit(child, `${prefix}${isLast ? '   ' : '│  '}`, index === children.length - 1);
    }
  };

  for (const [index, service] of services.entries()) {
    visit(service, '', index === services.length - 1);
  }
  if (omitted) {
    lines.push('… additional hops omitted');
  }
  return lines;
};

const anomalyDetails = (event: WideEventSnapshot): string[] => {
  const fields = ['failureKind', 'unavailableCode', 'warningCodes']
    .map((key) => [key, event.annotations[key]] as const)
    .filter((entry): entry is readonly [string, LogValue] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${renderLogValue(value)}`);
  const error = renderError(event);
  return [...fields, ...(error === null ? [] : [error])];
};

export const genericPrettyWideEventProjector: PrettyWideEventProjector = (event) => ({
  subject: event.boundary,
});

export const stripWideEventAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

export const renderPrettyWideEvent = (
  event: WideEventSnapshot,
  options: {
    readonly detail?: 'debug' | 'info';
    readonly projector?: PrettyWideEventProjector;
  } = {},
): string => {
  const detail = options.detail ?? 'info';
  const projected = (options.projector ?? genericPrettyWideEventProjector)(event);
  const summary = (projected.summary ?? []).map(truncatePrettyValue);
  const header = [
    renderEventTime(event.emittedAt),
    outcomeSymbol(event.outcome),
    truncatePrettyValue(projected.subject),
    formatDuration(event.durationMs),
    ...summary,
    `event=${renderEventId(event.eventId)}`,
  ].join('  ');
  const anomaly = event.outcome !== 'success';
  const services =
    detail === 'info' && !anomaly && shouldSuppressRepeatingHop(event)
      ? []
      : renderHopTree(
          anomaly && detail === 'info' ? event.services.filter(containsAnomalousHop) : event.services,
          detail === 'debug' || anomaly,
          anomaly && detail === 'info',
        );
  const details = [
    ...(projected.details ?? []).map(truncatePrettyValue),
    ...(anomaly ? anomalyDetails(event) : []),
    ...(detail === 'debug'
      ? [
          ...(renderAnnotations(event.annotations) === null
            ? []
            : [`annotations ${renderAnnotations(event.annotations)}`]),
          `resource ${event.resource.surface}/${event.resource.runtimeMode} ${event.resource.serviceName}@${truncatePrettyValue(event.resource.serviceVersion)} instance=${truncatePrettyValue(event.resource.instanceId)}`,
        ]
      : []),
  ];
  return [header, ...services, ...details].join('\n');
};

export const selectConsoleLogFormat = (
  env: NodeJS.ProcessEnv = process.env,
  stderr: { isTTY?: boolean } = process.stderr,
): ConsoleLogFormat => {
  if (env.LOG_FORMAT === 'json') {
    return 'json';
  }
  return stderr.isTTY ? 'pretty' : 'json';
};

export const selectConsoleLogLevel = (env: NodeJS.ProcessEnv = process.env): ConsoleLogLevel => {
  const value = env.LOG_LEVEL;
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
};

const shouldWrite = (severity: ConsoleSeverity, level: ConsoleLogLevel): boolean => {
  if (level === 'debug' || level === 'info') {
    return true;
  }
  return level === 'warn' ? severity !== 'info' : severity === 'error';
};

export const defaultConsoleWideEventWriter: ConsoleWideEventWriter = (line, severity) => {
  console[severity](line);
};

export const makeConsoleWideEventSink = (options?: {
  readonly format?: ConsoleLogFormat;
  readonly level?: ConsoleLogLevel;
  readonly projector?: PrettyWideEventProjector;
  readonly write?: ConsoleWideEventWriter;
}): WideEventSinkShape => {
  const format = options?.format ?? selectConsoleLogFormat();
  const level = options?.level ?? selectConsoleLogLevel();
  const write = options?.write ?? defaultConsoleWideEventWriter;
  const diagnostics = Ref.unsafeMake(makeEmptyWideEventSinkDiagnostics());

  return {
    submit: (event) =>
      Effect.gen(function* () {
        const severity = severityForOutcome(event.outcome);
        if (!shouldWrite(severity, level)) {
          return;
        }
        try {
          const serialized = serializeWideEventSnapshot(event);
          const line =
            format === 'pretty'
              ? renderPrettyWideEvent(JSON.parse(serialized) as WideEventSnapshot, {
                  detail: level === 'debug' ? 'debug' : 'info',
                  ...(options?.projector === undefined ? {} : { projector: options.projector }),
                })
              : serialized;
          write(line, severity);
          yield* Ref.update(diagnostics, (current) => ({
            ...current,
            accepted: current.accepted + 1,
          }));
        } catch {
          yield* Ref.update(diagnostics, (current) => ({
            ...current,
            failed: current.failed + 1,
          }));
        }
      }),
    diagnostics: () => Ref.get(diagnostics),
  };
};
