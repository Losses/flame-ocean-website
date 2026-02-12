/**
 * Shared Glyph Rendering Utilities
 *
 * Consolidates all glyph rendering operations into a single, consistent implementation.
 * Provides three core operations:
 * 1. Render glyph from font file to pixel grid (boolean[][])
 * 2. Render pixel grid to canvas for visualization (data URL)
 * 3. Binarize ImageData to boolean pixel grid
 */

import { createOffscreenCanvas, get2dContext } from './worker-utils.js';

/**
 * Font size in pixels for firmware fonts
 */
export type FontSize = 12 | 16;

/**
 * Glyph rendering configuration
 */
export interface GlyphRenderConfig {
	/** Font family name to use for rendering */
	readonly fontFamily: string;
	/** Font size in pixels (12 or 16) */
	readonly fontSize: FontSize;
	/** Brightness threshold for binarization (0-255, default: 128) */
	readonly brightnessThreshold?: number;
	/** Background color for rendering (default: white) */
	readonly bgColor?: string;
	/** Foreground color for rendering (default: black) */
	readonly fgColor?: string;
	/** Whether to use scaled rendering (default: true for pixel-perfect results) */
	readonly useScaling?: boolean;
	/** Scale factor when useScaling is true (default: 10) */
	readonly scaleFactor?: number;
	/** Text baseline for rendering (default: 'top') */
	readonly textBaseline?: CanvasTextBaseline;
}

/**
 * Canvas dimensions for font sizes
 */
const CANVAS_DIMENSIONS: Record<FontSize, { width: number; height: number }> = {
	12: { width: 12, height: 12 },
	16: { width: 16, height: 16 }
};

/**
 * Default rendering options
 */
const DEFAULT_OPTIONS: Required<Omit<GlyphRenderConfig, 'fontFamily' | 'fontSize'>> = {
	brightnessThreshold: 128,
	bgColor: '#ffffff',
	fgColor: '#000000',
	useScaling: true,
	scaleFactor: 10,
	textBaseline: 'top'
};

/**
 * Convert ImageData to boolean pixel array
 *
 * Reads RGBA pixel data and converts to a 2D boolean array where:
 * - true = black/foreground pixel
 * - false = white/background pixel
 *
 * Uses a configurable brightness threshold to determine foreground vs background.
 *
 * @param imageData - ImageData from canvas getImageData
 * @param threshold - Brightness threshold (0-255), default 128
 * @returns 2D boolean array representing pixels
 *
 * @example
 * ```ts
 * const ctx = canvas.getContext('2d');
 * const imageData = ctx.getImageData(0, 0, width, height);
 * const pixels = imageDataToPixels(imageData, 128);
 * // pixels[0][0] is top-left pixel (true = black, false = white)
 * ```
 */
export function imageDataToPixels(
	imageData: ImageData,
	threshold: number = 128
): boolean[][] {
	const pixels: boolean[][] = [];
	const data = imageData.data;
	const width = imageData.width;
	const height = imageData.height;

	for (let y = 0; y < height; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const r = data[i];
			const g = data[i + 1];
			const b = data[i + 2];
			// Alpha (data[i + 3]) is ignored

			// Calculate brightness as average of RGB channels
			const brightness = (r + g + b) / 3;

			// Pixel is foreground if brightness is below threshold (dark)
			// Threshold of 128 is the midpoint between 0 (black) and 255 (white)
			row.push(brightness < threshold);
		}
		pixels.push(row);
	}

	return pixels;
}

/**
 * Build font family string for canvas rendering
 *
 * Creates a properly formatted font family string with optional tofu fallback.
 *
 * @param fontFamily - Base font family name (e.g., "W95FA")
 * @param tofuFallback - Optional tofu font family name to include in stack
 * @returns Properly formatted font family string for canvas font property
 *
 * @example
 * ```ts
 * buildFontStackString("W95FA")           // Returns: 'W95FA'
 * buildFontStackString("W95FA", "Tofu")  // Returns: 'W95FA, Tofu'
 * ```
 */
export function buildFontStackString(
	fontFamily: string,
	tofuFallback?: string
): string {
	if (tofuFallback) {
		return `${fontFamily}, "${tofuFallback}"`;
	}
	return fontFamily;
}

/**
 * Render a single character to a pixel grid (boolean[][])
 *
 * Creates an offscreen canvas, renders the character using the provided font family,
 * and extracts the resulting black-and-white pixel bitmap.
 *
 * Supports two rendering modes:
 * 1. **Scaled rendering** (default): Renders at larger size (10x) and downsamples
 *    - Produces pixel-perfect results without anti-aliasing
 *    - Recommended for font extraction
 * 2. **Direct rendering**: Renders directly at target size
 *    - Faster but may have minor anti-aliasing artifacts
 *    - Recommended for tofu detection and debugging
 *
 * @param char - Single character to render
 * @param config - Rendering configuration
 * @returns 2D boolean array representing pixels (true = black, false = white)
 *
 * @example
 * ```ts
 * // Scaled rendering (pixel-perfect)
 * const pixels = await renderGlyphToPixels('A', {
 *   fontFamily: 'UserFont',
 *   fontSize: 12
 * });
 *
 * // Direct rendering (faster, for tofu detection)
 * const pixels = await renderGlyphToPixels('A', {
 *   fontFamily: 'UserFont',
 *   fontSize: 12,
 *   useScaling: false
 * });
 * ```
 */
