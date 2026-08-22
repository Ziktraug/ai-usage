import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { aiUsagePreset } from '@ai-usage/design-system/preset';

const REPORT_COLOR_TOKEN_PATTERN = /token\(colors\.([A-Za-z0-9_.-]+)\)/g;
const REPORT_SOURCE_FILE_PATTERN = /\.(?:svelte|ts)$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const semanticColorPaths = (): ReadonlySet<string> => {
  const colors = aiUsagePreset.theme?.extend?.semanticTokens?.colors as unknown;
  const paths = new Set<string>();
  const visit = (node: unknown, prefix: string): void => {
    if (!isRecord(node)) {
      return;
    }
    if (isRecord(node.value)) {
      paths.add(prefix);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      visit(value, prefix ? `${prefix}.${key}` : key);
    }
  };
  visit(colors, '');
  return paths;
};

const sourceFilesUnder = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFilesUnder(entryPath));
    } else if (REPORT_SOURCE_FILE_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
};

/**
 * Panda does not fail on an undeclared token: it emits the literal `token(colors.x)` into the
 * stylesheet and the colour silently never applies. Nothing downstream — types, build, lint —
 * notices, so the declared set is checked against the source here.
 */
test('Report source references only declared semantic color tokens', () => {
  const appDirectory = path.resolve(import.meta.dir, '..');
  const repositoryDirectory = path.resolve(appDirectory, '../..');
  const sourceFiles = [
    ...sourceFilesUnder(path.join(appDirectory, 'src/lib/features/report')),
    ...sourceFilesUnder(path.join(repositoryDirectory, 'packages/design-system/src/components')),
  ];
  const declaredColors = semanticColorPaths();
  const unknownTokens = new Set<string>();
  for (const sourceFile of sourceFiles) {
    const source = readFileSync(sourceFile, 'utf8');
    for (const match of source.matchAll(REPORT_COLOR_TOKEN_PATTERN)) {
      const token = match[1];
      if (token && !declaredColors.has(token)) {
        unknownTokens.add(token);
      }
    }
  }

  expect([...unknownTokens].toSorted()).toEqual([]);
});

test('Report alerts use warning and danger roles instead of the interaction accent', () => {
  const reportCoreDirectory = path.join(import.meta.dir, 'lib/features/report/core');
  const warningSource = readFileSync(path.join(reportCoreDirectory, 'report-warnings.svelte'), 'utf8');
  const statusSource = readFileSync(path.join(reportCoreDirectory, 'report-status.svelte'), 'utf8');

  expect(warningSource).toContain("borderColor: 'status.warn'");
  expect(warningSource).toContain("bg: 'status.warnSoft'");
  expect(warningSource).not.toContain("bg: 'accentTint'");
  expect(statusSource).toContain("borderColor: 'status.danger'");
  expect(statusSource).toContain("bg: 'status.dangerSoft'");
});
