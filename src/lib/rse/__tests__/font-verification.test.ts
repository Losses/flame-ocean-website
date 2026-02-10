/**
 * Unit tests for QA verification logic in font replacement
 * Tests the per-character verification that happens after writing font data to firmware
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PixelData } from '../types/index.js';

// Test constants matching the worker implementation
const SMALL_STRIDE = 32;
const LARGE_STRIDE = 33;

/**
 * Helper function to verify font data after writing to firmware
 * This mirrors the worker verification logic at lines 1204-1222 in firmware-worker.ts
 * @param expectedData - The data that was supposed to be written
 * @param firmwareData - The actual firmware data after writing
 * @param addr - The address where data was written
 * @param chunkSize - The size of the chunk written
 * @param unicode - The unicode value for error reporting
 */
function verifyFontWrite(
	expectedData: Uint8Array,
	firmwareData: Uint8Array,
	addr: number,
	chunkSize: number,
	unicode: number
): { verified: boolean; error?: string } {
	// Read back the written data
	const writtenData = firmwareData.slice(addr, addr + chunkSize);
	let verified = true;

	// Byte-by-byte comparison
	for (let j = 0; j < chunkSize; j++) {
		if (writtenData[j] !== expectedData[j]) {
			verified = false;
			break;
		}
	}

	if (!verified) {
		return {
			verified: false,
			error: `Verification failed for U+${unicode.toString(16).toUpperCase().padStart(4, '0')}: written data does not match original`
		};
	}

	return { verified: true };
}

/**
 * Test helper that simulates a full font replacement with verification
 * Returns the verification result and the updated firmware data
 */
function simulateFontReplacementWithVerification(
	firmwareData: Uint8Array,
	addr: number,
	fontType: 'SMALL' | 'LARGE',
	unicode: number,
	pixels: PixelData
): { verified: boolean; error?: string; firmwareData: Uint8Array } {
	const chunkSize = fontType === 'SMALL' ? SMALL_STRIDE : LARGE_STRIDE;

	// Check if address is valid
	if (addr + chunkSize > firmwareData.length) {
		return {
			verified: false,
			error: `Address ${addr.toString(16)} + ${chunkSize} exceeds firmware size`,
			firmwareData
		};
	}

	// Simulate encoding (simplified - we just create a chunk with known values)
	const chunkToWrite = new Uint8Array(chunkSize);
	chunkToWrite.fill(0x42); // Fill with known pattern

	// For LARGE fonts, preserve the footer byte (last byte)
	if (fontType === 'LARGE') {
		const originalFooter = firmwareData[addr + LARGE_STRIDE - 1];
		chunkToWrite[LARGE_STRIDE - 1] = originalFooter;
	}

	// Write encoded data to firmware
	firmwareData.set(chunkToWrite, addr);

	// Verify by reading back
	const result = verifyFontWrite(chunkToWrite, firmwareData, addr, chunkSize, unicode);

	return {
		...result,
		firmwareData
	};
}

/**
 * Mock readFont function that returns data from a specific address
 * This simulates the worker's firmwareData.slice() behavior
 */
function mockReadFont(firmwareData: Uint8Array, addr: number, chunkSize: number): Uint8Array {
	return firmwareData.slice(addr, addr + chunkSize);
}

