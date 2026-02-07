/**
 * Tests for byte manipulation utilities
 */

import { describe, it, expect } from 'vitest';
import {
	swapBytes16Bit,
	padToLength,
	getStrideInfo,
	restrideToBmp,
	sanitizeFilename,
	isDataEmpty,
	isDataValid
} from '../utils/bytes.js';
import { createBmpHeader } from '../utils/bytes.js';

describe('swapBytes16Bit', () => {
	it('should swap odd and even bytes', () => {
		const input = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90]);
		const expected = new Uint8Array([0x34, 0x12, 0x78, 0x56, 0x90]);
		expect(swapBytes16Bit(input)).toEqual(expected);
	});

	it('should handle odd-length arrays', () => {
		const input = new Uint8Array([0x12, 0x34, 0x56]);
		const expected = new Uint8Array([0x34, 0x12, 0x56]);
		expect(swapBytes16Bit(input)).toEqual(expected);
	});

	it('should handle empty array', () => {
		const input = new Uint8Array(0);
		expect(swapBytes16Bit(input)).toEqual(new Uint8Array(0));
	});
});

describe('padToLength', () => {
	it('should pad to minimum length', () => {
		const input = new Uint8Array([0x12, 0x34]);
		const result = padToLength(input, 5);
		expect(result.length).toBe(5);
		expect(result[0]).toBe(0x12);
		expect(result[1]).toBe(0x34);
		expect(result[2]).toBe(0);
		expect(result[3]).toBe(0);
		expect(result[4]).toBe(0);
	});

	it('should not pad if already long enough', () => {
		const input = new Uint8Array([0x12, 0x34, 0x56]);
		const result = padToLength(input, 3);
		expect(result).toEqual(input);
	});
});

describe('getStrideInfo', () => {
	it('should calculate stride for width=100', () => {
		const info = getStrideInfo(100);
		expect(info.srcStride).toBe(200); // 100 * 2
		expect(info.dstStride).toBe(200); // (200 + 3) & ~3 = 200
		expect(info.padding).toBe(0);
	});

	it('should calculate stride for width=101', () => {
		const info = getStrideInfo(101);
		expect(info.srcStride).toBe(202); // 101 * 2
		expect(info.dstStride).toBe(204); // (202 + 3) & ~3 = 204
		expect(info.padding).toBe(2);
	});

	it('should handle small widths', () => {
		const info = getStrideInfo(1);
		expect(info.srcStride).toBe(2);
		expect(info.dstStride).toBe(4); // 2-byte aligned
		expect(info.padding).toBe(2);
	});
});

describe('restrideToBmp', () => {
	it('should return original if no padding needed', () => {
		const input = new Uint8Array([1, 2, 3, 4]);
		const result = restrideToBmp(input, 2, 1);
		expect(result).toEqual(input);
	});

	it('should add padding for odd widths', () => {
		const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
		const result = restrideToBmp(input, 3, 1);
		// 3 pixels = 6 bytes, stride should be 8 bytes
		expect(result.length).toBe(8);
		expect(result[0]).toBe(1);
		expect(result[1]).toBe(2);
		expect(result[2]).toBe(3);
		expect(result[3]).toBe(4);
		expect(result[4]).toBe(5);
		expect(result[5]).toBe(6);
		expect(result[6]).toBe(0);
		expect(result[7]).toBe(0);
	});

	it('should handle multiple rows', () => {
		const input = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const result = restrideToBmp(input, 3, 2);
		// Each row: 3 pixels = 6 bytes + 2 padding = 8 bytes
		// 2 rows = 16 bytes
		expect(result.length).toBe(16);
	});
});

describe('createBmpHeader', () => {
	it('should create valid BMP header for RGB565', () => {
		const header = createBmpHeader(100, 50);

		// Check file type ('BM')
		expect(header[0]).toBe(0x42); // 'B'
		expect(header[1]).toBe(0x4d); // 'M'

		// Check file size
		const fileSize = header[2] | (header[3] << 8) | (header[4] << 16) | (header[5] << 24);
		const expectedSize = 14 + 40 + 12 + 204 * 50; // Header + DIB + masks + image data
		expect(fileSize).toBe(expectedSize);
	});

	it('should have correct DIB header size', () => {
		const header = createBmpHeader(100, 50);
		const dibSize = header[14] | (header[15] << 8) | (header[16] << 16) | (header[17] << 24);
		expect(dibSize).toBe(40); // BITMAPINFOHEADER
	});

	it('should have correct bit count', () => {
		const header = createBmpHeader(100, 50);
		const bitCount = header[28] | (header[29] << 8);
		expect(bitCount).toBe(16); // RGB565
	});
});

describe('sanitizeFilename', () => {
	it('should replace slashes with underscores', () => {
		expect(sanitizeFilename('path/to/file.bmp')).toBe('path_to_file.bmp');
		expect(sanitizeFilename('path\\to\\file.bmp')).toBe('path_to_file.bmp');
	});

	it('should replace invalid characters', () => {
		expect(sanitizeFilename('file<>name?.bmp')).toBe('file__name_.bmp');
	});

	it('should preserve valid characters', () => {
		expect(sanitizeFilename('file-name_v1.2 (3).bmp')).toBe('file-name_v1.2 (3).bmp');
	});

	it('should trim whitespace', () => {
		expect(sanitizeFilename('  file.bmp  ')).toBe('file.bmp');
	});
});

describe('isDataEmpty', () => {
	it('should return true for all zeros', () => {
		expect(isDataEmpty(new Uint8Array([0, 0, 0, 0]))).toBe(true);
	});

	it('should return true for all 0xFF', () => {
		expect(isDataEmpty(new Uint8Array([0xff, 0xff, 0xff]))).toBe(true);
	});

	it('should return false for mixed data', () => {
		expect(isDataEmpty(new Uint8Array([0, 1, 2, 3]))).toBe(false);
	});

	it('should return true for empty array', () => {
		expect(isDataEmpty(new Uint8Array(0))).toBe(true);
	});
});

describe('isDataValid', () => {
	it('should return false for empty data', () => {
		expect(isDataValid(new Uint8Array(0))).toBe(false);
	});

	it('should return false for uniform data', () => {
		expect(isDataValid(new Uint8Array([0, 0, 0]))).toBe(false);
		expect(isDataValid(new Uint8Array([0xff, 0xff, 0xff]))).toBe(false);
	});

	it('should return true for varied data', () => {
		expect(isDataValid(new Uint8Array([0, 1, 2, 3]))).toBe(true);
	});
});
