import { createHash } from 'node:crypto';
import type { DBAdapter, DBAdapterInstance, DBTransactionAdapter, Where } from 'better-auth';

const redactedSessionToken = '[REDACTED]';

export const digestWebSessionToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url');

const transformTokenValue = (value: Where['value'], rawByDigest: Map<string, string>): Where['value'] => {
  if (typeof value === 'string') {
    const digest = digestWebSessionToken(value);
    rawByDigest.set(digest, value);
    return digest;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.map((item) => {
      const digest = digestWebSessionToken(item);
      rawByDigest.set(digest, item);
      return digest;
    });
  }
  return value;
};

const transformWhere = (
  model: string,
  where: readonly Where[] | undefined,
  rawByDigest: Map<string, string>,
): Where[] | undefined =>
  where?.map((clause) =>
    model === 'session' && clause.field === 'token'
      ? { ...clause, value: transformTokenValue(clause.value, rawByDigest) }
      : clause,
  );

const transformData = <Value extends Record<string, unknown>>(
  model: string,
  data: Value,
  rawByDigest: Map<string, string>,
): Value => {
  if (model !== 'session' || typeof data.token !== 'string') {
    return data;
  }
  return { ...data, token: transformTokenValue(data.token, rawByDigest) };
};

const restoreToken = <Value>(model: string, value: Value, rawByDigest: ReadonlyMap<string, string>): Value => {
  if (model !== 'session' || typeof value !== 'object' || value === null || !('token' in value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const token = typeof record.token === 'string' ? rawByDigest.get(record.token) : undefined;
  return { ...record, token: token ?? redactedSessionToken } as Value;
};

const wrapTransactionAdapter = (adapter: DBTransactionAdapter): DBTransactionAdapter => ({
  count: (input) => {
    const rawByDigest = new Map<string, string>();
    return adapter.count({ ...input, where: transformWhere(input.model, input.where, rawByDigest) });
  },
  create: async <T extends Record<string, unknown>, R = T>(input: {
    readonly data: Omit<T, 'id'>;
    readonly forceAllowId?: boolean | undefined;
    readonly model: string;
    readonly select?: string[] | undefined;
  }): Promise<R> => {
    const rawByDigest = new Map<string, string>();
    const value = await adapter.create<T, R>({
      ...input,
      data: transformData(input.model, input.data, rawByDigest),
    });
    return restoreToken(input.model, value, rawByDigest);
  },
  createSchema: adapter.createSchema,
  delete: (input) => {
    const rawByDigest = new Map<string, string>();
    return adapter.delete({ ...input, where: transformWhere(input.model, input.where, rawByDigest) ?? [] });
  },
  deleteMany: (input) => {
    const rawByDigest = new Map<string, string>();
    return adapter.deleteMany({ ...input, where: transformWhere(input.model, input.where, rawByDigest) ?? [] });
  },
  findMany: async <T>(input: {
    readonly join?: Parameters<DBTransactionAdapter['findMany']>[0]['join'] | undefined;
    readonly limit?: number | undefined;
    readonly model: string;
    readonly offset?: number | undefined;
    readonly select?: string[] | undefined;
    readonly sortBy?: { readonly direction: 'asc' | 'desc'; readonly field: string } | undefined;
    readonly where?: Where[] | undefined;
  }): Promise<T[]> => {
    const rawByDigest = new Map<string, string>();
    const values = await adapter.findMany<T>({
      ...input,
      where: transformWhere(input.model, input.where, rawByDigest),
    });
    return values.map((value) => restoreToken(input.model, value, rawByDigest));
  },
  findOne: async <T>(input: {
    readonly join?: Parameters<DBTransactionAdapter['findOne']>[0]['join'] | undefined;
    readonly model: string;
    readonly select?: string[] | undefined;
    readonly where: Where[];
  }): Promise<T | null> => {
    const rawByDigest = new Map<string, string>();
    const value = await adapter.findOne<T>({
      ...input,
      where: transformWhere(input.model, input.where, rawByDigest) ?? [],
    });
    return restoreToken(input.model, value, rawByDigest);
  },
  id: `${adapter.id}-session-digests`,
  consumeOne: async <T>(input: { readonly model: string; readonly where: Where[] }): Promise<T | null> => {
    const rawByDigest = new Map<string, string>();
    const value = await adapter.consumeOne<T>({
      ...input,
      where: transformWhere(input.model, input.where, rawByDigest) ?? [],
    });
    return restoreToken(input.model, value, rawByDigest);
  },
  incrementOne: async <T>(input: {
    readonly increment: Record<string, number>;
    readonly model: string;
    readonly set?: Record<string, unknown> | undefined;
    readonly where: Where[];
  }): Promise<T | null> => {
    const rawByDigest = new Map<string, string>();
    const value = await adapter.incrementOne<T>({
      ...input,
      set: input.set ? transformData(input.model, input.set, rawByDigest) : undefined,
      where: transformWhere(input.model, input.where, rawByDigest) ?? [],
    });
    return restoreToken(input.model, value, rawByDigest);
  },
  options: adapter.options,
  update: async <T>(input: {
    readonly model: string;
    readonly update: Record<string, unknown>;
    readonly where: Where[];
  }): Promise<T | null> => {
    const rawByDigest = new Map<string, string>();
    const value = await adapter.update<T>({
      ...input,
      update: transformData(input.model, input.update, rawByDigest),
      where: transformWhere(input.model, input.where, rawByDigest) ?? [],
    });
    return restoreToken(input.model, value, rawByDigest);
  },
  updateMany: (input) => {
    const rawByDigest = new Map<string, string>();
    return adapter.updateMany({
      ...input,
      update: transformData(input.model, input.update, rawByDigest),
      where: transformWhere(input.model, input.where, rawByDigest) ?? [],
    });
  },
});

export const withWebSessionTokenDigests =
  (database: DBAdapterInstance): DBAdapterInstance =>
  (options) => {
    const adapter = database(options);
    const wrapped = wrapTransactionAdapter(adapter);
    const result: DBAdapter = {
      ...wrapped,
      id: `${adapter.id}-session-digests`,
      transaction: (run) => adapter.transaction((transaction) => run(wrapTransactionAdapter(transaction))),
    };
    return result;
  };
