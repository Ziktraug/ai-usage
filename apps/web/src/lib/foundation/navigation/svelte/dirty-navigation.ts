import type { Disposer, StateSubscription } from '../../subscription';
import type { NavigationPort } from './navigation';

export type DirtyNavigationTarget =
  | { readonly delta: number; readonly kind: 'history' }
  | { readonly kind: 'url'; readonly replace?: boolean; readonly url: URL };

export interface DirtyBeforeNavigate {
  readonly cancel: () => void;
  readonly delta?: number;
  readonly replace?: boolean;
  readonly to: { readonly url: URL } | null;
  readonly type: 'form' | 'goto' | 'leave' | 'link' | 'popstate';
  readonly willUnload: boolean;
}

export interface DirtyNavigationController {
  readonly discard: () => Promise<boolean>;
  readonly handle: (navigation: DirtyBeforeNavigate) => boolean;
  readonly keep: () => void;
  readonly pending: () => DirtyNavigationTarget | undefined;
}

const targetFor = (navigation: DirtyBeforeNavigate): DirtyNavigationTarget | undefined => {
  if (navigation.type === 'popstate' && navigation.delta && Number.isInteger(navigation.delta)) {
    return { delta: navigation.delta, kind: 'history' };
  }
  return navigation.to
    ? {
        kind: 'url',
        ...(navigation.replace === undefined ? {} : { replace: navigation.replace }),
        url: new URL(navigation.to.url),
      }
    : undefined;
};

export const replayDirtyNavigation = async (port: NavigationPort, target: DirtyNavigationTarget): Promise<void> => {
  if (target.kind === 'history') {
    port.traverse(target.delta);
    return;
  }
  await port.navigate({
    ...(target.replace === undefined ? {} : { replace: target.replace }),
    resetScroll: false,
    url: target.url,
  });
};

export const createDirtyNavigationController = (dependencies: {
  readonly discardChanges: () => Promise<void> | void;
  readonly focus: () => void;
  readonly isDirty: () => boolean;
  readonly onFailure?: (cause: unknown) => void;
  readonly replay: (target: DirtyNavigationTarget) => Promise<void> | void;
}): DirtyNavigationController => {
  let pendingTarget: DirtyNavigationTarget | undefined;
  return {
    discard: async () => {
      const target = pendingTarget;
      if (!target) {
        return false;
      }
      pendingTarget = undefined;
      try {
        await dependencies.discardChanges();
        await dependencies.replay(target);
        return true;
      } catch (cause) {
        pendingTarget ??= target;
        dependencies.onFailure?.(cause);
        throw cause;
      }
    },
    handle: (navigation) => {
      if (!dependencies.isDirty()) {
        return false;
      }
      navigation.cancel();
      if (!navigation.willUnload) {
        pendingTarget ??= targetFor(navigation);
      }
      return true;
    },
    keep: () => {
      pendingTarget = undefined;
      dependencies.focus();
    },
    pending: () => pendingTarget,
  };
};

export interface BeforeUnloadEventLike {
  preventDefault: () => void;
  returnValue: string;
}

export const installDirtyNavigationBridge = (dependencies: {
  readonly beforeNavigate: (callback: (navigation: DirtyBeforeNavigate) => void) => Disposer | undefined;
  readonly controller: DirtyNavigationController;
  readonly dirty: StateSubscription<boolean>;
  readonly window: {
    addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEventLike) => void): void;
    removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEventLike) => void): void;
  };
}): Disposer => {
  let listening = false;
  const onBeforeUnload = (event: BeforeUnloadEventLike): void => {
    event.preventDefault();
    event.returnValue = '';
  };
  const sync = (dirty: boolean): void => {
    if (dirty === listening) {
      return;
    }
    listening = dirty;
    if (dirty) {
      dependencies.window.addEventListener('beforeunload', onBeforeUnload);
    } else {
      dependencies.window.removeEventListener('beforeunload', onBeforeUnload);
    }
  };
  const stopNavigation = dependencies.beforeNavigate((navigation) => {
    dependencies.controller.handle(navigation);
  });
  sync(dependencies.dirty.getState());
  const stopDirty = dependencies.dirty.subscribe(sync);
  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;
    stopNavigation?.();
    stopDirty();
    if (listening) {
      listening = false;
      dependencies.window.removeEventListener('beforeunload', onBeforeUnload);
    }
  };
};
