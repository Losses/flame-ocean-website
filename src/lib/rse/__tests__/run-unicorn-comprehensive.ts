/**
 * Comprehensive Unicorn Test Runner for Theme Patcher
 *
 * This script tests ALL patching combinations:
 * - First patch: FLAC-only, Menu-only, Both (3 options)
 * - Second patch: FLAC-only, Menu-only, Both (3 options)
 * - Total: 9 scenarios
 *
 * For each scenario, we:
 * 1. Use the TypeScript patcher to create patched firmware
 * 2. Run Python Unicorn emulation to verify the result
 * 3. Verify colors match expected values
 *
 * Usage: bun run src/lib/rse/__tests__/run-unicorn-comprehensive.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { ThemePatcher } from '../theme/patcher.js';

const PYTHON_PATH = '/nix/store/lc6q15imd72k6a4mpm9zzr3g0yygs4k6-system-path/bin/python3';
const FIRMWARE_BASE = '/tmp/echo-mini-firmwares';
const OUTPUT_DIR = '/tmp/unicorn-comprehensive';

// Test colors
const TEST_COLORS = {
	flac: {
		first: [0x1111, 0x2222, 0x3333, 0x4444, 0x5555],
		second: [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410]
	},
	menu: {
		first: [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF],
		second: [0xF800, 0x07E0, 0x001F, 0xFFE0, 0x8410, 0xFFFF, 0x0000, 0x7777, 0x8888, 0x9999, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE]
	}
};

// Extract ground truth from a firmware file
function extractGroundTruth(firmwarePath: string): { flacColors: number[]; menuColors: number[] } {
	const firmwareData = readFileSync(firmwarePath);
	const patcher = new ThemePatcher(firmwareData);
	const { flacColors, menuColors } = patcher.extractGroundTruthColors();
	return { flacColors, menuColors };
}

// Firmware versions with FLAC function addresses (discovered from test_roundtrip_emulation.py)
const FIRMWARE_INFO = [
	{ version: 'V1.8.0', file: 'HIFIEC80.IMG', flacAddr: 0x84DC2, subdir: 'ECHO MINI V1.8.0/ECHO MINI V1.8.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.4.0', file: 'HIFIEC40.IMG', flacAddr: 0x86508, subdir: 'ECHO MINI V2.4.0/ECHO MINI V2.4.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.5.0', file: 'HIFIEC50.IMG', flacAddr: 0x865AC, subdir: 'ECHO MINI V2.5.0/ECHO MINI V2.5.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.6.0', file: 'HIFIEC60.IMG', flacAddr: 0x8669C, subdir: 'ECHO MINI V2.6.0/ECHO MINI V2.6.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.7.0', file: 'HIFIEC70.IMG', flacAddr: 0x867A8, subdir: 'ECHO MINI V2.7.0/ECHO MINI V2.7.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.8.0', file: 'HIFIEC80.IMG', flacAddr: 0x8692C, subdir: 'ECHO MINI V2.8.0/ECHO MINI V2.8.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V3.0.0', file: 'HIFIEC00.IMG', flacAddr: 0x86958, subdir: 'ECHO MINI V3.0.0/ECHO MINI V3.0.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V3.1.0', file: 'HIFIEC10.IMG', flacAddr: 0x86CB0, subdir: 'ECHO MINI V3.1.0/ECHO MINI V3.1.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V3.2.0', file: 'HIFIEC20.IMG', flacAddr: 0x86CFC, subdir: 'ECHO MINI V3.2.0/ECHO MINI V3.2.0', groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
];

// All test scenarios (templates - will be populated with actual ground truth per firmware)
const SCENARIO_TEMPLATES = [
	{
		id: 'flac_flac',
		name: 'FLAC-only → FLAC-only',
		firstOp: 'flac-only' as const,
		secondOp: 'flac-only' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first }),
		getSecondColors: () => ({ flacColors: TEST_COLORS.flac.second })
	},
	{
		id: 'flac_menu',
		name: 'FLAC-only → Menu-only',
		firstOp: 'flac-only' as const,
		secondOp: 'menu-only' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first }),
		getSecondColors: () => ({ menuColors: TEST_COLORS.menu.second })
	},
	{
		id: 'flac_both',
		name: 'FLAC-only → Both',
		firstOp: 'flac-only' as const,
		secondOp: 'both' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first }),
		getSecondColors: () => ({ flacColors: TEST_COLORS.flac.second, menuColors: TEST_COLORS.menu.second })
	},
	{
		id: 'menu_flac',
		name: 'Menu-only → FLAC-only',
		firstOp: 'menu-only' as const,
		secondOp: 'flac-only' as const,
		getFirstColors: () => ({ menuColors: TEST_COLORS.menu.first }),
		getSecondColors: () => ({ flacColors: TEST_COLORS.flac.second })
	},
	{
		id: 'menu_menu',
		name: 'Menu-only → Menu-only',
		firstOp: 'menu-only' as const,
		secondOp: 'menu-only' as const,
		getFirstColors: () => ({ menuColors: TEST_COLORS.menu.first }),
		getSecondColors: () => ({ menuColors: TEST_COLORS.menu.second })
	},
	{
		id: 'menu_both',
		name: 'Menu-only → Both',
		firstOp: 'menu-only' as const,
		secondOp: 'both' as const,
		getFirstColors: () => ({ menuColors: TEST_COLORS.menu.first }),
		getSecondColors: () => ({ flacColors: TEST_COLORS.flac.second, menuColors: TEST_COLORS.menu.second })
	},
	{
		id: 'both_flac',
		name: 'Both → FLAC-only',
		firstOp: 'both' as const,
		secondOp: 'flac-only' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first, menuColors: TEST_COLORS.menu.first }),
		getSecondColors: () => ({ flacColors: TEST_COLORS.flac.second })
	},
	{
		id: 'both_menu',
		name: 'Both → Menu-only',
		firstOp: 'both' as const,
		secondOp: 'menu-only' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first, menuColors: TEST_COLORS.menu.first }),
		getSecondColors: () => ({ menuColors: TEST_COLORS.menu.second })
	},
	{
		id: 'both_both',
		name: 'Both → Both',
		firstOp: 'both' as const,
		secondOp: 'both' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first, menuColors: TEST_COLORS.menu.first }),
		getSecondColors: () => ({ flacColors: TEST_COLORS.flac.second, menuColors: TEST_COLORS.menu.second })
	}
];

/**
 * Create output directory
 */
