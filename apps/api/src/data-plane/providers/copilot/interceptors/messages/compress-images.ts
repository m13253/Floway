import { compressBase64ImageToWebp } from '../../../../../image/inline.ts';
import { imageSizeCalculatorForModel } from '../../../../../image/size.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import type { MessagesImageBlock, MessagesMessage } from '@floway-dev/protocols/messages';

// Anthropic carries inline images both at the top level of a message's content
// and nested inside tool_result content, mirroring the vision-header scan.
const collectImageBlocks = (messages: MessagesMessage[]): MessagesImageBlock[] => {
  const blocks: MessagesImageBlock[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'image') blocks.push(block);
      else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === 'image') blocks.push(inner);
        }
      }
    }
  }
  return blocks;
};

// Recompresses every inline base64 image in the outgoing Messages payload to
// WebP before the Copilot upstream call. Generic in the run-result type so the
// same definition serves both the streaming Messages target chain and the
// count_tokens chain, keeping the token estimate aligned with the resized
// image we actually send.
export const withInlineImagesCompressed = async <TResult>(ctx: MessagesInvocation, _request: RequestContext, run: () => Promise<TResult>): Promise<TResult> => {
  const blocks = collectImageBlocks(ctx.payload.messages);
  if (blocks.length > 0) {
    const targetSize = imageSizeCalculatorForModel(ctx.upstreamModel.id);
    await Promise.all(
      blocks.map(async block => {
        block.source.data = await compressBase64ImageToWebp(block.source.data, targetSize);
        block.source.media_type = 'image/webp';
      }),
    );
  }

  return await run();
};