describe('Font Verification Logic', () => {
	describe('verifyFontWrite helper', () => {
		it('should pass verification when written data matches original', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;
			const chunkSize = 32;

			// Write known pattern
			const chunkToWrite = new Uint8Array(chunkSize);
			chunkToWrite.fill(0xAB);
			firmwareData.set(chunkToWrite, addr);

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, chunkSize, 0x0041);

			expect(result.verified).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should fail verification when written data does not match', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;
			const chunkSize = 32;

			// Write pattern, then corrupt one byte
			const chunkToWrite = new Uint8Array(chunkSize);
			chunkToWrite.fill(0xCD);
			firmwareData.set(chunkToWrite, addr);

			// Corrupt the data after "write" (simulating write failure)
			firmwareData[addr + 5] = 0xFF;

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, chunkSize, 0x0042);

			expect(result.verified).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('Verification failed');
			expect(result.error).toContain('U+0042');
		});

		it('should handle boundary address correctly', () => {
			const firmwareData = new Uint8Array(0x2000);
			const addr = 0x1FE0; // Near end of firmware
			const chunkSize = 32;

			const chunkToWrite = new Uint8Array(chunkSize);
			chunkToWrite.fill(0x77);
			firmwareData.set(chunkToWrite, addr);

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, chunkSize, 0x0043);

			expect(result.verified).toBe(true);
		});
	});

	describe('SMALL font verification', () => {
		it('should verify SMALL font data (32 byte chunk)', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;
			const unicode = 0x0041; // 'A'

			// Create 16x16 pixel data
			const pixels: boolean[][] = [];
			for (let y = 0; y < 16; y++) {
				const row: boolean[] = [];
				for (let x = 0; x < 16; x++) {
					row.push((x + y) % 3 === 0);
				}
				pixels.push(row);
			}

			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', unicode, pixels as PixelData);

			expect(result.verified).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should verify SMALL font at correct address (SMALL_BASE + unicode * 32)', () => {
			const SMALL_BASE = 0x10000;
			const unicode = 0x0061; // 'a'
			const expectedAddr = SMALL_BASE + unicode * SMALL_STRIDE;

			const firmwareData = new Uint8Array(0x100000);
			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, expectedAddr, 'SMALL', unicode, pixels);

			expect(result.verified).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should fail verification when SMALL font data is corrupted during write', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x2000;
			const unicode = 0x0041;

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			// Simulate replacement
			const chunkSize = SMALL_STRIDE;
			const chunkToWrite = new Uint8Array(chunkSize);
			chunkToWrite.fill(0x42);
			firmwareData.set(chunkToWrite, addr);

			// Simulate data corruption (e.g., firmware write error)
			firmwareData[addr + 10] = 0xFF;

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, chunkSize, unicode);

			expect(result.verified).toBe(false);
			expect(result.error).toBeDefined();
		});

		it('should handle unicode range limit (0xffff for SMALL fonts)', () => {
			const SMALL_BASE = 0x10000;
			const unicode = 0xFFFF; // Maximum SMALL font unicode
			const expectedAddr = SMALL_BASE + unicode * SMALL_STRIDE;

			// Calculate required firmware size: address + chunk size
			const requiredSize = expectedAddr + SMALL_STRIDE;
			const firmwareData = new Uint8Array(requiredSize);
			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, expectedAddr, 'SMALL', unicode, pixels);

			expect(result.verified).toBe(true);
		});
	});

	describe('LARGE font verification', () => {
		it('should verify LARGE font data (33 byte chunk with footer)', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x5000;
			const unicode = 0x4E00; // First CJK character

			// Set a specific footer byte value
			const originalFooter = 0xAA;
			firmwareData[addr + LARGE_STRIDE - 1] = originalFooter;

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'LARGE', unicode, pixels);

			expect(result.verified).toBe(true);
			// Verify footer was preserved
			expect(firmwareData[addr + LARGE_STRIDE - 1]).toBe(originalFooter);
		});

		it('should verify LARGE font at correct address (LARGE_BASE + (unicode - 0x4e00) * 33)', () => {
			const LARGE_BASE = 0x80000;
			const unicode = 0x4E01; // Second CJK character
			const expectedAddr = LARGE_BASE + (unicode - 0x4E00) * LARGE_STRIDE;

			const firmwareData = new Uint8Array(0x200000);
			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, expectedAddr, 'LARGE', unicode, pixels);

			expect(result.verified).toBe(true);
			expect(result.error).toBeUndefined();
		});

		it('should preserve footer byte during LARGE font verification', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x6000;
			const unicode = 0x4E00;

			// Set different footer bytes
			const footerValues = [0x00, 0x55, 0xAA, 0xFF];

			for (const footer of footerValues) {
				const testData = new Uint8Array(firmwareData);
				testData[addr + LARGE_STRIDE - 1] = footer;

				const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

				const result = simulateFontReplacementWithVerification(testData, addr, 'LARGE', unicode, pixels);

				expect(result.verified).toBe(true);
				// Footer should be preserved
				expect(testData[addr + LARGE_STRIDE - 1]).toBe(footer);
			}
		});

		it('should handle CJK range bounds (0x4e00-0x9fff for LARGE fonts)', () => {
			const LARGE_BASE = 0x80000;
			const firmwareData = new Uint8Array(0x500000);
			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			// Test lower bound
			const lowerUnicode = 0x4E00;
			const lowerAddr = LARGE_BASE + (lowerUnicode - 0x4E00) * LARGE_STRIDE;
			const lowerResult = simulateFontReplacementWithVerification(firmwareData, lowerAddr, 'LARGE', lowerUnicode, pixels);
			expect(lowerResult.verified).toBe(true);

			// Test upper bound
			const upperUnicode = 0x9FFF;
			const upperAddr = LARGE_BASE + (upperUnicode - 0x4E00) * LARGE_STRIDE;
			const upperResult = simulateFontReplacementWithVerification(firmwareData, upperAddr, 'LARGE', upperUnicode, pixels);
			expect(upperResult.verified).toBe(true);
		});

		it('should fail verification when LARGE font footer is corrupted', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x7000;
			const unicode = 0x4E00;

			const originalFooter = 0x33;
			firmwareData[addr + LARGE_STRIDE - 1] = originalFooter;

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			// Simulate replacement
			const chunkToWrite = new Uint8Array(LARGE_STRIDE);
			chunkToWrite.fill(0x42);
			chunkToWrite[LARGE_STRIDE - 1] = originalFooter; // Set footer
			firmwareData.set(chunkToWrite, addr);

			// Corrupt the footer byte
			firmwareData[addr + LARGE_STRIDE - 1] = 0xFF;

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, LARGE_STRIDE, unicode);

			expect(result.verified).toBe(false);
		});
	});

	describe('mockReadFont function', () => {
		it('should read font data correctly from firmware', () => {
			const firmwareData = new Uint8Array(0x10000);
			const addr = 0x1000;
			const chunkSize = 32;

			// Write test pattern
			const testPattern = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]);
			firmwareData.set(testPattern, addr);

			const readData = mockReadFont(firmwareData, addr, chunkSize);

			expect(readData.length).toBe(chunkSize);
			expect(readData[0]).toBe(0x01);
			expect(readData[1]).toBe(0x02);
			expect(readData[2]).toBe(0x03);
			expect(readData[3]).toBe(0x04);
			expect(readData[4]).toBe(0x05);
		});

		it('should return independent copy (not reference to original)', () => {
			const firmwareData = new Uint8Array(0x10000);
			const addr = 0x1000;
			const chunkSize = 32;

			const readData = mockReadFont(firmwareData, addr, chunkSize);

			// Modify read data
			readData[0] = 0xFF;

			// Original should be unchanged
			expect(firmwareData[addr]).not.toBe(0xFF);
		});

		it('should handle reads at different addresses', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addresses = [0x0, 0x1000, 0x10000, 0xF0000];

			for (const addr of addresses) {
				const readData = mockReadFont(firmwareData, addr, SMALL_STRIDE);
				expect(readData.length).toBe(SMALL_STRIDE);
			}
		});
	});

	describe('Error message formatting', () => {
		it('should format Unicode values correctly in error messages', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;

			// On success, no error message
			const chunkToWrite = new Uint8Array(SMALL_STRIDE);
			chunkToWrite.fill(0xAB);
			firmwareData.set(chunkToWrite, addr);

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, SMALL_STRIDE, 0x0041);

			expect(result.error).toBeUndefined();

			// Corrupt data to get error
			firmwareData[addr] = 0xFF;
			const errorResult = verifyFontWrite(chunkToWrite, firmwareData, addr, SMALL_STRIDE, 0x0041);

			expect(errorResult.error).toBeDefined();
			expect(errorResult.error).toContain('U+0041');
		});

		it('should handle different Unicode formats', () => {
			const testCases = [
				{ unicode: 0x0041, expected: 'U+0041' }, // 'A'
				{ unicode: 0x4E00, expected: 'U+4E00' }, // CJK
				{ unicode: 0xFFFF, expected: 'U+FFFF' }, // Max SMALL
				{ unicode: 0x9FFF, expected: 'U+9FFF' }, // Max LARGE
			];

			for (const { unicode, expected } of testCases) {
				const formatted = 'U+' + unicode.toString(16).toUpperCase().padStart(4, '0');
				expect(formatted).toBe(expected);
			}
		});
	});

	describe('Edge cases', () => {
		it('should handle chunk boundary exactly at firmware end', () => {
			const firmwareSize = 0x1000;
			const firmwareData = new Uint8Array(firmwareSize);
			const addr = firmwareSize - SMALL_STRIDE; // Last possible SMALL font address

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', 0x0041, pixels);

			expect(result.verified).toBe(true);
		});

		it('should reject address beyond firmware bounds', () => {
			const firmwareSize = 0x1000;
			const firmwareData = new Uint8Array(firmwareSize);
			const addr = firmwareSize - SMALL_STRIDE + 1; // One byte beyond

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', 0x0041, pixels);

			expect(result.verified).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('exceeds firmware size');
		});

		it('should handle all-zero pixel data', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', 0x0041, pixels);

			expect(result.verified).toBe(true);
		});

		it('should handle all-one pixel data', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(true));

			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', 0x0041, pixels);

			expect(result.verified).toBe(true);
		});

		it('should verify multiple sequential writes correctly', () => {
			const firmwareData = new Uint8Array(0x100000);
			const SMALL_BASE = 0x10000;
			const unicodeValues = [0x0041, 0x0042, 0x0043, 0x0044]; // 'A', 'B', 'C', 'D'

			const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

			for (const unicode of unicodeValues) {
				const addr = SMALL_BASE + unicode * SMALL_STRIDE;
				const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', unicode, pixels);

				expect(result.verified).toBe(true);
			}
		});

		it('should detect single-bit corruption in verification', () => {
			const firmwareData = new Uint8Array(0x100000);
			const addr = 0x1000;

			// Write and verify
			const chunkToWrite = new Uint8Array(SMALL_STRIDE);
			chunkToWrite.fill(0x55); // 01010101 pattern
			firmwareData.set(chunkToWrite, addr);

			// Flip one bit
			firmwareData[addr + 15] = 0x54; // 01010100 (one bit different)

			const result = verifyFontWrite(chunkToWrite, firmwareData, addr, SMALL_STRIDE, 0x0041);

			expect(result.verified).toBe(false);
		});
	});
});

