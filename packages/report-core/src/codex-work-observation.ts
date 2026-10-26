import type { CanonicalInstant } from './canonical-instant';
import { isRecord } from './datasets';
import { normalizeIsoTimestamp } from './provider-status';

/** Local auxiliary facts only: never part of usage rows, snapshots or replication. */
export const CODEX_WORK_BOUNDS = { maxRequests: 16, maxQuestions: 3, maxText: 512, maxId: 256 } as const;

export interface CodexWorkQuestion {
  /** Only a nonempty native answer for this question id and this request call id establishes this. */
  readonly answeredAt: CanonicalInstant | null;
  /** Absent for the native asynchronous tool: a display index is not a response identity. */
  readonly id: string | null;
  readonly text: string;
  readonly textTruncated: boolean;
}

export interface CodexWorkRequest {
  /** A tool acknowledgement says the request was accepted, never that the person answered. */
  readonly acknowledgedAt: CanonicalInstant | null;
  readonly askedAt: CanonicalInstant;
  readonly callId: string;
  readonly questions: readonly CodexWorkQuestion[];
  /** Explicit tool failure before acknowledgement: invocation alone did not present a question. */
  readonly rejectedAt: CanonicalInstant | null;
  readonly tool: 'request_user_input' | 'request_user_input_async';
}

export interface CodexWorkObservation {
  readonly forkedFromId: string | null;
  readonly format: 'codex-work-v1';
  readonly lastEventAt: CanonicalInstant;
  readonly latestUserMessageAt: CanonicalInstant | null;
  readonly omittedRequests: number;
  readonly originator: string | null;
  readonly rejectedRecords: number;
  readonly requests: readonly CodexWorkRequest[];
  readonly source: string | null;
  readonly sourceSessionId: string;
  readonly threadSource: string | null;
}

export interface StoredCodexWorkObservation extends CodexWorkObservation {
  readonly machineId: string;
  readonly observedAt: CanonicalInstant;
}

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const CONTROL_CHARACTERS = /\p{Cc}/u;
const text = (value: unknown, max: number = CODEX_WORK_BOUNDS.maxId): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !CONTROL_CHARACTERS.test(value);

const optionalText = (value: unknown): value is string | null => value === null || text(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const instant = (value: unknown): CanonicalInstant | null =>
  typeof value === 'string' ? normalizeIsoTimestamp(value) : null;

const parseQuestion = (value: unknown, askedAt: CanonicalInstant): CodexWorkQuestion | null => {
  if (!(isRecord(value) && exactKeys(value, ['id', 'text', 'textTruncated', 'answeredAt']))) {
    return null;
  }
  const answeredAt = instant(value.answeredAt);
  if (
    !(optionalText(value.id) && text(value.text, CODEX_WORK_BOUNDS.maxText)) ||
    typeof value.textTruncated !== 'boolean' ||
    (value.answeredAt !== null && (answeredAt === null || answeredAt < askedAt || value.id === null))
  ) {
    return null;
  }
  return { id: value.id, text: value.text, textTruncated: value.textTruncated, answeredAt };
};

const parseRequest = (value: unknown): CodexWorkRequest | null => {
  if (
    !(isRecord(value) && exactKeys(value, ['callId', 'tool', 'askedAt', 'acknowledgedAt', 'rejectedAt', 'questions']))
  ) {
    return null;
  }
  const askedAt = instant(value.askedAt);
  const acknowledgedAt = instant(value.acknowledgedAt);
  const rejectedAt = instant(value.rejectedAt);
  if (
    !text(value.callId) ||
    (value.tool !== 'request_user_input' && value.tool !== 'request_user_input_async') ||
    askedAt === null ||
    (value.acknowledgedAt !== null && (acknowledgedAt === null || acknowledgedAt < askedAt)) ||
    (value.rejectedAt !== null && (rejectedAt === null || rejectedAt < askedAt || acknowledgedAt !== null)) ||
    !Array.isArray(value.questions) ||
    value.questions.length === 0 ||
    value.questions.length > CODEX_WORK_BOUNDS.maxQuestions
  ) {
    return null;
  }
  const questions = value.questions.map((question) => parseQuestion(question, askedAt));
  if (questions.some((question) => question === null)) {
    return null;
  }
  const validQuestions = questions.filter((question): question is CodexWorkQuestion => question !== null);
  const ids = validQuestions.flatMap((question) => (question.id === null ? [] : [question.id]));
  if (
    new Set(ids).size !== ids.length ||
    (value.tool === 'request_user_input' && ids.length !== questions.length) ||
    (value.tool === 'request_user_input_async' && ids.length !== 0) ||
    (rejectedAt !== null && validQuestions.some((question) => question.answeredAt !== null))
  ) {
    return null;
  }
  return { callId: value.callId, tool: value.tool, askedAt, acknowledgedAt, rejectedAt, questions: validQuestions };
};

/** Strict on import and cache/store reads; malformed facts never become an empty success. */
export const parseCodexWorkObservation = (value: unknown): CodexWorkObservation | null => {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        'format',
        'sourceSessionId',
        'originator',
        'source',
        'threadSource',
        'forkedFromId',
        'lastEventAt',
        'latestUserMessageAt',
        'requests',
        'omittedRequests',
        'rejectedRecords',
      ])
    )
  ) {
    return null;
  }
  const lastEventAt = instant(value.lastEventAt);
  const latestUserMessageAt = instant(value.latestUserMessageAt);
  if (
    value.format !== 'codex-work-v1' ||
    !text(value.sourceSessionId) ||
    !optionalText(value.originator) ||
    !optionalText(value.source) ||
    !optionalText(value.threadSource) ||
    !optionalText(value.forkedFromId) ||
    lastEventAt === null ||
    (value.latestUserMessageAt !== null && (latestUserMessageAt === null || latestUserMessageAt > lastEventAt)) ||
    !count(value.omittedRequests) ||
    !count(value.rejectedRecords) ||
    !Array.isArray(value.requests) ||
    value.requests.length > CODEX_WORK_BOUNDS.maxRequests
  ) {
    return null;
  }
  const requests = value.requests.map(parseRequest);
  if (
    requests.some(
      (request) =>
        request === null ||
        request.askedAt > lastEventAt ||
        (request.acknowledgedAt !== null && request.acknowledgedAt > lastEventAt) ||
        (request.rejectedAt !== null && request.rejectedAt > lastEventAt) ||
        request.questions.some((question) => question.answeredAt !== null && question.answeredAt > lastEventAt),
    )
  ) {
    return null;
  }
  const validRequests = requests.filter((request): request is CodexWorkRequest => request !== null);
  if (new Set(validRequests.map((request) => request.callId)).size !== requests.length) {
    return null;
  }
  return {
    format: 'codex-work-v1',
    sourceSessionId: value.sourceSessionId,
    originator: value.originator,
    source: value.source,
    threadSource: value.threadSource,
    forkedFromId: value.forkedFromId,
    lastEventAt,
    latestUserMessageAt,
    requests: validRequests,
    omittedRequests: value.omittedRequests,
    rejectedRecords: value.rejectedRecords,
  };
};
