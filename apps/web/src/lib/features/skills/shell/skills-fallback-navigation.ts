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

/**
 * Rewrites the address of a URL naming a missing skill to the worktable, once per fallback.
 *
 * The fallback runs from an effect that reads `page.state`, so a later navigation re-arms it. Each
 * `replaceState` hands SvelteKit 3's re-parsed state back as a new object while `page.url` stays on
 * the missing skill, so that effect runs again after every write. The navigator makes those runs
 * no-ops: it writes nothing while a write is in flight or once the address is already the
 * fallback, and it reports a rejected write instead of dropping it.
 */
export interface SkillsFallbackNavigator {
  readonly apply: (state: App.PageState) => void;
}

export const createSkillsFallbackNavigator = (port: {
  readonly currentHref: () => string;
  readonly onFailure: (cause: unknown) => void;
  readonly replace: (url: URL, state: App.PageState) => Promise<void>;
}): SkillsFallbackNavigator => {
  let writing = false;
  return {
    apply: (state) => {
      if (writing) {
        return;
      }
      const currentHref = port.currentHref();
      const request = createSkillsFallbackNavigationRequest(currentHref, state);
      const url = new URL(request.intent.url);
      if (url.href === currentHref) {
        return;
      }
      writing = true;
      port
        .replace(url, request.state)
        .catch(port.onFailure)
        .finally(() => {
          writing = false;
        });
    },
  };
};
