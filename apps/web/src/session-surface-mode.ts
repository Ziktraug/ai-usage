export type SessionSurfaceMode = 'pending' | 'mobile' | 'desktop';

export const SESSION_DESKTOP_MEDIA_QUERY = '(min-width: 48rem)';

interface MediaQueryChangeEventLike {
  matches: boolean;
}

interface MediaQueryListLike {
  addEventListener(type: 'change', listener: (event: MediaQueryChangeEventLike) => void): void;
  matches: boolean;
  removeEventListener(type: 'change', listener: (event: MediaQueryChangeEventLike) => void): void;
}

export interface SessionSurfaceModeEnvironment {
  matchMedia(query: string): MediaQueryListLike;
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
      const mediaQuery = environment.matchMedia(SESSION_DESKTOP_MEDIA_QUERY);
      const publish = (mode: SessionSurfaceMode) => {
        currentMode = mode;
        onModeChange(mode);
      };
      const publishViewportMode = (matches = mediaQuery.matches) => publish(matches ? 'desktop' : 'mobile');
      const onMediaChange = (event: MediaQueryChangeEventLike) => publishViewportMode(event.matches);

      mediaQuery.addEventListener('change', onMediaChange);
      publishViewportMode();

      return () => {
        mediaQuery.removeEventListener('change', onMediaChange);
        started = false;
        currentMode = 'pending';
      };
    },
  };
};

export const browserSessionSurfaceModeEnvironment = (): SessionSurfaceModeEnvironment => ({
  matchMedia: (query) => window.matchMedia(query),
});
