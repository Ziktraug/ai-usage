import { getContext, setContext } from 'svelte';

export interface SessionWindowAnchorOwner {
  readonly available: () => boolean;
  readonly beginNavigation: (preserveScroll: boolean) => void;
  readonly cancelNavigation: () => void;
  readonly consume: () => void;
  readonly settleNavigation: () => void;
}

interface SessionWindowAnchorPort {
  readonly replace: (state: App.PageState) => void;
  readonly state: () => App.PageState;
}

const sessionWindowAnchorContextKey = Symbol('ai-usage-session-window-anchor');

export const createSessionWindowAnchorOwner = (port: SessionWindowAnchorPort): SessionWindowAnchorOwner => {
  let pendingPreservedEntry = false;
  const consume = (): void => {
    const state = port.state();
    if (state.aiUsageSessionWindowAnchorConsumed === true) {
      return;
    }
    port.replace({ ...state, aiUsageSessionWindowAnchorConsumed: true });
  };
  return {
    available: () => !pendingPreservedEntry && port.state().aiUsageSessionWindowAnchorConsumed !== true,
    beginNavigation: (preserveScroll) => {
      pendingPreservedEntry = preserveScroll;
    },
    cancelNavigation: () => {
      pendingPreservedEntry = false;
    },
    consume,
    settleNavigation: () => {
      if (!pendingPreservedEntry) {
        return;
      }
      pendingPreservedEntry = false;
      consume();
    },
  };
};

export const provideSessionWindowAnchorOwner = (owner: SessionWindowAnchorOwner): void => {
  setContext(sessionWindowAnchorContextKey, owner);
};

export const useSessionWindowAnchorOwner = (): SessionWindowAnchorOwner => {
  const owner = getContext<SessionWindowAnchorOwner | undefined>(sessionWindowAnchorContextKey);
  if (!owner) {
    throw new Error('Session window anchor context is unavailable');
  }
  return owner;
};
