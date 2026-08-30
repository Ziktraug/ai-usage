import { MEMORY_REDACTION_RULE_SET_VERSION, type MemoryJsonValue, type MemorySensitivity } from './domain';

const redacted = '[REDACTED]';
const sensitiveKeyPattern = /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)$/iu;
const sensitiveValuePatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/gu,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /(?:https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu,
  /\b(?:api[-_]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^\s,;]+/giu,
] as const;

export interface RedactedMemoryValue {
  readonly redacted: boolean;
  readonly ruleSetVersion: typeof MEMORY_REDACTION_RULE_SET_VERSION;
  readonly sensitivity: MemorySensitivity;
  readonly value: MemoryJsonValue;
}

const redactString = (value: string): { readonly changed: boolean; readonly value: string } => {
  let result = value;
  for (const pattern of sensitiveValuePatterns) {
    result = result.replace(pattern, redacted);
  }
  return { changed: result !== value, value: result };
};

const redactValue = (value: MemoryJsonValue): { readonly changed: boolean; readonly value: MemoryJsonValue } => {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((entry) => {
      const item = redactValue(entry);
      changed ||= item.changed;
      return item.value;
    });
    return { changed, value: output };
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const output: Record<string, MemoryJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (sensitiveKeyPattern.test(key)) {
        output[key] = redacted;
        changed = true;
      } else {
        const item = redactValue(entry);
        output[key] = item.value;
        changed ||= item.changed;
      }
    }
    return { changed, value: output };
  }
  return { changed: false, value };
};

export const redactMemoryValue = (
  value: MemoryJsonValue,
  requestedSensitivity: MemorySensitivity,
): RedactedMemoryValue => {
  const result = redactValue(value);
  return {
    redacted: result.changed,
    ruleSetVersion: MEMORY_REDACTION_RULE_SET_VERSION,
    sensitivity: result.changed ? 'sensitive' : requestedSensitivity,
    value: result.value,
  };
};
