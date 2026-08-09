import type { NavigationIntent } from '../../../foundation/navigation/svelte/navigation';
import { skillsFallbackIntent } from '../../../foundation/navigation/svelte/skills-url';

export interface SkillsFallbackNavigationRequest {
  readonly intent: NavigationIntent;
  readonly state: App.PageState;
}

export const createSkillsFallbackNavigationRequest = (
  currentUrl: string | URL,
  state: App.PageState,
): SkillsFallbackNavigationRequest => ({
  intent: skillsFallbackIntent(currentUrl),
  state,
});
