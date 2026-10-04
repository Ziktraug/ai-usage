import {
  type DistillationEvidenceCoverage,
  type DistillationEvidenceEvent,
  type DistillationEvidencePacket,
  type DistillationEvidenceSource,
  parseDistillationEvidenceCoverage,
  parseDistillationEvidenceEvent,
  parseDistillationEvidenceSource,
} from './distillation-evidence';

/** Generated accounts are a separate local corpus, never accepted Memory guidance. */
export const DISTILLATION_SCHEMA_VERSION = 1 as const;
export const DISTILLATION_EXTRACTOR_VERSION = 'session-distillation-v1' as const;
export const distillationBounds = {
  sessions: 10,
  outputBytes: 48 * 1024,
  contextBytes: 32 * 1024,
  requestBytes: 64 * 1024,
  episodes: 12,
  claims: 16,
  references: 6,
  claimCharacters: 1600,
  leaseMs: 15 * 60_000,
  attempts: 3,
  operationMs: 30_000,
  searchResults: 20,
} as const;

export type AssertionBasis = 'observed' | 'reported' | 'inferred' | 'unknown';
export interface EvidenceRef {
  eventId: string;
  /** An exact, bounded quotation; existence and quotation are not semantic entailment. */
  quote: string;
}
export interface SourcedAssertion {
  basis: AssertionBasis;
  evidence: EvidenceRef[];
  text: string;
}
export type EpisodeOutcome =
  | 'observed-success'
  | 'reported-success'
  | 'failed'
  | 'unresolved'
  | 'abandoned'
  | 'unknown';
export interface WorkEpisode {
  attempts: SourcedAssertion[];
  decisions: SourcedAssertion[];
  difficulties: SourcedAssertion[];
  entryPoints: SourcedAssertion[];
  id: string;
  objective: SourcedAssertion;
  openQuestions: SourcedAssertion[];
  result: { status: EpisodeOutcome; assertion: SourcedAssertion };
}
/** The only model-authored portion. Identity, provenance, coverage and revisions are runtime-owned. */
export interface SessionAnalysisContent {
  abstention: string | null;
  episodes: WorkEpisode[];
  schemaVersion: typeof DISTILLATION_SCHEMA_VERSION;
  summary: SourcedAssertion;
}
export class DistillationError extends Error {
  override readonly name = 'DistillationError';
  readonly code: string;
  constructor(code: string) {
    super(`Session distillation: ${code}`);
    this.code = code;
  }
}

export const distillationObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DistillationError('invalid-object');
  }
  return value as Record<string, unknown>;
};
export const distillationText = (value: unknown, maximum = 512): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || value.includes('\0')) {
    throw new DistillationError('invalid-text');
  }
  return value;
};
export const distillationInteger = (value: unknown, minimum: number, maximum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DistillationError('invalid-limit');
  }
  return value;
};
const strictKeys = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) {
    throw new DistillationError('invalid-fields');
  }
};
const oneOf = <T extends string>(value: unknown, choices: readonly T[]): T => {
  if (typeof value !== 'string' || !choices.includes(value as T)) {
    throw new DistillationError('invalid-enum');
  }
  return value as T;
};
const boundedArray = <T>(value: unknown, maximum: number, parse: (entry: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new DistillationError('invalid-array');
  }
  return value.map(parse);
};
export const distillationJsonBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

