import { expect, test } from 'bun:test';
import { SEMANTIC_MODEL } from './semantic-model';
import { modelAssetRequest } from './semantic-network';

const asset = `https://huggingface.co/${SEMANTIC_MODEL.id}/resolve/${SEMANTIC_MODEL.revision}/config.json`;
test('model download strips ambient credentials and referring page information', () => {
  const request = modelAssetRequest(asset);
  expect(request.init.method).toBe('GET');
  expect(request.init.credentials).toBe('omit');
  expect(request.init.referrerPolicy).toBe('no-referrer');
});
test('rejects uploads, arbitrary destinations, mutable model revisions and text in query strings', () => {
  expect(() => modelAssetRequest(asset, { body: 'PRIVATE_PROMPT_SENTINEL', method: 'POST' })).toThrow();
  expect(() => modelAssetRequest(`${asset}?text=PRIVATE_PROMPT_SENTINEL`)).toThrow();
  expect(() => modelAssetRequest(asset.replace(SEMANTIC_MODEL.revision, 'main'))).toThrow();
  expect(() => modelAssetRequest('https://example.com/inference')).toThrow();
  expect(() => modelAssetRequest('http://127.0.0.1:1234/inference')).toThrow();
});
