import { type ProjectGroupConfig, projectSourceSelectorKey } from '@ai-usage/report-core/project-group';
import {
  parseWebUsageEngineCommand,
  type UsageEngineProjectSourceReference,
  type WebUsageEngineCommand,
} from '@ai-usage/usage-engine-control';

type ProjectGroupReferenceCommand = Extract<
  WebUsageEngineCommand,
  { readonly command: 'replace-project-groups-by-reference' }
>;

const bytesToHex = (bytes: Uint8Array): string => {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
};

export const projectSourceReferenceForSelector = async (
  selector: ProjectGroupConfig['sources'][number],
): Promise<UsageEngineProjectSourceReference> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(projectSourceSelectorKey(selector)));
  return `project-source:${bytesToHex(new Uint8Array(digest))}` as UsageEngineProjectSourceReference;
};

export const buildProjectGroupReferenceCommand = async (
  projectGroups: readonly ProjectGroupConfig[],
  revision: string,
): Promise<ProjectGroupReferenceCommand> => {
  const command = parseWebUsageEngineCommand({
    command: 'replace-project-groups-by-reference',
    projectGroups: await Promise.all(
      projectGroups.map(async (group) => ({
        id: group.id,
        name: group.name,
        sources: await Promise.all(group.sources.map(projectSourceReferenceForSelector)),
      })),
    ),
    revision,
  });
  if (command.command !== 'replace-project-groups-by-reference') {
    throw new Error('Project group reference command parsing returned another command kind.');
  }
  return command;
};