function ensureOutputDir() {
	if (!existsSync(OUTPUT_DIR)) {
		mkdirSync(OUTPUT_DIR, { recursive: true });
	}
	if (!existsSync(join(OUTPUT_DIR, 'scripts'))) {
		mkdirSync(join(OUTPUT_DIR, 'scripts'), { recursive: true });
	}
}

/**
 * Generate Python Unicorn test script for a specific firmware and scenario
 * Uses the reference approach: emulate from NOP slide, not FLAC function
 */
function generateUnicornScript(
	firmwareInfo: typeof FIRMWARE_INFO[0],
	scenarioName: string,
	patchNumber: 1 | 2,
	expectedFlac: number[],
	patchedFirmwarePath: string,
	nopSlideAddr: number
): string {

	return `
import sys
sys.path.insert(0, 'references')

from unicorn import *
from unicorn.arm_const import *

# Load patched firmware
with open('${patchedFirmwarePath}', 'rb') as f:
    data = f.read()

# NOP slide address from BL decoding (may have 2-byte padding)
NOP_SLIDE_RAW = 0x${nopSlideAddr.toString(16)}

# Find actual code start (skip 0x0000 padding)
code_start = NOP_SLIDE_RAW
while code_start < len(data) and data[code_start] == 0x00 and data[code_start + 1] == 0x00:
    code_start += 2

print(f"NOP slide raw: 0x{NOP_SLIDE_RAW:X}, code start: 0x{code_start:X}")

# Initialize emulator
mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

# Page-align for memory mapping
code_base = code_start & ~0xFFF
mu.mem_map(code_base, 0x10000, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)

# Write code (512 bytes from actual code start)
mu.mem_write(code_start, data[code_start:code_start + 512])

# Also map stack region
mu.mem_map(0x20000000, 0x10000, UC_PROT_READ | UC_PROT_WRITE)

# Expected FLAC colors
expected_flac = ${JSON.stringify(expectedFlac)}

# Hook to stop at BX LR
def hook_code(uc, address, size, user_data):
    try:
        instr_bytes = uc.mem_read(address, 2)
        if instr_bytes[0] == 0x70 and instr_bytes[1] == 0x47:  # BX LR
            uc.emu_stop()
    except:
        pass

mu.hook_add(UC_HOOK_CODE, hook_code)

# Emulate FLAC handler for each theme
flac_results = []
for theme_idx, expected_color in enumerate(expected_flac):
    # Set up registers
    mu.reg_write(UC_ARM_REG_CPSR, 0x000001F3)
    mu.reg_write(UC_ARM_REG_SP, 0x20008000)
    mu.reg_write(UC_ARM_REG_R1, theme_idx)  # Theme index in R1
    mu.reg_write(UC_ARM_REG_LR, (code_start + 100) | 1)
    mu.reg_write(UC_ARM_REG_PC, code_start | 1)

    # Emulate
    try:
        mu.emu_start(code_start | 1, (code_start + 1000) | 1, 0, 100)
        r0 = mu.reg_read(UC_ARM_REG_R0)
        flac_results.append(r0 & 0xFFFF)
    except UcError as e:
        flac_results.append(0)

print(f"FLAC results: {flac_results}")
print(f"Expected FLAC: {expected_flac}")

# Verify
if flac_results == expected_flac:
    print("✅ PASS")
    sys.exit(0)
else:
    print("❌ FAIL")
    sys.exit(1)
`;
}

