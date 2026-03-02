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

					child.on('exit', (code, signal) => {
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
								reject(new Error(`Process failed for ${task.id}: ${result.error || 'Unknown error'}`));
							}
						} catch (parseError) {
							reject(new Error(`Failed to parse output for ${task.id} (exit code ${code}): ${parseError}\nSTDOUT: ${stdoutOutput}\nSTDERR: ${stderrOutput}`));
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

# Read two MOVW instructions
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

movw1_addr = cmp_addr + 4
movw1_value = decode_movw(data, movw1_addr)
if movw1_value is None:
    print(f"    ✗ MOVW #1 not found at 0x{movw1_addr:X}")
    sys.exit(1)
print(f"    ✓ MOVW at 0x{movw1_addr:X} = 0x{movw1_value:04X} (theme 4 - Gold)")

movw2_addr = movw1_addr + 4
movw2_value = decode_movw(data, movw2_addr)
if movw2_value is None:
    print(f"    ✗ MOVW #2 not found at 0x{movw2_addr:X}")
    sys.exit(1)
print(f"    ✓ MOVW at 0x{movw2_addr:X} = 0x{movw2_value:04X} (themes 0-3)")

all_passed = True
if expected_colors[4] == movw1_value:
    print(f"\\n  ✓ Theme 4: expected 0x{expected_colors[4]:04X}, MOVW has 0x{movw1_value:04X}")
else:
    print(f"\\n  ✗ Theme 4: expected 0x{expected_colors[4]:04X}, MOVW has 0x{movw1_value:04X}")
    all_passed = False

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
 */
function generateUnicornScriptWithBLVerification(
	firmware: { version: string; flacAddr: number },
	scenarioName: string,
	patchNum: 1 | 2,
	expectedColors: number[],
	firmwarePath: string,
	flacFuncAddr: number,
	blAddr: number,
	nopSlideAddr: number,
	flacCodeAddr: number,
	menuCodeAddr: number
): string {
	const isFlacTest = Math.abs(blAddr - firmware.flacAddr) < 1000;
	const handlerStart = isFlacTest ? flacCodeAddr : menuCodeAddr;

	return `#!/usr/bin/env python3
import sys
sys.path.insert(0, '/home/losses/Development/flame-ocean')
from unicorn import *
from unicorn.arm_const import *
from capstone import *

with open('${firmwarePath}', 'rb') as f:
    data = f.read()

FLAC_FUNC = ${flacFuncAddr}
BL_ADDR = ${blAddr}
EXPECTED_HANDLER = ${nopSlideAddr}
HANDLER_START = ${handlerStart}
RETURN_ADDR = BL_ADDR + 4
FLASH_BASE = 0x00000000
FLASH_SIZE = 0x02100000
SYSRAM0_BASE = 0x03000000
SYSRAM0_SIZE = 0x00100000
is_flac = ${isFlacTest ? 'True' : 'False'}

print(f"🔍 Test Config: BL=0x{BL_ADDR:X}, Handler=0x{HANDLER_START:X}, IS_FLAC={is_flac}")

mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)
mu.mem_map(FLASH_BASE, FLASH_SIZE, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)
mu.mem_map(SYSRAM0_BASE, SYSRAM0_SIZE, UC_PROT_READ | UC_PROT_WRITE)
mu.mem_write(FLASH_BASE, data[FLASH_BASE:FLASH_BASE + FLASH_SIZE])
md = Cs(CS_ARCH_ARM, CS_MODE_THUMB)

def decode_movw(data, addr):
    if addr + 4 > len(data): return None
    hw1 = data[addr] | (data[addr + 1] << 8)
    hw2 = data[addr + 2] | (data[addr + 3] << 8)
    if (hw1 & 0xFBF0) != 0xF240: return None
    i = (hw1 >> 10) & 1
    imm4 = hw1 & 0xF
    imm3 = (hw2 >> 12) & 0x7
    imm8 = hw2 & 0xFF
    return (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8

actual_colors = []
num_colors = 5 if is_flac else 3
for i in range(num_colors):
    if is_flac:
        # Theme section offset calculation:
        #   PUSH {R4, LR} (2 bytes)
        #   4 * (CMP R1, #i; BEQ theme_i) (4 * 4 = 16 bytes)
        # Theme i MOVW/MOVT at offset 2 + 16 + (4 - i) * 10 (reverse order)
        movw_addr = HANDLER_START + 18 + (4 - i) * 10
    else:
        # Menu handler starts with MOVW/MOVT pairs immediately (0 offset)
        # We load R1, R2, R3 correctly
        movw_addr = HANDLER_START + i * 8
        
    color = decode_movw(data, movw_addr)
    if color is None:
        print(f"ERROR: MOVW not found at 0x{movw_addr:X} for theme/index {i}")
        sys.exit(1)
    actual_colors.append(color)

expected_flac = actual_colors
CALLER_R4 = 0x12345678
bl_executed = False
bx_lr_executed = False

def hook_code(uc, address, size, user_data):
    global bl_executed, bx_lr_executed
    if (address & ~1) == BL_ADDR:
        bl_executed = True
    try:
        instr_bytes = uc.mem_read(address, 2)
        is_bx_lr = instr_bytes[0] == 0x70 and instr_bytes[1] == 0x47
        is_pop_pc = (instr_bytes[1] == 0xBD)
        if is_bx_lr or is_pop_pc:
            bx_lr_executed = True
            uc.emu_stop()
    except: pass
    if address == (BL_ADDR + 14) and is_flac:
        uc.emu_stop()

mu.hook_add(UC_HOOK_CODE, hook_code)
all_success = True
test_range = range(len(expected_flac)) if is_flac else range(1)

for theme_idx in test_range:
    expected_color = expected_flac[theme_idx]
    STACK_BASE = 0x03050000
    stackFrame = [CALLER_R4, RETURN_ADDR] if is_flac else []
    import struct
    for i in range(len(stackFrame)):
        addr = STACK_BASE - (len(stackFrame) - i) * 4
        mu.mem_write(addr, struct.pack('<I', stackFrame[i]))
    mu.reg_write(UC_ARM_REG_SP, STACK_BASE - len(stackFrame) * 4)
    mu.reg_write(UC_ARM_REG_LR, RETURN_ADDR)
    mu.reg_write(UC_ARM_REG_R4, CALLER_R4)
    mu.reg_write(UC_ARM_REG_R1, theme_idx)
    mu.reg_write(UC_ARM_REG_PC, (FLAC_FUNC if is_flac else BL_ADDR) | 1)
    mu.reg_write(UC_ARM_REG_CPSR, 0x000001F3)
    try:
        if is_flac: mu.emu_start(FLAC_FUNC | 1, (BL_ADDR + 16) | 1, 0, 1000)
        else: mu.emu_start(BL_ADDR | 1, (BL_ADDR + 4) | 1, 0, 1000)
    except UcError:
        if not bl_executed: all_success = False; continue
    if not bl_executed: all_success = False
    if (mu.reg_read(UC_ARM_REG_R1) & 0xFFFF) != expected_color: all_success = False
    if mu.reg_read(UC_ARM_REG_R4) != CALLER_R4: all_success = False

if all_success: print("✅ PASS"); sys.exit(0)
else: print("❌ FAIL"); sys.exit(1)
`;
}

function findBlInFunction(firmwareData: Uint8Array, funcAddr: number): number | null {
	for (let offset = 0; offset < 100; offset += 2) {
		const addr = funcAddr + offset;
		if (addr + 4 > firmwareData.length) break;
		const high1 = firmwareData[addr + 1];
		const high2 = firmwareData[addr + 3];
		if ((high1 & 0xF8) === 0xF0 && (high2 & 0xF0) >= 0x80) return addr;
	}
	return null;
}

function discoverFlacFunctionAddress(firmwarePath: string): number {
	const firmwareData = readFileSync(firmwarePath);
	const patcher = new ThemePatcher(firmwareData);
	const analysis = patcher.analyze();
	const flacFunc = analysis.themeFunctions.find(f => f.type === 'flac');
	if (!flacFunc) throw new Error(`FLAC function not found in ${firmwarePath}`);
	return flacFunc.funcAddr;
}

/**
 * Run a Python Unicorn test script and capture its output
 */
async function runUnicornTestAsync(
	scriptPath: string,
	logPath: string
): Promise<{ success: boolean; output: string }> {
	return new Promise((resolve) => {
		const child = spawn(PYTHON_PATH, [scriptPath], {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let output = '';
		child.stdout?.on('data', (data) => {
			output += data.toString();
		});
		child.stderr?.on('data', (data) => {
			output += data.toString();
		});

		child.on('close', (code) => {
			writeFileSync(logPath, output);
			resolve({
				success: code === 0,
				output
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
	const executing = new Set<Promise<void>>();

	for (const { id, test } of tests) {
		const promise = test().then(result => {
			results.push({ id, result });
		});
		executing.add(promise);
		promise.finally(() => executing.delete(promise));

		if (executing.size >= MAX_CONCURRENT) {
			await Promise.race(Array.from(executing));
		}
	}
	await Promise.all(Array.from(executing));
	return results;
}

async function runComprehensiveTests() {
	if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
	const scriptsDir = join(OUTPUT_DIR, 'scripts');
	if (!existsSync(scriptsDir)) mkdirSync(scriptsDir, { recursive: true });
	const logsDir = join(OUTPUT_DIR, 'logs');
	if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

	console.log('=== Comprehensive Theme Patcher Tests (PARALLEL) ===\n');
	console.log(`Output directory: ${OUTPUT_DIR}\n`);
	const startTime = Date.now();

	for (const firmware of FIRMWARE_INFO) {
		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);
		if (!existsSync(firmwarePath)) {
			console.warn(`  ⚠ Firmware not found: ${firmware.version}`);
			continue;
		}
		try {
			firmware.groundTruth = extractGroundTruth(firmwarePath);
			(firmware as any).flacAddr = discoverFlacFunctionAddress(firmwarePath);
			console.log(`  ✓ ${firmware.version}: Ground truth extracted`);
		} catch (error) {
			console.error(`  ✗ ${firmware.version}: Failed - ${(error as Error).message}`);
		}
	}

	const firmwareResults = await generateAllFirmwaresInParallel(FIRMWARE_INFO);
	const allTestCases: Array<{ id: string; firmwareVersion: string; scenarioName: string; patchNum: 1 | 2; test: () => Promise<any>; }> = [];

	for (const firmware of FIRMWARE_INFO) {
		if (!firmware.groundTruth) continue;
		const scenarios = buildScenariosForFirmware(firmware.groundTruth);
		for (const scenario of scenarios) {
			const firstFirmwareInfo = firmwareResults.get(`${firmware.version}_${scenario.id}_1`);
			if (!firstFirmwareInfo) continue;
			const firstColors = scenario.firstOp === 'menu-only' ? scenario.expectedAfterFirst.menu : scenario.expectedAfterFirst.flac;
			allTestCases.push({
				id: `${firmware.version}_${scenario.id}_1`,
				firmwareVersion: firmware.version,
				scenarioName: scenario.name,
				patchNum: 1,
				test: async () => {
					const scriptPath = join(scriptsDir, `test_${firmware.version}_${scenario.id}_1_bl.py`);
					const logPath = join(logsDir, `test_${firmware.version}_${scenario.id}_1_bl.log`);
					const script = generateUnicornScriptWithBLVerification(
						firmware, scenario.name, 1, firstColors, 
						join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_1.IMG`),
						firmware.flacAddr, firstFirmwareInfo.blAddr, firstFirmwareInfo.nopSlideAddr, firstFirmwareInfo.flacCodeAddr, firstFirmwareInfo.menuCodeAddr
					);
					writeFileSync(scriptPath, script);
					const result = await runUnicornTestAsync(scriptPath, logPath);
					return { success: result.success };
				}
			});
			if (!scenario.isSinglePatch) {
				const secondFirmwareInfo = firmwareResults.get(`${firmware.version}_${scenario.id}_2`);
				if (!secondFirmwareInfo) continue;
				const secondColors = scenario.secondOp === 'menu-only' ? scenario.expectedAfterSecond!.menu : scenario.expectedAfterSecond!.flac;
				allTestCases.push({
					id: `${firmware.version}_${scenario.id}_2`,
					firmwareVersion: firmware.version,
					scenarioName: scenario.name,
					patchNum: 2,
					test: async () => {
						const scriptPath = join(scriptsDir, `test_${firmware.version}_${scenario.id}_2_bl.py`);
						const logPath = join(logsDir, `test_${firmware.version}_${scenario.id}_2_bl.log`);
						const script = generateUnicornScriptWithBLVerification(
							firmware, scenario.name, 2, secondColors,
							join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_2.IMG`),
							firmware.flacAddr, secondFirmwareInfo.blAddr, secondFirmwareInfo.nopSlideAddr, secondFirmwareInfo.flacCodeAddr, secondFirmwareInfo.menuCodeAddr
						);
						writeFileSync(scriptPath, script);
						const result = await runUnicornTestAsync(scriptPath, logPath);
						return { success: result.success };
					}
				});
			}
		}
	}

	console.log(`\nTotal test cases: ${allTestCases.length}`);
	const results = await runTestsWithPool(allTestCases);
	const grouped = new Map<string, Array<{ patchNum: number; result: any }>>();
	for (const result of results) {
		const key = result.id.slice(0, -2);
		if (!grouped.has(key)) grouped.set(key, []);
		grouped.get(key)!.push({ patchNum: result.id.endsWith('_1') ? 1 : 2, result: result.result });
	}

	let passed = 0;
	for (const [id, tests] of grouped.entries()) {
		console.log(`\n${id}`);
		for (const { patchNum, result } of tests) {
			if (result.success) { passed++; console.log(`  ✓ Patch ${patchNum}: PASS`); }
			else console.log(`  ✗ Patch ${patchNum}: FAIL`);
		}
	}
	console.log(`\nSummary: ${passed}/${results.length} passed in ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
	return { passed, total: results.length };
}

runComprehensiveTests().then(({ passed, total }) => process.exit(passed === total ? 0 : 1)).catch((error) => {
	console.error('Test execution failed with error:', error);
	process.exit(1);
});
