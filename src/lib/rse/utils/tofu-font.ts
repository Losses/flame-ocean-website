/**
 * Tofu Fallback Font Utilities
 *
 * Uses a tofu.ttf fallback font to reliably detect missing characters in user-provided fonts.
 * The tofu font displays a generic placeholder glyph (�) for characters that don't exist in a font.
 * By comparing rendered characters against the known tofu signature, we can skip characters
 * that are missing from the user's font.
 */

import type { PixelData } from '../types/index.js';

/**
 * Tofu pixel signature for a font size
 * Stores the canonical pixel representation of a tofu character
 */
export interface TofuSignature {
	/** Font size for this signature */
	fontSize: number;
	/** Character used to generate the signature */
	char: string;
	/** Pixel grid (2D boolean array) of the tofu character */
	pixels: boolean[][];
	/** Canvas dimensions used */
	width: number;
	height: number;
}

/**
 * Registered tofu font state
 */
interface TofuFontState {
	/** FontFace object for tofu */
	fontFace: FontFace | null;
	/** Whether the font is loaded and registered */
	isLoaded: boolean;
	/** Cached signatures by font size */
	signatures: Map<number, TofuSignature>;
}

/**
 * Global tofu font state
 */
const tofuState: TofuFontState = {
	fontFace: null,
	isLoaded: false,
	signatures: new Map()
};

/**
 * Font family name for tofu fallback
 */
export const TOFU_FONT_FAMILY = 'Tofu';

/**
 * Default test character for tofu signature generation
 * Using a character that typically doesn't exist in most fonts
 */
const DEFAULT_TOFU_TEST_CHAR = '\uD83D\uDD7A'; // 🔺 - Alien Monster, unlikely to be in pixel fonts

/**
 * Alternative test characters (fallbacks if the primary doesn't work)
 */
const ALTERNATIVE_TOFU_CHARS = [
	'\u{1F600}', // 😀
	'\u{2605}', // ★
	'\u{2764}', // ❤
	'A' // Common fallback
];

/**
 * Load the tofu font from static directory and register it
 * @param baseUrl - Base URL for static assets (defaults to '/tofu.ttf')
 * @returns Promise that resolves when the font is loaded and registered
 * @throws Error if font fails to load
 */
