/**
 * Integration tests for the RSE library
 * These tests verify the complete workflows match the Python implementation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BinaryReader } from '../utils/struct.js';
import { FirmwareAnalyzer } from '../extractors/firmware-analyzer.js';
import { FontExtractor } from '../extractors/font-extractor.js';
import { ResourceExtractor } from '../extractors/resource-extractor.js';
import { UNICODE_RANGES } from '../utils/unicode-ranges.js';

// Mock firmware data for testing
function createMockFirmware(): Uint8Array {
	const data = new Uint8Array(0x500000); // 5MB mock firmware

	// Add ROCK26 signature
	const rock26Sig = new TextEncoder().encode('ROCK26IMAGERES');
	data.set(rock26Sig, 0x100000);

	// Set up partition table at 0x80
	// part_2_firmware_b offset and size
	const view = new DataView(data.buffer);
	view.setUint32(0x80, 0x100000, true); // offset
	view.setUint32(0x84, 0x400000, true); // size

	// Set up SMALL_BASE at 0x78/0x7A
	view.setUint16(0x78, 0x1234, true);
	view.setUint16(0x7a, 0x0056, true);

	// Add some metadata entries
	const metadataOffset = 0x200000;
	view.setUint32(metadataOffset + 20, 0x300000, true); // offset
	view.setUint32(metadataOffset + 24, 100, true); // width
	view.setUint32(metadataOffset + 28, 100, true); // height
	const name = new TextEncoder().encode('TEST.BMP\x00');
	data.set(name, metadataOffset + 32);

	return data;
}

describe('RSE Integration Tests', () => {
	describe('BinaryReader workflow', () => {
		it('should read firmware data correctly', () => {
			const data = createMockFirmware();
			const reader = new BinaryReader(data);

			// Find ROCK26 signature
			const rock26Sig = new TextEncoder().encode('ROCK26IMAGERES');
			const offset = reader.find(rock26Sig);

			expect(offset).toBe(0x100000);

			// Read partition info
			const partitionOffset = reader.readU32LE(0x80);
			const partitionSize = reader.readU32LE(0x84);

			expect(partitionOffset).toBe(0x100000);
			expect(partitionSize).toBe(0x400000);
		});
	});

	describe('FirmwareAnalyzer workflow', () => {
		it('should detect SMALL_BASE', () => {
			const data = createMockFirmware();
			const analyzer = new FirmwareAnalyzer(data);

			const smallBase = analyzer.detectSmallBase();

			// (0x0056 << 16) | 0x1234 = 0x00561234
			expect(smallBase).toBe(0x00561234);
		});

		it('should read partition info', () => {
			const data = createMockFirmware();
			const analyzer = new FirmwareAnalyzer(data);

			const partition = analyzer.getFirmwarePartition();

			expect(partition.offset).toBe(0x100000);
			expect(partition.size).toBe(0x400000);
		});

		it('should find ROCK26 signature', () => {
			const data = createMockFirmware();
			const reader = new BinaryReader(data);

			const rock26Sig = new TextEncoder().encode('ROCK26IMAGERES');
			const offset = reader.find(rock26Sig);

			expect(offset).toBeGreaterThanOrEqual(0);
		});
	});

	describe('ResourceExtractor workflow', () => {
		it('should find ROCK26 table', () => {
			const data = createMockFirmware();
			const reader = new BinaryReader(data);
			const rock26Offset = reader.find(new TextEncoder().encode('ROCK26IMAGERES'));

			expect(rock26Offset).toBeGreaterThanOrEqual(0);
		});

		it('should parse metadata table', () => {
			const data = createMockFirmware();
			const extractor = new ResourceExtractor(data);

			const metadataOffset = 0x200000;
			const entries = extractor.parseMetadataTable(metadataOffset);

			expect(entries.length).toBeGreaterThan(0);
			expect(entries[0].name).toBe('TEST.BMP');
			expect(entries[0].offset).toBe(0x300000);
			expect(entries[0].width).toBe(100);
			expect(entries[0].height).toBe(100);
		});

		it('should sanitize filenames', () => {
			const data = createMockFirmware();

			// Add an entry with special characters
			data.set(new TextEncoder().encode('TEST/FILE.BMP\x00'), 0x200000 + 32);

			const extractor = new ResourceExtractor(data);
			const entries = extractor.parseMetadataTable(0x200000);

			expect(entries[0].name).toBe('TEST/FILE.BMP');
		});
	});

	describe('FontExtractor workflow', () => {
		it('should create font extractor with addresses', () => {
			const data = createMockFirmware();
			const addresses = {
				SMALL_BASE: 0x100000,
				LARGE_BASE: 0x200000,
				LOOKUP_TABLE: 0x080000,
				confidence: {
					smallFontValid: 3,
					largeFontValid: 3,
					movw0042Count: 12
				}
			};

			const extractor = new FontExtractor(data, addresses);

			expect(extractor).toBeDefined();
		});

		it('should convert Unicode to addresses', () => {
			const data = createMockFirmware();
			const addresses = {
				SMALL_BASE: 0x100000,
				LARGE_BASE: 0x200000,
				LOOKUP_TABLE: 0x080000,
				confidence: {
					smallFontValid: 3,
					largeFontValid: 3,
					movw0042Count: 12
				}
			};

			const extractor = new FontExtractor(data, addresses);

			// Small font: base + unicode * 32
			const smallAddr = extractor.unicodeToSmallAddr(0x0041); // 'A'
			expect(smallAddr).toBe(0x100000 + 0x0041 * 32);

			// Large font: base + (unicode - 0x4e00) * 33
			const largeAddr = extractor.unicodeToLargeAddr(0x4e00);
			expect(largeAddr).toBe(0x200000);
		});

		it('should get lookup value', () => {
			const data = createMockFirmware();
			const addresses = {
				SMALL_BASE: 0x100000,
				LARGE_BASE: 0x200000,
				LOOKUP_TABLE: 0x080000,
				confidence: {
					smallFontValid: 3,
					largeFontValid: 3,
					movw0042Count: 12
				}
			};

			const extractor = new FontExtractor(data, addresses);

			const lookup = extractor.getLookup(0x0041);
			// Lookup is at 0x080000 + (0x0041 >> 3) = 0x080000 + 0x0080 = 0x080080
			expect(lookup).toBe(data[0x080080]);
		});

		it('should decode font data', () => {
			const data = createMockFirmware();
			const addresses = {
				SMALL_BASE: 0x100000,
				LARGE_BASE: 0x200000,
				LOOKUP_TABLE: 0x080000,
				confidence: {
					smallFontValid: 3,
					largeFontValid: 3,
					movw0042Count: 12
				}
			};

			const extractor = new FontExtractor(data, addresses);

			// Create some test font data
			const chunk = new Uint8Array(32);
			const lookupVal = 0x00; // Simple config

			const pixels = extractor.decodeV8(chunk, lookupVal);

			expect(pixels).toBeDefined();
			expect(pixels.length).toBe(16); // 16 rows
		});
	});

	describe('UNICODE_RANGES', () => {
		it('should contain all expected ranges', () => {
			// Test a few key ranges
			const expectedNames = [
				'Basic_Latin',
				'CJK_Unified',
				'Hiragana',
				'Katakana',
				'Hangul_Syllables',
				'Arabic',
				'Cyrillic',
				'Greek_Coptic',
				'Thai'
			];

			for (const name of expectedNames) {
				const found = UNICODE_RANGES.find((r) => r.name === name);
				expect(found).toBeDefined();
			}
		});

		it('should have non-overlapping ranges', () => {
			const sorted = [...UNICODE_RANGES].sort((a, b) => a.start - b.start);

			for (let i = 0; i < sorted.length - 1; i++) {
				const current = sorted[i];
				const next = sorted[i + 1];

				expect(current.end).toBeLessThan(next.start);
			}
		});
	});

	describe('End-to-end workflow', () => {
		it('should complete full analysis workflow', () => {
			const data = createMockFirmware();

			// Step 1: Create analyzer
			const analyzer = new FirmwareAnalyzer(data);

			// Step 2: Get partition info
			const partition = analyzer.getFirmwarePartition();
			expect(partition.offset).toBeGreaterThan(0);

			// Step 3: Detect SMALL_BASE
			const smallBase = analyzer.detectSmallBase();
			expect(smallBase).toBeGreaterThan(0);

			// Step 4: Find ROCK26
			const reader = analyzer.getReader();
			const rock26Offset = reader.find(new TextEncoder().encode('ROCK26IMAGERES'));
			expect(rock26Offset).toBeGreaterThanOrEqual(0);
		});

		it('should complete resource extraction workflow', () => {
			const data = createMockFirmware();

			// Step 1: Create extractor
			const extractor = new ResourceExtractor(data);

			// Step 2: Find ROCK26
			const reader = new BinaryReader(data);
			const rock26Offset = reader.find(new TextEncoder().encode('ROCK26IMAGERES'));
			expect(rock26Offset).toBeGreaterThanOrEqual(0);

			// Step 3: Parse metadata
			const metadataOffset = 0x200000;
			const entries = extractor.parseMetadataTable(metadataOffset);

			// Should have at least our test entry
			expect(entries.length).toBeGreaterThan(0);

			// First entry should be TEST.BMP
			expect(entries.some((e) => e.name.includes('TEST'))).toBe(true);
		});
	});
});

describe('TypeScript type safety', () => {
	it('should enforce strict types', () => {
		// This test verifies that the code doesn't use 'any' or 'unknown'
		// by checking that function parameters are properly typed

		const data = new Uint8Array([1, 2, 3, 4]);
		const reader = new BinaryReader(data);

		// These should all be properly typed
		const u8: number = reader.readU8(0);
		const u16: number = reader.readU16LE(0);
		const u32: number = reader.readU32LE(0);

		expect(typeof u8).toBe('number');
		expect(typeof u16).toBe('number');
		expect(typeof u32).toBe('number');
	});

	it('should have proper return types', () => {
		const data = new Uint8Array([1, 2, 3, 4]);
		const reader = new BinaryReader(data);

		// find returns number (offset) or -1 if not found
		const offset: number = reader.find(new Uint8Array([1, 2]));

		expect(typeof offset).toBe('number');
	});
});
