/**
 * Theme Extraction Integration Tests
 *
 * Tests actual firmware files and validates color extraction against ground truth.
 * This ensures the simulator correctly extracts all theme colors for all firmware versions.
 *
 * Prerequisites:
 * - Run: bun run src/lib/rse/__tests__/setup-fixtures.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { extractThemeColors } from '../theme/index.js';
import type { ColorWrite } from '../theme/types.js';

// Configuration - same as setup-fixtures.ts
const BASE_DOWNLOAD_DIR = '/tmp/echo-mini-firmwares';

/**
 * Ground truth data for Menu colors (R1, R2, R3 registers)
 * Format: [R1_color, R2_color, R3_color]
 */
interface MenuColors {
	theme0: [number, number, number];
	theme1: [number, number, number];
	theme2: [number, number, number];
	theme3: [number, number, number];
	theme4: [number, number, number];
}

/**
 * Ground truth data for FLAC colors
 */
interface FlacColors {
	themes0to3: number;
	theme4: number;
}

/**
 * Ground truth data for Progress Bar colors
 */
interface ProgressColors {
	theme0: number;
	theme1: number;
	theme2: number;
	theme3: number;
	theme4: number;
}

/**
 * Ground truth data for Marquee colors
 */
interface MarqueeColors {
	theme0: number;
	theme1: number;
	theme2: number;
	theme3: number;
	theme4: number;
}

/**
 * Complete ground truth for a firmware version
 */
interface FirmwareGroundTruth {
	version: string;
	filename: string;
	menuFuncAddr: number;
	menuColors: MenuColors;
	flacFuncAddr: number;
	flacColors: FlacColors;
	progressFuncAddr: number;
	progressColors: ProgressColors;
	marqueeFuncAddr: number;
	marqueeColors: MarqueeColors;
}

/**
 * Ground truth extracted from all firmware versions (V1.8.0 - V3.2.0)
 * Theme system was introduced in V1.8.0, earlier versions don't support theme customization
 */
const GROUND_TRUTH: FirmwareGroundTruth[] = [
	{
		version: 'ECHO MINI V1.8.0',
		filename: 'HIFIEC80.IMG',
		menuFuncAddr: 0x3F796,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x84DC2,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x8536E,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D1AC,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V2.4.0',
		filename: 'HIFIEC40.IMG',
		menuFuncAddr: 0x3F87E,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x86508,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x86ABC,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D218,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V2.5.0',
		filename: 'HIFIEC50.IMG',
		menuFuncAddr: 0x3F806,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x865AC,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x86B60,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D1A0,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V2.6.0',
		filename: 'HIFIEC60.IMG',
		menuFuncAddr: 0x3F806,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x8669C,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x86C50,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D1A0,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V2.7.0',
		filename: 'HIFIEC70.IMG',
		menuFuncAddr: 0x3F81E,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x867A8,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x86D5C,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D1CC,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V2.8.0',
		filename: 'HIFIEC80.IMG',
		menuFuncAddr: 0x3F9A6,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x8692C,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x86EE0,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D34C,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V3.0.0',
		filename: 'HIFIEC00.IMG',
		menuFuncAddr: 0x3F86E,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x86958,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x86F0C,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3CFD0,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V3.1.0',
		filename: 'HIFIEC10.IMG',
		menuFuncAddr: 0x3F862,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x86CB0,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x87264,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3CFC4,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	},
	{
		version: 'ECHO MINI V3.2.0',
		filename: 'HIFIEC20.IMG',
		menuFuncAddr: 0x3F8AE,
		menuColors: {
			theme0: [0x77DE, 0x2945, 0x0000],
			theme1: [0xFFFF, 0x2945, 0xFFFF],
			theme2: [0x77DE, 0x0000, 0x2945],
			theme3: [0xFFFF, 0x0000, 0x0000],
			theme4: [0xFFFF, 0x0000, 0x0000]
		},
		flacFuncAddr: 0x86CFC,
		flacColors: {
			themes0to3: 0x44DE,
			theme4: 0xE162
		},
		progressFuncAddr: 0x872B0,
		progressColors: {
			theme0: 0x632C,
			theme1: 0x10A2,
			theme2: 0xFD55,
			theme3: 0x2B6F,
			theme4: 0xB2A0
		},
		marqueeFuncAddr: 0x3D010,
		marqueeColors: {
			theme0: 0xEF5D,
			theme1: 0x10C3,
			theme2: 0xFF1C,
			theme3: 0xC6FC,
			theme4: 0xCC29
		}
	}
];

