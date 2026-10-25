import { canonicalInstantFromDate } from '@ai-usage/report-core/canonical-instant';
import {
  CODEX_WORK_BOUNDS,
  type CodexWorkObservation,
  type CodexWorkQuestion,
  type CodexWorkRequest,
} from '@ai-usage/report-core/codex-work-observation';
import { isRecord } from '@ai-usage/report-core/datasets';

const WHITESPACE = /[\s\p{Cc}]+/gu;
const ID_WHITESPACE = /[\s\p{Cc}]/u;
const OUTPUT_TYPE = /"type"\s*:\s*"(?:function_call_output|custom_tool_call_output)"/u;
const CALL_ID = /"call_id"\s*:\s*"([^"\\]+)"/u;
const UNAVAILABLE_INPUT_TOOL =
  /^(?:Error:\s*)?request_user_input(?:_async)? is (?:unavailable|not available) in .+ mode\.?$/u;

const identifier = (value: unknown): string | null =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= CODEX_WORK_BOUNDS.maxId &&
  value.trim() === value &&
  !ID_WHITESPACE.test(value)
    ? value
    : null;

const nativeText = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.replace(WHITESPACE, ' ').trim();
  return normalized.length === 0 ? null : normalized;
};

const metadataText = (value: unknown): string | null => {
  const normalized = nativeText(value);
  return normalized !== null && normalized.length <= CODEX_WORK_BOUNDS.maxId ? normalized : null;
};

const decode = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const inputTool = (value: unknown): CodexWorkRequest['tool'] | null => {
  if (value === 'request_user_input' || value === 'functions.request_user_input') {
    return 'request_user_input';
  }
  if (value === 'request_user_input_async' || value === 'functions.request_user_input_async') {
    return 'request_user_input_async';
  }
  return null;
};

const questionsFrom = (value: unknown, tool: CodexWorkRequest['tool']): CodexWorkQuestion[] | null => {
  if (
    !(isRecord(value) && Array.isArray(value.questions)) ||
    value.questions.length === 0 ||
    value.questions.length > CODEX_WORK_BOUNDS.maxQuestions
  ) {
    return null;
  }
  const questions: CodexWorkQuestion[] = [];
  for (const raw of value.questions) {
    if (!isRecord(raw)) {
      return null;
    }
    const id = tool === 'request_user_input' ? identifier(raw.id) : null;
    const text =
      raw.isSecret === true
        ? 'Private question (text not collected)'
        : nativeText(tool === 'request_user_input' ? raw.question : raw.title);
    if (text === null || (tool === 'request_user_input' && id === null)) {
      return null;
    }
    questions.push({
      id,
      text: text.slice(0, CODEX_WORK_BOUNDS.maxText),
      textTruncated: text.length > CODEX_WORK_BOUNDS.maxText,
      answeredAt: null,
    });
  }
  const ids = questions.flatMap((question) => (question.id === null ? [] : [question.id]));
  return new Set(ids).size === ids.length ? questions : null;
};

