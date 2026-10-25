import { isRecord } from './datasets';
import type {
  DelegationClientInfo,
  DelegationRequest,
  DelegationScopeRequest,
  DelegationSelection,
} from './delegation-contracts';
import {
  DELEGATION_ABSTENTION_REASONS,
  DELEGATION_ACTIONS,
  DELEGATION_BOUNDS,
  DELEGATION_IDEMPOTENCY_KEY_PATTERN,
  DELEGATION_RESERVED_ACTIONS,
  DELEGATION_RESERVED_SCOPE_KINDS,
  DELEGATION_REVISION_PATTERN,
  DELEGATION_SCHEMA_VERSION,
  DELEGATION_SCOPE_KINDS,
  DELEGATION_TASK_CATEGORIES,
} from './delegation-vocabulary';
import { isPrintableSkillObservationText } from './skill-observation';
import { normalizeCheckoutPath } from './work-attempts';
import { isRoutingId } from './work-routing-vocabulary';

/**
 * The caller's side of a delegation: the request and the selection, parsed strictly and bounded
 * before anything else looks at them, and digested canonically so the engine can tell "the same
 * work" from "another request". The caller's `client` block is metadata: it is kept, never
 * digested, never used to authorize.
 */

export interface DelegationRequestIssue {
  /** Path inside the request such as `scope.commit`; empty for the request itself. Never the value. */
  readonly path: string;
  readonly reason: string;
}

export type DelegationRequestParseResult =
  | { readonly kind: 'invalid'; readonly issues: readonly DelegationRequestIssue[] }
  | { readonly kind: 'ok'; readonly request: DelegationRequest }
  | {
      readonly kind: 'unsupported';
      readonly message: string;
      readonly reason: 'action-unsupported' | 'scope-unsupported';
    };

export type DelegationSelectionParseResult =
  | { readonly kind: 'invalid'; readonly issues: readonly DelegationRequestIssue[] }
  | { readonly kind: 'ok'; readonly selection: DelegationSelection };

const REQUEST_KEYS: ReadonlySet<string> = new Set([
  'action',
  'checkout',
  'client',
  'constraints',
  'criteria',
  'objective',
  'retryOf',
  'schemaVersion',
  'scope',
  'taskCategory',
]);
const CLIENT_KEYS: ReadonlySet<string> = new Set(['correlationId', 'name', 'sessionRef']);
const CHOICE_KEYS: ReadonlySet<string> = new Set([
  'confidence',
  'kind',
  'qualificationId',
  'rationale',
  'routeId',
  'selectorVersion',
]);
const ABSTAIN_KEYS: ReadonlySet<string> = new Set(['kind', 'note', 'qualificationId', 'reason', 'selectorVersion']);
const MAX_ABSTENTION_NOTE_CHARACTERS = 500;

/** Lowercase RFC 4122 text, the form `crypto.randomUUID()` produces; an uppercase copy is another string. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const isDelegationUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_PATTERN.test(value);

export const isDelegationIdempotencyKey = (value: unknown): value is string =>
  typeof value === 'string' && DELEGATION_IDEMPOTENCY_KEY_PATTERN.test(value);

const isOneOf = <const Values extends readonly string[]>(values: Values, value: unknown): value is Values[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/** Renderable text (no C0/C1 control characters), non-blank, within the bound. */
const isBoundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.length <= maximum &&
  isPrintableSkillObservationText(value);

const textReason = (maximum: number): string => `must be a non-blank printable string of at most ${maximum} characters`;

const unknownKeys = (record: Record<string, unknown>, keys: ReadonlySet<string>): string[] =>
  Object.keys(record).filter((key) => !keys.has(key));

/** A Git revision the engine passes after `--end-of-options`; still never an option by shape. */
const isRevision = (value: unknown): value is string =>
  typeof value === 'string' && DELEGATION_REVISION_PATTERN.test(value) && !value.startsWith('-');

const REVISION_REASON = `must be a Git revision of at most ${DELEGATION_BOUNDS.maxRevisionCharacters} characters (letters, digits, ._/@{}^~+-) not starting with '-'`;

/**
 * Bounded string list: the length is judged before any element, so an oversize array is refused
 * without walking it.
 */
const parseTextList = (
  value: unknown,
  path: string,
  bounds: { readonly maxEntries: number; readonly maxCharacters: number },
  issues: DelegationRequestIssue[],
): readonly string[] | null => {
  if (!Array.isArray(value)) {
    issues.push({ path, reason: 'must be an array of strings' });
    return null;
  }
  if (value.length > bounds.maxEntries) {
    issues.push({ path, reason: `must list at most ${bounds.maxEntries} entries` });
    return null;
  }
  const entries: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isBoundedText(entry, bounds.maxCharacters)) {
      issues.push({ path: `${path}[${index}]`, reason: textReason(bounds.maxCharacters) });
      return null;
    }
    entries.push(entry);
  }
  return entries;
};

