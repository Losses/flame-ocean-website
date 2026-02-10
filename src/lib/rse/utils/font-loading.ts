/**
 * Font File Loading and Validation Utilities
 *
 * Handles loading user-provided font files and performing initial validation
 * before starting the font replacement process.
 */

import type { DetectedFontType } from './font-detection.js';

/**
 * Result of loading and validating a font file
 */
export interface FontLoadingResult {
	/** The loaded FontFace object */
	fontFace: FontFace;
	/** Font family name for use in rendering */
	fontFamily: string;
	/** Detected font type ('SMALL' | 'LARGE' | null) */
	detectedType: DetectedFontType;
	/** Original file name */
	fileName: string;
	/** Whether the font is pixel-perfect (no anti-aliasing) */
	isPixelPerfect: boolean;
}

/**
 * Error thrown when font loading or validation fails
 */
export class FontLoadingError extends Error {
	/** The file name that failed to load */
	readonly fileName: string;
	/** The underlying error cause */
	readonly cause?: Error;

	constructor(message: string, fileName: string, cause?: Error) {
		super(message);
		this.name = 'FontLoadingError';
		this.fileName = fileName;
		this.cause = cause;
	}
}

/**
 * Font file extensions that are supported
 */
const SUPPORTED_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];

/**
 * MIME types that indicate font files
 */
const FONT_MIME_TYPES = [
	'font/ttf',
	'font/otf',
	'font/woff',
	'font/woff2',
	'application/font-ttf',
	'application/font-otf',
	'application/font-woff',
	'application/font-woff2',
	'application/x-font-ttf',
	'application/x-font-otf',
	'application/x-font-woff',
];

/**
 * Check if a file is a font file based on extension or MIME type
 * @param file - The file to check
 * @returns True if the file appears to be a font file
 */
export function isFontFile(file: File): boolean {
	const fileName = file.name.toLowerCase();
	const hasFontExtension = SUPPORTED_EXTENSIONS.some((ext) => fileName.endsWith(ext));
	const hasFontMime = FONT_MIME_TYPES.includes(file.type);
	return hasFontExtension || hasFontMime;
}

/**
 * Load and validate a font file
 *
 * Reads the font file as ArrayBuffer, creates a FontFace object, adds it to
 * document.fonts, and performs initial validation.
 *
 * @param file - The font file to load
 * @param fontName - Optional custom font name (defaults to file name without extension)
 * @returns Promise that resolves with the font loading result
 * @throws FontLoadingError if the font fails to load or validate
 *
 * @example
 * ```ts
 * try {
 *   const result = await loadAndValidateFontFile(file);
 *   console.log(`Loaded ${result.fontFamily} as ${result.detectedType}`);
 *   // Use result.fontFace for rendering
 * } catch (error) {
 *   if (error instanceof FontLoadingError) {
 *     console.error(`Failed to load ${error.fileName}: ${error.message}`);
 *   }
 * }
 * ```
 */