export async function loadTofuFont(baseUrl = '/tofu.ttf'): Promise<void> {
	// Already loaded
	if (tofuState.isLoaded && tofuState.fontFace) {
		return;
	}

	try {
		// Fetch the tofu font file
		const response = await fetch(baseUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch tofu font: ${response.status} ${response.statusText}`);
		}

		const arrayBuffer = await response.arrayBuffer();

		// Create FontFace object
		const fontFace = new FontFace(TOFU_FONT_FAMILY, arrayBuffer);

		// Load the font
		await fontFace.load();

		// Add to document.fonts for rendering
		document.fonts.add(fontFace);

		// Store the font face
		tofuState.fontFace = fontFace;
		tofuState.isLoaded = true;

		// Pre-generate signatures for common font sizes
		await generateTofuSignature(12);
		await generateTofuSignature(16);
	} catch (error) {
		tofuState.isLoaded = false;
		tofuState.fontFace = null;
		throw new Error(`Failed to load tofu font: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Generate a tofu signature for a specific font size
 * @param fontSize - Font size in pixels
 * @param testChar - Optional test character (defaults to alien monster)
 * @returns The tofu signature
 * @throws Error if tofu font is not loaded
 */
export async function generateTofuSignature(
	fontSize: number,
	testChar = DEFAULT_TOFU_TEST_CHAR
): Promise<TofuSignature> {
	// Check if already cached
	const cached = tofuState.signatures.get(fontSize);
	if (cached) {
		return cached;
	}

	// Ensure tofu font is loaded
	if (!tofuState.isLoaded || !tofuState.fontFace) {
		throw new Error('Tofu font is not loaded. Call loadTofuFont() first.');
	}

	// Create canvas for rendering
	const canvas = document.createElement('canvas');
	const width = fontSize * 2; // Extra space for wider glyphs
	const height = fontSize * 2;
	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}

	// Clear with white background
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);

	// Configure font rendering
	ctx.font = `${fontSize}px "${TOFU_FONT_FAMILY}"`;
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'center';
	ctx.imageSmoothingEnabled = false;

	// Render the character
	ctx.fillStyle = '#000000';
	ctx.fillText(testChar, width / 2, height / 2);

	// Extract pixel data
	const imageData = ctx.getImageData(0, 0, width, height);
	const pixels = imageDataToPixels(imageData, width, height);

	const signature: TofuSignature = {
		fontSize,
		char: testChar,
		pixels,
		width,
		height
	};

	// Cache the signature
	tofuState.signatures.set(fontSize, signature);

	// Clean up
	ctx.clearRect(0, 0, width, height);
	canvas.width = 0;
	canvas.height = 0;

	return signature;
}

/**
 * Get the tofu signature for a font size
 * @param fontSize - Font size in pixels
 * @returns The tofu signature or null if not generated
 */
export function getTofuSignature(fontSize: number): TofuSignature | null {
	return tofuState.signatures.get(fontSize) || null;
}

/**
 * Check if tofu font is loaded and ready
 * @returns True if tofu font is loaded
 */
export function isTofuFontLoaded(): boolean {
	return tofuState.isLoaded;
}

/**
 * Get the tofu font family name for use in CSS font stacks
 * @returns The tofu font family name
 */
export function getTofuFontFamily(): string {
	return TOFU_FONT_FAMILY;
}

/**
 * Unload the tofu font and clean up resources
 * Call this when font replacement operations are complete
 */
export function unloadTofuFont(): void {
	if (tofuState.fontFace) {
		try {
			document.fonts.delete(tofuState.fontFace);
		} catch {
			// Ignore cleanup errors
		}
		tofuState.fontFace = null;
	}
	tofuState.isLoaded = false;
	tofuState.signatures.clear();
}

/**
 * Convert ImageData to boolean pixel array
 * @param imageData - ImageData from canvas
 * @param width - Width of the image
 * @param height - Height of the image
 * @returns 2D boolean array (true = black/foreground, false = white/background)
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

			// Consider a pixel "foreground" if it's dark enough
			// Using threshold of 128 (middle gray)
			const brightness = (r + g + b) / 3;
			row.push(brightness < 128);
		}
		pixels.push(row);
	}

	return pixels;
}

/**
 * Compare two pixel grids for equality
 * Used to detect if a rendered character matches the tofu signature
 * @param pixels1 - First pixel grid
 * @param pixels2 - Second pixel grid
 * @returns True if the pixel grids match exactly
 */
export function pixelsMatch(pixels1: boolean[][], pixels2: boolean[][]): boolean {
	if (pixels1.length !== pixels2.length) {
		return false;
	}

	for (let y = 0; y < pixels1.length; y++) {
		const row1 = pixels1[y];
		const row2 = pixels2[y];
		if (row1.length !== row2.length) {
			return false;
		}
		for (let x = 0; x < row1.length; x++) {
			if (row1[x] !== row2[x]) {
				return false;
			}
		}
	}

	return true;
}

/**
 * Check if a rendered character matches the tofu signature
 * @param pixels - Rendered character pixels
 * @param fontSize - Font size used for rendering
 * @returns True if the character appears to be tofu (missing from font)
 */
export function isTofuCharacter(pixels: PixelData, fontSize: number): boolean {
	const signature = getTofuSignature(fontSize);
	if (!signature) {
		// No signature available, cannot determine
		return false;
	}

	// Convert readonly PixelData to mutable boolean[][] for internal processing
	const mutablePixels = pixels.map((row) => [...row]);
	const mutableSigPixels = signature.pixels.map((row) => [...row]);

	// The rendered character should be centered, so we need to find the bounding box
	// and compare it with the signature
	const bbox = findBoundingBox(mutablePixels);
	const sigBbox = findBoundingBox(mutableSigPixels);

	// If both are empty (no pixels), consider it tofu
	if (bbox.width === 0 && bbox.height === 0 && sigBbox.width === 0 && sigBbox.height === 0) {
		return true;
	}

	// If one is empty and the other isn't, not a match
	if (bbox.width === 0 || sigBbox.width === 0) {
		return false;
	}

	// Extract the bounding box region from both
	const cropped = cropToBoundingBox(mutablePixels, bbox);
	const sigCropped = cropToBoundingBox(mutableSigPixels, sigBbox);

	// Compare the cropped regions
	return comparePixelRegions(cropped, sigCropped);
}

/**
 * Find the bounding box of non-white pixels in a pixel grid
 */
function findBoundingBox(pixels: boolean[][]): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	let minX = pixels[0]?.length || 0;
	let minY = pixels.length;
	let maxX = 0;
	let maxY = 0;
	let found = false;

	for (let y = 0; y < pixels.length; y++) {
		for (let x = 0; x < pixels[y].length; x++) {
			if (pixels[y][x]) {
				found = true;
				minX = Math.min(minX, x);
				minY = Math.min(minY, y);
				maxX = Math.max(maxX, x);
				maxY = Math.max(maxY, y);
			}
		}
	}

	if (!found) {
		return { x: 0, y: 0, width: 0, height: 0 };
	}

	return {
		x: minX,
		y: minY,
		width: maxX - minX + 1,
		height: maxY - minY + 1
	};
}