const parseReference = (value: unknown): EvidenceRef => {
  const entry = distillationObject(value);
  strictKeys(entry, ['eventId', 'quote']);
  return { eventId: distillationText(entry.eventId), quote: distillationText(entry.quote, 600) };
};
const parseAssertion = (value: unknown): SourcedAssertion => {
  const entry = distillationObject(value);
  strictKeys(entry, ['text', 'basis', 'evidence']);
  const assertion = {
    basis: oneOf(entry.basis, ['observed', 'reported', 'inferred', 'unknown']),
    evidence: boundedArray(entry.evidence, distillationBounds.references, parseReference),
    text: distillationText(entry.text, distillationBounds.claimCharacters),
  };
  if ((assertion.basis === 'observed' || assertion.basis === 'reported') && assertion.evidence.length === 0) {
    throw new DistillationError('missing-evidence');
  }
  return assertion;
};
const parseEpisode = (value: unknown): WorkEpisode => {
  const entry = distillationObject(value);
  strictKeys(entry, [
    'id',
    'objective',
    'attempts',
    'result',
    'difficulties',
    'decisions',
    'entryPoints',
    'openQuestions',
  ]);
  const result = distillationObject(entry.result);
  strictKeys(result, ['status', 'assertion']);
  const claims = (input: unknown) => boundedArray(input, distillationBounds.claims, parseAssertion);
  return {
    id: distillationText(entry.id, 80),
    objective: parseAssertion(entry.objective),
    attempts: claims(entry.attempts),
    result: {
      status: oneOf(result.status, [
        'observed-success',
        'reported-success',
        'failed',
        'unresolved',
        'abandoned',
        'unknown',
      ]),
      assertion: parseAssertion(result.assertion),
    },
    difficulties: claims(entry.difficulties),
    decisions: claims(entry.decisions),
    entryPoints: claims(entry.entryPoints),
    openQuestions: claims(entry.openQuestions),
  };
};
export const parseSessionAnalysisContent = (value: unknown): SessionAnalysisContent => {
  if (distillationJsonBytes(value) > distillationBounds.outputBytes) {
    throw new DistillationError('output-too-large');
  }
  const entry = distillationObject(value);
  strictKeys(entry, ['schemaVersion', 'summary', 'episodes', 'abstention']);
  if (entry.schemaVersion !== DISTILLATION_SCHEMA_VERSION) {
    throw new DistillationError('schema-version-mismatch');
  }
  const episodes = boundedArray(entry.episodes, distillationBounds.episodes, parseEpisode);
  if (new Set(episodes.map((episode) => episode.id)).size !== episodes.length) {
    throw new DistillationError('duplicate-episode');
  }
  return {
    schemaVersion: DISTILLATION_SCHEMA_VERSION,
    summary: parseAssertion(entry.summary),
    episodes,
    abstention: entry.abstention === null ? null : distillationText(entry.abstention, 1600),
  };
};

export const analysisAssertions = (content: SessionAnalysisContent): SourcedAssertion[] => [
  content.summary,
  ...content.episodes.flatMap((episode) => [
    episode.objective,
    ...episode.attempts,
    episode.result.assertion,
    ...episode.difficulties,
    ...episode.decisions,
    ...episode.entryPoints,
    ...episode.openQuestions,
  ]),
];

export interface AssertionEvidenceEvent {
  id: string;
  kind: 'user' | 'assistant' | 'tool-call' | 'tool-result';
  text: string;
}
/** Mechanical validation rejects evidence-tier inflation; a human must still assess semantic support. */
export const validateAnalysisEvidence = (
  content: SessionAnalysisContent,
  events: readonly AssertionEvidenceEvent[],
): void => {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const assertion of analysisAssertions(content)) {
    for (const ref of assertion.evidence) {
      const event = byId.get(ref.eventId);
      if (!event?.text.includes(ref.quote)) {
        throw new DistillationError('invalid-evidence-reference');
      }
    }
    if (
      assertion.basis === 'observed' &&
      !assertion.evidence.some((ref) => byId.get(ref.eventId)?.kind === 'tool-result')
    ) {
      throw new DistillationError('observation-requires-tool-result');
    }
    if (
      assertion.basis === 'reported' &&
      !assertion.evidence.some((ref) => ['user', 'assistant'].includes(byId.get(ref.eventId)?.kind ?? ''))
    ) {
      throw new DistillationError('report-requires-statement');
    }
  }
  for (const episode of content.episodes) {
    if (episode.result.status === 'observed-success' && episode.result.assertion.basis !== 'observed') {
      throw new DistillationError('success-not-observed');
    }
    if (episode.result.status === 'reported-success' && episode.result.assertion.basis !== 'reported') {
      throw new DistillationError('success-not-reported');
    }
    if (episode.decisions.some((decision) => decision.basis !== 'reported')) {
      throw new DistillationError('decision-requires-explicit-statement');
    }
  }
};

