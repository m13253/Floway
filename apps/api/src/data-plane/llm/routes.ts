import type { Hono } from 'hono';

import { chatCompletionsTraits } from './sources/chat-completions/traits.ts';
import { geminiTraits } from './sources/gemini/traits.ts';
import { countTokens } from './sources/messages/count-tokens/serve.ts';
import { messagesTraits } from './sources/messages/traits.ts';
import { responsesTraits } from './sources/responses/traits.ts';
import { serveLlm } from './sources/serve.ts';

export const mountLlmRoutes = (app: Hono) => {
  const serveChatCompletions = serveLlm(chatCompletionsTraits);
  const serveResponses = serveLlm(responsesTraits);
  const serveMessages = serveLlm(messagesTraits);
  const serveGemini = serveLlm(geminiTraits);

  app.post('/v1/chat/completions', serveChatCompletions);
  app.post('/chat/completions', serveChatCompletions);
  app.post('/v1/responses', serveResponses);
  app.post('/responses', serveResponses);
  app.post('/v1/messages', serveMessages);
  app.post('/messages', serveMessages);
  app.post('/v1/messages/count_tokens', countTokens);
  app.post('/messages/count_tokens', countTokens);
  app.post('/v1beta/models/:modelAction{.+}', serveGemini);
};