export async function renderGlyphToPixels(
	char: string,
	config: GlyphRenderConfig
): Promise<boolean[][]> {
	// Merge with defaults
	const opts = { ...DEFAULT_OPTIONS, ...config };

	// Validate font size
	if (opts.fontSize !== 12 && opts.fontSize !== 16) {
		throw new Error(`Invalid font size: ${opts.fontSize}. Must be 12 or 16.`);
	}

	// Get canvas dimensions
	const { width, height } = CANVAS_DIMENSIONS[opts.fontSize];

	let pixels: boolean[][];

	if (opts.useScaling) {
		// SCALED RENDERING: Render large, then downsample
		// This produces pixel-perfect results without anti-aliasing
		const scaleFactor = opts.scaleFactor || 10;

		// Create offscreen canvas at scaled size
		const scaledCanvas = createOffscreenCanvas(width * scaleFactor, height * scaleFactor);
		const scaledCtx = get2dContext(scaledCanvas);

		// Clear with background color
		scaledCtx.fillStyle = opts.bgColor;
		scaledCtx.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);

		// Build font family string
		const fontFamilyString = buildFontStackString(opts.fontFamily);

		// Configure font rendering at scaled size
		scaledCtx.font = `${opts.fontSize * scaleFactor}px ${fontFamilyString}`;
		scaledCtx.textBaseline = opts.textBaseline || 'top';
		scaledCtx.textAlign = 'left';
		scaledCtx.imageSmoothingEnabled = false;
		// Important: Use geometricPrecision to prevent anti-aliasing on pixel art fonts
		scaledCtx.textRendering = 'geometricPrecision';

		// Render character at scaled size
		scaledCtx.fillStyle = opts.fgColor;
		scaledCtx.fillText(char, 0, 0);

		// Create final canvas at target size
		const canvas = createOffscreenCanvas(width, height);
		const ctx = get2dContext(canvas);

		// Clear with background color
		ctx.fillStyle = opts.bgColor;
		ctx.fillRect(0, 0, width, height);

		// Scale down with NO smoothing to get pixel-perfect result
		ctx.imageSmoothingEnabled = false;
		// Use transferToImageBitmap for OffscreenCanvas
		if ('transferToImageBitmap' in scaledCanvas) {
			ctx.drawImage((scaledCanvas as unknown as { transferToImageBitmap(): ImageBitmap }).transferToImageBitmap(), 0, 0, width, height);
		} else {
			ctx.drawImage(scaledCanvas as unknown as CanvasImageSource, 0, 0, width, height);
		}

		// Extract pixel data
		const imageData = ctx.getImageData(0, 0, width, height);
		pixels = imageDataToPixels(imageData, opts.brightnessThreshold);

		// Clean up
		ctx.clearRect(0, 0, width, height);
		canvas.width = 0;
		canvas.height = 0;
		scaledCtx.clearRect(0, 0, scaledCanvas.width, scaledCanvas.height);
		scaledCanvas.width = 0;
		scaledCanvas.height = 0;
	} else {
		// DIRECT RENDERING: Render directly at target size
		// Faster but may have minor anti-aliasing artifacts
		const canvas = createOffscreenCanvas(width, height);
		const ctx = get2dContext(canvas);

		// Clear with background color
		ctx.fillStyle = opts.bgColor;
		ctx.fillRect(0, 0, width, height);

		// Build font family string
		const fontFamilyString = buildFontStackString(opts.fontFamily);

		// Configure font rendering
		ctx.font = `${opts.fontSize}px ${fontFamilyString}`;
		ctx.textBaseline = opts.textBaseline || 'top';
		ctx.textAlign = 'left';
		ctx.imageSmoothingEnabled = false;
		// Important: Use geometricPrecision for consistent rendering
		ctx.textRendering = 'geometricPrecision';

		// Render character
		ctx.fillStyle = opts.fgColor;
		ctx.fillText(char, 0, 0);

		// Extract pixel data
		const imageData = ctx.getImageData(0, 0, width, height);
		pixels = imageDataToPixels(imageData, opts.brightnessThreshold);

		// Clean up
		ctx.clearRect(0, 0, width, height);
		canvas.width = 0;
		canvas.height = 0;
	}

	return pixels;
}

