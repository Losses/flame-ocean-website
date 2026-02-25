/**
 * Theme Patching Round-Trip Tests
 *
 * Tests the complete patching flow: extract → patch → extract → verify
 * This ensures colors are correctly preserved through the patching process.
 *
 * Prerequisites:
 * - Run: bun run src/lib/rse/__tests__/setup-fixtures.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { extractThemeColors } from '../theme/index.js';
import { discoverFlacFunction, discoverMenuFunction } from '../theme/discovery.js';
import { ThemePatcher } from '../theme/patcher.js';

// Configuration
const BASE_DOWNLOAD_DIR = '/tmp/echo-mini-firmwares';

/**
 * Test firmware versions - all versions from V1.8.0 onwards that support theme customization
 */
const TEST_FIRMWARES = [
	{ version: 'ECHO MINI V1.8.0', filename: 'HIFIEC80.IMG' },
	{ version: 'ECHO MINI V2.4.0', filename: 'HIFIEC40.IMG' },
	{ version: 'ECHO MINI V2.5.0', filename: 'HIFIEC50.IMG' },
	{ version: 'ECHO MINI V2.6.0', filename: 'HIFIEC60.IMG' },
	{ version: 'ECHO MINI V2.7.0', filename: 'HIFIEC70.IMG' },
	{ version: 'ECHO MINI V2.8.0', filename: 'HIFIEC80.IMG' },
	{ version: 'ECHO MINI V3.0.0', filename: 'HIFIEC00.IMG' },
	{ version: 'ECHO MINI V3.1.0', filename: 'HIFIEC10.IMG' },
	{ version: 'ECHO MINI V3.2.0', filename: 'HIFIEC20.IMG' }
];

/**
 * Load firmware from local filesystem
 */
function loadFirmware(version: string, filename: string): Uint8Array {
	// Try nested directory structure first (most versions)
	let firmwarePath = join(BASE_DOWNLOAD_DIR, version, version, filename);

	// Fallback to flat directory structure (some older versions)
	if (!existsSync(firmwarePath)) {
		firmwarePath = join(BASE_DOWNLOAD_DIR, version, filename);
	}

	if (!existsSync(firmwarePath)) {
		throw new Error(`Firmware not found: ${firmwarePath}\nRun: bun run src/lib/rse/__tests__/setup-fixtures.ts`);
	}
	const buffer = readFileSync(firmwarePath);
	return new Uint8Array(buffer);
}

