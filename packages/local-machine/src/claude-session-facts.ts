import { approxCost, priceFor } from '@ai-usage/report-core/pricing';
import {
  completeCoverage,
  type SessionDetail,
  type SessionDetailChildLink,
  type SessionDetailCoverage,
  type SessionDetailCoverageFact,
  type SessionDetailCoverageReason,
  type SessionDetailInteraction,
  type SessionDetailInterval,
  type SessionDetailPhase,
  type SessionDetailPrompt,
  type SessionDetailTokenCounts,
  type SessionDetailTurn,
  type SessionProjectionFacts,
} from '@ai-usage/report-core/session-detail';
import {
  compactSessionVcsBranchObservations,
  normalizeSessionVcsPullRequests,
  parseSessionVcsContext,
  type SessionVcsContext,
  type SessionVcsPullRequest,
  type SessionVcsRepository,
} from '@ai-usage/report-core/session-vcs';
import {
  MAX_SKILL_OBSERVATIONS_PER_SESSION,
  parseSkillObservation,
  type SkillObservation,
  type SkillObservationExtraction,
} from '@ai-usage/report-core/skill-observation';
import type { UsageModelSegment } from '@ai-usage/report-core/types';
import { addNonNegativeSafeIntegers, parseOptionalNonNegativeSafeInteger } from './metric-validation';
import { dominant, usablePrompt } from './text';

const MAX_CLAUDE_RECORDS = 100_000;
// Prompt identities group activity into rounds, so they share the turn budget.
// Bodies are bounded separately: past the total byte budget an identity is
// kept with an empty body and the omission is reported through coverage.
const MAX_CLAUDE_PROMPTS = 1024;
const MAX_CLAUDE_PROMPT_BYTES = 32 * 1024;
const MAX_CLAUDE_PROMPT_TOTAL_BYTES = 1024 * 1024;
const MAX_CLAUDE_TURNS = 1024;
const MAX_CLAUDE_CHILDREN = 512;
const MAX_CLAUDE_INTERACTIONS = 2048;
const CLAUDE_SPAWN_TOOL_NAMES = new Set(['Agent', 'Task', 'Workflow']);
const CLAUDE_MESSAGE_TOOL_NAME = 'SendMessage';
const CLAUDE_AGENT_SESSION_PREFIX = 'agent-';
const MAX_CLAUDE_LINK_LABEL_LENGTH = 256;
// Nested conflicting records are resolved recursively; past this depth the
// activity stays unattributed rather than risking the call stack.
const MAX_CLAUDE_CONFLICT_DEPTH = 64;

/**
 * The collector names an agent transcript by its file stem, `agent-<id>`, so
 * that is the child session identity a link must carry to join the report row.
 * Tool results and sidecar file names carry the bare id.
 */
export const claudeChildSessionId = (agentId: string): string =>
  agentId.startsWith(CLAUDE_AGENT_SESSION_PREFIX) ? agentId : `${CLAUDE_AGENT_SESSION_PREFIX}${agentId}`;

const boundedLabel = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  return value.length > MAX_CLAUDE_LINK_LABEL_LENGTH ? value.slice(0, MAX_CLAUDE_LINK_LABEL_LENGTH) : value;
};
const TRAILING_REPLACEMENT_CHARACTER = /\uFFFD$/u;

/**
 * One `<session>/subagents/agent-<id>.meta.json` sidecar. It names the agent's
 * type, its task description and the `tool_use` that launched it, so a child
 * stays linked even when the launching tool result was dropped as oversized.
 */
export interface ClaudeAgentMeta {
  agentId: string;
  agentType: string | null;
  description: string | null;
  toolUseId: string | null;
  /** Run id of the Workflow that spawned the agent, when the sidecar lives under `subagents/workflows/<run>/`. */
  workflowRunId: string | null;
}

export interface ClaudeSessionInput {
  agentMetas?: readonly ClaudeAgentMeta[];
  /** Sidecars that existed but could not be read within budget. */
  agentMetasUnreadable?: number;
  isAgentFile?: boolean;
  records: readonly unknown[];
  repository: SessionVcsRepository | null;
  sourceSessionId: string;
}

