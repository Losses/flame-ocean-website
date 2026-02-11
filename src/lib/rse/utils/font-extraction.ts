/**
 * Font Extraction Utilities
 *
 * Extracts single character pixel data from user-provided fonts for firmware replacement.
 * Renders characters using canvas with tofu fallback to handle missing glyphs.
 *
 * This module now uses shared glyph rendering utilities from glyph-renderer.ts
 * for consistent pixel-perfect rendering across all font operations.
 */

import { TOFU_FONT_FAMILY, isTofuFontLoaded } from './tofu-font';
import {
	renderWithTofuPipeline,
	getCanvasDimensions as getSharedCanvasDimensions,
	buildFontStackString,
	type FontSize
} from './glyph-renderer';

/**
 * Character extraction result
 */
export interface CharacterExtractionResult {
	/** Unicode code point of extracted character */
	readonly codePoint: number;
	/** Character string */
	readonly char: string;
	/** Pixel grid (true = black/foreground, false = white/background) */
	readonly pixels: boolean[][];
	/** Font size used */
	readonly fontSize: FontSize;
	/** Width of canvas in pixels */
	readonly width: number;
	/** Height of canvas in pixels */
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
 * Uses scaled rendering (10x) with downsampling to produce pixel-perfect results
 * without anti-aliasing artifacts.
 *
 * @param codePoint - Unicode code point of character to extract
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
	const { width, height } = getCanvasDimensions(opts.fontSize);

	// Build font stack string - use shared function from glyph-renderer
	// Pass TOFU_FONT_FAMILY string directly when fallback is enabled
	const fontStack = buildFontStackString(
		opts.fontFamily,
		opts.useTofuFallback ? TOFU_FONT_FAMILY : undefined
	);

	// Use unified tofu pipeline for consistent rendering with tofu detection
	// Returns cropped result (downsampled to target size)
	const pixels = await renderWithTofuPipeline(
		char,
		fontStack,
		opts.fontSize,
		{
			returnType: "cropped",
			fgColor: opts.fgColor,
			bgColor: opts.bgColor
		}
	);

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
 * Get expected canvas dimensions for a font size
 *
 * @param fontSize - Font size in pixels
 * @returns Width and height of canvas
 */
export function getCanvasDimensions(fontSize: FontSize): { width: number; height: number } {
	return getSharedCanvasDimensions(fontSize);
}
