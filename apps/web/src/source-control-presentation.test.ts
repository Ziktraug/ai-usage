import { describe, expect, test } from 'bun:test';
import { collectionSourceDefinitions, type SourceControlEntryView } from '@ai-usage/report-core/source-control';
import {
  presentSourceProgress,
  presentSourceState,
  type SourcePresentationTone,
  sourceToneClass,
} from './source-control-presentation';

const source = (overrides: Partial<SourceControlEntryView> = {}): SourceControlEntryView => ({
  availability: 'detected',
  cadenceMs: collectionSourceDefinitions[0].cadenceMs,
  id: collectionSourceDefinitions[0].id,
  label: collectionSourceDefinitions[0].label,
  lastOutcome: 'success',
  lifecycle: 'scheduled',
  policy: 'enabled',
  reason: { code: 'none' },
  warnings: [],
  ...overrides,
});

describe('source control presentation', () => {
  test.each([
    [{ lifecycle: 'pausing', policy: 'disabled' }, 'Pausing after current run', 'warning'],
    [{ policy: 'disabled' }, 'Disabled', 'info'],
    [{ availability: 'misconfigured' }, 'Misconfigured', 'danger'],
    [{ availability: 'not-detected' }, 'Not detected', 'warning'],
    [{ availability: 'unsupported' }, 'Unsupported', 'warning'],
    [{ lastOutcome: 'timed-out' }, 'Timed out', 'danger'],
    [{ lastOutcome: 'failed' }, 'Failed', 'danger'],
    [{ lifecycle: 'running' }, 'Running', 'ok'],
    [{ lifecycle: 'queued' }, 'Queued', 'info'],
    [{ lastOutcome: 'warning' }, 'Completed with warnings', 'warning'],
    [{ lastOutcome: 'not-run' }, 'Not run yet', 'info'],
    [{ lastOutcome: 'skipped' }, 'Skipped', 'info'],
    [{}, 'Ready', 'ok'],
  ] as const)('maps %o through the shared presentation owner', (overrides, label, tone) => {
    expect(presentSourceState(source(overrides))).toMatchObject({ label, tone });
  });

  test('maps every semantic tone to one shared CSS class', () => {
    const tones: readonly SourcePresentationTone[] = ['danger', 'info', 'ok', 'warning'];
    expect(new Set(tones.map(sourceToneClass)).size).toBe(tones.length);
    expect(tones.every((tone) => sourceToneClass(tone).length > 0)).toBe(true);
  });

  test('keeps phase-only progress indeterminate and bounds determinate values', () => {
    expect(presentSourceProgress(source({ progress: { phase: 'reading' } }))).toEqual({ kind: 'indeterminate' });
    expect(presentSourceProgress(source({ progress: { completed: 12, phase: 'importing', total: 10 } }))).toEqual({
      kind: 'determinate',
      max: 10,
      value: 10,
    });
  });
});
