import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import type {
  SessionDetail,
  SessionDetailInterval,
  SessionDetailPhase,
  SessionDetailPrompt,
  SessionDetailTokenCounts,
  SessionDetailTurn,
  SessionProjectionFacts,
} from '@ai-usage/report-core/session-detail';
import {
  compactSessionVcsBranchObservations,
  normalizeSessionVcsPullRequests,
  parseSessionVcsContext,
  type SessionVcsContext,
  type SessionVcsPullRequest,
  type SessionVcsRepository,
} from '@ai-usage/report-core/session-vcs';
import type { UsageModelSegment } from '@ai-usage/report-core/types';
import { addNonNegativeSafeIntegers, parseOptionalNonNegativeSafeInteger } from './metric-validation';
import { dominant, usablePrompt } from './text';

const MAX_CLAUDE_RECORDS = 100_000;
const MAX_CLAUDE_GRAPH_DEPTH = 64;
const MAX_CLAUDE_PROMPTS = 256;
const MAX_CLAUDE_PROMPT_BYTES = 32 * 1024;
const MAX_CLAUDE_PROMPT_TOTAL_BYTES = 1024 * 1024;
const MAX_CLAUDE_TURNS = 1024;
const TRAILING_REPLACEMENT_CHARACTER = /\uFFFD$/u;

export interface ClaudeSessionInput {
  isAgentFile?: boolean;
  records: readonly unknown[];
  repository: SessionVcsRepository | null;
  sourceSessionId: string;
}

export interface ClaudeReportFacts {
  calls: number;
  end: Date;
  firstPrompt: string | null;
  model: string;
  modelSegments: UsageModelSegment[];
  models: string[];
  name: string;
  rejectedMetricRecords: number;
  sidechain: boolean;
  start: Date;
  titleSource: 'agent-role' | 'ai' | 'first-prompt' | 'id';
  tokens: { cr: number; cw: number; in: number; out: number };
  tools: number;
  turns: number;
}

export interface ClaudeSourceFacts {
  parentSourceSessionId: string | null;
  sourcePath: string | null;
  vcs?: SessionVcsContext;
}

export interface ClaudeSessionFacts {
  detailFacts: SessionDetail;
  projection: SessionProjectionFacts;
  report: ClaudeReportFacts;
  source: ClaudeSourceFacts;
}

interface ClaudeEvent {
  at: Date;
  index: number;
  parentUuid: string | null;
  record: Record<string, unknown>;
  uuid: string | null;
}

interface MutableTurn {
  assistants: ClaudeAssistant[];
  durationIntervals: SessionDetailInterval[];
  end: Date;
  prompt: SessionDetailPrompt | null;
  start: Date;
  timingRejected: boolean;
}

interface ClaudeAssistant {
  at: Date;
  model: string;
  tokens: SessionDetailTokenCounts;
  tools: number;
  uuid: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const eventDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
};

const iso = (date: Date): string => date.toISOString();

const emptyTokens = (): SessionDetailTokenCounts => ({
  cacheRead: 0,
  cacheWrite: 0,
  input: 0,
  output: 0,
  total: 0,
});

const addTokens = (target: SessionDetailTokenCounts, delta: SessionDetailTokenCounts): boolean => {
  const cacheRead = addNonNegativeSafeIntegers(target.cacheRead, delta.cacheRead);
  const cacheWrite = addNonNegativeSafeIntegers(target.cacheWrite, delta.cacheWrite);
  const input = addNonNegativeSafeIntegers(target.input, delta.input);
  const output = addNonNegativeSafeIntegers(target.output, delta.output);
  const total = addNonNegativeSafeIntegers(target.total, delta.total);
  if (!(cacheRead.ok && cacheWrite.ok && input.ok && output.ok && total.ok)) {
    return false;
  }
  target.cacheRead = cacheRead.value;
  target.cacheWrite = cacheWrite.value;
  target.input = input.value;
  target.output = output.value;
  target.total = total.value;
  return true;
};

const parseUsage = (value: unknown): SessionDetailTokenCounts | null => {
  if (!isRecord(value)) {
    return null;
  }
  const input = parseOptionalNonNegativeSafeInteger(value.input_tokens);
  const output = parseOptionalNonNegativeSafeInteger(value.output_tokens);
  const cacheRead = parseOptionalNonNegativeSafeInteger(value.cache_read_input_tokens);
  const cacheWrite = parseOptionalNonNegativeSafeInteger(value.cache_creation_input_tokens);
  if (!(input.ok && output.ok && cacheRead.ok && cacheWrite.ok)) {
    return null;
  }
  const total = input.value + output.value + cacheRead.value + cacheWrite.value;
  if (!Number.isSafeInteger(total)) {
    return null;
  }
  return {
    cacheRead: cacheRead.value,
    cacheWrite: cacheWrite.value,
    input: input.value,
    output: output.value,
    total,
  };
};

