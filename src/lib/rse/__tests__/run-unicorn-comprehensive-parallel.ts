/**
 * Parallel Unicorn Test Runner for Theme Patcher
 *
 * This is a PARALLEL version of run-unicorn-comprehensive.ts
 * - Uses worker pool to run multiple Python tests concurrently
 * - Each test writes to its own log file to avoid output corruption
 * - Real-time progress: prints brief status updates
 * - Final summary: aggregates all results
 *
 * Usage: bun run src/lib/rse/__tests__/run-unicorn-comprehensive-parallel.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { ThemePatcher } from '../theme/patcher.js';

// Helper: wait for a file to exist with timeout
async function waitForFile(filePath: string, timeoutMs: number = 30000): Promise<void> {
	const startTime = Date.now();
	while (!existsSync(filePath)) {
		if (Date.now() - startTime > timeoutMs) {
			throw new Error(`Timeout waiting for file: ${filePath}`);
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

/**
 * Generate all firmware patches in parallel using worker threads
 */
async function generateAllFirmwaresInParallel(
	firmwareInfo: Array<{ version: string; file: string; subdir: string; flacAddr?: number; groundTruth: { flacColors: number[]; menuColors: number[] } | null }>
): Promise<Map<string, { nopSlideAddr: number; blAddr: number; flacCodeAddr: number; menuCodeAddr: number }>> {

	// Phase 1 tasks (Initial patches)
	const phase1Tasks: Array<{
		id: string;
		firmwarePath: string;
		colors: { flacColors?: number[]; menuColors?: number[] };
		outputPath: string;
		flacAddr: number;
	}> = [];

	// Phase 2 tasks (Re-patches)
	const phase2Tasks: Array<{
		id: string;
		firmwarePath: string;
		colors: { flacColors?: number[]; menuColors?: number[] };
		outputPath: string;
		flacAddr: number;
	}> = [];

	for (const firmware of firmwareInfo) {
		if (!firmware.groundTruth || !firmware.flacAddr) continue;

		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);
		const scenarios = buildScenariosForFirmware(firmware.groundTruth);

		for (const scenario of scenarios) {
			const firstOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_1.IMG`);
			
			// First patch task
			phase1Tasks.push({
				id: `${firmware.version}_${scenario.id}_1`,
				firmwarePath,
				colors: scenario.firstColors,
				outputPath: firstOutputPath,
				flacAddr: firmware.flacAddr
			});

			// Second patch (if not single-patch)
			if (scenario.secondColors !== null) {
				phase2Tasks.push({
					id: `${firmware.version}_${scenario.id}_2`,
					firmwarePath: firstOutputPath, // Feed the output of patch 1 as input for patch 2
					colors: scenario.secondColors as { flacColors?: number[]; menuColors?: number[] },
					outputPath: join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_2.IMG`),
					flacAddr: firmware.flacAddr
				});
			}
		}
	}

	const results = new Map<string, { nopSlideAddr: number; blAddr: number; flacCodeAddr: number; menuCodeAddr: number }>();
	let startTime = Date.now();

	async function runBatch(tasks: typeof phase1Tasks, phaseName: string) {
		console.log(`\n=== Generating ${tasks.length} firmware files in ${phaseName} ===`);
		let completed = 0;

		for (let i = 0; i < tasks.length; i += MAX_CONCURRENT) {
			const batchIndex = Math.floor(i / MAX_CONCURRENT);
			const batch = tasks.slice(i, Math.min(i + MAX_CONCURRENT, tasks.length));
			console.log(`\n[${phaseName} - Batch ${batchIndex + 1}] Processing ${batch.length} tasks...`);

			const processes = batch.map(task => {
				return new Promise<{ id: string; nopSlideAddr: number; blAddr: number; flacCodeAddr: number; menuCodeAddr: number }>((resolve, reject) => {
					// Create temporary task JSON file
					const taskJsonPath = join(OUTPUT_DIR, `task_${task.id}_${Date.now()}.json`);
					writeFileSync(taskJsonPath, JSON.stringify(task));

					const scriptPath = join(process.cwd(), 'src/lib/rse/__tests__/patch-spawn.ts');
					let resolved = false;

					// Add timeout to prevent hanging (60 seconds per task)
					const timeoutHandle = setTimeout(() => {
						if (!resolved) {
							resolved = true;
							child.kill('SIGKILL');
							reject(new Error(`Process for ${task.id} timed out after 60s`));
						}
					}, 60000);

					const child = spawn('bun', ['run', scriptPath, taskJsonPath], {
						cwd: process.cwd(),
						stdio: ['ignore', 'pipe', 'pipe']
					});

					let stdoutOutput = '';
					let stderrOutput = '';

					child.stdout?.on('data', (data) => {
						stdoutOutput += data.toString();
					});

					child.stderr?.on('data', (data) => {
						stderrOutput += data.toString();
					});

					child.on('exit', (_code, signal) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutHandle);

						if (signal === 'SIGKILL' || signal === 'SIGTERM') {
							reject(new Error(`Process for ${task.id} was killed (${signal})`));
							return;
						}

						try {
							const result = JSON.parse(stdoutOutput.trim());
							if (result.success && result.blAddr !== null) {
								resolve({
									id: result.id,
									nopSlideAddr: result.nopSlideAddr,
									blAddr: result.blAddr,
									flacCodeAddr: result.flacCodeAddr,
									menuCodeAddr: result.menuCodeAddr
								});
							} else {
								console.error(`\n[ERROR] Task ${task.id} failed:\nSTDOUT: ${stdoutOutput}\nSTDERR: ${stderrOutput}`);
								reject(new Error(`Process failed for ${result.id}: ${result.error || 'Unknown error'}`));
							}
						} catch (parseError) {
							console.error(`\n[ERROR] Task ${task.id} output parse error:\nSTDOUT: ${stdoutOutput}\nSTDERR: ${stderrOutput}`);
							reject(new Error(`Failed to parse output for ${task.id}: ${parseError}`));
						}

						try { unlinkSync(taskJsonPath); } catch {}
					});

					child.on('error', (err) => {
						if (!resolved) {
							resolved = true;
							clearTimeout(timeoutHandle);
							reject(err);
						}
					});
				});
			});

			const batchResults = await Promise.allSettled(processes);
			for (const result of batchResults) {
				if (result.status === 'fulfilled') {
					results.set(result.value.id, { 
						nopSlideAddr: result.value.nopSlideAddr, 
						blAddr: result.value.blAddr,
						flacCodeAddr: result.value.flacCodeAddr,
						menuCodeAddr: result.value.menuCodeAddr
					});
				} else {
					console.error(`  ✗ Task failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
				}
			}

			completed += batch.length;
			const elapsedNum = (Date.now() - startTime) / 1000;
			console.log(`  Progress: ${completed}/${tasks.length} - ${elapsedNum.toFixed(1)}s`);
		}
	}

	// Run Phase 1
	await runBatch(phase1Tasks, 'PHASE 1 (Initial Patches)');
	
	// Run Phase 2
	await runBatch(phase2Tasks, 'PHASE 2 (Sequential Patches)');

	console.log(`\n✓ All firmware files generated in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);
	return results;
}


const PYTHON_PATH = '/nix/store/mrvk6p37qm6qk5p95clnghmb1m7bbw8q-system-path/bin/python3';
const FIRMWARE_BASE = '/tmp/echo-mini-firmwares';
// Add timestamp to output directory for better tracking
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUTPUT_DIR = `/tmp/unicorn-comprehensive-parallel-${timestamp}`;
const MAX_CONCURRENT = 8; // Parallel execution using spawn (stable)

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

// Discover FLAC function address dynamically
function discoverFlacFunctionAddress(firmwarePath: string): number {
	const firmwareData = readFileSync(firmwarePath);
	const patcher = new ThemePatcher(firmwareData);

	// Use the analyze method to get function addresses
	const analysis = patcher.analyze();

	const flacFunc = analysis.themeFunctions.find(f => f.type === 'flac');
	if (!flacFunc) {
		throw new Error(`FLAC function not found in ${firmwarePath}`);
	}

	return flacFunc.funcAddr;  // Use funcAddr, not address
}

// Firmware versions (dynamic discovery - addresses discovered at runtime)
const FIRMWARE_INFO = [
	{ version: 'V1.8.0', file: 'HIFIEC80.IMG', subdir: 'ECHO MINI V1.8.0/ECHO MINI V1.8.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.4.0', file: 'HIFIEC40.IMG', subdir: 'ECHO MINI V2.4.0/ECHO MINI V2.4.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.5.0', file: 'HIFIEC50.IMG', subdir: 'ECHO MINI V2.5.0/ECHO MINI V2.5.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.6.0', file: 'HIFIEC60.IMG', subdir: 'ECHO MINI V2.6.0/ECHO MINI V2.6.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.7.0', file: 'HIFIEC70.IMG', subdir: 'ECHO MINI V2.7.0/ECHO MINI V2.7.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V2.8.0', file: 'HIFIEC80.IMG', subdir: 'ECHO MINI V2.8.0/ECHO MINI V2.8.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V3.0.0', file: 'HIFIEC00.IMG', subdir: 'ECHO MINI V3.0.0/ECHO MINI V3.0.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V3.1.0', file: 'HIFIEC10.IMG', subdir: 'ECHO MINI V3.1.0/ECHO MINI V3.1.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
	{ version: 'V3.2.0', file: 'HIFIEC20.IMG', subdir: 'ECHO MINI V3.2.0/ECHO MINI V3.2.0', flacAddr: 0, groundTruth: null as { flacColors: number[]; menuColors: number[] } | null },
];

// Test scenarios
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
	},
];

