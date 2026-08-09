import type { KnownProjectScope, SkillSelection } from '../../../../skills-page-model';
import { projectRouteKey } from '../../../../skills-page-model';

const segment = (value: string): string => encodeURIComponent(value);

export const skillSelectionHref = (selection: SkillSelection, knownProjects: readonly KnownProjectScope[]): string => {
  if (selection.type === 'global-scope') {
    return '/skills/global';
  }
  if (selection.type === 'global-skill') {
    return `/skills/global/${segment(selection.skillName)}`;
  }
  const projectKey = segment(projectRouteKey(selection.projectPath, knownProjects));
  if (selection.type === 'project-scope') {
    return `/skills/projects/${projectKey}`;
  }
  return `/skills/projects/${projectKey}/${segment(selection.skillName)}`;
};
