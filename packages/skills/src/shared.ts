export const skillNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const skillTargetIdPattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const skillTokenDiagnosticCodes = [
  'SkillMarkdownTokenHigh',
  'SkillMarkdownTokenWarning',
  'SkillReferenceTokenHigh',
  'SkillReferenceTokenWarning',
  'SkillTotalTokenHigh',
  'SkillTotalTokenWarning',
] as const;

export type SkillTokenDiagnosticCode = (typeof skillTokenDiagnosticCodes)[number];

export const parseSkillName = (value: unknown): string => {
  if (typeof value !== 'string' || !skillNamePattern.test(value)) {
    throw new Error('skill name must be lowercase kebab-case');
  }
  return value;
};

export const parseTargetId = (value: unknown): string => {
  if (typeof value !== 'string' || !skillTargetIdPattern.test(value)) {
    throw new Error('target id must be lowercase kebab-case');
  }
  return value;
};
