/**
 * Font Extraction Utilities
 *
 * Extracts single character pixel data from user-provided fonts for firmware replacement.
 * Renders characters using canvas with tofu fallback to handle missing glyphs.
 */

import { TOFU_FONT_FAMILY, isTofuFontLoaded } from './tofu-font.js';

/**
 * Font size in pixels for firmware fonts
 */
export type FontSize = 12 | 16;

/**
 * Character extraction result
 */
export interface CharacterExtractionResult {
	/** Unicode code point of the extracted character */
	readonly codePoint: number;
	/** Character string */
	readonly char: string;
	/** Pixel grid (true = black/foreground, false = white/background) */
	readonly pixels: boolean[][];
	/** Font size used */
	readonly fontSize: FontSize;
	/** Width of the canvas in pixels */
	readonly width: number;
	/** Height of the canvas in pixels */
	readonly height: number;
}

/**
 * Options for character extraction
 */
export interface ExtractionOptions {
	/** Font family name to use for rendering */
	readonly fontFamily: string;
	/** Font size in pixels (12 or 16) */
	readonly fontSize: FontSize;
	/** Whether to use tofu fallback (defaults to true) */
	readonly useTofuFallback?: boolean;
	/** Background color for rendering (defaults to white) */
	readonly bgColor?: string;
	/** Foreground color for rendering (defaults to black) */
	readonly fgColor?: string;
}

/**
 * Canvas dimensions for font sizes
 */
const CANVAS_DIMENSIONS: Record<FontSize, { width: number; height: number }> = {
	12: { width: 12, height: 12 },
	16: { width: 16, height: 16 }
};

/**
 * Default extraction options
 */
const DEFAULT_OPTIONS: Required<Omit<ExtractionOptions, 'fontFamily' | 'fontSize'>> = {
	useTofuFallback: true,
	bgColor: '#ffffff',
	fgColor: '#000000'
};

/**
 * Extract pixel data for a single Unicode character
 *
 * Creates an offscreen canvas, renders the character using the provided font family
 * with tofu fallback, and extracts the resulting black-and-white pixel bitmap.
 *
 * @param codePoint - Unicode code point of the character to extract
 * @param options - Extraction options including font family and size
 * @returns Character extraction result with pixel grid
 *
 * @example
 * ```ts
 * const result = await extractCharacter(0x41, {
 *   fontFamily: 'UserFont',
 *   fontSize: 12
 * });
 * // result.pixels is a 12x12 boolean array
 * // result.pixels[0][0] is top-left pixel
 * ```
 */
export async function extractCharacter(
	codePoint: number,
	options: ExtractionOptions
): Promise<CharacterExtractionResult> {
	// Merge with defaults
	const opts = { ...DEFAULT_OPTIONS, ...options };

	// Validate font size
	if (opts.fontSize !== 12 && opts.fontSize !== 16) {
		throw new Error(`Invalid font size: ${opts.fontSize}. Must be 12 or 16.`);
	}

	// Check tofu font if fallback is enabled
	if (opts.useTofuFallback && !isTofuFontLoaded()) {
		throw new Error(
			'Tofu font is not loaded. Call loadTofuFont() first or set useTofuFallback to false.'
		);
	}

	// Convert code point to string
	const char = String.fromCodePoint(codePoint);

	// Get canvas dimensions
	const { width, height } = CANVAS_DIMENSIONS[opts.fontSize];

	// SCALE FACTOR WORKAROUND: Render at larger size and scale down
	// Browser canvas API doesn't provide a direct way to disable font anti-aliasing.
	// By rendering at a larger scale and then downscaling with imageSmoothingEnabled=false,
	// we get pixelated rendering without anti-aliasing artifacts.
	const SCALE_FACTOR = 10;

	// Create offscreen canvas at scaled size
	const scaledCanvas = document.createElement('canvas');
	scaledCanvas.width = width * SCALE_FACTOR;
	scaledCanvas.height = height * SCALE_FACTOR;

	const scaledCtx = scaledCanvas.getContext('2d', { willReadFrequently: true });
	if (!scaledCtx) {
		throw new Error('Failed to get scaled canvas context');
	}

	// Clear with background color
	scaledCtx.fillStyle = opts.bgColor;
	scaledCtx.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);

	// Build font family string with tofu fallback
	const fontFamilyString = opts.useTofuFallback
		? `"${opts.fontFamily}", "${TOFU_FONT_FAMILY}"`
		: `"${opts.fontFamily}"`;

	// Configure font rendering at scaled size
	scaledCtx.font = `${opts.fontSize * SCALE_FACTOR}px ${fontFamilyString}`;
	scaledCtx.textBaseline = 'top';
	scaledCtx.textAlign = 'left';
	scaledCtx.imageSmoothingEnabled = false;

	// Render the character at scaled size
	scaledCtx.fillStyle = opts.fgColor;
	scaledCtx.fillText(char, 0, 0);

	// Create final canvas at target size
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}

	// Clear with background color
	ctx.fillStyle = opts.bgColor;
	ctx.fillRect(0, 0, width, height);

	// Scale down with NO smoothing to get pixel-perfect result
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(scaledCanvas, 0, 0, width, height);

	// Extract pixel data
	const imageData = ctx.getImageData(0, 0, width, height);
	const pixels = imageDataToPixels(imageData, width, height);

	// Log first few characters for debugging
	if (codePoint < 0x20) {
		const pixelCount = pixels.flat().filter(p => p).length;
		console.log(`[extract] U+${codePoint.toString(16).padStart(4, '0')}: ${width}x${height}, pixels=${pixels.length}x${pixels[0]?.length}, foreground=${pixelCount}`);
	}

	// Clean up
	ctx.clearRect(0, 0, width, height);
	canvas.width = 0;
	canvas.height = 0;

	return {
		codePoint,
		char,
		pixels,
		fontSize: opts.fontSize,
		width,
		height
	};
}

