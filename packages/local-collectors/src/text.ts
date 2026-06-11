import path from 'node:path';

const PREAMBLE =
  /^\s*(#\s*AGENTS\.md|#\s*Context from my IDE|#\s*Files mentioned|<environment_context|<user_instructions|<system-reminder|<command-name|<turn_aborted|<turn_context|Caveat:|The following is the Codex agent history|\[Request interrupted)/i;

export const safeJSON = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

export const base = (p: string | null | undefined) => (p ? path.basename(p) || p : '');

export const dominant = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';

export const cleanPrompt = (s: string) => s.replace(/\s+/g, ' ').trim();

export const usablePrompt = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const c = cleanPrompt(s);
  return c.length >= 3 && !PREAMBLE.test(c) ? c : null;
};
