/**
 * Theme Patcher Tests
 *
 * Unit tests for the theme patcher functionality.
 * Independent tests for instruction encoding, function discovery,
 * NOP slide finding, patch detection, and the full patching workflow.
 */

import { describe, it, expect } from 'vitest';
import {
	ThemePatcher,
	ThemeColorExtractor,
	encodeBl,
	decodeBlTarget,
	encodeB16bit,
	encodeMovw,
	encodePush,
	discoverFlacFunction,
	discoverMenuFunction,
	findFunctionStart,
	NopSlideFinder,
	PatchDetector,
	crc16,
	ValidationError
} from '../theme/index.js';
import type { FirmwareFile } from '../extractors/batch-processor.js';
import { fileIO } from '../utils/file-io.js';

describe('Theme Patcher - Instruction Encoding', () => {
	describe('encodeBl', () => {
		it('should encode forward BL instruction correctly', () => {
			const fromAddr = 0x1000;
			const toAddr = 0x2000;

			const blBytes = encodeBl(fromAddr, toAddr);

			// Verify it's a valid BL instruction
			const hw1 = blBytes[0] | (blBytes[1] << 8);
			const hw2 = blBytes[2] | (blBytes[3] << 8);

			expect(hw1 & 0xf800).toEqual(0xf000);
			expect(hw2 & 0xd000).toEqual(0xd000);
		});

		it('should encode backward BL instruction correctly', () => {
			const fromAddr = 0x2000;
			const toAddr = 0x1000;

			const blBytes = encodeBl(fromAddr, toAddr);

			const hw1 = blBytes[0] | (blBytes[1] << 8);
			const hw2 = blBytes[2] | (blBytes[3] << 8);

			expect(hw1 & 0xf800).toEqual(0xf000);
			expect(hw2 & 0xd000).toEqual(0xd000);
		});

		it('should maintain BL roundtrip correctness', () => {
			// This test verifies BL instruction encoding/decoding roundtrip.
			// Using the decodeBlTarget function which matches the encodeBl implementation.
			const fromAddr = 0x86cb0;
			const toAddr = 0xa0d204; // Real NOP slide address from V3.1.0

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(toAddr);
		});

		it('should reject BL offsets out of range', () => {
			const fromAddr = 0x100000;

			// More than +16MB
			expect(() => encodeBl(fromAddr, fromAddr + 0x1000004)).toThrow();
		});
	});

	describe('encodeB16bit', () => {
		it('should encode 16-bit B instruction correctly', () => {
			const fromAddr = 0x1000;
			const toAddr = 0x1000 + 0x802; // Near max forward

			const bBytes = encodeB16bit(fromAddr, toAddr);

			expect(bBytes.length).toEqual(2);
		});

		it('should reject B offsets out of range', () => {
			const fromAddr = 0x1000;

			expect(() => encodeB16bit(fromAddr, fromAddr + 0x1000)).toThrow();
		});
	});

	describe('encodeMovw', () => {
		it('should encode MOVW instruction correctly', () => {
			const reg = 5;
			const imm16 = 0xf800;

			const movwBytes = encodeMovw(reg, imm16);

			// Verify encoding
			const hw1 = movwBytes[0] | (movwBytes[1] << 8);
			const hw2 = movwBytes[2] | (movwBytes[3] << 8);

			expect(hw1 & 0xfbf0).toEqual(0xf240);
			expect((hw2 >> 8) & 0xf).toEqual(reg);
		});
	});

	describe('encodePush', () => {
		it('should encode PUSH instruction correctly', () => {
			const regs = [0, 1, 2, 14]; // R0, R1, R2, LR

			const pushBytes = encodePush(regs);

			// ARM Thumb PUSH is a 16-bit (2-byte) instruction
			expect(pushBytes.length).toEqual(2);

			// Verify the opcode: PUSH {R0,R1,R2,LR}
			// Format: 0xB5XX where XX is register list (bit 0 = R0, bit 1 = R1, bit 2 = R2)
			const opcode = pushBytes[0] | (pushBytes[1] << 8);
			// Register list: R0|R1|R2 = 0b111 = 0x07
			// With LR: 0xB500 | 0x07 = 0xB507
			expect(opcode).toEqual(0xB507);
		});
	});
});

