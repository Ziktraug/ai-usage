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
// One slot match as masked on its own: `text` replaces whole[start, end) and hides the value up to
// `hidden` (a kept placeholder or a verbatim tail leaves the rest visible). `opener` is where a bare
// value opening a bracket starts, -1 otherwise; `head` is where its head ends.
interface SlotMatch {
  readonly end: number;
  readonly head: number;
  readonly hidden: number;
  readonly opener: number;
  readonly slot: string;
  readonly start: number;
  readonly text: string;
}
// Whether a match from index `from` on starts before `end` and runs past it.
const straddles = (matches: readonly SlotMatch[], from: number, end: number): boolean => {
  for (let index = from; index < matches.length; index += 1) {
    const match = matches[index];
    if (match === undefined || match.start >= end) {
      return false;
    }
    if (match.end > end) {
      return true;
    }
  }
  return false;
};
// More of a nested value than its brackets and separators.
const valueText = /[^\s,:;{}[\]]/u;
// A closing bracket continues a bare value unless the shared rules match text starting there; then the
// tail stays verbatim and they mask it. With keepFilled, an exact placeholder is a filled slot and stays.
// One rescan budget per phase bounds those checks across every string of the text; past it the value
// ends at the bracket as before.
// A bare value opening a bracket is a nested object or array: when its brackets balance (brackets in
// quoted strings do not count) and the extent above leaves more than brackets and separators of it
// visible, the slot covers it whole. It keeps that extent when covering would cut a later match, hide a
// PEM marker (as for tails) or hide text a shared-rule match starts in. Nested values draw on their own
// allowance of the same size, so every tail decision is the one made without them; past it they keep the
// extent above. Without an allowance the mask is the one without nested values.
const maskSlots = (keepFilled: boolean, budget: number, nestedBudget = budget): Mask => {
  let remaining = budget;
  let allowance = nestedBudget;
  const decide = (found: RegExpExecArray, whole: string): SlotMatch => {
    const [match, quote = '', key = '', quoted, head, tail] = found;
    const offset = found.index;
    const end = offset + match.length;
    const headEnd = end - (tail?.length ?? 0);
    const opener = head?.startsWith('{') || head?.startsWith('[') ? headEnd - head.length : -1;
    const slot = `${quote}${key}${quote}: "[REDACTED]"`;
    const replace = (text: string, hidden: number): SlotMatch => ({
      end,
      head: headEnd,
      hidden,
      opener,
      slot,
      start: offset,
      text,
    });
    if (head === undefined || tail === undefined) {
      return replace(keepFilled && quoted !== undefined && placeholders.has(quoted) ? match : slot, end);
    }
    if (tail === '') {
      return replace(keepFilled && head === '[REDACTED' && whole[offset + match.length] === ']' ? match : slot, end);
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
      return replace(match, tailStart);
    }
    return overlap ? replace(`${slot}${tail}`, tailStart) : replace(slot, end);
  };
  // The end of the bracketed value opening at `start`, or -1 when its brackets do not balance within the
  // allowance. In a quoted string a backslash skips the next character. Charges what it reads.
  const balancedEnd = (whole: string, start: number): number => {
    const limit = Math.min(whole.length, start + allowance);
    const closers: string[] = [];
    let quote = '';
    let index = start;
    while (index < limit) {
      const char = whole[index];
      index += 1;
      if (quote !== '') {
        if (char === '\\') {
          index += 1;
        } else if (char === quote) {
          quote = '';
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '{' || char === '[') {
        closers.push(char === '{' ? '}' : ']');
      } else if (char === '}' || char === ']') {
        if (closers.pop() !== char) {
          break;
        }
        if (closers.length === 0) {
          allowance -= index - start;
          return index;
        }
      }
    }
    allowance -= Math.min(index, limit) - start;
    return -1;
  };
  // The end of the nested value `match` opens when its slot covers it whole, otherwise -1.
  const nestedEnd = (whole: string, matches: readonly SlotMatch[], index: number, match: SlotMatch): number => {
    const end = balancedEnd(whole, match.opener);
    if (
      end === -1 ||
      end <= match.hidden ||
      !valueText.test(whole.slice(match.hidden, end)) ||
      straddles(matches, index + 1, end) ||
      whole.slice(match.head, end).includes('-----')
    ) {
      return -1;
    }
    const rest = whole.slice(match.head);
    if (rest.length > allowance) {
      return -1;
    }
    allowance -= rest.length;
    const masked = redactString(rest);
    for (let offset = 0; offset < end - match.head; offset += 1) {
      if (masked[offset] !== rest[offset]) {
        return -1;
      }
    }
    return end;
  };
  return (value) => {
    const matches = Array.from(value.matchAll(quotedSecret), (found) => decide(found, value));
    let output = '';
    let copied = 0;
    for (const [index, match] of matches.entries()) {
      // A match inside a nested value that an earlier slot covers is part of that slot.
      if (match.start >= copied) {
        const end = match.opener === -1 ? -1 : nestedEnd(value, matches, index, match);
        output += value.slice(copied, match.start) + (end === -1 ? match.text : match.slot);
        copied = end === -1 ? match.end : end;
      }
    }
    return output + value.slice(copied);
  };
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
const step = (text: string, nestedBudget: number): string =>
  isRedacted(text, maskSlots(true, RESCAN_BUDGET, nestedBudget))
    ? text
    : redact(text, maskSlots(false, RESCAN_BUDGET, nestedBudget));
// The text the steps settle on, or null when it is still changing after MAX_STEPS steps.
const converge = (value: string, nestedBudget: number): string | null => {
  let text = value;
  for (let count = 0; count < MAX_STEPS; count += 1) {
    const next = step(text, nestedBudget);
    if (next === text) {
      return text;
    }
    text = next;
  }
  return null;
};
// The closing quote of a placeholder, raw or inside a serialized JSON string.
const placeholderEnd = /\[REDACTED\]\\?"/gu;
/**
 * Covering only ever removes text right after a slot. Cut the covered output after every placeholder:
 * the first piece must start the output without covering, each later one must follow in it, the last
 * must end it, and none may overlap (the earliest occurrence of each is the one that leaves the most
 * room). Then every character of the covered output appears verbatim, in order and in the same
 * surroundings, in the output without covering; only text after a placeholder may be gone. Anything else
 * (a later step that turned one text into JSON and not the other, a second pass of a shared rule) could
 * show text the output without covering hides, so that output stands.
 */
const removesOnlyAfterSlots = (covered: string, plain: string): boolean => {
  let from = 0;
  let at = 0;
  for (const match of covered.matchAll(placeholderEnd)) {
    const end = match.index + match[0].length;
    const piece = covered.slice(from, end);
    if (from === 0 && !plain.startsWith(piece)) {
      return false;
    }
    const found = plain.indexOf(piece, at);
    if (found === -1) {
      return false;
    }
    at = found + piece.length;
    from = end;
  }
  if (from === 0) {
    return covered === plain;
  }
  const last = covered.slice(from);
  return plain.endsWith(last) && plain.length - last.length >= at;
};

/**
 * Redacts JSON payloads, nested command strings, and JSON embedded in tool envelopes.
 * Already-redacted text stays byte-identical so packet quotes remain substrings. JSON whose decoded
 * strings or sensitive members change is re-emitted structurally (with its key text redacted);
 * anything else gets the raw-text rules. Members dropped by duplicate keys are never returned
 * unredacted; a duplicate-key document whose every member is already clean stays as it is. JSON
 * nested past DISTILLATION_JSON_MAX_DEPTH becomes DISTILLATION_TOO_DEEP_MARKER instead of throwing.
 * Nested object and array values after a secret key are covered whole, unless the output then differs
 * from the one without covering by more than text removed after slots, or does not settle; then the
 * output without covering stands.
 * The output is a fixed point: `prepare` rejects event text that redaction would change, and evidence
 * quotes must stay substrings. A covered output is a fixed point of the covering steps, so it comes
 * back unchanged. An output without covering is a fixed point of the steps without it, and holds no
 * value covering could apply to: their check rewrites every bracket value after a secret key except a
 * filled `[REDACTED]`, which covering declines, so the covering steps leave it unchanged too. Inputs
 * whose first output is already stable are unaffected; text still changing after MAX_STEPS steps
 * without covering becomes the placeholder.
 */
export const redactDistillationText = (value: string): string => {
  const covered = converge(value, RESCAN_BUDGET);
  // Covering only ever changes text: when the covering check finds nothing to cover it decides exactly as
  // the check without covering, so that check leaves the text alone too.
  if (covered === value) {
    return value;
  }
  const plain = converge(value, 0) ?? '[REDACTED]';
  return covered !== null && (covered === plain || removesOnlyAfterSlots(covered, plain)) ? covered : plain;
};
