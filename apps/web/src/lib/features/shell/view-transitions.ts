import { isReportPathname } from '../sessions/detail/session-route';
import { activeReportTab, shellManagementDestinations } from './navigation';

const managementSection = (url: URL): string | undefined =>
  shellManagementDestinations.find(({ href }) => url.pathname === href || url.pathname.startsWith(`${href}/`))?.href;

export const shouldTransitionNavigation = (from: URL | null, to: URL | null, reducedMotion: boolean): boolean => {
  if (reducedMotion || from === null || to === null) {
    return false;
  }
  if (isReportPathname(from.pathname) && isReportPathname(to.pathname)) {
    return activeReportTab(from) !== activeReportTab(to);
  }
  // The Skills layout owns the worktable/header; all its child routes select panels over it.
  const section = managementSection(from);
  if (section !== undefined && section === managementSection(to)) {
    return false;
  }
  return from.pathname !== to.pathname;
};

const destinationIndex = (url: URL): number => {
  if (url.pathname === '/work' || url.pathname.startsWith('/work/')) {
    return 0;
  }
  if (isReportPathname(url.pathname)) {
    return { overview: 1, sessions: 2, breakdown: 3 }[activeReportTab(url)];
  }
  if (url.pathname === '/campaigns') {
    return 4;
  }
  const managementIndex = shellManagementDestinations.findIndex(
    ({ href }) => url.pathname === href || url.pathname.startsWith(`${href}/`),
  );
  return managementIndex === -1 ? 5 + shellManagementDestinations.length : 5 + managementIndex;
};

export const transitionDirection = (from: URL, to: URL, historyDelta?: number): 'forwards' | 'backwards' =>
  (historyDelta === undefined ? destinationIndex(to) - destinationIndex(from) : historyDelta) < 0
    ? 'backwards'
    : 'forwards';

/** Navigation remains authoritative: animation failure must never strand an update. */
export const transitionNavigation = (navigation: {
  complete: Promise<void>;
  from: { url: URL } | null;
  to: { url: URL } | null;
  type: string;
  delta?: number;
}): Promise<void> | undefined => {
  if (
    typeof document.startViewTransition !== 'function' ||
    !shouldTransitionNavigation(
      navigation.from?.url ?? null,
      navigation.to?.url ?? null,
      matchMedia('(prefers-reduced-motion: reduce)').matches,
    ) ||
    !navigation.from ||
    !navigation.to
  ) {
    return;
  }
  const direction = transitionDirection(
    navigation.from.url,
    navigation.to.url,
    navigation.type === 'popstate' ? navigation.delta : undefined,
  );
  return new Promise<void>((resolve) => {
    let transition: ViewTransition | undefined;
    // Observe immediately, even if the browser defers invoking update (e.g. supersession).
    // SvelteKit reports navigation errors; the decorative snapshot should just be skipped.
    const settledNavigation = navigation.complete.catch(() => {
      transition?.skipTransition();
    });
    const update = async (): Promise<void> => {
      resolve();
      await settledNavigation;
    };
    try {
      transition =
        'ViewTransition' in window && 'types' in ViewTransition.prototype
          ? document.startViewTransition({ update, types: [direction] })
          : document.startViewTransition(update);
      // Cancellation/supersession is normal; SvelteKit owns navigation error reporting.
      transition.updateCallbackDone.catch(() => {
        resolve();
      });
      transition.finished.catch(() => {
        resolve();
      });
      transition.ready.catch(() => {
        resolve();
      });
    } catch {
      resolve();
    }
  });
};