export interface DistillationSelection {
  revision: string;
  rowId: string;
}
export type DistillationJobState = 'queued' | 'running' | 'failed' | 'cancelled' | 'published';
export interface DistillationJobView {
  analysisId: string | null;
  attempt: number;
  errorCode: string | null;
  id: string;
  state: DistillationJobState;
}
export interface AnalysisRevisionMetadata {
  createdAt: string;
  id: string;
  machineId: string;
  nativeSessionId: string;
  packetDigest: string;
  projectId: string;
  revision: number;
}

export interface SessionAnalysis extends AnalysisRevisionMetadata {
  content: SessionAnalysisContent;
  coverage: DistillationEvidenceCoverage;
  extractorVersion: typeof DISTILLATION_EXTRACTOR_VERSION;
  normalizationVersion: number;
  producer: { kind: 'active-harness'; sessionId: string | null; attribution: 'worker-declared' | 'unknown' };
  schemaVersion: typeof DISTILLATION_SCHEMA_VERSION;
  source: DistillationEvidenceSource;
  validation: 'schema-and-references';
}
export interface DistillationStatus {
  job: DistillationJobView | null;
  latest: AnalysisRevisionMetadata | null;
  revisions: AnalysisRevisionMetadata[];
  revisionsOmitted: number;
  sourceStatus: 'unchecked';
  state: Exclude<DistillationJobState, 'published'> | 'not-analyzed' | 'available';
}
export type DistillationEvidenceResult =
  | { status: 'available'; events: DistillationEvidenceEvent[] }
  | { status: 'changed' | 'unavailable'; events: [] };
export interface DistillationCandidate {
  eligible: boolean;
  machineId: string;
  nativeSessionId: string;
  projectId: string;
  reason: string | null;
  selection: DistillationSelection;
}
export interface DistillationLease {
  expiresAt: string;
  extractorVersion: typeof DISTILLATION_EXTRACTOR_VERSION;
  job: DistillationJobView;
  leaseId: string;
  packet: DistillationEvidencePacket;
  schemaVersion: typeof DISTILLATION_SCHEMA_VERSION;
}
export type AnalysisReadScope = { projectId: string } | { selection: DistillationSelection };
export type DistillationRequest =
  | { kind: 'select'; projectId: string; selections: DistillationSelection[] }
  | {
      kind: 'prepare';
      projectId: string;
      selections: DistillationSelection[];
      providerProcessingAuthorized: true;
      producerSessionId: string | null;
      revisionKey: string | null;
    }
  | { kind: 'claim'; projectId: string; jobId: string }
  | {
      kind: 'submit';
      projectId: string;
      jobId: string;
      leaseId: string;
      packetDigest: string;
      extractorVersion: typeof DISTILLATION_EXTRACTOR_VERSION;
      content: SessionAnalysisContent;
    }
  | { kind: 'cancel' | 'retry'; projectId: string; jobId: string }
  | { kind: 'status'; selection: DistillationSelection }
  | ({ kind: 'get'; analysisId: string } & AnalysisReadScope)
  | ({ kind: 'evidence'; analysisId: string; eventIds: string[] } & AnalysisReadScope)
  | { kind: 'search'; projectId: string; query: string; limit: number }
  | { kind: 'context'; projectId: string; query: string; maxBytes: number }
  | { kind: 'cleanup'; projectId: string; before: string };

