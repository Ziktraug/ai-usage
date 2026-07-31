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
  return;
};

const skipJsonWhitespace = (text: string, start: number): number => {
  let index = start;
  while (JSON_WHITESPACE_PATTERN.test(text[index] ?? '')) {
    index += 1;
  }
  return index;
};

const topLevelArrayExceedsLimit = (text: string, key: string, maximumElements: number): boolean => {
  let objectDepth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      const token = readJsonStringToken(text, index);
      if (!token) {
        return false;
      }
      if (objectDepth === 1 && token.decoded === key) {
        let cursor = skipJsonWhitespace(text, token.end + 1);
        if (text[cursor] === ':') {
          cursor = skipJsonWhitespace(text, cursor + 1);
          if (text[cursor] === '[') {
            let nestedDepth = 0;
            let elements = 0;
            let hasValue = false;
            for (cursor += 1; cursor < text.length; cursor++) {
              const arrayCharacter = text[cursor];
              if (arrayCharacter === '"') {
                const arrayToken = readJsonStringToken(text, cursor);
                if (!arrayToken) {
                  return false;
                }
                if (nestedDepth === 0) {
                  hasValue = true;
                }
                cursor = arrayToken.end;
              } else if (arrayCharacter === '[' || arrayCharacter === '{') {
                if (nestedDepth === 0) {
                  hasValue = true;
                }
                nestedDepth += 1;
              } else if (arrayCharacter === '}' || (arrayCharacter === ']' && nestedDepth > 0)) {
                nestedDepth -= 1;
              } else if (arrayCharacter === ']' && nestedDepth === 0) {
                if (hasValue && elements + 1 > maximumElements) {
                  return true;
                }
                index = cursor;
                break;
              } else if (arrayCharacter === ',' && nestedDepth === 0) {
                elements += 1;
                if (elements >= maximumElements) {
                  return true;
                }
                hasValue = false;
              } else if (!JSON_WHITESPACE_PATTERN.test(arrayCharacter ?? '') && nestedDepth === 0) {
                hasValue = true;
              }
            }
            if (cursor >= text.length) {
              return false;
            }
            continue;
          }
        }
      }
      index = token.end;
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
