import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const FORBIDDEN_CLIENT_IMPORTS = ['solid-js', '@ai-usage/design-system/solid'] as const;
const IMPORT_SPECIFIER_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g;

const importSpecifiers = (source: string): readonly string[] =>
  [...source.matchAll(IMPORT_SPECIFIER_PATTERN)].flatMap((match) => (match[1] ? [match[1]] : []));

describe('framework-neutral presentation closure', () => {
  for (const moduleName of ['format.ts', 'report-value.ts']) {
    test(`${moduleName} cannot reach a framework runtime or TSX module`, async () => {
      const source = await readFile(new URL(moduleName, import.meta.url), 'utf8');
      const specifiers = importSpecifiers(source);
      expect(specifiers.some((specifier) => specifier.endsWith('.tsx'))).toBe(false);
      expect(
        specifiers.some((specifier) =>
          FORBIDDEN_CLIENT_IMPORTS.some(
            (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
          ),
        ),
      ).toBe(false);
    });
  }
});
