import { describe, expect, test } from 'bun:test';
import { collectionSourceDefinitions, type SourceControlEntryView } from '@ai-usage/report-core/source-control';
import { presentSourceProgress, presentSourceState } from '../../../source-control-presentation-model';

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

describe('Sources framework-neutral presentation model', () => {
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
  ] as const)('preserves the accepted product projection for %o', (overrides, label, tone) => {
    expect(presentSourceState(source(overrides))).toMatchObject({ label, tone });
  });

  test('preserves indeterminate and bounded progress semantics', () => {
    expect(presentSourceProgress(source({ progress: { phase: 'reading' } }))).toEqual({ kind: 'indeterminate' });
    expect(presentSourceProgress(source({ progress: { completed: 12, phase: 'importing', total: 10 } }))).toEqual({
      kind: 'determinate',
      max: 10,
      value: 10,
    });
  });
});
