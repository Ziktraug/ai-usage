import { describe, expect, test } from 'bun:test';
import type { ProjectionState, SkillDiagnostic, SkillValidationStatus } from '@ai-usage/skills';
import { deriveInstallationAction, groupSkillDiagnostics } from './skill-document-inspector-model';

const skillState = (
  overrides: Partial<{ enabled: boolean; validationStatus: SkillValidationStatus }> = {},
): { enabled: boolean; validationStatus: SkillValidationStatus } => ({
  enabled: true,
  validationStatus: 'valid',
  ...overrides,
});

const directlyReconciliableStates = new Set<ProjectionState>(['missing', 'broken-link', 'wrong-target']);

const exposures = (...states: ProjectionState[]): readonly { canReconcile: boolean; state: ProjectionState }[] =>
  states.map((state) => ({ canReconcile: directlyReconciliableStates.has(state), state }));

describe('skill document inspector model', () => {
  test('groups identical diagnostic codes and messages while preserving severity and paths', () => {
    const diagnostics: readonly SkillDiagnostic[] = [
      {
        code: 'UnreadableSkillReferenceFile',
        message: 'Skill reference file could not be read',
        path: '/skills/example/references/first.md',
        severity: 'warning',
      },
      {
        code: 'UnreadableSkillReferenceFile',
        message: 'Skill reference file could not be read',
        path: '/skills/example/references/second.md',
        severity: 'error',
      },
      {
        code: 'UnreadableSkillReferenceFile',
        message: 'A different read failure',
        severity: 'warning',
      },
    ];

    expect(groupSkillDiagnostics(diagnostics)).toEqual([
      {
        code: 'UnreadableSkillReferenceFile',
        count: 2,
        message: 'Skill reference file could not be read',
        paths: ['/skills/example/references/first.md', '/skills/example/references/second.md'],
        severity: 'error',
      },
      {
        code: 'UnreadableSkillReferenceFile',
        count: 1,
        message: 'A different read failure',
        paths: [],
        severity: 'warning',
      },
    ]);
  });

  test('returns no diagnostic groups for an empty list', () => {
    expect(groupSkillDiagnostics([])).toEqual([]);
  });

  test('disables installation when every runtime is already linked', () => {
    expect(deriveInstallationAction(skillState(), exposures('linked'))).toEqual({
      label: 'Install',
      mode: 'none',
    });
  });

  test('installs missing runtime projections directly', () => {
    expect(deriveInstallationAction(skillState(), exposures('linked', 'missing'))).toEqual({
      label: 'Install',
      mode: 'direct',
    });
  });

  test('repairs broken and wrong-target projections directly', () => {
    expect(deriveInstallationAction(skillState(), exposures('broken-link', 'wrong-target'))).toEqual({
      label: 'Repair',
      mode: 'direct',
    });
  });

  test('uses Repair when safe missing and repair work coexist', () => {
    expect(deriveInstallationAction(skillState(), exposures('missing', 'broken-link'))).toEqual({
      label: 'Repair',
      mode: 'direct',
    });
  });

  test('disables review when only unmanaged or unavailable runtimes need attention', () => {
    expect(deriveInstallationAction(skillState(), exposures('unmanaged-copy'))).toEqual({
      label: 'Review installation',
      mode: 'none',
    });
    expect(deriveInstallationAction(skillState(), exposures('missing-target'))).toEqual({
      label: 'Review installation',
      mode: 'none',
    });
  });

  test('previews mixed safe and blocked installation work', () => {
    expect(deriveInstallationAction(skillState(), exposures('missing', 'unmanaged-copy'))).toEqual({
      label: 'Review installation',
      mode: 'preview',
    });
    expect(deriveInstallationAction(skillState(), exposures('wrong-target', 'missing-target'))).toEqual({
      label: 'Review installation',
      mode: 'preview',
    });
  });

  test('disables installation for invalid and disabled skills', () => {
    expect(deriveInstallationAction(skillState({ validationStatus: 'invalid' }), exposures('missing'))).toEqual({
      label: 'Install',
      mode: 'none',
    });
    expect(deriveInstallationAction(skillState({ enabled: false }), exposures('broken-link'))).toEqual({
      label: 'Repair',
      mode: 'none',
    });
  });

  test('keeps warning-status skills installable', () => {
    expect(deriveInstallationAction(skillState({ validationStatus: 'warning' }), exposures('missing'))).toEqual({
      label: 'Install',
      mode: 'direct',
    });
  });

  test('disables installation when there are no enabled runtimes', () => {
    expect(deriveInstallationAction(skillState(), [])).toEqual({
      label: 'Install',
      mode: 'none',
    });
  });
});