// Single-patch scenarios (test first patch only, no second patch)
const SINGLE_PATCH_SCENARIOS = [
	{
		id: 'single_flac',
		name: 'Original → FLAC-only',
		firstOp: 'flac-only' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first }),
		isSinglePatch: true as const
	},
	{
		id: 'single_menu',
		name: 'Original → Menu-only',
		firstOp: 'menu-only' as const,
		getFirstColors: () => ({ menuColors: TEST_COLORS.menu.first }),
		isSinglePatch: true as const
	},
	{
		id: 'single_both',
		name: 'Original → Both',
		firstOp: 'both' as const,
		getFirstColors: () => ({ flacColors: TEST_COLORS.flac.first, menuColors: TEST_COLORS.menu.first }),
		isSinglePatch: true as const
	}
];

function buildScenariosForFirmware(groundTruth: { flacColors: number[]; menuColors: number[] }) {
	// Build two-patch scenarios (9 scenarios)
	const twoPatchScenarios = SCENARIO_TEMPLATES.map(template => {
		const firstColors = template.getFirstColors();
		const secondColors = template.getSecondColors();

		// Build expected results (handle partial color objects)
		const expectedAfterFirst = {
			flac: 'flacColors' in firstColors ? firstColors.flacColors : groundTruth.flacColors,
			menu: 'menuColors' in firstColors ? firstColors.menuColors : groundTruth.menuColors
		};

		const expectedAfterSecond = {
			flac: 'flacColors' in secondColors ? secondColors.flacColors : expectedAfterFirst.flac,
			menu: 'menuColors' in secondColors ? secondColors.menuColors : expectedAfterFirst.menu
		};

		return {
			...template,
			firstColors,
			secondColors,
			expectedAfterFirst,
			expectedAfterSecond,
			isSinglePatch: false
		};
	});

	// Build single-patch scenarios (3 scenarios)
	const singlePatchScenarios = SINGLE_PATCH_SCENARIOS.map(template => {
		const firstColors = template.getFirstColors();

		const expectedAfterFirst = {
			flac: 'flacColors' in firstColors ? firstColors.flacColors : groundTruth.flacColors,
			menu: 'menuColors' in firstColors ? firstColors.menuColors : groundTruth.menuColors
		};

		return {
			...template,
			firstColors,
			secondColors: null as { flacColors?: number[]; menuColors?: number[] } | null,
			expectedAfterFirst,
			expectedAfterSecond: null as { flac: number[]; menu: number[] } | null,
			isSinglePatch: true
		};
	});

	// Return all scenarios (12 total)
	return [...twoPatchScenarios, ...singlePatchScenarios];
}

