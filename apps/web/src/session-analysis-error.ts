import { SessionDetailValidationError } from '@ai-usage/report-core/session-detail';

export type SessionAnalysisError = { kind: 'terminal'; message: string } | { kind: 'transient'; message: string };

export const classifySessionAnalysisError = (error: unknown): SessionAnalysisError => {
  if (error instanceof SessionDetailValidationError) {
    return { kind: 'terminal', message: error.message };
  }
  return {
    kind: 'transient',
    message: error instanceof Error ? error.message : 'The session analysis could not be loaded.',
  };
};
