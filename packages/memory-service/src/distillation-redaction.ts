import type { MemoryJsonValue } from './domain';
import { isJsonWhitespace, type JsonCandidates, jsonCandidateAt, newJsonCandidates } from './embedded-json';
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
// Key text gets the text rules. A key the shared rules judge sensitive (on its original text, so its value
// is already the placeholder) keeps its text when they would make it stop looking sensitive: they read
// some sensitive names themselves as credentials (`secret:token`, `settings.database.password`), and
// the key must stay sensitive so the next pass emits the same structure. A credential inside it
// (`https:\/\/u:p@h\/token`) still goes.
const isSensitiveKey = (key: string): boolean => redactMemoryValue({ [key]: null }, 'normal').redacted;
const redactKey = (key: string, mask: Mask): string => {
  const text = redactText(key, mask);
  return text === key || !isSensitiveKey(key) || isSensitiveKey(text) ? text : key;
};
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
// In text JSON.parse accepted, every string token followed by a colon is an object key. The string is
// written as runs between escapes: one alternation per character makes long strings hundreds of times
// slower to match.
const keyToken = /"[^"\\]*(?:\\.[^"\\]*)*"(\s*:)?/gu;
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
interface ParsedJson {
  readonly kind: 'json';
  readonly lossy: boolean;
  readonly value: MemoryJsonValue;
}
type ParsedText = { readonly kind: 'text' } | { readonly kind: 'too-deep' } | ParsedJson;
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
// is renamed to its position so nothing collapses. Every key goes to the key judgement; sensitivity is
// judged on the original key, a sensitive member must hold the placeholder, and every other string goes
// to the text judgement.
const everyMember = (
  value: string,
  cleanText: (text: string) => boolean,
  cleanKey: (key: string) => boolean,
): boolean => {
  const { keys, renamed } = renameKeys(value);
  const parsed: unknown = JSON.parse(renamed);
  // parseJson already bounded the nesting of this renamed form; this only narrows the type.
  if (!isWalkableJson(parsed, DISTILLATION_JSON_MAX_DEPTH)) {
    return false;
  }
  const clean = (item: MemoryJsonValue): boolean => {
    if (typeof item === 'string') {
      return cleanText(item);
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
        return cleanKey(key) && (isSensitiveKey(key) ? member === '[REDACTED]' : clean(member));
      });
    }
    return true;
  };
  return clean(parsed);
};
// Each member judged as redactStructure judges it: key text through redactKey (which keeps a sensitive
// key as it is), strings through the mask and the shared rules.
const cleanLossy = (value: string, mask: Mask): boolean =>
  everyMember(
    value,
    (item) => redactText(item, mask) === item,
    (key) => redactKey(key, mask) === key,
  );
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
  if (result.changed) {
    return JSON.stringify(result.value);
  }
  // A secret the raw text escapes inside a key (`https:\/\/user:password@host`) only shows to the rules
  // once decoded: when the raw-text rules leave the text alone but a key redacts, the structure is
  // re-emitted with its keys redacted.
  const settled = settle(value, mask);
  const keyed = JSON.stringify(result.value);
  return settled === value && keyed !== JSON.stringify(json.value) ? keyed : settled;
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
// Characters one nested pass may examine or hand to JSON.parse, across every document at every level, per
// character of the text it is given. Each level of string nesting doubles the backslashes before the
// quotes inside it, so about 17 levels fit in 256 KiB, and each level reads the text it nests a bounded
// number of times: measured over key, value, envelope, literal, mixed and duplicate-key chains, around
// content within and outside the Memory domain limits (empty and over-long keys, non-finite numbers, more
// than 10 000 nodes, nesting up to 255 and past the bound), at every depth that fits in 64 KiB and
// 256 KiB, a pass charges at most about 48 per character (a 14-level envelope chain beside a document past
// the bound; duplicate-key chains whose innermost member is unclean at most 24, since each text is judged
// once per pass). Past the budget the rest of the text keeps the output of the earlier rules. A floor
// covers short texts.
const SCAN_BUDGET_PER_CHARACTER = 256;
const MIN_SCAN_BUDGET = 2 ** 16;
// Each step settles one layer (an absorbed tail, collapsed keys, one nesting level of a credential);
// text that has not converged after this many steps is replaced outright.
const MAX_STEPS = 8;

