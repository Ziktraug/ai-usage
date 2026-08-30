import type { SkillManagementSnapshot } from '@ai-usage/skills';
import type { SkillObservations } from '@ai-usage/web-contract/skills';
import {
  deriveInstallationAction,
  type GroupedSkillDiagnostic,
  groupSkillDiagnostics,
  type InstallationAction,
} from '../../../skill-document-inspector-model';
import {
  buildGlobalSkillExposure,
  buildProjectSkillRows,
  buildSkillHealthSummary,
  buildSkillMatrix,
  describeProjectSkillPlacement,
  type GlobalSkillExposure,
  globalSkillAttention,
  groupUnmanagedEntries,
  type ProjectSkillRow,
  type SkillHealthSummary,
  type SkillMatrix,
  type SkillTreeScopeNode,
  type UnmanagedGroup,
} from '../../../skills-page-model';
import { matrixDotTone } from './management/model';
import {
  buildSkillObservationsView,
  compareObservationRows,
  homonymNote,
  installVerdictText,
  managedVerdictDescribesInstall,
  observationEvidenceRank,
  observedHarnessSummary,
  type SkillInstallScope,
  type SkillObservationRow,
  type SkillObservationsPresentationState,
  type SkillObservationsView,
  skillObservationsPresentationState,
  verdictText,
} from './observations/model';
import type { SkillsShellViewModel } from './shell/model';

const ATTENTION_SKILL_LIMIT = 6;

type GlobalSkill = SkillManagementSnapshot['skills'][number];

export interface SkillsObservationPresentation {
  readonly errorMessage: string | undefined;
  readonly rowsByName: ReadonlyMap<string, SkillObservationRow>;
  readonly state: SkillObservationsPresentationState;
  readonly view: SkillObservationsView | undefined;
}

export interface SkillsAttentionEntry {
  readonly attention: {
    readonly attentionSummary: string;
    readonly issueCount: number;
    readonly pendingLinkCount: number;
  };
  readonly skill: GlobalSkill;
}

export interface SkillsProjectScopePresentationRow {
  readonly description: string;
  readonly name: string;
  readonly observationRow: SkillObservationRow | undefined;
  readonly placements: readonly string[];
  readonly validationStatus: string;
}

export interface SkillsProjectUsagePresentation {
  readonly lastObservedAt: string | null;
  readonly observedCount: number;
  readonly top: SkillObservationRow | undefined;
}

export interface SkillsSelectedPresentation {
  readonly diagnostics: readonly GroupedSkillDiagnostic[];
  readonly exposure: readonly GlobalSkillExposure[];
  readonly exposureSummaryText: string;
  readonly exposureTones: Readonly<Record<'broken' | 'copy' | 'linked' | 'missing', number>>;
  readonly globalSkill: GlobalSkill | undefined;
  readonly homonym: string | undefined;
  readonly installationAction: InstallationAction | undefined;
  readonly installScope: SkillInstallScope;
  readonly managedClaimApplies: boolean;
  readonly name: string | undefined;
  readonly observationRow: SkillObservationRow | undefined;
  readonly observedSummary: string;
  readonly projectPlacementSummary: readonly string[];
  readonly projectSkill: ProjectSkillRow | undefined;
  readonly verdict: string | undefined;
}

export interface SkillsPresentationProjection {
  readonly attention: {
    readonly entries: readonly SkillsAttentionEntry[];
    readonly overflow: number;
  };
  readonly disabledSkills: readonly GlobalSkill[];
  readonly health: SkillHealthSummary;
  readonly matrix: SkillMatrix;
  readonly observations: SkillsObservationPresentation;
  readonly projectScopeRows: readonly SkillsProjectScopePresentationRow[];
  readonly projectScopes: readonly SkillTreeScopeNode[];
  readonly projectUsageByScopeKey: ReadonlyMap<string, SkillsProjectUsagePresentation>;
  readonly selected: SkillsSelectedPresentation;
  readonly targetLabelById: ReadonlyMap<string, string>;
  readonly unmanagedGroups: readonly UnmanagedGroup[];
  readonly unmanagedUsageByName:
    | ReadonlyMap<string, { readonly lastObservedAt: string | null; readonly summary: string }>
    | undefined;
}

const buildObservationPresentation = (
  observations: SkillObservations | undefined,
  errorMessage: string | undefined,
): SkillsObservationPresentation => {
  const view = observations === undefined ? undefined : buildSkillObservationsView(observations);
  return {
    errorMessage,
    rowsByName: new Map((view?.rows ?? []).map((row) => [row.skillName, row])),
    state: skillObservationsPresentationState(observations, errorMessage),
    view,
  };
};

const buildProjectScopeRows = (
  view: SkillsShellViewModel,
  observations: SkillsObservationPresentation,
): readonly SkillsProjectScopePresentationRow[] => {
  if (view.selectionDetail.kind !== 'project-scope') {
    return [];
  }
  const rows = buildProjectSkillRows(view.selectionDetail.inventories, view.knownProjects).map((row) => ({
    description: row.description,
    name: row.name,
    observationRow: observations.rowsByName.get(row.name),
    placements: [...new Set(row.observations.map((observation) => describeProjectSkillPlacement(observation)))],
    validationStatus: row.validationStatus,
  }));
  return rows.toSorted((left, right) => {
    if (left.observationRow !== undefined && right.observationRow !== undefined) {
      return compareObservationRows(left.observationRow, right.observationRow);
    }
    if (left.observationRow !== right.observationRow) {
      return left.observationRow === undefined ? 1 : -1;
    }
    return left.name.localeCompare(right.name);
  });
};