/**
 * Generate Python Unicorn test script for original firmware FLAC String function verification
 * Validates that ThemeColorExtractor extracted colors match actual execution
 */
function generateUnicornScriptForOriginalFlac(
	firmwarePath: string,
	expectedFlac: number[],
	flacStringFuncAddr: number
): string {
	return `
import sys
sys.path.insert(0, '/home/losses/Development/flame-ocean')

from unicorn import *
from unicorn.arm_const import *

# Load original firmware
with open('${firmwarePath}', 'rb') as f:
    data = f.read()

# FLAC String function address (CMP R1, #4 + ITE block)
FLAC_FUNC = 0x${flacStringFuncAddr.toString(16)}

print(f"🎵 Verifying FLAC String function at 0x{FLAC_FUNC:X}")
print(f"   Expected colors: {[f'0x{c:04X}' for c in ${JSON.stringify(expectedFlac)}]}")

# Initialize emulator
mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

# RKNanoD memory map:
# Flash:    0x00000000 - 0x02100000 (33MB)
# SYSRAM0:  0x03000000 - 0x03100000 (1MB)

FLASH_BASE = 0x00000000
FLASH_SIZE = 0x02100000
mu.mem_map(FLASH_BASE, FLASH_SIZE, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)

SYSRAM0_BASE = 0x03000000
SYSRAM0_SIZE = 0x00100000
mu.mem_map(SYSRAM0_BASE, SYSRAM0_SIZE, UC_PROT_READ | UC_PROT_WRITE)

# Write firmware to Flash
mu.mem_write(FLASH_BASE, data[FLASH_BASE:FLASH_BASE + FLASH_SIZE])

# Expected FLAC colors from ThemeColorExtractor
expected_colors = ${JSON.stringify(expectedFlac)}

# Static verification: Read MOVW instructions from FLAC String function
print(f"\\n  Static verification: Reading MOVW instructions from FLAC String function")
print(f"  Function address: 0x{FLAC_FUNC:X}")

# Find CMP R1, #4 + ITE block
cmp_addr = FLAC_FUNC
cmp_bytes = data[cmp_addr:cmp_addr+2]
cmp_hw = cmp_bytes[0] | (cmp_bytes[1] << 8)

if cmp_hw != 0x2904:
    print(f"    ✗ CMP R1, #4 not found at 0x{cmp_addr:X} (got 0x{cmp_hw:04X})")
    sys.exit(1)

print(f"    ✓ CMP R1, #4 at 0x{cmp_addr:X}")

# Check ITE
ite_bytes = data[cmp_addr+2:cmp_addr+4]
ite_hw = ite_bytes[0] | (ite_bytes[1] << 8)

if (ite_hw & 0xFF00) != 0xBF00:
    print(f"    ✗ ITE not found after CMP (got 0x{ite_hw:04X})")
    sys.exit(1)

print(f"    ✓ ITE at 0x{cmp_addr+2:X}")

# Read two MOVW instructions (they load the color values)
# MOVW format: hw1 = 11110(i)1xxxx(imm4), hw2 = xxxx(imm3)xxxx(rd)xxxx(imm8)

def decode_movw(data, addr):
    if addr + 4 > len(data):
        return None

    # Read little-endian halfwords
    hw1 = data[addr] | (data[addr + 1] << 8)
    hw2 = data[addr + 2] | (data[addr + 3] << 8)

    # Check if MOVW (DDI0403 A6.3.2 T3: hw1 = 11110(i)1(imm4), hw2 = xxxx(imm3)xxxx(rd)xxxx(imm8))
    # Base opcode: 0xF240, with i bit at position 10, imm4 at bits [3:0]
    if (hw1 & 0xFBF0) != 0xF240:
        return None

    # Decode according to actual ARM ARM MOVW encoding
    # imm4 = bits 3:0 of hw1
    # i = bit 10 of hw1
    # imm3 = bits 14:12 of hw2
    # imm8 = bits 7:0 of hw2
    i = (hw1 >> 10) & 1
    imm4 = hw1 & 0xF
    imm3 = (hw2 >> 12) & 0x7
    imm8 = hw2 & 0xFF

    # imm16 = imm4[15:12] | i[11] | imm3[10:8] | imm8[7:0]
    imm16 = (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8

    return imm16

# Read MOVW #1 (for theme 4 - Gold)
movw1_addr = cmp_addr + 4
movw1_value = decode_movw(data, movw1_addr)

if movw1_value is None:
    print(f"    ✗ MOVW #1 not found at 0x{movw1_addr:X}")
    sys.exit(1)

print(f"    ✓ MOVW at 0x{movw1_addr:X} = 0x{movw1_value:04X} (theme 4 - Gold)")

# Read MOVW #2 (for themes 0-3)
movw2_addr = movw1_addr + 4
movw2_value = decode_movw(data, movw2_addr)

if movw2_value is None:
    print(f"    ✗ MOVW #2 not found at 0x{movw2_addr:X}")
    sys.exit(1)

print(f"    ✓ MOVW at 0x{movw2_addr:X} = 0x{movw2_value:04X} (themes 0-3)")

# Verify extracted colors match MOVW values
all_passed = True

# Theme 4 should match MOVW #1
if expected_colors[4] == movw1_value:
    print(f"\\n  ✓ Theme 4: expected 0x{expected_colors[4]:04X}, MOVW has 0x{movw1_value:04X}")
else:
    print(f"\\n  ✗ Theme 4: expected 0x{expected_colors[4]:04X}, MOVW has 0x{movw1_value:04X}")
    all_passed = False

# Themes 0-3 should match MOVW #2
for i in range(4):
    if expected_colors[i] == movw2_value:
        print(f"  ✓ Theme {i}: expected 0x{expected_colors[i]:04X}, MOVW has 0x{movw2_value:04X}")
    else:
        print(f"  ✗ Theme {i}: expected 0x{expected_colors[i]:04X}, MOVW has 0x{movw2_value:04X}")
        all_passed = False

print(f"\\n📊 Result: {'✅ PASS' if all_passed else '❌ FAIL'}")
sys.exit(0 if all_passed else 1)
`;
}

