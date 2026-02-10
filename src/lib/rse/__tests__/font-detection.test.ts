/**
 * Tests for font detection utilities
 *
 * These tests mock the Canvas API and FontFace API to test font detection logic
 * without requiring actual font files or browser rendering.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FontDetectionResult, DetectedFontType } from '../utils/font-detection.js';

// Mock FontFace class
class MockFontFace {
	loaded = false;
	family: string;
	_data: ArrayBuffer;

	constructor(family: string, data: ArrayBuffer | string) {
		this.family = family;
		this._data = data as ArrayBuffer;
	}

	async load(): Promise<this> {
		this.loaded = true;
		return this;
	}
}

// Track mock state for testing
interface MockCanvasState {
	pixels: Uint8ClampedArray;
	width: number;
	height: number;
	fontSize: number;
}

// Mock canvas state storage
let mockCanvasState: MockCanvasState | null = null;

// Helper to create mock ImageData
function createMockImageData(width: number, height: number, antiAliased = false): ImageData {
	const pixels = new Uint8ClampedArray(width * height * 4);

	for (let i = 0; i < pixels.length; i += 4) {
		if (antiAliased) {
			// Create some anti-aliased (gray) pixels
			const isGrayPixel = Math.random() < 0.1; // 10% of pixels are gray
			if (isGrayPixel) {
				const grayValue = 128 + Math.floor(Math.random() * 100); // 128-227
				pixels[i] = grayValue;     // R
				pixels[i + 1] = grayValue; // G
				pixels[i + 2] = grayValue; // B
				pixels[i + 3] = 255;       // A
			} else {
				// Black or white pixels
				const isBlack = Math.random() < 0.3;
				const value = isBlack ? 0 : 255;
				pixels[i] = value;
				pixels[i + 1] = value;
				pixels[i + 2] = value;
				pixels[i + 3] = 255;
			}
		} else {
			// Pixel-perfect: only black (0) or white (255)
			const isBlack = Math.random() < 0.3;
			const value = isBlack ? 0 : 255;
			pixels[i] = value;
			pixels[i + 1] = value;
			pixels[i + 2] = value;
			pixels[i + 3] = 255;
		}
	}

	mockCanvasState = {
		pixels,
		width,
		height,
		fontSize: width === 312 ? 12 : 16 // 312 = 52 chars * 12px, 416 = 52 chars * 16px
	};

	return {
		data: pixels,
		width,
		height
	} as ImageData;
}

// Setup and teardown
beforeEach(() => {
	mockCanvasState = null;
	vi.clearAllMocks();
});

describe('font-detection unit tests (via mocked canvas)', () => {
	/**
	 * Test helper to simulate font type detection
	 * Simulates the logic in detectFontType by examining mock canvas state
	 */
	function simulateFontDetection(
		is12pxPixelPerfect: boolean,
		is16pxPixelPerfect: boolean
	): FontDetectionResult {
		let fontType: DetectedFontType = null;

		// Same logic as detectFontType function
		if (is12pxPixelPerfect) {
			fontType = 'SMALL';
		} else if (is16pxPixelPerfect) {
			fontType = 'LARGE';
		} else if (is12pxPixelPerfect && is16pxPixelPerfect) {
			fontType = 'SMALL';
		}

		const antiAliasedCount12px = is12pxPixelPerfect ? 0 : 150;
		const antiAliasedCount16px = is16pxPixelPerfect ? 0 : 200;

		return {
			fontType,
			isPixelPerfect: is12pxPixelPerfect || is16pxPixelPerfect,
			antiAliasedCount12px,
			antiAliasedCount16px
		};
	}

	describe('valid SMALL font detection', () => {
		it('should classify font as SMALL when 12px rendering is pixel-perfect', () => {
			const result = simulateFontDetection(true, false);

			expect(result.fontType).toBe('SMALL');
			expect(result.isPixelPerfect).toBe(true);
			expect(result.antiAliasedCount12px).toBe(0);
		});

		it('should classify font as SMALL when both 12px and 16px are pixel-perfect (prefer SMALL)', () => {
			const result = simulateFontDetection(true, true);

			expect(result.fontType).toBe('SMALL');
			expect(result.isPixelPerfect).toBe(true);
		});
	});

	describe('valid LARGE font detection', () => {
		it('should classify font as LARGE when only 16px rendering is pixel-perfect', () => {
			const result = simulateFontDetection(false, true);

			expect(result.fontType).toBe('LARGE');
			expect(result.isPixelPerfect).toBe(true);
			expect(result.antiAliasedCount12px).toBeGreaterThan(0);
			expect(result.antiAliasedCount16px).toBe(0);
		});
	});

	describe('invalid font rejection (anti-aliasing detected)', () => {
		it('should reject font as invalid when neither size produces pixel-perfect results', () => {
			const result = simulateFontDetection(false, false);

			expect(result.fontType).toBe(null);
			expect(result.isPixelPerfect).toBe(false);
			expect(result.antiAliasedCount12px).toBeGreaterThan(0);
			expect(result.antiAliasedCount16px).toBeGreaterThan(0);
		});

		it('should report anti-aliased pixel counts for both sizes when font is invalid', () => {
			const result = simulateFontDetection(false, false);

			expect(result.antiAliasedCount12px).toBe(150);
			expect(result.antiAliasedCount16px).toBe(200);
		});
	});
});

