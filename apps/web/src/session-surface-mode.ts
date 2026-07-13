export type SessionSurfaceMode = 'pending' | 'mobile' | 'desktop' | 'print';

export const SESSION_DESKTOP_MEDIA_QUERY = '(min-width: 48rem)';

interface MediaQueryChangeEventLike {
  matches: boolean;
}

interface MediaQueryListLike {
  addEventListener(type: 'change', listener: (event: MediaQueryChangeEventLike) => void): void;
  matches: boolean;
  removeEventListener(type: 'change', listener: (event: MediaQueryChangeEventLike) => void): void;
}

interface PrintEventTargetLike {
  addEventListener(type: 'afterprint' | 'beforeprint', listener: () => void): void;
  removeEventListener(type: 'afterprint' | 'beforeprint', listener: () => void): void;
}

export interface SessionSurfaceModeEnvironment {
  matchMedia(query: string): MediaQueryListLike;
  printEvents: PrintEventTargetLike;
}

export interface SessionSurfaceModeController {
  mode(): SessionSurfaceMode;
  start(onModeChange: (mode: SessionSurfaceMode) => void): () => void;
}

export const createSessionSurfaceModeController = (
  environment: SessionSurfaceModeEnvironment,
): SessionSurfaceModeController => {
  let currentMode: SessionSurfaceMode = 'pending';
  let started = false;

  return {
    mode: () => currentMode,
    start: (onModeChange) => {
      if (started) {
        throw new Error('Session surface mode controller is already started');
      }
      started = true;
      let printing = false;
      const mediaQuery = environment.matchMedia(SESSION_DESKTOP_MEDIA_QUERY);
      const publish = (mode: SessionSurfaceMode) => {
        currentMode = mode;
        onModeChange(mode);
      };
      const publishViewportMode = (matches = mediaQuery.matches) => publish(matches ? 'desktop' : 'mobile');
      const onMediaChange = (event: MediaQueryChangeEventLike) => {
        if (!printing) {
          publishViewportMode(event.matches);
        }
      };
      const onBeforePrint = () => {
        printing = true;
        publish('print');
      };
      const onAfterPrint = () => {
        printing = false;
        publishViewportMode();
      };

      mediaQuery.addEventListener('change', onMediaChange);
      environment.printEvents.addEventListener('beforeprint', onBeforePrint);
      environment.printEvents.addEventListener('afterprint', onAfterPrint);
      publishViewportMode();

      return () => {
        mediaQuery.removeEventListener('change', onMediaChange);
        environment.printEvents.removeEventListener('beforeprint', onBeforePrint);
        environment.printEvents.removeEventListener('afterprint', onAfterPrint);
        printing = false;
        started = false;
        currentMode = 'pending';
      };
    },
  };
};

export const browserSessionSurfaceModeEnvironment = (): SessionSurfaceModeEnvironment => ({
  matchMedia: (query) => window.matchMedia(query),
  printEvents: window,
});
