import { test } from 'vitest';

import { kindForEndpoints, modelEndpointToPublicPath, modelEndpointsToPublicPaths, publicPathToModelEndpoint } from './endpoints.ts';
import { assertEquals } from '../../test-assert.ts';

test('publicPathToModelEndpoint maps both prefix variants for image endpoints', () => {
  assertEquals(publicPathToModelEndpoint('/images/generations'), 'imagesGenerations');
  assertEquals(publicPathToModelEndpoint('/v1/images/generations'), 'imagesGenerations');
  assertEquals(publicPathToModelEndpoint('/images/edits'), 'imagesEdits');
  assertEquals(publicPathToModelEndpoint('/v1/images/edits'), 'imagesEdits');
});

test('modelEndpointToPublicPath returns the canonical path for image endpoints', () => {
  assertEquals(modelEndpointToPublicPath('imagesGenerations'), '/images/generations');
  assertEquals(modelEndpointToPublicPath('imagesEdits'), '/images/edits');
});

test('modelEndpointsToPublicPaths lists the public path for each present endpoint', () => {
  assertEquals(modelEndpointsToPublicPaths({ imagesGenerations: {}, imagesEdits: {} }), ['/images/generations', '/images/edits']);
});

test('kindForEndpoints returns image when either images endpoint is present', () => {
  assertEquals(kindForEndpoints({ imagesGenerations: {} }), 'image');
  assertEquals(kindForEndpoints({ imagesEdits: {} }), 'image');
  assertEquals(kindForEndpoints({ imagesGenerations: {}, imagesEdits: {} }), 'image');
});

test('kindForEndpoints still returns embedding for embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ embeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ chatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ messages: {} }), 'chat');
});