describe('Theme Patching Round-Trip Tests', () => {
	beforeAll(() => {
		// Check if fixtures exist
		const needsSetup = !TEST_FIRMWARES.every(fw => {
			const firmwarePath = join(BASE_DOWNLOAD_DIR, fw.version, fw.version, fw.filename);
			return existsSync(firmwarePath);
		});

		if (needsSetup) {
			console.log('\nSetting up test fixtures...');
			try {
				execSync('bun run src/lib/rse/__tests__/setup-fixtures.ts', { stdio: 'inherit' });
			} catch (error) {
				throw new Error(`Failed to set up fixtures: ${error}`);
			}
		}
	}, 300000);

	describe('FLAC Color Round-Trip', () => {
		for (const { version, filename } of TEST_FIRMWARES) {
			describe(`${version} (${filename})`, () => {
				let originalData: Uint8Array;

				beforeAll(() => {
					originalData = loadFirmware(version, filename);
				});

				it('should discover FLAC function', () => {
					const result = discoverFlacFunction(originalData);
					expect(result).not.toBeNull();
					const [funcAddr, patchAddr] = result!;
					expect(funcAddr).toBeGreaterThan(0);
					expect(patchAddr).toBeGreaterThan(0);
				});

				it('should extract original FLAC colors from unpatched firmware', () => {
					const result = extractThemeColors(originalData);

					expect(result.flacBehavior.isFlac).toBe(true);
					expect(result.flacBehavior.type).toBe('standard');

					// Original firmware should have colorFor4 and colorForOther
					expect(result.flacBehavior.colorFor4).toBeDefined();
					expect(result.flacBehavior.colorForOther).toBeDefined();

					// flacColors array should NOT be present in unpatched firmware
					expect(result.flacBehavior.flacColors).toBeUndefined();
				});

				it('should patch firmware with custom FLAC colors', () => {
					const testColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];

					const patcher = new ThemePatcher(originalData, version);
					const result = patcher.patch(
						{ flacColors: testColors },
						`/tmp/${filename}-flac-patched.IMG`
					);

					expect(result.success).toBe(true);
					expect(result.metadataAddr).toBeGreaterThan(0);

					// Verify patched file was created
					expect(existsSync(`/tmp/${filename}-flac-patched.IMG`)).toBe(true);
				});

				it('should extract patched FLAC colors correctly (round-trip test)', () => {
					const testColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];

					// Patch firmware
					const patcher = new ThemePatcher(originalData, version);
					const patchResult = patcher.patch(
						{ flacColors: testColors },
						`/tmp/${filename}-flac-patched.IMG`
					);
					expect(patchResult.success).toBe(true);

					// Load patched firmware
					const patchedData = readFileSync(`/tmp/${filename}-flac-patched.IMG`);

					// Extract colors from patched firmware
					const extracted = extractThemeColors(patchedData);

					// CRITICAL: flacColors array should be present in patched firmware
					expect(extracted.flacBehavior.isFlac).toBe(true);
					expect(extracted.flacBehavior.flacColors).toBeDefined();
					expect(extracted.flacBehavior.flacColors?.length).toBe(5);

					// Verify all 5 colors match
					for (let i = 0; i < 5; i++) {
						expect(extracted.flacBehavior.flacColors![i]).toBe(testColors[i]);
					}
				});

				it('should preserve different colors for each theme', () => {
					// Test with distinct colors to ensure each theme gets its own color
					const testColors = [0x1234, 0x5678, 0x9ABC, 0xDEF0, 0x2468];

					const patcher = new ThemePatcher(originalData, version);
					patcher.patch({ flacColors: testColors }, `/tmp/${filename}-flac-distinct.IMG`);

					const patchedData = readFileSync(`/tmp/${filename}-flac-distinct.IMG`);
					const extracted = extractThemeColors(patchedData);

					// All 5 colors should be distinct
					expect(extracted.flacBehavior.flacColors![0]).toBe(0x1234);
					expect(extracted.flacBehavior.flacColors![1]).toBe(0x5678);
					expect(extracted.flacBehavior.flacColors![2]).toBe(0x9ABC);
					expect(extracted.flacBehavior.flacColors![3]).toBe(0xDEF0);
					expect(extracted.flacBehavior.flacColors![4]).toBe(0x2468);
				});

				it('should support re-patching with different colors', () => {
					// First patch
					const firstColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
					let patcher = new ThemePatcher(originalData, version);
					patcher.patch({ flacColors: firstColors }, `/tmp/${filename}-flac-repatch1.IMG`);

					// Second patch (re-patch)
					const secondColors = [0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE];
					const firstPatched = readFileSync(`/tmp/${filename}-flac-repatch1.IMG`);
					patcher = new ThemePatcher(firstPatched, version);
					patcher.patch({ flacColors: secondColors }, `/tmp/${filename}-flac-repatch2.IMG`);

					// Verify second patch colors
					const secondPatchedData = readFileSync(`/tmp/${filename}-flac-repatch2.IMG`);
					const extracted = extractThemeColors(secondPatchedData);

					expect(extracted.flacBehavior.flacColors![0]).toBe(0xAAAA);
					expect(extracted.flacBehavior.flacColors![1]).toBe(0xBBBB);
					expect(extracted.flacBehavior.flacColors![2]).toBe(0xCCCC);
					expect(extracted.flacBehavior.flacColors![3]).toBe(0xDDDD);
					expect(extracted.flacBehavior.flacColors![4]).toBe(0xEEEE);
				});
			});
		}
	});

	describe('Menu Color Round-Trip', () => {
		for (const { version, filename } of TEST_FIRMWARES) {
			describe(`${version} (${filename})`, () => {
				let originalData: Uint8Array;

				beforeAll(() => {
					originalData = loadFirmware(version, filename);
				});

				it('should discover Menu function', () => {
					const result = discoverMenuFunction(originalData);
					expect(result).not.toBeNull();
					const [funcAddr, patchAddr] = result!;
					expect(funcAddr).toBeGreaterThan(0);
					expect(patchAddr).toBeGreaterThan(0);
				});

				it('should patch and extract Menu colors (15 colors × 5 themes = 75 total)', () => {
					// Menu has 15 colors per theme
					const testColors: number[] = [];
					for (let i = 0; i < 15; i++) {
						testColors.push(0x1000 + i);
					}

					const patcher = new ThemePatcher(originalData, version);
					const result = patcher.patch(
						{ menuColors: testColors },
						`/tmp/${filename}-menu-patched.IMG`
					);

					expect(result.success).toBe(true);

					// Extract and verify
					const patchedData = readFileSync(`/tmp/${filename}-menu-patched.IMG`);
					const extracted = extractThemeColors(patchedData);

					const menuFunc = extracted.themeFunctions.find(f => f.type === 'menu');
					expect(menuFunc).toBeDefined();

					// Should have color writes for all themes
					const writesByTheme = new Map<number, Set<number>>();
					for (const write of menuFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, new Set());
						}
						writesByTheme.get(themeId)!.add(write.targetReg);
					}

					// All 5 themes should be present
					expect(writesByTheme.size).toBeGreaterThanOrEqual(5);
				});
			});
		}
	});

	describe('Combined FLAC + Menu Patching', () => {
		for (const { version, filename } of TEST_FIRMWARES) {
			it(`${version} should patch both FLAC and Menu colors simultaneously`, () => {
				const originalData = loadFirmware(version, filename);

				const flacColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];
				const menuColors: number[] = [];
				for (let i = 0; i < 15; i++) {
					menuColors.push(0x2000 + i);
				}

				const patcher = new ThemePatcher(originalData, version);
				const result = patcher.patch(
					{ flacColors, menuColors },
					`/tmp/${filename}-both-patched.IMG`
				);

				expect(result.success).toBe(true);
				expect(result.patchPoints['flac']).toBeDefined();
				expect(result.patchPoints['menu']).toBeDefined();

				// Extract and verify both
				const patchedData = readFileSync(`/tmp/${filename}-both-patched.IMG`);
				const extracted = extractThemeColors(patchedData);

				// Verify FLAC
				expect(extracted.flacBehavior.flacColors).toEqual(flacColors);

				// Verify Menu
				const menuFunc = extracted.themeFunctions.find(f => f.type === 'menu');
				expect(menuFunc).toBeDefined();
			});
		}
	});

	describe('Metadata Integrity', () => {
		it('should write valid metadata with correct magic string', () => {
			const version = 'ECHO MINI V2.4.0';
			const filename = 'HIFIEC40.IMG';
			const originalData = loadFirmware(version, filename);

			const flacColors = [0x1111, 0x2222, 0x3333, 0x4444, 0x5555];

			const patcher = new ThemePatcher(originalData, version);
			patcher.patch({ flacColors }, `/tmp/${filename}-metadata-test.IMG`);

			const patchedData = readFileSync(`/tmp/${filename}-metadata-test.IMG`);

			// Find ECHO magic string (should be the last one in the file)
			let echoAddr = -1;
			for (let i = patchedData.length - 51; i >= 0; i--) {
				if (patchedData[i] === 0x45 && // E
				    patchedData[i + 1] === 0x43 && // C
				    patchedData[i + 2] === 0x48 && // H
				    patchedData[i + 3] === 0x4f) { // O
					echoAddr = i;
					break;
				}
			}

			expect(echoAddr).toBeGreaterThan(0);

			// Verify metadata structure
			expect(patchedData[echoAddr]).toBe(0x45); // E
			expect(patchedData[echoAddr + 1]).toBe(0x43); // C
			expect(patchedData[echoAddr + 2]).toBe(0x48); // H
			expect(patchedData[echoAddr + 3]).toBe(0x4f); // O
			expect(patchedData[echoAddr + 4]).toBe(1); // Version

			// Verify FLAC colors at offset 9
			for (let i = 0; i < 5; i++) {
				const offset = echoAddr + 9 + i * 2;
				const color = patchedData[offset] | (patchedData[offset + 1] << 8);
				expect(color).toBe(flacColors[i]);
			}
		});

		it('should handle multiple ECHO strings correctly (find the last one)', () => {
			const version = 'ECHO MINI V2.4.0';
			const filename = 'HIFIEC40.IMG';
			const originalData = loadFirmware(version, filename);

			// Original firmware has multiple ECHO strings
			// Count them before patching
			let echoCountBefore = 0;
			for (let i = 0; i < originalData.length - 4; i++) {
				if (originalData[i] === 0x45 &&
				    originalData[i + 1] === 0x43 &&
				    originalData[i + 2] === 0x48 &&
				    originalData[i + 3] === 0x4f) {
					echoCountBefore++;
				}
			}

			expect(echoCountBefore).toBeGreaterThan(0);

			// Patch adds one more ECHO (the metadata)
			const flacColors = [0x9999, 0x9999, 0x9999, 0x9999, 0x9999];
			const patcher = new ThemePatcher(originalData, version);
			patcher.patch({ flacColors }, `/tmp/${filename}-multi-echo.IMG`);

			const patchedData = readFileSync(`/tmp/${filename}-multi-echo.IMG`);

			// Should have one more ECHO than before
			let echoCountAfter = 0;
			let lastEchoAddr = -1;
			for (let i = 0; i < patchedData.length - 4; i++) {
				if (patchedData[i] === 0x45 &&
				    patchedData[i + 1] === 0x43 &&
				    patchedData[i + 2] === 0x48 &&
				    patchedData[i + 3] === 0x4f) {
					echoCountAfter++;
					lastEchoAddr = i;
				}
			}

			expect(echoCountAfter).toBe(echoCountBefore + 1);

			// The last ECHO should be our metadata
			const extracted = extractThemeColors(patchedData);
			expect(extracted.flacBehavior.flacColors).toEqual(flacColors);
		});
	});

	describe('Error Handling', () => {
		it('should reject invalid FLAC color arrays', () => {
			const version = 'ECHO MINI V2.4.0';
			const filename = 'HIFIEC40.IMG';
			const originalData = loadFirmware(version, filename);

			const patcher = new ThemePatcher(originalData, version);

			// Wrong number of colors
			expect(() => {
				patcher.patch({ flacColors: [0x1111, 0x2222] }, `/tmp/${filename}-invalid.IMG`);
			}).toThrow();
		});

		it('should reject invalid Menu color arrays', () => {
			const version = 'ECHO MINI V2.4.0';
			const filename = 'HIFIEC40.IMG';
			const originalData = loadFirmware(version, filename);

			const patcher = new ThemePatcher(originalData, version);

			// Wrong number of colors
			expect(() => {
				patcher.patch({ menuColors: [0x1111, 0x2222] }, `/tmp/${filename}-invalid.IMG`);
			}).toThrow();
		});
	});
});
