import { parseServedRevision } from './served-revision';

export interface SessionDetailRequest {
  revision: string;
  rowId: string;
}

export class SessionDetailValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionDetailValidationError';
  }
}

/** Request identity stays available without loading native-detail response validation. */
export const parseSessionDetailRequest = (value: unknown): SessionDetailRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionDetailValidationError('Session detail request must be an object');
  }
  const allowed = new Set(['revision', 'rowId']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new SessionDetailValidationError('Session detail request contains unknown fields');
  }
  const revision = parseServedRevision(Reflect.get(value, 'revision'), 'Session detail request.revision');
  const rowId: unknown = Reflect.get(value, 'rowId');
  if (typeof rowId !== 'string' || rowId.length === 0 || rowId.length > 512) {
    throw new SessionDetailValidationError('Session detail request.rowId must be a non-empty bounded string');
  }
  return { revision, rowId };
};

const fnv1a64 = (value: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    // biome-ignore lint/suspicious/noBitwiseOperators: The XOR step is intrinsic to FNV-1a.
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
};

export const sessionDetailRequestFingerprint = (input: SessionDetailRequest): string => {
  const request = parseSessionDetailRequest(input);
  return `session-detail-v2:${fnv1a64(request.rowId)}`;
};
