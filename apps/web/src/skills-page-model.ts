import type { Projection, SkillManagementSnapshot, SourceSkill } from '@ai-usage/skills';

export interface SkillSummaryTile {
  label: string;
  value: string;
}

export const buildSkillSummaryTiles = (snapshot: SkillManagementSnapshot): readonly SkillSummaryTile[] => [
  {
    label: 'Source',
    value: snapshot.config.sourceRepoPath ?? 'Not configured',
  },
  {
    label: 'Skills',
    value: String(snapshot.summary.skillCount),
  },
  {
    label: 'Active',
    value: String(snapshot.summary.activeSkillCount),
  },
  {
    label: 'Needs attention',
    value: String(snapshot.summary.unhealthyProjectionCount + snapshot.summary.unmanagedEntryCount),
  },
  {
    label: 'Diagnostics',
    value: String(snapshot.summary.diagnosticCount),
  },
];

export const projectionStateLabel = (state: Projection['state']): string => {
  switch (state) {
    case 'linked':
      return 'Linked';
    case 'missing':
      return 'Not linked';
    case 'broken-link':
      return 'Broken link';
    case 'wrong-target':
      return 'Wrong target';
    case 'unmanaged-copy':
      return 'Unmanaged copy';
    case 'unmanaged-symlink':
      return 'Unmanaged symlink';
    case 'duplicate-same-content':
      return 'Duplicate';
    case 'duplicate-name-conflict':
      return 'Name conflict';
    case 'disabled-exposed':
      return 'Disabled exposed';
    case 'missing-target':
      return 'Missing target';
    default:
      return state;
  }
};

export const skillProjectionSummary = (skill: SourceSkill, projections: readonly Projection[]): string => {
  const states = projections
    .filter((projection) => projection.skillName === skill.name)
    .map((projection) => projectionStateLabel(projection.state));
  return states.length === 0 ? 'No targets' : states.join(', ');
};

const unsafeReconcileStates = new Set<Projection['state']>([
  'disabled-exposed',
  'duplicate-name-conflict',
  'unmanaged-copy',
  'unmanaged-symlink',
]);

export const canReconcileAllActiveSkills = (snapshot: SkillManagementSnapshot): boolean =>
  snapshot.unmanagedEntries.length === 0 &&
  !snapshot.projections.some((projection) => unsafeReconcileStates.has(projection.state));

export const canReconcileSkill = (skill: SourceSkill, snapshot: SkillManagementSnapshot): boolean =>
  skill.enabled &&
  skill.validationStatus === 'valid' &&
  !snapshot.projections.some(
    (projection) => projection.skillName === skill.name && unsafeReconcileStates.has(projection.state),
  );
