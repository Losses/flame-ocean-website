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
 * Debug image data for font rendering tests
 */
export interface FontDebugImage {
	/** Data URL of the rendered test image */
	dataUrl: string;
	/** Number of anti-aliased pixels found */
	antiAliasedCount: number;
	/** Font size used for rendering */
	fontSize: number;
}

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
	/** Debug images showing rendered test results (only populated when pixel-perfect check fails) */
	debugImages?: FontDebugImage[];
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
 * @param includeDebugImages - Whether to capture debug images for failed tests
 * @returns Font detection result
 */
export async function detectFontType(fontFace: FontFace, includeDebugImages = false): Promise<FontDetectionResult> {
	// Ensure font is loaded
	await fontFace.load();

	// Test at 12px (SMALL)
	const result12px = testFontSize(fontFace.family, SMALL_TEST_SIZE);
	// Test at 16px (LARGE)
	const result16px = testFontSize(fontFace.family, LARGE_TEST_SIZE);

	// Determine font type based on pixel-perfect rendering
	let fontType: DetectedFontType = null;

	// If both are pixel-perfect, prefer SMALL (more common for pixel fonts)
	if (result12px.isPixelPerfect && result16px.isPixelPerfect) {
		fontType = 'SMALL';
	}
	// Classify as SMALL if only 12px rendering produces only black/white pixels
	else if (result12px.isPixelPerfect) {
		fontType = 'SMALL';
	}
	// Classify as LARGE if 16px rendering produces only black/white pixels
	// (but 12px failed, meaning 12px likely had anti-aliasing)
	else if (result16px.isPixelPerfect) {
		fontType = 'LARGE';
	}

	// Prepare debug images if requested and font is not pixel-perfect (failed at both sizes)
	const bothFailed = !result12px.isPixelPerfect && !result16px.isPixelPerfect;

	const debugImages: FontDebugImage[] | undefined =
		includeDebugImages && bothFailed
			? [
					{
						dataUrl: result12px.debugImage ?? '',
						antiAliasedCount: result12px.antiAliasedCount,
						fontSize: SMALL_TEST_SIZE
					},
					{
						dataUrl: result16px.debugImage ?? '',
						antiAliasedCount: result16px.antiAliasedCount,
						fontSize: LARGE_TEST_SIZE
					}
			  ]
			: undefined;

	return {
		fontType,
		isPixelPerfect: result12px.isPixelPerfect || result16px.isPixelPerfect,
		antiAliasedCount12px: result12px.antiAliasedCount,
		antiAliasedCount16px: result16px.antiAliasedCount,
		debugImages
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
	antiAliasedCount: number;
	debugImage: string | null;
} {
	// Test multiple textBaseline and offsetY combinations to find optimal rendering
	// This handles fonts where the metrics don't align with the nominal font size
	const BASELINES: CanvasTextBaseline[] = ['top', 'middle', 'bottom', 'alphabetic', 'hanging'];
	const OFFSET_RANGE = 5; // Try offsets from -5 to +5 pixels

	let bestResult: { isPixelPerfect: boolean; antiAliasedCount: number; debugImage: string | null } = {
		isPixelPerfect: false,
		antiAliasedCount: Infinity,
		debugImage: null
	};

	for (const textBaseline of BASELINES) {
		for (let offsetY = -OFFSET_RANGE; offsetY <= OFFSET_RANGE; offsetY++) {
			const result = testFontRendering(fontFamily, fontSize, textBaseline, offsetY);
			if (result.antiAliasedCount < bestResult.antiAliasedCount) {
				bestResult = result;
				// If we found a perfectly pixel-perfect rendering, stop searching
				if (result.antiAliasedCount === 0) {
					return result;
				}
			}
		}
	}

	return bestResult;
}

/**
 * Test font rendering with specific parameters
 * @param fontFamily - Font family name
 * @param fontSize - Font size in pixels
 * @param textBaseline - Canvas textBaseline setting
 * @param offsetY - Vertical offset in pixels
 * @returns Test result
 */
function testFontRendering(
	fontFamily: string,
	fontSize: number,
	textBaseline: CanvasTextBaseline,
	offsetY: number
): { isPixelPerfect: boolean; antiAliasedCount: number; debugImage: string | null } {
	// Render at target size directly (no scaling)
	// Check for anti-aliasing by looking for gray pixels
	const canvas = document.createElement('canvas');
	canvas.width = fontSize * TEST_CHARACTERS.length;
	canvas.height = fontSize * 2;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });

	if (!ctx) {
		return { isPixelPerfect: false, antiAliasedCount: 0, debugImage: null };
	}

	// Clear canvas with white background
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	// Configure font rendering
	ctx.font = `${fontSize}px "${fontFamily}", sans-serif`;
	ctx.textBaseline = textBaseline;
	ctx.textAlign = 'left';
	ctx.imageSmoothingEnabled = false;
	// Important: Use geometricPrecision to prevent anti-aliasing on pixel art fonts
	(ctx as any).textRendering = 'geometricPrecision';

	// Use TextMetrics to find actual bounding box BEFORE rendering
	// This tells us where the actual pixels will be
	const metrics = ctx.measureText(TEST_CHARACTERS);

	// Calculate Y position based on baseline
	// We want to center the text vertically in the canvas, then apply offset
	const canvasCenterY = canvas.height / 2;
	let yPos = canvasCenterY + offsetY;

	// Adjust for different baselines to keep text centered
	if (textBaseline === 'top') {
		// top baseline means the top of em box is at yPos, text extends below
		// Move down by half font size to center
		yPos += fontSize / 2;
	} else if (textBaseline === 'middle') {
		// middle baseline centers on the em box, yPos is already centered
		// No adjustment needed
	} else if (textBaseline === 'bottom') {
		// bottom baseline means bottom of em box is at yPos, text extends above
		// Move up by half font size to center
		yPos -= fontSize / 2;
	} else if (textBaseline === 'alphabetic') {
		// alphabetic baseline is for normal text, approximate center
		// Move up slightly to account for descenders
		yPos -= fontSize / 4;
	} else if (textBaseline === 'hanging') {
		// hanging is for certain scripts (like Tibetan), treat like top
		yPos += fontSize / 2;
	}

	// Render test characters with offset
	ctx.fillStyle = '#000000';
	ctx.fillText(TEST_CHARACTERS, 0, yPos);

	// Use actual bounding box from TextMetrics if available
	// TextMetrics.actualBoundingBoxAscent/Descent gives us real pixel bounds
	const actualAscent = metrics.actualBoundingBoxAscent ?? 0;
	const actualDescent = metrics.actualBoundingBoxDescent ?? 0;
	const actualLeft = metrics.actualBoundingBoxLeft ?? 0;
	const actualRight = metrics.actualBoundingBoxRight ?? TEST_CHARACTERS.length * fontSize;

	// Convert to pixel coordinates
	const renderTop = yPos - actualAscent;
	const renderBottom = yPos + actualDescent;
	const renderLeft = actualLeft;
	const renderRight = actualRight;

	// Get image data only for the actual rendered area
	const dataX = Math.max(0, Math.floor(renderLeft));
	const dataY = Math.max(0, Math.floor(renderTop));
	const dataWidth = Math.min(canvas.width - dataX, Math.ceil(renderRight - renderLeft));
	const dataHeight = Math.min(canvas.height - dataY, Math.ceil(renderBottom - renderTop));

	if (dataWidth <= 0 || dataHeight <= 0) {
		return { isPixelPerfect: false, antiAliasedCount: 1, debugImage: null };
	}

	const imageData = ctx.getImageData(dataX, dataY, dataWidth, dataHeight);
	const pixels = imageData.data;

	// Count anti-aliased pixels within actual bounding box
	let antiAliasedCount = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];

		// Check if pixel is grayscale but not black or white (anti-aliasing)
		if (r === g && g === b) {
			if (r > 0 && r < 255) {
				antiAliasedCount++;
			}
		}
	}

	// Capture debug image before cleanup
	const debugImage = canvas.toDataURL('image/png');

	// Clean up
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	canvas.width = 0;
	canvas.height = 0;

	return {
		isPixelPerfect: antiAliasedCount <= ANTI_ALIASING_THRESHOLD,
		antiAliasedCount,
		debugImage
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
		document.fonts.add(fontFace);

		// Detect font type
		const result = await detectFontType(fontFace);

		// Remove font from document fonts
		document.fonts.delete(fontFace);

		return result;
	} catch (error) {
		// Clean up on error
		try {
			document.fonts.delete(fontFace);
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
		document.fonts.add(fontFace);

		// Detect font type
		const result = await detectFontType(fontFace);

		// Remove font from document fonts
		document.fonts.delete(fontFace);

		return result;
	} catch (error) {
		// Clean up on error
		try {
			document.fonts.delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new Error(`Failed to load font: ${error instanceof Error ? error.message : String(error)}`);
	}
}
