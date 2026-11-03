import { createHash } from 'node:crypto';
import { isRecord } from '@ai-usage/report-core/datasets';
import type { SessionDetail } from '@ai-usage/report-core/session-detail';
import {
  SESSION_EVIDENCE_LIMITS,
  type SessionEvidence,
  type SessionEvidenceRecord,
} from '@ai-usage/report-core/session-evidence';
import { safeJSON } from './text';

type EvidenceDetail = Pick<SessionDetail, 'sourceSessionId' | 'turns'> & {
  coverage: Pick<SessionDetail['coverage'], 'grouping'>;
};
type EvidenceInput = Omit<SessionEvidenceRecord, 'truncated'>;
const identifier = (value: unknown, maximum = 1024): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
const bodyText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .filter(isRecord)
      .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
      .join('\n');
  }
  return '';
};
const toolKind = (name: string | null): SessionEvidenceRecord['kind'] => {
  if (name === 'exec_command' || name === 'functions.exec_command' || name === 'shell' || name === 'Bash') {
    return 'command';
  }
  if (
    name === 'apply_patch' ||
    name === 'functions.apply_patch' ||
    name === 'Write' ||
    name === 'Edit' ||
    name === 'MultiEdit'
  ) {
    return 'patch';
  }
  return 'tool-call';
};
const argumentText = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

/** Display-only evidence. Neither command text nor patch requests are interpreted or executed. */
export const createEvidenceAccumulator = () => {
  const records: SessionEvidenceRecord[] = [];
  let usedText = 0;
  let omittedRecords = 0;
  const add = (input: EvidenceInput): SessionEvidenceRecord | null => {
    if (
      records.length >= SESSION_EVIDENCE_LIMITS.records ||
      usedText >= SESSION_EVIDENCE_LIMITS.totalText ||
      !Number.isFinite(Date.parse(input.at))
    ) {
      omittedRecords++;
      return null;
    }
    const maximum = Math.min(SESSION_EVIDENCE_LIMITS.text, SESSION_EVIDENCE_LIMITS.totalText - usedText);
    const record = {
      ...input,
      at: new Date(input.at).toISOString(),
      text: input.text.slice(0, maximum),
      truncated: input.text.length > maximum,
    };
    usedText += record.text.length;
    records.push(record);
    return record;
  };
  return {
    add,
    omit: (count = 1) => {
      omittedRecords += count;
    },
    finish: (sourceSessionId: string, partial: boolean): SessionEvidence => ({
      sourceSessionId,
      records,
      coverage: {
        omittedRecords,
        unattributedRecords: records.filter((record) => record.turnIndex === null).length,
        partial:
          partial || omittedRecords > 0 || records.some((record) => record.truncated || record.turnIndex === null),
      },
    }),
  };
};
interface CodexContext {
  hasContext: boolean;
  replayed: boolean;
  turnId: string;
}
export const createCodexEvidenceCapture = () => {
  const accumulator = createEvidenceAccumulator();
  const pending: { record: SessionEvidenceRecord; turnId: string | null }[] = [];
  const calls = new Map<string, { turnId: string | null; name: string | null }>();
  let ordinal = 0;
  const visit = (line: string, contextFor: (turnId: string | null) => CodexContext | null): void => {
    const event = safeJSON(line);
    if (!isRecord(event)) {
      if (line.trim()) {
        accumulator.omit();
      }
      return;
    }
    if (event.type !== 'response_item' || !isRecord(event.payload)) {
      return;
    }
    const payload = event.payload;
    const supported =
      (payload.type === 'message' && payload.role === 'assistant') ||
      payload.type === 'function_call' ||
      payload.type === 'custom_tool_call' ||
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output';
    if (!supported) {
      return;
    }
    if (typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) {
      accumulator.omit();
      return;
    }
    ordinal++;
    const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
      ? payload.internal_chat_message_metadata_passthrough
      : {};
    const context = contextFor(identifier(payload.turn_id) ?? identifier(metadata.turn_id));
    if (context?.replayed) {
      accumulator.omit();
      return;
    }
    const callId = identifier(payload.call_id);
    let turnId = context?.hasContext ? context.turnId : null;
    let name = identifier(payload.name, 256);
    let kind: SessionEvidenceRecord['kind'];
    let text: string;
    if (payload.type === 'message') {
      kind = 'response';
      text = bodyText(payload.content);
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      kind = 'tool-result';
      text = bodyText(payload.output);
      const call = callId ? calls.get(callId) : undefined;
      turnId = call?.turnId ?? null;
      name = call?.name ?? null;
    } else {
      kind = toolKind(name);
      text = argumentText(payload.arguments ?? payload.input);
      if (callId && (calls.has(callId) || calls.size < SESSION_EVIDENCE_LIMITS.records)) {
        const previous = calls.get(callId);
        calls.set(callId, { turnId: previous ? null : turnId, name: previous ? null : name });
      }
    }
    if (!text) {
      return;
    }
    const record = accumulator.add({
      id: `native-${ordinal}`,
      at: typeof event.timestamp === 'string' ? event.timestamp : '',
      kind,
      text,
      toolName: name,
      callId,
      turnIndex: null,
      promptIds: [],
    });
    if (record) {
      pending.push({ record, turnId });
    }
  };
  return {
    visit,
    omit: accumulator.omit,
    finish: (detail: EvidenceDetail, turnIndexes: ReadonlyMap<string, number>): SessionEvidence => {
      const turns = new Map(detail.turns.map((turn) => [turn.index, turn]));
      for (const { record, turnId } of pending) {
        let owner = turnId;
        if (record.kind === 'tool-result' && record.callId && owner !== null) {
          owner = calls.get(record.callId)?.turnId ?? null;
        }
        const index = owner === null ? undefined : turnIndexes.get(owner);
        const turn = index === undefined ? undefined : turns.get(index);
        record.turnIndex = turn?.index ?? null;
        record.promptIds = turn?.promptIds.slice(0, 32) ?? [];
      }
      return accumulator.finish(detail.sourceSessionId, detail.coverage.grouping.status !== 'complete');
    },
  };
};

