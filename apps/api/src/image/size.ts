import type { ImageDimensions, ImageSizeCalculator } from './types.ts';

// Upper bound on an outbound image's longest edge. The default is deliberately
// conservative: it sits at the smallest of the major providers' server-side
// resize thresholds (Anthropic shrinks anything past ~1568px on its long
// edge), so our single recompression pass never enlarges past what the
// upstream would itself downscale, and never hands the model a larger image
// than it can use. Per-model tile budgets — to be derived from live probing —
// will replace this through imageSizeCalculatorForModel below.
// Reference: https://platform.claude.com/docs/en/build-with-claude/vision
const DEFAULT_MAX_LONG_EDGE = 1568;

export const defaultImageSizeCalculator: ImageSizeCalculator = ({ width, height }: ImageDimensions): ImageDimensions => {
  const longEdge = Math.max(width, height);
  if (longEdge <= DEFAULT_MAX_LONG_EDGE) return { width, height };
  const scale = DEFAULT_MAX_LONG_EDGE / longEdge;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

// Resolves the size calculator for a given upstream model. Every model shares
// the conservative default today; this is the single seam where probed,
// per-model tile-budget calculators will be wired in once measured.
export const imageSizeCalculatorForModel = (_upstreamModelId: string): ImageSizeCalculator => defaultImageSizeCalculator;
