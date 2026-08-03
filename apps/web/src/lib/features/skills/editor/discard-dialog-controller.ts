import type { StateSubscription } from '../../../foundation/subscription';

export interface DiscardDialogController {
  readonly discard: () => Promise<void>;
  readonly keep: () => boolean;
  readonly pending: StateSubscription<boolean>;
}

export const createDiscardDialogController = (options: {
  readonly onDiscard: () => Promise<void> | void;
  readonly onKeep: () => void;
}): DiscardDialogController => {
  let pending = false;
  const listeners = new Set<(next: boolean) => void>();
  const publish = (next: boolean): void => {
    pending = next;
    for (const listener of listeners) {
      listener(pending);
    }
  };
  return {
    discard: async () => {
      if (pending) {
        return;
      }
      publish(true);
      try {
        await options.onDiscard();
      } finally {
        publish(false);
      }
    },
    keep: () => {
      if (pending) {
        return false;
      }
      options.onKeep();
      return true;
    },
    pending: {
      getState: () => pending,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
};