/**
 * Decode BL instruction to get target address
 */
function decodeBlTarget(data: Buffer, blAddr: number): number {
	const hw1 = data[blAddr] | (data[blAddr + 1] << 8);
	const hw2 = data[blAddr + 2] | (data[blAddr + 3] << 8);

	const S = (hw1 >> 10) & 1;
	const J1 = (hw2 >> 13) & 1;
	const J2 = (hw2 >> 11) & 1;
	const imm10 = hw1 & 0x3FF;
	const imm11 = hw2 & 0x7FF;

	const I1 = (~(J1 ^ S)) & 1;
	const I2 = (~(J2 ^ S)) & 1;

	const imm25 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);
	let imm32 = imm25 << 1;

	if (S) {
		imm32 |= 0xFE000000;
	}

	return blAddr + 4 + imm32;
}

/**
 * Apply patch using TypeScript patcher
 * Returns: { success: boolean, nopSlideAddr: number }
 */
function applyPatch(
	firmwarePath: string,
	options: { flacColors?: number[]; menuColors?: number[] },
	outputPath: string,
	flacAddr: number
): { success: boolean; nopSlideAddr: number } {
	try {
		const firmwareData = readFileSync(firmwarePath);
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch(options, outputPath, true);

		if (!result.success) {
			return { success: false, nopSlideAddr: 0 };
		}

		// Read patched firmware and decode BL at FLAC address to find NOP slide
		const patchedData = readFileSync(outputPath);
		const nopSlideAddr = decodeBlTarget(patchedData, flacAddr);

		return { success: true, nopSlideAddr };
	} catch (error) {
		console.error(`Patch failed: ${error}`);
		return { success: false, nopSlideAddr: 0 };
	}
}

/**
 * Run Python Unicorn test
 */
function runUnicornTest(scriptPath: string): { success: boolean; output: string } {
	try {
		const result = execSync(`${PYTHON_PATH} ${scriptPath}`, {
			cwd: process.cwd(),
			encoding: 'utf-8',
			stdio: 'pipe',
			timeout: 30000
		});

		return {
			success: result.includes('✅ PASS'),
			output: result
		};
	} catch (error: any) {
		return {
			success: false,
			output: error.stdout || error.stderr || error.message
		};
	}
}

/**
 * Build test scenarios for a specific firmware with its ground truth colors
 */
