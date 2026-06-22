import { type HarnessKey, harnessLabel } from '@ai-usage/report-core/harness-metadata';
import type { UsageRowSource } from '@ai-usage/report-core/types';
import { normalizeUsageRow, type UsageRowInput } from '@ai-usage/report-core/usage-row';
import type { CollectorRow } from './rtk-enrichment';
import { withProjectPath, withSource } from './rtk-enrichment';

export type CollectedSessionSource = UsageRowSource & {
  harnessKey: HarnessKey;
};

export interface CollectedSession extends Omit<UsageRowInput, 'harness'> {
  projectPath?: string | null;
  source: CollectedSessionSource;
}

export const sessionToUsageRow = (session: CollectedSession): CollectorRow => {
  const { source, projectPath, ...input } = session;
  return withSource(
    withProjectPath(
      normalizeUsageRow({
        ...input,
        harness: harnessLabel(source.harnessKey),
      }),
      projectPath,
    ),
    source,
  );
};
