/**
 * Overwrite functionality tests for FontExtractor and ResourceExtractor
 * Tests round-trip consistency and modification preservation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FontExtractor } from '../extractors/font-extractor.js';
import { ResourceExtractor } from '../extractors/resource-extractor.js';
import { createMonoBmp, parseMonoBmp } from '../utils/bitmap.js';
import { encodeV8, validateFontData, validateBitmapData } from '../utils/font-encoder.js';
import type { PixelData } from '../types/index.js';

// Create a test firmware with font data
function createTestFirmware(): Uint8Array {
	const data = new Uint8Array(0x500000); // 5MB

	// Set up addresses
	const view = new DataView(data.buffer);

	// SMALL_BASE at 0x100000
	// LARGE_BASE at 0x200000
	// LOOKUP_TABLE at 0x080000

	// Set up lookup table values (all zeros = simple config)
	// For basic Latin (0x0000-0x007F), lookup at 0x080000 + (unicode >> 3)
	for (let i = 0; i < 256; i++) {
		data[0x080000 + i] = 0x00; // Simple config (no swaps)
	}

	// Add some font data for 'A' (0x0041) at SMALL font
	// Address: 0x100000 + 0x0041 * 32 = 0x100820
	const smallFontOffset = 0x100000 + 0x0041 * 32;
	// Create a simple 'A' pattern (15x16 pixels)
	const aPattern: number[] = [
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // Row 0-1 (empty)
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
		0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // Row 2
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 3
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 4
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 5
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 6
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 7
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 8
		0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, // Row 9
		0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // Row 10
		0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, // Row 11
		0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // Row 12
		0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, // Row 13
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // Row 14-15 (empty)
		0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
	];

	// Encode the pattern using the v8 algorithm (with lookupVal = 0x00)
	const pixels: PixelData = [];
	for (let y = 0; y < 16; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < 15; x++) {
			row.push(aPattern[y * 16 + x] === 1);
		}
		(pixels as boolean[][]).push(row);
	}

	const encoded = encodeV8(pixels, 0x00);
	data.set(encoded, smallFontOffset);

	// Set up partition table at 0x14c
	view.setUint32(0x14c, 0x300000, true); // Part 5 offset
	view.setUint32(0x150, 0x100000, true); // Part 5 size

	// Add ROCK26 signature for resource testing (in Part 5)
	const rock26Sig = new TextEncoder().encode('ROCK26IMAGERES');
	data.set(rock26Sig, 0x310000); // ROCK26 at offset 0x10000 in Part 5

	// Set up ROCK26 header
	view.setUint32(0x310016, 1, true); // Count
	view.setUint32(0x310020, 16, true); // Entry size

	// Add ROCK26 Entry 0 pointing to our bitmap data
	view.setUint32(0x310020 + 12, 0x2000, true); // offset to bitmap data

	// Add metadata entry (offset must match ROCK26 entry offset)
	const metadataOffset = 0x320000;
	// Entry 0: (dummy entry, might be corrupted)
	view.setUint32(metadataOffset + 20, 0x00000000, true); // offset
	view.setUint32(metadataOffset + 24, 0, true); // width
	view.setUint32(metadataOffset + 28, 0, true); // height
	// Entry 1: TEST.BMP (this is what we'll actually use)
	view.setUint32(metadataOffset + 108 + 20, 0x2000, true); // offset (matches ROCK26)
	view.setUint32(metadataOffset + 108 + 24, 10, true); // width
	view.setUint32(metadataOffset + 108 + 28, 10, true); // height
	const name = new TextEncoder().encode('TEST.BMP\x00');
	data.set(name, metadataOffset + 108 + 32);

	// Add bitmap data at offset 0x2000 in Part 5 (0x302000 in firmware)
	const bitmapOffset = 0x300000 + 0x2000;
	for (let i = 0; i < 10 * 10 * 2; i += 2) {
		// Red color (0xF800 in RGB565)
		data[bitmapOffset + i] = 0x00;
		data[bitmapOffset + i + 1] = 0xf8;
	}

	return data;
}

// Helper to compare two Uint8Arrays
function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// Helper to create a test pixel pattern (50% filled for valid font data)
function createTestPattern(fillAll: boolean): PixelData {
	const result: boolean[][] = [];
	for (let y = 0; y < 16; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < 15; x++) {
			// Create a checkerboard-like pattern (50% filled)
			row.push(fillAll ? (x + y) % 2 === 0 : false);
		}
		result.push(row);
	}
	return result;
}

// Helper to create a simple valid font pattern
function createSimpleFontPattern(): PixelData {
	// Create a simple pattern that's ~50% filled (valid font)
	const result: boolean[][] = [];
	for (let y = 0; y < 16; y++) {
		const row: boolean[] = [];
		for (let x = 0; x < 15; x++) {
			// X pattern in center
			if ((x === y) || (x + y === 14)) {
				row.push(true);
			} else {
				row.push(false);
			}
		}
		result.push(row);
	}
	return result;
}

describe('FontExtractor Overwrite Tests', () => {
	let firmware: Uint8Array;
	let extractor: FontExtractor;

	beforeEach(() => {
		firmware = createTestFirmware();
		extractor = new FontExtractor(firmware, {
			SMALL_BASE: 0x100000,
			LARGE_BASE: 0x200000,
			LOOKUP_TABLE: 0x080000,
			confidence: {
				smallFontValid: 1,
				largeFontValid: 0,
				movw0042Count: 0
			}
		});
	});

	describe('readFont', () => {
		it('should read font data for valid Unicode character', () => {
			const data = extractor.readFont(0x0041, 'SMALL');
			expect(data).not.toBeNull();
			expect(data?.length).toBe(32); // SMALL_STRIDE
		});

		it('should return null for out of range Unicode', () => {
			const data = extractor.readFont(0x999999, 'SMALL');
			expect(data).toBeNull();
		});

		it('should return null for out of bounds address', () => {
			// Try to read from a LARGE address that's way beyond firmware size
			const data = extractor.readFont(0x999999, 'LARGE');
			expect(data).toBeNull();
		});
	});

	describe('readFontAsPixels', () => {
		it('should read and decode font data to pixels', () => {
			const pixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(pixels).not.toBeNull();
			expect(pixels?.length).toBe(16);
			expect(pixels?.[0].length).toBe(15);
		});

		it('should return null for invalid character', () => {
			const pixels = extractor.readFontAsPixels(0x999999, 'SMALL');
			expect(pixels).toBeNull();
		});
	});

	describe('replaceFont - Round-trip consistency', () => {
		it('should read -> write -> read and get identical data', () => {
			// Read original font data
			const original = extractor.readFont(0x0041, 'SMALL');
			expect(original).not.toBeNull();

			// Write it back
			const result = extractor.replaceFont(0x0041, 'SMALL', original!);
			expect(result).toBe(true);

			// Read again
			const afterWrite = extractor.readFont(0x0041, 'SMALL');
			expect(afterWrite).not.toBeNull();

			// Compare byte-for-byte
			expect(arraysEqual(original!, afterWrite!)).toBe(true);
		});

		it('should readAsPixels -> encode -> write -> read and get identical data', () => {
			// Read original pixels
			const originalPixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(originalPixels).not.toBeNull();

			// Write from pixels
			const result = extractor.replaceFontFromPixels(0x0041, 'SMALL', originalPixels!);
			expect(result).toBe(true);

			// Read again as pixels
			const afterWritePixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(afterWritePixels).not.toBeNull();

			// Compare pixel-by-pixel
			expect(afterWritePixels).toEqual(originalPixels);
		});

		it('should read -> BMP -> write -> read and get identical data', () => {
			// Read original pixels
			const originalPixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(originalPixels).not.toBeNull();

			// Convert to BMP
			const bmpData = createMonoBmp(originalPixels!, 15, 16);
			expect(bmpData).not.toBeNull();

			// Write from BMP
			const result = extractor.replaceFontFromBmp(0x0041, 'SMALL', bmpData);
			expect(result).toBe(true);

			// Read again as pixels
			const afterWritePixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(afterWritePixels).not.toBeNull();

			// Compare pixel-by-pixel
			expect(afterWritePixels).toEqual(originalPixels);
		});
	});

	describe('replaceFont - Modification preservation', () => {
		it('should read -> modify -> write -> read and preserve modifications', () => {
			// Read original pixels
			const originalPixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(originalPixels).not.toBeNull();

			// Modify: invert all pixels
			const modifiedPixels: PixelData = originalPixels!.map((row) =>
				row.map((pixel) => !pixel)
			);

			// Write modified pixels
			const result = extractor.replaceFontFromPixels(0x0041, 'SMALL', modifiedPixels);
			expect(result).toBe(true);

			// Read again
			const afterWritePixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(afterWritePixels).not.toBeNull();

			// Verify modifications are preserved
			expect(afterWritePixels).toEqual(modifiedPixels);
		});

		it('should modify specific pixels and preserve changes', () => {
			// Read original pixels
			const originalPixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(originalPixels).not.toBeNull();

			// Modify: set center pixels to true
			const modifiedPixels: PixelData = originalPixels!.map((row) =>
				row.map((pixel, x) => (x >= 5 && x <= 9 ? true : pixel))
			);

			// Write modified pixels
			const result = extractor.replaceFontFromPixels(0x0041, 'SMALL', modifiedPixels);
			expect(result).toBe(true);

			// Read again
			const afterWritePixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(afterWritePixels).not.toBeNull();

			// Verify modifications are preserved
			expect(afterWritePixels).toEqual(modifiedPixels);

			// Verify specific pixels in center (rows 5-9, cols 5-9)
			for (let y = 5; y <= 9; y++) {
				for (let x = 5; x <= 9; x++) {
					expect(afterWritePixels![y][x]).toBe(true);
				}
			}
		});

		it('should handle multiple sequential modifications', () => {
			// Read original
			let pixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(pixels).not.toBeNull();

			// First modification: set to checkerboard pattern
			let modifiedPixels: PixelData = Array.from({ length: 16 }, (_, y) =>
				Array.from({ length: 15 }, (_, x) => (x + y) % 2 === 0)
			);
			let result = extractor.replaceFontFromPixels(0x0041, 'SMALL', modifiedPixels);
			expect(result).toBe(true);

			pixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(pixels).toEqual(modifiedPixels);

			// Second modification: set to X pattern
			modifiedPixels = createSimpleFontPattern();
			result = extractor.replaceFontFromPixels(0x0041, 'SMALL', modifiedPixels);
			expect(result).toBe(true);

			pixels = extractor.readFontAsPixels(0x0041, 'SMALL');
			expect(pixels).toEqual(modifiedPixels);
		});
	});

	describe('replaceFont - Validation', () => {
		it('should reject data with wrong size', () => {
			const wrongSize = new Uint8Array(99); // Wrong size
			const result = extractor.replaceFont(0x0041, 'SMALL', wrongSize);
			expect(result).toBe(false);
		});

		it('should reject all-zero data', () => {
			const allZero = new Uint8Array(32); // All zeros
			const result = extractor.replaceFont(0x0041, 'SMALL', allZero);
			expect(result).toBe(false);
		});

		it('should reject all-0xFF data', () => {
			const allFF = new Uint8Array(32).fill(0xff);
			const result = extractor.replaceFont(0x0041, 'SMALL', allFF);
			expect(result).toBe(false);
		});

		it('should reject invalid pixel dimensions', () => {
			const invalidPixels: PixelData = [];
			for (let y = 0; y < 10; y++) {
				// Wrong: 10 rows instead of 16
				const row: boolean[] = [];
				for (let x = 0; x < 15; x++) {
					row.push(false);
				}
				invalidPixels.push(row);
			}

			const result = extractor.replaceFontFromPixels(0x0041, 'SMALL', invalidPixels);
			expect(result).toBe(false);
		});
	});

	describe('getFirmwareData', () => {
		it('should return modified firmware after overwrite', () => {
			// Get original data
			const originalData = extractor.getFirmwareData();

			// Read original font to make sure we have data
			const originalFont = extractor.readFont(0x0041, 'SMALL');
			expect(originalFont).not.toBeNull();

			// Save original data at font location
			const fontOffset = 0x100000 + 0x0041 * 32;
			const beforeWrite = new Uint8Array(32);
			beforeWrite.set(originalData.slice(fontOffset, fontOffset + 32));

			// Modify font with a clearly different pattern (all false in center, true on edges)
			const modifiedPixels: PixelData = Array.from({ length: 16 }, (_, y) =>
				Array.from({ length: 15 }, (_, x) => x < 2 || x > 12 || y < 2 || y > 13)
			);

			const success = extractor.replaceFontFromPixels(0x0041, 'SMALL', modifiedPixels);
			expect(success).toBe(true);

			// Get modified data
			const modifiedData = extractor.getFirmwareData();

			// Should be same reference (mutates in place)
			expect(modifiedData).toBe(originalData);

			// Read the data at font location after modification
			const afterWrite = new Uint8Array(32);
			afterWrite.set(modifiedData.slice(fontOffset, fontOffset + 32));

			// The data should be different
			expect(arraysEqual(beforeWrite, afterWrite)).toBe(false);
		});
	});
});

describe('ResourceExtractor Overwrite Tests', () => {
	let firmware: Uint8Array;
	let extractor: ResourceExtractor;

	beforeEach(() => {
		firmware = createTestFirmware();
		extractor = new ResourceExtractor(firmware);
	});

	describe('readBitmap', () => {
		it('should read bitmap data for existing file', () => {
			const data = extractor.readBitmap('TEST.BMP');
			expect(data).not.toBeNull();
			expect(data?.length).toBe(10 * 10 * 2); // width * height * 2
		});

		it('should return null for non-existent file', () => {
			const data = extractor.readBitmap('NONEXISTENT.BMP');
			expect(data).toBeNull();
		});
	});

	describe('replaceBitmap - Round-trip consistency', () => {
		it('should read -> write -> read and get identical data', () => {
			// Read original bitmap data
			const original = extractor.readBitmap('TEST.BMP');
			expect(original).not.toBeNull();

			// Write it back
			const result = extractor.replaceBitmap('TEST.BMP', original!);
			expect(result).toBe(true);

			// Read again
			const afterWrite = extractor.readBitmap('TEST.BMP');
			expect(afterWrite).not.toBeNull();

			// Compare byte-for-byte
			expect(arraysEqual(original!, afterWrite!)).toBe(true);
		});
	});

	describe('replaceBitmap - Modification preservation', () => {
		it('should read -> modify -> write -> read and preserve modifications', () => {
			// Read original bitmap data
			const original = extractor.readBitmap('TEST.BMP');
			expect(original).not.toBeNull();

			// Modify: invert all bytes
			const modified = new Uint8Array(original!.length);
			for (let i = 0; i < original!.length; i++) {
				modified[i] = original![i] ^ 0xff;
			}

			// Write modified data
			const result = extractor.replaceBitmap('TEST.BMP', modified);
			expect(result).toBe(true);

			// Read again
			const afterWrite = extractor.readBitmap('TEST.BMP');
			expect(afterWrite).not.toBeNull();

			// Verify modifications are preserved
			expect(arraysEqual(modified, afterWrite!)).toBe(true);
		});

		it('should handle multiple sequential modifications', () => {
			// Read original
			let data = extractor.readBitmap('TEST.BMP');
			expect(data).not.toBeNull();

			// First modification: set all to 0x00, 0x00 (black in RGB565)
			let modified = new Uint8Array(data!.length).fill(0x00);
			let result = extractor.replaceBitmap('TEST.BMP', modified);
			expect(result).toBe(true);

			data = extractor.readBitmap('TEST.BMP');
			expect(arraysEqual(modified, data!)).toBe(true);

			// Second modification: set all to 0xff, 0xff (white-ish in RGB565)
			modified = new Uint8Array(data!.length).fill(0xff);
			result = extractor.replaceBitmap('TEST.BMP', modified);
			expect(result).toBe(true);

			data = extractor.readBitmap('TEST.BMP');
			expect(arraysEqual(modified, data!)).toBe(true);
		});

		it('should modify specific pixels and preserve changes', () => {
			// Read original
			const original = extractor.readBitmap('TEST.BMP');
			expect(original).not.toBeNull();

			// Modify: set first 10 bytes to 0x00
			const modified = new Uint8Array(original!);
			for (let i = 0; i < 10; i++) {
				modified[i] = 0x00;
			}

			// Write modified data
			const result = extractor.replaceBitmap('TEST.BMP', modified);
			expect(result).toBe(true);

			// Read again
			const afterWrite = extractor.readBitmap('TEST.BMP');
			expect(afterWrite).not.toBeNull();

			// Verify modifications are preserved
			expect(arraysEqual(modified, afterWrite!)).toBe(true);

			// Verify specific bytes
			for (let i = 0; i < 10; i++) {
				expect(afterWrite![i]).toBe(0x00);
			}
		});
	});

	describe('replaceBitmap - Validation', () => {
		it('should reject data with wrong size', () => {
			const wrongSize = new Uint8Array(999); // Wrong size for 10x10 bitmap
			const result = extractor.replaceBitmap('TEST.BMP', wrongSize);
			expect(result).toBe(false);
		});

		it('should reject non-existent filename', () => {
			const data = new Uint8Array(10 * 10 * 2);
			const result = extractor.replaceBitmap('NONEXISTENT.BMP', data);
			expect(result).toBe(false);
		});
	});

	describe('getFirmwareData', () => {
		it('should return modified firmware after overwrite', () => {
			// Create a fresh firmware for this specific test
			const freshFirmware = createTestFirmware();
			const freshExtractor = new ResourceExtractor(freshFirmware);

			// Get original data (before modification)
			const originalData = freshExtractor.getFirmwareData();

			// Read original bitmap
			const originalBitmap = freshExtractor.readBitmap('TEST.BMP');
			expect(originalBitmap).not.toBeNull();

			// Save a copy of the original bitmap
			const originalBitmapCopy = new Uint8Array(originalBitmap!);

			// Modify bitmap with a clearly different pattern
			const modified = new Uint8Array(10 * 10 * 2).fill(0x99);
			const success = freshExtractor.replaceBitmap('TEST.BMP', modified);
			expect(success).toBe(true);

			// Get modified data
			const modifiedData = freshExtractor.getFirmwareData();

			// Should be same reference (mutates in place)
			expect(modifiedData).toBe(originalData);

			// Read bitmap again to verify it was modified
			const afterModification = freshExtractor.readBitmap('TEST.BMP');
			expect(afterModification).not.toBeNull();

			// The new bitmap should match our modified data
			expect(arraysEqual(afterModification!, modified)).toBe(true);

			// The new bitmap should be different from the original
			expect(arraysEqual(afterModification!, originalBitmapCopy)).toBe(false);
		});
	});
});

describe('FontEncoder Tests', () => {
	describe('encodeV8 round-trip with decodeV8', () => {
		it('should encode and decode back to same pixels', () => {
			// Use the pattern from the test firmware
			const originalPixels = createSimpleFontPattern();

			// Encode
			const encoded = encodeV8(originalPixels, 0x00);

			// Decode (using FontExtractor's decodeV8)
			const firmware = new Uint8Array(0x500000);
			firmware.set(encoded, 0x100000);

			const extractor = new FontExtractor(firmware, {
				SMALL_BASE: 0x100000,
				LARGE_BASE: 0x200000,
				LOOKUP_TABLE: 0x080000,
				confidence: {
					smallFontValid: 1,
					largeFontValid: 0,
					movw0042Count: 0
				}
			});

			// Set lookup value
			firmware[0x080000] = 0x00;

			const decodedPixels = extractor.readFontAsPixels(0x0000, 'SMALL');

			// Verify the pattern was preserved
			expect(decodedPixels).toEqual(originalPixels);
		});

		it('should handle various patterns', () => {
			const patterns: PixelData[] = [
				// Checkerboard pattern
				Array.from({ length: 16 }, (_, y) =>
					Array.from({ length: 15 }, (_, x) => (x + y) % 2 === 0)
				),
				// Vertical stripes
				Array.from({ length: 16 }, (_, y) =>
					Array.from({ length: 15 }, (_, x) => x % 3 === 0)
				),
				// Horizontal stripes
				Array.from({ length: 16 }, (_, y) =>
					Array.from({ length: 15 }, (_, x) => y % 3 === 0)
				)
			];

			for (const pattern of patterns) {
				const encoded = encodeV8(pattern, 0x00);

				// Create firmware and decode
				const firmware = new Uint8Array(0x500000);
				firmware.set(encoded, 0x100000);
				firmware[0x080000] = 0x00;

				const extractor = new FontExtractor(firmware, {
					SMALL_BASE: 0x100000,
					LARGE_BASE: 0x200000,
					LOOKUP_TABLE: 0x080000,
					confidence: {
						smallFontValid: 1,
						largeFontValid: 0,
						movw0042Count: 0
					}
				});

				const decodedPixels = extractor.readFontAsPixels(0x0000, 'SMALL');

				expect(decodedPixels).toEqual(pattern);
			}
		});
	});
});

describe('BMP Parser Tests', () => {
	describe('parseMonoBmp round-trip with createMonoBmp', () => {
		it('should create and parse back to same pixels', () => {
			const originalPixels = createSimpleFontPattern();

			// Create BMP
			const bmpData = createMonoBmp(originalPixels, 15, 16);

			// Parse BMP
			const parsedPixels = parseMonoBmp(bmpData);

			expect(parsedPixels).not.toBeNull();
			expect(parsedPixels).toEqual(originalPixels);
		});

		it('should handle various patterns', () => {
			const patterns: PixelData[] = [
				// Checkerboard pattern
				Array.from({ length: 16 }, (_, y) =>
					Array.from({ length: 15 }, (_, x) => (x + y) % 2 === 0)
				),
				// Vertical stripes
				Array.from({ length: 16 }, (_, y) =>
					Array.from({ length: 15 }, (_, x) => x % 3 === 0)
				),
				// All false (empty)
				Array.from({ length: 16 }, (_, y) =>
					Array.from({ length: 15 }, () => false)
				)
			];

			for (const pattern of patterns) {
				const bmpData = createMonoBmp(pattern, 15, 16);
				const parsedPixels = parseMonoBmp(bmpData);

				expect(parsedPixels).not.toBeNull();
				expect(parsedPixels).toEqual(pattern);
			}
		});
	});
});

describe('Validation Tests', () => {
	describe('validateFontData', () => {
		it('should accept valid font data', () => {
			const data = new Uint8Array(32);
			data[0] = 0x12;
			data[1] = 0x34;

			expect(validateFontData(data, 32)).toBe(true);
		});

		it('should reject wrong size', () => {
			const data = new Uint8Array(99);
			expect(validateFontData(data, 32)).toBe(false);
		});

		it('should reject all zeros', () => {
			const data = new Uint8Array(32);
			expect(validateFontData(data, 32)).toBe(false);
		});

		it('should reject all 0xFF', () => {
			const data = new Uint8Array(32).fill(0xff);
			expect(validateFontData(data, 32)).toBe(false);
		});
	});

	describe('validateBitmapData', () => {
		it('should accept valid bitmap data', () => {
			const data = new Uint8Array(10 * 10 * 2);
			expect(validateBitmapData(data, 10, 10)).toBe(true);
		});

		it('should reject wrong size', () => {
			const data = new Uint8Array(99);
			expect(validateBitmapData(data, 10, 10)).toBe(false);
		});

		it('should reject invalid dimensions', () => {
			const data = new Uint8Array(10 * 10 * 2);
			expect(validateBitmapData(data, -1, 10)).toBe(false);
			expect(validateBitmapData(data, 0, 10)).toBe(false);
			expect(validateBitmapData(data, 10001, 10)).toBe(false);
		});
	});
});