const blockType = (value: unknown): string | null =>
  isRecord(value) && typeof value.type === 'string' ? value.type : null;

const humanPromptText = (message: unknown): string | null => {
  if (!isRecord(message) || (message.role !== undefined && message.role !== 'user')) {
    return null;
  }
  const { content } = message;
  if (typeof content === 'string') {
    return usablePrompt(content);
  }
  if (!Array.isArray(content) || content.some((block) => blockType(block) === 'tool_result')) {
    return null;
  }
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      const prompt = usablePrompt(block.text);
      if (prompt) {
        return prompt;
      }
    }
  }
  return null;
};

const boundedPrompt = (
  text: string,
  remainingBytes: number,
): { text: string; truncated: boolean; usedBytes: number } | null => {
  if (remainingBytes <= 0) {
    return null;
  }
  const bytes = Buffer.from(text, 'utf8');
  const maximumBytes = Math.min(MAX_CLAUDE_PROMPT_BYTES, remainingBytes);
  const truncated = bytes.byteLength > maximumBytes;
  const bounded = truncated
    ? bytes.subarray(0, maximumBytes).toString('utf8').replace(TRAILING_REPLACEMENT_CHARACTER, '')
    : text;
  return { text: bounded, truncated, usedBytes: Buffer.byteLength(bounded, 'utf8') };
};

