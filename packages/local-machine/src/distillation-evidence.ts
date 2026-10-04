import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  DISTILLATION_EVENT_MAX_BYTES,
  DISTILLATION_EVIDENCE_VERSION,
  DISTILLATION_MAX_EVENTS,
  DISTILLATION_NORMALIZATION_VERSION,
  DISTILLATION_PACKET_MAX_BYTES,
  type DistillationEvidenceCoverage,
  type DistillationEvidenceEvent,
  type DistillationEvidencePacket,
  type DistillationEvidenceRef,
  type DistillationExclusionReason,
  type DistillationReportAnchor,
  type DistillationSourceVersion,
  distillationEvidenceDigestInput,
  parseDistillationEvidencePacket,
  parseDistillationEvidenceRef,
  parseDistillationEvidenceSource,
} from '@ai-usage/platform-core/distillation-evidence';
import { deriveSessionRounds } from '@ai-usage/report-core/session-detail';
import { Effect } from 'effect';
import { createCodexSessionParser, listCodexSessionFiles } from './internal/codex-history';
import { createLocalHistoryStorage, LocalHistoryStorage, type LocalHistoryStorage as Storage } from './local-history';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const SAFE_SESSION_ID = /^[a-z\d][a-z\d-]{0,127}$/i;
const TRAILING_REPLACEMENT = /\uFFFD$/u;
const MAX_EVENT_CONTENT_BYTES = 176 * 1024;
// These are recorded harness truncation markers, not a claim about how much was lost.
const RECORDED_OUTPUT_TRUNCATION =
  /(?:^|\n)(?:Warning: truncated output \(original (?:token|character) count: \d+\)|\[\.\.\. output truncated \.\.\.\])/i;

/** Created by the runtime after resolving one Project/Checkout and local report provenance. */
export interface CodexDistillationSelection {
  checkoutPath: string;
  machineId: string;
  projectId: string;
  reportAnchor?: DistillationReportAnchor | null;
  sourceAuthority: 'local-observed' | 'portable-opaque';
  sourceSessionId: string;
}

export interface CodexDistillationEvidenceRequest {
  localMachineId: string;
  selection: CodexDistillationSelection;
}

export interface CodexDistillationEvidenceOptions {
  homePath?: string;
  limits?: { sourceBytes?: number; lineBytes?: number; eventBytes?: number; events?: number; contentBytes?: number };
  redactionVersion: number;
  /** Shared runtime redactor; mandatory so an unconfigured reader cannot emit secrets. */
  redactText: (value: string) => string;
  signal?: AbortSignal;
  storage?: Storage;
}

export type DistillationEvidenceUnavailableReason =
  | 'unauthorized'
  | 'source-unavailable'
  | 'source-changed'
  | 'source-ambiguous'
  | 'project-mismatch'
  | 'invalid-reference'
  | 'unsupported-reader';

export type DistillationEvidenceReadResult =
  | { status: 'available'; packet: DistillationEvidencePacket }
  | { status: 'unavailable'; reason: DistillationEvidenceUnavailableReason };

export type DistillationEvidenceReloadResult =
  | { status: 'available'; events: DistillationEvidenceEvent[] }
  | { status: 'unavailable'; reason: DistillationEvidenceUnavailableReason };

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const bound = (value: number | undefined, maximum: number): number => {
  if (value === undefined) {
    return maximum;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error('Distillation evidence limit is invalid');
  }
  return value;
};
const truncate = (value: string, maximumBytes: number): { text: string; truncated: boolean } => {
  const buffer = Buffer.from(value);
  return buffer.byteLength <= maximumBytes
    ? { text: value, truncated: false }
    : { text: buffer.subarray(0, maximumBytes).toString('utf8').replace(TRAILING_REPLACEMENT, ''), truncated: true };
};

const messageText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .flatMap((part) => {
      if (!isRecord(part) || (part.type !== 'input_text' && part.type !== 'output_text' && part.type !== 'text')) {
        return [];
      }
      return typeof part.text === 'string' ? [part.text] : [];
    })
    .join('\n');
};

interface EvidenceCandidate {
  callId: string | null;
  kind: DistillationEvidenceEvent['kind'];
  representation: 'canonical' | 'response';
  text: string;
  toolName: string | null;
}

