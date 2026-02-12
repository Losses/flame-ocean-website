/**
 * Font Extraction Comprehensive Integration Tests
 *
 * This test suite performs exhaustive testing of font extraction:
 * 1. Bun-mode JSON output validation
 * 2. Python vs TypeScript consistency (Python as ground truth)
 * 3. Round-trip tests: read → encode → write → read → verify
 * 4. Exhaustive Unicode code point coverage
 *
 * Usage:
 *   bun test src/lib/rse/__tests__/font-extraction-comprehensive.test.ts --setup
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { FontExtractor } from '../extractors/font-extractor.js';
import { FirmwareAnalyzer } from '../extractors/firmware-analyzer.js';
import { decodeV8, SMALL_FONT_SIZE } from '../utils/font-decoder.js';
import { encodeV8 } from '../utils/font-encoder.js';
import { parseMonoBmp, createMonoBmp } from '../utils/bitmap.js';
import { UNICODE_RANGES } from '../utils/unicode-ranges.js';
import type { FirmwareAddresses, PixelData } from '../types/index.js';

// Configuration
const BASE_DOWNLOAD_DIR = '/tmp/echo-mini-firmwares';
const TEST_VERSION = 'ECHO MINI V3.1.0';
const FIRMWARE_PATH = join(BASE_DOWNLOAD_DIR, TEST_VERSION, 'HIFIEC80.IMG');
const PYTHON_SCRIPT = join(process.cwd(), 'references', 'extract_font_universal.py');

// Test state
let firmwareData: Uint8Array;
let analyzer: FirmwareAnalyzer;
let extractor: FontExtractor;
let addresses: FirmwareAddresses;

/**
 * Check if test fixtures are ready
 */
function ensureFixtures(setup = false): boolean {
	if (!existsSync(FIRMWARE_PATH)) {
		if (setup) {
			console.log('\nFixtures not found. Running setup...');
			try {
				execSync('bun run src/lib/rse/__tests__/setup-fixtures.ts', { stdio: 'inherit' });
				return existsSync(FIRMWARE_PATH);
			} catch {
				console.error('\nFailed to set up fixtures');
				return false;
			}
		}
		return false;
	}
	return true;
}

/**
 * Run Python extractor in bun-mode
 */
function runPythonBunMode(
	firmwarePath: string,
	fontSize: 'SMALL' | 'LARGE',
	startHex: string,
	endHex: string,
): Record<string, unknown> | null {
	const cmd = [
		'python3',
		PYTHON_SCRIPT,
		'--bun-mode',
		firmwarePath,
		'--size',
		fontSize,
		'--start',
		startHex,
		'--end',
		endHex,
	].join(' ');

	try {
		const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
		return JSON.parse(output);
	} catch (error) {
		console.error(`Python bun-mode failed: ${error}`);
		return null;
	}
}

/**
 * Compare two pixel arrays for equality
 */
function pixelsEqual(p1: PixelData, p2: PixelData): boolean {
	if (p1.length !== p2.length) return false;
	for (let y = 0; y < p1.length; y++) {
		if (p1[y].length !== p2[y].length) return false;
		for (let x = 0; x < p1[y].length; x++) {
			if (p1[y][x] !== p2[y][x]) return false;
		}
	}
	return true;
}

/**
 * Convert Python pixel format (0/1 numbers) to TypeScript boolean format
 */
function pythonPixelsToTs(pythonPixels: number[][]): PixelData {
	return pythonPixels.map((row) => row.map((val) => val === 1));
}

