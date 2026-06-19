import type { Hono } from 'hono';

import { mountCodexRoutes } from './codex/routes.ts';
import { embeddings } from './embeddings/serve.ts';
import { imagesEdits, imagesGenerations } from './images/serve.ts';
import { mountLlmRoutes } from './llm/routes.ts';
import { captureRequestDump } from './middleware/capture-dump.ts';
import { serveGeminiModelInfo, serveGeminiModels } from './models/gemini.ts';
import { models } from './models/serve.ts';

export const mountDataPlane = (app: Hono) => {
  mountLlmRoutes(app);
  mountCodexRoutes(app);

  // Model listing endpoints carry no upstream model call and are excluded
  // from dump capture; only the model-invoking endpoints below wear the
  // capture middleware.
  const dump = captureRequestDump();
  app.get('/v1/models', models);
  app.get('/models', models);
  app.get('/v1beta/models', serveGeminiModels);
  app.get('/v1beta/models/:modelId{.+}', serveGeminiModelInfo);
  app.post('/v1/embeddings', dump, embeddings);
  app.post('/embeddings', dump, embeddings);
  app.post('/v1/images/generations', dump, imagesGenerations);
  app.post('/images/generations', dump, imagesGenerations);
  app.post('/v1/images/edits', dump, imagesEdits);
  app.post('/images/edits', dump, imagesEdits);
};