const classify = (event: Record<string, unknown>, payload: Record<string, unknown>): EvidenceCandidate | null => {
  const base = { toolName: null, callId: null, representation: 'response' as const };
  if (event.type === 'event_msg' && payload.type === 'user_message') {
    return { ...base, kind: 'user', text: messageText(payload.message), representation: 'canonical' };
  }
  if (event.type === 'event_msg' && payload.type === 'agent_message') {
    return { ...base, kind: 'assistant', text: messageText(payload.message), representation: 'canonical' };
  }
  if (event.type !== 'response_item') {
    return null;
  }
  if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'assistant')) {
    return { ...base, kind: payload.role, text: messageText(payload.content) };
  }
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    return {
      ...base,
      kind: 'tool-call',
      text: messageText(payload.arguments ?? payload.input),
      toolName: nonempty(payload.name),
      callId: nonempty(payload.call_id),
    };
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    return { ...base, kind: 'tool-result', text: messageText(payload.output), callId: nonempty(payload.call_id) };
  }
  return null;
};

interface Snapshot {
  incompleteRecord: boolean;
  prefixTruncated: boolean;
  text: string;
  version: DistillationSourceVersion;
}

const readSnapshot = (storage: Storage, filePath: string, sourceBytes: number) =>
  Effect.gen(function* () {
    if (!(storage.readFileMetadata && storage.readTextRange)) {
      return null;
    }
    const before = yield* storage.readFileMetadata(filePath);
    const first = yield* storage.readTextRange(filePath, 0, sourceBytes);
    const second = yield* storage.readTextRange(filePath, 0, sourceBytes);
    const after = yield* storage.readFileMetadata(filePath);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      first.bytesRead !== Math.min(before.size, sourceBytes) ||
      first.text !== second.text
    ) {
      return 'changed' as const;
    }
    const prefixTruncated = first.bytesRead < before.size;
    const lastNewline = first.text.lastIndexOf('\n');
    const incompleteRecord = prefixTruncated && !first.text.endsWith('\n');
    const text = incompleteRecord ? first.text.slice(0, lastNewline + 1) : first.text;
    return {
      text,
      prefixTruncated,
      incompleteRecord,
      version: {
        digest: sha256(text),
        bytes: Buffer.byteLength(text),
        totalBytes: before.size,
        modifiedAtMs: before.mtimeMs,
      },
    } satisfies Snapshot;
  });

const isAuthorized = (request: CodexDistillationEvidenceRequest): boolean => {
  const selection = request.selection;
  return (
    selection.sourceAuthority === 'local-observed' &&
    selection.machineId.length > 0 &&
    selection.machineId === request.localMachineId &&
    selection.projectId.length > 0 &&
    SAFE_SESSION_ID.test(selection.sourceSessionId) &&
    path.isAbsolute(selection.checkoutPath) &&
    path.normalize(selection.checkoutPath) === selection.checkoutPath
  );
};

const readCandidate = (request: CodexDistillationEvidenceRequest, storage: Storage, sourceBytes: number) =>
  Effect.gen(function* () {
    if (!isAuthorized(request)) {
      return { status: 'unavailable', reason: 'unauthorized' } as const;
    }
    const files = yield* listCodexSessionFiles.pipe(Effect.provideService(LocalHistoryStorage, storage));
    const sessionId = request.selection.sourceSessionId;
    const candidates = files.filter(
      (file) => path.basename(file) === `${sessionId}.jsonl` || path.basename(file).endsWith(`-${sessionId}.jsonl`),
    );
    if (candidates.length !== 1) {
      return {
        status: 'unavailable',
        reason: candidates.length === 0 ? 'source-unavailable' : 'source-ambiguous',
      } as const;
    }
    const file = candidates[0];
    if (!file) {
      return { status: 'unavailable', reason: 'source-unavailable' } as const;
    }
    const snapshot = yield* readSnapshot(storage, file, sourceBytes);
    if (!snapshot) {
      return { status: 'unavailable', reason: 'unsupported-reader' } as const;
    }
    if (snapshot === 'changed') {
      return { status: 'unavailable', reason: 'source-changed' } as const;
    }
    return { status: 'available', snapshot } as const;
  });

