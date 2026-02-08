/**
 * Font decoder utilities - Decode font data from firmware
 * Shared between FontExtractor and firmware-worker
 */

import type { PixelData } from '../types/index.js';

/**
 * SMALL font display size
 * SMALL fonts are stored as 16x16 in the firmware but only a subset is used for display
 */
export const SMALL_FONT_SIZE = 12;

/**
 * Parse lookup value to encoding config
 * @param lookupVal - Lookup table value
 * @returns Encoding configuration
 */
export function parseLookupConfig(lookupVal: number): {
	swMcuBits: number;
	swMcuHwSwap: number;
	swMcuByteSwap: number;
} {
	const configByte = lookupVal & 0xff;
	return {
		swMcuBits: (configByte >> 3) & 1,
		swMcuHwSwap: (configByte >> 4) & 1,
		swMcuByteSwap: (configByte >> 5) & 1
	};
}

/**
 * Decode font data chunk using v8 algorithm
 * @param chunk - Raw font data (32 bytes for SMALL, 33 bytes for LARGE)
 * @param lookupVal - Lookup table value
 * @returns Decoded pixel data (16x16 boolean array)
 */
export function decodeV8(chunk: Uint8Array, lookupVal: number): PixelData {
	const config = parseLookupConfig(lookupVal);
	const { swMcuBits, swMcuHwSwap, swMcuByteSwap } = config;

	const pixels: boolean[][] = [];

	for (let i = 0; i < chunk.length - 1; i += 2) {
		const b0 = chunk[i];
		const b1 = chunk[i + 1];

		let finalPixel: number;

		if (swMcuBits === 1) {
			let val = (b1 << 8) | b0;
			if (swMcuByteSwap === 1) {
				val = ((val & 0xff) << 8) | ((val >> 8) & 0xff);
			}
			finalPixel = val;
		} else {
			let cycle1: number;
			let cycle2: number;

			if (swMcuHwSwap === swMcuByteSwap) {
				cycle1 = b1;
				cycle2 = b0;
			} else {
				cycle1 = b0;
				cycle2 = b1;
			}

			if (swMcuByteSwap === 1) {
				[cycle1, cycle2] = [cycle2, cycle1];
			}

			if (swMcuHwSwap === 1) {
				[cycle1, cycle2] = [cycle2, cycle1];
			}

			finalPixel = cycle2 | (cycle1 << 8);
		}

		if (!(swMcuBits === 1 && swMcuByteSwap === 1)) {
			finalPixel = ((finalPixel & 0xff) << 8) | ((finalPixel >> 8) & 0xff);
		}

		const rowBits: boolean[] = [];
		// Extract all 16 bits (15 down to 0 inclusive)
		for (let bit = 15; bit >= 0; bit--) {
			rowBits.push(((finalPixel >> bit) & 1) === 1);
		}
		pixels.push(rowBits);
	}

	return pixels;
}

/**
 * Check if data is all zeros or all 0xFF
 * @param data - Data chunk to check
 * @returns True if data is empty (all same byte)
 */
export function isDataEmpty(data: Uint8Array): boolean {
	if (data.length === 0) return true;
	const first = data[0];
	return data.every((b) => b === first);
}

/**
 * Slice SMALL font pixels to SMALL_FONT_SIZE x SMALL_FONT_SIZE (top-left corner)
 * SMALL fonts are stored as 16x16 but only the top-left SMALL_FONT_SIZE x SMALL_FONT_SIZE is used
 * @param pixels - Full 16x16 pixel data
 * @returns SMALL_FONT_SIZE x SMALL_FONT_SIZE pixel data
 */
export function sliceSmallFontPixels(pixels: PixelData): PixelData {
	return pixels.slice(0, SMALL_FONT_SIZE).map((row) => row.slice(0, SMALL_FONT_SIZE));
}

/**
 * Pad SMALL font pixels from SMALL_FONT_SIZE x SMALL_FONT_SIZE to 16x16 for encoding
 * @param pixels - SMALL_FONT_SIZE x SMALL_FONT_SIZE pixel data
 * @returns 16x16 pixel data with padding
 */
export function padSmallFontPixels(pixels: PixelData): PixelData {
	const padded: boolean[][] = [];
	const paddingCols = 16 - SMALL_FONT_SIZE;
	for (let i = 0; i < 16; i++) {
		if (i < SMALL_FONT_SIZE) {
			// Pad each row to 16 columns
			padded.push([...pixels[i], ...new Array(paddingCols).fill(false)]);
		} else {
			// Add empty rows
			padded.push(new Array(16).fill(false));
		}
	}
	return padded as PixelData;
}
