import { compressImageDataUrlToWebp, isBase64ImageDataUrl } from '../../../../../image/inline.ts';
import { imageSizeCalculatorForModel } from '../../../../../image/size.ts';
import type { ChatCompletionsInterceptor } from '../../../../llm/interceptors.ts';

// Recompresses every inline base64 image (`data:image/*;base64,...` in an
// `image_url` part) in the outgoing Chat Completions payload to WebP before
// the Copilot upstream call. Remote https image references are left untouched.
export const withInlineImagesCompressed: ChatCompletionsInterceptor = async (ctx, _request, run) => {
  const targets: { url: string }[] = [];
  for (const message of ctx.payload.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url' && isBase64ImageDataUrl(part.image_url.url)) targets.push(part.image_url);
    }
  }

  if (targets.length > 0) {
    const targetSize = imageSizeCalculatorForModel(ctx.upstreamModel.id);
    await Promise.all(
      targets.map(async target => {
        target.url = await compressImageDataUrlToWebp(target.url, targetSize);
      }),
    );
  }

  return await run();
};