interface CandidateRecord {
  duplicateKey: string | null;
  event: DistillationEvidenceEvent;
  representation: EvidenceCandidate['representation'];
}

const normalizeSnapshot = (
  snapshot: Snapshot,
  request: CodexDistillationEvidenceRequest,
  options: CodexDistillationEvidenceOptions,
): DistillationEvidenceReadResult => {
  const lineBytes = bound(options.limits?.lineBytes, MAX_LINE_BYTES);
  const eventBytes = bound(options.limits?.eventBytes, DISTILLATION_EVENT_MAX_BYTES);
  const maximumEvents = bound(options.limits?.events, DISTILLATION_MAX_EVENTS);
  const contentBytes = bound(options.limits?.contentBytes, MAX_EVENT_CONTENT_BYTES);
  const parser = createCodexSessionParser(true);
  const exclusions = new Map<DistillationExclusionReason, number>();
  const exclude = (reason: DistillationExclusionReason) => exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
  const records: CandidateRecord[] = [];
  const mirrorRepresentations = new Map<string, CandidateRecord[]>();
  const toolRepresentations = new Set<string>();
  const callTurns = new Map<string, { nativeTurnId: string | null; replayed: boolean }>();
  let retainedBytes = 0;
  let lines = 0;
  let metadataMatches = false;
  let metadataConflict = false;
  let completion: DistillationEvidenceCoverage['completion'] = 'unknown';
  const activeTasks = new Set<string>();
  if (snapshot.prefixTruncated) {
    exclude('source-byte-budget');
  }
  if (snapshot.incompleteRecord) {
    exclude('incomplete-record');
  }
  const sourceLines = snapshot.text.split('\n');
  for (const [index, line] of sourceLines.entries()) {
    if (line.length === 0 && index === sourceLines.length - 1) {
      continue;
    }
    lines = index + 1;
    if (Buffer.byteLength(line) > lineBytes) {
      exclude('oversized-record');
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      exclude('malformed-record');
      continue;
    }
    if (!isRecord(parsed)) {
      exclude('malformed-record');
      continue;
    }
    const payload = asRecord(parsed.payload);
    if (parsed.type === 'session_meta') {
      const matches =
        payload.id === request.selection.sourceSessionId && payload.cwd === request.selection.checkoutPath;
      metadataMatches ||= matches;
      metadataConflict ||= !matches;
    }
    const previousContext = parser.evidenceContext(nonempty(payload.turn_id));
    parser.visit(line);
    const taskContext = parser.evidenceContext(nonempty(payload.turn_id));
    if (payload.type === 'task_started' && taskContext && !taskContext.replayed) {
      activeTasks.add(taskContext.turnId);
      completion = 'in-progress';
    }
    if (
      (payload.type === 'task_complete' || payload.type === 'turn_aborted') &&
      previousContext &&
      !previousContext.replayed
    ) {
      activeTasks.delete(previousContext.turnId);
      completion = payload.type === 'turn_aborted' ? 'interrupted' : 'completed';
      if (activeTasks.size > 0) {
        completion = 'in-progress';
      }
    }
    if (payload.type === 'reasoning' || payload.type === 'agent_reasoning' || payload.channel === 'analysis') {
      exclude('reasoning');
      continue;
    }
    if (payload.role === 'system' || payload.role === 'developer') {
      exclude('instructions');
      continue;
    }
    const candidate = classify(parsed, payload);
    if (!candidate) {
      if (parsed.type === 'response_item') {
        exclude('unsupported-content');
      }
      continue;
    }
    if (!candidate.text) {
      exclude('unsupported-content');
      continue;
    }
    const content = payload.type === 'message' ? payload.content : payload.output;
    const partialContent =
      Array.isArray(content) &&
      content.some(
        (part) =>
          !isRecord(part) ||
          (part.type !== 'input_text' && part.type !== 'output_text' && part.type !== 'text') ||
          typeof part.text !== 'string',
      );
    if (partialContent) {
      exclude('unsupported-content');
    }
    const explicitTurnId =
      nonempty(asRecord(payload.internal_chat_message_metadata_passthrough).turn_id) ?? nonempty(payload.turn_id);
    const context = parser.evidenceContext(explicitTurnId);
    const callContext =
      candidate.kind === 'tool-result' && candidate.callId ? callTurns.get(candidate.callId) : undefined;
    const nativeTurnId = callContext?.nativeTurnId ?? context?.turnId ?? null;
    const replayed = callContext?.replayed ?? context?.replayed ?? false;
    if (candidate.kind === 'tool-call' && candidate.callId) {
      callTurns.set(candidate.callId, { nativeTurnId, replayed });
    }
    if (replayed) {
      exclude('replayed-history');
      continue;
    }
    if (!(context?.hasContext || callContext)) {
      // Unanchored response items can be inherited context. Never present them as current work.
      exclude('unattributed-history');
      continue;
    }
    const timestamp =
      typeof parsed.timestamp === 'string' && Number.isFinite(Date.parse(parsed.timestamp)) ? parsed.timestamp : null;
    // Only paired harness representations of one message are deduplicated. A new native
    // event of the same representation, even with identical text, remains a new attempt.
    const duplicateKey =
      candidate.kind === 'user' || candidate.kind === 'assistant'
        ? JSON.stringify([nativeTurnId, candidate.kind, candidate.text])
        : null;
    const mirrors = duplicateKey === null ? [] : (mirrorRepresentations.get(duplicateKey) ?? []);
    const mirrorIndex = mirrors.findIndex(
      (mirror) =>
        mirror.representation !== candidate.representation &&
        mirror.event.timestamp !== null &&
        timestamp !== null &&
        Math.abs(Date.parse(mirror.event.timestamp) - Date.parse(timestamp)) <= 1000,
    );
    if (mirrorIndex >= 0) {
      exclude('duplicate-representation');
      mirrors.splice(mirrorIndex, 1);
      continue;
    }
    if ((candidate.kind === 'tool-call' || candidate.kind === 'tool-result') && candidate.callId) {
      const nativeIdentity = JSON.stringify([nativeTurnId, candidate.kind, candidate.callId, candidate.text]);
      if (toolRepresentations.has(nativeIdentity)) {
        exclude('duplicate-representation');
        continue;
      }
      toolRepresentations.add(nativeIdentity);
    }
    if (records.length >= maximumEvents) {
      exclude('event-budget');
      continue;
    }
    const redacted = options.redactText(candidate.text);
    const bounded = truncate(redacted, Math.max(0, Math.min(eventBytes, contentBytes - retainedBytes)));
    if (bounded.truncated) {
      exclude('text-budget');
    }
    if (!bounded.text) {
      continue;
    }
    const recordedTruncation = candidate.kind === 'tool-result' && RECORDED_OUTPUT_TRUNCATION.test(candidate.text);
    if (recordedTruncation) {
      exclude('recorded-truncation');
    }
    const event: DistillationEvidenceEvent = {
      id: `event:${lines}:${sha256(line).slice(0, 16)}`,
      line: lines,
      kind: candidate.kind,
      text: bounded.text,
      timestamp,
      nativeTurnId,
      roundId: null,
      toolName: candidate.toolName === null ? null : truncate(options.redactText(candidate.toolName), 512).text,
      callId: candidate.callId === null ? null : truncate(options.redactText(candidate.callId), 512).text,
      truncated: bounded.truncated || recordedTruncation || partialContent,
      redacted: redacted !== candidate.text,
    };
    const serializedBytes = Buffer.byteLength(JSON.stringify(event));
    if (retainedBytes + serializedBytes > contentBytes) {
      exclude('text-budget');
      continue;
    }
    retainedBytes += serializedBytes;
    const record: CandidateRecord = { event, representation: candidate.representation, duplicateKey };
    records.push(record);
    if (duplicateKey !== null) {
      mirrors.push(record);
      mirrorRepresentations.set(duplicateKey, mirrors);
    }
  }
  if (!metadataMatches || metadataConflict) {
    return { status: 'unavailable', reason: 'project-mismatch' };
  }
  const detail = parser.detail();
  const turnIndexes = parser.evidenceTurnIndexes();
  const rounds = new Map((detail ? deriveSessionRounds(detail) : []).map((round) => [round.turnIndex, round.id]));
  const events = records.map(({ event }) => {
    const index = event.nativeTurnId === null ? undefined : turnIndexes.get(event.nativeTurnId);
    return { ...event, roundId: index === undefined ? null : (rounds.get(index) ?? null) };
  });
  const partial =
    completion !== 'completed' ||
    [...exclusions.keys()].some(
      (reason) =>
        reason !== 'reasoning' &&
        reason !== 'instructions' &&
        reason !== 'replayed-history' &&
        reason !== 'duplicate-representation',
    );
  const body = {
    schemaVersion: DISTILLATION_EVIDENCE_VERSION,
    normalizationVersion: DISTILLATION_NORMALIZATION_VERSION,
    redactionVersion: options.redactionVersion,
    source: {
      harnessKey: 'codex' as const,
      machineId: request.selection.machineId,
      projectId: request.selection.projectId,
      nativeSessionId: request.selection.sourceSessionId,
      reportAnchor: request.selection.reportAnchor ?? null,
      version: snapshot.version,
    },
    events,
    coverage: {
      scope: 'session-only' as const,
      status: partial ? ('partial' as const) : ('complete' as const),
      lines,
      includedEvents: events.length,
      exclusions: [...exclusions].map(([reason, count]) => ({ reason, count })),
      childrenNotAnalyzed: null,
      completion,
      childDiscovery: 'not-performed' as const,
    },
  };
  const packet = { ...body, packetDigest: sha256(distillationEvidenceDigestInput(body)) };
  if (Buffer.byteLength(JSON.stringify(packet)) > DISTILLATION_PACKET_MAX_BYTES) {
    throw new Error('Distillation packet overhead exceeded its hard budget');
  }
  return { status: 'available', packet: parseDistillationEvidencePacket(packet) };
};