/**
 * Load firmware from local filesystem
 */
function loadFirmware(version: string, filename: string): Uint8Array {
	// Try nested directory structure first (most versions)
	let firmwarePath = join(BASE_DOWNLOAD_DIR, version, version, filename);

	// Fallback to flat directory structure (some older versions like V1.4.0, V1.4.6)
	if (!existsSync(firmwarePath)) {
		firmwarePath = join(BASE_DOWNLOAD_DIR, version, filename);
	}

	if (!existsSync(firmwarePath)) {
		throw new Error(`Firmware not found: ${firmwarePath}\nRun: bun run src/lib/rse/__tests__/setup-fixtures.ts`);
	}
	const buffer = readFileSync(firmwarePath);
	return new Uint8Array(buffer);
}

describe('Theme Extraction Integration Tests', () => {
	beforeAll(() => {
		// Check if --setup flag is passed or fixtures exist
		const setupMode = process.argv.includes('--setup');
		const needsSetup = !GROUND_TRUTH.every(truth => {
			const firmwarePath = join(BASE_DOWNLOAD_DIR, truth.version, truth.version, truth.filename);
			return existsSync(firmwarePath);
		});

		if (needsSetup && !setupMode) {
			throw new Error(
				`Test fixtures not found.\n` +
				`Please run: bun run src/lib/rse/__tests__/setup-fixtures.ts\n` +
				`Or run tests with: bun test src/lib/rse/__tests__/theme-extraction-integration.test.ts --setup`
			);
		}

		if (setupMode) {
			console.log('\nSetting up test fixtures...');
			try {
				execSync('bun run src/lib/rse/__tests__/setup-fixtures.ts', { stdio: 'inherit' });
			} catch (error) {
				throw new Error(`Failed to set up fixtures: ${error}`);
			}
		}
	}, 300000);

	describe('Menu Text Colors', () => {
		for (const truth of GROUND_TRUTH) {
			describe(`${truth.version} (${truth.filename})`, () => {
				let firmwareData: Uint8Array;

				beforeAll(() => {
					firmwareData = loadFirmware(truth.version, truth.filename);
				});

				it(`should discover Menu function at 0x${truth.menuFuncAddr.toString(16).toUpperCase()}`, () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');

					expect(menuFunc).toBeDefined();
					expect(menuFunc?.addr).toBe(truth.menuFuncAddr);
				});

				it(`should extract correct Theme 0 colors`, () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
					expect(menuFunc).toBeDefined();

					// Group writes by themeCondition
					const writesByTheme = new Map<number, ColorWrite[]>();
					for (const write of menuFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, []);
						}
						writesByTheme.get(themeId)!.push(write);
					}

					// Get Theme 0 writes and group by target register
					const theme0Writes = writesByTheme.get(0) ?? [];
					const colorsByReg = new Map<number, number>();
					for (const write of theme0Writes) {
						if (write.targetReg >= 1 && write.targetReg <= 3) {
							colorsByReg.set(write.targetReg, write.colorValue);
						}
					}

					// Verify R1, R2, R3
					expect(colorsByReg.get(1), `Theme 0 R1 mismatch`).toBe(truth.menuColors.theme0[0]);
					expect(colorsByReg.get(2), `Theme 0 R2 mismatch`).toBe(truth.menuColors.theme0[1]);
					expect(colorsByReg.get(3), `Theme 0 R3 mismatch`).toBe(truth.menuColors.theme0[2]);
				});

				it(`should extract correct Theme 1 colors`, () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
					expect(menuFunc).toBeDefined();

					const writesByTheme = new Map<number, ColorWrite[]>();
					for (const write of menuFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, []);
						}
						writesByTheme.get(themeId)!.push(write);
					}

					const theme1Writes = writesByTheme.get(1) ?? [];
					const colorsByReg = new Map<number, number>();
					for (const write of theme1Writes) {
						if (write.targetReg >= 1 && write.targetReg <= 3) {
							colorsByReg.set(write.targetReg, write.colorValue);
						}
					}

					expect(colorsByReg.get(1)).toBe(truth.menuColors.theme1[0]);
					expect(colorsByReg.get(2)).toBe(truth.menuColors.theme1[1]);
					expect(colorsByReg.get(3)).toBe(truth.menuColors.theme1[2]);
				});

				it(`should extract correct Theme 2 colors`, () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
					expect(menuFunc).toBeDefined();

					const writesByTheme = new Map<number, ColorWrite[]>();
					for (const write of menuFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, []);
						}
						writesByTheme.get(themeId)!.push(write);
					}

					const theme2Writes = writesByTheme.get(2) ?? [];
					const colorsByReg = new Map<number, number>();
					for (const write of theme2Writes) {
						if (write.targetReg >= 1 && write.targetReg <= 3) {
							colorsByReg.set(write.targetReg, write.colorValue);
						}
					}

					expect(colorsByReg.get(1)).toBe(truth.menuColors.theme2[0]);
					expect(colorsByReg.get(2)).toBe(truth.menuColors.theme2[1]);
					expect(colorsByReg.get(3)).toBe(truth.menuColors.theme2[2]);
				});

				it(`should extract correct Theme 3 colors`, () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
					expect(menuFunc).toBeDefined();

					const writesByTheme = new Map<number, ColorWrite[]>();
					for (const write of menuFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, []);
						}
						writesByTheme.get(themeId)!.push(write);
					}

					const theme3Writes = writesByTheme.get(3) ?? [];
					const colorsByReg = new Map<number, number>();
					for (const write of theme3Writes) {
						if (write.targetReg >= 1 && write.targetReg <= 3) {
							colorsByReg.set(write.targetReg, write.colorValue);
						}
					}

					expect(colorsByReg.get(1)).toBe(truth.menuColors.theme3[0]);
					expect(colorsByReg.get(2)).toBe(truth.menuColors.theme3[1]);
					expect(colorsByReg.get(3)).toBe(truth.menuColors.theme3[2]);
				});

				it(`should extract correct Theme 4 colors`, () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
					expect(menuFunc).toBeDefined();

					const writesByTheme = new Map<number, ColorWrite[]>();
					for (const write of menuFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, []);
						}
						writesByTheme.get(themeId)!.push(write);
					}

					const theme4Writes = writesByTheme.get(4) ?? [];
					const colorsByReg = new Map<number, number>();
					for (const write of theme4Writes) {
						if (write.targetReg >= 1 && write.targetReg <= 3) {
							colorsByReg.set(write.targetReg, write.colorValue);
						}
					}

					expect(colorsByReg.get(1)).toBe(truth.menuColors.theme4[0]);
					expect(colorsByReg.get(2)).toBe(truth.menuColors.theme4[1]);
					expect(colorsByReg.get(3)).toBe(truth.menuColors.theme4[2]);
				});

				it('should only extract writes to R1, R2, R3 registers', () => {
					const result = extractThemeColors(firmwareData);
					const menuFunc = result.themeFunctions.find(f => f.type === 'menu');

					// All writes should be to R1, R2, or R3
					for (const write of menuFunc!.colorWrites) {
						expect(write.targetReg).toBeGreaterThanOrEqual(1);
						expect(write.targetReg).toBeLessThanOrEqual(3);
					}
				});
			});
		}
	});

	describe('FLAC Colors (Original/Unpatched Firmware)', () => {
		/**
		 * IMPORTANT: These tests ONLY verify extraction from ORIGINAL (unpatched) firmware.
		 *
		 * In original firmware, themes 0-3 share one color (themes0to3) and theme 4 has a different color.
		 * This is because the original firmware uses a CMP #4 + ITE conditional to select between 2 colors.
		 *
		 * For PATCHED firmware, each theme can have a completely different color.
		 * See theme-patching-roundtrip.test.ts for tests that verify patching preserves all 5 colors.
		 */
		for (const truth of GROUND_TRUTH) {
			describe(`${truth.version} (${truth.filename})`, () => {
				let firmwareData: Uint8Array;

				beforeAll(() => {
					firmwareData = loadFirmware(truth.version, truth.filename);
				});

				it(`should extract correct FLAC colors for all themes (original firmware behavior)`, () => {
					const result = extractThemeColors(firmwareData);
					const flacFunc = result.themeFunctions.find(f => f.type === 'flac');

					expect(flacFunc).toBeDefined();

					// Original firmware should NOT have flacColors array (only colorFor4 and colorForOther)
					expect(result.flacBehavior.flacColors).toBeUndefined();
					expect(result.flacBehavior.colorFor4).toBe(truth.flacColors.theme4);
					expect(result.flacBehavior.colorForOther).toBe(truth.flacColors.themes0to3);

					// Group writes by themeCondition
					const writesByTheme = new Map<number, ColorWrite[]>();
					for (const write of flacFunc!.colorWrites) {
						const themeId = write.themeCondition ?? 0;
						if (!writesByTheme.has(themeId)) {
							writesByTheme.set(themeId, []);
						}
						writesByTheme.get(themeId)!.push(write);
					}

					// Themes 0-3 should have the same color (original firmware behavior)
					for (let themeId = 0; themeId <= 3; themeId++) {
						const themeWrites = writesByTheme.get(themeId) ?? [];
						expect(themeWrites.length, `FLAC Theme ${themeId} should have writes`).toBeGreaterThan(0);
						expect(themeWrites[0].colorValue, `FLAC Theme ${themeId} color mismatch`).toBe(truth.flacColors.themes0to3);
					}

					// Theme 4 should have different color
					const theme4Writes = writesByTheme.get(4) ?? [];
					expect(theme4Writes.length, `FLAC Theme 4 should have writes`).toBeGreaterThan(0);
					expect(theme4Writes[0].colorValue, `FLAC Theme 4 color mismatch`).toBe(truth.flacColors.theme4);
				});
			});
		}
	});

	describe('Progress Bar Colors', () => {
		for (const truth of GROUND_TRUTH) {
			describe(`${truth.version} (${truth.filename})`, () => {
				let firmwareData: Uint8Array;

				beforeAll(() => {
					firmwareData = loadFirmware(truth.version, truth.filename);
				});

				it(`should extract correct Progress Bar colors for all themes`, () => {
					const result = extractThemeColors(firmwareData);
					const progressFunc = result.themeFunctions.find(f => f.type === 'progress');

					expect(progressFunc, 'Progress function should be found').toBeDefined();

					// Progress Bar uses preloadColors
					const preloadColors = progressFunc!.preloadColors;

					expect(preloadColors[0]).toBe(truth.progressColors.theme0);
					expect(preloadColors[1]).toBe(truth.progressColors.theme1);
					expect(preloadColors[2]).toBe(truth.progressColors.theme2);
					expect(preloadColors[3]).toBe(truth.progressColors.theme3);
					expect(preloadColors[4]).toBe(truth.progressColors.theme4);
				});
			});
		}
	});

	describe('Marquee Colors', () => {
		for (const truth of GROUND_TRUTH) {
			describe(`${truth.version} (${truth.filename})`, () => {
				let firmwareData: Uint8Array;

				beforeAll(() => {
					firmwareData = loadFirmware(truth.version, truth.filename);
				});

				it(`should extract correct Marquee colors for all themes`, () => {
					const result = extractThemeColors(firmwareData);
					const marqueeFunc = result.themeFunctions.find(f => f.type === 'marquee');

					expect(marqueeFunc, 'Marquee function should be found').toBeDefined();

					// Marquee uses preloadColors
					const preloadColors = marqueeFunc!.preloadColors;

					expect(preloadColors[0]).toBe(truth.marqueeColors.theme0);
					expect(preloadColors[1]).toBe(truth.marqueeColors.theme1);
					expect(preloadColors[2]).toBe(truth.marqueeColors.theme2);
					expect(preloadColors[3]).toBe(truth.marqueeColors.theme3);
					expect(preloadColors[4]).toBe(truth.marqueeColors.theme4);
				});
			});
		}
	});
});
