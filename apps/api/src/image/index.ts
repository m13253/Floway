import type { ImageProcessor } from './types.ts';

let _imageProcessor: ImageProcessor | null = null;

export function initImageProcessor(processor: ImageProcessor): void {
  _imageProcessor = processor;
}

export function getImageProcessor(): ImageProcessor {
  if (!_imageProcessor) throw new Error('Image processor not initialized — call initImageProcessor() first');
  return _imageProcessor;
}
