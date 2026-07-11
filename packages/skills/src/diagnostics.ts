import type { SkillDiagnostic, SkillDiagnosticSeverity } from './contracts';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const createDiagnostic = (
  code: string,
  severity: SkillDiagnosticSeverity,
  message: string,
  details: Omit<SkillDiagnostic, 'code' | 'message' | 'severity'> = {},
): SkillDiagnostic => ({
  code,
  message,
  severity,
  ...details,
});

export const isMissingPathError = (error: unknown): boolean =>
  isRecord(error) && typeof error.code === 'string' && error.code === 'ENOENT';
