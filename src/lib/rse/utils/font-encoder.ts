/**
 * Font encoder utilities - Encode pixel data back to font format
 * This is the inverse of the v8 decoding algorithm in FontExtractor
 */

import type { PixelData } from '../types/index.js';

/**
 * Font encoding configuration (derived from lookup table value)
 */
export interface FontEncodingConfig {
	/** Swap bits flag */
	readonly swMcuBits: number;
	/** Hardware swap flag */
	readonly swMcuHwSwap: number;
	/** Byte swap flag */
	readonly swMcuByteSwap: number;
}

/**
 * Parse lookup value to encoding config
 * @param lookupVal - Lookup table value
 * @returns Encoding configuration
 */
export function parseLookupConfig(lookupVal: number): FontEncodingConfig {
	const configByte = lookupVal & 0xff;
	return {
		swMcuBits: (configByte >> 3) & 1,
		swMcuHwSwap: (configByte >> 4) & 1,
		swMcuByteSwap: (configByte >> 5) & 1
	};
}

/**
 * Encode pixel data to font chunk using v8 algorithm (inverse of decodeV8)
 * @param pixels - 2D pixel array (16 rows, each with 15 bits)
 * @param lookupVal - Lookup table value for encoding configuration
 * @returns Encoded font data chunk (32 bytes for SMALL, 33 bytes for LARGE)
 * @throws Error if pixel data is invalid
 */
export function encodeV8(pixels: PixelData, lookupVal: number): Uint8Array {
	// Validate pixel data
	if (pixels.length !== 16) {
		throw new Error(`Invalid pixel data: expected 16 rows, got ${pixels.length}`);
	}

	for (let i = 0; i < pixels.length; i++) {
		if (pixels[i].length !== 15) {
			throw new Error(`Invalid pixel data: expected 15 pixels per row, got ${pixels[i].length} in row ${i}`);
		}
	}

	const config = parseLookupConfig(lookupVal);
	const { swMcuBits, swMcuHwSwap, swMcuByteSwap } = config;

	// Encode each row to 2 bytes (16 bits, but we only use 15)
	const chunk = new Uint8Array(32);

	for (let row = 0; row < 16; row++) {
		// Convert 15 pixels to a 16-bit value (left-aligned)
		let pixelValue = 0;
		for (let bit = 0; bit < 15; bit++) {
			if (pixels[row][bit]) {
				pixelValue |= (1 << (15 - bit));
			}
		}

		// Apply inverse of decodeV8 transformations
		// The final step in decodeV8 (if not swMcuBits=1 && swMcuByteSwap=1)
		// was: finalPixel = ((finalPixel & 0xff) << 8) | ((finalPixel >> 8) & 0xff)
		// So we need to reverse this first
		if (!(swMcuBits === 1 && swMcuByteSwap === 1)) {
			pixelValue = ((pixelValue & 0xff) << 8) | ((pixelValue >> 8) & 0xff);
		}

		let finalPixel: number;

		if (swMcuBits === 1) {
			// In decode: if swMcuBits === 1, val = (b1 << 8) | b0, then possible byte swap
			// So finalPixel after byte swap is what we have
			// To reverse: if swMcuByteSwap === 1, swap back
			finalPixel = pixelValue;
			if (swMcuByteSwap === 1) {
				finalPixel = ((finalPixel & 0xff) << 8) | ((finalPixel >> 8) & 0xff);
			}
		} else {
			// More complex case with swMcuHwSwap and swMcuByteSwap
			// In decode:
			// - cycle1/cycle2 are determined by swMcuHwSwap vs swMcuByteSwap
			// - then possibly swapped by swMcuByteSwap
			// - then possibly swapped by swMcuHwSwap
			// - finalPixel = cycle2 | (cycle1 << 8)

			let cycle1 = (pixelValue >> 8) & 0xff;
			let cycle2 = pixelValue & 0xff;

			// Reverse swMcuHwSwap
			if (swMcuHwSwap === 1) {
				[cycle1, cycle2] = [cycle2, cycle1];
			}

			// Reverse swMcuByteSwap
			if (swMcuByteSwap === 1) {
				[cycle1, cycle2] = [cycle2, cycle1];
			}

			// Reverse the initial assignment based on swMcuHwSwap vs swMcuByteSwap
			if (swMcuHwSwap === swMcuByteSwap) {
				// Was: cycle1 = b1, cycle2 = b0
				// We already have cycle1, cycle2
			} else {
				// Was: cycle1 = b0, cycle2 = b1
				// Already swapped above
			}

			finalPixel = cycle2 | (cycle1 << 8);
		}

		// Write to chunk (little-endian)
		chunk[row * 2] = finalPixel & 0xff;
		chunk[row * 2 + 1] = (finalPixel >> 8) & 0xff;
	}

	return chunk;
}

/**
 * Validate font data before writing
 * @param data - Font data to validate
 * @param expectedSize - Expected size (32 for SMALL, 33 for LARGE)
 * @returns True if valid
 */
export function validateFontData(data: Uint8Array, expectedSize: number): boolean {
	if (data.length !== expectedSize) {
		return false;
	}

	// Check data is not all zeros or all 0xFF
	const first = data[0];
	if (data.every((b) => b === first)) {
		return false;
	}

	return true;
}

/**
 * Validate bitmap data before writing
 * @param data - RGB565 bitmap data
 * @param width - Image width
 * @param height - Image height
 * @returns True if valid
 */
export function validateBitmapData(data: Uint8Array, width: number, height: number): boolean {
	const expectedSize = width * height * 2;
	if (data.length !== expectedSize) {
		return false;
	}

	// Check dimensions are reasonable
	if (width <= 0 || height <= 0 || width > 10000 || height > 10000) {
		return false;
	}

	return true;
}
