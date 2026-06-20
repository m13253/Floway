import type { Hono } from 'hono';

import { mountCodexRoutes } from './codex/routes.ts';
import { embeddings } from './embeddings/serve.ts';
import { imagesEdits, imagesGenerations } from './images/serve.ts';
import { mountLlmRoutes } from './llm/routes.ts';
import { captureRequestDump } from './middleware/capture-dump.ts';
import { serveGeminiModelInfo, serveGeminiModels } from './models/gemini.ts';
import { models } from './models/serve.ts';

// Every data-plane route runs through capture-dump first; the middleware
// short-circuits when the request's API key has no retention configured, so
// the steady-state cost on dump-disabled keys is one map lookup.
export const mountDataPlane = (app: Hono) => {
  app.use('/v1/*', captureRequestDump());
  app.use('/v1beta/*', captureRequestDump());
  app.use('/chat/*', captureRequestDump());
  app.use('/responses', captureRequestDump());
  app.use('/responses/*', captureRequestDump());
  app.use('/messages', captureRequestDump());
  app.use('/messages/*', captureRequestDump());
  app.use('/embeddings', captureRequestDump());
  app.use('/images/*', captureRequestDump());
  app.use('/models', captureRequestDump());
  app.use('/azure-api.codex/*', captureRequestDump());

  mountLlmRoutes(app);
  mountCodexRoutes(app);

  app.get('/v1/models', models);
  app.get('/models', models);
  app.get('/v1beta/models', serveGeminiModels);
  app.get('/v1beta/models/:modelId{.+}', serveGeminiModelInfo);
  app.post('/v1/embeddings', embeddings);
  app.post('/embeddings', embeddings);
  app.post('/v1/images/generations', imagesGenerations);
  app.post('/images/generations', imagesGenerations);
  app.post('/v1/images/edits', imagesEdits);
  app.post('/images/edits', imagesEdits);
};
