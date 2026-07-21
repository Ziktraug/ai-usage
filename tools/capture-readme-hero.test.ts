import { expect, test } from 'bun:test';
import path from 'node:path';

const HERO_WIDTH = 1600;
const HERO_HEIGHT = 900;
const MAX_HERO_BYTES = 1024 * 1024;
const heroPath = path.resolve(import.meta.dirname, '..', 'docs', 'assets', 'ai-usage-overview-session-detail.png');

test('the committed README hero has the documented dimensions and byte budget', async () => {
  const hero = Bun.file(heroPath);
  expect(await hero.exists()).toBe(true);
  expect(hero.size).toBeLessThan(MAX_HERO_BYTES);

  const bytes = new Uint8Array(await hero.arrayBuffer());
  const dimensions = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(dimensions.getUint32(16)).toBe(HERO_WIDTH);
  expect(dimensions.getUint32(20)).toBe(HERO_HEIGHT);
});
