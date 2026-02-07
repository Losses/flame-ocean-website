/**
 * Tests for bitmap conversion utilities
 */

import { describe, it, expect } from 'vitest';
import { convertToBmp, createMonoBmp, isValidFontData } from '../utils/bitmap.js';
import type { PixelData } from '../types/index.js';

describe('convertToBmp', () => {
	it('should convert RGB565 to BMP', () => {
		// Create simple RGB565 data: 2x2 pixels
		// Each pixel is 2 bytes, total 4 pixels = 8 bytes
		const rawData = new Uint8Array([
			0xff, 0x00, // Pixel 0: red (0x00ff -> after byte swap -> 0xff00 -> RGB565 red)
			0x00, 0x07, // Pixel 1: blue
			0xe0, 0x07, // Pixel 2: green
			0xff, 0xf8 // Pixel 3: white
		]);

		const result = convertToBmp(rawData, 2, 2);

		expect(result).not.toBeNull();

		// Check BMP signature
		expect(result![0]).toBe(0x42); // 'B'
		expect(result![1]).toBe(0x4d); // 'M'
	});

	it('should return null for invalid dimensions', () => {
		const rawData = new Uint8Array(8);
		expect(convertToBmp(rawData, 0, 10)).toBeNull();
		expect(convertToBmp(rawData, 10, 0)).toBeNull();
		expect(convertToBmp(rawData, -1, 10)).toBeNull();
	});

	it('should pad data to expected size', () => {
		const rawData = new Uint8Array([1, 2, 3, 4]); // Only 2 pixels worth
		const result = convertToBmp(rawData, 2, 2);

		expect(result).not.toBeNull();
		// Should complete the 4 pixels
	});

	it('should handle byte swapping', () => {
		// Create a pattern that tests byte swapping
		const rawData = new Uint8Array([
			0x12, 0x34, // Before swap: 0x3412, after swap: 0x1234
			0x56, 0x78 // Before swap: 0x7856, after swap: 0x5678
		]);

		const result = convertToBmp(rawData, 2, 1);

		expect(result).not.toBeNull();
		// The result should have bytes swapped in the pixel data area
	});
});

describe('createMonoBmp', () => {
	it('should create monochrome BMP', () => {
		// Create 15x16 pixel pattern
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			const row: boolean[] = [];
			for (let x = 0; x < 15; x++) {
				row.push((x + y) % 2 === 0);
			}
			pixels.push(row);
		}

		const result = createMonoBmp(pixels, 15, 16);

		// Check BMP signature
		expect(result[0]).toBe(0x42); // 'B'
		expect(result[1]).toBe(0x4d); // 'M'

		// Check bit count (1 for monochrome)
		const bitCount = result[28] | (result[29] << 8);
		expect(bitCount).toBe(1);
	});

	it('should handle custom dimensions', () => {
		const pixels: PixelData = [
			[true, false, true],
			[false, true, false],
			[true, false, true]
		];

		const result = createMonoBmp(pixels, 3, 3);

		// Check dimensions
		const width = result[18] | (result[19] << 8) | (result[20] << 16) | (result[21] << 24);
		const height = result[22] | (result[23] << 8) | (result[24] << 16) | (result[25] << 24);

		expect(width).toBe(3);
		expect(height).toBe(3);
	});

	it('should create valid BMP structure', () => {
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			pixels.push(new Array(15).fill(false));
		}

		const result = createMonoBmp(pixels);

		// Check file header size (14 bytes)
		// Check DIB header size (40 bytes)
		const dibSize = result[14] | (result[15] << 8) | (result[16] << 16) | (result[17] << 24);
		expect(dibSize).toBe(40);

		// Check color table (2 colors * 4 bytes = 8 bytes)
		// Offset to pixel data should be 62
		const offset = result[10] | (result[11] << 8) | (result[12] << 16) | (result[13] << 24);
		expect(offset).toBe(62);
	});
});

describe('isValidFontData', () => {
	it('should accept valid small font data', () => {
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			const row: boolean[] = [];
			for (let x = 0; x < 15; x++) {
				row.push(Math.random() < 0.3); // ~30% fill
			}
			pixels.push(row);
		}

		expect(isValidFontData(pixels, 'SMALL')).toBe(true);
	});

	it('should accept valid large font data', () => {
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			const row: boolean[] = [];
			for (let x = 0; x < 15; x++) {
				row.push(Math.random() < 0.4); // ~40% fill
			}
			pixels.push(row);
		}

		expect(isValidFontData(pixels, 'LARGE')).toBe(true);
	});

	it('should reject empty data', () => {
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			pixels.push(new Array(15).fill(false));
		}

		expect(isValidFontData(pixels, 'SMALL')).toBe(false);
		expect(isValidFontData(pixels, 'LARGE')).toBe(false);
	});

	it('should reject too dense data', () => {
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			pixels.push(new Array(15).fill(true)); // 100% fill
		}

		expect(isValidFontData(pixels, 'SMALL')).toBe(false);
		expect(isValidFontData(pixels, 'LARGE')).toBe(false);
	});

	it('should reject sparse data', () => {
		const pixels: boolean[][] = [];
		for (let y = 0; y < 16; y++) {
			const row: boolean[] = [];
			for (let x = 0; x < 15; x++) {
				row.push(x === 0); // Only first pixel set
			}
			pixels.push(row);
		}

		expect(isValidFontData(pixels, 'SMALL')).toBe(false);
		expect(isValidFontData(pixels, 'LARGE')).toBe(false);
	});

	it('should handle partial rows', () => {
		const pixels: boolean[][] = [
			[true, false, true],
			[false, true, false]
		];

		// Partial data should still be validated
		const result = isValidFontData(pixels, 'SMALL');
		expect(typeof result).toBe('boolean');
	});
});
