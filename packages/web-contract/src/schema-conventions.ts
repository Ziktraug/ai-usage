import { custom, maxLength, minLength, pipe, regex, strictObject, string } from 'valibot';

const MAX_PUBLIC_MESSAGE_CHARACTERS = 512;
const MAX_PUBLIC_REASON_CHARACTERS = 128;
const SAFE_PUBLIC_REASON_PATTERN = /^[a-z][a-z0-9-]*$/u;

export type JsonWireValue =
  | boolean
  | null
  | number
  | string
  | readonly JsonWireValue[]
  | { readonly [key: string]: JsonWireValue };

const isPlainRecord = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
};

const isJsonWireValueInternal = (value: unknown, ancestors: ReadonlySet<object>): value is JsonWireValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }

  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string') || keys.length !== value.length + 1) {
      return false;
    }
    for (const index of value.keys()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!(descriptor?.enumerable && 'value' in descriptor)) {
        return false;
      }
      if (!isJsonWireValueInternal(descriptor.value, nextAncestors)) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainRecord(value)) {
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!(descriptor?.enumerable && 'value' in descriptor)) {
      return false;
    }
    if (!isJsonWireValueInternal(descriptor.value, nextAncestors)) {
      return false;
    }
  }
  return true;
};

export const isJsonWireValue = (value: unknown): value is JsonWireValue => isJsonWireValueInternal(value, new Set());

export const jsonWireValueSchema = custom<JsonWireValue>(
  isJsonWireValue,
  'Expected a finite, acyclic JSON value without files, streams, dates, class instances, or accessors.',
);

export const emptyInputSchema = strictObject({});

export const publicMessageSchema = pipe(
  string(),
  minLength(1, 'Public error messages must not be empty.'),
  maxLength(MAX_PUBLIC_MESSAGE_CHARACTERS, 'Public error messages exceed the character limit.'),
);

export const publicReasonSchema = pipe(
  string(),
  minLength(1, 'Public error reasons must not be empty.'),
  maxLength(MAX_PUBLIC_REASON_CHARACTERS, 'Public error reasons exceed the character limit.'),
  regex(SAFE_PUBLIC_REASON_PATTERN, 'Public error reasons must be stable lowercase tokens.'),
);