/**
 * Crop a pixel grid to its bounding box
 */
function cropToBoundingBox(
	pixels: boolean[][],
	bbox: { x: number; y: number; width: number; height: number }
): boolean[][] {
	const result: boolean[][] = [];

	for (let y = bbox.y; y < bbox.y + bbox.height && y < pixels.length; y++) {
		const row: boolean[] = [];
		for (let x = bbox.x; x < bbox.x + bbox.width && x < pixels[y].length; x++) {
			row.push(pixels[y][x]);
		}
		result.push(row);
	}

	return result;
}

/**
 * Compare two pixel regions with tolerance for minor differences
 */
function comparePixelRegions(pixels1: boolean[][], pixels2: boolean[][], tolerance = 0.1): boolean {
	const size1 = pixels1.length * pixels1[0]?.length;
	const size2 = pixels2.length * pixels2[0]?.length;

	if (size1 === 0 || size2 === 0) {
		return size1 === size2;
	}

	// For small differences in size, allow it
	const maxSize = Math.max(size1, size2);
	const minSize = Math.min(size1, size2);
	if (maxSize - minSize > maxSize * tolerance) {
		return false;
	}

	// Count matching pixels
	let matches = 0;
	let total = 0;

	const rows = Math.max(pixels1.length, pixels2.length);
	const cols = Math.max(pixels1[0]?.length || 0, pixels2[0]?.length || 0);

	for (let y = 0; y < rows; y++) {
		for (let x = 0; x < cols; x++) {
			const p1 = pixels1[y]?.[x] ?? false;
			const p2 = pixels2[y]?.[x] ?? false;
			if (p1 === p2) {
				matches++;
			}
			total++;
		}
	}

	// Require at least 95% match
	return matches / total >= 0.95;
}

/**
 * Render a single character using a font family (with tofu fallback)
 * This is a helper for use in batch character extraction
 * @param char - Character to render
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @returns Rendered pixel data
 * @throws Error if tofu font is not loaded
 */
export async function renderCharacterWithTofu(
	char: string,
	fontFamily: string,
	fontSize: 12 | 16
): Promise<boolean[][]> {
	// Ensure tofu font is loaded
	if (!tofuState.isLoaded) {
		await loadTofuFont();
	}

	// Create canvas
	const canvas = document.createElement('canvas');
	const width = fontSize === 12 ? 12 : 16;
	const height = fontSize === 12 ? 12 : 16;
	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}

	// Clear with white background
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);

	// Configure font with tofu fallback
	// The primary font is tried first, then tofu if the character is missing
	ctx.font = `${fontSize}px "${fontFamily}", "${TOFU_FONT_FAMILY}"`;
	ctx.textBaseline = 'top';
	ctx.textAlign = 'left';
	ctx.imageSmoothingEnabled = false;

	// Render the character
	ctx.fillStyle = '#000000';
	ctx.fillText(char, 0, 0);

	// Extract pixel data
	const imageData = ctx.getImageData(0, 0, width, height);
	const pixels = imageDataToPixels(imageData, width, height);

	// Clean up
	ctx.clearRect(0, 0, width, height);
	canvas.width = 0;
	canvas.height = 0;

	return pixels;
}

/**
 * Result of checking if a character should be skipped during font replacement
 */
