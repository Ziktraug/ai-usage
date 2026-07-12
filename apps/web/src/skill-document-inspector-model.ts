import type {
  ProjectionState,
  SkillDiagnostic,
  SkillDiagnosticSeverity,
  SkillValidationStatus,
} from '@ai-usage/skills';

export interface GroupedSkillDiagnostic {
  code: string;
  count: number;
  message: string;
  paths: readonly string[];
  severity: SkillDiagnosticSeverity;
}

export type InstallationActionLabel = 'Install' | 'Repair' | 'Review installation';
export type InstallationActionMode = 'direct' | 'none' | 'preview';

export interface InstallationAction {
  label: InstallationActionLabel;
  mode: InstallationActionMode;
}

interface SkillInstallationState {
  enabled: boolean;
  validationStatus: SkillValidationStatus;
}

interface InstallationExposure {
  canReconcile: boolean;
  state: ProjectionState | 'not-applicable';
}

interface MutableDiagnosticGroup {
  code: string;
  count: number;
  message: string;
  paths: string[];
  severity: SkillDiagnosticSeverity;
}

const diagnosticSeverityRank: Record<SkillDiagnosticSeverity, number> = {
  error: 2,
  info: 0,
  warning: 1,
};

const repairInstallationStates = new Set<ProjectionState>(['broken-link', 'wrong-target']);

export const groupSkillDiagnostics = (diagnostics: readonly SkillDiagnostic[]): readonly GroupedSkillDiagnostic[] => {
  const groupsByCode = new Map<string, Map<string, MutableDiagnosticGroup>>();
  const orderedGroups: MutableDiagnosticGroup[] = [];

  for (const diagnostic of diagnostics) {
    let groupsByMessage = groupsByCode.get(diagnostic.code);
    if (groupsByMessage === undefined) {
      groupsByMessage = new Map();
      groupsByCode.set(diagnostic.code, groupsByMessage);
    }

    const existingGroup = groupsByMessage.get(diagnostic.message);
    if (existingGroup === undefined) {
      const group: MutableDiagnosticGroup = {
        code: diagnostic.code,
        count: 1,
        message: diagnostic.message,
        paths: diagnostic.path === undefined ? [] : [diagnostic.path],
        severity: diagnostic.severity,
      };
      groupsByMessage.set(diagnostic.message, group);
      orderedGroups.push(group);
      continue;
    }

    existingGroup.count += 1;
    if (diagnostic.path !== undefined && !existingGroup.paths.includes(diagnostic.path)) {
      existingGroup.paths.push(diagnostic.path);
    }
    if (diagnosticSeverityRank[diagnostic.severity] > diagnosticSeverityRank[existingGroup.severity]) {
      existingGroup.severity = diagnostic.severity;
    }
  }

  return orderedGroups.map((group) => ({
    code: group.code,
    count: group.count,
    message: group.message,
    paths: group.paths,
    severity: group.severity,
  }));
};

export const deriveInstallationAction = (
  skill: SkillInstallationState,
  exposures: readonly InstallationExposure[],
): InstallationAction => {
  const actionableExposures = exposures.filter((exposure) => exposure.canReconcile);
  const hasBlockedIssue = exposures.some((exposure) => exposure.state !== 'linked' && !exposure.canReconcile);
  const hasRepair = actionableExposures.some(
    (exposure) => exposure.state !== 'not-applicable' && repairInstallationStates.has(exposure.state),
  );

  let action: InstallationAction;
  if (actionableExposures.length === 0) {
    action = {
      label: hasBlockedIssue ? 'Review installation' : 'Install',
      mode: 'none',
    };
  } else if (hasBlockedIssue) {
    action = { label: 'Review installation', mode: 'preview' };
  } else if (hasRepair) {
    action = { label: 'Repair', mode: 'direct' };
  } else {
    action = { label: 'Install', mode: 'direct' };
  }

  if (!(skill.enabled && skill.validationStatus !== 'invalid')) {
    return { ...action, mode: 'none' };
  }
  return action;
};
