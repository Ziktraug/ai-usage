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
    settingsFile: string;
    /** Claude Desktop's per-session registry: `<account>/<org>/local_<uuid>.json` under this directory. */
    desktopSessionsDir: string;
  };
  codex: {
    sessionsDir: string;
    /** Threads archived from the Codex picker move here as a flat directory. */
    archivedSessionsDir: string;
    sessionIndexFile: string;
  };
  cursor: {
    stateVscdb: string;
    aiTrackingDb: string;
  };
  opencode: {
    liveDb: string;
    stableDb: string;
  };
  rtk: {
    historyDb: string;
  };
}

export interface HarnessPathCandidates {
  claude: {
    projectsDir: string[];
    historyFile: string[];
    configFile: string[];
    desktopSessionsDir: string[];
  };
  codex: {
    sessionsDir: string[];
    sessionIndexFile: string[];
  };
  cursor: {
    stateVscdb: string[];
    aiTrackingDb: string[];
  };
  opencode: {
    liveDb: string[];
    stableDb: string[];
  };
  rtk: {
    historyDb: string[];
  };
}

const unique = <T>(values: T[]) => [...new Set(values)];

const pathSet = (storage: LocalHistoryStorage) => {
  const home = storage.home;

  const join = (...segments: string[]) => path.join(home, ...segments);

  // Claude Code keeps one home layout on every platform; only the Desktop app follows the OS.
  const claudeCode = {
    projectsDir: join('.claude', 'projects'),
    historyFile: join('.claude', 'history.jsonl'),
    configFile: join('.claude.json'),
    settingsFile: join('.claude', 'settings.json'),
  };

  const macos: HarnessPaths = {
    claude: {
      ...claudeCode,
      desktopSessionsDir: join('Library', 'Application Support', 'Claude', 'claude-code-sessions'),
    },
    codex: {
      sessionsDir: join('.codex', 'sessions'),
      archivedSessionsDir: join('.codex', 'archived_sessions'),
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
    claude: {
      ...claudeCode,
      desktopSessionsDir: join('.config', 'Claude', 'claude-code-sessions'),
    },
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
    claude: {
      ...claudeCode,
      // Not verified on a Windows profile; the Roaming location follows the other Electron apps above.
      desktopSessionsDir: join('AppData', 'Roaming', 'Claude', 'claude-code-sessions'),
    },
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

  return { macos, linux, windows } satisfies Record<Platform, HarnessPaths>;
};

export const resolvePaths = (storage: LocalHistoryStorage): HarnessPaths => {
  const os = platform();
  return pathSet(storage)[os];
};

export const resolvePathCandidates = (storage: LocalHistoryStorage): HarnessPathCandidates => {
  const paths = pathSet(storage);
  const ordered = unique([platform(), 'macos', 'linux', 'windows'] satisfies Platform[]).map((os) => paths[os]);
  return {
    claude: {
      projectsDir: unique(ordered.map((platformPaths) => platformPaths.claude.projectsDir)),
      historyFile: unique(ordered.map((platformPaths) => platformPaths.claude.historyFile)),
      configFile: unique(ordered.map((platformPaths) => platformPaths.claude.configFile)),
      desktopSessionsDir: unique(ordered.map((platformPaths) => platformPaths.claude.desktopSessionsDir)),
    },
    codex: {
      sessionsDir: unique(ordered.map((platformPaths) => platformPaths.codex.sessionsDir)),
      sessionIndexFile: unique(ordered.map((platformPaths) => platformPaths.codex.sessionIndexFile)),
    },
    opencode: {
      liveDb: unique(ordered.map((platformPaths) => platformPaths.opencode.liveDb)),
      stableDb: unique(ordered.map((platformPaths) => platformPaths.opencode.stableDb)),
    },
    cursor: {
      stateVscdb: unique(ordered.map((platformPaths) => platformPaths.cursor.stateVscdb)),
      aiTrackingDb: unique(ordered.map((platformPaths) => platformPaths.cursor.aiTrackingDb)),
    },
    rtk: {
      historyDb: unique(ordered.map((platformPaths) => platformPaths.rtk.historyDb)),
    },
  };
};

export const firstExisting = (
  storage: LocalHistoryStorage,
  ...candidates: string[]
): Effect.Effect<string | null, never, never> =>
  Effect.gen(function* () {
    for (const candidate of candidates) {
      const exists = yield* storage.exists(candidate).pipe(Effect.catch(() => Effect.succeed(false)));
      if (exists) {
        return candidate;
      }
    }
    return null;
  });
