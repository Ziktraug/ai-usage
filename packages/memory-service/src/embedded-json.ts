// Finds the bracketed JSON documents embedded in a text without parsing a candidate JSON.parse would
// reject, and tells the ones nested past a bound from the ones within it. Internal to the package:
// distillation redaction uses it to keep embedded document discovery linear.

/** Characters a scan may still examine; the caller shares it with its other work. */
export interface ScanBudget {
  remaining: number;
}
const QUOTE = 0x22;
const COMMA = 0x2c;
const COLON = 0x3a;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const jsonWhitespace = new Set(Array.from('\t\n\r ', (char) => char.charCodeAt(0)));
const onlyJsonWhitespace = /^[\t\n\r ]*$/u;
const leadingJsonWhitespace = /^[\t\n\r ]*/u;
/** Whether a character code is JSON whitespace. */
export const isJsonWhitespace = (code: number): boolean => jsonWhitespace.has(code);
// Characters of numbers and of the literals true, false and null.
const scalarCharacters = new Set(Array.from('0123456789+-.eEtrufalsn', (char) => char.charCodeAt(0)));
const jsonLiterals = new Set(['true', 'false', 'null']);
const jsonNumber = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
// The escapes JSON.parse accepts after a backslash, besides \uXXXX.
const shortEscapes = new Set(Array.from('"\\/bfnrt', (char) => char.charCodeAt(0)));
const UNICODE_ESCAPE = 0x75;
// What a container accepts next. Arrays start at VALUE_OR_CLOSE, objects at KEY_OR_CLOSE.
const VALUE_OR_CLOSE = 0;
const VALUE = 1;
const COMMA_OR_CLOSE = 2;
const KEY_OR_CLOSE = 3;
const KEY = 4;
const COLON_NEXT = 5;
// The height of a value is the number of containers on its deepest path: 0 for a scalar, 1 for an empty
// container. Every member counts, so an object's height covers the members a duplicate key hides.
interface Frame {
  // The greatest height of a value read so far.
  deepest: number;
  readonly object: boolean;
  readonly start: number;
  state: number;
}
/**
 * What a scan finds at one opener: no bracketed document JSON.parse accepts there, one nested within the
 * bound, or one nested past it. `end` is the index after its closing bracket.
 */
export type JsonCandidate =
  | { readonly kind: 'none' }
  | { readonly kind: 'json'; readonly end: number }
  | { readonly kind: 'too-deep'; readonly end: number };
const NONE: JsonCandidate = { kind: 'none' };
/**
 * Per opener of one text, what a scan from it finds: the end of the bracketed document JSON.parse would
 * accept there, or -1 when there is none (0 while unscanned), and whether it is nested past `maxDepth`
 * containers.
 */
export interface JsonCandidates {
  readonly ends: Int32Array;
  readonly maxDepth: number;
  readonly tooDeep: Uint8Array;
}
export const newJsonCandidates = (length: number, maxDepth: number): JsonCandidates => ({
  ends: new Int32Array(length),
  maxDepth,
  tooDeep: new Uint8Array(length),
});
const expectsValue = (frame: Frame): boolean => frame.state === VALUE || frame.state === VALUE_OR_CLOSE;
const closes = (frame: Frame, code: number): boolean =>
  frame.object === (code === CLOSE_OBJECT) &&
  (frame.state === COMMA_OR_CLOSE || frame.state === VALUE_OR_CLOSE || frame.state === KEY_OR_CLOSE);
