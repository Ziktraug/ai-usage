export type HarnessColor = 'magenta' | 'cyan' | 'green' | 'blue';

export const HARNESS_METADATA = {
  claude: {
    key: 'claude',
    label: 'Claude Code',
    color: 'magenta',
    defaultEnabled: true,
    tracksLineDeltas: false,
    partial: false,
    reportNote: null,
  },
  codex: {
    key: 'codex',
    label: 'Codex',
    color: 'cyan',
    defaultEnabled: true,
    tracksLineDeltas: false,
    partial: false,
    reportNote:
      'Codex tokens are cumulative observed counters (proxy, not billing); Codex durations span the rollout file (resumed sessions look long, not active time).',
  },
  opencode: {
    key: 'opencode',
    label: 'OpenCode',
    color: 'green',
    defaultEnabled: true,
    tracksLineDeltas: true,
    partial: false,
    reportNote: null,
  },
  cursor: {
    key: 'cursor',
    label: 'Cursor',
    color: 'blue',
    defaultEnabled: true,
    tracksLineDeltas: true,
    partial: true,
    reportNote: 'Cursor rows marked ~ are partial (counts stored server-side).',
  },
} as const;

export type HarnessKey = keyof typeof HARNESS_METADATA;
export type HarnessMetadata = (typeof HARNESS_METADATA)[HarnessKey];

export const harnessKeys = Object.keys(HARNESS_METADATA) as HarnessKey[];
export const harnessKeyList = harnessKeys.join('|');
export const harnessLabelList = harnessKeys.map((key) => HARNESS_METADATA[key].label).join(' / ');

export const isHarnessKey = (value: string): value is HarnessKey => Object.hasOwn(HARNESS_METADATA, value);

export const harnessLabel = (key: HarnessKey) => HARNESS_METADATA[key].label;

export const harnessMetadataForLabel = (label: string): HarnessMetadata | null => {
  for (const key of harnessKeys) {
    const metadata = HARNESS_METADATA[key];
    if (metadata.label === label) {
      return metadata;
    }
  }
  return null;
};

export const lineTrackingHarnessLabels = () =>
  harnessKeys.filter((key) => HARNESS_METADATA[key].tracksLineDeltas).map((key) => HARNESS_METADATA[key].label);

export const nonLineTrackingHarnessLabels = () =>
  harnessKeys.filter((key) => !HARNESS_METADATA[key].tracksLineDeltas).map((key) => HARNESS_METADATA[key].label);

export const reportHarnessNotes = (): string[] =>
  harnessKeys.flatMap((key) => {
    const note: string | null = HARNESS_METADATA[key].reportNote;
    return note == null ? [] : [note];
  });