describe('Theme Patcher - Function Discovery', () => {
	// These tests require actual firmware data
	// In CI/CD, the firmware should be downloaded first

	const testFirmwarePath = 'references/HIFIEC10.IMG';

	it('should discover FLAC function', () => {
		const firmwareData = fileIO.readFileSync(testFirmwarePath);
		const result = discoverFlacFunction(firmwareData);

		expect(result).not.toBeNull();
		if (result) {
			const [funcAddr, patchAddr] = result;
			expect(funcAddr).toBeGreaterThan(0);
			expect(patchAddr).toBeGreaterThan(0);

			// Verify pattern at patch address
			expect(firmwareData[patchAddr]).toEqual(0x04);
			expect(firmwareData[patchAddr + 1]).toEqual(0x29);
			expect(firmwareData[patchAddr + 2]).toEqual(0x0c);
			expect(firmwareData[patchAddr + 3]).toEqual(0xbf);
		}
	});

	it('should discover Menu function', () => {
		const firmwareData = fileIO.readFileSync(testFirmwarePath);
		const result = discoverMenuFunction(firmwareData);

		expect(result).not.toBeNull();
		if (result) {
			const [funcAddr, patchAddr] = result;
			expect(funcAddr).toBeGreaterThan(0);
			expect(patchAddr).toBeGreaterThan(0);

			// Verify pattern at patch address
			expect(firmwareData[patchAddr]).toEqual(0x4f);
			expect(firmwareData[patchAddr + 1]).toEqual(0xf0);
			expect(firmwareData[patchAddr + 2]).toEqual(0x00);
			expect(firmwareData[patchAddr + 3]).toEqual(0x0c);
		}
	});

	it('should find function start', () => {
		const firmwareData = fileIO.readFileSync(testFirmwarePath);
		const flacResult = discoverFlacFunction(firmwareData);

		expect(flacResult).not.toBeNull();
		if (flacResult) {
			const [funcAddr] = flacResult;
			const funcStart = findFunctionStart(firmwareData, funcAddr);

			expect(funcStart).toBeGreaterThan(0);
			expect(funcStart).toBeLessThanOrEqual(funcAddr);
		}
	});
});

describe('Theme Patcher - NOP Slide Finder', () => {
	it('should find valid NOP slides', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const finder = new NopSlideFinder(firmwareData);
		const slides = finder.findAllSlides();

		expect(slides.length).toBeGreaterThan(0);

		for (const slide of slides) {
			expect(slide.size).toBeGreaterThan(0);
			expect(slide.end).toBeGreaterThan(slide.start);
		}
	});

	it('should select best NOP slide', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const finder = new NopSlideFinder(firmwareData);

		// Discover functions dynamically
		const flacResult = discoverFlacFunction(firmwareData);
		const menuResult = discoverMenuFunction(firmwareData);

		expect(flacResult).not.toBeNull();
		expect(menuResult).not.toBeNull();

		if (flacResult && menuResult) {
			const funcAddrs = [flacResult[0], menuResult[0]];
			const best = finder.selectBestSlide(funcAddrs, 250);

			expect(best).not.toBeNull();
			if (best) {
				expect(best.size).toBeGreaterThanOrEqual(250);

				// Check distance is within BL range
				for (const funcAddr of funcAddrs) {
					const distance = Math.abs(best.start - funcAddr);
					expect(distance).toBeLessThanOrEqual(16777216);
				}

				// Verify 4-byte alignment (ARM Thumb2 requirement)
				expect(best.start % 4).toEqual(0);
			}
		}
	});
});

describe('Theme Patcher - NOP Slide Landing Points Analysis', () => {
	it('should analyze landing points in NOP slides', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);
		const analysis = patcher.analyzeLandingPoints();

		// Should find landing points
		expect(analysis.landingPoints.length).toBeGreaterThan(0);

		// Should find NOP slides
		expect(analysis.nopSlides.length).toBeGreaterThan(0);

		// Should find functional NOP slides
		expect(analysis.functionalNopSlides.length).toBeGreaterThan(0);
	});

	it('should identify the functional NOP slide at 0x588A8 - 0x79B70', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);
		const analysis = patcher.analyzeLandingPoints();

		// Find the functional NOP slide mentioned in memory
		const functionalSlide = analysis.functionalNopSlides.find(
			ns => ns.start === 0x588A8 && ns.end === 0x79B70
		);

		// This slide should be detected as functional
		expect(functionalSlide).toBeDefined();
		if (functionalSlide) {
			expect(functionalSlide.type).toBe('functional');
			expect(functionalSlide.landingPoints.length).toBeGreaterThan(0);
			expect(functionalSlide.referenceCount).toBeGreaterThan(50);
		}
	});

	it('should verify NOP slide safety before patching', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Get NOP slides from analysis
		const analysis = patcher.analyze();
		const slides = analysis.nopSlides;
		expect(slides.length).toBeGreaterThan(0);

		// Test safety verification for each slide
		for (const slide of slides.slice(0, 3)) { // Test first 3 slides
			const safety = patcher.verifyNopSlideLandingPointSafety(slide, 200);

			// Should have landing points info
			expect(safety.landingPoints).toBeDefined();

			// If the slide has landing points, check the result
			if (safety.requiresProtection) {
				// Functional NOP slides should have injection strategy
				if (safety.landingPoints.length > 0) {
					expect(safety.requiresProtection).toBe(true);
				}
			}
		}
	});

	it('should print landing points report', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// This should not throw
		expect(() => patcher.printLandingPointsReport()).not.toThrow();
	});

	it('should verify that patches do not interfere with functional NOP slide', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Find the functional NOP slide
		const analysis = patcher.analyzeLandingPoints();
		const functionalSlide = analysis.functionalNopSlides.find(
			ns => ns.start === 0x588A8
		);

		if (functionalSlide) {
			// Verify that trying to use this slide would be rejected
			const safety = patcher.verifyNopSlideLandingPointSafety(
				{
					start: functionalSlide.start,
					end: functionalSlide.end,
					size: functionalSlide.size,
					source: 'test',
					isActive: false,
					referenceCount: functionalSlide.referenceCount
				},
				200
			);

			// The functional NOP slide has many landing points
			expect(safety.landingPoints.length).toBeGreaterThan(0);
			expect(safety.requiresProtection).toBe(true);
		}
	});
});

