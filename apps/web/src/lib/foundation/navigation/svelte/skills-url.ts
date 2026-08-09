import {
  type KnownProjectScope,
  projectRouteKey,
  type SkillSelection,
  skillSelectionFromPath,
} from '../../../../skills-page-model';
import type { NavigationIntent } from './navigation';

export type SkillDestination = SkillSelection | { readonly type: 'matrix' };

const segment = (value: string): string => encodeURIComponent(value);

export const skillHref = (destination: SkillDestination, knownProjects: readonly KnownProjectScope[] = []): string => {
  if (destination.type === 'matrix') {
    return '/skills/matrix';
  }
  if (destination.type === 'global-scope') {
    return '/skills/global';
  }
  if (destination.type === 'global-skill') {
    return `/skills/global/${segment(destination.skillName)}`;
  }
  const projectKey = segment(projectRouteKey(destination.projectPath, knownProjects));
  if (destination.type === 'project-scope') {
    return `/skills/projects/${projectKey}`;
  }
  return `/skills/projects/${projectKey}/${segment(destination.skillName)}`;
};

export const skillDestinationFromUrl = (
  url: string | URL,
  knownProjects: readonly KnownProjectScope[] = [],
): SkillDestination | undefined => {
  const parsed = url instanceof URL ? url : new URL(url, 'http://localhost');
  if (parsed.pathname === '/skills/matrix') {
    return { type: 'matrix' };
  }
  return skillSelectionFromPath(parsed.pathname, knownProjects);
};

export const skillTreeSelectionFromUrl = (
  url: string | URL,
  knownProjects: readonly KnownProjectScope[] = [],
): SkillSelection | undefined => {
  const parsed = url instanceof URL ? url : new URL(url, 'http://localhost');
  return skillSelectionFromPath(parsed.pathname, knownProjects);
};

export const skillsFallbackIntent = (currentUrl: string | URL): NavigationIntent => ({
  replace: true,
  resetScroll: false,
  url: destinationUrl(currentUrl, '/skills/global'),
});

const destinationUrl = (currentUrl: string | URL, pathname: string): URL => {
  const url = new URL(currentUrl);
  url.pathname = pathname;
  return url;
};

export const skillNavigationIntent = (
  currentUrl: string | URL,
  destination: SkillDestination,
  knownProjects: readonly KnownProjectScope[] = [],
): NavigationIntent => ({
  resetScroll: false,
  url: destinationUrl(currentUrl, skillHref(destination, knownProjects)),
});
