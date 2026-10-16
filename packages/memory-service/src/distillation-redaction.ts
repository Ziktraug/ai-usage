import type { MemoryJsonValue } from './domain';
import { redactMemoryValue } from './redaction';

/**
 * Part of every packet digest and snapshot identity. Rule fixes keep it: identity already follows
 * the redacted text, so only sessions whose text changes get a new identity, and evidence reload
 * rebuilds packets with this version and compares digests, so a bump would report every published
 * analysis's evidence as changed instead of only the affected ones.
 */
export const DISTILLATION_REDACTION_VERSION = 1;

/**
 * Event text is not Memory content, so the Memory domain's JSON limits (key length, node count,
 * depth 32, finite numbers) do not apply to it. Nesting is the one bound: JSON.parse accepts any
 * depth, while the walks here, redactMemoryValue and JSON.stringify recurse once per level.
 */
export const DISTILLATION_JSON_MAX_DEPTH = 256;
/** Replaces a whole text that is JSON nested past DISTILLATION_JSON_MAX_DEPTH; a fixed point. */
export const DISTILLATION_TOO_DEEP_MARKER = `[REDACTED: JSON nested deeper than ${DISTILLATION_JSON_MAX_DEPTH} levels]`;

type Mask = (text: string) => string;

// Tool outputs often wrap JSON in process diagnostics; parsing the whole output then fails.
const secretKey = String.raw`(["'])([A-Za-z0-9_-]*(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token))\1\s*:\s*`;
const quotedValue = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
// A bare value runs to whitespace, comma or semicolon (head); past a closing-bracket run it continues
// only through characters that cannot start another token (tail).
const bareHead = String.raw`[^\s,;}\]]+`;
const bareTail = String.raw`(?:[}\]]+[^\s,;}\]"'{\[]+)*`;
const quotedSecret = new RegExp(`${secretKey}(?:(${quotedValue})|(${bareHead})(${bareTail}))`, 'giu');
const redactString = (value: string): string => String(redactMemoryValue(value, 'normal').value);
const placeholders = new Set(['"[REDACTED]"', "'[REDACTED]'"]);
// A closing bracket continues a bare value unless the shared rules match text starting there; then the
// tail stays verbatim and they mask it. With keepFilled, an exact placeholder is a filled slot and stays.
// One rescan budget per phase bounds those checks across every string of the text; past it the value
// ends at the bracket as before.
const maskSlots = (keepFilled: boolean, budget: number): Mask => {
  let remaining = budget;
  return (value) =>
    value.replace(
      quotedSecret,
      (
        match: string,
        quote: string,
        key: string,
        quoted: string | undefined,
        head: string | undefined,
        tail: string | undefined,
        offset: number,
        whole: string,
      ) => {
        const slot = `${quote}${key}${quote}: "[REDACTED]"`;
        if (head === undefined || tail === undefined) {
          return keepFilled && quoted !== undefined && placeholders.has(quoted) ? match : slot;
        }
        if (tail === '') {
          return keepFilled && head === '[REDACTED' && whole[offset + match.length] === ']' ? match : slot;
        }
        const tailStart = offset + match.length - tail.length;
        const rest = whole.slice(tailStart);
        let overlap = true;
        // memory-redaction-v1's PEM rule is the only shared rule whose match spans whitespace, so it is
        // the only one that can begin before a slot and end inside its tail (the other rules' runs stop
        // at the space the slot replacement inserts): a tail holding a PEM marker stays outside.
        if (!tail.includes('-----') && rest.length <= remaining) {
          remaining -= rest.length;
          const masked = redactString(rest);
          overlap = false;
          for (let index = 0; index < tail.length && !overlap; index += 1) {
            overlap = masked[index] !== rest[index];
          }
        }
        const bare = overlap ? head : `${head}${tail}`;
        if (keepFilled && bare === '[REDACTED' && whole[tailStart - head.length + bare.length] === ']') {
          return match;
        }
        return overlap ? `${slot}${tail}` : slot;
      },
    );
};
const redactText = (value: string, mask: Mask): string => redactString(mask(value));
// A key the shared rules judge sensitive keeps its text, as in redactMemoryValue itself: its value is
// already the placeholder, and the key must stay sensitive so the next pass emits the same structure.
const isSensitiveKey = (key: string): boolean => redactMemoryValue({ [key]: null }, 'normal').redacted;
const redactKey = (key: string, mask: Mask): string => (isSensitiveKey(key) ? key : redactText(key, mask));
const identity: Mask = (text) => text;
const mapJson = (value: MemoryJsonValue, text: Mask, key: Mask): MemoryJsonValue => {
  if (typeof value === 'string') {
    return text(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => mapJson(item, text, key));
  }
  if (value && typeof value === 'object') {
    // Object.fromEntries keeps "__proto__" as an own property; keys that redact to the same text
    // collapse, which loses only redacted members.
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [key(name), mapJson(item, text, key)]));
  }
  return value;
};
// Fail-closed form of a lossy document: sensitive keys keep their text; every other key and every leaf
// (string, number, boolean, null) becomes the placeholder.
const closed = (value: MemoryJsonValue): MemoryJsonValue => {
  if (Array.isArray(value)) {
    return value.map(closed);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [isSensitiveKey(key) ? key : '[REDACTED]', closed(item)]),
    );
  }
  return '[REDACTED]';
};
// The shared rules judge sensitive keys on their original text; keys are redacted as text afterwards.
// Only value changes decide whether structured output replaces the raw text.
const redactStructure = (
  value: MemoryJsonValue,
  mask: Mask,
): { readonly changed: boolean; readonly value: MemoryJsonValue } => {
  const result = redactMemoryValue(mapJson(value, mask, identity), 'normal');
  return {
    changed: result.redacted || JSON.stringify(result.value) !== JSON.stringify(value),
    value: mapJson(result.value, identity, (key) => redactKey(key, mask)),
  };
};
// In text JSON.parse accepted, every string token followed by a colon is an object key.
const keyToken = /"(?:\\.|[^"\\])*"(\s*:)?/gu;
const countMembers = (value: MemoryJsonValue): number => {
  if (Array.isArray(value)) {
    return value.reduce((count: number, item) => count + countMembers(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((count: number, item) => count + 1 + countMembers(item), 0);
  }
  return 0;
};
// A JSON value nested at most `levels` containers deep. Recursion stops at the bound, so this is safe on
// any depth JSON.parse accepts.
const isWalkableJson = (value: unknown, levels: number): value is MemoryJsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (levels === 0 || typeof value !== 'object') {
    return false;
  }
  return (Array.isArray(value) ? value : Object.values(value)).every((item) => isWalkableJson(item, levels - 1));
};
type ParsedText =
  | { readonly kind: 'text' }
  | { readonly kind: 'too-deep' }
  | { readonly kind: 'json'; readonly lossy: boolean; readonly value: MemoryJsonValue };
// Every key token renamed to its position, so JSON.parse keeps duplicate members too.
const renameKeys = (value: string): { readonly keys: readonly string[]; readonly renamed: string } => {
  const keys: string[] = [];
  const renamed = value.replace(keyToken, (token: string, colon: string | undefined) => {
    if (colon === undefined) {
      return token;
    }
    keys.push(String(JSON.parse(token.slice(0, -colon.length))));
    return `"${keys.length - 1}"${colon}`;
  });
  return { keys, renamed };
};
// JSON.parse keeps only the last of duplicate members, so the raw text can hold members the
// structured pass never sees.
const parseJson = (value: string): ParsedText => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: 'text' };
    }
    throw error;
  }
  if (!isWalkableJson(parsed, DISTILLATION_JSON_MAX_DEPTH)) {
    return { kind: 'too-deep' };
  }
  let keys = 0;
  for (const match of value.matchAll(keyToken)) {
    if (match[1] !== undefined) {
      keys += 1;
    }
  }
  const lossy = keys !== countMembers(parsed);
  // Dropped members are judged too (cleanLossy), so their nesting counts toward the bound.
  if (lossy && !isWalkableJson(JSON.parse(renameKeys(value).renamed), DISTILLATION_JSON_MAX_DEPTH)) {
    return { kind: 'too-deep' };
  }
  return { kind: 'json', lossy, value: parsed };
};
// Lossy JSON is judged member by member, including the members JSON.parse would drop: every key token
// is renamed to its position so nothing collapses, then each member is judged as redactStructure judges
// it (sensitivity on the original key, key text through redactKey, strings through the mask and the
// shared rules).
const cleanLossy = (value: string, mask: Mask): boolean => {
  const { keys, renamed } = renameKeys(value);
  const parsed: unknown = JSON.parse(renamed);
  // parseJson already bounded the nesting of this renamed form; this only narrows the type.
  if (!isWalkableJson(parsed, DISTILLATION_JSON_MAX_DEPTH)) {
    return false;
  }
  const clean = (item: MemoryJsonValue): boolean => {
    if (typeof item === 'string') {
      return redactText(item, mask) === item;
    }
    if (Array.isArray(item)) {
      return item.every(clean);
    }
    if (item && typeof item === 'object') {
      return Object.entries(item).every(([index, member]) => {
        const key = keys[Number(index)];
        if (key === undefined) {
          return false;
        }
        return isSensitiveKey(key) ? member === '[REDACTED]' : redactKey(key, mask) === key && clean(member);
      });
    }
    return true;
  };
  return clean(parsed);
};
// Non-JSON and walkable JSON are both acceptable outputs; JSON nested past the bound would become the
// marker on the next step.
const accepted = (text: string): boolean => parseJson(text).kind !== 'too-deep';
// An absorbed tail can close text into JSON nested past the bound; it fails closed like any such JSON
// (keeping the bracket outside instead would leave the tail visible). Duplicate keys that masking
// produces are settled by the next step.
const settle = (value: string, mask: Mask): string => {
  const masked = redactText(value, mask);
  return accepted(masked) ? masked : DISTILLATION_TOO_DEEP_MARKER;
};
const redact = (value: string, mask: Mask): string => {
  const json = parseJson(value);
  if (json.kind === 'text') {
    return settle(value, mask);
  }
  if (json.kind === 'too-deep') {
    return DISTILLATION_TOO_DEEP_MARKER;
  }
  if (json.lossy) {
    // The shared rules can span members the parser drops (into kept keys too), and would rewrite a
    // sensitive key before the structured pass judges it if the masked raw text were used; so when they
    // change the raw lossy text at all, the document fails closed before canonicalising (collapsing
    // members is accepted). Sensitivity is judged on the parsed keys.
    return redact(JSON.stringify(redactString(value) === value ? json.value : closed(json.value)), mask);
  }
  const result = redactStructure(json.value, mask);
  return result.changed ? JSON.stringify(result.value) : settle(value, mask);
};
const isRedacted = (value: string, mask: Mask): boolean => {
  const json = parseJson(value);
  if (json.kind === 'text') {
    return redactText(value, mask) === value;
  }
  if (json.kind === 'too-deep') {
    return false;
  }
  if (redactString(value) !== value) {
    return false;
  }
  return json.lossy
    ? cleanLossy(value, mask)
    : JSON.stringify(redactStructure(json.value, mask).value) === JSON.stringify(json.value);
};