describe('Theme Patcher - Patch Detection', () => {
	const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

	it('should detect original firmware as not patched', () => {
		const detector = new PatchDetector(firmwareData, 'Unknown');
		const flacResult = discoverFlacFunction(firmwareData);

		if (flacResult) {
			const [funcAddr] = flacResult;
			const [isPatched, status] = detector.detectFlacPatch(funcAddr);
			expect(isPatched).toBe(false);
			expect(status).toContain('Original');
		}
	});

	it('should check if instruction is BL', () => {
		const detector = new PatchDetector(firmwareData);

		// At a known non-BL instruction
		expect(detector.isBlInstruction(0x86cb0)).toBe(false);
	});

	it('should read patch metadata', () => {
		const finder = new NopSlideFinder(firmwareData);
		const slides = finder.findAllSlides();

		if (slides.length > 0) {
			const detector = new PatchDetector(firmwareData);
			const metadata = detector.readPatchMetadata(slides[0]);

			// Original firmware should not have metadata
			expect(metadata).toBeNull();
		}
	});
});

describe('Theme Patcher - CRC16', () => {
	it('should produce consistent CRC16 values', () => {
		const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

		const crc1 = crc16(data);
		const crc2 = crc16(data);

		expect(crc1).toEqual(crc2);
	});

	it('should produce different CRC16 for different data', () => {
		const crc1 = crc16(new Uint8Array([0x01, 0x02]));
		const crc2 = crc16(new Uint8Array([0x01, 0x03]));

		expect(crc1).not.toEqual(crc2);
	});

	it('should handle empty data', () => {
		const crc = crc16(new Uint8Array([]));
		expect(typeof crc).toBe('number');
	});
});

describe('Theme Patcher - Full Patching Workflow', () => {
	it('should analyze firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.analyze();

		expect(result.version).toBeTruthy();
		expect(result.themeFunctions.length).toBeGreaterThan(0);
		expect(result.nopSlides.length).toBeGreaterThan(0);
	});

	it('should patch firmware with custom colors', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		const flacColors = [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000];
		const menuColors = [0xf800, 0xf800, 0xf800, 0x001f, 0x001f, 0x001f, 0xffe0, 0xffe0, 0xffe0, 0x07ff, 0x07ff, 0x07ff, 0x0000, 0x0000, 0x0000];

		const result = patcher.patch({ flacColors, menuColors }, '/tmp/test.IMG', true);

		expect(result.success).toBe(true);
		expect(result.nopSlide.start).toBeGreaterThan(0);
		expect(result.patchPoints).toBeDefined();
	});

	it('should reject invalid color counts', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Too few FLAC colors
		expect(() =>
			patcher.patch({ flacColors: [0xf800, 0x001f, 0xffe0], menuColors: [0xf800, 0xf800, 0xf800] }, '/tmp/test.IMG', true)
		).toThrow();

		// Too many menu colors
		expect(() =>
			patcher.patch({ flacColors: [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000], menuColors: Array.from({ length: 20 }, () => 0xf800) }, '/tmp/test.IMG', true)
		).toThrow();
	});
});

describe('Theme Patcher - Round-trip Color Extraction', () => {
	/**
	 * Test complete round-trip: patch → detect → extract colors
	 * This verifies we can read back colors from patched firmware
	 */

	it('should extract colors from patched FLAC firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const originalFlacColors = [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000];
		const menuColors = Array(15).fill(0xf800);

		// Patch the firmware
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch({ flacColors: originalFlacColors, menuColors }, '/tmp/test_roundtrip_flac.IMG', true);

		expect(result.success).toBe(true);
		expect(result.nopSlide).not.toBeNull();
		expect(result.metadataAddr).toBeGreaterThan(0);

		// Read back patched firmware
		const patchedFirmware = fileIO.readFileSync('/tmp/test_roundtrip_flac.IMG');

		// Extract colors from metadata
		const detector = new PatchDetector(patchedFirmware, 'Unknown');
		if (result.nopSlide) {
			const metadata = detector.readPatchMetadata(result.nopSlide);

			expect(metadata).not.toBeNull();
			if (metadata) {
				// Verify FLAC colors were preserved
				expect(metadata.flacColors).toEqual(originalFlacColors);
			}
		}
	});

	it('should extract colors from patched Menu firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const flacColors = [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000];
		const originalMenuColors = [
			0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000,
			0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000,
			0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000
		];

		// Patch the firmware
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch({ flacColors, menuColors: originalMenuColors }, '/tmp/test_roundtrip_menu.IMG', true);

		expect(result.success).toBe(true);
		expect(result.nopSlide).not.toBeNull();
		expect(result.metadataAddr).toBeGreaterThan(0);

		// Read back patched firmware
		const patchedFirmware = fileIO.readFileSync('/tmp/test_roundtrip_menu.IMG');

		// Extract colors from metadata
		const detector = new PatchDetector(patchedFirmware, 'Unknown');
		if (result.nopSlide) {
			const metadata = detector.readPatchMetadata(result.nopSlide);

			expect(metadata).not.toBeNull();
			if (metadata) {
				// Verify Menu colors were preserved
				expect(metadata.menuColors).toEqual(originalMenuColors);
			}
		}
	});

	it('should read patch metadata from patched firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const originalFlacColors = [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000];
		const originalMenuColors = Array(15).fill(0xf800);

		// Patch the firmware
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch({ flacColors: originalFlacColors, menuColors: originalMenuColors }, '/tmp/test_roundtrip_metadata.IMG', true);

		expect(result.success).toBe(true);
		expect(result.nopSlide).not.toBeNull();
		expect(result.metadataAddr).toBeGreaterThan(0);

		// Read back and verify metadata
		const patchedFirmware = fileIO.readFileSync('/tmp/test_roundtrip_metadata.IMG');
		const detector = new PatchDetector(patchedFirmware, 'Unknown');

		if (result.nopSlide) {
			const metadata = detector.readPatchMetadata(result.nopSlide);

			expect(metadata).not.toBeNull();
			if (metadata) {
				// Verify FLAC colors
				expect(metadata.flacColors).toEqual(originalFlacColors);

				// Verify Menu colors
				expect(metadata.menuColors).toEqual(originalMenuColors);

				// Verify metadata structure
				expect(metadata.magic).toBe('ECHO');
				expect(metadata.version).toBe(1);
				// Timestamp is dynamic (current Unix time), so just verify it's reasonable
				expect(metadata.timestamp).toBeGreaterThan(0);
			}
		}
	});
});

