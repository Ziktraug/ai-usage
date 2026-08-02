import { readLocalCampaignLabelOverrides } from '@ai-usage/local-machine/campaign-label-config';
import {
  type CampaignLabelOverride,
  type CampaignLabelOverrideMutation,
  parseCampaignLabelOverrideMutation,
  parseCampaignLabelOverrides,
} from '@ai-usage/report-core/campaign-label';
import { parseWebUsageEngineCommand, type WebUsageEngineCommand } from '@ai-usage/usage-engine-control';
import { validateTrustedLocalRequest } from './local-request-trust.server';
import {
  type ExecuteUsageEngineCommandOptions,
  executeUsageEngineCommandToCompletion,
} from './usage-engine-command.server';
import { resolveUsageEngineControlClientForServer } from './usage-engine-control-resolver.server';

type SetCampaignLabelOverrideCommand = Extract<
  WebUsageEngineCommand,
  { readonly command: 'set-campaign-label-override' }
>;

type ExecuteCampaignLabelCommand = (
  command: SetCampaignLabelOverrideCommand,
  options?: ExecuteUsageEngineCommandOptions,
) => Promise<unknown>;

type ReadCampaignLabelOverrides = () => Promise<CampaignLabelOverride[]>;

const executeCampaignLabelCommand: ExecuteCampaignLabelCommand = async (command, options) => {
  const control = await resolveUsageEngineControlClientForServer();
  return await executeUsageEngineCommandToCompletion(control, command, options);
};

export const getCampaignLabelOverridesForServer = async (
  readOverrides: ReadCampaignLabelOverrides = readLocalCampaignLabelOverrides,
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => ({
  campaignLabelOverrides: parseCampaignLabelOverrides(await readOverrides()),
});

export const setCampaignLabelOverrideForServer = async (
  input: CampaignLabelOverrideMutation,
  execute: ExecuteCampaignLabelCommand = executeCampaignLabelCommand,
  readOverrides: ReadCampaignLabelOverrides = readLocalCampaignLabelOverrides,
  options?: ExecuteUsageEngineCommandOptions,
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => {
  const mutation = parseCampaignLabelOverrideMutation(input);
  const command = parseWebUsageEngineCommand({ command: 'set-campaign-label-override', ...mutation });
  if (command.command !== 'set-campaign-label-override') {
    throw new Error('Expected a campaign label override command.');
  }
  await execute(command, options);
  return await getCampaignLabelOverridesForServer(readOverrides);
};

export const setCampaignLabelOverrideFromRequestForServer = async (
  request: Request,
  input: CampaignLabelOverrideMutation,
  execute?: ExecuteCampaignLabelCommand,
  readOverrides?: ReadCampaignLabelOverrides,
): Promise<{ campaignLabelOverrides: CampaignLabelOverride[] }> => {
  const trustFailure = validateTrustedLocalRequest(request);
  if (trustFailure) {
    throw trustFailure;
  }
  return await setCampaignLabelOverrideForServer(input, execute, readOverrides, { signal: request.signal });
};