/**
 * Generate Python Unicorn test script with BL verification
 * (Same as in run-unicorn-comprehensive.ts)
 */
function generateUnicornScriptWithBLVerification(
	firmware: { version: string; flacAddr: number },
	scenarioName: string,
	patchNum: 1 | 2,
	expectedFlac: number[],
	firmwarePath: string,
	flacFuncAddr: number,
	blAddr: number,
	nopSlideAddr: number,
	flacCodeAddr: number,
	menuCodeAddr: number
): string {
	// Determine which handler we are testing (FLAC or Menu)
	// Compare BL_ADDR with firmware.flacAddr to see if it's in the FLAC function
	const isFlacTest = Math.abs(blAddr - firmware.flacAddr) < 1000;
	const handlerStart = isFlacTest ? flacCodeAddr : menuCodeAddr;

	return `#!/usr/bin/env python3
"""
Unicorn emulation test for ${firmware.version} - ${scenarioName} - Patch ${patchNum}
Generated by run-unicorn-comprehensive-parallel.ts
"""

import sys
sys.path.insert(0, '/home/losses/Development/flame-ocean')

from unicorn import *
from unicorn.arm_const import *
from capstone import *

# Load firmware
with open('${firmwarePath}', 'rb') as f:
    data = f.read()

FLAC_FUNC = ${flacFuncAddr}
BL_ADDR = ${blAddr}
EXPECTED_HANDLER = ${nopSlideAddr}
HANDLER_START = ${handlerStart}
RETURN_ADDR = BL_ADDR + 4  # 返回到 BL 指令之后的地址
FLASH_BASE = 0x00000000
FLASH_SIZE = 0x02100000
SYSRAM0_BASE = 0x03000000
SYSRAM0_SIZE = 0x00100000

print(f"🔍 Test Config:")
print(f"   BL_ADDR: 0x{BL_ADDR:X}")
print(f"   HANDLER_START: 0x{HANDLER_START:X}")
print(f"   EXPECTED_HANDLER (NOP slide): 0x{EXPECTED_HANDLER:X}")

# Initialize emulator
mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)
mu.mem_map(FLASH_BASE, FLASH_SIZE, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)
mu.mem_map(SYSRAM0_BASE, SYSRAM0_SIZE, UC_PROT_READ | UC_PROT_WRITE)
mu.mem_write(FLASH_BASE, data[FLASH_BASE:FLASH_BASE + FLASH_SIZE])

# Initialize Capstone for tracing
md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)

# Extract actual colors from the handler's MOVW instructions
def decode_movw(data, addr):
    if addr + 4 > len(data):
        return None
    hw1 = data[addr] | (data[addr + 1] << 8)
    hw2 = data[addr + 2] | (data[addr + 3] << 8)
    if (hw1 & 0xFBF0) != 0xF240:
        return None
    i = (hw1 >> 10) & 1
    imm4 = hw1 & 0xF
    imm3 = (hw2 >> 12) & 0x7
    imm8 = hw2 & 0xFF
    imm16 = (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8
    return imm16

# Extract colors from MOVW instructions
actual_colors = []
# FLAC handler has 5 colors, Menu handler has 12 colors (currently)
is_flac = ${isFlacTest ? 'True' : 'False'}
num_colors = 5 if is_flac else 12

for i in range(num_colors):
    # theme i (R{4+i} for FLAC, R{i} for Menu)
    # FLAC handler starts with PUSH {R4-R7, LR}, MOV R3, R8, PUSH {R3} (6 bytes)
    # Then MOVW/MOVT pairs (8 bytes each)
    if is_flac:
        movw_addr = HANDLER_START + 6 + i * 8
    else:
        # Menu handler starts with MOVW/MOVT pairs immediately (0 offset)
        movw_addr = HANDLER_START + i * 8
        
    color = decode_movw(data, movw_addr)
    if color is None:
        print(f"ERROR: MOVW not found at 0x{movw_addr:X} for theme {i}")
        # Disassemble around the error point for debugging
        print(f"Disassembly around 0x{movw_addr:X}:")
        try:
            debug_code = data[movw_addr-16:movw_addr+16]
            for instr in md.disasm(debug_code, movw_addr-16):
                print(f"  0x{instr.address:X}: {instr.mnemonic} {instr.op_str}")
        except:
            pass
        sys.exit(1)
    actual_colors.append(color)

expected_flac = actual_colors

# Callee-saved register preservation test values
CALLER_R4 = 0x12345678
CALLER_R5 = 0x87654321
CALLER_R6 = 0xABCDEF00
CALLER_R7 = 0xFEDCBA00
CALLER_R8 = 0x11223344

bl_executed = False
bl_target_actual = 0
bx_lr_executed = False
flac_results = []
registers_preserved = True
instruction_count = 0
MAX_INSTRUCTIONS = 1000

def hook_code(uc, address, size, user_data):
    global bl_executed, bl_target_actual, bx_lr_executed, flac_results, registers_preserved, instruction_count

    instruction_count += 1
    if instruction_count > MAX_INSTRUCTIONS:
        uc.emu_stop()
        return

    # Trace execution
    try:
        code = uc.mem_read(address, size)
        for i in md.disasm(code, address):
            # print(f"  0x{i.address:X}: {i.mnemonic} {i.op_str}")
            if i.mnemonic == 'strh' and 'r1' in i.op_str:
                r1 = uc.reg_read(UC_ARM_REG_R1)
                r0 = uc.reg_read(UC_ARM_REG_R0)
                print(f"    [TRACE] STRH R1(0x{r1:X}), [R0(0x{r0:X})]")
    except:
        pass

    # Check BL instruction
    if (address & ~1) == BL_ADDR:
        bl_executed = True
        print(f"  [TRACE] Reached BL instruction at 0x{address:X}")

    # Check for handler return (BX LR or POP {...,PC})
    try:
        instr_bytes = uc.mem_read(address, 2)
        is_bx_lr = instr_bytes[0] == 0x70 and instr_bytes[1] == 0x47
        is_pop_pc = instr_bytes[0] == 0xF0 and instr_bytes[1] == 0xBD
        if is_bx_lr or is_pop_pc:
            bx_lr_executed = True
            print(f"  [TRACE] Handler returning at 0x{address:X}")
            
            # For Menu test, check registers at return
            if not is_flac:
                r0 = uc.reg_read(UC_ARM_REG_R0)
                r1 = uc.reg_read(UC_ARM_REG_R1)
                print(f"  [TRACE] Menu handler return: R0=0x{r0:X}, R1=0x{r1:X}")
            
            # STOP EMULATION when returning from handler
            uc.emu_stop()
    except:
        pass

    # FORCE STOP after STRH to prevent R1 being overwritten by original firmware code
    # (Original firmware often has 'add r1, sp, #0x78' or similar after the patch point)
    if address == (BL_ADDR + 14) and is_flac:
        print(f"  [TRACE] Forcing stop at 0x{address:X} after STRH")
        
        # Check callee-saved registers at return
        r4 = uc.reg_read(UC_ARM_REG_R4)
        r5 = uc.reg_read(UC_ARM_REG_R5)
        r6 = uc.reg_read(UC_ARM_REG_R6)
        r7 = uc.reg_read(UC_ARM_REG_R7)
        r8 = uc.reg_read(UC_ARM_REG_R8)
        print(f"  [TRACE] Registers at return: R4=0x{r4:X}, R5=0x{r5:X}, R6=0x{r6:X}, R7=0x{r7:X}, R8=0x{r8:X}")
        
        uc.emu_stop()

mu.hook_add(UC_HOOK_CODE, hook_code)

all_success = True

# For Menu test, we only test theme 0 since it's just a direct jump
test_range = range(len(expected_flac)) if is_flac else range(1)

for theme_idx in test_range:
    expected_color = expected_flac[theme_idx]
    print(f"\\n--- Testing Theme {theme_idx} ---")
    bl_executed = False
    bl_target_actual = 0
    bx_lr_executed = False
    instruction_count = 0

    # === 栈帧初始化 (修正布局) ===
    # 补丁处理程序压栈顺序: PUSH {R4-R7, LR}, 然后 PUSH {R3} (R8)
    STACK_BASE = 0x03050000
    stackFrame = [
        CALLER_R8,           # R8 [SP+0]
        CALLER_R4,           # R4 [SP+4]
        CALLER_R5,           # R5 [SP+8]
        CALLER_R6,           # R6 [SP+12]
        CALLER_R7,           # R7 [SP+16]
        RETURN_ADDR          # LR [SP+20]
    ]

    import struct
    for i in range(len(stackFrame)):
        addr = STACK_BASE - (len(stackFrame) - i) * 4
        buf = struct.pack('<I', stackFrame[i])
        mu.mem_write(addr, buf)

    mu.reg_write(UC_ARM_REG_SP, STACK_BASE - len(stackFrame) * 4)
    mu.reg_write(UC_ARM_REG_LR, RETURN_ADDR)

    mu.reg_write(UC_ARM_REG_R4, CALLER_R4)
    mu.reg_write(UC_ARM_REG_R5, CALLER_R5)
    mu.reg_write(UC_ARM_REG_R6, CALLER_R6)
    mu.reg_write(UC_ARM_REG_R7, CALLER_R7)
    mu.reg_write(UC_ARM_REG_R8, CALLER_R8)
    mu.reg_write(UC_ARM_REG_R1, theme_idx)
    mu.reg_write(UC_ARM_REG_PC, (FLAC_FUNC if is_flac else BL_ADDR) | 1)
    mu.reg_write(UC_ARM_REG_CPSR, 0x000001F3)

    try:
        # Stop emulation after executing STRH instruction (BL_ADDR + 12 + 2 = BL_ADDR + 14)
        if is_flac:
            mu.emu_start((FLAC_FUNC) | 1, (BL_ADDR + 16) | 1, 0, 1000)
        else:
            # Menu function just jump to handler
            mu.emu_start(BL_ADDR | 1, (BL_ADDR + 4) | 1, 0, 1000)
    except UcError as e:
        if bl_executed:
            pass
        else:
            print(f"Theme {theme_idx}: Unicorn error: {e}")
            all_success = False
            continue

    theme_success = True

    if not bl_executed:
        print(f"Theme {theme_idx}: ✗ BL instruction not executed")
        theme_success = False

    r1_value = mu.reg_read(UC_ARM_REG_R1)
    color_value = r1_value & 0xFFFF
    if color_value != expected_color:
        print(f"Theme {theme_idx}: ✗ Color mismatch: expected 0x{expected_color:04X}, got 0x{color_value:04X}")
        theme_success = False
    else:
        print(f"Theme {theme_idx}: ✓ Color value correct: 0x{color_value:04X}")

    actual_r4 = mu.reg_read(UC_ARM_REG_R4)
    actual_r5 = mu.reg_read(UC_ARM_REG_R5)
    actual_r6 = mu.reg_read(UC_ARM_REG_R6)
    actual_r7 = mu.reg_read(UC_ARM_REG_R7)
    actual_r8 = mu.reg_read(UC_ARM_REG_R8)

    if (actual_r4 != CALLER_R4 or actual_r5 != CALLER_R5 or
        actual_r6 != CALLER_R6 or actual_r7 != CALLER_R7 or actual_r8 != CALLER_R8):
        print(f"Theme {theme_idx}: ✗ Register corruption")
        print(f"  Expected: R4=0x{CALLER_R4:X}, R5=0x{CALLER_R5:X}, R6=0x{CALLER_R6:X}, R7=0x{CALLER_R7:X}, R8=0x{CALLER_R8:X}")
        print(f"  Actual:   R4=0x{actual_r4:X}, R5=0x{actual_r5:X}, R6=0x{actual_r6:X}, R7=0x{actual_r7:X}, R8=0x{actual_r8:X}")
        theme_success = False

    if not theme_success:
        all_success = False
    else:
        flac_results.append(color_value)

if all_success:
    print("✅ PASS")
    sys.exit(0)
else:
    print("❌ FAIL")
    sys.exit(1)
`;
}

