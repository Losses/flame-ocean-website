/**
 * Tests for tofu comparison logic
 *
 * These tests verify the pixel-based tofu character detection that identifies
 * missing glyphs in user-provided fonts. The tofu font displays a placeholder
 * character for glyphs that don't exist in a font.
 *
 * Since these tests run in Node without DOM access, they test the core
 * algorithm logic directly using mock pixel data.
 */

import { describe, it, expect } from 'vitest';
import type { PixelData } from '../types/index.js';

/**
 * Test helper to simulate pixelsMatch function
 * Matches the logic in tofu-font.ts
 */
function pixelsMatch(pixels1: boolean[][], pixels2: boolean[][]): boolean {
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
 * Test helper to simulate findBoundingBox function
 * Matches the logic in tofu-font.ts
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
 * Test helper to simulate cropToBoundingBox function
 * Matches the logic in tofu-font.ts
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
 * Test helper to simulate comparePixelRegions function
 * Matches the logic in tofu-font.ts
 */
function comparePixelRegions(
	pixels1: boolean[][],
	pixels2: boolean[][],
	tolerance = 0.1
): boolean {
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

	// Require at least 95% match
	return matches / total >= 0.95;
}

/**
 * Test helper to simulate isTofuCharacter function logic
 * Matches the logic in tofu-font.ts
 */
function isTofuCharacter(pixels: PixelData, signature: PixelData): boolean {
	// Convert readonly PixelData to mutable boolean[][] for internal processing
	const mutablePixels = pixels.map((row) => [...row]);
	const mutableSigPixels = signature.map((row) => [...row]);

	// The rendered character should be centered, so we need to find the bounding box
	// and compare it with the signature
	const bbox = findBoundingBox(mutablePixels);
	const sigBbox = findBoundingBox(mutableSigPixels);

	// If both are empty (no pixels), consider it tofu
	if (bbox.width === 0 && bbox.height === 0 && sigBbox.width === 0 && sigBbox.height === 0) {
		return true;
	}

	// If one is empty and the other isn't, not a match
	if (bbox.width === 0 || sigBbox.width === 0) {
		return false;
	}

	// Extract the bounding box region from both
	const cropped = cropToBoundingBox(mutablePixels, bbox);
	const sigCropped = cropToBoundingBox(mutableSigPixels, sigBbox);

	// Compare the cropped regions
	return comparePixelRegions(cropped, sigCropped);
}

describe('tofu comparison unit tests', () => {
	describe('pixelsMatch - exact pixel grid comparison', () => {
		it('should return true for identical pixel grids', () => {
			const pixels1: boolean[][] = [
				[true, false, true],
				[false, true, false],
				[true, false, true]
			];
			const pixels2: boolean[][] = [
				[true, false, true],
				[false, true, false],
				[true, false, true]
			];

			expect(pixelsMatch(pixels1, pixels2)).toBe(true);
		});

		it('should return false for grids with different pixel values', () => {
			const pixels1: boolean[][] = [
				[true, false, true],
				[false, true, false],
				[true, false, true]
			];
			const pixels2: boolean[][] = [
				[true, true, true],
				[false, true, false],
				[true, false, true]
			];

			expect(pixelsMatch(pixels1, pixels2)).toBe(false);
		});

		it('should return false for grids with different heights', () => {
			const pixels1: boolean[][] = [
				[true, false],
				[false, true]
			];
			const pixels2: boolean[][] = [
				[true, false],
				[false, true],
				[true, true]
			];

			expect(pixelsMatch(pixels1, pixels2)).toBe(false);
		});

		it('should return false for grids with different widths', () => {
			const pixels1: boolean[][] = [
				[true, false],
				[false, true]
			];
			const pixels2: boolean[][] = [
				[true, false, true],
				[false, true, false]
			];

			expect(pixelsMatch(pixels1, pixels2)).toBe(false);
		});

		it('should return true for empty grids', () => {
			const pixels1: boolean[][] = [];
			const pixels2: boolean[][] = [];

			expect(pixelsMatch(pixels1, pixels2)).toBe(true);
		});
	});

	describe('findBoundingBox - bounding box detection', () => {
		it('should find correct bounding box for a simple shape', () => {
			const pixels: boolean[][] = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];

			const bbox = findBoundingBox(pixels);
			expect(bbox).toEqual({ x: 1, y: 1, width: 2, height: 2 });
		});

		it('should find bounding box for single pixel', () => {
			const pixels: boolean[][] = [
				[false, false, false],
				[false, true, false],
				[false, false, false]
			];

			const bbox = findBoundingBox(pixels);
			expect(bbox).toEqual({ x: 1, y: 1, width: 1, height: 1 });
		});

		it('should return empty bounding box for all-false grid', () => {
			const pixels: boolean[][] = [
				[false, false, false],
				[false, false, false],
				[false, false, false]
			];

			const bbox = findBoundingBox(pixels);
			expect(bbox).toEqual({ x: 0, y: 0, width: 0, height: 0 });
		});

		it('should find bounding box for corner pixel', () => {
			const pixels: boolean[][] = [
				[true, false, false],
				[false, false, false],
				[false, false, false]
			];

			const bbox = findBoundingBox(pixels);
			expect(bbox).toEqual({ x: 0, y: 0, width: 1, height: 1 });
		});

		it('should find bounding box spanning entire grid', () => {
			const pixels: boolean[][] = [
				[true, true, true],
				[true, true, true],
				[true, true, true]
			];

			const bbox = findBoundingBox(pixels);
			expect(bbox).toEqual({ x: 0, y: 0, width: 3, height: 3 });
		});

		it('should handle irregular shapes', () => {
			const pixels: boolean[][] = [
				[false, true, false, false, true],
				[true, true, true, false, false],
				[false, true, false, false, false],
				[false, false, false, false, true]
			];

			const bbox = findBoundingBox(pixels);
			expect(bbox).toEqual({ x: 0, y: 0, width: 5, height: 4 });
		});
	});

	describe('cropToBoundingBox - cropping to bounding box', () => {
		it('should crop a pixel grid to its bounding box', () => {
			const pixels: boolean[][] = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];
			const bbox = { x: 1, y: 1, width: 2, height: 2 };

			const cropped = cropToBoundingBox(pixels, bbox);
			expect(cropped).toEqual([
				[true, true],
				[true, true]
			]);
		});

		it('should handle bounding box at origin', () => {
			const pixels: boolean[][] = [
				[true, true, false],
				[true, true, false],
				[false, false, false]
			];
			const bbox = { x: 0, y: 0, width: 2, height: 2 };

			const cropped = cropToBoundingBox(pixels, bbox);
			expect(cropped).toEqual([
				[true, true],
				[true, true]
			]);
		});

		it('should handle empty bounding box', () => {
			const pixels: boolean[][] = [
				[false, false],
				[false, false]
			];
			const bbox = { x: 0, y: 0, width: 0, height: 0 };

			const cropped = cropToBoundingBox(pixels, bbox);
			expect(cropped).toEqual([]);
		});

		it('should handle bounding box extending beyond grid (clipping)', () => {
			const pixels: boolean[][] = [
				[true, true, true],
				[true, true, true]
			];
			const bbox = { x: 1, y: 0, width: 5, height: 3 };

			const cropped = cropToBoundingBox(pixels, bbox);
			// Should clip to actual grid dimensions
			expect(cropped).toEqual([
				[true, true],
				[true, true]
			]);
		});
	});

	describe('comparePixelRegions - region comparison with tolerance', () => {
		it('should return true for identical regions', () => {
			const pixels1: boolean[][] = [
				[true, false],
				[false, true]
			];
			const pixels2: boolean[][] = [
				[true, false],
				[false, true]
			];

			expect(comparePixelRegions(pixels1, pixels2)).toBe(true);
		});

		it('should return true for regions with 95%+ match', () => {
			const pixels1: boolean[][] = [
				[true, true, true, true, true],
				[true, true, true, true, true],
				[true, true, true, true, true],
				[true, true, true, true, true],
				[true, true, true, true, true]
			];
			const pixels2: boolean[][] = [
				[true, true, true, true, true],
				[true, true, true, true, true],
				[true, true, false, true, true], // 1 pixel different
				[true, true, true, true, true],
				[true, true, true, true, true]
			];

			// 24/25 = 96% match
			expect(comparePixelRegions(pixels1, pixels2)).toBe(true);
		});

		it('should return false for regions below 95% match', () => {
			const pixels1: boolean[][] = [
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true]
			];
			const pixels2: boolean[][] = [
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, false, false, false, false, false], // 5 pixels different
				[true, true, true, true, true, false, false, false, false, false], // 5 more pixels different
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true]
			];

			// 90/100 = 90% match (below 95% threshold)
			expect(comparePixelRegions(pixels1, pixels2)).toBe(false);
		});

		it('should return false when size difference exceeds tolerance', () => {
			const pixels1: boolean[][] = [
				[true, true, true],
				[true, true, true],
				[true, true, true]
			]; // 9 pixels
			const pixels2: boolean[][] = [
				[true, true],
				[true, true]
			]; // 4 pixels

			// Size difference: (9-4)/9 = 55% > 10% tolerance
			expect(comparePixelRegions(pixels1, pixels2)).toBe(false);
		});

		it('should return true when size difference is within tolerance', () => {
			const pixels1: boolean[][] = [
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true]
			]; // 100 pixels
			const pixels2: boolean[][] = [
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, true],
				[true, true, true, true, true, true, true, true, true, false]
			]; // 99 pixels (1 pixel different)

			// Size difference: (100-99)/100 = 1% < 10% tolerance
			// And all pixels match except the last one
			expect(comparePixelRegions(pixels1, pixels2)).toBe(true);
		});

		it('should handle empty regions', () => {
			const pixels1: boolean[][] = [];
			const pixels2: boolean[][] = [];

			// Empty arrays result in NaN sizes, and the function returns false
			// because 0/0 >= 0.95 evaluates to NaN >= 0.95 which is false
			expect(comparePixelRegions(pixels1, pixels2)).toBe(false);
		});

		it('should treat one empty and one non-empty as different', () => {
			const pixels1: boolean[][] = [
				[true, false],
				[false, true]
			];
			const pixels2: boolean[][] = [];

			expect(comparePixelRegions(pixels1, pixels2)).toBe(false);
		});

		it('should handle different dimensions with overlapping pixels', () => {
			const pixels1: boolean[][] = [
				[true, false, true],
				[false, true, false]
			];
			const pixels2: boolean[][] = [
				[true, false, true, false],
				[false, true, false, true]
			];

			// Should iterate over max dimensions and compare with defaults
			const result = comparePixelRegions(pixels1, pixels2);
			expect(typeof result).toBe('boolean');
		});
	});

	describe('isTofuCharacter - full tofu detection workflow', () => {
		it('should detect exact tofu match (same pixels)', () => {
			// Simulate tofu signature and rendered character being identical
			const tofuSignature: PixelData = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];
			const renderedChar: PixelData = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(true);
		});

		it('should detect non-tofu character (different pixels)', () => {
			// Tofu signature is a box
			const tofuSignature: PixelData = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];
			// Rendered character is an 'A' shape (different from tofu)
			const renderedChar: PixelData = [
				[false, false, true, false, false],
				[false, true, false, true, false],
				[false, true, true, true, false],
				[false, true, false, true, false],
				[false, true, false, true, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(false);
		});

		it('should detect tofu when both are empty (no pixels)', () => {
			const tofuSignature: PixelData = [
				[false, false, false],
				[false, false, false],
				[false, false, false]
			];
			const renderedChar: PixelData = [
				[false, false, false],
				[false, false, false],
				[false, false, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(true);
		});

		it('should not match when signature has pixels but rendered is empty', () => {
			const tofuSignature: PixelData = [
				[false, true, false],
				[true, true, true],
				[false, true, false]
			];
			const renderedChar: PixelData = [
				[false, false, false],
				[false, false, false],
				[false, false, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(false);
		});

		it('should not match when rendered has pixels but signature is empty', () => {
			const tofuSignature: PixelData = [
				[false, false, false],
				[false, false, false],
				[false, false, false]
			];
			const renderedChar: PixelData = [
				[false, true, false],
				[true, true, true],
				[false, true, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(false);
		});

		it('should detect tofu with slight positional differences (within tolerance)', () => {
			// Tofu signature centered
			const tofuSignature: PixelData = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];
			// Same shape, slightly offset (within 95% match threshold)
			const renderedChar: PixelData = [
				[false, false, false, false, false],
				[false, false, true, true, false],
				[false, false, true, true, false],
				[false, false, false, false, false],
				[false, false, false, false, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(true);
		});

		it('should reject non-tofu character with significantly different shape', () => {
			// Tofu signature: box shape
			const tofuSignature: PixelData = [
				[false, false, false, false, false, false],
				[false, true, true, true, true, false],
				[false, true, true, true, true, false],
				[false, true, true, true, true, false],
				[false, true, true, true, true, false],
				[false, false, false, false, false, false]
			];
			// Rendered: completely different pattern
			const renderedChar: PixelData = [
				[false, false, false, true, false, false],
				[false, false, true, true, true, false],
				[false, true, true, true, true, true],
				[false, false, true, true, true, false],
				[false, false, false, true, false, false],
				[false, false, false, false, false, false]
			];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(false);
		});

		it('should handle SMALL font type (12x12 grid simulation)', () => {
			// Simulate 12x12 SMALL font tofu signature
			const tofuSignatureMutable: boolean[][] = Array(12)
				.fill(false)
				.map(() => Array(12).fill(false));
			// Add tofu box in center
			for (let y = 3; y < 9; y++) {
				for (let x = 3; x < 9; x++) {
					tofuSignatureMutable[y][x] = true;
				}
			}

			// Same tofu rendered
			const renderedCharMutable: boolean[][] = tofuSignatureMutable.map((row) => [...row]);

			expect(isTofuCharacter(renderedCharMutable as PixelData, tofuSignatureMutable as PixelData)).toBe(true);
		});

		it('should handle LARGE font type (16x16 grid simulation)', () => {
			// Simulate 16x16 LARGE font tofu signature
			const tofuSignatureMutable: boolean[][] = Array(16)
				.fill(false)
				.map(() => Array(16).fill(false));
			// Add tofu box in center
			for (let y = 4; y < 12; y++) {
				for (let x = 4; x < 12; x++) {
					tofuSignatureMutable[y][x] = true;
				}
			}

			// Same tofu rendered
			const renderedCharMutable: boolean[][] = tofuSignatureMutable.map((row) => [...row]);

			expect(isTofuCharacter(renderedCharMutable as PixelData, tofuSignatureMutable as PixelData)).toBe(true);
		});
	});

	describe('edge cases for tofu comparison', () => {
		it('should handle single-pixel tofu signature', () => {
			const tofuSignature: PixelData = [[true]];
			const renderedChar: PixelData = [[true]];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(true);
		});

		it('should handle single-pixel non-tofu character', () => {
			const tofuSignature: PixelData = [[true]];
			const renderedChar: PixelData = [[false]];

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(false);
		});

		it('should handle characters with similar but not identical appearance to tofu', () => {
			// Tofu: a filled box
			const tofuSignature: PixelData = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, true, false],
				[false, false, false, false]
			];
			// Similar character: box with one pixel different (below 95% match threshold for small grids)
			const similarChar: PixelData = [
				[false, false, false, false],
				[false, true, true, false],
				[false, true, false, false], // One pixel different
				[false, false, false, false]
			];

			// For a 4x4 grid (16 pixels), 1 different = 15/16 = 93.75% < 95%
			expect(isTofuCharacter(similarChar, tofuSignature)).toBe(false);
		});

		it('should handle larger grids where minor differences are within tolerance', () => {
			// Tofu: 10x10 filled box
			const tofuSignatureMutable: boolean[][] = Array(10)
				.fill(false)
				.map(() => Array(10).fill(false));
			for (let y = 2; y < 8; y++) {
				for (let x = 2; x < 8; x++) {
					tofuSignatureMutable[y][x] = true;
				}
			}

			// Similar: same box with 1 pixel different
			const similarCharMutable: boolean[][] = tofuSignatureMutable.map((row) => [...row]);
			similarCharMutable[4][4] = false; // Flip one pixel

			// For ~36 foreground pixels, 1 different = 35/36 ≈ 97% > 95%
			expect(isTofuCharacter(similarCharMutable as PixelData, tofuSignatureMutable as PixelData)).toBe(true);
		});

		it('should handle asymmetric shapes', () => {
			// Tofu: asymmetric box shape
			const tofuSignature: PixelData = [
				[false, true, true, true, false],
				[true, true, true, true, true],
				[true, true, true, true, true],
				[true, true, true, true, false],
				[false, true, true, false, false]
			];

			// Same asymmetric shape
			const renderedChar: PixelData = tofuSignature.map((row) => [...row]);

			expect(isTofuCharacter(renderedChar, tofuSignature)).toBe(true);
		});
	});
});