const buildProjectUsage = (
  view: SkillsShellViewModel,
  observations: SkillsObservationPresentation,
): ReadonlyMap<string, SkillsProjectUsagePresentation> =>
  new Map(
    view.tree.scopes
      .filter((scope) => scope.type === 'project' && scope.hasSkills)
      .map((scope) => {
        const rows = scope.skills.flatMap((skill) => {
          const row = observations.rowsByName.get(skill.name);
          return row === undefined ? [] : [row];
        });
        const observed = rows.filter((row) => observationEvidenceRank(row) > 0).toSorted(compareObservationRows);
        return [
          scope.key,
          {
            lastObservedAt: rows.reduce<string | null>(
              (latest, row) =>
                row.lastObservedAt !== null && row.lastObservedAt > (latest ?? '') ? row.lastObservedAt : latest,
              null,
            ),
            observedCount: observed.length,
            top: observed.at(0),
          },
        ] as const;
      }),
  );

const buildSelectedPresentation = (
  view: SkillsShellViewModel,
  observations: SkillsObservationPresentation,
): SkillsSelectedPresentation => {
  const globalSkill = view.selectionDetail.kind === 'global-skill' ? view.selectionDetail.skill : undefined;
  const projectSkill = view.selectionDetail.kind === 'project-skill' ? view.selectionDetail.skill : undefined;
  const name = globalSkill?.name ?? projectSkill?.name;
  const installScope: SkillInstallScope = projectSkill === undefined ? 'global' : 'project';
  const observationRow = name === undefined ? undefined : observations.rowsByName.get(name);
  const exposure = globalSkill === undefined ? [] : buildGlobalSkillExposure(view.snapshot, globalSkill.name);
  const exposureTones = { broken: 0, copy: 0, linked: 0, missing: 0 };
  for (const item of exposure) {
    const tone = matrixDotTone(item.state);
    if (tone !== 'none') {
      exposureTones[tone] += 1;
    }
  }
  const exposureSummaryText = [
    exposureTones.missing > 0 ? `${exposureTones.missing} to link` : undefined,
    exposureTones.broken > 0 ? `${exposureTones.broken} to repair` : undefined,
    exposureTones.copy > 0 ? `${exposureTones.copy} blocked` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
  const verdict = (() => {
    if (observationRow !== undefined) {
      return installVerdictText(observationRow, installScope);
    }
    if (observations.view === undefined || name === undefined) {
      return;
    }
    return verdictText({
      verdict: 'never-observed',
      verdictProvisional: !observations.view.invocationEvidenceComplete,
    });
  })();
  return {
    diagnostics: globalSkill === undefined ? [] : groupSkillDiagnostics(globalSkill.diagnostics),
    exposure,
    exposureSummaryText,
    exposureTones,
    globalSkill,
    homonym: observationRow === undefined ? undefined : homonymNote(observationRow, installScope),
    installScope,
    installationAction: globalSkill === undefined ? undefined : deriveInstallationAction(globalSkill, exposure),
    name,
    observationRow,
    observedSummary: observationRow === undefined ? '' : observedHarnessSummary(observationRow),
    projectPlacementSummary:
      projectSkill === undefined
        ? []
        : [...new Set(projectSkill.observations.map((observation) => describeProjectSkillPlacement(observation)))],
    projectSkill,
    managedClaimApplies: observationRow === undefined || managedVerdictDescribesInstall(observationRow, installScope),
    verdict,
  };
};

export const createSkillsPresentationProjection = (input: {
  readonly observations: SkillObservations | undefined;
  readonly observationsError: string | undefined;
  readonly view: SkillsShellViewModel;
}): SkillsPresentationProjection => {
  const observations = buildObservationPresentation(input.observations, input.observationsError);
  const allAttention = input.view.snapshot.skills
    .map((skill) => ({ attention: globalSkillAttention(input.view.snapshot, skill), skill }))
    .filter(
      (entry) => entry.attention.issueCount > 0 || entry.skill.validationStatus !== 'valid' || !entry.skill.enabled,
    )
    .sort((left, right) => {
      if (left.attention.issueCount !== right.attention.issueCount) {
        return right.attention.issueCount - left.attention.issueCount;
      }
      return left.skill.name.localeCompare(right.skill.name);
    });
  const matrix = buildSkillMatrix(input.view.snapshot);
  const unmanagedUsageByName =
    observations.view === undefined
      ? undefined
      : new Map(
          observations.view.rows.map((row) => [
            row.skillName,
            { lastObservedAt: row.lastObservedAt, summary: observedHarnessSummary(row) },
          ]),
        );
  const attentionEntries = allAttention.slice(0, ATTENTION_SKILL_LIMIT);
  return {
    attention: {
      entries: attentionEntries,
      overflow: allAttention.length - attentionEntries.length,
    },
    disabledSkills: input.view.snapshot.skills.filter((skill) => !skill.enabled),
    health: buildSkillHealthSummary(input.view.snapshot),
    matrix,
    observations,
    projectScopeRows: buildProjectScopeRows(input.view, observations),
    projectScopes: input.view.tree.scopes.filter((scope) => scope.type === 'project' && scope.hasSkills),
    projectUsageByScopeKey: buildProjectUsage(input.view, observations),
    selected: buildSelectedPresentation(input.view, observations),
    targetLabelById: new Map(matrix.targets.map((target) => [target.id, target.label])),
    unmanagedGroups: groupUnmanagedEntries(input.view.snapshot),
    unmanagedUsageByName,
  };
};
