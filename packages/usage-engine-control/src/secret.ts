import { usageEngineControlBounds } from './contracts';

const encoder = new TextEncoder();
const tokenValues = new WeakMap<UsageEngineBearerToken, string>();
const base64UrlTokenPattern = /^[A-Za-z0-9_-]+$/;
declare const usageEngineBearerTokenBrand: unique symbol;

export interface UsageEngineBearerToken {
  readonly toJSON: () => string;
  readonly toString: () => string;
  readonly [usageEngineBearerTokenBrand]: 'UsageEngineBearerToken';
}

class RedactedUsageEngineBearerToken implements UsageEngineBearerToken {
  declare readonly [usageEngineBearerTokenBrand]: 'UsageEngineBearerToken';

  constructor(value: string) {
    tokenValues.set(this, value);
    Object.freeze(this);
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }
}

export const createUsageEngineBearerToken = (value: unknown): UsageEngineBearerToken => {
  const byteLength = typeof value === 'string' ? encoder.encode(value).byteLength : 0;
  if (
    !(
      typeof value === 'string' &&
      byteLength >= usageEngineControlBounds.minTokenBytes &&
      byteLength <= usageEngineControlBounds.maxTokenBytes &&
      base64UrlTokenPattern.test(value)
    )
  ) {
    throw new Error('Usage engine rendezvous token is invalid or exceeds its byte limit.');
  }
  return new RedactedUsageEngineBearerToken(value);
};

export const revealUsageEngineBearerToken = (token: UsageEngineBearerToken): string => {
  const value = tokenValues.get(token);
  if (value === undefined) {
    throw new Error('Usage engine bearer token is invalid.');
  }
  return value;
};