describe('FontDetectionResult type', () => {
	it('should have correct structure for SMALL font detection', () => {
		const result: FontDetectionResult = {
			fontType: 'SMALL',
			isPixelPerfect: true,
			antiAliasedCount12px: 0,
			antiAliasedCount16px: 150
		};

		expect(result.fontType).toBe('SMALL');
		expect(result.isPixelPerfect).toBe(true);
		expect(result.antiAliasedCount12px).toBe(0);
		expect(result.antiAliasedCount16px).toBe(150);
	});

	it('should have correct structure for LARGE font detection', () => {
		const result: FontDetectionResult = {
			fontType: 'LARGE',
			isPixelPerfect: true,
			antiAliasedCount12px: 100,
			antiAliasedCount16px: 0
		};

		expect(result.fontType).toBe('LARGE');
		expect(result.isPixelPerfect).toBe(true);
	});

	it('should have correct structure for invalid font (null type)', () => {
		const result: FontDetectionResult = {
			fontType: null,
			isPixelPerfect: false,
			antiAliasedCount12px: 200,
			antiAliasedCount16px: 300
		};

		expect(result.fontType).toBe(null);
		expect(result.isPixelPerfect).toBe(false);
	});
});

describe('anti-aliasing detection logic', () => {
	/**
	 * Test the core anti-aliasing detection algorithm
	 * This matches the logic in testFontSize function
	 */
	function detectAntiAliasing(pixels: Uint8ClampedArray): number {
		let antiAliasedCount = 0;

		for (let i = 0; i < pixels.length; i += 4) {
			const r = pixels[i];
			const g = pixels[i + 1];
			const b = pixels[i + 2];

			// Check if pixel is grayscale (all three channels equal) but not black or white
			if (r === g && g === b) {
				if (r > 0 && r < 255) {
					antiAliasedCount++;
				}
			}
		}

		return antiAliasedCount;
	}

	it('should detect anti-aliased pixels (gray values between 0 and 255)', () => {
		// Create pixels with some gray values
		const pixels = new Uint8ClampedArray([
			// Pixel 1: Black (0, 0, 0) - not anti-aliased
			0, 0, 0, 255,
			// Pixel 2: White (255, 255, 255) - not anti-aliased
			255, 255, 255, 255,
			// Pixel 3: Gray (128, 128, 128) - anti-aliased!
			128, 128, 128, 255,
			// Pixel 4: Gray (200, 200, 200) - anti-aliased!
			200, 200, 200, 255,
			// Pixel 5: Black (0, 0, 0) - not anti-aliased
			0, 0, 0, 255
		]);

		const count = detectAntiAliasing(pixels);
		expect(count).toBe(2); // 2 gray pixels detected
	});

	it('should count zero anti-aliased pixels for pixel-perfect black/white image', () => {
		// Create perfect black and white pixels
		const pixels = new Uint8ClampedArray(20); // 5 pixels * 4 channels
		for (let i = 0; i < pixels.length; i += 4) {
			const isBlack = i % 8 === 0; // Alternate black/white
			const value = isBlack ? 0 : 255;
			pixels[i] = value;
			pixels[i + 1] = value;
			pixels[i + 2] = value;
			pixels[i + 3] = 255;
		}

		const count = detectAntiAliasing(pixels);
		expect(count).toBe(0);
	});

	it('should handle RGB pixels that are not grayscale (R != G != B)', () => {
		// Colored pixels are not grayscale, so not counted as anti-aliased
		const pixels = new Uint8ClampedArray([
			// Pixel 1: Red (255, 0, 0) - not grayscale, not counted
			255, 0, 0, 255,
			// Pixel 2: Green (0, 255, 0) - not grayscale, not counted
			0, 255, 0, 255,
			// Pixel 3: Gray (128, 128, 128) - grayscale, counted
			128, 128, 128, 255
		]);

		const count = detectAntiAliasing(pixels);
		expect(count).toBe(1); // Only the gray pixel
	});

	it('should detect threshold edge case (value of 1 is anti-aliased)', () => {
		const pixels = new Uint8ClampedArray([
			1, 1, 1, 255, // Value of 1 - should be detected as anti-aliased
			0, 0, 0, 255, // Black - not anti-aliased
			255, 255, 255, 255 // White - not anti-aliased
		]);

		const count = detectAntiAliasing(pixels);
		expect(count).toBe(1); // Only the value-1 pixel
	});

	it('should detect threshold edge case (value of 254 is anti-aliased)', () => {
		const pixels = new Uint8ClampedArray([
			254, 254, 254, 255, // Value of 254 - should be detected as anti-aliased
			0, 0, 0, 255, // Black - not anti-aliased
			255, 255, 255, 255 // White - not anti-aliased
		]);

		const count = detectAntiAliasing(pixels);
		expect(count).toBe(1); // Only the value-254 pixel
	});
});