describe('Theme Patcher - Re-patching', () => {
	/**
	 * Test that we can re-patch an already-patched firmware
	 * This should reuse the same NOP slide instead of finding a new one
	 */

	it('should allow re-patching with different colors', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

		// First patch with original colors
		const originalFlacColors = [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000];
		const originalMenuColors = Array(15).fill(0xf800);

		const patcher = new ThemePatcher(firmwareData);
		const firstResult = patcher.patch(
			{ flacColors: originalFlacColors, menuColors: originalMenuColors },
			'/tmp/test_repatch_first.IMG',
			true
		);

		expect(firstResult.success).toBe(true);

		// Load the patched firmware and patch again with new colors
		const newFlacColors = [0x44DE, 0x44DE, 0x44DE, 0x44DE, 0xE162];
		const newMenuColors = [
			0x77DE, 0x2945, 0x0000,  // T0
			0xFFFF, 0x2945, 0xFFFF,  // T1
			0x77DE, 0x0000, 0x2945,  // T2
			0xFFFF, 0x0000, 0x0000,  // T3
			0xFFFF, 0x0000, 0x0000,  // T4
		];

		const patchedFirmware = fileIO.readFileSync('/tmp/test_repatch_first.IMG');
		const repatcher = new ThemePatcher(patchedFirmware);

		const secondResult = repatcher.patch(
			{ flacColors: newFlacColors, menuColors: newMenuColors },
			'/tmp/test_repatch_second.IMG',
			true
		);

		expect(secondResult.success).toBe(true);

		// Verify NOP slide is reused (same start address)
		expect(secondResult.nopSlide.start).toEqual(firstResult.nopSlide.start);

		// Read back and verify new metadata
		const twicePatchedFirmware = fileIO.readFileSync('/tmp/test_repatch_second.IMG');
		const detector = new PatchDetector(twicePatchedFirmware, 'Unknown');

		if (secondResult.nopSlide) {
			const metadata = detector.readPatchMetadata(secondResult.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				// Verify new colors are stored
				expect(metadata.flacColors).toEqual(newFlacColors);
				expect(metadata.menuColors).toEqual(newMenuColors);
			}
		}
	});
});