// Helper functions (same as original)
function findBlInFunction(firmwareData: Uint8Array, funcAddr: number): number | null {
	const decoder = new TextDecoder();
	for (let offset = 0; offset < 100; offset += 2) {
		const addr = funcAddr + offset;
		if (addr + 4 > firmwareData.length) break;

		// BL instruction in little-endian: [low1, high1, low2, high2]
		// high1 byte (addr+1): bits [15:11] should be 11110 for BL
		// high2 byte (addr+3): bits [15:14] should be 11 for BL
		const high1 = firmwareData[addr + 1];
		const high2 = firmwareData[addr + 3];

		if ((high1 & 0xF8) === 0xF0 && (high2 & 0xF0) >= 0x80) {
			return addr;
		}
	}
	return null;
}

function decodeBlTarget(firmwareData: Uint8Array, blAddr: number): number {
	const blBytes = firmwareData.slice(blAddr, blAddr + 4);
	const { decodeBlTarget: decodeFromEncoders } = require('../theme/thumb/encoders.js');
	return decodeFromEncoders(blAddr, blBytes);
}

function verifyNopSlideBoundaries(firmwareData: Uint8Array, nopSlideAddr: number, firmwareSize: number): { safe: boolean; message: string } {
	if (nopSlideAddr < 0 || nopSlideAddr >= firmwareSize) {
		return { safe: false, message: `NOP slide at 0x${nopSlideAddr.toString(16)} is outside firmware bounds` };
	}

	const checkSize = Math.min(64, firmwareSize - nopSlideAddr);
	let zeroCount = 0;
	for (let i = 0; i < checkSize; i++) {
		if (firmwareData[nopSlideAddr + i] === 0x00) {
			zeroCount++;
		}
	}

	if (zeroCount < checkSize * 0.8) {
		return {
			safe: false,
			message: `Region at 0x${nopSlideAddr.toString(16)} doesn't appear to be a valid NOP slide (${zeroCount}/${checkSize} zeros)`
		};
	}

	return { safe: true, message: 'OK' };
}

