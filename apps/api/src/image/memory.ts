import type { ImageProcessor, ImageSizeCalculator } from './types.ts';

// In-memory image processor for tests, mirroring InMemoryRepo. There is no
// WebP codec available under the test runtime, so this stub returns the input
// bytes unchanged; it exists only to satisfy the ImageProcessor contract so
// the egress interceptors run end-to-end. Interceptor behaviour (which images
// are rewritten, what size calculator is used) is asserted against a dedicated
// spy processor in the interceptor tests, not against this stub.
class InMemoryImageProcessor implements ImageProcessor {
  compressToWebp(input: Uint8Array, _targetSize: ImageSizeCalculator): Promise<Uint8Array> {
    return Promise.resolve(input);
  }
}

export const createInMemoryImageProcessor = (): ImageProcessor => new InMemoryImageProcessor();