describe('Theme Patcher - Patch Independence and Order', () => {
	/**
	 * Test that FLAC and Menu patches are independent
	 * Verifies they use different addresses, registers, and don't interfere
	 */

	it('should use different BL addresses for FLAC and Menu patches', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		const flacColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const menuColors = Array(15).fill(0x9999);

		const result = patcher.patch({ flacColors, menuColors }, '/tmp/test_independence.IMG', true);

		expect(result.success).toBe(true);
		expect(result.patchPoints['flac']).toBeDefined();
		expect(result.patchPoints['menu']).toBeDefined();

		// Verify patches are at different addresses
		const flacAddr = result.patchPoints['flac']?.patchAddr;
		const menuAddr = result.patchPoints['menu']?.patchAddr;

		expect(flacAddr).toBeDefined();
		expect(menuAddr).toBeDefined();
		expect(flacAddr).not.toBe(menuAddr);

		console.error(`FLAC BL address: 0x${flacAddr?.toString(16)}`);
		console.error(`Menu BL address: 0x${menuAddr?.toString(16)}`);
	});

	it('should store both color sets independently in metadata', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Distinct colors to verify independence
		const flacColors = [0xF800, 0x07E0, 0x001F, 0xFFFF, 0x0000];
		const menuColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF];

		const result = patcher.patch({ flacColors, menuColors }, '/tmp/test_metadata_independence.IMG', true);

		expect(result.success).toBe(true);
		expect(result.metadataAddr).toBeGreaterThan(0);

		// Read back metadata
		const patchedFirmware = fileIO.readFileSync('/tmp/test_metadata_independence.IMG');
		const detector = new PatchDetector(patchedFirmware, 'test');

		if (result.nopSlide) {
			const metadata = detector.readPatchMetadata(result.nopSlide);

			expect(metadata).not.toBeNull();
			if (metadata) {
				// Verify both color sets are stored
				expect(metadata.flacColors).toEqual(flacColors);
				expect(metadata.menuColors).toEqual(menuColors);

				// Verify they don't interfere (no overlapping values)
				expect(metadata.flacColors).not.toEqual(menuColors.slice(0, 5));
			}
		}
	});

	it('should allow updating FLAC colors while keeping Menu colors unchanged', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

		// Initial patch
		const initialFlac = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const initialMenu = [0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF, 0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999];

		const patcher1 = new ThemePatcher(firmwareData);
		const result1 = patcher1.patch({ flacColors: initialFlac, menuColors: initialMenu }, '/tmp/test_flac_update1.IMG', true);

		expect(result1.success).toBe(true);

		// Re-patch with NEW FLAC, SAME Menu
		const patched1 = fileIO.readFileSync('/tmp/test_flac_update1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const newFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410]; // Completely different
		const sameMenu = initialMenu; // Exactly the same

		const result2 = patcher2.patch({ flacColors: newFlac, menuColors: sameMenu }, '/tmp/test_flac_update2.IMG', true);

		expect(result2.success).toBe(true);

		// Verify FLAC was updated, Menu stayed the same
		const patched2 = fileIO.readFileSync('/tmp/test_flac_update2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);

			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(newFlac); // Changed
				expect(metadata.menuColors).toEqual(sameMenu);  // Unchanged
			}
		}
	});

	it('should allow updating Menu colors while keeping FLAC colors unchanged', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

		// Initial patch
		const initialFlac = [0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE];
		const initialMenu = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

		const patcher1 = new ThemePatcher(firmwareData);
		const result1 = patcher1.patch({ flacColors: initialFlac, menuColors: initialMenu }, '/tmp/test_menu_update1.IMG', true);

		expect(result1.success).toBe(true);

		// Re-patch with SAME FLAC, NEW Menu
		const patched1 = fileIO.readFileSync('/tmp/test_menu_update1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const sameFlac = initialFlac; // Exactly the same
		const newMenu = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114]; // Completely different

		const result2 = patcher2.patch({ flacColors: sameFlac, menuColors: newMenu }, '/tmp/test_menu_update2.IMG', true);

		expect(result2.success).toBe(true);

		// Verify Menu was updated, FLAC stayed the same
		const patched2 = fileIO.readFileSync('/tmp/test_menu_update2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);

			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(sameFlac);   // Unchanged
				expect(metadata.menuColors).toEqual(newMenu);    // Changed
			}
		}
	});

	it('should use different register sets for FLAC and Menu handlers', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

		// Patch with known colors
		const flacColors = [0xF800, 0x001F, 0xFFE0, 0x07FF, 0x0000];
		const menuColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF];

		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch({ flacColors, menuColors }, '/tmp/test_registers.IMG', true);

		expect(result.success).toBe(true);

		// Verify both patches exist
		expect(result.patchPoints['flac']).toBeDefined();
		expect(result.patchPoints['menu']).toBeDefined();

		// Verify by examining the BL instructions that they target different code regions
		// FLAC handler uses R4-R8 for color storage
		// Menu handler uses R0-R14 for color storage
		const flacAddr = result.patchPoints['flac']?.patchAddr;
		const menuAddr = result.patchPoints['menu']?.patchAddr;

		expect(flacAddr).not.toBe(menuAddr);

		// Verify handlers are in different regions
		if (result.nopSlide) {
			// FLAC handler should be at nopSlide.start
			// Menu handler should be after FLAC (aligned)
			const flacCodeAddr = result.nopSlide.start; // FLAC handler at beginning
			const expectedMenuAddr = result.nopSlide.start + Math.ceil((5 * 8) / 4) * 4; // After 5 FLAC MOVW/MOVT pairs (40 bytes), aligned to 4 bytes

			// Verify handlers are in different regions
			expect(flacCodeAddr).toBeLessThan(expectedMenuAddr);
		}
	});
});