const parseCheckout = (value: unknown, issues: DelegationRequestIssue[]): { readonly path: string } | null => {
  if (!isRecord(value)) {
    issues.push({ path: 'checkout', reason: 'must be an object with a path' });
    return null;
  }
  const extra = unknownKeys(value, new Set(['path']));
  if (extra.length > 0) {
    issues.push({ path: 'checkout', reason: `unknown field(s): ${extra.join(', ')}` });
    return null;
  }
  const path =
    typeof value.path === 'string' && value.path.length <= DELEGATION_BOUNDS.maxCheckoutPathCharacters
      ? normalizeCheckoutPath(value.path)
      : null;
  if (path === null) {
    issues.push({
      path: 'checkout.path',
      reason: `must be an absolute path of at most ${DELEGATION_BOUNDS.maxCheckoutPathCharacters} characters without . or .. segments`,
    });
    return null;
  }
  return { path };
};

const parseScope = (
  value: Record<string, unknown>,
  issues: DelegationRequestIssue[],
): DelegationScopeRequest | null => {
  if (value.kind === 'commit') {
    const extra = unknownKeys(value, new Set(['commit', 'kind']));
    if (extra.length > 0) {
      issues.push({ path: 'scope', reason: `unknown field(s) for a commit scope: ${extra.join(', ')}` });
      return null;
    }
    if (!isRevision(value.commit)) {
      issues.push({ path: 'scope.commit', reason: REVISION_REASON });
      return null;
    }
    return { commit: value.commit, kind: 'commit' };
  }
  if (value.kind === 'range') {
    const extra = unknownKeys(value, new Set(['base', 'head', 'kind']));
    if (extra.length > 0) {
      issues.push({ path: 'scope', reason: `unknown field(s) for a range scope: ${extra.join(', ')}` });
      return null;
    }
    const before = issues.length;
    if (!isRevision(value.base)) {
      issues.push({ path: 'scope.base', reason: REVISION_REASON });
    }
    if (!isRevision(value.head)) {
      issues.push({ path: 'scope.head', reason: REVISION_REASON });
    }
    return issues.length === before && isRevision(value.base) && isRevision(value.head)
      ? { base: value.base, head: value.head, kind: 'range' }
      : null;
  }
  issues.push({
    path: 'scope.kind',
    reason: `must be one of ${DELEGATION_SCOPE_KINDS.map((kind) => `'${kind}'`).join(', ')}`,
  });
  return null;
};

const parseClient = (
  value: unknown,
  issues: DelegationRequestIssue[],
): { readonly ok: boolean; readonly client: DelegationClientInfo | undefined } => {
  if (value === undefined) {
    return { client: undefined, ok: true };
  }
  if (!isRecord(value)) {
    issues.push({ path: 'client', reason: 'must be an object' });
    return { client: undefined, ok: false };
  }
  const extra = unknownKeys(value, CLIENT_KEYS);
  if (extra.length > 0) {
    issues.push({ path: 'client', reason: `unknown field(s): ${extra.join(', ')}` });
    return { client: undefined, ok: false };
  }
  const before = issues.length;
  const fields: readonly (readonly [keyof DelegationClientInfo, number])[] = [
    ['correlationId', DELEGATION_BOUNDS.maxClientCorrelationCharacters],
    ['name', DELEGATION_BOUNDS.maxClientNameCharacters],
    ['sessionRef', DELEGATION_BOUNDS.maxClientSessionRefCharacters],
  ];
  const client: { -readonly [Key in keyof DelegationClientInfo]?: string } = {};
  for (const [key, maximum] of fields) {
    const field = value[key];
    if (field === undefined) {
      continue;
    }
    if (!isBoundedText(field, maximum)) {
      issues.push({ path: `client.${key}`, reason: textReason(maximum) });
      continue;
    }
    client[key] = field;
  }
  return { client, ok: issues.length === before };
};

const supportedActions = DELEGATION_ACTIONS.map((action) => `'${action}'`).join(', ');
const supportedScopes = DELEGATION_SCOPE_KINDS.map((kind) => `'${kind}'`).join(', ');

/**
 * Strict, bounded parsing of a caller's request. A reserved action or scope kind is answered as
 * `unsupported` with the supported alternatives; any other shape problem is `invalid` with every
 * issue located by path. Values are never echoed.
 */
