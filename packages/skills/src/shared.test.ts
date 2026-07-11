import { describe, expect, test } from 'bun:test';
import { parseSkillName, parseTargetId, type SkillTokenDiagnosticCode, skillTokenDiagnosticCodes } from './shared';

describe('browser-safe skill contracts', () => {
  test('shares canonical name and target validation', () => {
    expect(parseSkillName('example-skill')).toBe('example-skill');
    expect(parseTargetId('standard-agents')).toBe('standard-agents');
    expect(() => parseSkillName('1-example')).toThrow('lowercase kebab-case');
    expect(() => parseTargetId('-target')).toThrow('lowercase kebab-case');
  });

  test('exports all token diagnostic codes as a typed readonly tuple', () => {
    const codes: readonly SkillTokenDiagnosticCode[] = skillTokenDiagnosticCodes;
    expect(codes).toEqual([
      'SkillMarkdownTokenHigh',
      'SkillMarkdownTokenWarning',
      'SkillReferenceTokenHigh',
      'SkillReferenceTokenWarning',
      'SkillTotalTokenHigh',
      'SkillTotalTokenWarning',
    ]);
  });
});