// The rules above judge JSON only when the whole text parses, and mask only the decoded strings of it:
// JSON embedded in tool envelopes (also printed as an escaped string literal), and JSON escaped inside
// JSON strings, reach them as raw text. The nested pass gives every such document the rules above as if
// it were the whole text. It runs after the rules above, so documents they damage first (container values
// under sensitive keys, which a slot covers whole; sensitive dotted keys the shared token-shaped rule
// rewrites) are judged only as far as they survive. One scan per pass shares the character budget and the
// mask rescan budgets across all documents at all levels; past the budget the rest of the text stays as
// the rules above left it.
interface Scan {
  // Documents without strings that the shared rules leave unchanged; see bracketedAt.
  readonly clean: Set<string>;
  // Texts nested already judged in this pass; see nested.
  readonly judged: Map<string, string>;
  readonly keep: Mask;
  readonly mask: Mask;
  remaining: number;
}
// The pass never covers nested values: covering is kept only where the whole text's output without it
// shows everything the covered one does (see redactRules), and a document the pass re-emits breaks that
// comparison.
const newScan = (text: string): Scan => ({
  clean: new Set(),
  judged: new Map(),
  keep: maskSlots(true, RESCAN_BUDGET, 0),
  mask: maskSlots(false, RESCAN_BUDGET, 0),
  remaining: Math.max(MIN_SCAN_BUDGET, SCAN_BUDGET_PER_CHARACTER * text.length),
});
const opensDocument = /^[\t\n\r ]*["[{]/u;
// Text that does not open a document, or that the budget cannot cover, is text; the text inside it is
// still scanned.
const documentOf = (text: string, scan: Scan): ParsedText => {
  if (!opensDocument.test(text)) {
    return { kind: 'text' };
  }
  if (text.length > scan.remaining) {
    scan.remaining = 0;
    return { kind: 'text' };
  }
  scan.remaining -= text.length;
  return parseJson(text);
};
const QUOTE = 0x22;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const OPEN_OBJECT = 0x7b;
// End of the JSON string literal opening at start when it holds an escape, or -1. A literal without one
// decodes to its raw text, which the rules above already judged in place.
const escapedLiteralEnd = (text: string, start: number, scan: Scan): number => {
  let escaped = false;
  for (let index = start + 1; index < text.length && scan.remaining > 0; index += 1) {
    scan.remaining -= 1;
    const code = text.charCodeAt(index);
    if (code === BACKSLASH) {
      escaped = true;
      index += 1;
      scan.remaining -= 1;
    } else if (code === QUOTE) {
      return escaped ? index + 1 : -1;
    } else if (code < 0x20) {
      return -1;
    }
  }
  return -1;
};
interface Segment {
  readonly end: number;
  readonly text: string;
}
// A bracketed document is a segment even when judging leaves it unchanged: its strings are walked. Only
// a candidate the scan accepts is parsed, and it is then consumed whole, so parsing stays linear too; the
// openers inside a rejected one are still scanned. A candidate nested past the bound fails closed in
// place, as the whole text would, before anything in it is read. documentOf still guards the parse: a
// candidate the budget cannot cover is skipped like one the scan rejected.
const bracketedAt = (text: string, start: number, scan: Scan, candidates: JsonCandidates): Segment | null => {
  const candidate = jsonCandidateAt(text, start, scan, candidates);
  if (candidate.kind === 'none') {
    return null;
  }
  const { end } = candidate;
  if (candidate.kind === 'too-deep') {
    return { end, text: DISTILLATION_TOO_DEEP_MARKER };
  }
  const segment = text.slice(start, end);
  if (!segment.includes('"') && unchangedWithoutStrings(segment, scan)) {
    return { end, text: segment };
  }
  const json = documentOf(segment, scan);
  if (json.kind === 'text') {
    return null;
  }
  return { end, text: json.kind === 'too-deep' ? DISTILLATION_TOO_DEEP_MARKER : judge(segment, json, scan) };
};
// A document without strings has no keys and no string values, so judge returns it unchanged unless the
// shared rules change its raw text; it is kept as it is, without parsing. documentOf is not needed as a
// guard: the span holds no literal and no document with strings, so even a candidate the parser would
// reject keeps the same text as skipping it would. Inside an unchanged literal such a document reads the
// same at every level of string nesting, so the check is remembered for the pass.
const unchangedWithoutStrings = (segment: string, scan: Scan): boolean => {
  if (scan.clean.has(segment)) {
    return true;
  }
  if (redactString(segment) !== segment) {
    return false;
  }
  scan.clean.add(segment);
  return true;
};
// A literal followed by a colon is an object key.
const keyFollows = (text: string, end: number, scan: Scan): boolean => {
  for (let index = end; index < text.length && scan.remaining > 0; index += 1) {
    scan.remaining -= 1;
    const code = text.charCodeAt(index);
    if (!isJsonWhitespace(code)) {
      return code === COLON;
    }
  }
  return false;
};
// A string literal is a segment only when judging changes it. Otherwise its closing quote stays a
// possible opening one, so a closing quote mistaken for an opening one cannot hide the next literal. A key
// gets the key text rules a whole document's rules give it (see redact), then is judged as walk judges
// keys, so a document cut after a key judges it as the whole document does; a key text the rules leave
// alone as a key they also leave alone as a value, so a cut before the colon judges it the same.
const changedLiteralAt = (text: string, start: number, scan: Scan): Segment | null => {
  const end = escapedLiteralEnd(text, start, scan);
  if (end < 0) {
    return null;
  }
  const literal = text.slice(start, end);
  const json = documentOf(literal, scan);
  if (json.kind !== 'json' || typeof json.value !== 'string') {
    return null;
  }
  if (keyFollows(text, end, scan)) {
    const ruled = redactKey(json.value, scan.keep) === json.value ? json.value : redactKey(json.value, scan.mask);
    const key = nested(ruled, scan);
    return key === json.value ? null : { end, text: bounded(JSON.stringify(key), literal) };
  }
  const judged = judge(literal, json, scan);
  return judged === literal ? null : { end, text: judged };
};
// Embedded documents, left to right: maximal objects and arrays, and JSON string literals holding
// escapes, opening at a quote no backslash escapes. A candidate that does not close or parse leaves the
// text after its opener to be scanned. Unchanged documents leave the text byte-identical.
const embedded = (text: string, scan: Scan): string => {
  let output = '';
  let copied = 0;
  let index = 0;
  let backslashes = 0;
  let candidates: JsonCandidates | null = null;
  while (index < text.length && scan.remaining > 0) {
    scan.remaining -= 1;
    const code = text.charCodeAt(index);
    let segment: Segment | null = null;
    if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      candidates ??= newJsonCandidates(text.length, DISTILLATION_JSON_MAX_DEPTH);
      segment = bracketedAt(text, index, scan, candidates);
    } else if (code === QUOTE && backslashes % 2 === 0) {
      segment = changedLiteralAt(text, index, scan);
    }
    if (segment === null) {
      backslashes = code === BACKSLASH ? backslashes + 1 : 0;
      index += 1;
    } else {
      // A segment ends in a bracket or a quote, so no backslash run continues past it.
      output += text.slice(copied, index) + segment.text;
      copied = segment.end;
      index = segment.end;
      backslashes = 0;
    }
  }
  return output + text.slice(copied);
};
// Decoded strings and keys are judged as texts of their own. The nested pass replaces only documents,
// which end in a bracket or a quote, so a sensitive key keeps its sensitive ending and its member the
// placeholder; the shared rules never run on keys here. A changed document is re-emitted; a lossy one as
// the members JSON.parse keeps, judged in the same pass so nested duplicate-key documents do not take a
// step per level.
// Re-emitting a document or a key literal writes every string nested in it with short escapes. A text
// that spells each level's escapes as \u sequences grows linearly per level while short escapes double
// per level, so a re-emitted text that outgrows the text it replaces past this bound fails closed instead.
// Redaction itself grows a text by less: a slot replaces at least the key's separator and a one-character
// value.
const MAX_REEMITTED_GROWTH = 4;
const REEMITTED_SLACK = 1024;
const bounded = (judged: string, text: string): string =>
  judged.length > MAX_REEMITTED_GROWTH * text.length + REEMITTED_SLACK ? '[REDACTED]' : judged;
