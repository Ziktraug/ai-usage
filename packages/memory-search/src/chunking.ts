import { createHash } from 'node:crypto';
import {
  type MemoryItem,
  type MemoryJsonValue,
  type MemoryRevision,
  memoryContentHash,
  memoryRevisionContent,
} from '@ai-usage/memory-service/domain';
import { MEMORY_SEARCH_CHUNKER_VERSION } from '@ai-usage/memory-service/search';

export const memorySearchChunkBounds = Object.freeze({
  maxChunkCharacters: 2048,
  maxStructuredCharacters: 16_384,
});

export interface MemorySearchChunk {
  readonly chunkerVersion: typeof MEMORY_SEARCH_CHUNKER_VERSION;
  readonly chunkId: string;
  readonly chunkOrdinal: number;
  readonly contentHash: string;
  readonly guidance: string;
  readonly item: MemoryItem;
  readonly revision: MemoryRevision;
  readonly structuredTerms: string;
  readonly summary: string;
  readonly supportingText: string;
  readonly title: string;
}

const isMemoryJsonObject = (value: MemoryJsonValue): value is { readonly [key: string]: MemoryJsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const flattenStructuredValue = (value: MemoryJsonValue, path: string, output: string[]): void => {
  if (output.join('\n').length >= memorySearchChunkBounds.maxStructuredCharacters) {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      flattenStructuredValue(item, `${path}[${index}]`, output);
    }
    return;
  }
  if (isMemoryJsonObject(value)) {
    for (const key of Object.keys(value).sort()) {
      flattenStructuredValue(value[key] ?? null, path.length === 0 ? key : `${path}.${key}`, output);
    }
    return;
  }
  output.push(`${path}: ${String(value)}`);
};

export const memorySearchStructuredText = (value: MemoryJsonValue): string => {
  const output: string[] = [];
  flattenStructuredValue(value, '', output);
  return output.join('\n').slice(0, memorySearchChunkBounds.maxStructuredCharacters);
};

const splitText = (value: string): readonly string[] => {
  if (value.length === 0) {
    return [''];
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < value.length; offset += memorySearchChunkBounds.maxChunkCharacters) {
    chunks.push(value.slice(offset, offset + memorySearchChunkBounds.maxChunkCharacters));
  }
  return chunks;
};

export const createMemorySearchChunks = (item: MemoryItem, revision: MemoryRevision): readonly MemorySearchChunk[] => {
  if (item.id !== revision.memoryItemId || item.currentRevisionId !== revision.id) {
    throw new Error('Memory search projection requires the exact current revision.');
  }
  const contentHash = memoryContentHash(memoryRevisionContent(revision));
  const guidance = revision.guidance.join('\n');
  const structuredTerms = memorySearchStructuredText(revision.structuredContent);
  const supportingChunks = splitText([revision.summary, guidance, structuredTerms].filter(Boolean).join('\n'));
  return Object.freeze(
    supportingChunks.map((supportingText, chunkOrdinal) => ({
      chunkId: createHash('sha256')
        .update(`${MEMORY_SEARCH_CHUNKER_VERSION}:${revision.id}:${chunkOrdinal}`)
        .digest('hex'),
      chunkOrdinal,
      chunkerVersion: MEMORY_SEARCH_CHUNKER_VERSION,
      contentHash,
      guidance: guidance.slice(0, memorySearchChunkBounds.maxChunkCharacters),
      item,
      revision,
      structuredTerms: structuredTerms.slice(0, memorySearchChunkBounds.maxChunkCharacters),
      summary: revision.summary.slice(0, memorySearchChunkBounds.maxChunkCharacters),
      supportingText,
      title: revision.title,
    })),
  );
};
