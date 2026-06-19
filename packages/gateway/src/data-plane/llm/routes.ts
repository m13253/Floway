import type { Hono } from 'hono';

import { chatCompletionsHttp } from './chat-completions/http.ts';
import { geminiHttp } from './gemini/http.ts';
import { messagesHttp } from './messages/http.ts';
import { responsesHttp } from './responses/http.ts';
import { responsesWebSocket } from './responses/websocket.ts';
import { captureRequestDump } from '../middleware/capture-dump.ts';

export const mountLlmRoutes = (app: Hono) => {
  // `count_tokens` and the WebSocket upgrade are excluded from dump capture:
  // count_tokens is a local pre-flight that does not produce a billable
  // upstream model call, and the WebSocket entry runs its own framing loop
  // outside the request/response middleware lifecycle.
  const dump = captureRequestDump();
  app.post('/v1/chat/completions', dump, chatCompletionsHttp.generate);
  app.post('/chat/completions', dump, chatCompletionsHttp.generate);
  app.post('/v1/responses', dump, responsesHttp.generate);
  app.post('/responses', dump, responsesHttp.generate);
  app.post('/v1/responses/compact', dump, responsesHttp.compact);
  app.post('/responses/compact', dump, responsesHttp.compact);
  app.post('/v1/messages', dump, messagesHttp.generate);
  app.post('/messages', dump, messagesHttp.generate);
  app.post('/v1/messages/count_tokens', messagesHttp.countTokens);
  app.post('/messages/count_tokens', messagesHttp.countTokens);
  app.get('/v1/responses', responsesWebSocket);
  app.get('/responses', responsesWebSocket);
  // Gemini encodes both the model id and the action in one path segment
  // (e.g. `models/gemini-2.5-pro:streamGenerateContent`); `geminiHttp`
  // splits on the trailing `:` and fans out to the right sub-endpoint.
  app.post('/v1beta/models/:modelAction{.+}', dump, geminiHttp);
};