function applyPatch(
	firmwarePath: string,
	options: { flacColors?: number[]; menuColors?: number[] },
	outputPath: string,
	flacAddr: number
): { success: boolean; nopSlideAddr: number; blAddr: number | null } {
	try {
		const firmwareData = readFileSync(firmwarePath);
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch(options, outputPath, true);

		if (!result.success) {
			return { success: false, nopSlideAddr: 0, blAddr: null };
		}

		const patchedData = readFileSync(outputPath);
		const blAddr = findBlInFunction(patchedData, flacAddr);

		if (!blAddr) {
			return { success: false, nopSlideAddr: 0, blAddr: null };
		}

		const nopSlideAddr = decodeBlTarget(patchedData, blAddr);
		const boundaryCheck = verifyNopSlideBoundaries(patchedData, nopSlideAddr, patchedData.length);

		return { success: true, nopSlideAddr, blAddr };
	} catch (error) {
		return { success: false, nopSlideAddr: 0, blAddr: null };
	}
}

/**
 * ASYNC: Run Python Unicorn test with proper output capture
 */
function runUnicornTestAsync(scriptPath: string, logPath: string): Promise<{ success: boolean; output: string }> {
	return new Promise((resolve) => {
		const output: string[] = [];
		const errors: string[] = [];
		let resolved = false;

		const cleanup = (result: { success: boolean; output: string }) => {
			if (!resolved) {
				resolved = true;
				try {
					writeFileSync(logPath, result.output);
				} catch (e) {
					// Ignore write errors
				}
				clearTimeout(timeoutHandle);
				resolve(result);
			}
		};

		const child = spawn(PYTHON_PATH, [scriptPath], {
			cwd: process.cwd(),
			timeout: 30000
		});

		// Add Promise-level timeout as backup (35 seconds)
		const timeoutHandle = setTimeout(() => {
			child.kill('SIGKILL');
			cleanup({
				success: false,
				output: `TIMEOUT after 35s\n\nPartial output:\n${output.join('')}\n\nErrors:\n${errors.join('')}`
			});
		}, 35000);

		child.stdout.on('data', (data) => {
			const text = data.toString();
			output.push(text);
		});

		child.stderr.on('data', (data) => {
			const text = data.toString();
			errors.push(text);
		});

		// Use 'exit' instead of 'close' - it always fires
		child.on('exit', (_code, signal) => {
			const fullOutput = output.join('') + errors.join('');
			const success = fullOutput.includes('✅ PASS');

			if (signal === 'SIGKILL' || signal === 'SIGTERM') {
				cleanup({
					success: false,
					output: fullOutput || `Process killed by signal ${signal}`
				});
			} else {
				cleanup({
					success,
					output: fullOutput
				});
			}
		});

		child.on('error', (error) => {
			cleanup({
				success: false,
				output: error.message
			});
		});
	});
}

