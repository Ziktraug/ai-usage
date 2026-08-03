import { getContext, setContext } from 'svelte';
import type { Disposer, StateListener, StateSubscription } from '../../foundation/subscription';

export interface DirtyGuardRegistration {
  readonly dirty: StateSubscription<boolean>;
  readonly discard: () => Promise<void> | void;
  readonly focus: () => void;
}

export interface DirtyGuardRegistry {
  readonly dirty: StateSubscription<boolean>;
  readonly discard: () => Promise<void> | void;
  readonly focus: () => void;
  readonly register: (registration: DirtyGuardRegistration) => Disposer;
}

const dirtyGuardContextKey = Symbol('ai-usage-dirty-navigation');

export const createDirtyGuardRegistry = (): DirtyGuardRegistry => {
  const listeners = new Set<StateListener<boolean>>();
  let active: DirtyGuardRegistration | undefined;
  let dirty = false;
  let stopDirty: Disposer | undefined;
  const publish = (next: boolean): void => {
    if (next === dirty) {
      return;
    }
    dirty = next;
    for (const listener of listeners) {
      listener(dirty);
    }
  };
  return {
    dirty: {
      getState: () => dirty,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    discard: () => active?.discard(),
    focus: () => active?.focus(),
    register: (registration) => {
      if (active) {
        throw new Error('A dirty navigation guard is already registered');
      }
      active = registration;
      publish(registration.dirty.getState());
      stopDirty = registration.dirty.subscribe(publish);
      let disposed = false;
      return () => {
        if (disposed) {
          return;
        }
        disposed = true;
        stopDirty?.();
        stopDirty = undefined;
        active = undefined;
        publish(false);
      };
    },
  };
};

export const provideDirtyGuardRegistry = (registry: DirtyGuardRegistry): void => {
  setContext(dirtyGuardContextKey, registry);
};

export const useDirtyGuardRegistry = (): DirtyGuardRegistry => {
  const registry = getContext<DirtyGuardRegistry | undefined>(dirtyGuardContextKey);
  if (!registry) {
    throw new Error('Dirty navigation guard context is unavailable');
  }
  return registry;
};