const RESCAN_BUDGET = 2 ** 20;
// Each step settles one layer (an absorbed tail, collapsed keys, one nesting level of a credential);
// text that has not converged after this many steps is replaced outright.
const MAX_STEPS = 8;
const step = (text: string): string =>
  isRedacted(text, maskSlots(true, RESCAN_BUDGET)) ? text : redact(text, maskSlots(false, RESCAN_BUDGET));

/**
 * Redacts JSON payloads, nested command strings, and JSON embedded in tool envelopes.
 * Already-redacted text stays byte-identical so packet quotes remain substrings. JSON whose decoded
 * strings or sensitive members change is re-emitted structurally (with its key text redacted);
 * anything else gets the raw-text rules. Members dropped by duplicate keys are never returned
 * unredacted; a duplicate-key document whose every member is already clean stays as it is. JSON
 * nested past DISTILLATION_JSON_MAX_DEPTH becomes DISTILLATION_TOO_DEEP_MARKER instead of throwing.
 * The output is a fixed point: `prepare` rejects event text that redaction would change, and evidence
 * quotes must stay substrings. Inputs whose first output is already stable are unaffected; text still
 * changing after MAX_STEPS steps becomes the placeholder.
 */
export const redactDistillationText = (value: string): string => {
  let text = value;
  for (let count = 0; count < MAX_STEPS; count += 1) {
    const next = step(text);
    if (next === text) {
      return text;
    }
    text = next;
  }
  return '[REDACTED]';
};