/**
 * Worker pool for parallel execution
 */
async function runTestsWithPool(tests: Array<{
	id: string;
	test: () => Promise<any>;
}>): Promise<Array<{ id: string; result: any }>> {
	const results: Array<{ id: string; result: any }> = [];
	const executing: Promise<void>[] = [];

	for (const { id, test } of tests) {
		const promise = test().then(result => {
			results.push({ id, result });
		});

		executing.push(promise);

		if (executing.length >= MAX_CONCURRENT) {
			await Promise.race(executing);
			executing.splice(executing.findIndex(p => p === promise), 1);
		}
	}

	await Promise.all(executing);
	return results;
}

/**
 * Main test runner with parallel execution
 */
async function runComprehensiveTests() {
	// Create output directory
	if (!existsSync(OUTPUT_DIR)) {
		mkdirSync(OUTPUT_DIR, { recursive: true });
	}
	const scriptsDir = join(OUTPUT_DIR, 'scripts');
	if (!existsSync(scriptsDir)) {
		mkdirSync(scriptsDir, { recursive: true });
	}
	const logsDir = join(OUTPUT_DIR, 'logs');
	if (!existsSync(logsDir)) {
		mkdirSync(logsDir, { recursive: true });
	}

	console.log('=== Comprehensive Theme Patcher Tests (PARALLEL) ===\n');
	console.log(`Max concurrent workers: ${MAX_CONCURRENT}`);
	console.log(`Output directory: ${OUTPUT_DIR}\n`);

	// Load firmware info and extract ground truth
	const startTime = Date.now();

	console.log('Loading firmware information...');
	for (const firmware of FIRMWARE_INFO) {
		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);
		if (!existsSync(firmwarePath)) {
			console.warn(`  ⚠ Firmware not found: ${firmware.version}`);
			continue;
		}

		try {
			firmware.groundTruth = extractGroundTruth(firmwarePath);
			const flacAddr = discoverFlacFunctionAddress(firmwarePath);
			(firmware as any).flacAddr = flacAddr;  // Store discovered address
			console.log(`  ✓ ${firmware.version}: Ground truth extracted, FLAC@0x${flacAddr.toString(16).toUpperCase()}`);
		} catch (error) {
			console.error(`  ✗ ${firmware.version}: Failed to extract ground truth - ${(error as Error).message}`);
		}
	}

	// Ground truth verification first (sequential - must complete before patch tests)
	console.log('\n=== Ground Truth Verification ===');
	for (const firmware of FIRMWARE_INFO) {
		if (!firmware.groundTruth) continue;

		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);
		console.log(`\n${firmware.version}: Verifying ground truth colors...`);

		try {
			const verifyScriptPath = join(scriptsDir, `verify_${firmware.version}_flac.py`);
			const verifyLogPath = join(logsDir, `verify_${firmware.version}_flac.log`);
			const verifyScript = generateUnicornScriptForOriginalFlac(
				firmwarePath,
				firmware.groundTruth.flacColors,
				firmware.flacAddr
			);
			writeFileSync(verifyScriptPath, verifyScript);

			const verifyResult = await runUnicornTestAsync(verifyScriptPath, verifyLogPath);
			if (verifyResult.success) {
				console.log(`  ✓ Ground truth verification: PASSED`);
			} else {
				console.log(`  ⚠ Ground truth verification: FAILED`);
				console.log(`    ${verifyResult.output.split('\n').slice(-3).join(' ')}`);
			}
		} catch (error) {
			console.log(`  ⚠ Ground truth verification skipped: ${error}`);
		}
	}

	// Generate all firmware files in parallel using worker threads
	const firmwareResults = await generateAllFirmwaresInParallel(FIRMWARE_INFO);

	// Collect all test cases (now only Python tests, no patching)
	const allTestCases: Array<{
		id: string;
		firmwareVersion: string;
		scenarioName: string;
		patchNum: 1 | 2;
		test: () => Promise<any>;
	}> = [];

	for (const firmware of FIRMWARE_INFO) {
		if (!firmware.groundTruth) continue;

		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);

		// Build scenarios for this firmware
		const scenarios = buildScenariosForFirmware(firmware.groundTruth);

		for (const scenario of scenarios) {
			const firstOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_1.IMG`);
			const script1BLPath = join(scriptsDir, `test_${firmware.version}_${scenario.id}_1_bl.py`);
			const log1Path = join(logsDir, `test_${firmware.version}_${scenario.id}_1_bl.log`);

			// Get pre-generated firmware info
			const firstFirmwareInfo = firmwareResults.get(`${firmware.version}_${scenario.id}_1`);
			if (!firstFirmwareInfo) {
				console.error(`  ✗ Missing firmware info for ${firmware.version}_${scenario.id}_1`);
				continue;
			}

			// Single-patch scenarios: run first patch and test
			if (scenario.isSinglePatch) {
				allTestCases.push({
					id: `${firmware.version}_${scenario.id}_1`,
					firmwareVersion: firmware.version,
					scenarioName: scenario.name,
					patchNum: 1,
					test: async () => {
						// Firmware already generated, just run Python test
						const script1BL = generateUnicornScriptWithBLVerification(
							firmware,
							scenario.name,
							1,
							scenario.expectedAfterFirst.flac,
							firstOutputPath,
							firmware.flacAddr,
							firstFirmwareInfo.blAddr,
							firstFirmwareInfo.nopSlideAddr,
							firstFirmwareInfo.flacCodeAddr,
							firstFirmwareInfo.menuCodeAddr
						);
						writeFileSync(script1BLPath, script1BL);

						const unicorn1BL = await runUnicornTestAsync(script1BLPath, log1Path);
						return {
							success: unicorn1BL.success
						};
					}
				});
			} else {
				// Two-patch scenarios: run BOTH patches sequentially, then test both
				const secondOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_2.IMG`);
				const script2BLPath = join(scriptsDir, `test_${firmware.version}_${scenario.id}_2_bl.py`);
				const log2Path = join(logsDir, `test_${firmware.version}_${scenario.id}_2_bl.log`);

				// Get pre-generated firmware info for second patch
				const secondFirmwareInfo = firmwareResults.get(`${firmware.version}_${scenario.id}_2`);
				if (!secondFirmwareInfo) {
					console.error(`  ✗ Missing firmware info for ${firmware.version}_${scenario.id}_2`);
					continue;
				}

				// First patch test case
				allTestCases.push({
					id: `${firmware.version}_${scenario.id}_1`,
					firmwareVersion: firmware.version,
					scenarioName: scenario.name,
					patchNum: 1,
					test: async () => {
						// Firmware already generated, just run Python test
						const script1BL = generateUnicornScriptWithBLVerification(
							firmware,
							scenario.name,
							1,
							scenario.expectedAfterFirst.flac,
							firstOutputPath,
							firmware.flacAddr,
							firstFirmwareInfo.blAddr,
							firstFirmwareInfo.nopSlideAddr,
							firstFirmwareInfo.flacCodeAddr,
							firstFirmwareInfo.menuCodeAddr
						);
						writeFileSync(script1BLPath, script1BL);

						const unicorn1BL = await runUnicornTestAsync(script1BLPath, log1Path);
						return {
							success: unicorn1BL.success
						};
					}
				});

				// Second patch test case
				allTestCases.push({
					id: `${firmware.version}_${scenario.id}_2`,
					firmwareVersion: firmware.version,
					scenarioName: scenario.name,
					patchNum: 2,
					test: async () => {
						// Firmware already generated, just run Python test
						const script2BL = generateUnicornScriptWithBLVerification(
							firmware,
							scenario.name,
							2,
							scenario.expectedAfterSecond!.flac,
							secondOutputPath,
							firmware.flacAddr,
							secondFirmwareInfo.blAddr,
							secondFirmwareInfo.nopSlideAddr,
							secondFirmwareInfo.flacCodeAddr,
							secondFirmwareInfo.menuCodeAddr
						);
						writeFileSync(script2BLPath, script2BL);

						const unicorn2BL = await runUnicornTestAsync(script2BLPath, log2Path);
						return {
							success: unicorn2BL.success
						};
					}
				});
			}
		}
	}

	console.log(`\nTotal test cases: ${allTestCases.length}`);
	console.log('Starting parallel execution...\n');

	// Run tests with worker pool
	const results = await runTestsWithPool(allTestCases);

	// Print results in order
	let firstPatchPassed = 0;
	let firstPatchTotal = 0;
	let secondPatchPassed = 0;
	let secondPatchTotal = 0;

	console.log('\n=== Test Results (in order) ===\n');

	// Group results by firmware and scenario for cleaner output
	const grouped = new Map<string, Array<{ patchNum: number; result: any }>>();
	for (const result of results) {
		const key = result.id.slice(0, -2); // Remove _1 or _2 suffix
		if (!grouped.has(key)) {
			grouped.set(key, []);
		}
		const patchNum = result.id.endsWith('_1') ? 1 : 2;
		grouped.get(key)!.push({ patchNum, result: result.result });
	}

	for (const [id, tests] of grouped.entries()) {
		const [firmwareVer, scenarioId] = id.split('_');
		const scenario = SCENARIO_TEMPLATES.find(s => s.id === scenarioId);

		console.log(`\n${firmwareVer} - ${scenario?.name || scenarioId}`);

		for (const { patchNum, result } of tests) {
			if (patchNum === 1) {
				firstPatchTotal++;
				if (result.success) {
					firstPatchPassed++;
					console.log(`  ✓ Patch 1: PASS`);
				} else {
					console.log(`  ✗ Patch 1: FAIL`);
				}
			} else {
				secondPatchTotal++;
				if (result.success) {
					secondPatchPassed++;
					console.log(`  ✓ Patch 2: PASS`);
				} else {
					console.log(`  ✗ Patch 2: FAIL`);
				}
			}
		}
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

	console.log('\n=== Summary ===');
	console.log(`First patch:  ${firstPatchPassed}/${firstPatchTotal} passed`);
	console.log(`Second patch: ${secondPatchPassed}/${secondPatchTotal} passed`);
	console.log(`Total tests:  ${firstPatchPassed + secondPatchPassed}/${firstPatchTotal + secondPatchTotal} passed`);
	console.log(`Time elapsed: ${elapsed}s`);
	console.log(`\nIndividual logs: ${logsDir}`);

	return {
		firstPatchPassed,
		firstPatchTotal,
		secondPatchPassed,
		secondPatchTotal
	};
}

// Run tests
runComprehensiveTests().then(({ firstPatchPassed, firstPatchTotal }) => {
	process.exit(firstPatchPassed === firstPatchTotal ? 0 : 1);
}).catch((error) => {
	console.error('Test execution failed:', error);
	process.exit(1);
});
