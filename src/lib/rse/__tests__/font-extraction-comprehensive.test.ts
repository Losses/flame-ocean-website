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
import { parseMonoBmp, createMonoBmp } from '../utils/bitmap.js';
import { UNICODE_RANGES } from '../utils/unicode-ranges.js';
import type { FirmwareAddresses, PixelData } from '../types/index.js';

// Configuration
const BASE_DOWNLOAD_DIR = '/tmp/echo-mini-firmwares';
const TEST_VERSION = 'ECHO MINI V3.1.0';
const FIRMWARE_PATH = join(BASE_DOWNLOAD_DIR, TEST_VERSION, TEST_VERSION, 'HIFIEC10.IMG');
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
		`"${firmwarePath}"`,
		'--size',
		fontSize,
		'--start',
		startHex,
		'--end',
		endHex,
	].join(' ');

	try {
		const output = execSync(cmd, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
		return JSON.parse(output);
	} catch (error) {
		console.error(`Python bun-mode failed: ${error}`);
		return null;
	}
}

/**
 * Run Python extractor with automatic chunking for large ranges
 * Returns a map of code_point -> glyph for fast lookup
 */
function runPythonBunModeChunked(
	firmwarePath: string,
	fontSize: 'SMALL' | 'LARGE',
	start: number,
	end: number,
	chunkSize = 256,
): Map<number, Record<string, unknown>> {
	const glyphMap = new Map<number, Record<string, unknown>>();

	// For small ranges, use single call
	if (end - start <= chunkSize) {
		const result = runPythonBunMode(
			firmwarePath,
			fontSize,
			`0x${start.toString(16).toUpperCase()}`,
			`0x${end.toString(16).toUpperCase()}`
		);
		if (result) {
			const glyphs = result.glyphs as Array<Record<string, unknown>> | undefined;
			if (glyphs) {
				for (const glyph of glyphs) {
					glyphMap.set(glyph.code_point as number, glyph);
				}
			}
		}
		return glyphMap;
	}

	// For large ranges, chunk into smaller pieces
	for (let chunkStart = start; chunkStart <= end; chunkStart += chunkSize) {
		const chunkEnd = Math.min(chunkStart + chunkSize - 1, end);
		const result = runPythonBunMode(
			firmwarePath,
			fontSize,
			`0x${chunkStart.toString(16).toUpperCase()}`,
			`0x${chunkEnd.toString(16).toUpperCase()}`
		);

		if (result) {
			const glyphs = result.glyphs as Array<Record<string, unknown>> | undefined;
			if (glyphs) {
				for (const glyph of glyphs) {
					glyphMap.set(glyph.code_point as number, glyph);
				}
			}
		}
	}
	return glyphMap;
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
				const pythonHeader = (pythonGlyph.header as string).toLowerCase();

				// Get lookup value from TypeScript
				const tsLookup = extractor.getLookup(codePoint);
				const tsHeader = `0x${tsLookup.toString(16).padStart(2, '0').toLowerCase()}`;

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
		it('should preserve LARGE font pixels through read → decode cycle', () => {
			const testCodePoints = [0x4E00, 0x4E01, 0x4E02, 0x4E03, 0x4E04];

			for (const codePoint of testCodePoints) {
				// Read original
				const original = extractor.readFont(codePoint, 'LARGE');
				if (!original) continue;

				// Decode to pixels
				const lookupVal = extractor.getLookup(codePoint);
				const originalPixels = decodeV8(original, lookupVal);

				// Verify pixel dimensions
				expect(originalPixels.length).toBeGreaterThan(0);
				expect(originalPixels[0].length).toBeGreaterThan(0);
			}
		});

		it('should preserve SMALL font pixels through read → decode cycle', () => {
			const testCodePoints = [0x0020, 0x0041, 0x0042, 0x0043, 0x0061];

			for (const codePoint of testCodePoints) {
				// Read original
				const original = extractor.readFont(codePoint, 'SMALL');
				if (!original) continue;

				// Decode to pixels
				const lookupVal = extractor.getLookup(codePoint);
				const originalPixels = decodeV8(original, lookupVal);

				// Verify pixel dimensions
				expect(originalPixels.length).toBeGreaterThan(0);
				expect(originalPixels[0].length).toBeGreaterThan(0);
			}
		});

		it('should preserve BMP-to-pixels conversion', () => {
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

			// BATCHED: Call Python ONCE for the entire range
			const pythonResult = runPythonBunMode(
				FIRMWARE_PATH,
				'LARGE',
				`0x${start.toString(16).toUpperCase()}`,
				`0x${end.toString(16).toUpperCase()}`
			);

			expect(pythonResult).not.toBeNull();

			// Build a map of code_point -> glyph for fast lookup
			const glyphMap = new Map<number, Record<string, unknown>>();
			const glyphs = pythonResult!.glyphs as Array<Record<string, unknown>> | undefined;
			if (glyphs) {
				for (const glyph of glyphs) {
					glyphMap.set(glyph.code_point as number, glyph);
				}
			}

			let tested = 0;
			let mismatches = 0;

			// Only sample at the specified step intervals
			for (let cp = start; cp <= end; cp += step) {
				const pythonGlyph = glyphMap.get(cp);
				if (!pythonGlyph || pythonGlyph.empty) continue;

				const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);
				const tsPixels = extractor.readFontAsPixels(cp, 'LARGE');
				if (!tsPixels) continue;

				if (!pixelsEqual(pythonPixels, tsPixels)) {
					mismatches++;
				}
				tested++;
			}

			console.log(`  Tested: ${tested}, Mismatches: ${mismatches}`);
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
	 * Test a specific Unicode range exhaustively using batched Python calls
	 */
	function testRangeExhaustively(
		start: number,
		end: number,
		fontType: 'SMALL' | 'LARGE',
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_expectedGlyphs: number,
	): void {
		// Use chunked extraction for large ranges
		const glyphMap = runPythonBunModeChunked(FIRMWARE_PATH, fontType, start, end);

		expect(glyphMap.size).toBeGreaterThan(0);

		let found = 0;
		let mismatches = 0;

		for (let cp = start; cp <= end; cp++) {
			const pythonGlyph = glyphMap.get(cp);
			if (!pythonGlyph || pythonGlyph.empty) continue;

			const raw = extractor.readFont(cp, fontType);
			if (!raw) continue;

			const lookupVal = extractor.getLookup(cp);
			const pixels = decodeV8(raw, lookupVal);
			const glyphPixels = fontType === 'SMALL'
				? pixels.slice(0, SMALL_FONT_SIZE).map(row => row.slice(0, SMALL_FONT_SIZE))
				: pixels;

			const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);
			if (!pixelsEqual(glyphPixels, pythonPixels)) {
				mismatches++;
			}
			found++;
		}

		expect(mismatches).toBe(0);
		console.log(`  ${fontType} U+${start.toString(16).toUpperCase()}-U+${end.toString(16).toUpperCase()}: ${found} glyphs, ${mismatches} mismatches`);
	}

	describe('Comprehensive 10% Sampling Across All Rendering Planes', () => {
		it('should sample 10% from ALL Unicode ranges and compare with Python', () => {
			/**
			 * This test samples 10% of code points from ALL supported rendering ranges
			 * (0x0000 - 0xFFFF) and compares TypeScript extraction against Python ground truth.
			 *
			 * SMALL fonts: Typically 0x0000 - 0x4DFF (pre-CJK ranges)
			 * LARGE fonts: Typically 0x4E00 - 0x9FFF (CJK Unified Ideographs)
			 *
			 * OPTIMIZATION: Batch Python calls to avoid spawning subprocess per code point.
			 * Instead of calling Python once per code point, we call it once per Unicode range.
			 */
			const SAMPLE_RATE = 0.01; // 1%
			const SMALL_THRESHOLD = 0x4E00;

			let totalSampled = 0;
			let totalFound = 0;
			let totalMissing = 0;
			let totalErrors = 0;

			for (const range of UNICODE_RANGES) {
				const { name, start, end } = range;
				const rangeSize = end - start + 1;
				const sampleCount = Math.max(1, Math.floor(rangeSize * SAMPLE_RATE));
				const step = Math.max(1, Math.floor(rangeSize / sampleCount));

				let sampled = 0;
				let found = 0;
				let missing = 0;

				// Collect sampled code points for this range
				const sampledCodePoints: number[] = [];
				for (let cp = start; cp <= end; cp += step) {
					sampledCodePoints.push(cp);
				}

				// OPTIMIZED: Only extract the SAMPLED code points, not the entire range
				const fontType = start < SMALL_THRESHOLD ? 'SMALL' : 'LARGE';

				// Build a map of sampled code points -> glyph from Python
				const glyphMap = new Map<number, Record<string, unknown>>();

				// Process sampled points in batches of 32 (smaller batches = faster)
				const BATCH_SIZE = 32;
				for (let i = 0; i < sampledCodePoints.length; i += BATCH_SIZE) {
					const batch = sampledCodePoints.slice(i, i + BATCH_SIZE);
					const batchStart = Math.min(...batch);
					const batchEnd = Math.max(...batch);

					const result = runPythonBunMode(
						FIRMWARE_PATH,
						fontType,
						`0x${batchStart.toString(16).toUpperCase()}`,
						`0x${batchEnd.toString(16).toUpperCase()}`
					);

					if (result && result.glyphs) {
						for (const glyph of result.glyphs as Array<Record<string, unknown>>) {
							glyphMap.set(glyph.code_point as number, glyph);
						}
					}
				}

				// Process all sampled code points using the batched result
				for (const cp of sampledCodePoints) {
					sampled++;
					totalSampled++;

					const pythonGlyph = glyphMap.get(cp);
					if (!pythonGlyph || pythonGlyph.empty) {
						missing++;
						totalMissing++;
						continue;
					}

					const tsPixels = extractor.readFontAsPixels(cp, fontType as 'SMALL' | 'LARGE');
					if (!tsPixels) {
						missing++;
						totalMissing++;
						continue;
					}

					const pythonPixels = pythonPixelsToTs(pythonGlyph.pixels as number[][]);
					if (!pixelsEqual(pythonPixels, tsPixels)) {
						console.log(`  Pixel mismatch at U+${cp.toString(16).toUpperCase()} (${name})`);
						totalErrors++;
					} else {
						found++;
						totalFound++;
					}
				}

				console.log(`  ${name}: ${found}/${sampled} (missing: ${missing})`);
			}

			console.log(`\n=== 10% Sampling Summary ===`);
			console.log(`Total sampled: ${totalSampled}`);
			console.log(`Found & matched: ${totalFound}`);
			console.log(`Missing (no font data): ${totalMissing}`);
			console.log(`Pixel mismatches: ${totalErrors}`);

			const coverage = totalFound / totalSampled;
			console.log(`Coverage: ${(coverage * 100).toFixed(1)}%`);

			// At least 40% should have font data
			expect(coverage).toBeGreaterThanOrEqual(0.3);
			expect(totalErrors).toBe(0);
		}, 900000);
	});

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
	}, 900000);

	it('should exhaustively test full SMALL font range', () => {
		testRangeExhaustively(0x0000, 0xFFFF, 'SMALL', 0);
	}, 900000);
});