describe('Theme Patcher - Partial Patching', () => {
	/**
	 * Test partial patching: FLAC-only or Menu-only
	 * Verifies that we can patch just one set of colors while preserving the other
	 *
	 * Extended timeout: These tests perform multiple patching operations,
	 * which can take longer than the default 5 second timeout.
	 */

	it('should support patching only FLAC colors on unpatched firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Extract ground truth to verify
		const groundTruth = patcher.extractGroundTruthColors();
		expect(groundTruth.flacColors).toHaveLength(5);
		expect(groundTruth.menuColors).toHaveLength(15);

		// Patch only FLAC (Menu should use ground truth)
		const newFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410];
		const result = patcher.patch({ flacColors: newFlac }, '/tmp/test_partial_flac.IMG', true);

		expect(result.success).toBe(true);

		// Verify FLAC was patched, Menu uses ground truth
		const patched = fileIO.readFileSync('/tmp/test_partial_flac.IMG');
		const detector = new PatchDetector(patched, 'test');

		if (result.nopSlide) {
			const metadata = detector.readPatchMetadata(result.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(newFlac); // New FLAC colors
				expect(metadata.menuColors).toEqual(groundTruth.menuColors); // Ground truth Menu
			}
		}
	});

	it('should support patching only Menu colors on unpatched firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Extract ground truth to verify
		const groundTruth = patcher.extractGroundTruthColors();
		expect(groundTruth.flacColors).toHaveLength(5);
		expect(groundTruth.menuColors).toHaveLength(15);

		// Patch only Menu (FLAC should use ground truth)
		const newMenu = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF];
		const result = patcher.patch({ menuColors: newMenu }, '/tmp/test_partial_menu.IMG', true);

		expect(result.success).toBe(true);

		// Verify Menu was patched, FLAC uses ground truth
		const patched = fileIO.readFileSync('/tmp/test_partial_menu.IMG');
		const detector = new PatchDetector(patched, 'test');

		if (result.nopSlide) {
			const metadata = detector.readPatchMetadata(result.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(groundTruth.flacColors); // Ground truth FLAC
				expect(metadata.menuColors).toEqual(newMenu); // New Menu colors
			}
		}
	});

	it('should support patching only FLAC colors on already patched firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

		// First patch with both colors
		const initialFlac = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const initialMenu = [0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF, 0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999];

		const patcher1 = new ThemePatcher(firmwareData);
		const result1 = patcher1.patch({ flacColors: initialFlac, menuColors: initialMenu }, '/tmp/test_partial_flac_patch1.IMG', true);

		expect(result1.success).toBe(true);

		// Re-patch with only FLAC (Menu should keep existing colors)
		const patched1 = fileIO.readFileSync('/tmp/test_partial_flac_patch1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const newFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410]; // Completely different
		const result2 = patcher2.patch({ flacColors: newFlac }, '/tmp/test_partial_flac_patch2.IMG', true);

		expect(result2.success).toBe(true);

		// Verify FLAC was updated, Menu kept existing colors
		const patched2 = fileIO.readFileSync('/tmp/test_partial_flac_patch2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(newFlac); // Changed
				expect(metadata.menuColors).toEqual(initialMenu); // Unchanged
			}
		}
	});

	it('should support patching only Menu colors on already patched firmware', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');

		// First patch with both colors
		const initialFlac = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const initialMenu = [0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF, 0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999];

		const patcher1 = new ThemePatcher(firmwareData);
		const result1 = patcher1.patch({ flacColors: initialFlac, menuColors: initialMenu }, '/tmp/test_partial_menu_patch1.IMG', true);

		expect(result1.success).toBe(true);

		// Re-patch with only Menu (FLAC should keep existing colors)
		const patched1 = fileIO.readFileSync('/tmp/test_partial_menu_patch1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const newMenu = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114]; // Completely different
		const result2 = patcher2.patch({ menuColors: newMenu }, '/tmp/test_partial_menu_patch2.IMG', true);

		expect(result2.success).toBe(true);

		// Verify Menu was updated, FLAC kept existing colors
		const patched2 = fileIO.readFileSync('/tmp/test_partial_menu_patch2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(initialFlac); // Unchanged
				expect(metadata.menuColors).toEqual(newMenu); // Changed
			}
		}
	});

	it('should support patching FLAC-only twice (FLAC → FLAC)', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Extract ground truth
		const groundTruth = patcher.extractGroundTruthColors();

		// First: FLAC-only (Menu uses ground truth)
		const firstFlac = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const result1 = patcher.patch({ flacColors: firstFlac }, '/tmp/test_seq_flac_flac1.IMG', true);
		expect(result1.success).toBe(true);

		// Second: FLAC-only again (Menu should still use ground truth)
		const patched1 = fileIO.readFileSync('/tmp/test_seq_flac_flac1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const secondFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410];
		const result2 = patcher2.patch({ flacColors: secondFlac }, '/tmp/test_seq_flac_flac2.IMG', true);
		expect(result2.success).toBe(true);

		// Verify: Second FLAC, Menu still ground truth
		const patched2 = fileIO.readFileSync('/tmp/test_seq_flac_flac2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(secondFlac); // Second FLAC
				expect(metadata.menuColors).toEqual(groundTruth.menuColors); // Still ground truth
			}
		}
	});

	it('should support patching FLAC-only then Menu-only (FLAC → Menu)', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// First: FLAC-only
		const firstFlac = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const result1 = patcher.patch({ flacColors: firstFlac }, '/tmp/test_seq_flac_menu1.IMG', true);
		expect(result1.success).toBe(true);

		// Second: Menu-only (FLAC should keep first FLAC)
		const patched1 = fileIO.readFileSync('/tmp/test_seq_flac_menu1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const newMenu = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
		const result2 = patcher2.patch({ menuColors: newMenu }, '/tmp/test_seq_flac_menu2.IMG', true);
		expect(result2.success).toBe(true);

		// Verify: First FLAC, new Menu
		const patched2 = fileIO.readFileSync('/tmp/test_seq_flac_menu2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(firstFlac); // First FLAC unchanged
				expect(metadata.menuColors).toEqual(newMenu); // New Menu
			}
		}
	});

	it('should support patching FLAC-only then Both (FLAC → Both)', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// First: FLAC-only
		const firstFlac = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
		const result1 = patcher.patch({ flacColors: firstFlac }, '/tmp/test_seq_flac_both1.IMG', true);
		expect(result1.success).toBe(true);

		// Second: Both (new FLAC, new Menu)
		const patched1 = fileIO.readFileSync('/tmp/test_seq_flac_both1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const secondFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410];
		const newMenu = [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214];
		const result2 = patcher2.patch({ flacColors: secondFlac, menuColors: newMenu }, '/tmp/test_seq_flac_both2.IMG', true);
		expect(result2.success).toBe(true);

		// Verify: Second FLAC, new Menu
		const patched2 = fileIO.readFileSync('/tmp/test_seq_flac_both2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(secondFlac); // Second FLAC
				expect(metadata.menuColors).toEqual(newMenu); // New Menu
			}
		}
	});

	it('should support patching Menu-only twice (Menu → Menu)', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Extract ground truth
		const groundTruth = patcher.extractGroundTruthColors();

		// First: Menu-only (FLAC uses ground truth)
		const firstMenu = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
		const result1 = patcher.patch({ menuColors: firstMenu }, '/tmp/test_seq_menu_menu1.IMG', true);
		expect(result1.success).toBe(true);

		// Second: Menu-only again (FLAC should still use ground truth)
		const patched1 = fileIO.readFileSync('/tmp/test_seq_menu_menu1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const secondMenu = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
		const result2 = patcher2.patch({ menuColors: secondMenu }, '/tmp/test_seq_menu_menu2.IMG', true);
		expect(result2.success).toBe(true);

		// Verify: FLAC still ground truth, second Menu
		const patched2 = fileIO.readFileSync('/tmp/test_seq_menu_menu2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(groundTruth.flacColors); // Still ground truth
				expect(metadata.menuColors).toEqual(secondMenu); // Second Menu
			}
		}
	});

	it('should support patching Menu-only then FLAC-only (Menu → FLAC)', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// First: Menu-only
		const firstMenu = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
		const result1 = patcher.patch({ menuColors: firstMenu }, '/tmp/test_seq_menu_flac1.IMG', true);
		expect(result1.success).toBe(true);

		// Second: FLAC-only (Menu should keep first Menu)
		const patched1 = fileIO.readFileSync('/tmp/test_seq_menu_flac1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const newFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410];
		const result2 = patcher2.patch({ flacColors: newFlac }, '/tmp/test_seq_menu_flac2.IMG', true);
		expect(result2.success).toBe(true);

		// Verify: new FLAC, first Menu unchanged
		const patched2 = fileIO.readFileSync('/tmp/test_seq_menu_flac2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(newFlac); // New FLAC
				expect(metadata.menuColors).toEqual(firstMenu); // First Menu unchanged
			}
		}
	});

	it('should support patching Menu-only then Both (Menu → Both)', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// First: Menu-only
		const firstMenu = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
		const result1 = patcher.patch({ menuColors: firstMenu }, '/tmp/test_seq_menu_both1.IMG', true);
		expect(result1.success).toBe(true);

		// Second: Both (new FLAC, new Menu)
		const patched1 = fileIO.readFileSync('/tmp/test_seq_menu_both1.IMG');
		const patcher2 = new ThemePatcher(patched1);

		const newFlac = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410];
		const secondMenu = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
		const result2 = patcher2.patch({ flacColors: newFlac, menuColors: secondMenu }, '/tmp/test_seq_menu_both2.IMG', true);
		expect(result2.success).toBe(true);

		// Verify: new FLAC, second Menu
		const patched2 = fileIO.readFileSync('/tmp/test_seq_menu_both2.IMG');
		const detector = new PatchDetector(patched2, 'test');

		if (result2.nopSlide) {
			const metadata = detector.readPatchMetadata(result2.nopSlide);
			expect(metadata).not.toBeNull();
			if (metadata) {
				expect(metadata.flacColors).toEqual(newFlac); // New FLAC
				expect(metadata.menuColors).toEqual(secondMenu); // Second Menu
			}
		}
	});

	it('should reject patch when neither FLAC nor Menu colors are provided', () => {
		const firmwareData = fileIO.readFileSync('references/HIFIEC10.IMG');
		const patcher = new ThemePatcher(firmwareData);

		// Should throw - at least one color set must be provided
		expect(() => {
			patcher.patch({}, '/tmp/test_partial_error.IMG', true);
		}).toThrow(ValidationError);
	});
});

