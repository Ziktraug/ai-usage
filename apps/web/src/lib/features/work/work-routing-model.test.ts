import { describe, expect, test } from 'bun:test';
import { qualifyReviewCandidates, type ReviewTarget } from '@ai-usage/report-core/work-routing';
import type { WorkRoutingContext, WorkRoutingQualification } from '@ai-usage/web-contract/work-routing';
import { identityLine, qualificationFreshnessText, qualificationHeadline, routingSummary } from './work-routing-model';

const NOW = '2026-10-22T10:00:00.000Z';
const TARGET: ReviewTarget = {
  harness: 'claude',
  kind: 'session',
  machineId: 'machine-a',
  projectLabel: 'elsewhere',
  sourceSessionId: 'session-a',
};
const context: WorkRoutingContext = {
  configPath: '/home/operator/.config/ai-usage/config.json',
  declarationErrors: [],
  declarations: [
    {
      accountScope: 'personal',
      authorization: 'allowed',
      capabilities: ['read-only-review'],
      declaredAt: '2026-10-21T08:00:00.000Z',
      effort: null,
      harness: 'claude-code',
      machineId: 'machine-a',
      model: null,
      quality: 'review-capable',
      subscription: 'verified',
      targets: [{ kind: 'project', projectLabel: 'ai-usage' }],
    },
  ],
  executorObservations: [
    {
      authEvidence: 'claude auth status exit 0 loggedIn=true',
      authMethod: null,
      authState: 'logged-in',
      binaryPath: '/usr/bin/claude',
      harness: 'claude-code',
      machineId: 'machine-a',
      observedAt: '2026-10-22T09:00:00.000Z',
      outcome: 'observed',
      version: null,
    },
    {
      authEvidence: 'codex binary not found on PATH',
      authMethod: null,
      authState: 'unknown',
      binaryPath: null,
      harness: 'codex',
      machineId: 'machine-a',
      observedAt: '2026-10-22T09:59:00.000Z',
      outcome: 'unavailable',
      version: null,
    },
  ],
  generatedAt: NOW,
  machineId: 'machine-a',
};

describe('Work routing qualification summary', () => {
  test('words a stale observation, an unadmitted target and an uninstalled CLI from their own sources', () => {
    const candidates = qualifyReviewCandidates({
      declarations: context.declarations,
      executorObservations: context.executorObservations,
      now: NOW,
      providers: [],
      target: TARGET,
    });
    const [claude, codex] = routingSummary({ candidates, context, referenceTime: NOW, target: TARGET });
    expect(claude?.detected).toBe(
      'Detected: claude (version unknown) · signed in · no account reported · observed 2026-10-22T09:00:00.000Z (stale).',
    );
    expect(claude?.declared).toEqual([
      'Declared: account personal · allowed · subscription verified · no model declared · targets project ai-usage · account not pinned · declared 2026-10-21T08:00:00.000Z.',
    ]);
    expect(claude?.target).toBe('Target: this session is outside the declared targets.');
    expect(claude?.missing.some((action) => action.startsWith('Declared targets do not admit this session'))).toBe(
      true,
    );
    expect(codex?.detected).toContain('codex (version unknown) · not installed or not runnable');
    expect(routingSummary({ candidates, context, referenceTime: NOW, target: null }).map((row) => row.target)).toEqual([
      'Target: no session identity, so no authorization can be bound to it.',
      'Target: no session identity, so no authorization can be bound to it.',
    ]);
  });

  test('never words a pinned account as observed', () => {
    expect(identityLine({ declared: '0123456789abcdef', observed: null, state: 'unobserved' })).toBe(
      'Account: 0123456789abcdef is pinned (declared), but no current observation reports the signed-in account.',
    );
  });

  test('headlines the engine decision and says when its observation was not refreshed', () => {
    const qualification: WorkRoutingQualification = {
      candidates: [],
      chosenCandidateId: null,
      executors: { outcome: 'timed-out', refreshed: false },
      omittedCandidates: 0,
      qualifiedAt: NOW,
      reasons: [],
      recommendation: { candidateId: null, kind: 'none', missing: null },
    };
    expect(qualificationHeadline(qualification)).toBe(
      'No eligible candidate: see each candidate’s exclusions and missing facts.',
    );
    expect(qualificationFreshnessText(qualification)).toContain(
      'executors not refreshed: the executor observation timed out, so the stored observations were used',
    );
  });
});
