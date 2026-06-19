export interface SyncInvite {
  v: 1;
  name: string;
  url: string;
  tokenEnv: string;
  token: string;
}

const invitePrefix = 'ai-usage-sync-v1:';

export const encodeSyncInvite = (invite: SyncInvite) =>
  `${invitePrefix}${Buffer.from(JSON.stringify(invite), 'utf8').toString('base64url')}`;

export const decodeSyncInvite = (value: string): SyncInvite => {
  const trimmed = value.trim();
  if (!trimmed.startsWith(invitePrefix)) throw new Error('Expected an ai-usage sync invite string.');
  const encoded = trimmed.slice(invitePrefix.length);
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SyncInvite>;
  if (parsed.v !== 1) throw new Error('Unsupported sync invite version.');
  if (!parsed.name || typeof parsed.name !== 'string') throw new Error('Sync invite is missing a remote name.');
  if (!parsed.url || typeof parsed.url !== 'string') throw new Error('Sync invite is missing a snapshot URL.');
  if (!parsed.tokenEnv || typeof parsed.tokenEnv !== 'string') throw new Error('Sync invite is missing a token env name.');
  if (!parsed.token || typeof parsed.token !== 'string') throw new Error('Sync invite is missing a token.');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(parsed.name)) throw new Error('Sync invite remote name is invalid.');
  try {
    const url = new URL(parsed.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must start with http:// or https://');
  } catch (cause) {
    throw new Error(`Sync invite snapshot URL is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.tokenEnv)) throw new Error('Sync invite token env name is invalid.');
  if (!/^[A-Za-z0-9_-]+$/.test(parsed.token)) throw new Error('Sync invite token is invalid.');
  return { v: 1, name: parsed.name, url: parsed.url, tokenEnv: parsed.tokenEnv, token: parsed.token };
};
