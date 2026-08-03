import { describe, expect, test } from 'bun:test';
import { collectionSourceDefinitions, type SourceControlEntryView } from '@ai-usage/report-core/source-control';
import {
  presentSourceProgress as presentLegacyProgress,
  presentSourceState as presentLegacyState,
} from '../../../source-control-presentation';
import { presentSourceProgress, presentSourceState } from './presentation-model';

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
    { lifecycle: 'pausing', policy: 'disabled' },
    { policy: 'disabled' },
    { availability: 'misconfigured' },
    { availability: 'not-detected' },
    { availability: 'unsupported' },
    { lastOutcome: 'timed-out' },
    { lastOutcome: 'failed' },
    { lifecycle: 'running' },
    { lifecycle: 'queued' },
    { lastOutcome: 'warning' },
    { lastOutcome: 'not-run' },
    { lastOutcome: 'skipped' },
    {},
  ] as const)('preserves the accepted legacy state projection for %o', (overrides) => {
    const value = source(overrides as Partial<SourceControlEntryView>);
    expect(presentSourceState(value)).toEqual(presentLegacyState(value));
  });

  test('preserves indeterminate and bounded progress semantics', () => {
    for (const value of [
      source({ progress: { phase: 'reading' } }),
      source({ progress: { completed: 12, phase: 'importing', total: 10 } }),
    ]) {
      expect(presentSourceProgress(value)).toEqual(presentLegacyProgress(value));
    }
  });
});
