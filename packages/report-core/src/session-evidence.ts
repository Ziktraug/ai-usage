import { parseSessionDetailResponse, type SessionDetailResponse } from './session-detail';

export const SESSION_EVIDENCE_LIMITS = { records: 200, text: 8000, totalText: 256_000 } as const;
export const sessionEvidenceKinds = ['response', 'command', 'patch', 'tool-call', 'tool-result'] as const;
export interface SessionEvidenceRecord {
  at: string;
  callId: string | null;
  id: string;
  kind: (typeof sessionEvidenceKinds)[number];
  promptIds: string[];
  text: string;
  toolName: string | null;
  truncated: boolean;
  turnIndex: number | null;
}
export interface SessionEvidence {
  coverage: { omittedRecords: number; partial: boolean; unattributedRecords: number };
  records: SessionEvidenceRecord[];
  sourceSessionId: string;
}
export type SessionEvidenceResponse =
  | { evidence: SessionEvidence; revision: string; status: 'available' }
  | Extract<SessionDetailResponse, { status: 'unavailable' }>;
export class SessionEvidenceValidationError extends Error {}
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw new SessionEvidenceValidationError('Invalid evidence object');
  }
  return value as Record<string, unknown>;
};
const text = (value: unknown, maximum = 1024): string => {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new SessionEvidenceValidationError('Invalid evidence text');
  }
  return value;
};
const count = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionEvidenceValidationError('Invalid evidence count');
  }
  return value;
};
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') {
    throw new SessionEvidenceValidationError('Invalid evidence coverage');
  }
  return value;
};
export const parseSessionEvidence = (value: unknown): SessionEvidence => {
  const input = object(value, ['sourceSessionId', 'records', 'coverage']);
  if (!Array.isArray(input.records) || input.records.length > SESSION_EVIDENCE_LIMITS.records) {
    throw new SessionEvidenceValidationError('Invalid evidence record budget');
  }
  const records = input.records.map((raw): SessionEvidenceRecord => {
    const record = object(raw, [
      'id',
      'at',
      'kind',
      'text',
      'toolName',
      'callId',
      'turnIndex',
      'promptIds',
      'truncated',
    ]);
    const at = text(record.at, 40);
    if (
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at ||
      !sessionEvidenceKinds.includes(record.kind as SessionEvidenceRecord['kind'])
    ) {
      throw new SessionEvidenceValidationError('Invalid evidence kind or date');
    }
    if (!Array.isArray(record.promptIds) || record.promptIds.length > 32) {
      throw new SessionEvidenceValidationError('Invalid evidence prompt references');
    }
    return {
      id: text(record.id),
      at,
      kind: record.kind as SessionEvidenceRecord['kind'],
      text: text(record.text, SESSION_EVIDENCE_LIMITS.text),
      toolName: record.toolName === null ? null : text(record.toolName, 256),
      callId: record.callId === null ? null : text(record.callId),
      turnIndex: record.turnIndex === null ? null : count(record.turnIndex),
      promptIds: record.promptIds.map((id) => text(id)),
      truncated: flag(record.truncated),
    };
  });
  if (records.reduce((sum, record) => sum + record.text.length, 0) > SESSION_EVIDENCE_LIMITS.totalText) {
    throw new SessionEvidenceValidationError('Evidence text budget exceeded');
  }
  const coverage = object(input.coverage, ['omittedRecords', 'partial', 'unattributedRecords']);
  return {
    sourceSessionId: text(input.sourceSessionId),
    records,
    coverage: {
      omittedRecords: count(coverage.omittedRecords),
      partial: flag(coverage.partial),
      unattributedRecords: count(coverage.unattributedRecords),
    },
  };
};
export const parseSessionEvidenceResponse = (value: unknown): SessionEvidenceResponse => {
  if (typeof value === 'object' && value !== null && 'status' in value && value.status === 'unavailable') {
    const unavailable = parseSessionDetailResponse(value);
    if (unavailable.status === 'unavailable') {
      return unavailable;
    }
  }
  const input = object(value, ['status', 'revision', 'evidence']);
  if (input.status !== 'available') {
    throw new SessionEvidenceValidationError('Invalid evidence status');
  }
  return { status: 'available', revision: text(input.revision, 512), evidence: parseSessionEvidence(input.evidence) };
};