/**
 * Render a pixel grid (boolean[][]) to a data URL for visualization
 *
 * Creates a canvas and draws the pixel grid at a specified scale factor.
 * Useful for debugging, preview windows, and displaying extracted glyphs.
 *
 * @param pixels - 2D boolean array (true = black/foreground, false = white/background)
 * @param scale - Scale factor for display (default: 1)
 * @param options - Optional rendering options
 * @returns Data URL containing PNG image
 *
 * @example
 * ```ts
 * const pixels = await renderGlyphToPixels('A', { fontFamily: 'Font', fontSize: 12 });
 * const dataUrl = pixelsToDataURL(pixels, 10);
 * document.getElementById('preview').src = dataUrl;
 * ```
 */
export function pixelsToDataURL(
	pixels: boolean[][],
	scale: number = 1,
	options: {
		/** Background color (default: white) */
		bgColor?: string;
		/** Foreground color (default: black) */
		fgColor?: string;
	} = {}
): string {
	const height = pixels.length;
	const width = pixels[0]?.length || 0;

	const canvas = document.createElement('canvas');
	canvas.width = width * scale;
	canvas.height = height * scale;

	const ctx = canvas.getContext('2d');
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}

	// Fill background
	ctx.fillStyle = options.bgColor || '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// Draw pixels
	ctx.fillStyle = options.fgColor || '#000000';
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (pixels[y][x]) {
				ctx.fillRect(x * scale, y * scale, scale, scale);
			}
		}
	}

	return canvas.toDataURL('image/png');
}

/**
 * Get canvas dimensions for a font size
 *
 * @param fontSize - Font size in pixels
 * @returns Width and height of canvas
 */
export function getCanvasDimensions(fontSize: FontSize): { width: number; height: number } {
	return { ...CANVAS_DIMENSIONS[fontSize] };
}

// ============================================================================
// UNIFIED TOFU PIPELINE - Used by both tofu detection AND font extraction
// ============================================================================

/**
 * Scale factor for tofu-compatible rendering (must match tofu signature generation)
 */
export const TOFU_SCALE = 4;

/**
 * Padding pixels on each side for tofu-compatible rendering
 * Allows tofu font to render without clipping due to ascender/descender differences
 */
export const TOFU_PADDING = 10;

/**
 * Calculate padded canvas size for tofu-compatible rendering
 * @param fontSize - Font size in pixels (12 or 16)
 * @returns Total canvas size including padding
 */
export function getPaddedCanvasSize(fontSize: FontSize): number {
	return fontSize * TOFU_SCALE + TOFU_PADDING * 2;
}

/**
 * Render a character using the tofu-compatible pipeline
 *
 * This function is used by BOTH:
 * 1. Tofu detection - returns the full padded canvas for signature matching
 * 2. Font extraction - returns the cropped, downsampled result for firmware
 *
 * The pipeline ensures consistency between tofu detection and extraction.
 *
 * @param char - Character to render
 * @param fontFamily - Font family (or stack) to use
 * @param fontSize - Font size in pixels (12 or 16)
 * @param options - Rendering options
 * @returns Rendered pixels
 */
export async function renderWithTofuPipeline(
	char: string,
	fontFamily: string,
	fontSize: FontSize,
	options: {
		/** Return full padded canvas (for tofu detection) or cropped result (for extraction) */
		returnType: "full" | "cropped";
		/** Foreground color (default: black) */
		fgColor?: string;
		/** Background color (default: white) */
		bgColor?: string;
	} = { returnType: "cropped" },
): Promise<boolean[][]> {
	const scale = TOFU_SCALE;
	const padding = TOFU_PADDING;
	const canvasSize = fontSize * scale + padding * 2;

	// Create offscreen canvas at padded size - works in both worker and main thread
	const canvas = createOffscreenCanvas(canvasSize, canvasSize);
	const ctx = get2dContext(canvas);

	// Clear with background
	ctx.fillStyle = options.bgColor ?? '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// Configure font rendering at scaled size
	ctx.font = `${fontSize * scale}px ${fontFamily}`;
	ctx.textBaseline = 'top';
	ctx.textAlign = 'left';
	ctx.imageSmoothingEnabled = false;

	// Render character at padding offset
	ctx.fillStyle = options.fgColor ?? '#000000';
	ctx.fillText(char, padding, padding);

	// Extract pixel data
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const pixels = imageDataToPixels(imageData, 128);

	// Clean up
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	canvas.width = 0;
	canvas.height = 0;

	if (options.returnType === 'full') {
		// Return full padded canvas (for tofu detection/signature generation)
		return pixels;
	}

	// Extract and downsample in one step for firmware storage
	// The glyph is rendered at canvas offset (padding, padding), so we:
	// 1. Sample from canvas coordinate (padding + y, padding + x) for each glyph pixel
	// 2. Downsample by taking every scale-th pixel
	const patternSize = fontSize * scale;
	const extracted: boolean[][] = [];

	for (let y = 0; y < patternSize; y += scale) {
		const row: boolean[] = [];
		for (let x = 0; x < patternSize; x += scale) {
			// Extract from canvas coordinate (padding + y, padding + x)
			// This correctly samples the rendered glyph at the correct offset
			// while downsampling in a single pass
			row.push(pixels[padding + y]?.[padding + x] ?? false);
		}
		extracted.push(row);
	}

	return extracted;
}