const parseSelection = (value: unknown): DistillationSelection => {
  const entry = distillationObject(value);
  strictKeys(entry, ['revision', 'rowId']);
  return { revision: distillationText(entry.revision), rowId: distillationText(entry.rowId, 4096) };
};
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const projectId = (value: unknown): string => {
  const result = distillationText(value, 128);
  if (!PROJECT_ID_PATTERN.test(result)) {
    throw new DistillationError('invalid-project');
  }
  return result;
};
export const parseDistillationRequest = (value: unknown): DistillationRequest => {
  if (distillationJsonBytes(value) > distillationBounds.requestBytes) {
    throw new DistillationError('request-too-large');
  }
  const entry = distillationObject(value);
  const kind = entry.kind;
  if (kind === 'select' || kind === 'prepare') {
    strictKeys(
      entry,
      kind === 'select'
        ? ['kind', 'projectId', 'selections']
        : ['kind', 'projectId', 'selections', 'providerProcessingAuthorized', 'producerSessionId', 'revisionKey'],
    );
    const selections = boundedArray(entry.selections, distillationBounds.sessions, parseSelection);
    if (!selections.length || new Set(selections.map((item) => JSON.stringify(item))).size !== selections.length) {
      throw new DistillationError('invalid-selection');
    }
    const base = { projectId: projectId(entry.projectId), selections };
    if (kind === 'select') {
      return { kind, ...base };
    }
    if (entry.providerProcessingAuthorized !== true) {
      throw new DistillationError('provider-permission-required');
    }
    return {
      kind,
      ...base,
      providerProcessingAuthorized: true,
      producerSessionId: entry.producerSessionId === null ? null : distillationText(entry.producerSessionId),
      revisionKey: entry.revisionKey === null ? null : distillationText(entry.revisionKey, 128),
    };
  }
  if (kind === 'claim' || kind === 'cancel' || kind === 'retry') {
    strictKeys(entry, ['kind', 'projectId', 'jobId']);
    return { kind, projectId: projectId(entry.projectId), jobId: distillationText(entry.jobId) };
  }
  if (kind === 'submit') {
    strictKeys(entry, ['kind', 'projectId', 'jobId', 'leaseId', 'packetDigest', 'extractorVersion', 'content']);
    if (entry.extractorVersion !== DISTILLATION_EXTRACTOR_VERSION) {
      throw new DistillationError('extractor-version-mismatch');
    }
    return {
      kind,
      projectId: projectId(entry.projectId),
      jobId: distillationText(entry.jobId),
      leaseId: distillationText(entry.leaseId),
      packetDigest: distillationText(entry.packetDigest, 64),
      extractorVersion: DISTILLATION_EXTRACTOR_VERSION,
      content: parseSessionAnalysisContent(entry.content),
    };
  }
  if (kind === 'status') {
    strictKeys(entry, ['kind', 'selection']);
    return { kind, selection: parseSelection(entry.selection) };
  }
  if (kind === 'get' || kind === 'evidence') {
    const scopeKey = 'selection' in entry ? 'selection' : 'projectId';
    strictKeys(entry, kind === 'get' ? ['kind', 'analysisId', scopeKey] : ['kind', 'analysisId', scopeKey, 'eventIds']);
    const scope =
      scopeKey === 'selection'
        ? { selection: parseSelection(entry.selection) }
        : { projectId: projectId(entry.projectId) };
    const base = { analysisId: distillationText(entry.analysisId), ...scope };
    return kind === 'get'
      ? { kind, ...base }
      : { kind, ...base, eventIds: boundedArray(entry.eventIds, 12, (id) => distillationText(id)) };
  }
  if (kind === 'search' || kind === 'context') {
    strictKeys(
      entry,
      kind === 'search' ? ['kind', 'projectId', 'query', 'limit'] : ['kind', 'projectId', 'query', 'maxBytes'],
    );
    const base = { projectId: projectId(entry.projectId), query: distillationText(entry.query, 1000) };
    return kind === 'search'
      ? { kind, ...base, limit: distillationInteger(entry.limit, 1, distillationBounds.searchResults) }
      : { kind, ...base, maxBytes: distillationInteger(entry.maxBytes, 512, distillationBounds.contextBytes) };
  }
  if (kind === 'cleanup') {
    strictKeys(entry, ['kind', 'projectId', 'before']);
    const before = distillationText(entry.before, 64);
    if (!Number.isFinite(Date.parse(before))) {
      throw new DistillationError('invalid-date');
    }
    return { kind, projectId: projectId(entry.projectId), before };
  }
  throw new DistillationError('unsupported-operation');
};

export interface DistillationSearchHit extends AnalysisRevisionMetadata {
  coverage: 'complete' | 'partial';
  episodeIds: string[];
  summary: string;
}
export interface DistillationSearchResult {
  corpus: 'session-analyses';
  items: DistillationSearchHit[];
  omitted: number;
}
export interface DistillationContext {
  analyses: (SessionAnalysis & { omittedEpisodes: number })[];
  bytes: number;
  corpus: 'session-analyses';
  maxBytes: number;
  notice: string;
  omitted: number;
}

