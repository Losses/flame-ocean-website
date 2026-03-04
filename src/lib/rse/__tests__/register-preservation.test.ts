/**
 * Register Preservation Tests
 *
 * Tests that FLAC and Menu handlers correctly preserve callee-saved registers.
 * This is CRITICAL for system stability - corrupted registers cause crashes
 * and data corruption.
 *
 * ARM Thumb Calling Convention:
 * - R0-R3: Caller-saved (can be modified freely)
 * - R4-R8: Callee-saved (MUST be saved by callee)
 * - R9: Platform-specific
 * - R10 (SL), R11 (FP): Callee-saved
 * - R12 (IP): Caller-saved
 * - R13 (SP): Stack pointer
 * - R14 (LR): Return address
 * - R15 (PC): Program counter
 *
 * Implementation Details:
 * - FLAC: Uses INLINE color code (replaces IT block in relocated function)
 *         No separate prologue/epilogue needed - uses function's own
 * - Menu: Uses SEPARATE handler with prologue (PUSH {R4-R6}) and
 *         epilogue (POP {R4-R6, PC})
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ThemePatcher } from '../theme/patcher.js';
import { scanForPatchWithRelocation } from '../theme/metadata.js';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Firmware path for testing - ALL supported versions
const FIRMWARE_DIR = '/home/losses/Downloads/ECHO MINI V3.1.0/firmwares';
const FIRMWARE_VERSIONS = [
	{ version: 'V1.8.0', path: join(FIRMWARE_DIR, 'ECHO MINI V1.8.0/HIFIEC80.IMG') },
	{ version: 'V2.4.0', path: join(FIRMWARE_DIR, 'ECHO MINI V2.4.0/HIFIEC40.IMG') },
	{ version: 'V2.5.0', path: join(FIRMWARE_DIR, 'ECHO MINI V2.5.0/HIFIEC50.IMG') },
	{ version: 'V2.6.0', path: join(FIRMWARE_DIR, 'ECHO MINI V2.6.0/HIFIEC60.IMG') },
	{ version: 'V2.7.0', path: join(FIRMWARE_DIR, 'ECHO MINI V2.7.0/HIFIEC70.IMG') },
	{ version: 'V2.8.0', path: join(FIRMWARE_DIR, 'ECHO MINI V2.8.0/HIFIEC80.IMG') },
	{ version: 'V3.0.0', path: join(FIRMWARE_DIR, 'ECHO MINI V3.0.0/HIFIEC00.IMG') },
	{ version: 'V3.1.0', path: join(FIRMWARE_DIR, 'ECHO MINI V3.1.0/HIFIEC10.IMG') },
	{ version: 'V3.2.0', path: join(FIRMWARE_DIR, 'ECHO MINI V3.2.0/HIFIEC20.IMG') }
].filter(f => existsSync(f.path));

const OUTPUT_DIR = '/tmp/register-preservation-test';
const TEST_COLORS = {
	flac: [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410],
	menu: Array(15).fill(0x1234)
};

describe('Register Preservation Tests', () => {
	beforeAll(() => {
		if (!existsSync(OUTPUT_DIR)) {
			mkdirSync(OUTPUT_DIR, { recursive: true });
		}
	});

	describe('FLAC Inline Color Code Analysis', () => {
		for (const firmware of FIRMWARE_VERSIONS) {
			it(`${firmware.version}: FLAC inline color code should be embedded in function`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_flac_inline_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				// Read patched firmware
				const patchedData = readFileSync(outputPath);

				// Get relocation header for color code offset
				const scanResult = scanForPatchWithRelocation(patchedData);
				expect(scanResult).not.toBeNull();

				const { reloHeader } = scanResult!;
				const colorCodeAddr = reloHeader.flacFuncAddr + reloHeader.flacColorCodeOffset;

				// Read first instruction of color code
				// Should be CMP R1, #0 = 0x2900
				const firstHalfword = patchedData[colorCodeAddr] | (patchedData[colorCodeAddr + 1] << 8);
				expect((firstHalfword & 0xFF00)).toBe(0x2900); // CMP R1, #imm8
			});

			it(`${firmware.version}: FLAC inline color code should have CMP/BEQ structure`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_flac_cmp_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				const patchedData = readFileSync(outputPath);
				const scanResult = scanForPatchWithRelocation(patchedData);
				expect(scanResult).not.toBeNull();

				const { reloHeader } = scanResult!;
				const colorCodeAddr = reloHeader.flacFuncAddr + reloHeader.flacColorCodeOffset;

				// Check CMP/BEQ pattern for themes 0-3
				// CMP R1, #0; BEQ theme_0
				// CMP R1, #1; BEQ theme_1
				// etc.
				for (let i = 0; i < 4; i++) {
					const cmpOffset = colorCodeAddr + i * 4;
					const cmpHw = patchedData[cmpOffset] | (patchedData[cmpOffset + 1] << 8);
					const beqHw = patchedData[cmpOffset + 2] | (patchedData[cmpOffset + 3] << 8);

					expect(cmpHw).toBe(0x2900 | i); // CMP R1, #i
					expect((beqHw & 0xFF00)).toBe(0xD000); // BEQ
				}
			});

			it(`${firmware.version}: FLAC function should have original prologue`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_flac_prologue_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				const patchedData = readFileSync(outputPath);
				const funcAddr = result.relocationInfo!.newFuncAddr;

				// Original FLAC function starts with PUSH or STMDB
				// 0xE92D = STMDB SP!, {...} (32-bit PUSH)
				// 0xB5XX = PUSH {rlist, LR} (16-bit)
				// 0xB4XX = PUSH {rlist} (16-bit)
				const firstHalfword = patchedData[funcAddr] | (patchedData[funcAddr + 1] << 8);

				const isPush =
					(firstHalfword & 0xFF00) === 0xB400 ||  // PUSH {rlist}
					(firstHalfword & 0xFF00) === 0xB500 ||  // PUSH {rlist, LR}
					firstHalfword === 0xE92D;               // STMDB SP!, {...}

				expect(isPush).toBe(true);
			});
		}
	});

	describe('Menu Handler Prologue/Epilogue Analysis', () => {
		for (const firmware of FIRMWARE_VERSIONS) {
			it(`${firmware.version}: Menu handler should have proper prologue (PUSH {R4-R6})`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_menu_prologue_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);
				expect(result.relocationInfo!.menuHandlerAddr).toBeDefined();
				expect(result.relocationInfo!.menuHandlerAddr).toBeGreaterThan(0);

				const patchedData = readFileSync(outputPath);
				const menuHandlerAddr = result.relocationInfo!.menuHandlerAddr!;

				// Read first instruction (should be PUSH {R4-R6} = 0xB470)
				const firstHalfword = patchedData[menuHandlerAddr] | (patchedData[menuHandlerAddr + 1] << 8);

				// PUSH {R4-R6} encoding: 0xB470 (B4 = PUSH, 70 = R4,R5,R6 in register list)
				expect((firstHalfword & 0xFF00)).toBe(0xB400); // PUSH instruction
				expect(firstHalfword & 0x00FF).toBe(0x70); // R4, R5, R6 in register list (bits 4,5,6)
			});

			it(`${firmware.version}: Menu handler should have proper epilogue (POP {R4-R6, PC})`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_menu_epilogue_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				const patchedData = readFileSync(outputPath);
				const menuHandlerAddr = result.relocationInfo!.menuHandlerAddr!;
				const menuHandlerSize = result.relocationInfo!.menuHandlerSize!;

				// Menu handler ends with POP {R4-R6, PC} = 0xBD70
				// Check the last instruction
				const lastInstrOffset = menuHandlerSize - 2;
				const lastHalfword = patchedData[menuHandlerAddr + lastInstrOffset] |
				                     (patchedData[menuHandlerAddr + lastInstrOffset + 1] << 8);

				// POP {R4-R6, PC} = 0xBD70 (BD = POP with PC, 70 = R4,R5,R6 in register list)
				expect(lastHalfword).toBe(0xBD70);
			});

			it(`${firmware.version}: Menu handler should maintain stack balance`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_menu_stack_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				const patchedData = readFileSync(outputPath);
				const menuHandlerAddr = result.relocationInfo!.menuHandlerAddr!;
				const menuHandlerSize = result.relocationInfo!.menuHandlerSize!;

				// Count PUSH and POP instructions
				let pushCount = 0;
				let popCount = 0;

				for (let offset = 0; offset < menuHandlerSize - 1; offset += 2) {
					const hw = patchedData[menuHandlerAddr + offset] | (patchedData[menuHandlerAddr + offset + 1] << 8);

					if ((hw & 0xFF00) === 0xB400 || (hw & 0xFF00) === 0xB500) {
						pushCount++;
					}
					if ((hw & 0xFF00) === 0xBC00 || (hw & 0xFF00) === 0xBD00) {
						popCount++;
					}
				}

				// Menu handler: 1 PUSH at start (from original prologue), 1 POP at end
				expect(pushCount).toBeGreaterThanOrEqual(1);
				expect(popCount).toBe(1);
			});
		}
	});

	describe('Relocation Header Verification', () => {
		for (const firmware of FIRMWARE_VERSIONS) {
			it(`${firmware.version}: Should store correct addresses in relocation header`, () => {
				const data = readFileSync(firmware.path);
				const patcher = new ThemePatcher(data);

				const outputPath = join(OUTPUT_DIR, `${firmware.version}_relo_header_test.bin`);
				const result = patcher.patch(
					{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
					outputPath,
					true
				);

				expect(result.success).toBe(true);

				// Read patched firmware and scan for relocation header
				const patchedData = readFileSync(outputPath);
				const scanResult = scanForPatchWithRelocation(patchedData);

				expect(scanResult).not.toBeNull();

				const { reloHeader } = scanResult!;

				// Verify FLAC addresses
				expect(reloHeader.flacFuncAddr).toBe(result.relocationInfo!.newFuncAddr);
				expect(reloHeader.flacFuncSize).toBe(result.relocationInfo!.funcSize);
				expect(reloHeader.flacCallerAddr).toBe(result.relocationInfo!.callerAddr);

				// Verify Menu addresses
				expect(reloHeader.menuHandlerAddr).toBe(result.relocationInfo!.menuHandlerAddr);
				expect(reloHeader.menuHandlerSize).toBe(result.relocationInfo!.menuHandlerSize);
				expect(reloHeader.menuCallerAddr).toBe(result.relocationInfo!.menuCallerAddr);
			});
		}
	});
});