export const parseDelegationRequest = (value: unknown): DelegationRequestParseResult => {
  if (!isRecord(value)) {
    return { issues: [{ path: '', reason: 'must be an object' }], kind: 'invalid' };
  }
  if (isOneOf(DELEGATION_RESERVED_ACTIONS, value.action)) {
    return {
      kind: 'unsupported',
      message: `Action '${value.action}' is not executed by this version; the supported action is ${supportedActions}.`,
      reason: 'action-unsupported',
    };
  }
  if (isRecord(value.scope) && isOneOf(DELEGATION_RESERVED_SCOPE_KINDS, value.scope.kind)) {
    return {
      kind: 'unsupported',
      message: `Scope '${value.scope.kind}' cannot be frozen for a worker; the supported scopes are ${supportedScopes} (committed objects only).`,
      reason: 'scope-unsupported',
    };
  }
  const issues: DelegationRequestIssue[] = [];
  const extra = unknownKeys(value, REQUEST_KEYS);
  if (extra.length > 0) {
    issues.push({ path: '', reason: `unknown field(s): ${extra.join(', ')}` });
  }
  if (value.schemaVersion !== DELEGATION_SCHEMA_VERSION) {
    issues.push({ path: 'schemaVersion', reason: `must be ${DELEGATION_SCHEMA_VERSION}` });
  }
  if (!isOneOf(DELEGATION_ACTIONS, value.action)) {
    issues.push({ path: 'action', reason: `must be ${supportedActions}` });
  }
  if (!isOneOf(DELEGATION_TASK_CATEGORIES, value.taskCategory)) {
    issues.push({
      path: 'taskCategory',
      reason: `must be one of ${DELEGATION_TASK_CATEGORIES.map((category) => `'${category}'`).join(', ')}`,
    });
  }
  if (!isBoundedText(value.objective, DELEGATION_BOUNDS.maxObjectiveCharacters)) {
    issues.push({ path: 'objective', reason: textReason(DELEGATION_BOUNDS.maxObjectiveCharacters) });
  }
  const checkout = parseCheckout(value.checkout, issues);
  let scope: DelegationScopeRequest | null = null;
  if (isRecord(value.scope)) {
    scope = parseScope(value.scope, issues);
  } else {
    issues.push({ path: 'scope', reason: 'must be an object with a kind' });
  }
  const criteria = parseTextList(
    value.criteria,
    'criteria',
    { maxCharacters: DELEGATION_BOUNDS.maxCriterionCharacters, maxEntries: DELEGATION_BOUNDS.maxCriteria },
    issues,
  );
  const constraints = parseTextList(
    value.constraints,
    'constraints',
    { maxCharacters: DELEGATION_BOUNDS.maxConstraintCharacters, maxEntries: DELEGATION_BOUNDS.maxConstraints },
    issues,
  );
  if (value.retryOf !== undefined && !isDelegationUuid(value.retryOf)) {
    issues.push({ path: 'retryOf', reason: 'must be the lowercase UUID of an earlier job' });
  }
  const client = parseClient(value.client, issues);
  if (
    issues.length > 0 ||
    !isOneOf(DELEGATION_ACTIONS, value.action) ||
    !isOneOf(DELEGATION_TASK_CATEGORIES, value.taskCategory) ||
    !isBoundedText(value.objective, DELEGATION_BOUNDS.maxObjectiveCharacters) ||
    checkout === null ||
    scope === null ||
    criteria === null ||
    constraints === null ||
    !client.ok
  ) {
    return { issues, kind: 'invalid' };
  }
  return {
    kind: 'ok',
    request: {
      action: value.action,
      checkout,
      ...(client.client === undefined ? {} : { client: client.client }),
      constraints,
      criteria,
      objective: value.objective,
      ...(isDelegationUuid(value.retryOf) ? { retryOf: value.retryOf } : {}),
      schemaVersion: DELEGATION_SCHEMA_VERSION,
      scope,
      taskCategory: value.taskCategory,
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Canonical JSON and digests
// ---------------------------------------------------------------------------------------------

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = value[key];
      if (member !== undefined) {
        sorted[key] = canonicalValue(member);
      }
    }
    return sorted;
  }
  return value;
};

/** JSON with object keys sorted at every depth and `undefined` members dropped; arrays keep their order. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

const toHex = (bytes: Uint8Array): string => {
  let text = '';
  for (const byte of bytes) {
    text += byte.toString(16).padStart(2, '0');
  }
  return text;
};

/** Lowercase hexadecimal SHA-256 of a text; Web Crypto, so it runs in the engine, the CLI and a browser. */
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
};

/** The identity of the work asked for: the request without its `client` metadata, canonically serialized. */
export const delegationRequestDigest = (request: DelegationRequest): Promise<string> => {
  const { client: _client, ...work } = request;
  return sha256Hex(canonicalJson(work));
};

/** Only what starts work is digested: the kind, the route and the qualification it was chosen from. */
export const delegationSelectionDigest = (selection: DelegationSelection): Promise<string> =>
  sha256Hex(
    canonicalJson({
      kind: selection.kind,
      qualificationId: selection.qualificationId,
      ...(selection.kind === 'choice' ? { routeId: selection.routeId } : {}),
    }),
  );

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