const walk = (text: string, json: ParsedJson, scan: Scan): string => {
  if (json.lossy) {
    const clean = everyMember(
      text,
      (item) => nested(item, scan) === item,
      (key) => nested(key, scan) === key,
    );
    if (clean) {
      return text;
    }
    const kept = JSON.stringify(json.value);
    const keptJson = documentOf(kept, scan);
    if (keptJson.kind === 'text') {
      return kept;
    }
    return keptJson.kind === 'too-deep' ? DISTILLATION_TOO_DEEP_MARKER : bounded(judge(kept, keptJson, scan), text);
  }
  const mapped = JSON.stringify(
    mapJson(
      json.value,
      (item) => nested(item, scan),
      (key) => nested(key, scan),
    ),
  );
  return mapped === JSON.stringify(json.value) ? text : bounded(mapped, text);
};
// A document first gets the rules above, as a whole text would; what they leave is walked when it still
// parses. None of those rules deepens a document, so the marker here is only fail-closed.
const judge = (text: string, json: ParsedJson, scan: Scan): string => {
  const redacted = isRedacted(text, scan.keep) ? text : redact(text, scan.mask);
  if (redacted === text) {
    return walk(text, json, scan);
  }
  const next = documentOf(redacted, scan);
  if (next.kind === 'text') {
    return redacted;
  }
  return next.kind === 'too-deep' ? DISTILLATION_TOO_DEEP_MARKER : walk(redacted, next, scan);
};
// Every call and every character examined or parsed is charged, so the pass always ends. A text that is
// JSON nested past the bound fails closed, as a whole text does. A text judged once in the pass keeps that
// judgement: a lossy document's members are judged to find it unclean and again in its kept form, which
// would otherwise double the work per level of nested duplicate-key documents.
const nested = (text: string, scan: Scan): string => {
  const known = scan.judged.get(text);
  if (known !== undefined) {
    return known;
  }
  if (scan.remaining <= 0) {
    return text;
  }
  scan.remaining -= 1;
  const json = documentOf(text, scan);
  let judged: string;
  if (json.kind === 'text') {
    judged = embedded(text, scan);
  } else {
    judged = json.kind === 'too-deep' ? DISTILLATION_TOO_DEEP_MARKER : judge(text, json, scan);
  }
  scan.judged.set(text, judged);
  return judged;
};
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
interface Settled {
  // Whether a covered output stood where it differs from the output without covering.
  readonly covered: boolean;
  readonly text: string;
}
/**
 * The rules above, settled, with nested object and array values after a secret key covered whole unless
 * the output then differs from the one without covering by more than text removed after slots, or does
 * not settle; then the output without covering stands. A covered output is a fixed point of the covering
 * steps, so it comes back unchanged. An output without covering is a fixed point of the steps without it,
 * and holds no value covering could apply to: their check rewrites every bracket value after a secret key
 * except a filled `[REDACTED]`, which covering declines, so the covering steps leave it unchanged too.
 */
