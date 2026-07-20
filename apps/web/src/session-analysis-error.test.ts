import { describe, expect, test } from 'bun:test';
import { SessionDetailValidationError } from '@ai-usage/report-core/session-detail';
import { classifySessionAnalysisError } from './session-analysis-error';

describe('session analysis error classification', () => {
  test('classifies an invalid detail contract as terminal', () => {
    expect(classifySessionAnalysisError(new SessionDetailValidationError('Revision mismatch'))).toEqual({
      kind: 'terminal',
      message: 'Revision mismatch',
    });
  });

  test('classifies a transport failure as transient', () => {
    expect(classifySessionAnalysisError(new Error('Connection reset'))).toEqual({
      kind: 'transient',
      message: 'Connection reset',
    });
  });
});