function buildScenariosForFirmware(groundTruth: { flacColors: number[]; menuColors: number[] }) {
	return SCENARIO_TEMPLATES.map(template => {
		// Determine expected colors after first patch
		let expectedAfterFirstFlac: number[];
		let expectedAfterFirstMenu: number[];

		const firstColors = template.getFirstColors();
		if ('flacColors' in firstColors) {
			expectedAfterFirstFlac = firstColors.flacColors;
		} else {
			expectedAfterFirstFlac = groundTruth.flacColors;
		}
		if ('menuColors' in firstColors) {
			expectedAfterFirstMenu = firstColors.menuColors;
		} else {
			expectedAfterFirstMenu = groundTruth.menuColors;
		}

		// Determine expected colors after second patch
		let expectedAfterSecondFlac: number[];
		let expectedAfterSecondMenu: number[];

		const secondColors = template.getSecondColors();
		if ('flacColors' in secondColors) {
			expectedAfterSecondFlac = secondColors.flacColors;
		} else {
			expectedAfterSecondFlac = expectedAfterFirstFlac;
		}
		if ('menuColors' in secondColors) {
			expectedAfterSecondMenu = secondColors.menuColors;
		} else {
			expectedAfterSecondMenu = expectedAfterFirstMenu;
		}

		return {
			...template,
			firstColors,
			secondColors,
			expectedAfterFirst: { flac: expectedAfterFirstFlac, menu: expectedAfterFirstMenu },
			expectedAfterSecond: { flac: expectedAfterSecondFlac, menu: expectedAfterSecondMenu }
		};
	});
}

/**
 * Main test execution
 */