const intervalUnionMs = (intervals: readonly SessionDetailInterval[]): number => {
  const ordered = intervals
    .map((interval) => ({ end: Date.parse(interval.endAt), start: Date.parse(interval.startAt) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const interval of ordered) {
    if (start === null || end === null) {
      start = interval.start;
      end = interval.end;
    } else if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return start === null || end === null ? total : total + end - start;
};

const findAncestor = (
  startUuid: string | null,
  parents: ReadonlyMap<string, string | null>,
  candidates: ReadonlySet<string>,
): { cycleOrDepth: boolean; uuid: string | null } => {
  let current = startUuid;
  const seen = new Set<string>();
  for (let depth = 0; current && depth < MAX_CLAUDE_GRAPH_DEPTH; depth += 1) {
    if (candidates.has(current)) {
      return { cycleOrDepth: false, uuid: current };
    }
    if (seen.has(current)) {
      return { cycleOrDepth: true, uuid: null };
    }
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return { cycleOrDepth: current !== null, uuid: null };
};

const modelSegments = (assistants: readonly ClaudeAssistant[]): UsageModelSegment[] => {
  const segments = new Map<string, UsageModelSegment>();
  for (const assistant of assistants) {
    const pricing = priceFor(assistant.model, { at: assistant.at });
    const current = segments.get(assistant.model) ?? {
      costApprox: 0,
      costKnown: true,
      model: assistant.model,
      tokCr: 0,
      tokCw: 0,
      tokIn: 0,
      tokOut: 0,
    };
    current.costApprox += approxCost(pricing.rates, {
      cr: assistant.tokens.cacheRead,
      cw: assistant.tokens.cacheWrite,
      in: assistant.tokens.input,
      out: assistant.tokens.output,
    });
    current.costKnown = current.costKnown && pricing.known;
    current.tokCr += assistant.tokens.cacheRead;
    current.tokCw += assistant.tokens.cacheWrite;
    current.tokIn += assistant.tokens.input;
    current.tokOut += assistant.tokens.output;
    segments.set(assistant.model, current);
  }
  return [...segments.values()];
};

const detailPhases = (assistants: readonly ClaudeAssistant[]): SessionDetailPhase[] => {
  const phases: SessionDetailPhase[] = [];
  for (const assistant of assistants) {
    const pricing = priceFor(assistant.model, { at: assistant.at });
    const cost = approxCost(pricing.rates, {
      cr: assistant.tokens.cacheRead,
      cw: assistant.tokens.cacheWrite,
      in: assistant.tokens.input,
      out: assistant.tokens.output,
    });
    const previous = phases.at(-1);
    if (previous?.model === assistant.model) {
      previous.endAt = iso(assistant.at);
      addTokens(previous.tokens, assistant.tokens);
      previous.cost = previous.cost === null || !pricing.known ? null : previous.cost + cost;
      previous.costKind = previous.cost === null ? 'unknown' : 'approximate';
      continue;
    }
    phases.push({
      cost: pricing.known ? cost : null,
      costKind: pricing.known ? 'approximate' : 'unknown',
      effort: null,
      effortKind: 'unavailable',
      endAt: iso(assistant.at),
      model: assistant.model,
      startAt: iso(assistant.at),
      tokens: { ...assistant.tokens },
    });
  }
  return phases;
};

export const parseClaudeSessionFacts = (input: ClaudeSessionInput): ClaudeSessionFacts | null => {
  if (!input.sourceSessionId || input.records.length > MAX_CLAUDE_RECORDS) {
    return null;
  }
  const events: ClaudeEvent[] = [];
  for (const [index, value] of input.records.entries()) {
    if (!isRecord(value)) {
      continue;
    }
    const at = eventDate(value.timestamp);
    if (!at) {
      continue;
    }
    events.push({
      at,
      index,
      parentUuid: typeof value.parentUuid === 'string' ? value.parentUuid : null,
      record: value,
      uuid: typeof value.uuid === 'string' ? value.uuid : null,
    });
  }
  events.sort((left, right) => left.at.getTime() - right.at.getTime() || left.index - right.index);
  const start = events[0]?.at;
  const end = events.at(-1)?.at;
  if (!(start && end)) {
    return null;
  }

  const parents = new Map<string, string | null>();
  for (const event of events) {
    if (event.uuid) {
      parents.set(event.uuid, event.parentUuid);
    }
  }

  const prompts: SessionDetailPrompt[] = [];
  const promptEvents = new Map<string, ClaudeEvent>();
  let promptBytes = 0;
  let promptsTruncated = false;
  let turnsPartial = false;
  for (const current of events) {
    const record = current.record;
    if (record.type !== 'user' || record.isMeta === true || record.isSynthetic === true) {
      continue;
    }
    const text = humanPromptText(record.message);
    if (!text) {
      continue;
    }
    if (prompts.length >= MAX_CLAUDE_PROMPTS) {
      promptsTruncated = true;
      turnsPartial = true;
      continue;
    }
    const bounded = boundedPrompt(text, MAX_CLAUDE_PROMPT_TOTAL_BYTES - promptBytes);
    if (!bounded) {
      promptsTruncated = true;
      turnsPartial = true;
      continue;
    }
    const id = current.uuid ?? `prompt-${current.index + 1}`;
    prompts.push({ id, text: bounded.text, timestamp: iso(current.at), truncated: bounded.truncated });
    promptBytes += bounded.usedBytes;
    if (bounded.truncated) {
      promptsTruncated = true;
    }
    if (current.uuid) {
      promptEvents.set(current.uuid, current);
    }
  }

  const promptIds = new Set(promptEvents.keys());
  const assistants: ClaudeAssistant[] = [];
  const assistantEvents = new Map<string, ClaudeEvent>();
  const assistantTurnKey = new Map<string, string>();
  const seenUsage = new Set<string>();
  let rejectedMetricRecords = 0;
  for (const current of events) {
    const { record } = current;
    if (record.type !== 'assistant') {
      continue;
    }
    const message = isRecord(record.message) ? record.message : null;
    if (!message?.usage) {
      continue;
    }
    const messageId = typeof message.id === 'string' ? message.id : null;
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    const deduplicationKey = messageId ? `${messageId}:${requestId}` : null;
    if (deduplicationKey && seenUsage.has(deduplicationKey)) {
      continue;
    }
    const tokens = parseUsage(message.usage);
    if (!tokens) {
      rejectedMetricRecords += 1;
      continue;
    }
    if (deduplicationKey) {
      seenUsage.add(deduplicationKey);
    }
    const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : 'unknown';
    const tools = Array.isArray(message.content)
      ? message.content.filter((block) => blockType(block) === 'tool_use').length
      : 0;
    assistants.push({ at: current.at, model, tokens, tools, uuid: current.uuid });
    if (current.uuid) {
      assistantEvents.set(current.uuid, current);
      const ancestor = findAncestor(current.parentUuid, parents, promptIds);
      if (ancestor.cycleOrDepth) {
        turnsPartial = true;
      }
      assistantTurnKey.set(current.uuid, ancestor.uuid ?? `assistant:${current.uuid}`);
    } else {
      turnsPartial = true;
    }
  }
  if (assistants.length === 0 && prompts.length === 0) {
    return null;
  }

  const turnsByKey = new Map<string, MutableTurn>();
  for (const prompt of prompts.slice(0, MAX_CLAUDE_TURNS)) {
    const promptEvent = promptEvents.get(prompt.id);
    const at = promptEvent?.at ?? new Date(prompt.timestamp);
    turnsByKey.set(prompt.id, {
      assistants: [],
      durationIntervals: [],
      end: at,
      prompt,
      start: at,
      timingRejected: false,
    });
  }
  if (prompts.length > MAX_CLAUDE_TURNS) {
    turnsPartial = true;
  }
  for (const assistant of assistants) {
    const key = assistant.uuid
      ? (assistantTurnKey.get(assistant.uuid) ?? `assistant:${assistant.uuid}`)
      : `assistant:${assistants.indexOf(assistant)}`;
    let turn = turnsByKey.get(key);
    if (!turn) {
      if (turnsByKey.size >= MAX_CLAUDE_TURNS) {
        turnsPartial = true;
        continue;
      }
      turn = {
        assistants: [],
        durationIntervals: [],
        end: assistant.at,
        prompt: null,
        start: assistant.at,
        timingRejected: false,
      };
      turnsByKey.set(key, turn);
      turnsPartial = true;
    }
    turn.assistants.push(assistant);
    if (assistant.at < turn.start) {
      turn.start = assistant.at;
    }
    if (assistant.at > turn.end) {
      turn.end = assistant.at;
    }
  }

  const assistantIds = new Set(assistantEvents.keys());
  for (const current of events) {
    if (!(current.record.type === 'system' && current.record.subtype === 'turn_duration')) {
      continue;
    }
    const ancestor = findAncestor(current.parentUuid, parents, assistantIds);
    const key = ancestor.uuid ? assistantTurnKey.get(ancestor.uuid) : null;
    const turn = key ? turnsByKey.get(key) : null;
    const durationMs = current.record.durationMs;
    if (!(turn && Number.isSafeInteger(durationMs) && Number(durationMs) >= 0)) {
      if (turn) {
        turn.timingRejected = true;
      }
      turnsPartial = true;
      continue;
    }
    const intervalStart = new Date(current.at.getTime() - Number(durationMs));
    if (intervalStart < start || current.at > end) {
      turn.timingRejected = true;
      turnsPartial = true;
      continue;
    }
    turn.start = intervalStart < turn.start ? intervalStart : turn.start;
    turn.end = current.at > turn.end ? current.at : turn.end;
    turn.durationIntervals.push({ endAt: iso(current.at), startAt: iso(intervalStart) });
  }

  const detailTurns: SessionDetailTurn[] = [];
  for (const [index, turn] of [...turnsByKey.values()]
    .sort((left, right) => left.start.getTime() - right.start.getTime())
    .entries()) {
    const tokens = emptyTokens();
    let tools = 0;
    for (const assistant of turn.assistants) {
      if (!addTokens(tokens, assistant.tokens)) {
        turnsPartial = true;
      }
      tools += assistant.tools;
    }
    const intervals = turn.timingRejected ? [] : turn.durationIntervals;
    const durationMs = intervals.length > 0 ? intervalUnionMs(intervals) : null;
    detailTurns.push({
      durationMs,
      effort: null,
      effortKind: 'unavailable',
      endAt: iso(turn.end),
      index,
      intervals,
      model: turn.assistants.at(-1)?.model ?? 'unknown',
      promptIds: turn.prompt ? [turn.prompt.id] : [],
      startAt: iso(turn.start),
      timingStatus: durationMs === null ? 'unavailable' : 'recorded',
      tokens,
      tools,
    });
  }

  const recordedTurns = detailTurns.filter((turn) => turn.timingStatus === 'recorded').length;
  const activeDurationMs = recordedTurns > 0 ? intervalUnionMs(detailTurns.flatMap((turn) => turn.intervals)) : null;
  const elapsedDurationMs = end.getTime() - start.getTime();
  let durationStatus: SessionDetail['durationStatus'] = 'partial';
  if (recordedTurns === 0) {
    durationStatus = 'unavailable';
  } else if (recordedTurns === detailTurns.length) {
    durationStatus = 'recorded';
  }
  const idleDurationMs = activeDurationMs === null ? null : Math.max(0, elapsedDurationMs - activeDurationMs);
  const totalTokens = emptyTokens();
  for (const assistant of assistants) {
    if (!addTokens(totalTokens, assistant.tokens)) {
      rejectedMetricRecords += 1;
    }
  }
  const segments = modelSegments(assistants);
  const models = segments.map(({ model }) => model);
  const modelWeights = new Map(
    segments.map((segment) => [segment.model, segment.tokIn + segment.tokOut + segment.tokCr + segment.tokCw]),
  );

  let title: string | null = null;
  let lastPrompt: string | null = null;
  let parentSourceSessionId: string | null = null;
  let sourcePath: string | null = null;
  let sidechain = input.isAgentFile === true;
  const branchObservations: { name: string; observedAt: string | null }[] = [];
  const pullRequestCandidates: SessionVcsPullRequest[] = [];
  let invalidVcs = false;
  for (const current of events) {
    const { record } = current;
    if (input.isAgentFile && typeof record.sessionId === 'string' && record.sessionId !== input.sourceSessionId) {
      parentSourceSessionId = record.sessionId;
    }
    if (record.isSidechain === true) {
      sidechain = true;
    }
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      title = record.aiTitle;
    }
    if (record.type === 'last-prompt' && record.lastPrompt) {
      lastPrompt = String(record.lastPrompt);
    }
    if (typeof record.cwd === 'string') {
      sourcePath = record.cwd;
    }
    if (typeof record.gitBranch === 'string') {
      branchObservations.push({ name: record.gitBranch, observedAt: iso(current.at) });
    } else if (record.gitBranch !== undefined) {
      invalidVcs = true;
    }
    if (record.type === 'pr-link') {
      if (typeof record.prUrl === 'string') {
        pullRequestCandidates.push({
          number: Number.isSafeInteger(record.prNumber) && Number(record.prNumber) > 0 ? Number(record.prNumber) : null,
          observedAt: iso(current.at),
          repository: typeof record.prRepository === 'string' ? record.prRepository : null,
          url: record.prUrl,
        });
      } else {
        invalidVcs = true;
      }
    }
  }
  const compactedBranches = compactSessionVcsBranchObservations(
    branchObservations,
    'harness-recorded',
    input.repository,
  );
  const normalizedPullRequests = normalizeSessionVcsPullRequests(pullRequestCandidates);
  const hasVcs = Boolean(
    input.repository || branchObservations.length > 0 || pullRequestCandidates.length > 0 || invalidVcs,
  );
  const vcs = hasVcs
    ? parseSessionVcsContext({
        branches: compactedBranches.spans,
        headCommit: null,
        partial: invalidVcs || compactedBranches.partial || normalizedPullRequests.partial,
        pullRequests: normalizedPullRequests.pullRequests,
        repository: input.repository,
      })
    : undefined;

  const firstPrompt = prompts[0]?.text ?? null;
  const name =
    title ??
    usablePrompt(lastPrompt) ??
    firstPrompt ??
    `${sidechain ? 'subagent ' : ''}${input.sourceSessionId.slice(0, 8)}`;
  let titleSource: ClaudeReportFacts['titleSource'] = 'id';
  if (title) {
    titleSource = 'ai';
  } else if (sidechain && !lastPrompt && !firstPrompt) {
    titleSource = 'agent-role';
  } else if (lastPrompt || firstPrompt) {
    titleSource = 'first-prompt';
  }
  const tools = assistants.reduce((total, assistant) => total + assistant.tools, 0);
  const projection: SessionProjectionFacts = {
    calls: assistants.length,
    durationMs: activeDurationMs,
    modelSegments: segments
      .map((segment) => ({
        model: segment.model,
        tokens: {
          cacheRead: segment.tokCr,
          cacheWrite: segment.tokCw,
          input: segment.tokIn,
          output: segment.tokOut,
          total: segment.tokCr + segment.tokCw + segment.tokIn + segment.tokOut,
        },
      }))
      .sort((left, right) => left.model.localeCompare(right.model)),
    partial: turnsPartial || promptsTruncated,
    tokens: totalTokens,
    tools,
    turns: prompts.length,
  };
  const detailFacts: SessionDetail = {
    activeDurationMs,
    durationStatus,
    efforts: [],
    elapsedDurationMs,
    endedAt: iso(end),
    idleDurationMs,
    models,
    observedAt: new Date().toISOString(),
    phases: detailPhases(assistants),
    prompts,
    promptsTruncated,
    sourceSessionId: input.sourceSessionId,
    startedAt: iso(start),
    turns: detailTurns,
    turnsStatus: turnsPartial ? 'partial' : 'recorded',
  };
  return {
    detailFacts,
    projection,
    report: {
      calls: assistants.length,
      end,
      firstPrompt,
      model: dominant(modelWeights),
      modelSegments: segments,
      models,
      name,
      rejectedMetricRecords,
      sidechain,
      start,
      titleSource,
      tokens: {
        cr: totalTokens.cacheRead,
        cw: totalTokens.cacheWrite,
        in: totalTokens.input,
        out: totalTokens.output,
      },
      tools,
      turns: prompts.length,
    },
    source: {
      parentSourceSessionId,
      sourcePath,
      ...(vcs ? { vcs } : {}),
    },
  };
};