const redactRules = (value: string): Settled => {
  const covered = converge(value, RESCAN_BUDGET);
  // Covering only ever changes text: when the covering check finds nothing to cover it decides exactly as
  // the check without covering, so that check leaves the text alone too.
  if (covered === value) {
    return { covered: false, text: value };
  }
  const plain = converge(value, 0) ?? '[REDACTED]';
  return covered !== null && covered !== plain && removesOnlyAfterSlots(covered, plain)
    ? { covered: true, text: covered }
    : { covered: false, text: plain };
};
// Rules and nested pass alternate until neither changes the text: with covering, the rules of
// redactRules; without it, the steps that never cover. Text still changing after MAX_STEPS rounds becomes
// the placeholder.
const settleRounds = (value: string, covering: boolean): Settled => {
  let text = value;
  let covered = false;
  for (let count = 0; count < MAX_STEPS; count += 1) {
    let next: string;
    if (covering) {
      const ruled = redactRules(text);
      covered ||= ruled.covered;
      next = ruled.text;
    } else {
      next = converge(text, 0) ?? '[REDACTED]';
    }
    if (next === text) {
      next = nested(text, newScan(text));
    }
    if (next === text) {
      return { covered, text };
    }
    text = next;
  }
  return { covered, text: '[REDACTED]' };
};
const isWhitespace = (char: string | undefined): boolean =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r';
const PLACEHOLDER = '[REDACTED]';
// Where outputs write a whole value as a placeholder: a quoted `[REDACTED]` whose quotes sit at the same
// level of string escaping, with the colon and whitespace before it (a slot writes `"key": "[REDACTED]"`,
// JSON.stringify `"key":"[REDACTED]"`), or the too-deep marker. Any other `[REDACTED]` (inside a value,
// next to text the rules left) is text. Each character is read a bounded number of times.
const valueSlots = (text: string): (readonly [number, number])[] => {
  const slots: (readonly [number, number])[] = [];
  let floor = 0;
  let at = text.indexOf('[REDACTED', floor);
  while (at !== -1) {
    let start = -1;
    let end = -1;
    if (text.startsWith(DISTILLATION_TOO_DEEP_MARKER, at)) {
      start = at;
      end = at + DISTILLATION_TOO_DEEP_MARKER.length;
    } else if (text.startsWith(PLACEHOLDER, at) && at - 1 >= floor && text[at - 1] === '"') {
      let open = at - 1;
      while (open > floor && text[open - 1] === '\\') {
        open -= 1;
      }
      const escapes = at - 1 - open;
      const close = at + PLACEHOLDER.length;
      if (text.slice(close, close + escapes) === '\\'.repeat(escapes) && text[close + escapes] === '"') {
        start = open;
        end = close + escapes + 1;
        while (start > floor && isWhitespace(text[start - 1])) {
          start -= 1;
        }
        if (start > floor && text[start - 1] === ':') {
          start -= 1;
          while (start > floor && isWhitespace(text[start - 1])) {
            start -= 1;
          }
        }
      }
    }
    if (start === -1) {
      at = text.indexOf('[REDACTED', at + 1);
    } else {
      slots.push([start, end]);
      floor = end;
      at = text.indexOf('[REDACTED', end);
    }
  }
  return slots;
};
const withoutWhitespace = (text: string): string => text.replace(/[\t\n\r ]+/gu, '');
/**
 * Whether `shown` shows only what `other` shows: every run of `shown` between whole-value placeholders
 * appears in `other`, in order and without overlap, whitespace aside. Such a placeholder may stand for any
 * text of `other`, so a document the nested pass re-emitted (compact, with its values slotted) compares
 * too; a placeholder glued to text must match as text, so a value the rules redacted only in part keeps
 * its field. Any text `shown` shows lies within one run, so `other` shows it as well.
 */
