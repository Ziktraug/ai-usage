import { createHash } from 'node:crypto';
import fs from 'node:fs';
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
/** Full digest verification is bounded separately from the model's window budget. */
export const DISTILLATION_SNAPSHOT_MAX_BYTES = 128 * 1024 * 1024;
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
  | 'source-budget-exceeded'
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
  sourceLines?: Iterable<string | { oversizedPrefix: string }>;
  text: string;
  version: DistillationSourceVersion;
  window?: { index: number; startLine: number };
}

/** Recover only a text prefix of an oversized allowed record; never expose an unknown role/channel. */
const oversizedTextRecord = (prefix: string): string | null => {
  const closings: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const character of prefix) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) {
      continue;
    }
    if (character === '{') {
      closings.push('}');
    } else if (character === '[') {
      closings.push(']');
    } else if (character === '}' || character === ']') {
      closings.pop();
    }
  }
  if (!quoted) {
    return null;
  }
  for (let trim = 0; trim <= 6; trim += 1) {
    const candidate = `${prefix.slice(0, prefix.length - trim)}"${closings.toReversed().join('')}`;
    try {
      const record = asRecord(JSON.parse(candidate));
      const payload = asRecord(record.payload);
      const allowed =
        payload.type === 'user_message' ||
        payload.type === 'function_call_output' ||
        payload.type === 'custom_tool_call_output' ||
        payload.type === 'function_call' ||
        payload.type === 'custom_tool_call' ||
        (payload.type === 'message' &&
          (payload.role === 'user' ||
            (payload.role === 'assistant' && (payload.channel === 'commentary' || payload.channel === 'final'))));
      return allowed ? candidate : null;
    } catch {
      /* A prefix can end in the middle of a JSON escape. */
    }
  }
  return null;
};

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
  const parser = createCodexSessionParser(true, snapshot.window !== undefined);
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
  let sessionDate: string | null = null;
  let completion: DistillationEvidenceCoverage['completion'] = 'unknown';
  const activeTasks = new Set<string>();
  let nextLine: number | null = null;
  const overlapEventIds: string[] = [];
  let previousPrompt: CandidateRecord | null = null;
  const previousCalls = new Map<string, CandidateRecord>();
  if (snapshot.prefixTruncated) {
    exclude('source-byte-budget');
  }
  if (snapshot.incompleteRecord) {
    exclude('incomplete-record');
  }
  const sourceLines =
    snapshot.sourceLines ??
    snapshot.text.split('\n').filter((line, index, values) => line.length !== 0 || index !== values.length - 1);
  for (const sourceLine of sourceLines) {
    const oversized = typeof sourceLine !== 'string';
    const recovered = oversized ? oversizedTextRecord(sourceLine.oversizedPrefix) : sourceLine;
    if (oversized) {
      exclude('oversized-record');
    }
    if (recovered === null) {
      lines += 1;
      continue;
    }
    const line = recovered;
    if (line.length === 0) {
      lines += 1;
      exclude('malformed-record');
      continue;
    }
    lines += 1;
    if (!oversized && Buffer.byteLength(line) > lineBytes) {
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
      if (typeof parsed.timestamp === 'string' && Number.isFinite(Date.parse(parsed.timestamp))) {
        sessionDate ??= parsed.timestamp;
      }
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
    const missingCall = snapshot.window && candidate.kind === 'tool-result' && candidate.callId && !callContext;
    const nativeTurnId = missingCall ? null : (callContext?.nativeTurnId ?? context?.turnId ?? null);
    const replayed = callContext?.replayed ?? context?.replayed ?? false;
    if (candidate.kind === 'tool-call' && candidate.callId) {
      callTurns.set(candidate.callId, { nativeTurnId, replayed });
      if (snapshot.window && callTurns.size > 4096) {
        callTurns.delete(callTurns.keys().next().value ?? '');
        exclude('identity-budget');
      }
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
        ? JSON.stringify([nativeTurnId, candidate.kind, sha256(candidate.text)])
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
      const nativeIdentity = JSON.stringify([nativeTurnId, candidate.kind, candidate.callId, sha256(candidate.text)]);
      if (toolRepresentations.has(nativeIdentity)) {
        exclude('duplicate-representation');
        continue;
      }
      toolRepresentations.add(nativeIdentity);
      if (snapshot.window && toolRepresentations.size > 4096) {
        toolRepresentations.delete(toolRepresentations.values().next().value ?? '');
        exclude('identity-budget');
      }
    }
    if (!snapshot.window && records.length >= maximumEvents) {
      exclude('event-budget');
      continue;
    }
    const redacted = options.redactText(candidate.text);
    const bounded = truncate(
      redacted,
      snapshot.window ? eventBytes : Math.max(0, Math.min(eventBytes, contentBytes - retainedBytes)),
    );
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
      truncated: oversized || bounded.truncated || recordedTruncation || partialContent,
      redacted: redacted !== candidate.text,
    };
    const record: CandidateRecord = { event, representation: candidate.representation, duplicateKey };
    if (snapshot.window && duplicateKey !== null) {
      mirrors.push(record);
      if (mirrors.length > 32) {
        mirrors.shift();
      }
      mirrorRepresentations.set(duplicateKey, mirrors);
      if (mirrorRepresentations.size > 32) {
        mirrorRepresentations.delete(mirrorRepresentations.keys().next().value ?? '');
        exclude('identity-budget');
      }
    }
    if (snapshot.window && lines < snapshot.window.startLine) {
      if (candidate.kind === 'user') {
        previousPrompt = record;
      }
      if (candidate.kind === 'tool-call' && candidate.callId) {
        previousCalls.set(candidate.callId, record);
        if (previousCalls.size > 8) {
          previousCalls.delete(previousCalls.keys().next().value ?? '');
        }
      }
      continue;
    }
    if (snapshot.window && nextLine !== null) {
      continue;
    }
    if (snapshot.window && records.length === 0 && previousPrompt) {
      records.push(previousPrompt);
      overlapEventIds.push(previousPrompt.event.id);
      retainedBytes += Buffer.byteLength(JSON.stringify(previousPrompt.event));
    }
    const pairedCall =
      candidate.kind === 'tool-result' && candidate.callId ? previousCalls.get(candidate.callId) : undefined;
    if (snapshot.window && pairedCall && !records.some((item) => item.event.id === pairedCall.event.id)) {
      records.push(pairedCall);
      overlapEventIds.push(pairedCall.event.id);
      retainedBytes += Buffer.byteLength(JSON.stringify(pairedCall.event));
    }
    if (records.length >= maximumEvents) {
      if (snapshot.window) {
        nextLine = lines;
      } else {
        exclude('event-budget');
      }
      continue;
    }
    const serializedBytes = Buffer.byteLength(JSON.stringify(event));
    if (retainedBytes + serializedBytes > contentBytes) {
      if (snapshot.window) {
        nextLine = lines;
      } else {
        exclude('text-budget');
      }
      continue;
    }
    retainedBytes += serializedBytes;
    records.push(record);
    if (!snapshot.window && duplicateKey !== null) {
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
  if (snapshot.window) {
    for (const event of events) {
      if (event.nativeTurnId !== null && event.roundId === null) {
        exclude('round-budget');
      }
    }
  }
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
    ...(snapshot.window ? { window: { ...snapshot.window, nextLine, overlapEventIds } } : {}),
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
      ...(snapshot.window ? { sessionDate } : {}),
    },
    events,
    coverage: {
      ...(snapshot.window
        ? {
            snapshotCoverage: nextLine === null ? ('complete' as const) : ('partial' as const),
            textCoverage: partial ? ('partial' as const) : ('complete' as const),
          }
        : {}),
      scope: 'session-only' as const,
      status: partial || nextLine !== null ? ('partial' as const) : ('complete' as const),
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

/** Reads the fixed file horizon with bounded buffers. No unredacted snapshot is persisted. */
function* progressiveSourceLines(
  file: string,
  version: DistillationSourceVersion,
  deadline: number,
  signal?: AbortSignal,
): Generator<string | { oversizedPrefix: string }> {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('source-unavailable');
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: hardened regular file open flags.
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const digest = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let discarding = false;
  let oversizedPrefix = '';
  let offset = 0;
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      before.size !== version.totalBytes ||
      before.mtimeMs !== version.modifiedAtMs
    ) {
      throw new Error('source-changed');
    }
    while (offset < version.totalBytes) {
      signal?.throwIfAborted();
      if (Date.now() >= deadline) {
        throw new Error('source-budget-exceeded');
      }
      const buffer = Buffer.alloc(Math.min(64 * 1024, version.totalBytes - offset));
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (!bytes) {
        throw new Error('source-changed');
      }
      offset += bytes;
      digest.update(buffer.subarray(0, bytes));
      pending += decoder.decode(buffer.subarray(0, bytes), { stream: true });
      for (;;) {
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          break;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        // A discarded record still occupies its original line identity.
        yield discarding ? { oversizedPrefix } : line;
        discarding = false;
        oversizedPrefix = '';
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
        if (!discarding) {
          oversizedPrefix = truncate(pending, MAX_LINE_BYTES).text;
        }
        pending = '';
        discarding = true;
      } else if (discarding) {
        pending = '';
      }
    }
    pending += decoder.decode();
    if (discarding) {
      yield { oversizedPrefix };
    } else if (pending) {
      yield pending;
    }
    const after = fs.lstatSync(file);
    const current = fs.fstatSync(descriptor);
    if (
      after.isSymbolicLink() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.size !== before.size ||
      current.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      current.mtimeMs !== before.mtimeMs
    ) {
      throw new Error('source-changed');
    }
    version.bytes = offset;
    version.digest = digest.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}

export const prepareCodexDistillationWindow = async (
  request: CodexDistillationEvidenceRequest,
  options: CodexDistillationEvidenceOptions,
  continuation?: { version: DistillationSourceVersion; index: number; startLine: number },
): Promise<DistillationEvidenceReadResult> => {
  if (!isAuthorized(request)) {
    return { status: 'unavailable', reason: 'unauthorized' };
  }
  const deadline = Date.now() + 30_000;
  try {
    const storage = options.storage ?? createLocalHistoryStorage(options.homePath);
    const files = await Effect.runPromise(
      listCodexSessionFiles.pipe(Effect.provideService(LocalHistoryStorage, storage)),
      { signal: options.signal },
    );
    const sessionId = request.selection.sourceSessionId;
    const matches = files.filter(
      (file) => path.basename(file) === `${sessionId}.jsonl` || path.basename(file).endsWith(`-${sessionId}.jsonl`),
    );
    if (matches.length !== 1) {
      return { status: 'unavailable', reason: matches.length ? 'source-ambiguous' : 'source-unavailable' };
    }
    const file = matches[0];
    if (!file) {
      return { status: 'unavailable', reason: 'source-unavailable' };
    }
    const metadata = fs.lstatSync(file);
    if (metadata.size > DISTILLATION_SNAPSHOT_MAX_BYTES) {
      return { status: 'unavailable', reason: 'source-budget-exceeded' };
    }
    const version = continuation
      ? { ...continuation.version }
      : { bytes: metadata.size, totalBytes: metadata.size, modifiedAtMs: metadata.mtimeMs, digest: '' };
    const snapshot: Snapshot = {
      text: '',
      prefixTruncated: false,
      incompleteRecord: false,
      version,
      window: { index: continuation?.index ?? 0, startLine: continuation?.startLine ?? 1 },
      sourceLines: progressiveSourceLines(file, version, deadline, options.signal),
    };
    const result = normalizeSnapshot(snapshot, request, options);
    if (result.status !== 'available') {
      return result;
    }
    // A second bounded scan rejects an in-place rewrite even if metadata was restored.
    const verified = { ...version };
    const verification = progressiveSourceLines(file, verified, deadline, options.signal);
    while (!verification.next().done) {
      options.signal?.throwIfAborted();
    }
    if (verified.digest !== version.digest || (continuation && version.digest !== continuation.version.digest)) {
      return { status: 'unavailable', reason: 'source-changed' };
    }
    return result;
  } catch (cause) {
    options.signal?.throwIfAborted();
    let reason: DistillationEvidenceUnavailableReason = 'source-unavailable';
    if (cause instanceof Error && cause.message === 'source-changed') {
      reason = 'source-changed';
    }
    if (cause instanceof Error && cause.message === 'source-budget-exceeded') {
      reason = 'source-budget-exceeded';
    }
    return {
      status: 'unavailable',
      reason,
    };
  }
};

export const reloadCodexDistillationEvidence = async (
  request: CodexDistillationEvidenceRequest,
  expected: Pick<DistillationEvidencePacket, 'source' | 'packetDigest' | 'window'>,
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
  const result = expected.window
    ? await prepareCodexDistillationWindow(request, options, {
        version: expected.source.version,
        index: expected.window.index,
        startLine: expected.window.startLine,
      })
    : await prepareCodexDistillationEvidence(request, options);
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