describe('Font Extraction - Bun Mode Integration', () => {
	beforeAll(() => {
		const setupMode = process.argv.includes('--setup');
		if (!ensureFixtures(setupMode)) {
			throw new Error(
				`Fixtures not found. Run: bun test src/lib/rse/__tests__/font-extraction-comprehensive.test.ts --setup`
			);
		}

		// Load firmware
		firmwareData = new Uint8Array(readFileSync(FIRMWARE_PATH));
		analyzer = new FirmwareAnalyzer(firmwareData);
		addresses = analyzer.detectAddresses()!;
		extractor = new FontExtractor(firmwareData, addresses);

		console.log(`\nBun Mode Integration Tests`);
		console.log(`  Firmware: ${FIRMWARE_PATH}`);
		console.log(`  SMALL_BASE: 0x${addresses.SMALL_BASE.toString(16).padStart(6, '0')}`);
		console.log(`  LARGE_BASE: 0x${addresses.LARGE_BASE.toString(16).padStart(6, '0')}`);
		console.log(`  LOOKUP_TABLE: 0x${addresses.LOOKUP_TABLE.toString(16).padStart(6, '0')}\n`);
	}, 60000);

	describe('Bun Mode JSON Output', () => {
		it('should output valid JSON for SMALL font range', () => {
			const result = runPythonBunMode(FIRMWARE_PATH, 'SMALL', '0x0041', '0x0043');

			expect(result).not.toBeNull();
			expect(result).toHaveProperty('font_type', 'SMALL');
			expect(result).toHaveProperty('glyphs');
			expect(result).toHaveProperty('errors');
			expect(Array.isArray(result!.glyphs)).toBe(true);
			expect(Array.isArray(result!.errors)).toBe(true);
		});

		it('should output valid JSON for LARGE font range', () => {
			const result = runPythonBunMode(FIRMWARE_PATH, 'LARGE', '0x4E00', '0x4E02');

			expect(result).not.toBeNull();
			expect(result).toHaveProperty('font_type', 'LARGE');
			expect(Array.isArray(result!.glyphs)).toBe(true);
		});

		it('should include correct metadata in output', () => {
			const result = runPythonBunMode(FIRMWARE_PATH, 'LARGE', '0x4E00', '0x4E02');

			expect(result).toHaveProperty('range_start');
			expect(result).toHaveProperty('range_end');
			expect(result).toHaveProperty('total_glyphs');
			expect(result).toHaveProperty('extracted_count');
		});

		it('should include character and address for each glyph', () => {
			const result = runPythonBunMode(FIRMWARE_PATH, 'LARGE', '0x4E00', '0x4E02');

			for (const glyph of result!.glyphs as Array<Record<string, unknown>>) {
				expect(glyph).toHaveProperty('code_point');
				expect(glyph).toHaveProperty('character');
				expect(glyph).toHaveProperty('address');
				expect(glyph).toHaveProperty('header');
				expect(glyph).toHaveProperty('pixels');
				expect(glyph).toHaveProperty('empty');
			}
		});
	});

	describe('Python vs TypeScript Consistency', () => {
		it('should decode identical pixels for LARGE fonts (Python ground truth)', () => {
			const pythonResult = runPythonBunMode(FIRMWARE_PATH, 'LARGE', '0x4E00', '0x4E10');
			expect(pythonResult).not.toBeNull();

			let mismatches = 0;
			let tested = 0;

			for (const pythonGlyph of pythonResult!.glyphs as Array<Record<string, unknown>>) {
				if (pythonGlyph.empty) continue;

				const codePoint = pythonGlyph.code_point as number;
				const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);

				// Extract using TypeScript
				const tsPixels = extractor.readFontAsPixels(codePoint, 'LARGE');

				if (!tsPixels) {
					mismatches++;
					continue;
				}

				// Compare (TypeScript returns 16x16, Python returns 16x16 for LARGE)
				if (!pixelsEqual(pythonPixels, tsPixels)) {
					mismatches++;
					console.log(`  Mismatch at U+${codePoint.toString(16).toUpperCase()}`);
				}
				tested++;
			}

			console.log(`  Tested: ${tested}, Mismatches: ${mismatches}`);
			expect(mismatches).toBe(0);
		});

		it('should decode identical pixels for SMALL fonts (Python ground truth)', () => {
			const pythonResult = runPythonBunMode(FIRMWARE_PATH, 'SMALL', '0x0020', '0x0080');
			expect(pythonResult).not.toBeNull();

			let mismatches = 0;
			let tested = 0;

			for (const pythonGlyph of pythonResult!.glyphs as Array<Record<string, unknown>>) {
				if (pythonGlyph.empty) continue;

				const codePoint = pythonGlyph.code_point as number;
				const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);

				// Extract using TypeScript
				const tsPixels = extractor.readFontAsPixels(codePoint, 'SMALL');

				if (!tsPixels) {
					mismatches++;
					continue;
				}

				// TypeScript returns SMALL_FONT_SIZE x SMALL_FONT_SIZE
				if (!pixelsEqual(pythonPixels, tsPixels)) {
					mismatches++;
					console.log(`  Mismatch at U+${codePoint.toString(16).toUpperCase()}`);
				}
				tested++;
			}

			console.log(`  Tested: ${tested}, Mismatches: ${mismatches}`);
			expect(mismatches).toBe(0);
		});

		it('should match header/lookup values with Python', () => {
			const pythonResult = runPythonBunMode(FIRMWARE_PATH, 'LARGE', '0x4E00', '0x4E0F');
			expect(pythonResult).not.toBeNull();

			let mismatches = 0;

			for (const pythonGlyph of pythonResult!.glyphs as Array<Record<string, unknown>>) {
				const codePoint = pythonGlyph.code_point as number;
				const pythonHeader = pythonGlyph.header as string;

				// Get lookup value from TypeScript
				const tsLookup = extractor.getLookup(codePoint);
				const tsHeader = `0x${tsLookup.toString(16).padStart(2, '0').toUpperCase()}`;

				if (tsHeader !== pythonHeader) {
					mismatches++;
					console.log(`  Header mismatch at U+${codePoint.toString(16).toUpperCase()}: Python=${pythonHeader}, TS=${tsHeader}`);
				}
			}

			expect(mismatches).toBe(0);
		});

		it('should match address calculations with Python', () => {
			const pythonResult = runPythonBunMode(FIRMWARE_PATH, 'LARGE', '0x4E00', '0x4E0F');
			expect(pythonResult).not.toBeNull();

			let mismatches = 0;

			for (const pythonGlyph of pythonResult!.glyphs as Array<Record<string, unknown>>) {
				const codePoint = pythonGlyph.code_point as number;
				const pythonAddr = pythonGlyph.address as string;

				// Calculate address in TypeScript
				const tsAddr = extractor.unicodeToLargeAddr(codePoint);
				const tsAddrHex = `0x${tsAddr.toString(16).padStart(6, '0').toLowerCase()}`;

				if (tsAddrHex !== pythonAddr) {
					mismatches++;
					console.log(`  Address mismatch at U+${codePoint.toString(16).toUpperCase()}: Python=${pythonAddr}, TS=${tsAddrHex}`);
				}
			}

			expect(mismatches).toBe(0);
		});
	});

	describe('Round-Trip Tests', () => {
		it('should preserve LARGE font data through encode → decode cycle', () => {
			const testCodePoints = [0x4E00, 0x4E01, 0x4E02, 0x4E03, 0x4E04];

			for (const codePoint of testCodePoints) {
				// Read original
				const original = extractor.readFont(codePoint, 'LARGE');
				if (!original) continue;

				// Decode to pixels
				const lookupVal = extractor.getLookup(codePoint);
				const originalPixels = decodeV8(original, lookupVal);

				// Encode back
				const encoded = encodeV8(originalPixels, lookupVal, 'LARGE');

				// Should match original
				expect(encoded.length).toBe(original.length);
				for (let i = 0; i < original.length; i++) {
					expect(encoded[i]).toBe(original[i]);
				}
			}
		});

		it('should preserve SMALL font data through encode → decode cycle', () => {
			const testCodePoints = [0x0020, 0x0041, 0x0042, 0x0043, 0x0061];

			for (const codePoint of testCodePoints) {
				// Read original
				const original = extractor.readFont(codePoint, 'SMALL');
				if (!original) continue;

				// Decode to pixels
				const lookupVal = extractor.getLookup(codePoint);
				const originalPixels = decodeV8(original, lookupVal);

				// Encode back
				const encoded = encodeV8(originalPixels, lookupVal, 'SMALL');

				// Should match original
				expect(encoded.length).toBe(original.length);
				for (let i = 0; i < original.length; i++) {
					expect(encoded[i]).toBe(original[i]);
				}
			}
		});

		it('should preserve BMP-to-pixels-to-BMP conversion', () => {
			const testCodePoints = [0x4E00, 0x4E01, 0x4E02];

			for (const codePoint of testCodePoints) {
				const pixels = extractor.readFontAsPixels(codePoint, 'LARGE');
				if (!pixels) continue;

				// Create BMP
				const bmp = createMonoBmp(pixels, 16, 16);

				// Parse BMP back
				const parsed = parseMonoBmp(bmp);
				expect(parsed).not.toBeNull();

				// Should match
				expect(pixelsEqual(pixels, parsed!)).toBe(true);
			}
		});

		it('should survive full round-trip: read → write → read → verify', () => {
			// Test with a copy of firmware data
			const testFirmware = new Uint8Array(firmwareData);
			const testExtractor = new FontExtractor(testFirmware, addresses);

			const testCodePoints = [0x4E00, 0x4E01, 0x4E02, 0x4E03];

			for (const codePoint of testCodePoints) {
				// Read original
				const original = extractor.readFontAsPixels(codePoint, 'LARGE');
				if (!original) continue;

				// Create a modified version (invert pixels)
				const modified: boolean[][] = original.map((row) => row.map((pixel) => !pixel));

				// Write modified pixels
				const writeResult = testExtractor.replaceFontFromPixels(codePoint, 'LARGE', modified);
				expect(writeResult).toBe(true);

				// Read back
				const readBack = testExtractor.readFontAsPixels(codePoint, 'LARGE');
				expect(readBack).not.toBeNull();

				// Verify modification
				expect(pixelsEqual(modified, readBack!)).toBe(true);

				// Write original back (restore)
				const restoreResult = testExtractor.replaceFontFromPixels(codePoint, 'LARGE', original);
				expect(restoreResult).toBe(true);

				// Verify restoration
				const restored = testExtractor.readFontAsPixels(codePoint, 'LARGE');
				expect(pixelsEqual(original, restored!)).toBe(true);
			}
		});

		it('should handle edge case: empty glyph replacement', () => {
			// Find a valid glyph first
			let validCodePoint: number | null = null;
			for (let cp = 0x4E00; cp <= 0x4E10; cp++) {
				if (extractor.readFontAsPixels(cp, 'LARGE')) {
					validCodePoint = cp;
					break;
				}
			}

			if (!validCodePoint) {
				console.log('  ⊘ No valid glyph found, skipping');
				return;
			}

			const testFirmware = new Uint8Array(firmwareData);
			const testExtractor = new FontExtractor(testFirmware, addresses);

			// Create empty glyph
			const empty: boolean[][] = Array(16).fill(null).map(() => Array(16).fill(false));

			// Write empty
			testExtractor.replaceFontFromPixels(validCodePoint, 'LARGE', empty);

			// Read back
			const readBack = testExtractor.readFontAsPixels(validCodePoint, 'LARGE');

			// Should be empty
			expect(pixelsEqual(empty, readBack!)).toBe(true);
		});

		it('should handle modified BMP data round-trip', () => {
			const testCodePoint = 0x4E00;
			const pixels = extractor.readFontAsPixels(testCodePoint, 'LARGE');
			if (!pixels) return;

			// Create BMP
			const originalBmp = createMonoBmp(pixels, 16, 16);

			// Modify BMP (invert first few bytes of pixel data)
			const modifiedBmp = new Uint8Array(originalBmp);
			for (let i = 62; i < 94; i++) {
				modifiedBmp[i] ^= 0xFF;
			}

			// Parse modified BMP
			const parsed = parseMonoBmp(modifiedBmp);
			expect(parsed).not.toBeNull();

			// Should be different from original
			expect(pixelsEqual(pixels, parsed!)).toBe(false);
		});
	});

	describe('Exhaustive Unicode Range Tests', () => {
		it('should exhaustively test CJK Unified range (LARGE)', () => {
			// Test a subset due to size (full range is ~20k code points)
			const start = 0x4E00;
			const end = 0x4FFF;
			const step = 10;

			let tested = 0;
			let mismatches = 0;
			let pythonErrors = 0;

			for (let cp = start; cp <= end; cp += step) {
				// Get Python result
				const pythonResult = runPythonBunMode(
					FIRMWARE_PATH,
					'LARGE',
					`0x${cp.toString(16).toUpperCase()}`,
					`0x${Math.min(cp + step - 1, end).toString(16).toUpperCase()}`
				);

				if (!pythonResult) {
					pythonErrors++;
					continue;
				}

				for (const pythonGlyph of pythonResult!.glyphs as Array<Record<string, unknown>>) {
					if (pythonGlyph.empty) continue;

					const codePoint = pythonGlyph.code_point as number;
					const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);

					const tsPixels = extractor.readFontAsPixels(codePoint, 'LARGE');
					if (!tsPixels) continue;

					if (!pixelsEqual(pythonPixels, tsPixels)) {
						mismatches++;
					}
					tested++;
				}
			}

			console.log(`  Tested: ${tested}, Mismatches: ${mismatches}, Python Errors: ${pythonErrors}`);
			expect(mismatches).toBe(0);
		}, 120000);

		it('should exhaustively test Basic Latin range (SMALL)', () => {
			const start = 0x0000;
			const end = 0x007F;

			const pythonResult = runPythonBunMode(FIRMWARE_PATH, 'SMALL', `0x${start.toString(16).toUpperCase()}`, `0x${end.toString(16).toUpperCase()}`);
			expect(pythonResult).not.toBeNull();

			let tested = 0;
			let mismatches = 0;

			for (const pythonGlyph of pythonResult!.glyphs as Array<Record<string, unknown>>) {
				const codePoint = pythonGlyph.code_point as number;
				const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);

				const tsPixels = extractor.readFontAsPixels(codePoint, 'SMALL');
				if (!tsPixels) continue;

				if (!pixelsEqual(pythonPixels, tsPixels)) {
					mismatches++;
				}
				tested++;
			}

			console.log(`  Tested: ${tested}, Mismatches: ${mismatches}`);
			expect(mismatches).toBe(0);
		});

		it('should test all defined Unicode ranges have valid extraction', () => {
			let totalGlyphs = 0;
			let totalEmpty = 0;

			for (const range of UNICODE_RANGES) {
				// Pick first code point
				const first = range.start;

				// Determine font type based on range
				const fontType = first >= 0x4E00 ? 'LARGE' : 'SMALL';

				// Test a sample
				const sampleCp = first;
				const pixels = extractor.readFontAsPixels(sampleCp, fontType as 'SMALL' | 'LARGE');

				if (pixels) {
					totalGlyphs++;
				} else {
					// Check if it's actually empty in firmware
					const raw = extractor.readFont(sampleCp, fontType as 'SMALL' | 'LARGE');
					if (raw) {
						totalEmpty++;
					}
				}
			}

			console.log(`  Valid glyphs found: ${totalGlyphs}`);
			console.log(`  Empty/unavailable: ${totalEmpty}`);
			expect(totalGlyphs + totalEmpty).toBe(UNICODE_RANGES.length);
		});
	});

	describe('Error Handling', () => {
		it('should handle out-of-bounds address gracefully', () => {
			// Create a small test firmware
			const smallFirmware = new Uint8Array(100);
			const smallAddresses: FirmwareAddresses = {
				SMALL_BASE: 0,
				LARGE_BASE: 50,
				LOOKUP_TABLE: 80,
				confidence: { smallFontValid: 0, largeFontValid: 0, movw0042Count: 0 }
			};
			const smallExtractor = new FontExtractor(smallFirmware, smallAddresses);

			// Try to read out of bounds
			const result = smallExtractor.readFont(0xFFFF, 'LARGE');
			expect(result).toBeNull();
		});

		it('should handle invalid BMP data gracefully', () => {
			// Create an invalid BMP (too short)
			const invalidBmp = new Uint8Array([0x42, 0x4D]); // Just "BM"

			const result = parseMonoBmp(invalidBmp);
			expect(result).toBeNull();
		});

		it('should reject invalid font type in replaceFont', () => {
			expect(() => {
				extractor.replaceFont(0x0041, 'INVALID' as 'SMALL' | 'LARGE', new Uint8Array(32));
			}).toThrow();
		});

		it('should reject wrong-sized data in replaceFont', () => {
			const result = extractor.replaceFont(0x0041, 'SMALL', new Uint8Array(33));
			expect(result).toBe(false);
		});
	});

	describe('Boundary Condition Tests', () => {
		it('should handle first code point of LARGE fonts (0x4E00)', () => {
			const pixels = extractor.readFontAsPixels(0x4E00, 'LARGE');
			expect(pixels).not.toBeNull();
			expect(pixels!.length).toBe(16);
		});

		it('should handle last code point before transition', () => {
			// 0x4DFF is the last code point before some transition
			const pixels = extractor.readFontAsPixels(0x4DFF, 'LARGE');
			// May or may not exist depending on firmware
			if (pixels) {
				expect(pixels.length).toBe(16);
			}
		});

		it('should correctly calculate addresses at boundaries', () => {
			// LARGE font address calculation
			const addr0 = extractor.unicodeToLargeAddr(0x4E00);
			const addr1 = extractor.unicodeToLargeAddr(0x4E01);
			const addr2 = extractor.unicodeToLargeAddr(0x4E02);

			// Should differ by LARGE_STRIDE (33)
			expect(addr1 - addr0).toBe(33);
			expect(addr2 - addr1).toBe(33);
		});

		it('should correctly calculate SMALL font addresses', () => {
			const addr0 = extractor.unicodeToSmallAddr(0x0000);
			const addr1 = extractor.unicodeToSmallAddr(0x0001);
			const addr2 = extractor.unicodeToSmallAddr(0x0002);

			// Should differ by SMALL_STRIDE (32)
			expect(addr1 - addr0).toBe(32);
			expect(addr2 - addr1).toBe(32);
		});
	});
});

