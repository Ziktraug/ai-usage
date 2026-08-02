import {
  parseUsageEngineCommandRequest,
  type UsageEngineCommandRequest,
  usageEngineControlBounds,
} from '@ai-usage/usage-engine-control';

export type UsageEngineProcessMode =
  | { readonly mode: 'serve'; readonly port: number }
  | { readonly mode: 'once'; readonly request: UsageEngineCommandRequest }
  | { readonly mode: 'check' };

const canonicalPortPattern = /^(?:0|[1-9]\d{0,4})$/;
const encoder = new TextEncoder();

const parsePort = (value: string): number => {
  if (!canonicalPortPattern.test(value)) {
    throw new Error('Usage engine port must be a canonical decimal integer.');
  }
  const port = Number(value);
  if (!(Number.isSafeInteger(port) && port >= 0 && port <= 65_535)) {
    throw new Error('Usage engine port must be between 0 and 65535.');
  }
  return port;
};

const parseForegroundRequest = (text: string): UsageEngineCommandRequest => {
  if (encoder.encode(text).byteLength > usageEngineControlBounds.maxCommandBytes) {
    throw new Error('Usage engine foreground command exceeds its byte limit.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Usage engine foreground command must be valid JSON.');
  }
  return parseUsageEngineCommandRequest(value);
};

export const parseUsageEngineProcessArguments = (args: readonly string[]): UsageEngineProcessMode => {
  const [mode, ...rest] = args;
  if (mode === 'serve') {
    if (rest.length === 0) {
      return { mode: 'serve', port: 0 };
    }
    if (rest.length === 2 && rest[0] === '--port' && rest[1] !== undefined) {
      return { mode: 'serve', port: parsePort(rest[1]) };
    }
    throw new Error('Usage engine serve syntax is: serve [--port <0..65535>].');
  }
  if (mode === 'once') {
    if (rest.length !== 1 || rest[0] === undefined) {
      throw new Error('Usage engine once syntax is: once <command-request-json>.');
    }
    return { mode: 'once', request: parseForegroundRequest(rest[0]) };
  }
  if (mode === 'check') {
    if (rest.length !== 0) {
      throw new Error('Usage engine check does not accept additional arguments.');
    }
    return { mode: 'check' };
  }
  throw new Error('Usage engine mode must be serve, once, or check.');
};