export const prepareCodexDistillationEvidence = (
  request: CodexDistillationEvidenceRequest,
  options: CodexDistillationEvidenceOptions,
): Promise<DistillationEvidenceReadResult> => {
  const storage = options.storage ?? createLocalHistoryStorage(options.homePath);
  const sourceBytes = bound(options.limits?.sourceBytes, MAX_SOURCE_BYTES);
  const effect = readCandidate(request, storage, sourceBytes).pipe(
    Effect.map(
      (result): DistillationEvidenceReadResult =>
        result.status === 'unavailable' ? result : normalizeSnapshot(result.snapshot, request, options),
    ),
    Effect.catchAll(() => Effect.succeed({ status: 'unavailable' as const, reason: 'source-unavailable' as const })),
  );
  return Effect.runPromise(effect, options.signal === undefined ? undefined : { signal: options.signal });
};

export const reloadCodexDistillationEvidence = async (
  request: CodexDistillationEvidenceRequest,
  expected: Pick<DistillationEvidencePacket, 'source' | 'packetDigest'>,
  reference: DistillationEvidenceRef,
  options: CodexDistillationEvidenceOptions,
): Promise<DistillationEvidenceReloadResult> => {
  const packet = { source: parseDistillationEvidenceSource(expected.source), packetDigest: expected.packetDigest };
  const ref = parseDistillationEvidenceRef(reference);
  if (
    ref.packetDigest !== packet.packetDigest ||
    ref.sourceDigest !== packet.source.version.digest ||
    request.selection.sourceSessionId !== packet.source.nativeSessionId ||
    request.selection.machineId !== packet.source.machineId ||
    request.selection.projectId !== packet.source.projectId
  ) {
    return { status: 'unavailable', reason: 'invalid-reference' };
  }
  const result = await prepareCodexDistillationEvidence(request, options);
  if (result.status === 'unavailable') {
    return result;
  }
  if (result.packet.packetDigest !== packet.packetDigest) {
    return { status: 'unavailable', reason: 'source-changed' };
  }
  if (ref.eventIds.some((id) => !result.packet.events.some((event) => event.id === id))) {
    return { status: 'unavailable', reason: 'invalid-reference' };
  }
  return {
    status: 'available',
    events: ref.eventIds.flatMap((id) => result.packet.events.filter((event) => event.id === id)),
  };
};