export const parseAnalysisRevisionMetadata = (value: unknown): AnalysisRevisionMetadata => {
  const entry = distillationObject(value);
  const createdAt = distillationText(entry.createdAt, 64);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new DistillationError('invalid-date');
  }
  return {
    id: distillationText(entry.id),
    revision: distillationInteger(entry.revision, 1, Number.MAX_SAFE_INTEGER),
    createdAt,
    projectId: projectId(entry.projectId),
    nativeSessionId: distillationText(entry.nativeSessionId),
    machineId: distillationText(entry.machineId),
    packetDigest: distillationText(entry.packetDigest, 64),
  };
};
export const parseSessionAnalysis = (value: unknown): SessionAnalysis => {
  const entry = distillationObject(value);
  if (
    entry.schemaVersion !== DISTILLATION_SCHEMA_VERSION ||
    entry.extractorVersion !== DISTILLATION_EXTRACTOR_VERSION ||
    entry.validation !== 'schema-and-references'
  ) {
    throw new DistillationError('analysis-version-mismatch');
  }
  const producer = distillationObject(entry.producer);
  if (producer.kind !== 'active-harness') {
    throw new DistillationError('invalid-producer');
  }
  const metadata = parseAnalysisRevisionMetadata(value);
  const source = parseDistillationEvidenceSource(entry.source);
  if (
    source.projectId !== metadata.projectId ||
    source.machineId !== metadata.machineId ||
    source.nativeSessionId !== metadata.nativeSessionId
  ) {
    throw new DistillationError('source-identity-mismatch');
  }
  return {
    ...metadata,
    schemaVersion: DISTILLATION_SCHEMA_VERSION,
    normalizationVersion: distillationInteger(entry.normalizationVersion, 1, 1),
    extractorVersion: DISTILLATION_EXTRACTOR_VERSION,
    source,
    coverage: parseDistillationEvidenceCoverage(entry.coverage),
    content: parseSessionAnalysisContent(entry.content),
    producer: {
      kind: 'active-harness',
      sessionId: producer.sessionId === null ? null : distillationText(producer.sessionId),
      attribution: oneOf(producer.attribution, ['worker-declared', 'unknown']),
    },
    validation: 'schema-and-references',
  };
};
export const parseDistillationJobView = (value: unknown): DistillationJobView => {
  const entry = distillationObject(value);
  return {
    id: distillationText(entry.id),
    state: oneOf(entry.state, ['queued', 'running', 'failed', 'cancelled', 'published']),
    attempt: distillationInteger(entry.attempt, 0, distillationBounds.attempts),
    errorCode: entry.errorCode === null ? null : distillationText(entry.errorCode),
    analysisId: entry.analysisId === null ? null : distillationText(entry.analysisId),
  };
};
export const parseDistillationStatus = (value: unknown): DistillationStatus => {
  const entry = distillationObject(value);
  if (entry.sourceStatus !== 'unchecked') {
    throw new DistillationError('invalid-source-status');
  }
  return {
    state: oneOf(entry.state, ['queued', 'running', 'failed', 'cancelled', 'not-analyzed', 'available']),
    latest: entry.latest === null ? null : parseAnalysisRevisionMetadata(entry.latest),
    revisions: boundedArray(entry.revisions, 20, parseAnalysisRevisionMetadata),
    revisionsOmitted: distillationInteger(entry.revisionsOmitted, 0, Number.MAX_SAFE_INTEGER),
    job: entry.job === null ? null : parseDistillationJobView(entry.job),
    sourceStatus: 'unchecked',
  };
};
export const parseDistillationEvidenceResult = (value: unknown): DistillationEvidenceResult => {
  const entry = distillationObject(value);
  if (entry.status === 'available') {
    return { status: 'available', events: boundedArray(entry.events, 12, parseDistillationEvidenceEvent) };
  }
  const status = oneOf(entry.status, ['changed', 'unavailable']);
  if (!Array.isArray(entry.events) || entry.events.length !== 0) {
    throw new DistillationError('invalid-evidence-result');
  }
  return { status, events: [] };
};