async function runComprehensiveTests() {
	ensureOutputDir();

	const results: Array<{
		firmware: string;
		scenario: string;
		firstPatch: boolean;
		secondPatch: boolean;
		unicornVerify: boolean;
		patchApplicationFailed: boolean; // Type 1: Second patch application failed (e.g., "Menu function not found")
		verificationFailed: boolean;      // Type 2: Patch applied but Unicorn verification failed
	}> = [];

	console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
	console.log('║   Comprehensive Unicorn Test Suite - All Patch Combinations           ║');
	console.log('╚═════════════════════════════════════════════════════════════════════════╝');
	console.log();

	let completedTests = 0;

	for (const firmware of FIRMWARE_INFO) {
		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);

		if (!existsSync(firmwarePath)) {
			console.log(`⚠️  Skipping ${firmware.version} - file not found`);
			continue;
		}

		// Extract ground truth colors for this firmware
		console.log(`\n📦 Testing Firmware: ${firmware.version}`);
		console.log('  Extracting ground truth colors...');
		try {
			firmware.groundTruth = extractGroundTruth(firmwarePath);
			const gt = firmware.groundTruth;
			console.log(`  ✓ Ground truth: FLAC [${gt.flacColors.slice(0, 3).map((v: number) => '0x' + v.toString(16)).join(', ')}...] Menu [${gt.menuColors.slice(0, 3).map((v: number) => '0x' + v.toString(16)).join(', ')}...]`);
		} catch (error) {
			console.log(`  ✗ Failed to extract ground truth: ${error}`);
			continue;
		}

		// Build scenarios with this firmware's ground truth
		const scenarios = buildScenariosForFirmware(firmware.groundTruth);

		console.log('─'.repeat(60));

		for (const scenario of scenarios) {
			console.log(`\n  Scenario: ${scenario.name}`);
			console.log('  '.repeat(56));

			const scenarioResults = {
				firmware: firmware.version,
				scenario: scenario.name,
				firstPatch: false,
				secondPatch: false,
				unicornVerify: false,
				patchApplicationFailed: false,
				verificationFailed: false
			};

			// First patch
			const firstOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_1.IMG`);
			let firstPatchResult = { success: false, nopSlideAddr: 0 };

			try {
				firstPatchResult = applyPatch(firmwarePath, scenario.firstColors, firstOutputPath, firmware.flacAddr);

				if (firstPatchResult.success) {
					console.log(`    ✓ First patch: SUCCESS`);

					// Generate and run Unicorn test for first patch
					const script1Path = join(OUTPUT_DIR, 'scripts', `test_${firmware.version}_${scenario.id}_1.py`);
					const script1 = generateUnicornScript(firmware, scenario.name, 1, scenario.expectedAfterFirst.flac, firstOutputPath, firstPatchResult.nopSlideAddr);
					writeFileSync(script1Path, script1);

					const unicorn1 = runUnicornTest(script1Path);
					if (unicorn1.success) {
						console.log(`    ✓ First patch Unicorn: VERIFIED`);
						scenarioResults.firstPatch = true;
					} else {
						console.log(`    ✗ First patch Unicorn: FAILED`);
						console.log(`      ${unicorn1.output.split('\n').slice(-3).join(' ')}`);
					}
				} else {
					console.log(`    ✗ First patch: FAILED`);
				}
			} catch (error) {
				console.log(`    ✗ First patch: ERROR - ${error}`);
			}

			// Second patch
			if (firstPatchResult.success) {
				const secondOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_2.IMG`);
				let secondPatchResult = { success: false, nopSlideAddr: 0 };

				try {
					secondPatchResult = applyPatch(firstOutputPath, scenario.secondColors, secondOutputPath, firmware.flacAddr);

					if (secondPatchResult.success) {
						console.log(`    ✓ Second patch: SUCCESS`);

						// Generate and run Unicorn test for second patch
						const script2Path = join(OUTPUT_DIR, 'scripts', `test_${firmware.version}_${scenario.id}_2.py`);
						const script2 = generateUnicornScript(firmware, scenario.name, 2, scenario.expectedAfterSecond.flac, secondOutputPath, secondPatchResult.nopSlideAddr);
						writeFileSync(script2Path, script2);

						const unicorn2 = runUnicornTest(script2Path);
						if (unicorn2.success) {
							console.log(`    ✓ Second patch Unicorn: VERIFIED`);
							scenarioResults.secondPatch = true;
							scenarioResults.unicornVerify = true;
						} else {
							console.log(`    ✗ Second patch Unicorn: FAILED`);
							console.log(`      ${unicorn2.output.split('\n').slice(-3).join(' ')}`);
							scenarioResults.verificationFailed = true;
						}
					} else {
						console.log(`    ✗ Second patch: FAILED`);
						scenarioResults.patchApplicationFailed = true;
					}
				} catch (error) {
					console.log(`    ✗ Second patch: ERROR - ${error}`);
				}
			}

			results.push(scenarioResults);
			completedTests += 2;
		}
	}

	// Print summary
	console.log('\n\n╔═══════════════════════════════════════════════════════════════════════════╗');
	console.log('║                           Test Summary                                  ║');
	console.log('╚═════════════════════════════════════════════════════════════════════════╝');
	console.log();

	const firstPatchPassed = results.filter(r => r.firstPatch).length;
	const firstPatchTotal = results.length;
	const secondPatchPassed = results.filter(r => r.secondPatch).length;
	const secondPatchAttempted = results.filter(r => r.firstPatch).length;

	// Count the two types of second patch failures
	const patchApplicationFailures = results.filter(r => r.patchApplicationFailed).length;
	const verificationFailures = results.filter(r => r.verificationFailed).length;

	console.log(`First Patch (FLAC Handler):`);
	console.log(`  ${firstPatchPassed}/${firstPatchTotal} PASSED ✅`);
	console.log();

	console.log(`Second Patch:`);
	console.log(`  Attempted: ${secondPatchAttempted} (only runs if first patch succeeded)`);
	console.log(`  Passed: ${secondPatchPassed}/${secondPatchAttempted} ✅`);
	console.log(`  Failed: ${secondPatchAttempted - secondPatchPassed}/${secondPatchAttempted} ❌`);
	console.log();

	if (patchApplicationFailures > 0) {
		console.log(`Second Patch - Application Failed (Menu function not found): ${patchApplicationFailures}/${secondPatchAttempted}`);
		for (const result of results) {
			if (result.patchApplicationFailed) {
				console.log(`  - ${result.firmware}: ${result.scenario}`);
			}
		}
		console.log();
	}

	if (verificationFailures > 0) {
		console.log(`Second Patch - Verification Failed (Unicorn emulation): ${verificationFailures}/${secondPatchAttempted}`);
		for (const result of results) {
			if (result.verificationFailed) {
				console.log(`  - ${result.firmware}: ${result.scenario}`);
			}
		}
	}

	return {
		firstPatchPassed,
		firstPatchTotal,
		secondPatchPassed,
		secondPatchAttempted,
		results
	};
}

// Run tests
runComprehensiveTests().then(({ firstPatchPassed, firstPatchTotal }) => {
	// Exit with error if not all first patch tests passed
	process.exit(firstPatchPassed === firstPatchTotal ? 0 : 1);
}).catch((error) => {
	console.error('Test execution failed:', error);
	process.exit(1);
});