export interface SkipCharacterResult {
	/** Whether the character should be skipped */
	readonly shouldSkip: boolean;
	/** Unicode code point of the character */
	readonly codePoint: number;
	/** Character string */
	readonly char: string;
	/** Reason for skipping (if applicable) */
	readonly reason?: 'missing_from_font' | 'not_in_firmware' | null;
}

/**
 * Check if a character should be skipped during font replacement
 *
 * This function determines whether a character should be skipped by:
 * 1. Rendering the character with tofu fallback
 * 2. Comparing the rendered output against the known tofu signature
 * 3. Returning true if the character matches tofu (missing from user font)
 *
 * @param codePoint - Unicode code point of the character to check
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @param existsInFirmware - Optional callback to check if character exists in firmware address space
 * @returns SkipCharacterResult with skip decision and reason
 *
 * @example
 * ```ts
 * const result = await shouldSkipCharacter(0x41, 'UserFont', 12, (cp) => cp < 0x10000);
 * if (result.shouldSkip) {
 *   console.log(`Skipping U+${result.codePoint.toString(16)}: ${result.reason}`);
 * }
 * ```
 */
export async function shouldSkipCharacter(
	codePoint: number,
	fontFamily: string,
	fontSize: 12 | 16,
	existsInFirmware?: (codePoint: number) => boolean
): Promise<SkipCharacterResult> {
	// Convert code point to string
	const char = String.fromCodePoint(codePoint);

	// Check if character exists in firmware (if callback provided)
	if (existsInFirmware) {
		const exists = existsInFirmware(codePoint);
		if (!exists) {
			return {
				shouldSkip: true,
				codePoint,
				char,
				reason: 'not_in_firmware'
			};
		}
	}

	// Ensure tofu font is loaded
	if (!tofuState.isLoaded) {
		await loadTofuFont();
	}

	// Render the character with tofu fallback
	const pixels = await renderCharacterWithTofu(char, fontFamily, fontSize);

	// Check if the rendered character matches tofu signature
	const matchesTofu = isTofuCharacter(pixels as PixelData, fontSize);

	if (matchesTofu) {
		return {
			shouldSkip: true,
			codePoint,
			char,
			reason: 'missing_from_font'
		};
	}

	return {
		shouldSkip: false,
		codePoint,
		char,
		reason: null
	};
}

/**
 * Check if multiple characters should be skipped during font replacement
 *
 * Batch version of shouldSkipCharacter for processing multiple characters efficiently.
 *
 * @param codePoints - Array of Unicode code points to check
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @param existsInFirmware - Optional callback to check if character exists in firmware address space
 * @returns Array of SkipCharacterResult for each character
 * @returns skippedCharacters - Array of code points that should be skipped
 * @returns skippedReasons - Map of code point to skip reason
 *
 * @example
 * ```ts
 * const results = await shouldSkipCharacters([0x41, 0x42, 0x1F600], 'UserFont', 12);
 * console.log(`Skipping ${results.skippedCharacters.length} characters`);
 * // Log skipped characters with their Unicode values
 * results.skippedCharacters.forEach(cp => {
 *   const reason = results.skippedReasons.get(cp);
 *   console.log(`U+${cp.toString(16)}: ${reason}`);
 * });
 * ```
 */
export async function shouldSkipCharacters(
	codePoints: number[],
	fontFamily: string,
	fontSize: 12 | 16,
	existsInFirmware?: (codePoint: number) => boolean
): Promise<{
	results: SkipCharacterResult[];
	skippedCharacters: number[];
	skippedReasons: Map<number, string>;
}> {
	const results: SkipCharacterResult[] = [];
	const skippedCharacters: number[] = [];
	const skippedReasons = new Map<number, string>();

	// Ensure tofu font is loaded once for all characters
	if (!tofuState.isLoaded) {
		await loadTofuFont();
	}

	// Process each character
	for (const codePoint of codePoints) {
		const result = await shouldSkipCharacter(codePoint, fontFamily, fontSize, existsInFirmware);
		results.push(result);

		if (result.shouldSkip) {
			skippedCharacters.push(codePoint);
			skippedReasons.set(codePoint, result.reason || 'unknown');
		}
	}

	return {
		results,
		skippedCharacters,
		skippedReasons
	};
}
