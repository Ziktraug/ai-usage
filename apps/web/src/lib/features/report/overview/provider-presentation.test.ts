import { describe, expect, test } from 'bun:test';
import type { ProviderLimitWindow } from '@ai-usage/report-core/provider-status';
import {
  providerPercentLabel,
  providerRemainingLabel,
  providerResetLabel,
  providerWindowAriaLabel,
} from './provider-presentation';

const window = (overrides: Partial<ProviderLimitWindow> = {}): ProviderLimitWindow => ({
  blocked: false,
  group: 'weekly',
  id: 'weekly',
  label: 'Weekly',
  limitSeconds: 604_800,
  remainingPercent: 25,
  resetsAt: '2026-06-15T12:00:00.000Z',
  scope: 'provider',
  usedPercent: 75,
  ...overrides,
});

describe('P2 provider quota presentation', () => {
  test('spells out determined used, remaining, and reset semantics', () => {
    const quota = window();
    expect(providerPercentLabel(quota)).toBe('75%');
    expect(providerRemainingLabel(quota)).toBe('25% remaining');
    expect(providerResetLabel(quota)).toContain('Resets');
    expect(providerWindowAriaLabel('Codex', quota)).toContain(
      'Codex Weekly: 75 percent used, 25 percent remaining, resets',
    );
  });

  test('keeps unknown quota indeterminate and never presents it as zero', () => {
    const unknown = window({ remainingPercent: null, resetsAt: null, usedPercent: null });
    expect(providerPercentLabel(unknown)).toBe('Unknown usage');
    expect(providerRemainingLabel(unknown)).toBe('Remaining unknown');
    expect(providerResetLabel(unknown)).toBe('Reset time unknown');
    expect(providerWindowAriaLabel('Codex', unknown)).toBe(
      'Codex Weekly: unknown used percent, unknown remaining percent, reset time unknown',
    );
  });
});