/** Receives the canonical Claude parser's turn attribution; no separate ancestry or round model. */
export const createClaudeEvidenceCapture = () => {
  const accumulator = createEvidenceAccumulator();
  const calls = new Map<string, number | null>();
  const seen = new Map<string, string>();
  const visit = (record: Record<string, unknown>, recordIndex: number, turnIndex: number | null): void => {
    if (record.isMeta === true || record.isSynthetic === true || !isRecord(record.message)) {
      return;
    }
    const content =
      typeof record.message.content === 'string'
        ? [{ type: 'text', text: record.message.content }]
        : record.message.content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const [blockIndex, block] of content.entries()) {
      if (!isRecord(block)) {
        continue;
      }
      let kind: SessionEvidenceRecord['kind'];
      let text: string;
      let owner = turnIndex;
      let toolName: string | null = null;
      let callId: string | null = null;
      if (block.type === 'text' && record.type === 'assistant') {
        kind = 'response';
        text = bodyText(block.text);
      } else if (block.type === 'tool_use' && record.type === 'assistant') {
        toolName = identifier(block.name, 256);
        callId = identifier(block.id);
        kind = toolKind(toolName);
        text = argumentText(block.input);
      } else if (block.type === 'tool_result') {
        kind = 'tool-result';
        text = bodyText(block.content);
        callId = identifier(block.tool_use_id);
        owner = callId ? (calls.get(callId) ?? null) : null;
      } else {
        continue;
      }
      if (!text) {
        continue;
      }
      if (typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp))) {
        accumulator.omit();
        continue;
      }
      const nativeId = identifier(record.uuid);
      const id = `${nativeId ?? `record-${recordIndex}`}:${blockIndex}`;
      const signature = createHash('sha256')
        .update(JSON.stringify([kind, text, callId]))
        .digest('hex');
      if (seen.get(id) === signature) {
        continue;
      }
      if (seen.has(id)) {
        owner = null;
      }
      if (seen.size < SESSION_EVIDENCE_LIMITS.records) {
        seen.set(id, signature);
      }
      if (block.type === 'tool_use' && callId && (calls.has(callId) || calls.size < SESSION_EVIDENCE_LIMITS.records)) {
        calls.set(callId, calls.has(callId) ? null : owner);
      }
      accumulator.add({
        id,
        at: typeof record.timestamp === 'string' ? record.timestamp : '',
        kind,
        text,
        toolName,
        callId,
        turnIndex: owner,
        promptIds: [],
      });
    }
  };
  return {
    visit,
    omit: accumulator.omit,
    finish: (detail: EvidenceDetail): SessionEvidence => {
      const result = accumulator.finish(detail.sourceSessionId, detail.coverage.grouping.status !== 'complete');
      const turns = new Map(detail.turns.map((turn) => [turn.index, turn]));
      for (const record of result.records) {
        if (record.kind === 'tool-result' && record.callId && record.turnIndex !== null) {
          record.turnIndex = calls.get(record.callId) ?? null;
        }
        if (record.turnIndex !== null && !turns.has(record.turnIndex)) {
          record.turnIndex = null;
        }
        record.promptIds = record.turnIndex === null ? [] : (turns.get(record.turnIndex)?.promptIds.slice(0, 32) ?? []);
      }
      return accumulator.finish(detail.sourceSessionId, detail.coverage.grouping.status !== 'complete');
    },
  };
};
