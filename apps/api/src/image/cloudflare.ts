import { readImageDimensions } from './dimensions.ts';
import type { ImageProcessor, ImageSizeCalculator } from './types.ts';

// Fixed WebP quality for every recompressed inline image. 82 sits above the
// cwebp / photographic default of 75 so screenshots and text-heavy UI images —
// the bulk of Copilot traffic — survive our lossy pass before the upstream
// provider applies its own downscale and re-encode, while staying low enough
// to keep the bandwidth win. Kept as a single constant pending per-content
// tuning. References:
// - https://developers.google.com/speed/webp/docs/cwebp (default quality 75)
// - https://platform.claude.com/docs/en/build-with-claude/vision (multi-pass
//   compression warning)
// - https://getwebp.com/blog/screenshots-webp-settings-text-ui
const WEBP_QUALITY = 82;

// Minimal shape of the Cloudflare Images Workers binding we depend on, hand-
// typed (like D1Database) so the runtime contract does not pull in the full
// @cloudflare/workers-types surface. We use only the transform/output path;
// `info()` is intentionally not modelled because it is billed per call (see
// ./dimensions.ts). Reference:
// https://developers.cloudflare.com/images/transform-images/bindings/
export interface ImagesBinding {
  input(stream: ReadableStream): ImageTransformer;
}

interface ImageTransformer {
  transform(options: ImageTransformOptions): ImageTransformer;
  output(options: ImageOutputOptions): Promise<ImageTransformationResult>;
}

interface ImageTransformOptions {
  width?: number;
  height?: number;
  fit?: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad';
}

interface ImageOutputOptions {
  format: string;
  quality?: number;
}

interface ImageTransformationResult {
  image(): ReadableStream;
}

const streamFrom = (bytes: Uint8Array): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

class CloudflareImageProcessor implements ImageProcessor {
  constructor(private readonly images: ImagesBinding) {}

  async compressToWebp(input: Uint8Array, targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    let transformer = this.images.input(streamFrom(input));

    // Resize only when we can read the source dimensions locally. For formats
    // our header parser does not recognise we still re-encode to WebP, just
    // without applying the calculator.
    const dimensions = readImageDimensions(input);
    if (dimensions) {
      const target = targetSize(dimensions);
      transformer = transformer.transform({ width: target.width, height: target.height, fit: 'scale-down' });
    }

    const result = await transformer.output({ format: 'image/webp', quality: WEBP_QUALITY });
    return new Uint8Array(await new Response(result.image()).arrayBuffer());
  }
}

export const createCloudflareImageProcessor = (images: ImagesBinding): ImageProcessor => new CloudflareImageProcessor(images);
