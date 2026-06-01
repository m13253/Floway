import type { Hono } from 'hono';

import { chatCompletionsTraits } from './sources/chat-completions/traits.ts';
import { geminiTraits } from './sources/gemini/traits.ts';
import { messagesTraits } from './sources/messages/traits.ts';
import { responsesTraits } from './sources/responses/traits.ts';
import { serveLlm } from './sources/serve.ts';

export const mountLlmRoutes = (app: Hono) => {
  const serveChatCompletions = serveLlm(chatCompletionsTraits, 'generate');
  const serveResponses = serveLlm(responsesTraits, 'generate');
  const serveMessages = serveLlm(messagesTraits, 'generate');
  const serveMessagesCountTokens = serveLlm(messagesTraits, 'countTokens');
  const serveGemini = serveLlm(geminiTraits, 'generate');

  app.post('/v1/chat/completions', serveChatCompletions);
  app.post('/chat/completions', serveChatCompletions);
  app.post('/v1/responses', serveResponses);
  app.post('/responses', serveResponses);
  app.post('/v1/messages', serveMessages);
  app.post('/messages', serveMessages);
  app.post('/v1/messages/count_tokens', serveMessagesCountTokens);
  app.post('/messages/count_tokens', serveMessagesCountTokens);
  app.post('/v1beta/models/:modelAction{.+}', serveGemini);
};
