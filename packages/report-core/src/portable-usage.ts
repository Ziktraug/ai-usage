export const MAX_PORTABLE_USAGE_ROWS = 50_000;
export const MAX_PORTABLE_USAGE_BYTES = 64 * 1024 * 1024;

const JSON_WHITESPACE_PATTERN = /\s/;
const JSON_HEX_ESCAPE_PATTERN = /^[0-9a-fA-F]{4}$/;

interface JsonStringToken {
  readonly decoded: string | undefined;
  readonly end: number;
}

const decodeSimpleJsonEscape = (character: string): string => {
  switch (character) {
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return character;
  }
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy, plan 127
const readJsonStringToken = (text: string, start: number): JsonStringToken | undefined => {
  let decoded = '';
  let escaped = false;
  for (let index = start + 1; index < text.length; index++) {
    const character = text[index] ?? '';
    if (!escaped) {
      if (character === '"') {
        return { decoded, end: index };
      }
      if (character === '\\') {
        escaped = true;
      } else if (decoded.length <= 4) {
        decoded += character;
      }
      continue;
    }
    escaped = false;
    if (character === 'u') {
      const hexadecimal = text.slice(index + 1, index + 5);
      if (!JSON_HEX_ESCAPE_PATTERN.test(hexadecimal)) {
        return;
      }
      if (decoded.length <= 4) {
        decoded += String.fromCharCode(Number.parseInt(hexadecimal, 16));
      }
      index += 4;
      continue;
    }
    const escapedCharacter = decodeSimpleJsonEscape(character);
    if (decoded.length <= 4) {
      decoded += escapedCharacter;
    }
  }
};

const skipJsonWhitespace = (text: string, start: number): number => {
  let index = start;
  while (JSON_WHITESPACE_PATTERN.test(text[index] ?? '')) {
    index += 1;
  }
  return index;
};

/**
 * How a scan of the keyed array ends: it exceeds the limit, it stops without a verdict (an
 * unreadable string or an unterminated array), or it closes at the returned index.
 */
type TopLevelArrayScan = 'exceeds' | 'stop' | number;

/** The state of one keyed-array scan, created once per scan. */
interface TopLevelArrayState {
  elements: number;
  hasValue: boolean;
  nestedDepth: number;
}

const scanArrayString = (text: string, cursor: number, state: TopLevelArrayState): 'stop' | number => {
  const arrayToken = readJsonStringToken(text, cursor);
  if (!arrayToken) {
    return 'stop';
  }
  if (state.nestedDepth === 0) {
    state.hasValue = true;
  }
  return arrayToken.end;
};

/** Reads the array character at `cursor`; returns where to continue, `closed`, or a verdict. */
const scanArrayCharacter = (
  text: string,
  cursor: number,
  state: TopLevelArrayState,
  maximumElements: number,
): 'closed' | 'exceeds' | 'stop' | number => {
  const arrayCharacter = text[cursor];
  if (arrayCharacter === '"') {
    return scanArrayString(text, cursor, state);
  }
  if (arrayCharacter === '[' || arrayCharacter === '{') {
    if (state.nestedDepth === 0) {
      state.hasValue = true;
    }
    state.nestedDepth += 1;
    return cursor;
  }
  if (arrayCharacter === '}' || (arrayCharacter === ']' && state.nestedDepth > 0)) {
    state.nestedDepth -= 1;
    return cursor;
  }
  if (arrayCharacter === ']' && state.nestedDepth === 0) {
    return state.hasValue && state.elements + 1 > maximumElements ? 'exceeds' : 'closed';
  }
  if (arrayCharacter === ',' && state.nestedDepth === 0) {
    state.elements += 1;
    if (state.elements >= maximumElements) {
      return 'exceeds';
    }
    state.hasValue = false;
    return cursor;
  }
  if (!JSON_WHITESPACE_PATTERN.test(arrayCharacter ?? '') && state.nestedDepth === 0) {
    state.hasValue = true;
  }
  return cursor;
};

/** Scans the elements of the keyed array, from the character after its `[`. */
const scanTopLevelArray = (text: string, start: number, maximumElements: number): TopLevelArrayScan => {
  const state: TopLevelArrayState = { elements: 0, hasValue: false, nestedDepth: 0 };
  for (let cursor = start; cursor < text.length; cursor++) {
    const step = scanArrayCharacter(text, cursor, state, maximumElements);
    if (step === 'closed') {
      return cursor;
    }
    if (step === 'exceeds' || step === 'stop') {
      return step;
    }
    cursor = step;
  }
  return 'stop';
};

/** The scan of the value after a matching top-level key, or null when it is not an array. */
const scanKeyedValue = (text: string, keyEnd: number, maximumElements: number): TopLevelArrayScan | null => {
  let cursor = skipJsonWhitespace(text, keyEnd + 1);
  if (text[cursor] === ':') {
    cursor = skipJsonWhitespace(text, cursor + 1);
    if (text[cursor] === '[') {
      return scanTopLevelArray(text, cursor + 1, maximumElements);
    }
  }
  return null;
};

/** Reads the string at `index`; returns the index to continue from, or a verdict. */
const scanTopLevelString = (
  text: string,
  index: number,
  objectDepth: number,
  key: string,
  maximumElements: number,
): TopLevelArrayScan => {
  const token = readJsonStringToken(text, index);
  if (!token) {
    return 'stop';
  }
  if (objectDepth === 1 && token.decoded === key) {
    const scan = scanKeyedValue(text, token.end, maximumElements);
    if (scan !== null) {
      return scan;
    }
  }
  return token.end;
};

const topLevelArrayExceedsLimit = (text: string, key: string, maximumElements: number): boolean => {
  let objectDepth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const scan = scanTopLevelString(text, index, objectDepth, key, maximumElements);
      if (scan === 'exceeds') {
        return true;
      }
      if (scan === 'stop') {
        return false;
      }
      index = scan;
    } else if (character === '{') {
      objectDepth += 1;
    } else if (character === '}') {
      objectDepth -= 1;
    }
  }
  return false;
};

export const assertPortableUsageTopLevelRowsPreflight = (
  text: string,
  label: string,
  maxRows = MAX_PORTABLE_USAGE_ROWS,
): void => {
  if (!(Number.isSafeInteger(maxRows) && maxRows >= 0)) {
    throw new Error(`${label} row limit is invalid`);
  }
  if (topLevelArrayExceedsLimit(text, 'rows', maxRows)) {
    throw new Error(`${label} contains more than ${maxRows} rows; maximum is ${maxRows}`);
  }
};

export const assertPortableUsageByteLength = (
  text: string,
  label: string,
  maxBytes = MAX_PORTABLE_USAGE_BYTES,
): number => {
  const actualBytes = new TextEncoder().encode(text).byteLength;
  if (actualBytes > maxBytes) {
    throw new Error(`${label} contains ${actualBytes} bytes; maximum is ${maxBytes}`);
  }
  return actualBytes;
};

export const assertPortableUsageRowCount = (
  rows: readonly unknown[],
  label: string,
  maxRows = MAX_PORTABLE_USAGE_ROWS,
): void => {
  if (rows.length > maxRows) {
    throw new Error(`${label} contains ${rows.length} rows; maximum is ${maxRows}`);
  }
};
