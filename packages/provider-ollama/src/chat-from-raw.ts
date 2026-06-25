import type { OllamaRawModel } from './fetch-models.ts';
import type { UpstreamChatModelConfig } from '@floway-dev/provider';

// `^gpt-oss[:_-]` matches `gpt-oss:20b` (tag-suffixed) and any future
// `gpt-oss-*` or `gpt-oss_*` family member. The gpt-oss (harmony) family
// is the only Ollama family whose chat template renders `.ThinkLevel` literally
// (as `Reasoning: {{ .ThinkLevel }}`), so effort strings low/medium/high have
// differential effect. The server downgrades `max → high` for this family
// (ollama/server/routes.go:440-450). All other thinking-capable families
// (qwen3, deepseek-r1, glm-4, …) only read a boolean `.Think` from the
// template, so effort strings produce no differential output — `adaptive: true`
// is the honest catalog representation for those.
const GPT_OSS_FAMILY = /^gpt-oss[:_-]/i;

export const chatFromOllamaRaw = (raw: OllamaRawModel): UpstreamChatModelConfig | undefined => {
  const chat: UpstreamChatModelConfig = {};

  if (raw.capabilities.has('vision')) {
    chat.modalities = { input: ['text', 'image'], output: ['text'] };
  }

  if (raw.capabilities.has('thinking')) {
    chat.reasoning = GPT_OSS_FAMILY.test(raw.id)
      ? { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } }
      : { adaptive: true };
  }

  return Object.keys(chat).length > 0 ? chat : undefined;
};