/** A bounded accumulator called by the existing rollout parser; it never opens another file. */
export const createCodexWorkObserver = () => {
  let observation: CodexWorkObservation | null = null;
  const acceptsOutput = (prefix: string): boolean => {
    if (!OUTPUT_TYPE.test(prefix)) {
      return false;
    }
    const callId = prefix.match(CALL_ID)?.[1];
    return callId !== undefined && Boolean(observation?.requests.some((request) => request.callId === callId));
  };

  /** A recognizable native signal with no usable date is loss, not a dated request or answer. */
  const rejectUndated = (event: Record<string, unknown>, owned: boolean): void => {
    if (observation === null || !owned || event.type !== 'response_item' || !isRecord(event.payload)) {
      return;
    }
    const payload = event.payload;
    const request =
      inputTool(payload.name) !== null && (payload.type === 'function_call' || payload.type === 'custom_tool_call');
    const linkedOutput =
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
      observation.requests.some((candidate) => candidate.callId === payload.call_id);
    if (request || linkedOutput) {
      observation = { ...observation, rejectedRecords: observation.rejectedRecords + 1 };
    }
  };

  const visit = (event: Record<string, unknown>, date: Date, owned: boolean): void => {
    const payload = isRecord(event.payload) ? event.payload : {};
    const at = canonicalInstantFromDate(date);
    if (event.type === 'session_meta' && observation === null) {
      const sourceSessionId = identifier(payload.id);
      if (sourceSessionId === null) {
        return;
      }
      observation = {
        format: 'codex-work-v1',
        sourceSessionId,
        originator: metadataText(payload.originator),
        source: metadataText(isRecord(payload.source) ? JSON.stringify(payload.source) : payload.source),
        threadSource: metadataText(payload.thread_source),
        forkedFromId:
          identifier(payload.forked_from_id) ??
          identifier(payload.forked_from) ??
          identifier(payload.forked_from_thread_id),
        lastEventAt: at,
        latestUserMessageAt: null,
        requests: [],
        omittedRequests: 0,
        rejectedRecords: 0,
      };
    }
    if (observation === null || !owned) {
      return;
    }
    observation = { ...observation, lastEventAt: at > observation.lastEventAt ? at : observation.lastEventAt };
    if (
      (event.type === 'response_item' && payload.type === 'message' && payload.role === 'user') ||
      (event.type === 'event_msg' && payload.type === 'user_message')
    ) {
      observation = {
        ...observation,
        latestUserMessageAt:
          observation.latestUserMessageAt === null || at > observation.latestUserMessageAt
            ? at
            : observation.latestUserMessageAt,
      };
    }
    if (event.type !== 'response_item') {
      return;
    }
    const tool = inputTool(payload.name);
    if (tool !== null && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
      const callId = identifier(payload.call_id);
      const questions = questionsFrom(decode(payload.arguments ?? payload.input), tool);
      if (callId === null || questions === null) {
        observation = { ...observation, rejectedRecords: observation.rejectedRecords + 1 };
        return;
      }
      if (observation.requests.some((candidate) => candidate.callId === callId)) {
        return;
      }
      const requests = [
        ...observation.requests,
        { callId, tool, askedAt: at, acknowledgedAt: null, rejectedAt: null, questions },
      ];
      const omitted = Math.max(0, requests.length - CODEX_WORK_BOUNDS.maxRequests);
      observation = {
        ...observation,
        requests: requests.slice(-CODEX_WORK_BOUNDS.maxRequests),
        omittedRequests: observation.omittedRequests + omitted,
      };
      return;
    }
    if (payload.type !== 'function_call_output' && payload.type !== 'custom_tool_call_output') {
      return;
    }
    const request = observation.requests.find((candidate) => candidate.callId === payload.call_id);
    if (request === undefined || at < request.askedAt) {
      return;
    }
    const output = decode(payload.output);
    let next = request;
    // Only the installed synchronous protocol maps question ids to answers. An async accepted
    // receipt, a plain later user message, and task completion establish no answer identities.
    if (request.tool === 'request_user_input' && isRecord(output) && isRecord(output.answers)) {
      const answers = output.answers;
      const questions = request.questions.map((question) => {
        const answer = question.id === null ? null : answers[question.id];
        const answered =
          isRecord(answer) &&
          Array.isArray(answer.answers) &&
          answer.answers.length > 0 &&
          answer.answers.every((text) => typeof text === 'string' && text.trim().length > 0);
        return answered ? { ...question, answeredAt: at } : question;
      });
      if (questions.some((question) => question.answeredAt !== null)) {
        next = { ...request, acknowledgedAt: request.acknowledgedAt ?? at, rejectedAt: null, questions };
      }
    } else if (isRecord(output) && output.accepted === true) {
      next = { ...request, acknowledgedAt: request.acknowledgedAt ?? at, rejectedAt: null };
    } else if (
      request.acknowledgedAt === null &&
      ((isRecord(output) && typeof output.error === 'string' && output.error.trim().length > 0) ||
        (typeof payload.output === 'string' && UNAVAILABLE_INPUT_TOOL.test(payload.output.trim())))
    ) {
      next = { ...request, rejectedAt: at };
    }
    observation = {
      ...observation,
      requests: observation.requests.map((candidate) => (candidate === request ? next : candidate)),
    };
  };
  return { acceptsOutput, rejectUndated, visit, snapshot: () => observation };
};