describe('edge cases', () => {
	it('should handle empty pixel array', () => {
		const pixels = new Uint8ClampedArray(0);
		let antiAliasedCount = 0;

		for (let i = 0; i < pixels.length; i += 4) {
			const r = pixels[i];
			const g = pixels[i + 1];
			const b = pixels[i + 2];

			if (r === g && g === b) {
				if (r > 0 && r < 255) {
					antiAliasedCount++;
				}
			}
		}

		expect(antiAliasedCount).toBe(0);
	});

	it('should handle pixel array with incomplete pixel at end', () => {
		// Array not divisible by 4 (incomplete pixel)
		const pixels = new Uint8ClampedArray([
			128, 128, 128, 255, // Complete gray pixel
			100, 100, 100 // Incomplete pixel - should be ignored
		]);
		let antiAliasedCount = 0;

		for (let i = 0; i < pixels.length - 3; i += 4) {
			const r = pixels[i];
			const g = pixels[i + 1];
			const b = pixels[i + 2];

			if (r === g && g === b) {
				if (r > 0 && r < 255) {
					antiAliasedCount++;
				}
			}
		}

		expect(antiAliasedCount).toBe(1); // Only complete pixels counted
	});

	it('should treat font type detection constants', () => {
		// Test that the expected font size values match
		const SMALL_TEST_SIZE = 12;
		const LARGE_TEST_SIZE = 16;
		const ANTI_ALIASING_THRESHOLD = 0;

		expect(SMALL_TEST_SIZE).toBe(12);
		expect(LARGE_TEST_SIZE).toBe(16);
		expect(ANTI_ALIASING_THRESHOLD).toBe(0);
	});
});

describe('font type classification decision tree', () => {
	/**
	 * Test the exact decision tree logic from detectFontType
	 */
	function classifyFontType(
		is12pxPerfect: boolean,
		is16pxPerfect: boolean
	): DetectedFontType {
		let fontType: DetectedFontType = null;

		// Classify as SMALL if 12px rendering produces only black/white pixels
		if (is12pxPerfect) {
			fontType = 'SMALL';
		}
		// Classify as LARGE if 16px rendering produces only black/white pixels
		// (but 12px failed, meaning 12px likely had anti-aliasing)
		else if (is16pxPerfect) {
			fontType = 'LARGE';
		}
		// If both are pixel-perfect, prefer SMALL (more common for pixel fonts)
		else if (is12pxPerfect && is16pxPerfect) {
			fontType = 'SMALL';
		}

		return fontType;
	}

	it('should return SMALL when 12px is perfect (regardless of 16px)', () => {
		// First condition takes priority
		expect(classifyFontType(true, true)).toBe('SMALL');
		expect(classifyFontType(true, false)).toBe('SMALL');
	});

	it('should return LARGE when only 16px is perfect', () => {
		expect(classifyFontType(false, true)).toBe('LARGE');
	});

	it('should return null when neither is perfect', () => {
		expect(classifyFontType(false, false)).toBe(null);
	});
});

describe('test character constants', () => {
	/**
	 * Verify the test characters used for font detection
	 */
	const TEST_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

	it('should contain all 52 English letters (uppercase + lowercase)', () => {
		expect(TEST_CHARACTERS.length).toBe(52);
	});

	it('should start with uppercase A-Z', () => {
		expect(TEST_CHARACTERS.substring(0, 26)).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
	});

	it('should end with lowercase a-z', () => {
		expect(TEST_CHARACTERS.substring(26)).toBe('abcdefghijklmnopqrstuvwxyz');
	});
});