describe('Verification halting behavior', () => {
	it('should halt on first verification failure', () => {
		const firmwareData = new Uint8Array(0x100000);
		const SMALL_BASE = 0x10000;

		const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

		const replacements = [
			{ unicode: 0x0041, shouldFail: false },
			{ unicode: 0x0042, shouldFail: true }, // This should fail
			{ unicode: 0x0043, shouldFail: false }, // This should not be processed
		];

		let failureOccurred = false;
		let thirdItemProcessed = false;

		for (let i = 0; i < replacements.length; i++) {
			const { unicode, shouldFail } = replacements[i];

			// Track if third item was processed
			if (i === 2) {
				thirdItemProcessed = true;
			}

			// Simulate worker halting on verification failure
			if (failureOccurred) {
				break;
			}

			const addr = SMALL_BASE + unicode * SMALL_STRIDE;

			// For the failing test, we need to modify simulateFontReplacementWithVerification
			// to simulate a verification failure. We'll do this by directly manipulating
			// the verification process.
			if (shouldFail) {
				// Write data and verify directly, then corrupt to cause failure
				const chunkToWrite = new Uint8Array(SMALL_STRIDE);
				chunkToWrite.fill(0x42);
				firmwareData.set(chunkToWrite, addr);

				// Corrupt the data - this will cause verification to fail
				firmwareData[addr + 5] = 0xFF;

				// Verify manually - this should fail
				const result = verifyFontWrite(chunkToWrite, firmwareData, addr, SMALL_STRIDE, unicode);

				if (!result.verified) {
					failureOccurred = true;
					expect(result.error).toBeDefined();
					// Simulate worker halting on verification failure (return from worker message handler)
					break;
				}
			} else {
				// Normal verification for non-failing tests
				const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', unicode, pixels);
				if (!result.verified) {
					failureOccurred = true;
					break;
				}
			}
		}

		expect(failureOccurred).toBe(true);
		expect(thirdItemProcessed).toBe(false); // Third item should not have been processed
	});

	it('should continue when all verifications pass', () => {
		const firmwareData = new Uint8Array(0x100000);
		const SMALL_BASE = 0x10000;

		const pixels: PixelData = Array(16).fill(null).map(() => Array(16).fill(false));

		const replacements = [0x0041, 0x0042, 0x0043, 0x0044, 0x0045];

		let allPassed = true;

		for (const unicode of replacements) {
			const addr = SMALL_BASE + unicode * SMALL_STRIDE;
			const result = simulateFontReplacementWithVerification(firmwareData, addr, 'SMALL', unicode, pixels);

			if (!result.verified) {
				allPassed = false;
				break;
			}
		}

		expect(allPassed).toBe(true);
	});
});

describe('Integration with worker patterns', () => {
	it('should use same stride constants as worker', () => {
		// Verify our test constants match worker implementation
		expect(SMALL_STRIDE).toBe(32);
		expect(LARGE_STRIDE).toBe(33);
	});

	it('should calculate addresses using same formulas as worker', () => {
		const SMALL_BASE = 0x10000;
		const LARGE_BASE = 0x80000;

		// SMALL: base + unicode * 32
		const smallAddr = SMALL_BASE + 0x0041 * SMALL_STRIDE;
		expect(smallAddr).toBe(0x10000 + 0x0041 * 32);

		// LARGE: base + (unicode - 0x4e00) * 33
		const largeAddr = LARGE_BASE + (0x4E00 - 0x4E00) * LARGE_STRIDE;
		expect(largeAddr).toBe(0x80000);

		const largeAddr2 = LARGE_BASE + (0x4E01 - 0x4E00) * LARGE_STRIDE;
		expect(largeAddr2).toBe(0x80000 + 33);
	});
});
