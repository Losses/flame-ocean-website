/**
 * Font Detection Utilities
 *
 * Detects whether a user-provided font file is suitable for 12px (SMALL) or 16px (LARGE)
 * font replacement by rendering test characters and checking for pixel-perfect results.
 */

/**
 * Font type detected
 */
export type DetectedFontType = 'SMALL' | 'LARGE' | null;

/**
 * Result of font type detection
 */
export interface FontDetectionResult {
	/** Detected font type */
	fontType: DetectedFontType;
	/** Whether the font is pixel-perfect (no anti-aliasing) */
	isPixelPerfect: boolean;
	/** Number of anti-aliased pixels found at 12px */
	antiAliasedCount12px: number;
	/** Number of anti-aliased pixels found at 16px */
	antiAliasedCount16px: number;
}

/**
 * Test characters for font type detection
 * Uses English uppercase and lowercase letters to test for pixel-perfect rendering
 */
const TEST_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Canvas dimensions for testing
 */
const SMALL_TEST_SIZE = 12;
const LARGE_TEST_SIZE = 16;

/**
 * Threshold for anti-aliasing detection
 * If more than this many gray pixels are found, the font is considered anti-aliased
 */
const ANTI_ALIASING_THRESHOLD = 0;

/**
 * Detect font type by rendering test characters and checking for anti-aliasing
 * @param fontFace - The FontFace object to test
 * @returns Font detection result
 */
export async function detectFontType(fontFace: FontFace): Promise<FontDetectionResult> {
	// Ensure font is loaded
	await fontFace.load();

	// Test at 12px (SMALL)
	const result12px = testFontSize(fontFace.family, SMALL_TEST_SIZE);
	// Test at 16px (LARGE)
	const result16px = testFontSize(fontFace.family, LARGE_TEST_SIZE);

	// Determine font type based on pixel-perfect rendering
	let fontType: DetectedFontType = null;

	// Classify as SMALL if 12px rendering produces only black/white pixels
	if (result12px.isPixelPerfect) {
		fontType = 'SMALL';
	}
	// Classify as LARGE if 16px rendering produces only black/white pixels
	// (but 12px failed, meaning 12px likely had anti-aliasing)
	else if (result16px.isPixelPerfect) {
		fontType = 'LARGE';
	}
	// If both are pixel-perfect, prefer SMALL (more common for pixel fonts)
	else if (result12px.isPixelPerfect && result16px.isPixelPerfect) {
		fontType = 'SMALL';
	}

	return {
		fontType,
		isPixelPerfect: result12px.isPixelPerfect || result16px.isPixelPerfect,
		antiAliasedCount12px: result12px.antiAliatedCount,
		antiAliasedCount16px: result16px.antiAliatedCount,
	};
}

/**
 * Test a font at a specific size for pixel-perfect rendering
 * @param fontFamily - The font family name to test
 * @param fontSize - The font size in pixels
 * @returns Result indicating if the font is pixel-perfect at this size
 */
function testFontSize(fontFamily: string, fontSize: number): {
	isPixelPerfect: boolean;
	antiAliatedCount: number;
} {
	// Create an offscreen canvas
	const canvas = document.createElement('canvas');
	canvas.width = fontSize * TEST_CHARACTERS.length;
	canvas.height = fontSize * 2; // Extra space for descenders
	const ctx = canvas.getContext('2d', { willReadFrequently: true });

	if (!ctx) {
		return { isPixelPerfect: false, antiAliatedCount: 0 };
	}

	// Clear canvas with white background
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// Configure font rendering for pixel-perfect results
	ctx.font = `${fontSize}px "${fontFamily}", sans-serif`;
	ctx.textBaseline = 'middle';
	ctx.textAlign = 'left';
	// Disable anti-aliasing
	ctx.imageSmoothingEnabled = false;

	// Render test characters
	ctx.fillStyle = '#000000';
	ctx.fillText(TEST_CHARACTERS, 0, fontSize / 2);

	// Check for anti-aliasing by examining pixel data
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const pixels = imageData.data;
	let antiAliatedCount = 0;

	// Check each pixel for grayscale values (indicating anti-aliasing)
	for (let i = 0; i < pixels.length; i += 4) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];
		// Ignore alpha (pixels[i + 3])

		// Check if pixel is grayscale (all three channels equal) but not black or white
		// This indicates anti-aliasing
		if (r === g && g === b) {
			// Grayscale pixel - check if it's not black or white
			if (r > 0 && r < 255) {
				antiAliatedCount++;
			}
		}
	}

	// Clean up
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	canvas.width = 0;
	canvas.height = 0;

	return {
		isPixelPerfect: antiAliatedCount <= ANTI_ALIASING_THRESHOLD,
		antiAliatedCount,
	};
}

/**
 * Detect font type from a File object
 * @param file - The font file to test
 * @returns Font detection result
 */
export async function detectFontTypeFromFile(file: File): Promise<FontDetectionResult> {
	// Read file as ArrayBuffer
	const arrayBuffer = await file.arrayBuffer();

	// Create FontFace object
	const fontFace = new FontFace('TestFont', arrayBuffer);

	try {
		// Add to document.fonts for rendering
		await fontFace.load();
		(document.fonts as any).add(fontFace);

		// Detect font type
		const result = await detectFontType(fontFace);

		// Remove font from document fonts
		(document.fonts as any).delete(fontFace);

		return result;
	} catch (error) {
		// Clean up on error
		try {
			(document.fonts as any).delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new Error(`Failed to load font: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Detect font type from an ArrayBuffer
 * @param arrayBuffer - The font file data
 * @param fontName - Optional name for the font (defaults to 'TestFont')
 * @returns Font detection result
 */
export async function detectFontTypeFromArrayBuffer(
	arrayBuffer: ArrayBuffer,
	fontName = 'TestFont'
): Promise<FontDetectionResult> {
	// Create FontFace object
	const fontFace = new FontFace(fontName, arrayBuffer);

	try {
		// Add to document.fonts for rendering
		await fontFace.load();
		(document.fonts as any).add(fontFace);

		// Detect font type
		const result = await detectFontType(fontFace);

		// Remove font from document fonts
		(document.fonts as any).delete(fontFace);

		return result;
	} catch (error) {
		// Clean up on error
		try {
			(document.fonts as any).delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new Error(`Failed to load font: ${error instanceof Error ? error.message : String(error)}`);
	}
}
