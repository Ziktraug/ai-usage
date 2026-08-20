import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectionSourceDefinitions, type SourceControlEntryView } from '@ai-usage/report-core/source-control';
import { noSessionInputDetected, sessionHistoryLocations } from './first-run';

const SESSION_SOURCE_IDS = collectionSourceDefinitions
  .filter((definition) => definition.group === 'sessions')
  .map((definition) => definition.id);

const sourceEntry = (
  id: SourceControlEntryView['id'],
  overrides: Partial<SourceControlEntryView> = {},
): SourceControlEntryView => {
  const definition = collectionSourceDefinitions.find((candidate) => candidate.id === id);
  if (!definition) {
    throw new Error(`Unknown collection source: ${id}`);
  }
  return {
    availability: 'not-detected',
    cadenceMs: definition.cadenceMs,
    id: definition.id,
    label: definition.label,
    lastOutcome: 'not-run',
    lifecycle: 'dormant',
    policy: 'enabled',
    reason: { code: 'input-missing' },
    warnings: [],
    ...overrides,
  };
};

const undetectedSessionSources = (
  overridesById: Partial<Record<SourceControlEntryView['id'], Partial<SourceControlEntryView>>> = {},
): readonly SourceControlEntryView[] => SESSION_SOURCE_IDS.map((id) => sourceEntry(id, overridesById[id] ?? {}));

const README_SESSION_TABLE_PATTERN =
  /## Supported session sources\n\n\| Harness \| Local history \|\n\|[^\n]*\|\n([\s\S]*?)\n\n/u;
const README_CODE_SPAN_PATTERN = /`([^`]+)`/gu;
// The panel names the platform a path belongs to; README.md names only the harness.
const HARNESS_PLATFORM_NOTE_PATTERN = / \(macOS\)$/u;

interface SessionSourceCopy {
  readonly harness: string;
  readonly paths: readonly string[];
}

const readmeSessionRows = (): readonly SessionSourceCopy[] => {
  const readme = readFileSync(fileURLToPath(new URL('../../../../../../README.md', import.meta.url)), 'utf8');
  const table = readme.match(README_SESSION_TABLE_PATTERN)?.[1];
  if (!table) {
    throw new Error('README.md no longer exposes a "Supported session sources" table to check the panel copy against.');
  }
  return table.split('\n').map((row) => {
    const cells = row.split('|');
    return {
      harness: (cells[1] ?? '').trim(),
      paths: [...(cells[2] ?? '').matchAll(README_CODE_SPAN_PATTERN)].flatMap((match) => match[1] ?? []),
    };
  });
};

describe('first-run session detection', () => {
  test('reports nothing detected only when every session source is missing its input', () => {
    expect(noSessionInputDetected(undetectedSessionSources())).toBe(true);
  });

  test('stays silent while any session source has detected input', () => {
    expect(
      noSessionInputDetected(
        undetectedSessionSources({
          'codex.sessions': { availability: 'detected', lifecycle: 'scheduled', reason: { code: 'none' } },
        }),
      ),
    ).toBe(false);
  });

  test('stays silent while a source counted input despite reporting no detection now', () => {
    expect(noSessionInputDetected(undetectedSessionSources({ 'claude.sessions': { inputCount: 42 } }))).toBe(false);
  });

  test('treats a deliberately disabled but previously detected source as detected input', () => {
    // Policy is independent from detection: disabling masks the reason as `policy-disabled` while
    // availability still reports what detection found, so onboarding copy must not appear here.
    expect(
      noSessionInputDetected(
        undetectedSessionSources({
          'opencode.sessions': {
            availability: 'detected',
            policy: 'disabled',
            reason: { code: 'policy-disabled', message: 'Collection is disabled.' },
          },
        }),
      ),
    ).toBe(false);
  });

  test('still reports nothing detected when an undetected source was disabled on purpose', () => {
    expect(
      noSessionInputDetected(
        undetectedSessionSources({
          'cursor.sessions': { policy: 'disabled', reason: { code: 'policy-disabled' } },
        }),
      ),
    ).toBe(true);
  });

  test('accepts an unreadable input as undetected input', () => {
    expect(
      noSessionInputDetected(undetectedSessionSources({ 'codex.sessions': { reason: { code: 'input-unreadable' } } })),
    ).toBe(true);
  });

  test.each([
    ['misconfigured', { availability: 'misconfigured', reason: { code: 'misconfigured' } }],
    ['unsupported', { availability: 'unsupported', reason: { code: 'unsupported-platform' } }],
  ] as const)('defers to the deviation card when a session source is %s', (_state, overrides) => {
    // These are recovery states with their own answer; onboarding copy would bury it.
    expect(noSessionInputDetected(undetectedSessionSources({ 'cursor.sessions': overrides }))).toBe(false);
  });

  test('stays silent without any session source to judge', () => {
    expect(noSessionInputDetected([])).toBe(false);
    expect(noSessionInputDetected([sourceEntry('codex.usage-limits')])).toBe(false);
  });
});

describe('first-run history locations', () => {
  test('covers every session source in the catalogue', () => {
    expect(sessionHistoryLocations).toHaveLength(SESSION_SOURCE_IDS.length);
  });

  test('quotes the supported session source table from README.md verbatim', () => {
    const panelCopy: readonly SessionSourceCopy[] = sessionHistoryLocations.map(({ harness, paths }) => ({
      harness: harness.replace(HARNESS_PLATFORM_NOTE_PATTERN, ''),
      paths: [...paths],
    }));
    expect(panelCopy).toEqual(readmeSessionRows());
  });
});
