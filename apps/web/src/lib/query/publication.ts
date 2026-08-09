import { type CurrentAliasQueryKey, currentAliasKey } from './keys';

const reportManifestFamily = 'report-manifest';
const reportBootstrapFamily = 'report-bootstrap';

export const currentReportAliasKeys = (): readonly [CurrentAliasQueryKey, CurrentAliasQueryKey] => [
  currentAliasKey(reportManifestFamily),
  currentAliasKey(reportBootstrapFamily),
];