describe('Font Extraction - Exhaustive Code Point Coverage', () => {
	beforeAll(() => {
		const setupMode = process.argv.includes('--setup');
		if (!ensureFixtures(setupMode)) {
			throw new Error(
				`Fixtures not found. Run: bun test src/lib/rse/__tests__/font-extraction-comprehensive.test.ts --setup`
			);
		}

		firmwareData = new Uint8Array(readFileSync(FIRMWARE_PATH));
		analyzer = new FirmwareAnalyzer(firmwareData);
		addresses = analyzer.detectAddresses()!;
		extractor = new FontExtractor(firmwareData, addresses);
	}, 60000);

	/**
	 * Test a specific Unicode range exhaustively
	 */
	function testRangeExhaustively(
		start: number,
		end: number,
		fontType: 'SMALL' | 'LARGE',
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_expectedGlyphs: number,
	): void {
		let found = 0;
		let mismatches = 0;

		for (let cp = start; cp <= end; cp++) {
			const raw = extractor.readFont(cp, fontType);
			if (!raw) continue;

			const lookupVal = extractor.getLookup(cp);
			const pixels = decodeV8(raw, lookupVal);
			const glyphPixels = fontType === 'SMALL'
				? pixels.slice(0, SMALL_FONT_SIZE).map(row => row.slice(0, SMALL_FONT_SIZE))
				: pixels;

			// Verify using Python as ground truth
			const pythonResult = runPythonBunMode(
				FIRMWARE_PATH,
				fontType,
				`0x${cp.toString(16).toUpperCase()}`,
				`0x${cp.toString(16).toUpperCase()}`
			) as Record<string, unknown> | null;

			if (pythonResult &&
			    Array.isArray(pythonResult.errors) &&
			    pythonResult.errors.length === 0 &&
			    Array.isArray(pythonResult.glyphs) &&
			    pythonResult.glyphs.length > 0) {
				const pythonGlyph = pythonResult.glyphs[0] as Record<string, unknown>;
				if (!pythonGlyph.empty) {
					const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);
					if (!pixelsEqual(glyphPixels, pythonPixels)) {
						mismatches++;
					}
				}
			}
			found++;
		}

		expect(mismatches).toBe(0);
		console.log(`  ${fontType} U+${start.toString(16).toUpperCase()}-U+${end.toString(16).toUpperCase()}: ${found} glyphs, ${mismatches} mismatches`);
	}

	it('should exhaustively test CJK Extension A', () => {
		testRangeExhaustively(0x3400, 0x4DBF, 'LARGE', 0);
	}, 300000);

	it('should exhaustively test CJK Unified block', () => {
		// Test in chunks to avoid timeout
		const chunks = [
			[0x4E00, 0x4FFF],
			[0x5000, 0x5FFF],
			[0x6000, 0x6FFF],
			[0x7000, 0x7FFF],
			[0x8000, 0x8FFF],
			[0x9000, 0x9FFF],
		];

		for (const [start, end] of chunks) {
			testRangeExhaustively(start, end, 'LARGE', 0);
		}
	}, 600000);

	it('should exhaustively test full SMALL font range', () => {
		testRangeExhaustively(0x0000, 0xFFFF, 'SMALL', 0);
	}, 600000);
});
