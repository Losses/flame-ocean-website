/**
 * Complete Operation Matrix Tests
 *
 * Tests all possible operation sequences:
 * - Patch FLAC only
 * - Patch Menu only
 * - Patch both
 * - Edit colors after patching
 * - Re-patch scenarios
 * - All across multiple firmware versions
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { ThemePatcher } from '../theme/patcher.js';

// Generate valid test colors in correct format
// FLAC: 5 colors (one per theme)
// Menu: 15 colors (5 themes × 3 attributes)
function generateValidColors(): { flac: number[]; menu: number[] } {
	// FLAC colors: simple array of 5 values
	const flac = [0xFFFF, 0xFF00, 0xF800, 0x001F, 0x07FF];

	// Menu colors: interleaved by register
	// [T0_R1, T1_R1, T2_R1, T3_R1, T4_R1, T0_R2, T1_R2, T2_R2, T3_R2, T4_R2, T0_R3, T1_R3, T2_R3, T3_R3, T4_R3]
	const menu: number[] = [];
	for (let reg = 0; reg < 3; reg++) {
		for (let theme = 0; theme < 5; theme++) {
			// Generate distinct colors for each register/theme combo
			menu.push(0xF800 - (theme * 0x1000) - (reg * 0x100));
		}
	}

	return { flac, menu };
}

const versions: string[] = [
	'ECHO MINI V1.8.0',
	'ECHO MINI V2.4.0',
	'ECHO MINI V2.5.0',
	'ECHO MINI V2.6.0',
	'ECHO MINI V2.7.0',
	'ECHO MINI V2.8.0',
	'ECHO MINI V3.0.0',
	'ECHO MINI V3.1.0',
	'ECHO MINI V3.2.0',
];

// Select 3 versions for comprehensive testing (V1.x, V2.x, V3.x)
const testVersions = ['ECHO MINI V1.8.0', 'ECHO MINI V2.4.0', 'ECHO MINI V3.1.0'];

describe('Complete Operation Matrix Tests', () => {
	describe('Single patch scenarios', () => {
		testVersions.forEach(version => {
			const firmwarePath = `/tmp/echo-mini-firmwares/${version}/${version}/HIFIEC40.IMG`;

			if (!existsSync(firmwarePath)) {
				it.skip(`should test ${version} - firmware not found`);
				return;
			}

			const colors = generateValidColors();
			const flacColors = colors.flac;
			const menuColors = colors.menu;

			describe(`Version ${version}`, () => {
				it('should patch FLAC only successfully', () => {
					const patcher = new ThemePatcher(readFileSync(firmwarePath));
					const outputPath = `/tmp/test-${version.replace(/\s+/g, '_')}-flac-only.IMG`;

					// Clean up any existing test file
					if (existsSync(outputPath)) {
						unlinkSync(outputPath);
					}

					// For FLAC-only patching, omit menuColors entirely
					const result = patcher.patch(
						{ flacColors },
						outputPath,
						true
					);

					expect(result.success).toBe(true);
					expect(existsSync(outputPath)).toBe(true);

					// Verify output firmware is valid
					const patchedData = readFileSync(outputPath);
					expect(patchedData.length).toBeGreaterThan(0);

					// Clean up
					unlinkSync(outputPath);
				});

				it('should patch Menu only successfully', () => {
					const patcher = new ThemePatcher(readFileSync(firmwarePath));
					const outputPath = `/tmp/test-${version.replace(/\s+/g, '_')}-menu-only.IMG`;

					if (existsSync(outputPath)) {
						unlinkSync(outputPath);
					}

					// For Menu-only patching, omit flacColors entirely
					const result = patcher.patch(
						{ menuColors },
						outputPath,
						true
					);

					expect(result.success).toBe(true);
					expect(existsSync(outputPath)).toBe(true);

					const patchedData = readFileSync(outputPath);
					expect(patchedData.length).toBeGreaterThan(0);

					unlinkSync(outputPath);
				});

				it('should patch both FLAC and Menu successfully', () => {
					const patcher = new ThemePatcher(readFileSync(firmwarePath));
					const outputPath = `/tmp/test-${version.replace(/\s+/g, '_')}-both.IMG`;

					if (existsSync(outputPath)) {
						unlinkSync(outputPath);
					}

					const result = patcher.patch(
						{ flacColors, menuColors },
						outputPath,
						true
					);

					expect(result.success).toBe(true);
					expect(existsSync(outputPath)).toBe(true);

					const patchedData = readFileSync(outputPath);
					expect(patchedData.length).toBeGreaterThan(0);

					unlinkSync(outputPath);
				});
			});
		});
	});

	describe('Re-patch scenarios', () => {
		testVersions.forEach(version => {
			const firmwarePath = `/tmp/echo-mini-firmwares/${version}/${version}/HIFIEC40.IMG`;

			if (!existsSync(firmwarePath)) {
				it.skip(`should test ${version} - firmware not found`);
				return;
			}

			// Generate different color sets for re-patching
			const flacColors1 = [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410];
			const flacColors2 = [0xFF00, 0xF800, 0x001F, 0x07FF, 0xFFFF];

			// Menu colors: interleaved by register
			const menuColors1: number[] = [];
			for (let reg = 0; reg < 3; reg++) {
				for (let theme = 0; theme < 5; theme++) {
					menuColors1.push(0xF800 - (theme * 0x1000) - (reg * 0x100));
				}
			}
			const menuColors2: number[] = [];
			for (let reg = 0; reg < 3; reg++) {
				for (let theme = 0; theme < 5; theme++) {
					menuColors2.push(0x07FF + (theme * 0x1000) + (reg * 0x100));
				}
			}

			describe(`Version ${version}`, () => {
				it('should re-patch FLAC with different colors', () => {
					const patcher = new ThemePatcher(readFileSync(firmwarePath));
					const outputPath1 = `/tmp/test-${version.replace(/\s+/g, '_')}-repatch-flac-1.IMG`;
					const outputPath2 = `/tmp/test-${version.replace(/\s+/g, '_')}-repatch-flac-2.IMG`;

					// First patch - FLAC only
					if (existsSync(outputPath1)) unlinkSync(outputPath1);
					if (existsSync(outputPath2)) unlinkSync(outputPath2);

					let result = patcher.patch(
						{ flacColors: flacColors1 },
						outputPath1,
						true
					);

					expect(result.success).toBe(true);

					// Re-patch with different FLAC colors
					const patchedData1 = readFileSync(outputPath1);
					const patcher2 = new ThemePatcher(patchedData1);
					result = patcher2.patch(
						{ flacColors: flacColors2 },
						outputPath2,
						true
					);

					expect(result.success).toBe(true);

					// Clean up
					unlinkSync(outputPath1);
					unlinkSync(outputPath2);
				});

				it('should re-patch Menu with different colors', () => {
					const patcher = new ThemePatcher(readFileSync(firmwarePath));
					const outputPath1 = `/tmp/test-${version.replace(/\s+/g, '_')}-repatch-menu-1.IMG`;
					const outputPath2 = `/tmp/test-${version.replace(/\s+/g, '_')}-repatch-menu-2.IMG`;

					if (existsSync(outputPath1)) unlinkSync(outputPath1);
					if (existsSync(outputPath2)) unlinkSync(outputPath2);

					let result = patcher.patch(
						{ menuColors: menuColors1 },
						outputPath1,
						true
					);

					expect(result.success).toBe(true);

					const patchedData1 = readFileSync(outputPath1);
					const patcher2 = new ThemePatcher(patchedData1);
					result = patcher2.patch(
						{ menuColors: menuColors2 },
						outputPath2,
						true
					);

					expect(result.success).toBe(true);

					unlinkSync(outputPath1);
					unlinkSync(outputPath2);
				});
			});
		});
	});

	describe('Cross-version compatibility', () => {
		it('should produce consistent results across versions', () => {
			const results: Array<{ version: string; success: boolean }> = [];

			for (const version of testVersions) {
				const firmwarePath = `/tmp/echo-mini-firmwares/${version}/${version}/HIFIEC40.IMG`;

				if (!existsSync(firmwarePath)) {
					continue;
				}

				const patcher = new ThemePatcher(readFileSync(firmwarePath));
				const outputPath = `/tmp/test-${version.replace(/\s+/g, '_')}-cross-version.IMG`;

				try {
					if (existsSync(outputPath)) unlinkSync(outputPath);

					const colors = generateValidColors();
					const result = patcher.patch(
						{ flacColors: colors.flac, menuColors: colors.menu },
						outputPath,
						true
					);

					results.push({ version, success: result.success });

					if (existsSync(outputPath)) unlinkSync(outputPath);
				} catch (error: any) {
					results.push({ version, success: false });
				}
			}

			// All tested versions should succeed
			results.forEach(r => {
				expect(r.success).toBe(true);
			});
		});
	});

	describe('Error handling - invalid operations', () => {
		it('should successfully re-patch already patched firmware', () => {
			const firmwarePath = '/tmp/echo-mini-firmwares/ECHO MINI V2.4.0/ECHO MINI V2.4.0/HIFIEC40.IMG';

			if (!existsSync(firmwarePath)) {
				it.skip('Firmware not found');
				return;
			}

			const patcher = new ThemePatcher(readFileSync(firmwarePath));
			const outputPath1 = '/tmp/test-error-repatch-1.IMG';
			const outputPath2 = '/tmp/test-error-repatch-2.IMG';

			if (existsSync(outputPath1)) unlinkSync(outputPath1);
			if (existsSync(outputPath2)) unlinkSync(outputPath2);

			const colors = generateValidColors();

			// First patch
			patcher.patch(
				{ flacColors: colors.flac, menuColors: colors.menu },
				outputPath1,
				true
			);

			// Re-patch should succeed (no force parameter needed - automatic re-patch detection)
			const patchedData1 = readFileSync(outputPath1);
			const patcher2 = new ThemePatcher(patchedData1);
			const result2 = patcher2.patch(
				{ flacColors: colors.flac, menuColors: colors.menu },
				outputPath2,
				true
			);

			expect(result2.success).toBe(true);

			// Clean up
			unlinkSync(outputPath1);
			unlinkSync(outputPath2);
		});
	});

	describe('NOP slide boundary verification', () => {
		testVersions.forEach(version => {
			const firmwarePath = `/tmp/echo-mini-firmwares/${version}/${version}/HIFIEC40.IMG`;

			if (!existsSync(firmwarePath)) {
				it.skip(`should test ${version} - firmware not found`);
				return;
			}

			const colors = generateValidColors();

			it(`should verify ${version} does not slide off NOP slide`, () => {
				const patcher = new ThemePatcher(readFileSync(firmwarePath));
				const outputPath = `/tmp/test-${version.replace(/\s+/g, '_')}-boundary-check.IMG`;

				if (existsSync(outputPath)) unlinkSync(outputPath);

				const result = patcher.patch(
					{ flacColors: colors.flac, menuColors: colors.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				// Verify patched firmware size is correct
				const patchedData = readFileSync(outputPath);
				expect(patchedData.length).toEqual(readFileSync(firmwarePath).length);

				unlinkSync(outputPath);
			});
		});
	});
});