const showsOnlyWhatOtherShows = (shown: string, other: string): boolean => {
  const target = withoutWhitespace(other);
  let at = 0;
  let from = 0;
  for (const [start, end] of [...valueSlots(shown), [shown.length, shown.length] as const]) {
    const run = withoutWhitespace(shown.slice(from, start));
    const found = target.indexOf(run, at);
    if (found === -1) {
      return false;
    }
    at = found + run.length;
    from = end;
  }
  return true;
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
 * Once those rules leave the text unchanged, every JSON document embedded in non-JSON text or nested in
 * the decoded strings and keys of JSON (objects, arrays and escaped string literals) is judged the same
 * way, without covering, at every level, within a scan budget; an embedded document nested past
 * DISTILLATION_JSON_MAX_DEPTH becomes DISTILLATION_TOO_DEEP_MARKER in place. Rules and pass alternate
 * until neither changes the text.
 * A covered value can keep a document from the nested pass that the output without covering lets it
 * judge (a slot covering a value whole leaves a truncated enclosing object unclosed). So once a covered
 * output has stood, the rounds also run without covering, and the covered output is kept only when it
 * shows only what that output shows; otherwise the text becomes the placeholder.
 * The output is a fixed point: `prepare` rejects event text that redaction would change, and evidence
 * quotes must stay substrings. The output kept is one the rounds with covering leave unchanged, and they
 * do so without a covered output standing, so it comes back as it is.
 */
export const redactDistillationText = (value: string): string => {
  const withCovering = settleRounds(value, true);
  if (!withCovering.covered) {
    return withCovering.text;
  }
  const without = settleRounds(value, false).text;
  return withCovering.text === without || showsOnlyWhatOtherShows(withCovering.text, without)
    ? withCovering.text
    : '[REDACTED]';
};