const readValue = (frame: Frame, height: number): void => {
  frame.deepest = Math.max(frame.deepest, height);
  frame.state = COMMA_OR_CLOSE;
};
const isHexDigit = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
// End of the JSON string opening at start, past its closing quote, or -1 when JSON.parse would reject it.
const stringEnd = (text: string, start: number, scan: ScanBudget): number => {
  for (let index = start + 1; index < text.length && scan.remaining > 0; index += 1) {
    scan.remaining -= 1;
    const code = text.charCodeAt(index);
    if (code === QUOTE) {
      return index + 1;
    }
    if (code < 0x20) {
      return -1;
    }
    if (code === BACKSLASH) {
      const marker = text.charCodeAt(index + 1);
      const length = marker === UNICODE_ESCAPE ? 5 : 1;
      const valid =
        marker === UNICODE_ESCAPE
          ? [2, 3, 4, 5].every((offset) => isHexDigit(text.charCodeAt(index + offset)))
          : shortEscapes.has(marker);
      if (!valid) {
        return -1;
      }
      index += length;
      scan.remaining -= length;
    }
  }
  return -1;
};
// The number or literal at index, read into frame: the index after it, or -1 when JSON.parse would reject
// it.
const readScalar = (text: string, index: number, frame: Frame, scan: ScanBudget): number => {
  let end = index + 1;
  while (end < text.length && scalarCharacters.has(text.charCodeAt(end))) {
    end += 1;
  }
  scan.remaining -= end - index - 1;
  const token = text.slice(index, end);
  if (!(jsonLiterals.has(token) || jsonNumber.test(token))) {
    return -1;
  }
  readValue(frame, 0);
  return end;
};
// One token inside a container, other than a bracket: the index after it, or -1 when JSON.parse would
// reject the text there.
const readToken = (text: string, index: number, frame: Frame, scan: ScanBudget): number => {
  const code = text.charCodeAt(index);
  if (jsonWhitespace.has(code)) {
    return index + 1;
  }
  if (code === COMMA) {
    if (frame.state !== COMMA_OR_CLOSE) {
      return -1;
    }
    frame.state = frame.object ? KEY : VALUE;
    return index + 1;
  }
  if (code === COLON) {
    if (frame.state !== COLON_NEXT) {
      return -1;
    }
    frame.state = VALUE;
    return index + 1;
  }
  if (code === QUOTE) {
    const key = frame.state === KEY_OR_CLOSE || frame.state === KEY;
    const end = key || expectsValue(frame) ? stringEnd(text, index, scan) : -1;
    if (end < 0) {
      return -1;
    }
    if (key) {
      frame.state = COLON_NEXT;
    } else {
      readValue(frame, 0);
    }
    return end;
  }
  return scalarCharacters.has(code) && expectsValue(frame) ? readScalar(text, index, frame, scan) : -1;
};
// Decides, from start, exactly what JSON.parse accepts, and the height of what it accepts. Every opener
// the scan meets outside a string, where a value may start, starts in the same state in a scan of its
// own, and both scans read the same text the same way until that opener's container closes or the text
// stops being JSON there: so one scan records the answer of every such opener, and candidate discovery
// over a text stays linear. A grammar error ends every open container.
const scanCandidates = (text: string, start: number, scan: ScanBudget, candidates: JsonCandidates): void => {
  const open: Frame[] = [];
  let index = start;
  while (index >= 0 && index < text.length && scan.remaining > 0) {
    scan.remaining -= 1;
    const code = text.charCodeAt(index);
    const top = open.at(-1);
    if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      if (top !== undefined && !expectsValue(top)) {
        break;
      }
      const object = code === OPEN_OBJECT;
      open.push({ deepest: 0, object, start: index, state: object ? KEY_OR_CLOSE : VALUE_OR_CLOSE });
      index += 1;
    } else if (top === undefined) {
      break;
    } else if (code === CLOSE_ARRAY || code === CLOSE_OBJECT) {
      if (!closes(top, code)) {
        break;
      }
      open.pop();
      const height = top.deepest + 1;
      candidates.ends[top.start] = index + 1;
      candidates.tooDeep[top.start] = height > candidates.maxDepth ? 1 : 0;
      const parent = open.at(-1);
      if (parent === undefined) {
        return;
      }
      readValue(parent, height);
      index += 1;
    } else {
      index = readToken(text, index, top, scan);
    }
  }
  for (const frame of open) {
    candidates.ends[frame.start] = -1;
  }
};
/**
 * The bracketed document opening at start that JSON.parse accepts, within or past the bound of
 * `candidates`, or none. Only an opener no earlier scan over the same table answered is scanned, charging
 * the budget.
 */
export const jsonCandidateAt = (
  text: string,
  start: number,
  budget: ScanBudget,
  candidates: JsonCandidates,
): JsonCandidate => {
  if (candidates.ends[start] === 0) {
    scanCandidates(text, start, budget, candidates);
  }
  const end = candidates.ends[start] ?? -1;
  if (end <= 0) {
    return NONE;
  }
  return { end, kind: candidates.tooDeep[start] === 1 ? 'too-deep' : 'json' };
};
/** How the scanner reads a whole text: a bracketed document within the bound, one past it, or neither. */
export const scanJsonText = (text: string, maxDepth: number): JsonCandidate['kind'] => {
  // JSON.parse also accepts whitespace around the document.
  const start = leadingJsonWhitespace.exec(text)?.[0].length ?? 0;
  const candidate = jsonCandidateAt(
    text,
    start,
    { remaining: Number.POSITIVE_INFINITY },
    newJsonCandidates(text.length, maxDepth),
  );
  return candidate.kind !== 'none' && onlyJsonWhitespace.test(text.slice(candidate.end)) ? candidate.kind : 'none';
};