export interface ClaudeReportFacts {
  calls: number;
  end: Date;
  model: string;
  modelSegments: UsageModelSegment[];
  models: string[];
  name: string;
  rejectedMetricRecords: number;
  sidechain: boolean;
  start: Date;
  titleSource: 'agent-role' | 'ai' | 'id';
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
  key: string;
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

interface ClaudeGraphIndex {
  /** Every parent a conflicting uuid was recorded with, in file order. */
  conflictingParents: ReadonlyMap<string, readonly (string | null)[]>;
  conflictingUuids: ReadonlySet<string>;
  events: ReadonlyMap<string, ClaudeEvent>;
  parents: ReadonlyMap<string, string | null>;
}

interface ClaudePromptFacts {
  bodiesOmitted: number;
  identitiesOmitted: number;
  partial: boolean;
  promptEvents: ReadonlyMap<string, ClaudeEvent>;
  /** Claude's own `promptId` on a prompt record → that prompt's identity here. */
  promptIdsByRecordedId: ReadonlyMap<string, string>;
  prompts: SessionDetailPrompt[];
  promptsTruncated: boolean;
}

interface ClaudeAssistantFacts {
  assistantEvents: ReadonlyMap<string, ClaudeEvent>;
  assistants: ClaudeAssistant[];
  assistantTurnKey: ReadonlyMap<string, string>;
  budgetExhaustions: number;
  cycles: number;
  partial: boolean;
  rejectedMetricRecords: number;
  /** Prompt key of any attributable event, for records the usage pass skipped (streamed duplicates). */
  resolveTurnKey: (event: ClaudeEvent) => string | null;
  unattributed: number;
}

interface ClaudeTurnFacts {
  detailTurns: SessionDetailTurn[];
  partial: boolean;
  turnIndexByKey: ReadonlyMap<string, number>;
}

interface ClaudeToolCall {
  at: Date;
  input: Record<string, unknown>;
  name: string;
  toolUseId: string;
  turnKey: string | null;
}

interface ClaudeLinkFacts {
  children: SessionDetailChildLink[];
  coverage: Pick<SessionDetailCoverage, 'childDiscovery' | 'interactionAttribution'>;
  interactions: SessionDetailInteraction[];
}

interface ClaudeMetadataFacts extends ClaudeSourceFacts {
  sidechain: boolean;
  title: string | null;
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

/**
 * Nearest prompt above an event, resolved with memoisation instead of a depth
 * cap. A round in a long agentic session routinely reaches 150 hops of
 * parentUuid, and the old 64-hop ceiling turned every assistant record past it
 * into its own "turn". Every visited uuid is memoised, so the walk stays linear
 * over the transcript; a cycle or a missing parent resolves to no prompt.
 */
const createPromptResolver = (
  graph: ClaudeGraphIndex,
  promptIds: ReadonlySet<string>,
): { budgetExhaustions: () => number; cycles: () => number; resolve: (startUuid: string | null) => string | null } => {
  const memo = new Map<string, string | null>();
  let cycles = 0;
  let budgetExhaustions = 0;
  const resolve = (startUuid: string | null, visiting = new Set<string>(), depth = 0): string | null => {
    const path: string[] = [];
    let current = startUuid;
    let result: string | null = null;
    while (current) {
      if (promptIds.has(current)) {
        result = current;
        break;
      }
      const memoised = memo.get(current);
      if (memoised !== undefined) {
        result = memoised;
        break;
      }
      if (visiting.has(current)) {
        cycles += 1;
        break;
      }
      visiting.add(current);
      path.push(current);
      const conflicting = graph.conflictingParents.get(current);
      if (conflicting) {
        // Each recorded parent must lead to the same prompt; otherwise the
        // activity below stays unattributed rather than guessing a duplicate.
        if (depth >= MAX_CLAUDE_CONFLICT_DEPTH) {
          budgetExhaustions += 1;
          break;
        }
        const resolved = new Set(conflicting.map((parent) => resolve(parent, visiting, depth + 1)));
        result = resolved.size === 1 ? ([...resolved][0] ?? null) : null;
        break;
      }
      if (!graph.parents.has(current)) {
        break;
      }
      current = graph.parents.get(current) ?? null;
    }
    for (const uuid of path) {
      memo.set(uuid, result);
    }
    return result;
  };
  return {
    budgetExhaustions: () => budgetExhaustions,
    cycles: () => cycles,
    resolve: (startUuid) => resolve(startUuid),
  };
};

/**
 * Claude Code stamps every user record with the `promptId` of the human prompt
 * it belongs to. An assistant record carries none, but its parent (a tool
 * result) does, which recovers the round when an oversized dropped record broke
 * the parentUuid chain.
 */
const recordedPromptIdFor = (event: ClaudeEvent, graph: ClaudeGraphIndex): string | null => {
  const own = event.record.promptId;
  if (typeof own === 'string' && own.length > 0) {
    return own;
  }
  const parent = event.parentUuid ? graph.events.get(event.parentUuid) : undefined;
  const inherited = parent?.record.promptId;
  return typeof inherited === 'string' && inherited.length > 0 ? inherited : null;
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

const parseClaudeEvents = (records: readonly unknown[]): ClaudeEvent[] => {
  const events: ClaudeEvent[] = [];
  for (const [index, value] of records.entries()) {
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
  return events;
};

const createClaudeGraphIndex = (events: readonly ClaudeEvent[]): ClaudeGraphIndex => {
  const parents = new Map<string, string | null>();
  const eventsByUuid = new Map<string, ClaudeEvent>();
  const graphSignatures = new Map<string, string>();
  const conflictingUuids = new Set<string>();
  const conflictingParents = new Map<string, (string | null)[]>();
  for (const event of events) {
    if (!event.uuid) {
      continue;
    }
    const signature = `${String(event.record.type ?? '')}\0${event.parentUuid ?? ''}`;
    const existingSignature = graphSignatures.get(event.uuid);
    if (existingSignature !== undefined && existingSignature !== signature) {
      conflictingUuids.add(event.uuid);
      const recorded = conflictingParents.get(event.uuid) ?? [parents.get(event.uuid) ?? null];
      recorded.push(event.parentUuid);
      conflictingParents.set(event.uuid, recorded);
    } else if (existingSignature === undefined) {
      graphSignatures.set(event.uuid, signature);
      parents.set(event.uuid, event.parentUuid);
      eventsByUuid.set(event.uuid, event);
    }
  }
  // A conflicting uuid (Claude Code re-writes attachment records with a second
  // parent) is not cut out of the graph: that would sever every chain below it
  // and turn the whole round into unattributed activity. The resolver walks
  // each recorded parent and only accepts them when they agree on one prompt;
  // the conflict itself stays visible and keeps such records from owning
  // prompts or usage.
  for (const uuid of conflictingUuids) {
    parents.delete(uuid);
    eventsByUuid.delete(uuid);
  }
  return { conflictingParents, conflictingUuids, events: eventsByUuid, parents };
};

const collectClaudePrompts = (events: readonly ClaudeEvent[], graph: ClaudeGraphIndex): ClaudePromptFacts => {
  const prompts: SessionDetailPrompt[] = [];
  const promptEvents = new Map<string, ClaudeEvent>();
  const promptIdsByRecordedId = new Map<string, string>();
  let promptBytes = 0;
  let promptsTruncated = false;
  let bodiesOmitted = 0;
  let identitiesOmitted = 0;
  let partial = graph.conflictingUuids.size > 0;
  for (const current of events) {
    const { record } = current;
    if (record.type !== 'user' || record.isMeta === true || record.isSynthetic === true) {
      continue;
    }
    const text = humanPromptText(record.message);
    if (!text) {
      continue;
    }
    if (prompts.length >= MAX_CLAUDE_PROMPTS) {
      identitiesOmitted += 1;
      promptsTruncated = true;
      partial = true;
      continue;
    }
    const usableUuid = current.uuid && !graph.conflictingUuids.has(current.uuid) ? current.uuid : null;
    if (usableUuid && promptEvents.has(usableUuid)) {
      partial = true;
      continue;
    }
    const id = usableUuid ?? `prompt-${current.index + 1}`;
    // The identity is kept whatever the body budget says: it is what groups
    // the activity below it into a round. Only the body is subject to bytes.
    const bounded = boundedPrompt(text, MAX_CLAUDE_PROMPT_TOTAL_BYTES - promptBytes);
    if (bounded) {
      prompts.push({ id, text: bounded.text, timestamp: iso(current.at), truncated: bounded.truncated });
      promptBytes += bounded.usedBytes;
      promptsTruncated ||= bounded.truncated;
    } else {
      prompts.push({ id, text: '', timestamp: iso(current.at), truncated: true });
      bodiesOmitted += 1;
      promptsTruncated = true;
    }
    if (usableUuid) {
      promptEvents.set(usableUuid, current);
    }
    if (
      typeof record.promptId === 'string' &&
      record.promptId.length > 0 &&
      !promptIdsByRecordedId.has(record.promptId)
    ) {
      promptIdsByRecordedId.set(record.promptId, id);
    }
  }
  return { bodiesOmitted, identitiesOmitted, partial, promptEvents, promptIdsByRecordedId, prompts, promptsTruncated };
};

const collectClaudeAssistants = (
  events: readonly ClaudeEvent[],
  graph: ClaudeGraphIndex,
  promptFacts: ClaudePromptFacts,
): ClaudeAssistantFacts => {
  const promptIds = new Set(promptFacts.promptEvents.keys());
  const resolver = createPromptResolver(graph, promptIds);
  const assistants: ClaudeAssistant[] = [];
  const assistantEvents = new Map<string, ClaudeEvent>();
  const assistantTurnKey = new Map<string, string>();
  const seenUsage = new Set<string>();
  const seenToolUses = new Set<string>();
  let partial = false;
  let rejectedMetricRecords = 0;
  let unattributed = 0;
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
    // A tool use carries an id; a record that repeats one already counted
    // (a streamed duplicate the usage key did not catch) must not count twice.
    let tools = 0;
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (blockType(block) !== 'tool_use') {
        continue;
      }
      const toolUseId = isRecord(block) && typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
      if (toolUseId !== null) {
        if (seenToolUses.has(toolUseId)) {
          continue;
        }
        seenToolUses.add(toolUseId);
      }
      tools += 1;
    }
    assistants.push({ at: current.at, model, tokens, tools, uuid: current.uuid });
    if (current.uuid && !graph.conflictingUuids.has(current.uuid)) {
      assistantEvents.set(current.uuid, current);
      const key = promptKeyFor(current, graph, resolver.resolve, promptFacts.promptIdsByRecordedId);
      if (key === null) {
        unattributed += 1;
        partial = true;
      }
      assistantTurnKey.set(current.uuid, key ?? `assistant:${current.uuid}`);
    } else {
      partial = true;
    }
  }
  return {
    assistantEvents,
    assistants,
    assistantTurnKey,
    budgetExhaustions: resolver.budgetExhaustions(),
    cycles: resolver.cycles(),
    partial: partial || resolver.cycles() > 0 || resolver.budgetExhaustions() > 0,
    rejectedMetricRecords,
    resolveTurnKey: (event) => promptKeyFor(event, graph, resolver.resolve, promptFacts.promptIdsByRecordedId),
    unattributed,
  };
};

/** Ancestry first; Claude's own `promptId` stamp second, for records whose chain was broken. */
const promptKeyFor = (
  event: ClaudeEvent,
  graph: ClaudeGraphIndex,
  resolve: (startUuid: string | null) => string | null,
  promptIdsByRecordedId: ReadonlyMap<string, string>,
): string | null => {
  const ancestor = resolve(event.parentUuid);
  if (ancestor) {
    return ancestor;
  }
  const recorded = recordedPromptIdFor(event, graph);
  return recorded ? (promptIdsByRecordedId.get(recorded) ?? null) : null;
};

const createClaudeTurns = (
  prompts: readonly SessionDetailPrompt[],
  promptEvents: ReadonlyMap<string, ClaudeEvent>,
  assistants: readonly ClaudeAssistant[],
  assistantTurnKey: ReadonlyMap<string, string>,
): { partial: boolean; turnsByKey: Map<string, MutableTurn> } => {
  const turnsByKey = new Map<string, MutableTurn>();
  let partial = prompts.length > MAX_CLAUDE_TURNS;
  for (const prompt of prompts.slice(0, MAX_CLAUDE_TURNS)) {
    const promptEvent = promptEvents.get(prompt.id);
    const at = promptEvent?.at ?? new Date(prompt.timestamp);
    turnsByKey.set(prompt.id, {
      assistants: [],
      durationIntervals: [],
      end: at,
      key: prompt.id,
      prompt,
      start: at,
      timingRejected: false,
    });
  }
  for (const [assistantIndex, assistant] of assistants.entries()) {
    const key = assistant.uuid
      ? (assistantTurnKey.get(assistant.uuid) ?? `assistant:${assistant.uuid}`)
      : `assistant:${assistantIndex}`;
    let turn = turnsByKey.get(key);
    if (!turn) {
      if (turnsByKey.size >= MAX_CLAUDE_TURNS) {
        partial = true;
        continue;
      }
      turn = {
        assistants: [],
        durationIntervals: [],
        end: assistant.at,
        key,
        prompt: null,
        start: assistant.at,
        timingRejected: false,
      };
      turnsByKey.set(key, turn);
      partial = true;
    }
    turn.assistants.push(assistant);
    turn.start = assistant.at < turn.start ? assistant.at : turn.start;
    turn.end = assistant.at > turn.end ? assistant.at : turn.end;
  }
  return { partial, turnsByKey };
};

/**
 * A round's observed span ends with the last record attributable to it, tool
 * results included: an assistant call that ran a long tool ends when the
 * result came back, not when the request went out.
 */
const extendClaudeTurnBounds = (
  events: readonly ClaudeEvent[],
  assistantTurnKey: ReadonlyMap<string, string>,
  turnsByKey: ReadonlyMap<string, MutableTurn>,
): void => {
  for (const current of events) {
    if (current.record.type !== 'user' || !current.parentUuid) {
      continue;
    }
    const message = isRecord(current.record.message) ? current.record.message : null;
    const content = message?.content;
    if (!(Array.isArray(content) && content.some((block) => blockType(block) === 'tool_result'))) {
      continue;
    }
    const key = assistantTurnKey.get(current.parentUuid);
    const turn = key ? turnsByKey.get(key) : undefined;
    if (turn && current.at > turn.end) {
      turn.end = current.at;
    }
  }
};

const applyClaudeTurnDurations = (
  events: readonly ClaudeEvent[],
  graph: ClaudeGraphIndex,
  assistantEvents: ReadonlyMap<string, ClaudeEvent>,
  assistantTurnKey: ReadonlyMap<string, string>,
  turnsByKey: ReadonlyMap<string, MutableTurn>,
  sessionStart: Date,
  sessionEnd: Date,
): boolean => {
  const assistantIds = new Set(assistantEvents.keys());
  const resolver = createPromptResolver(graph, assistantIds);
  let partial = false;
  for (const current of events) {
    if (!(current.record.type === 'system' && current.record.subtype === 'turn_duration')) {
      continue;
    }
    const ancestor = resolver.resolve(current.parentUuid);
    const key = ancestor ? assistantTurnKey.get(ancestor) : null;
    const turn = key ? turnsByKey.get(key) : null;
    const durationMs = current.record.durationMs;
    const hasLaterAssistant = turn?.assistants.some((assistant) => assistant.at > current.at) ?? false;
    if (!(turn && Number.isSafeInteger(durationMs) && Number(durationMs) > 0 && !hasLaterAssistant)) {
      if (turn) {
        turn.timingRejected = true;
      }
      partial = true;
      continue;
    }
    const intervalStart = new Date(current.at.getTime() - Number(durationMs));
    if (intervalStart < sessionStart || current.at > sessionEnd) {
      turn.timingRejected = true;
      partial = true;
      continue;
    }
    turn.start = intervalStart < turn.start ? intervalStart : turn.start;
    turn.end = current.at > turn.end ? current.at : turn.end;
    turn.durationIntervals.push({ endAt: iso(current.at), startAt: iso(intervalStart) });
  }
  return partial;
};

const turnCost = (assistants: readonly ClaudeAssistant[]): { cost: number | null; known: boolean } => {
  let cost = 0;
  let known = true;
  for (const assistant of assistants) {
    const pricing = priceFor(assistant.model, { at: assistant.at });
    known &&= pricing.known || assistant.tokens.total === 0;
    cost += approxCost(pricing.rates, {
      cr: assistant.tokens.cacheRead,
      cw: assistant.tokens.cacheWrite,
      in: assistant.tokens.input,
      out: assistant.tokens.output,
    });
  }
  return known ? { cost, known } : { cost: null, known };
};

const serializeClaudeTurns = (turnsByKey: ReadonlyMap<string, MutableTurn>): ClaudeTurnFacts => {
  const detailTurns: SessionDetailTurn[] = [];
  const turnIndexByKey = new Map<string, number>();
  let partial = false;
  const orderedTurns = [...turnsByKey.values()].sort((left, right) => left.start.getTime() - right.start.getTime());
  for (const [index, turn] of orderedTurns.entries()) {
    const tokens = emptyTokens();
    let tools = 0;
    for (const assistant of turn.assistants) {
      partial ||= !addTokens(tokens, assistant.tokens);
      tools += assistant.tools;
    }
    const intervals = turn.timingRejected ? [] : turn.durationIntervals;
    const durationMs = intervals.length > 0 ? intervalUnionMs(intervals) : null;
    const pricing = turnCost(turn.assistants);
    turnIndexByKey.set(turn.key, index);
    detailTurns.push({
      calls: turn.assistants.length,
      cost: pricing.cost,
      costKind: pricing.cost === null ? 'unknown' : 'approximate',
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
  return { detailTurns, partial, turnIndexByKey };
};

const stringInput = (input: Record<string, unknown>, key: string): string | null => {
  const value = input[key];
  return boundedLabel(typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);
};

/**
 * Sub-agent launches (`Task`/`Agent`) and follow-up messages (`SendMessage`)
 * as the assistant issued them, each keyed to the turn of the assistant record
 * that carried the call.
 */
const collectClaudeToolCalls = (
  events: readonly ClaudeEvent[],
  graph: ClaudeGraphIndex,
  assistantTurnKey: ReadonlyMap<string, string>,
  resolveTurnKey: (event: ClaudeEvent) => string | null,
): ClaudeToolCall[] => {
  const calls: ClaudeToolCall[] = [];
  const seenToolUses = new Set<string>();
  for (const current of events) {
    if (current.record.type !== 'assistant') {
      continue;
    }
    const message = isRecord(current.record.message) ? current.record.message : null;
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    // A streamed message is written as several records sharing one message id;
    // the usage pass keeps the first, so a later record carrying the tool_use
    // block resolves its round through ancestry instead.
    const attributable = current.uuid && !graph.conflictingUuids.has(current.uuid);
    const turnKey =
      attributable && current.uuid ? (assistantTurnKey.get(current.uuid) ?? resolveTurnKey(current)) : null;
    for (const block of content) {
      if (!(isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string')) {
        continue;
      }
      if (!(CLAUDE_SPAWN_TOOL_NAMES.has(block.name) || block.name === CLAUDE_MESSAGE_TOOL_NAME)) {
        continue;
      }
      const toolUseId = typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
      // A streamed message repeats its blocks across records; one tool use is one call.
      if (!toolUseId || seenToolUses.has(toolUseId)) {
        continue;
      }
      seenToolUses.add(toolUseId);
      calls.push({
        at: current.at,
        input: isRecord(block.input) ? block.input : {},
        name: block.name,
        toolUseId,
        turnKey,
      });
    }
  }
  return calls;
};

interface ClaudeSpawnResults {
  /** `toolUseResult.agentId` of the tool result that answered a Task/Agent launch. */
  agentIdsByToolUse: ReadonlyMap<string, string>;
  /** `toolUseResult.runId` of the tool result that answered a Workflow launch. */
  workflowRunsByToolUse: ReadonlyMap<string, string>;
}

const collectClaudeSpawnResults = (events: readonly ClaudeEvent[]): ClaudeSpawnResults => {
  const agentIdsByToolUse = new Map<string, string>();
  const workflowRunsByToolUse = new Map<string, string>();
  for (const current of events) {
    if (current.record.type !== 'user') {
      continue;
    }
    const toolUseResult = isRecord(current.record.toolUseResult) ? current.record.toolUseResult : null;
    const agentId = optionalRecordString(toolUseResult, 'agentId');
    const runId = optionalRecordString(toolUseResult, 'runId');
    if (!(agentId || runId)) {
      continue;
    }
    const message = isRecord(current.record.message) ? current.record.message : null;
    const content = message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (!(isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string')) {
        continue;
      }
      if (agentId) {
        agentIdsByToolUse.set(block.tool_use_id, agentId);
      }
      if (runId) {
        workflowRunsByToolUse.set(block.tool_use_id, runId);
      }
    }
  }
  return { agentIdsByToolUse, workflowRunsByToolUse };
};

const optionalRecordString = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const collectClaudeLinks = (
  events: readonly ClaudeEvent[],
  graph: ClaudeGraphIndex,
  assistantFacts: ClaudeAssistantFacts,
  turnIndexByKey: ReadonlyMap<string, number>,
  input: ClaudeSessionInput,
): ClaudeLinkFacts => {
  const calls = collectClaudeToolCalls(events, graph, assistantFacts.assistantTurnKey, assistantFacts.resolveTurnKey);
  const spawnResults = collectClaudeSpawnResults(events);
  const metasByToolUse = new Map<string, ClaudeAgentMeta>();
  const metasByAgent = new Map<string, ClaudeAgentMeta>();
  const metasByWorkflowRun = new Map<string, ClaudeAgentMeta[]>();
  for (const meta of input.agentMetas ?? []) {
    metasByAgent.set(meta.agentId, meta);
    if (meta.toolUseId) {
      metasByToolUse.set(meta.toolUseId, meta);
    }
    if (meta.workflowRunId) {
      const run = metasByWorkflowRun.get(meta.workflowRunId) ?? [];
      run.push(meta);
      metasByWorkflowRun.set(meta.workflowRunId, run);
    }
  }
  const children = new Map<string, SessionDetailChildLink>();
  const interactions: SessionDetailInteraction[] = [];
  let resultsMissing = 0;
  let unattributedInteractions = 0;
  let interactionsOmitted = 0;
  const childFor = (
    agentId: string,
    evidence: SessionDetailChildLink['evidence'],
    label: string | null,
    agentType: string | null,
    turnIndex: number | null,
  ): void => {
    const meta = metasByAgent.get(agentId);
    const sourceSessionId = claudeChildSessionId(agentId);
    const boundedLabelValue = boundedLabel(label ?? meta?.description ?? null);
    const boundedAgentType = boundedLabel(agentType ?? meta?.agentType ?? null);
    const existing = children.get(sourceSessionId);
    if (existing) {
      if (existing.spawnTurnIndex === null && turnIndex !== null) {
        existing.spawnTurnIndex = turnIndex;
      }
      existing.label ??= boundedLabelValue;
      existing.agentType ??= boundedAgentType;
      return;
    }
    children.set(sourceSessionId, {
      agentType: boundedAgentType,
      evidence,
      label: boundedLabelValue,
      sourceSessionId,
      spawnTurnIndex: turnIndex,
    });
  };
  for (const call of calls) {
    const turnIndex = call.turnKey === null ? null : (turnIndexByKey.get(call.turnKey) ?? null);
    const isSpawn = CLAUDE_SPAWN_TOOL_NAMES.has(call.name);
    const label = isSpawn ? stringInput(call.input, 'description') : stringInput(call.input, 'summary');
    let agentId: string | null;
    if (call.name === 'Workflow') {
      // One Workflow call fans out to many agents; the run id in its result
      // names the sidecar directory that lists them, so each child links to
      // this round while the interaction itself names no single child.
      agentId = null;
      const runId = spawnResults.workflowRunsByToolUse.get(call.toolUseId) ?? null;
      const runMetas = runId ? (metasByWorkflowRun.get(runId) ?? []) : [];
      if (runMetas.length === 0) {
        resultsMissing += 1;
      }
      for (const meta of runMetas) {
        childFor(meta.agentId, 'claude-agent-meta', meta.description, meta.agentType, turnIndex);
      }
    } else if (isSpawn) {
      agentId =
        spawnResults.agentIdsByToolUse.get(call.toolUseId) ?? metasByToolUse.get(call.toolUseId)?.agentId ?? null;
      if (agentId === null) {
        resultsMissing += 1;
      } else {
        childFor(
          agentId,
          spawnResults.agentIdsByToolUse.has(call.toolUseId) ? 'claude-agent-link' : 'claude-agent-meta',
          label,
          stringInput(call.input, 'subagent_type'),
          turnIndex,
        );
      }
    } else {
      agentId = stringInput(call.input, 'to');
      if (agentId !== null) {
        // A message names the agent it reaches; the launch that created it may
        // sit in an earlier, possibly dropped, record. The child exists either way.
        childFor(agentId, 'claude-agent-link', null, null, null);
      }
    }
    if (turnIndex === null) {
      unattributedInteractions += 1;
    }
    if (interactions.length >= MAX_CLAUDE_INTERACTIONS) {
      interactionsOmitted += 1;
      continue;
    }
    interactions.push({
      at: iso(call.at),
      childSourceSessionId: agentId === null ? null : claudeChildSessionId(agentId),
      kind: isSpawn ? 'spawn' : 'message',
      label,
      toolUseId: call.toolUseId,
      turnIndex,
    });
  }
  // Sidecars name children whose launch record never survived at all.
  for (const meta of metasByAgent.values()) {
    if (!children.has(claudeChildSessionId(meta.agentId))) {
      childFor(meta.agentId, 'claude-agent-meta', meta.description, meta.agentType, null);
    }
  }
  const orderedChildren = [...children.values()];
  const retainedChildren = orderedChildren.slice(0, MAX_CLAUDE_CHILDREN);
  const retainedIds = new Set(retainedChildren.map(({ sourceSessionId }) => sourceSessionId));
  for (const interaction of interactions) {
    if (interaction.childSourceSessionId !== null && !retainedIds.has(interaction.childSourceSessionId)) {
      interaction.childSourceSessionId = null;
    }
  }
  const childReasons: SessionDetailCoverageReason[] = [];
  const metasUnreadable = input.agentMetasUnreadable ?? 0;
  if (resultsMissing > 0) {
    childReasons.push('child-result-missing');
  }
  if (metasUnreadable > 0) {
    childReasons.push('child-metadata-unreadable');
  }
  if (orderedChildren.length > retainedChildren.length) {
    childReasons.push('child-budget');
  }
  const childDiscovery: SessionDetailCoverageFact =
    childReasons.length === 0
      ? completeCoverage()
      : {
          omittedCount: resultsMissing + metasUnreadable + (orderedChildren.length - retainedChildren.length),
          reasons: childReasons,
          status: 'partial',
        };
  const interactionReasons: SessionDetailCoverageReason[] = [];
  if (unattributedInteractions > 0) {
    interactionReasons.push('unattributed-activity');
  }
  if (interactionsOmitted > 0) {
    interactionReasons.push('interaction-budget');
  }
  const interactionAttribution: SessionDetailCoverageFact =
    interactionReasons.length === 0
      ? completeCoverage()
      : { omittedCount: interactionsOmitted, reasons: interactionReasons, status: 'partial' };
  return { children: retainedChildren, coverage: { childDiscovery, interactionAttribution }, interactions };
};

const collectClaudeMetadata = (events: readonly ClaudeEvent[], input: ClaudeSessionInput): ClaudeMetadataFacts => {
  let title: string | null = null;
  let parentSourceSessionId: string | null = null;
  let sourcePath: string | null = null;
  let sidechain = input.isAgentFile === true;
  const observedSourcePaths = new Set<string>();
  const branchObservations: { name: string; observedAt: string | null }[] = [];
  const pullRequestCandidates: SessionVcsPullRequest[] = [];
  let invalidVcs = false;
  for (const current of events) {
    const { record } = current;
    if (input.isAgentFile && typeof record.sessionId === 'string' && record.sessionId !== input.sourceSessionId) {
      parentSourceSessionId = record.sessionId;
    }
    sidechain ||= record.isSidechain === true;
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
      title = record.aiTitle;
    }
    if (typeof record.cwd === 'string') {
      sourcePath = record.cwd;
      observedSourcePaths.add(record.cwd);
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
  const hasMultipleSourcePaths = observedSourcePaths.size > 1;
  const compactedBranches = compactSessionVcsBranchObservations(
    branchObservations,
    'harness-recorded',
    hasMultipleSourcePaths ? null : input.repository,
  );
  const normalizedPullRequests = normalizeSessionVcsPullRequests(pullRequestCandidates);
  const hasVcs = Boolean(
    input.repository || branchObservations.length > 0 || pullRequestCandidates.length > 0 || invalidVcs,
  );
  const vcs = hasVcs
    ? parseSessionVcsContext({
        branches: compactedBranches.spans,
        headCommit: null,
        partial: invalidVcs || hasMultipleSourcePaths || compactedBranches.partial || normalizedPullRequests.partial,
        pullRequests: normalizedPullRequests.pullRequests,
        repository: input.repository,
      })
    : undefined;
  return { parentSourceSessionId, sidechain, sourcePath, title, ...(vcs ? { vcs } : {}) };
};

/**
 * Claude Code writes the resolved skill directory as injected prompt text a
 * couple of envelopes after the `Skill` tool call. That string is prompt text,
 * not a contract, so the scan is bounded: measured over real local history,
 * every resolvable invocation but one lands within three envelopes, and a miss
 * past the bound is recorded as an unresolved observation rather than an error
 * (ADR 0022 — unresolvable is a state, not a drop).
 */
export const CLAUDE_SKILL_LOOKAHEAD_ENVELOPES = 3;

/**
 * Testing override for the per-session observation ceiling, mirroring the
 * OpenCode read-budget seam. The production ceiling guards a corrupt transcript
 * rather than ordinary volume, so exercising it honestly would mean building
 * 4096 calls; lowering it keeps the test about the behaviour.
 */
let claudeSkillCeilingOverride: number | null = null;

export const setClaudeSkillObservationCeilingForTesting = (ceiling: number | null): void => {
  if (ceiling !== null && !(Number.isSafeInteger(ceiling) && ceiling > 0)) {
    throw new Error('Claude skill observation ceiling override must be a positive safe integer or null');
  }
  claudeSkillCeilingOverride = ceiling;
};

export const claudeSkillObservationCeiling = (): number =>
  claudeSkillCeilingOverride ?? MAX_SKILL_OBSERVATIONS_PER_SESSION;

const CLAUDE_SKILL_TOOL_NAME = 'Skill';
const CLAUDE_SKILL_BASE_DIRECTORY = /^Base directory for this skill:[ \t]*(\S.*)$/m;

export interface ClaudeSkillObservationInput {
  records: readonly unknown[];
  sourceSessionId: string;
}

interface ClaudeSkillLookahead {
  resolvedPath: string | null;
  success: boolean | null;
}

const claudeTextBlocks = (record: Record<string, unknown>): string[] => {
  const message = isRecord(record.message) ? record.message : null;
  const { content } = message ?? {};
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts;
};

const claudeReferencesToolUse = (record: Record<string, unknown>, toolUseId: string | null): boolean => {
  if (!toolUseId) {
    return true;
  }
  if (record.sourceToolUseID === toolUseId || record.sourceToolAssistantUUID === toolUseId) {
    return true;
  }
  const message = isRecord(record.message) ? record.message : null;
  const { content } = message ?? {};
  if (!Array.isArray(content)) {
    // The envelope names no tool use at all; positional adjacency is the only
    // available link, so it stays a candidate within the bounded window.
    return record.sourceToolUseID === undefined;
  }
  return content.some((block) => isRecord(block) && block.tool_use_id === toolUseId);
};

/**
 * Scan forward a bounded number of envelopes for the two facts Claude Code
 * records *after* the call: the success flag and the resolved base directory.
 * Envelopes that name a different tool use are skipped, never consumed.
 */
const claudeSkillLookahead = (
  records: readonly unknown[],
  fromIndex: number,
  toolUseId: string | null,
): ClaudeSkillLookahead => {
  let resolvedPath: string | null = null;
  let success: boolean | null = null;
  const limit = Math.min(records.length, fromIndex + 1 + CLAUDE_SKILL_LOOKAHEAD_ENVELOPES);
  for (let index = fromIndex + 1; index < limit; index += 1) {
    const record = records[index];
    if (!(isRecord(record) && claudeReferencesToolUse(record, toolUseId))) {
      continue;
    }
    const toolUseResult = isRecord(record.toolUseResult) ? record.toolUseResult : null;
    if (success === null && typeof toolUseResult?.success === 'boolean') {
      success = toolUseResult.success;
    }
    if (resolvedPath === null) {
      for (const text of claudeTextBlocks(record)) {
        const matched = CLAUDE_SKILL_BASE_DIRECTORY.exec(text);
        if (matched?.[1]) {
          resolvedPath = matched[1].trim();
          break;
        }
      }
    }
    if (resolvedPath !== null && success !== null) {
      break;
    }
  }
  return { resolvedPath, success };
};

/**
 * Extract `declared` skill observations from one Claude Code transcript.
 *
 * Records are read in file order rather than timestamp order: the base-directory
 * text is positionally adjacent to its call, and re-sorting would break the
 * adjacency the look-ahead depends on.
 *
 * The `args` field is deliberately reduced to a boolean. Skill arguments are
 * user prose and have been measured to carry client names and business context;
 * ADR 0022 forbids persisting them.
 */
export const extractClaudeSkillObservations = (input: ClaudeSkillObservationInput): SkillObservationExtraction => {
  if (!input.sourceSessionId || input.records.length > MAX_CLAUDE_RECORDS) {
    return {
      observations: [],
      rejected: 0,
      // A transcript rejected for exceeding the reader budget may contain
      // invocations. Returning an ordinary empty result would certify their
      // absence downstream.
      truncated: input.records.length > MAX_CLAUDE_RECORDS,
    };
  }
  const observations: SkillObservation[] = [];
  let rejected = 0;
  let truncated = false;
  const ceiling = claudeSkillObservationCeiling();
  for (const [index, record] of input.records.entries()) {
    if (truncated) {
      break;
    }
    if (!isRecord(record)) {
      continue;
    }
    const message = isRecord(record.message) ? record.message : null;
    const { content } = message ?? {};
    if (!Array.isArray(content)) {
      continue;
    }
    for (const [blockIndex, block] of content.entries()) {
      if (!(isRecord(block) && block.type === 'tool_use' && block.name === CLAUDE_SKILL_TOOL_NAME)) {
        continue;
      }
      // Checked per block, not per envelope: a single assistant message can
      // carry any number of `Skill` calls, so a per-envelope check leaves the
      // inner loop unbounded and the ceiling never trips.
      if (observations.length >= ceiling) {
        truncated = true;
        break;
      }
      const blockInput = isRecord(block.input) ? block.input : {};
      const skillName = typeof blockInput.skill === 'string' ? blockInput.skill : blockInput.name;
      const toolUseId = typeof block.id === 'string' && block.id.length > 0 ? block.id : null;
      const lookahead = claudeSkillLookahead(input.records, index, toolUseId);
      const observation = parseSkillObservation({
        argsPresent: typeof blockInput.args === 'string' && blockInput.args.trim().length > 0,
        harnessKey: 'claude',
        observationKey: toolUseId ?? `record-${index}-block-${blockIndex}`,
        observedAt: typeof record.timestamp === 'string' ? record.timestamp : null,
        projectPath: typeof record.cwd === 'string' ? record.cwd : null,
        resolvedPath: lookahead.resolvedPath,
        sessionId: typeof record.sessionId === 'string' ? record.sessionId : input.sourceSessionId,
        skillName,
        success: lookahead.success,
        tier: 'declared',
      });
      if (observation) {
        observations.push(observation);
      } else {
        // A `Skill` tool call that will not validate means the transcript shape
        // moved. Counted so that shows up, rather than the count quietly
        // shrinking.
        rejected += 1;
      }
    }
  }
  return { observations, rejected, truncated };
};

export const parseClaudeSessionFacts = (input: ClaudeSessionInput): ClaudeSessionFacts | null => {
  if (!input.sourceSessionId || input.records.length > MAX_CLAUDE_RECORDS) {
    return null;
  }
  const events = parseClaudeEvents(input.records);
  const start = events[0]?.at;
  const end = events.at(-1)?.at;
  if (!(start && end)) {
    return null;
  }

  const graph = createClaudeGraphIndex(events);
  const promptFacts = collectClaudePrompts(events, graph);
  const assistantFacts = collectClaudeAssistants(events, graph, promptFacts);
  const { assistants } = assistantFacts;
  const { prompts, promptsTruncated } = promptFacts;
  if (assistants.length === 0 && prompts.length === 0) {
    return null;
  }

  const mutableTurns = createClaudeTurns(
    prompts,
    promptFacts.promptEvents,
    assistants,
    assistantFacts.assistantTurnKey,
  );
  extendClaudeTurnBounds(events, assistantFacts.assistantTurnKey, mutableTurns.turnsByKey);
  const timingPartial = applyClaudeTurnDurations(
    events,
    graph,
    assistantFacts.assistantEvents,
    assistantFacts.assistantTurnKey,
    mutableTurns.turnsByKey,
    start,
    end,
  );
  const turnFacts = serializeClaudeTurns(mutableTurns.turnsByKey);
  const { detailTurns } = turnFacts;
  const turnsPartial =
    promptFacts.partial || assistantFacts.partial || mutableTurns.partial || timingPartial || turnFacts.partial;
  let { rejectedMetricRecords } = assistantFacts;
  const links = collectClaudeLinks(events, graph, assistantFacts, turnFacts.turnIndexByKey, input);

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

  const metadata = collectClaudeMetadata(events, input);
  const { sidechain, title } = metadata;
  const name = title ?? `${sidechain ? 'subagent ' : 'claude '}${input.sourceSessionId.slice(0, 8)}`;
  let titleSource: ClaudeReportFacts['titleSource'] = 'id';
  if (title) {
    titleSource = 'ai';
  } else if (sidechain) {
    titleSource = 'agent-role';
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
  const groupingReasons: SessionDetailCoverageReason[] = [];
  if (assistantFacts.unattributed > 0) {
    groupingReasons.push('unattributed-activity');
  }
  if (assistantFacts.cycles > 0) {
    groupingReasons.push('ancestry-cycle');
  }
  if (assistantFacts.budgetExhaustions > 0) {
    groupingReasons.push('ancestry-budget');
  }
  if (graph.conflictingUuids.size > 0) {
    groupingReasons.push('ancestry-conflict');
  }
  if (mutableTurns.partial && detailTurns.length >= MAX_CLAUDE_TURNS) {
    groupingReasons.push('turn-budget');
  }
  if (promptFacts.identitiesOmitted > 0) {
    groupingReasons.push('prompt-budget');
  }
  const promptBodyReasons: SessionDetailCoverageReason[] = [];
  if (promptFacts.bodiesOmitted > 0 || prompts.some(({ truncated }) => truncated)) {
    promptBodyReasons.push('prompt-body-budget');
  }
  if (promptFacts.identitiesOmitted > 0) {
    promptBodyReasons.push('prompt-budget');
  }
  const timingReasons: SessionDetailCoverageReason[] = [];
  if (recordedTurns < detailTurns.length) {
    timingReasons.push('timing-not-recorded');
  }
  if (timingPartial) {
    timingReasons.push('timing-rejected');
  }
  const coverage: SessionDetailCoverage = {
    childDiscovery: links.coverage.childDiscovery,
    grouping:
      groupingReasons.length === 0
        ? completeCoverage()
        : { omittedCount: assistantFacts.unattributed, reasons: groupingReasons, status: 'partial' },
    interactionAttribution: links.coverage.interactionAttribution,
    promptBodies:
      promptBodyReasons.length === 0
        ? completeCoverage()
        : {
            omittedCount: promptFacts.bodiesOmitted + promptFacts.identitiesOmitted,
            reasons: promptBodyReasons,
            status: 'partial',
          },
    recordedTiming:
      timingReasons.length === 0
        ? completeCoverage()
        : {
            omittedCount: detailTurns.length - recordedTurns,
            reasons: timingReasons,
            status: recordedTurns === 0 ? 'unavailable' : 'partial',
          },
  };
  const detailFacts: SessionDetail = {
    activeDurationMs,
    children: links.children,
    coverage,
    durationStatus,
    efforts: [],
    elapsedDurationMs,
    endedAt: iso(end),
    idleDurationMs,
    interactions: links.interactions,
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
      parentSourceSessionId: metadata.parentSourceSessionId,
      sourcePath: metadata.sourcePath,
      ...(metadata.vcs ? { vcs: metadata.vcs } : {}),
    },
  };
};
