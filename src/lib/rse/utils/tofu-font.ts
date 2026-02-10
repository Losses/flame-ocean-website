/**
 * Tofu Fallback Font Utilities
 *
 * Uses Adobe NotDef font to detect missing characters.
 * Adobe NotDef is a special font that renders a distinctive .notdef glyph
 * for any character, allowing us to detect when a user's font is missing a glyph.
 */

import type { PixelData } from '../types/index.js';

/**
 * Tofu pixel signature for a font size
 * Stores the canonical pixel representation of Adobe NotDef's .notdef glyph
 */
export interface TofuSignature {
	/** Font size for this signature */
	fontSize: number;
	/** Character used to generate the signature */
	char: string;
	/** Pixel grid (2D boolean array) of the Adobe NotDef render */
	pixels: boolean[][];
	/** Canvas dimensions used */
	width: number;
	height: number;
}

/**
 * Registered tofu font state
 */
interface TofuFontState {
	/** FontFace object for Adobe NotDef */
	fontFace: FontFace | null;
	/** Font family name */
	fontFamily: string;
	/** Whether the font is loaded */
	loaded: boolean;
	/** Cached signatures by font size */
	signatures: Map<number, TofuSignature>;
}

/**
 * Global tofu font state
 */
const tofuState: TofuFontState = {
	fontFace: null,
	fontFamily: 'Adobe-NotDef',
	loaded: false,
	signatures: new Map()
};

/**
 * Font family name for tofu fallback
 */
export const TOFU_FONT_FAMILY = 'Adobe-NotDef';

/**
 * Default test character for tofu signature generation
 * Using a character that won't exist in most pixel fonts
 */
const DEFAULT_TOFU_TEST_CHAR = '\uFFFD'; // Replacement character

/**
 * Initialize the tofu font system by loading Adobe NotDef
 * @returns Promise that resolves when initialized
 */
export async function loadTofuFont(): Promise<void> {
	if (tofuState.loaded) {
		return;
	}

	try {
		// Fetch the Adobe NotDef font file
		const response = await fetch('/AND-Regular.ttf');
		if (!response.ok) {
			throw new Error(`Failed to fetch Adobe NotDef font: ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();

		// Create FontFace object
		const fontFace = new FontFace(TOFU_FONT_FAMILY, buffer);

		// Load and add to document fonts
		await fontFace.load();
		document.fonts.add(fontFace);

		// Store in state
		tofuState.fontFace = fontFace;
		tofuState.loaded = true;

		console.log(`Adobe NotDef font loaded successfully as "${TOFU_FONT_FAMILY}"`);
	} catch (error) {
		console.error('Failed to load Adobe NotDef font:', error);
		throw new Error(
			`Failed to load tofu font: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Generate an Adobe NotDef signature for a specific font size
 * @param fontSize - Font size in pixels
 * @param testChar - Optional test character (defaults to replacement character)
 * @returns The Adobe NotDef signature
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

	if (!tofuState.loaded) {
		throw new Error('Tofu font not loaded. Call loadTofuFont() first.');
	}

	// Create canvas for rendering - use same dimensions as extraction
	const width = fontSize;
	const height = fontSize;
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}

	// Clear with white background
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);

	// Configure font rendering - using Adobe NotDef only
	ctx.font = `${fontSize}px "${TOFU_FONT_FAMILY}"`;
	ctx.textBaseline = 'top';
	ctx.textAlign = 'left';
	ctx.imageSmoothingEnabled = false; // Keep pixel crisp

	// Render the character (Adobe NotDef will render .notdef glyph for any character)
	ctx.fillStyle = '#000000';
	ctx.fillText(testChar, 0, 0);

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
 * Check if tofu font system is ready
 * @returns True if Adobe NotDef is loaded
 */
export function isTofuFontLoaded(): boolean {
	return tofuState.loaded;
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
	tofuState.loaded = false;
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
			// Using threshold of 200 to avoid anti-aliasing
			const brightness = (r + g + b) / 3;
			row.push(brightness < 200);
		}
		pixels.push(row);
	}

	return pixels;
}

/**
 * Compare two pixel grids for equality
 * Used to detect if a rendered character matches the system fallback
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
 * Check if a rendered character matches the system fallback signature
 * @param pixels - Rendered character pixels
 * @param fontSize - Font size used for rendering
 * @returns True if the character appears to use system fallback (missing from font)
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

	// Check if pixels match the system fallback signature
	return comparePixelRegions(mutablePixels, mutableSigPixels);
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

	// Require at least 90% match (allowing for some anti-aliasing differences)
	return matches / total >= 0.90;
}

/**
 * Render a single character using user font with Adobe NotDef fallback
 * @param char - Character to render
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @returns Rendered pixel data
 */
export async function renderCharacterWithTofu(
	char: string,
	fontFamily: string,
	fontSize: 12 | 16
): Promise<boolean[][]> {
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

	// Configure font with Adobe NotDef fallback for missing characters
	// If user font doesn't have the glyph, Adobe NotDef will render .notdef
	const fontStack = tofuState.loaded
		? `"${fontFamily}", "${TOFU_FONT_FAMILY}"`
		: `"${fontFamily}"`;

	ctx.font = `${fontSize}px ${fontStack}`;
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
 * Checks by rendering the character and comparing against Adobe NotDef's .notdef glyph.
 * If they match (within tolerance), the character is missing from the user's font.
 *
 * @param codePoint - Unicode code point of the character to check
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @param existsInFirmware - Optional callback to check if character exists in firmware address space
 * @returns SkipCharacterResult with skip decision and reason
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

	// Check if character is missing from font by comparing against Adobe NotDef
	if (tofuState.loaded) {
		// Render the character (will use Adobe NotDef if missing)
		const pixels = await renderCharacterWithTofu(char, fontFamily, fontSize);

		// Get or generate the tofu signature for this size
		let signature = getTofuSignature(fontSize);
		if (!signature) {
			console.log(`[tofu] Generating signature for ${fontSize}px...`);
			signature = await generateTofuSignature(fontSize);
			console.log(`[tofu] Signature generated: ${signature.width}x${signature.height}, pixels:`, signature.pixels);
		}

		// Check if the render matches Adobe NotDef's .notdef glyph
		const isTofu = comparePixelRegions(pixels, signature.pixels);

		// Log first few characters for debugging
		if (codePoint < 0x20) {
			console.log(`[tofu] U+${codePoint.toString(16).padStart(4, '0')}: isTofu=${isTofu}, pixels=${pixels.length}x${pixels[0]?.length}`);
			console.log(`[tofu] Signature: ${signature.width}x${signature.height}`);
		}

		if (isTofu) {
			return {
				shouldSkip: true,
				codePoint,
				char,
				reason: 'missing_from_font'
			};
		}
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
