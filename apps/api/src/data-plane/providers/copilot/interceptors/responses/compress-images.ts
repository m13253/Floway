import { compressImageDataUrlToWebp, isBase64ImageDataUrl } from '../../../../../image/inline.ts';
import { imageSizeCalculatorForModel } from '../../../../../image/size.ts';
import type { ResponsesInterceptor } from '../../../../llm/interceptors.ts';
import type { ResponseInputImage } from '@floway-dev/protocols/responses';

// Recompresses every inline base64 image (`input_image` with a
// `data:image/*;base64,...` url) in the outgoing Responses payload to WebP
// before the Copilot upstream call. Remote https image references are left
// untouched.
export const withInlineImagesCompressed: ResponsesInterceptor = async (ctx, _request, run) => {
  const targets: ResponseInputImage[] = [];
  if (Array.isArray(ctx.payload.input)) {
    for (const item of ctx.payload.input) {
      if (item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part.type === 'input_image' && isBase64ImageDataUrl(part.image_url)) targets.push(part);
      }
    }
  }

  if (targets.length > 0) {
    const targetSize = imageSizeCalculatorForModel(ctx.upstreamModel.id);
    await Promise.all(
      targets.map(async target => {
        target.image_url = await compressImageDataUrlToWebp(target.image_url, targetSize);
      }),
    );
  }

  return await run();
};