/**
 * Extract pixel data for multiple characters
 *
 * Convenience function to extract multiple characters in sequence.
 * Characters are extracted in order of their code points.
 *
 * @param codePoints - Array of Unicode code points to extract
 * @param options - Extraction options
 * @returns Array of character extraction results
 *
 * @example
 * ```ts
 * const results = await extractCharacters([0x41, 0x42, 0x43], {
 *   fontFamily: 'UserFont',
 *   fontSize: 12
 * });
 * ```
 */
export async function extractCharacters(
	codePoints: number[],
	options: ExtractionOptions
): Promise<CharacterExtractionResult[]> {
	const results: CharacterExtractionResult[] = [];

	for (const codePoint of codePoints) {
		const result = await extractCharacter(codePoint, options);
		results.push(result);
	}

	return results;
}

/**
 * Extract pixel data for a range of Unicode characters
 *
 * @param start - Starting code point (inclusive)
 * @param end - Ending code point (inclusive)
 * @param options - Extraction options
 * @returns Array of character extraction results
 *
 * @example
 * ```ts
 * // Extract Basic Latin (A-Z)
 * const results = await extractCharacterRange(0x41, 0x5A, {
 *   fontFamily: 'UserFont',
 *   fontSize: 12
 * });
 * ```
 */
export async function extractCharacterRange(
	start: number,
	end: number,
	options: ExtractionOptions
): Promise<CharacterExtractionResult[]> {
	const codePoints: number[] = [];

	for (let cp = start; cp <= end; cp++) {
		codePoints.push(cp);
	}

	return extractCharacters(codePoints, options);
}

/**
 * Convert ImageData to boolean pixel array
 *
 * Reads RGBA pixel data and converts to a 2D boolean array where:
 * - true = black/foreground pixel
 * - false = white/background pixel
 *
 * Uses a threshold of 128 brightness to determine foreground vs background.
 *
 * @param imageData - ImageData from canvas getImageData
 * @param width - Width of the image in pixels
 * @param height - Height of the image in pixels
 * @returns 2D boolean array representing pixels
 */
function imageDataToPixels(imageData: ImageData, width: number, height: number): boolean[][] {
	const pixels: boolean[][] = [];
	const data = imageData.data;

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
			row.push(brightness < 128);
		}
		pixels.push(row);
	}

	return pixels;
}

/**
 * Get the expected canvas dimensions for a font size
 *
 * @param fontSize - Font size in pixels
 * @returns Width and height of the canvas
 */
export function getCanvasDimensions(fontSize: FontSize): { width: number; height: number } {
	return { ...CANVAS_DIMENSIONS[fontSize] };
}
