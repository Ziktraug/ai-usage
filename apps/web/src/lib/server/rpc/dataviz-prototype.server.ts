import { open } from 'node:fs/promises';
import { datavizPrototypeContract, datavizPrototypeSnapshotSchema } from '@ai-usage/web-contract/dataviz-prototype';
import { implement } from '@orpc/server';
import { parse } from 'valibot';

export const createDatavizPrototypeRouter = (enabled = false) => ({
  snapshot: implement(datavizPrototypeContract).snapshot.handler(async ({ errors }) => {
    const path = process.env.AI_USAGE_DATAVIZ_SNAPSHOT;
    if (!(enabled && path)) {
      throw errors.Unavailable({ data: { reason: 'prototype-disabled' }, message: 'The local prototype is disabled.' });
    }
    const file = await open(path, 'r');
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) {
        throw new Error('Snapshot exceeds its bound.');
      }
      return parse(datavizPrototypeSnapshotSchema, JSON.parse(await file.readFile('utf8')));
    } finally {
      await file.close();
    }
  }),
});