const parseSelectionCommon = (
  value: Record<string, unknown>,
  issues: DelegationRequestIssue[],
): { readonly qualificationId: string; readonly selectorVersion: string } | null => {
  const before = issues.length;
  if (!isDelegationUuid(value.qualificationId)) {
    issues.push({ path: 'qualificationId', reason: 'must be the lowercase UUID of a qualification' });
  }
  if (!isBoundedText(value.selectorVersion, DELEGATION_BOUNDS.maxSelectorVersionCharacters)) {
    issues.push({ path: 'selectorVersion', reason: textReason(DELEGATION_BOUNDS.maxSelectorVersionCharacters) });
  }
  return issues.length === before &&
    isDelegationUuid(value.qualificationId) &&
    typeof value.selectorVersion === 'string'
    ? { qualificationId: value.qualificationId, selectorVersion: value.selectorVersion }
    : null;
};

const parseChoice = (value: Record<string, unknown>, issues: DelegationRequestIssue[]): DelegationSelection | null => {
  const extra = unknownKeys(value, CHOICE_KEYS);
  if (extra.length > 0) {
    issues.push({ path: '', reason: `unknown field(s) for a choice: ${extra.join(', ')}` });
    return null;
  }
  const common = parseSelectionCommon(value, issues);
  const routeId = typeof value.routeId === 'string' && isRoutingId(value.routeId) ? value.routeId : null;
  if (routeId === null || !isPrintableSkillObservationText(routeId)) {
    issues.push({ path: 'routeId', reason: 'must be a route id offered by the qualification' });
  }
  let confidence: number | undefined;
  if (value.confidence !== undefined) {
    if (
      typeof value.confidence === 'number' &&
      Number.isFinite(value.confidence) &&
      value.confidence >= 0 &&
      value.confidence <= 1
    ) {
      confidence = value.confidence;
    } else {
      issues.push({ path: 'confidence', reason: 'must be a finite number between 0 and 1' });
    }
  }
  const rationale =
    value.rationale === undefined
      ? undefined
      : parseTextList(
          value.rationale,
          'rationale',
          {
            maxCharacters: DELEGATION_BOUNDS.maxSelectionRationaleCharacters,
            maxEntries: DELEGATION_BOUNDS.maxSelectionRationale,
          },
          issues,
        );
  if (common === null || routeId === null || issues.length > 0 || rationale === null) {
    return null;
  }
  return {
    ...(confidence === undefined ? {} : { confidence }),
    kind: 'choice',
    qualificationId: common.qualificationId,
    ...(rationale === undefined ? {} : { rationale }),
    routeId,
    selectorVersion: common.selectorVersion,
  };
};

const parseAbstention = (
  value: Record<string, unknown>,
  issues: DelegationRequestIssue[],
): DelegationSelection | null => {
  const extra = unknownKeys(value, ABSTAIN_KEYS);
  if (extra.length > 0) {
    issues.push({ path: '', reason: `unknown field(s) for an abstention: ${extra.join(', ')}` });
    return null;
  }
  const common = parseSelectionCommon(value, issues);
  if (!isOneOf(DELEGATION_ABSTENTION_REASONS, value.reason)) {
    issues.push({
      path: 'reason',
      reason: `must be one of ${DELEGATION_ABSTENTION_REASONS.map((reason) => `'${reason}'`).join(', ')}`,
    });
  }
  if (value.note !== undefined && !isBoundedText(value.note, MAX_ABSTENTION_NOTE_CHARACTERS)) {
    issues.push({ path: 'note', reason: textReason(MAX_ABSTENTION_NOTE_CHARACTERS) });
  }
  if (common === null || issues.length > 0 || !isOneOf(DELEGATION_ABSTENTION_REASONS, value.reason)) {
    return null;
  }
  return {
    kind: 'abstain',
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
    qualificationId: common.qualificationId,
    reason: value.reason,
    selectorVersion: common.selectorVersion,
  };
};

/** Strict parsing of a selector's answer; the route id is checked against the qualification elsewhere. */
export const parseDelegationSelection = (value: unknown): DelegationSelectionParseResult => {
  if (!isRecord(value)) {
    return { issues: [{ path: '', reason: 'must be an object' }], kind: 'invalid' };
  }
  const issues: DelegationRequestIssue[] = [];
  let selection: DelegationSelection | null = null;
  if (value.kind === 'choice') {
    selection = parseChoice(value, issues);
  } else if (value.kind === 'abstain') {
    selection = parseAbstention(value, issues);
  } else {
    issues.push({ path: 'kind', reason: "must be 'choice' or 'abstain'" });
  }
  return selection === null ? { issues, kind: 'invalid' } : { kind: 'ok', selection };
};
