import { Cause, Exit, Option } from 'effect';
import type { BoundaryClassification, BoundaryOutcome, SanitizedTaggedError } from './model';
import { scrubApprovedPublicString } from './sanitize';

export interface TaggedErrorPolicy {
  readonly allowedTags: ReadonlySet<string>;
  readonly interruptedTags?: ReadonlySet<string>;
}

const readOwnString = (value: object, key: string): string | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
      return descriptor.value;
    }
  } catch {
    // Hostile proxies must not throw into classification.
  }
  return;
};

export const sanitizeAllowedTaggedError = (
  value: unknown,
  allowedTags: ReadonlySet<string>,
): SanitizedTaggedError | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const tag = readOwnString(value, '_tag');
  if (tag === undefined || !allowedTags.has(tag)) {
    return null;
  }
  const code = readOwnString(value, 'code');
  const publicMessage = readOwnString(value, 'publicMessage');
  return {
    tag,
    ...(code === undefined ? {} : { code }),
    ...(publicMessage === undefined ? {} : { message: scrubApprovedPublicString(publicMessage) }),
  };
};

export const classifyExit = <A, E>(
  exit: Exit.Exit<A, E>,
  taggedErrorPolicy?: TaggedErrorPolicy,
): BoundaryClassification => {
  if (Exit.isSuccess(exit)) {
    return { outcome: 'success', error: null };
  }

  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  if (failure !== undefined) {
    const tagged =
      taggedErrorPolicy === undefined ? null : sanitizeAllowedTaggedError(failure, taggedErrorPolicy.allowedTags);
    if (tagged !== null && taggedErrorPolicy?.interruptedTags?.has(tagged.tag)) {
      return { outcome: 'interrupted', error: tagged };
    }
    return {
      outcome: 'failure',
      error: tagged,
    };
  }

  if (Cause.isInterruptedOnly(exit.cause)) {
    return { outcome: 'interrupted', error: null };
  }

  return { outcome: 'failure', error: null };
};

export const classifyHopExit = <A, E>(exit: Exit.Exit<A, E>): BoundaryOutcome => classifyExit(exit).outcome;

export const safeClassify = <A, E>(
  exit: Exit.Exit<A, E>,
  classify?: (exit: Exit.Exit<A, E>) => BoundaryClassification,
): BoundaryClassification => {
  if (classify === undefined) {
    return classifyExit(exit);
  }
  try {
    return classify(exit);
  } catch {
    return classifyExit(exit);
  }
};

export const safeClassifyHop = <A, E>(
  exit: Exit.Exit<A, E>,
  classify?: (exit: Exit.Exit<A, E>) => BoundaryOutcome,
): BoundaryOutcome => {
  if (classify === undefined) {
    return classifyHopExit(exit);
  }
  try {
    return classify(exit);
  } catch {
    return classifyHopExit(exit);
  }
};
