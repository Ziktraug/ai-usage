import { type MemoryJsonValue, parseMemoryJsonValue } from './domain';
import { redactMemoryValue } from './redaction';

// Tool outputs often wrap JSON in process diagnostics; parsing the whole output then fails.
const quotedSecret =
  /(["'])([A-Za-z0-9_-]*(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token))\1\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu;
const maskEmbeddedJson = (value: string): string => value.replace(quotedSecret, '$1$2$1: "[REDACTED]"');
const maskStrings = (value: MemoryJsonValue): MemoryJsonValue => {
  if (typeof value === 'string') {
    return maskEmbeddedJson(value);
  }
  if (Array.isArray(value)) {
    return value.map(maskStrings);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, maskStrings(item)]));
  }
  return value;
};

/** Redacts JSON payloads, nested command strings, and JSON embedded in tool envelopes. */
export const redactDistillationText = (value: string): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return String(redactMemoryValue(maskEmbeddedJson(value), 'normal').value);
  }
  const structured = parseMemoryJsonValue(parsed);
  const masked = maskStrings(structured);
  const redacted = redactMemoryValue(masked, 'normal');
  return redacted.redacted || JSON.stringify(masked) !== JSON.stringify(structured)
    ? JSON.stringify(redacted.value)
    : String(redactMemoryValue(maskEmbeddedJson(value), 'normal').value);
};
