import path from 'node:path';
import { Effect } from 'effect';
import type { LocalHistoryStorage } from './local-history';

export type Platform = 'macos' | 'linux' | 'windows';

export const platform = (): Platform => {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
};

export interface HarnessPaths {
  claude: {
    projectsDir: string;
    historyFile: string;
    configFile: string;
  };
  codex: {
    sessionsDir: string;
    sessionIndexFile: string;
  };
  opencode: {
    liveDb: string;
    stableDb: string;
  };
  cursor: {
    stateVscdb: string;
    aiTrackingDb: string;
  };
  rtk: {
    historyDb: string;
  };
}

export const resolvePaths = (storage: LocalHistoryStorage): HarnessPaths => {
  const home = storage.home;
  const os = platform();

  const join = (...segments: string[]) => path.join(home, ...segments);

  const macos: HarnessPaths = {
    claude: {
      projectsDir: join('.claude', 'projects'),
      historyFile: join('.claude', 'history.jsonl'),
      configFile: join('.claude.json'),
    },
    codex: {
      sessionsDir: join('.codex', 'sessions'),
      sessionIndexFile: join('.codex', 'session_index.jsonl'),
    },
    opencode: {
      liveDb: join('Library', 'Application Support', 'opencode', 'opencode.db'),
      stableDb: join('Library', 'Application Support', 'opencode', 'opencode-stable.db'),
    },
    cursor: {
      stateVscdb: join('Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      aiTrackingDb: join('Library', 'Application Support', 'Cursor', 'ai-tracking', 'ai-code-tracking.db'),
    },
    rtk: {
      historyDb: join('Library', 'Application Support', 'rtk', 'history.db'),
    },
  };

  const linux: HarnessPaths = {
    claude: macos.claude,
    codex: macos.codex,
    opencode: {
      liveDb: join('.local', 'share', 'opencode', 'opencode.db'),
      stableDb: join('.local', 'share', 'opencode', 'opencode-stable.db'),
    },
    cursor: {
      stateVscdb: join('.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      aiTrackingDb: join('.cursor', 'ai-tracking', 'ai-code-tracking.db'),
    },
    rtk: {
      historyDb: join('.local', 'share', 'rtk', 'history.db'),
    },
  };

  const windows: HarnessPaths = {
    claude: macos.claude,
    codex: macos.codex,
    opencode: {
      liveDb: join('AppData', 'Local', 'opencode', 'opencode.db'),
      stableDb: join('AppData', 'Local', 'opencode', 'opencode-stable.db'),
    },
    cursor: {
      stateVscdb: join('AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
      aiTrackingDb: join('AppData', 'Roaming', 'Cursor', 'ai-tracking', 'ai-code-tracking.db'),
    },
    rtk: {
      historyDb: join('AppData', 'Local', 'rtk', 'history.db'),
    },
  };

  const pathsByPlatform: Record<Platform, HarnessPaths> = { macos, linux, windows };
  return pathsByPlatform[os];
};

export const firstExisting = (
  storage: LocalHistoryStorage,
  ...candidates: string[]
): Effect.Effect<string | null, never, never> =>
  Effect.gen(function* () {
    for (const candidate of candidates) {
      const exists = yield* storage.exists(candidate).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (exists) return candidate;
    }
    return null;
  });