export async function loadAndValidateFontFile(
	file: File,
	fontName?: string
): Promise<FontLoadingResult> {
	// Validate file type
	if (!isFontFile(file)) {
		throw new FontLoadingError(
			`Unsupported file type. Please provide a font file (.ttf, .otf, .woff, .woff2).`,
			file.name
		);
	}

	// Generate font family name from file name if not provided
	const fontFamily = fontName || file.name.replace(/\.[^.]*$/, '').replace(/[^a-zA-Z0-9]/g, '_');

	// Read file as ArrayBuffer
	let arrayBuffer: ArrayBuffer;
	try {
		arrayBuffer = await file.arrayBuffer();
	} catch (error) {
		throw new FontLoadingError(
			`Failed to read font file.`,
			file.name,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Validate file has content
	if (arrayBuffer.byteLength === 0) {
		throw new FontLoadingError(`Font file is empty.`, file.name);
	}

	// Create FontFace object
	let fontFace: FontFace;
	try {
		fontFace = new FontFace(fontFamily, arrayBuffer);
	} catch (error) {
		throw new FontLoadingError(
			`Failed to create FontFace object. The file may not be a valid font file.`,
			file.name,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Load the font
	try {
		await fontFace.load();
	} catch (error) {
		throw new FontLoadingError(
			`Failed to load font. The font file may be corrupted or in an unsupported format.`,
			file.name,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Add to document.fonts for rendering
	try {
		(document.fonts as any).add(fontFace);
	} catch (error) {
		throw new FontLoadingError(
			`Failed to register font with document.`,
			file.name,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Import font detection utilities dynamically to avoid circular dependency
	const { detectFontType } = await import('./font-detection.js');

	// Perform font type detection
	let detectionResult;
	try {
		detectionResult = await detectFontType(fontFace);
	} catch (error) {
		// Clean up font on detection failure
		try {
			(document.fonts as any).delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new FontLoadingError(
			`Failed to validate font properties.`,
			file.name,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Check if font is pixel-perfect
	if (!detectionResult.isPixelPerfect) {
		// Clean up font if validation fails
		try {
			(document.fonts as any).delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new FontLoadingError(
			`Invalid font file. The font must be a pixel art font with no anti-aliasing. ` +
				`Please use a bitmap/pixel font designed for the target size (12px or 16px).`,
			file.name
		);
	}

	return {
		fontFace,
		fontFamily,
		detectedType: detectionResult.fontType,
		fileName: file.name,
		isPixelPerfect: detectionResult.isPixelPerfect
	};
}

/**
 * Unload a font file from document.fonts
 *
 * Call this when the font is no longer needed to free up resources.
 *
 * @param fontFace - The FontFace object to unload
 * @param fontFamily - The font family name (for reference)
 *
 * @example
 * ```ts
 * try {
 *   unloadFontFile(result.fontFace, result.fontFamily);
 * } catch (error) {
 *   console.error('Failed to unload font:', error);
 * }
 * ```
 */
export function unloadFontFile(fontFace: FontFace, fontFamily: string): void {
	try {
		(document.fonts as any).delete(fontFace);
	} catch (error) {
		// Log but don't throw - cleanup failures are non-critical
		console.warn(`Failed to unload font ${fontFamily}:`, error);
	}
}

/**
 * Load and validate a font file from an ArrayBuffer
 *
 * Alternative version that accepts an ArrayBuffer directly instead of a File object.
 * Useful for fonts loaded from non-file sources.
 *
 * @param arrayBuffer - The font file data
 * @param fontName - Name for the font
 * @returns Promise that resolves with the font loading result
 * @throws FontLoadingError if the font fails to load or validate
 */
export async function loadAndValidateFontFromArrayBuffer(
	arrayBuffer: ArrayBuffer,
	fontName: string
): Promise<FontLoadingResult> {
	// Validate ArrayBuffer has content
	if (arrayBuffer.byteLength === 0) {
		throw new FontLoadingError(`Font data is empty.`, fontName);
	}

	// Create FontFace object
	let fontFace: FontFace;
	try {
		fontFace = new FontFace(fontName, arrayBuffer);
	} catch (error) {
		throw new FontLoadingError(
			`Failed to create FontFace object. The data may not be a valid font.`,
			fontName,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Load the font
	try {
		await fontFace.load();
	} catch (error) {
		throw new FontLoadingError(
			`Failed to load font. The font data may be corrupted or in an unsupported format.`,
			fontName,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Add to document.fonts for rendering
	try {
		(document.fonts as any).add(fontFace);
	} catch (error) {
		throw new FontLoadingError(
			`Failed to register font with document.`,
			fontName,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Import font detection utilities dynamically to avoid circular dependency
	const { detectFontType } = await import('./font-detection.js');

	// Perform font type detection
	let detectionResult;
	try {
		detectionResult = await detectFontType(fontFace);
	} catch (error) {
		// Clean up font on detection failure
		try {
			(document.fonts as any).delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new FontLoadingError(
			`Failed to validate font properties.`,
			fontName,
			error instanceof Error ? error : new Error(String(error))
		);
	}

	// Check if font is pixel-perfect
	if (!detectionResult.isPixelPerfect) {
		// Clean up font if validation fails
		try {
			(document.fonts as any).delete(fontFace);
		} catch {
			// Ignore cleanup errors
		}
		throw new FontLoadingError(
			`Invalid font data. The font must be a pixel art font with no anti-aliasing. ` +
				`Please use a bitmap/pixel font designed for the target size (12px or 16px).`,
			fontName
		);
	}

	return {
		fontFace,
		fontFamily: fontName,
		detectedType: detectionResult.fontType,
		fileName: fontName,
		isPixelPerfect: detectionResult.isPixelPerfect
	};
}