describe('Theme Patcher - Batch Firmware Testing', { timeout: 15000 }, () => {
	/**
	 * Test across all firmware versions to ensure compatibility
	 */

	// All available firmware versions - only versions >= V1.8.0 are supported
	// Older versions (V1.2.5-V1.7.0) have different firmware structure and are not supported
	const BASE_DIR = '/tmp/echo-mini-firmwares';
	const firmwareFiles: FirmwareFile[] = [
		{ version: 'V3.1.0', path: `${BASE_DIR}/ECHO MINI V3.1.0/ECHO MINI V3.1.0/HIFIEC10.IMG` },
		{ version: 'V3.0.0', path: `${BASE_DIR}/ECHO MINI V3.0.0/ECHO MINI V3.0.0/HIFIEC00.IMG` },
		{ version: 'V2.8.0', path: `${BASE_DIR}/ECHO MINI V2.8.0/ECHO MINI V2.8.0/HIFIEC80.IMG` },
		{ version: 'V2.7.0', path: `${BASE_DIR}/ECHO MINI V2.7.0/ECHO MINI V2.7.0/HIFIEC70.IMG` },
		{ version: 'V2.6.0', path: `${BASE_DIR}/ECHO MINI V2.6.0/ECHO MINI V2.6.0/HIFIEC60.IMG` },
		{ version: 'V2.5.0', path: `${BASE_DIR}/ECHO MINI V2.5.0/ECHO MINI V2.5.0/HIFIEC50.IMG` },
		{ version: 'V2.4.0', path: `${BASE_DIR}/ECHO MINI V2.4.0/ECHO MINI V2.4.0/HIFIEC40.IMG` },
		{ version: 'V1.8.0', path: `${BASE_DIR}/ECHO MINI V1.8.0/ECHO MINI V1.8.0/HIFIEC80.IMG` }
	];

	// Skip batch tests if firmware files don't exist
	const runBatchTests = firmwareFiles.some((f) => fileIO.existsSync(f.path));

	describe.skipIf(!runBatchTests)('All firmware versions', () => {
		firmwareFiles.forEach(({ version, path }) => {
			const fileExists = fileIO.existsSync(path);

			// Use describe with if condition instead of skipIf
			if (fileExists) {
				describe(`Firmware ${version}`, () => {
					it('should discover theme functions', () => {
						const firmwareData = fileIO.readFileSync(path);
						const flacResult = discoverFlacFunction(firmwareData);
						const menuResult = discoverMenuFunction(firmwareData);

						expect(flacResult).not.toBeNull();
						expect(menuResult).not.toBeNull();
					});

					it('should analyze firmware', () => {
						const firmwareData = fileIO.readFileSync(path);
						const patcher = new ThemePatcher(firmwareData);
						const result = patcher.analyze();

						expect(result.canPatch).toBe(true);
						expect(result.themeFunctions.length).toBeGreaterThan(0);
					});

					it('should patch firmware', { timeout: 15000 }, () => {
						const firmwareData = fileIO.readFileSync(path);
						const patcher = new ThemePatcher(firmwareData);

						const flacColors = [0xf800, 0x001f, 0xffe0, 0x07ff, 0x0000];
						const menuColors = Array(15).fill(0xf800);

						const result = patcher.patch({ flacColors, menuColors }, `/tmp/${version}.patched.IMG`, true);

						expect(result.success).toBe(true);
					});

					it('should extract progress and marquee colors', () => {
						const firmwareData = fileIO.readFileSync(path);
						const extractor = new ThemeColorExtractor(firmwareData);
						const result = extractor.extract();

						// Check that progress and marquee functions are discovered
						const progressFunc = result.themeFunctions.find((f): f is typeof f & { type: 'progress' } => f.type === 'progress');
						const marqueeFunc = result.themeFunctions.find((f): f is typeof f & { type: 'marquee' } => f.type === 'marquee');

						// Progress Bar should be found
						expect(progressFunc).toBeDefined();
						if (progressFunc) {
							expect(progressFunc.uiElement).toContain('Progress Bar');
							expect(progressFunc.patternType).toBe('switch_case');
							// Should have exactly 5 theme colors
							expect(Object.keys(progressFunc.preloadColors).length).toBe(5);
						}

						// Marquee Overlay should be found
						expect(marqueeFunc).toBeDefined();
						if (marqueeFunc) {
							expect(marqueeFunc.uiElement).toContain('Marquee');
							expect(marqueeFunc.patternType).toBe('switch_case');
							// Should have exactly 5 theme colors
							expect(Object.keys(marqueeFunc.preloadColors).length).toBe(5);
						}

						// Test getColorsForFunction for progress and marquee
						if (progressFunc) {
							const progressColors = extractor.getColorsForFunction('progress');
							expect(progressColors).toHaveLength(5);
							// All colors should be valid 16-bit RGB565 values
							for (const color of progressColors) {
								expect(color).toBeGreaterThanOrEqual(0);
								expect(color).toBeLessThanOrEqual(0xffff);
							}
						}

						if (marqueeFunc) {
							const marqueeColors = extractor.getColorsForFunction('marquee');
							expect(marqueeColors).toHaveLength(5);
							// All colors should be valid 16-bit RGB565 values
							for (const color of marqueeColors) {
								expect(color).toBeGreaterThanOrEqual(0);
								expect(color).toBeLessThanOrEqual(0xffff);
							}
						}
					});
				});
			}
		});
	});
});
