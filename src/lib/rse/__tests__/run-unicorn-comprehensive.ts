/**
 * Comprehensive Unicorn Test Runner for Theme Patcher
 *
 * This script tests ALL patching combinations:
 * - Single-patch scenarios: Original → FLAC-only, Original → Menu-only, Original → Both (3 scenarios)
 * - Two-patch scenarios: First patch × Second patch (9 scenarios)
 * - Total: 12 scenarios
 *
 * For each scenario, we:
 * 1. Use the TypeScript patcher to create patched firmware
 * 2. Run Python Unicorn emulation to verify the result
 * 3. Verify colors match expected values
 *
 * Usage: bun run src/lib/rse/__tests__/run-unicorn-comprehensive.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
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
// flacAddr: FLAC String function address (CMP R1, #4 + ITE block, contains color values)
// Note: This is NOT the BL instruction address - it's the CMP address which is where FLAC String starts
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

// Single-patch scenarios (test one patch only, no second patch)
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
sys.path.insert(0, 'references')

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

    # Check if MOVW (bits 15:11 = 11110, bits 9:8 = 00 for MOVW)
    if (hw1 & 0xF800) != 0xF000 or (hw1 & 0x0400) != 0:
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
 * Generate Python Unicorn test script with BL precision verification
 * Tests COMPLETE execution flow: FLAC function → BL → handler → return
 */
function generateUnicornScriptWithBLVerification(
	_firmwareInfo: typeof FIRMWARE_INFO[0],
	_scenarioName: string,
	_patchNumber: 1 | 2,
	expectedFlac: number[],
	patchedFirmwarePath: string,
	flacFuncAddr: number,
	blAddr: number,
	expectedHandlerAddr: number
): string {

	return `
import sys
sys.path.insert(0, 'references')

from unicorn import *
from unicorn.arm_const import *

# Load patched firmware
with open('${patchedFirmwarePath}', 'rb') as f:
    data = f.read()

# FLAC function and BL addresses
FLAC_FUNC = 0x${flacFuncAddr.toString(16)}
BL_ADDR = 0x${blAddr.toString(16)}
EXPECTED_HANDLER = 0x${expectedHandlerAddr.toString(16)}

print(f"FLAC function: 0x{FLAC_FUNC:X}")
print(f"BL instruction: 0x{BL_ADDR:X}")
print(f"Expected handler: 0x{EXPECTED_HANDLER:X}")

# Verify NOP slide boundary protection
# Check that handler is within expected NOP slide region
NOP_SLIDE_START = EXPECTED_HANDLER & ~0xFFF  # Page-aligned
NOP_SLIDE_END = NOP_SLIDE_START + 0x1000      # 4KB page

if EXPECTED_HANDLER < NOP_SLIDE_START or EXPECTED_HANDLER >= NOP_SLIDE_END:
    print(f"⚠ WARNING: Handler at 0x{EXPECTED_HANDLER:X} may be outside expected NOP slide")
    print(f"  Expected range: 0x{NOP_SLIDE_START:X} - 0x{NOP_SLIDE_END:X}")

# Initialize emulator
mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

# RKNanoD memory map:
# Flash:    0x00000000 - 0x02100000 (33MB)
# SYSRAM0:  0x03000000 - 0x03100000 (1MB, increased to handle stack)

# Map entire Flash region for code execution
FLASH_BASE = 0x00000000
FLASH_SIZE = 0x02100000  # 33MB
mu.mem_map(FLASH_BASE, FLASH_SIZE, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)

# Map SYSRAM0 for stack with increased size
SYSRAM0_BASE = 0x03000000
SYSRAM0_SIZE = 0x00100000  # 1MB
mu.mem_map(SYSRAM0_BASE, SYSRAM0_SIZE, UC_PROT_READ | UC_PROT_WRITE)

# Write entire firmware to Flash
mu.mem_write(FLASH_BASE, data[FLASH_BASE:FLASH_BASE + FLASH_SIZE])

# Expected FLAC colors
expected_flac = ${JSON.stringify(expectedFlac)}

# ✅ CRITICAL: Test caller-saved register preservation (R4-R8)
# Set known values BEFORE calling FLAC function
CALLER_R4 = 0x12345678
CALLER_R5 = 0x87654321
CALLER_R6 = 0xABCDEF00
CALLER_R7 = 0xFEDCBA00
CALLER_R8 = 0x11223344

# Execution tracking
bl_executed = False
bl_target_actual = 0
handler_executed = False
bx_lr_executed = False
flac_results = []
registers_preserved = True
instruction_count = 0
MAX_INSTRUCTIONS = 1000

def hook_code(uc, address, size, user_data):
    global bl_executed, bl_target_actual, handler_executed, bx_lr_executed, flac_results, registers_preserved, instruction_count

    instruction_count += 1
    if instruction_count > MAX_INSTRUCTIONS:
        print(f"  ⚠ Stopped after {MAX_INSTRUCTIONS} instructions")
        uc.emu_stop()
        return

    # Check if we're at the BL instruction
    if address == BL_ADDR:
        bl_executed = True
        # Read BL instruction bytes
        bl_bytes = uc.mem_read(BL_ADDR, 4)
        hw1 = bl_bytes[0] | (bl_bytes[1] << 8)
        hw2 = bl_bytes[2] | (bl_bytes[3] << 8)

        # Verify this is a BL instruction
        if (hw1 & 0xf800) == 0xf000 and (hw2 & 0xd000) == 0xd000:
            # Decode BL target
            S = (hw1 >> 10) & 1
            J1 = (hw2 >> 13) & 1
            J2 = (hw2 >> 11) & 1
            imm10 = hw1 & 0x3FF
            imm11 = hw2 & 0x7FF

            I1 = (~(J1 ^ S)) & 1
            I2 = (~(J2 ^ S)) & 1

            imm25 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1)
            imm32 = imm25 << 1
            if S:
                imm32 |= 0xFE000000

            bl_target_actual = BL_ADDR + 4 + imm32

            print(f"  ✓ BL executed at 0x{address:X}")
            print(f"  → BL target: 0x{bl_target_actual:X}")

            # CRITICAL: Verify BL precision
            if bl_target_actual != EXPECTED_HANDLER:
                precision_error = bl_target_actual - EXPECTED_HANDLER
                print(f"  ✗ BL PRECISION LOSS DETECTED!")
                print(f"    Expected: 0x{EXPECTED_HANDLER:X}")
                print(f"    Actual:   0x{bl_target_actual:X}")
                print(f"    Error:    {precision_error:+d} bytes")
                uc.emu_stop()
                return
            else:
                print(f"  ✓ BL precision verified (exact match)")
        else:
            print(f"  ✗ Not a BL instruction at 0x{address:X}")
            uc.emu_stop()

    # Check if we entered the handler (clear Thumb bit for comparison)
    if (address & ~1) == EXPECTED_HANDLER:
        handler_executed = True
        print(f"  ✓ Handler entered at 0x{address:X}")

    # Check for handler return instructions (BX LR or POP {...,PC})
    try:
        instr_bytes = uc.mem_read(address, 2)

        # Check for BX LR (0x4770) - little endian: 0x70 0x47
        is_bx_lr = instr_bytes[0] == 0x70 and instr_bytes[1] == 0x47

        # Check for POP {..., PC} (0xBC/0xBD with bit 7 set in second byte)
        # Handler uses: POP {R4-R7, PC} = 0xFF 0xBD
        is_pop_pc = (instr_bytes[0] == 0xFF and instr_bytes[1] == 0xBD)

        if is_bx_lr or is_pop_pc:
            bx_lr_executed = True
            instr_type = "BX LR" if is_bx_lr else "POP {R4-R7, PC}"
            r0_value = uc.reg_read(UC_ARM_REG_R0)
            color_value = r0_value & 0xFFFF

            # ✅ CRITICAL CHECK: Verify R4-R8 are preserved (callee-saved registers)
            actual_r4 = uc.reg_read(UC_ARM_REG_R4)
            actual_r5 = uc.reg_read(UC_ARM_REG_R5)
            actual_r6 = uc.reg_read(UC_ARM_REG_R6)
            actual_r7 = uc.reg_read(UC_ARM_REG_R7)
            actual_r8 = uc.reg_read(UC_ARM_REG_R8)

            if (actual_r4 != CALLER_R4 or actual_r5 != CALLER_R5 or
                actual_r6 != CALLER_R6 or actual_r7 != CALLER_R7 or actual_r8 != CALLER_R8):
                registers_preserved = False
                print(f"  ✗ REGISTER CORRUPTION DETECTED!")
                print(f"    R4: 0x{actual_r4:08X} (expected 0x{CALLER_R4:08X})")
                print(f"    R5: 0x{actual_r5:08X} (expected 0x{CALLER_R5:08X})")
                print(f"    R6: 0x{actual_r6:08X} (expected 0x{CALLER_R6:08X})")
                print(f"    R7: 0x{actual_r7:08X} (expected 0x{CALLER_R7:08X})")
                print(f"    R8: 0x{actual_r8:08X} (expected 0x{CALLER_R8:08X})")
            else:
                print(f"  ✓ Callee-saved registers preserved (R4-R8)")

            # Get theme index from R1
            theme_idx = uc.reg_read(UC_ARM_REG_R1)
            if 0 <= theme_idx < len(expected_flac):
                flac_results.append(color_value)
                print(f"  ✓ {instr_type} executed, Theme {theme_idx}, R0 = 0x{color_value:X}")
            else:
                print(f"  ✓ {instr_type} executed, R0 = 0x{color_value:X}")
            uc.emu_stop()
    except:
        pass

# Hook code execution
mu.hook_add(UC_HOOK_CODE, hook_code)

# Hook invalid memory access for debugging
def hook_mem_invalid(uc, access, address, size, value, user_data):
    if access == UC_MEM_WRITE:
        print(f"  ⚠ Invalid write to 0x{address:X}, PC=0x{uc.reg_read(UC_ARM_REG_PC):X}")
    else:
        print(f"  ⚠ Invalid read from 0x{address:X}, PC=0x{uc.reg_read(UC_ARM_REG_PC):X}")
    uc.emu_stop()
    return False

mu.hook_add(UC_HOOK_MEM_READ_UNMAPPED | UC_HOOK_MEM_WRITE_UNMAPPED, hook_mem_invalid)

# Track overall success
all_success = True

# Emulate FLAC handler for each theme
for theme_idx, expected_color in enumerate(expected_flac):
    print(f"\\nTesting theme {theme_idx} (expected: 0x{expected_color:X})...")

    # Reset tracking for each theme
    bl_executed = False
    bl_target_actual = 0
    handler_executed = False
    bx_lr_executed = False
    instruction_count = 0

    # Set up registers
    mu.reg_write(UC_ARM_REG_CPSR, 0x000001F3)  # Thumb mode
    mu.reg_write(UC_ARM_REG_SP, 0x03050000)    # RKNanoD SYSRAM0 stack

    # ✅ CRITICAL: Set caller-saved registers to known values BEFORE calling FLAC function
    mu.reg_write(UC_ARM_REG_R4, CALLER_R4)
    mu.reg_write(UC_ARM_REG_R5, CALLER_R5)
    mu.reg_write(UC_ARM_REG_R6, CALLER_R6)
    mu.reg_write(UC_ARM_REG_R7, CALLER_R7)
    mu.reg_write(UC_ARM_REG_R8, CALLER_R8)

    mu.reg_write(UC_ARM_REG_R1, theme_idx)     # Theme index in R1
    mu.reg_write(UC_ARM_REG_LR, (FLAC_FUNC + 100) | 1)
    mu.reg_write(UC_ARM_REG_PC, FLAC_FUNC | 1) # Start from FLAC FUNCTION!

    # Emulate
    try:
        mu.emu_start(FLAC_FUNC | 1, (FLAC_FUNC + 1000) | 1, 0, 1000)
    except UcError as e:
        pass

    # ✅ Verify results for THIS theme
    theme_success = True

    if not bl_executed:
        print(f"  ✗ FAIL: BL instruction was not executed")
        theme_success = False
    else:
        print(f"  ✓ BL instruction executed")

    if bl_target_actual != EXPECTED_HANDLER:
        print(f"  ✗ FAIL: BL precision error (expected 0x{EXPECTED_HANDLER:X}, got 0x{bl_target_actual:X})")
        theme_success = False
    else:
        print(f"  ✓ BL precision verified (0x{EXPECTED_HANDLER:X})")

    if not bx_lr_executed:
        print(f"  ✗ FAIL: Handler did not return (BX LR not detected)")
        theme_success = False
    else:
        # Get color from R0
        r0_value = mu.reg_read(UC_ARM_REG_R0)
        color_value = r0_value & 0xFFFF
        if color_value == expected_color:
            print(f"  ✓ Color value correct: 0x{color_value:X}")
        else:
            print(f"  ✗ FAIL: Color value incorrect (expected 0x{expected_color:X}, got 0x{color_value:X})")
            theme_success = False

    # ✅ Check register preservation
    actual_r4 = mu.reg_read(UC_ARM_REG_R4)
    actual_r5 = mu.reg_read(UC_ARM_REG_R5)
    actual_r6 = mu.reg_read(UC_ARM_REG_R6)
    actual_r7 = mu.reg_read(UC_ARM_REG_R7)
    actual_r8 = mu.reg_read(UC_ARM_REG_R8)

    if (actual_r4 != CALLER_R4 or actual_r5 != CALLER_R5 or
        actual_r6 != CALLER_R6 or actual_r7 != CALLER_R7 or actual_r8 != CALLER_R8):
        print(f"  ✗ FAIL: Callee-saved registers (R4-R8) were corrupted")
        theme_success = False
    else:
        print(f"  ✓ Callee-saved registers preserved (R4-R8)")

    if theme_success:
        flac_results.append(expected_color)
    else:
        all_success = False

print(f"\\n=== Result ===")
if all_success and flac_results == expected_flac:
    print("✅ PASS")
    sys.exit(0)
else:
    print("❌ FAIL")
    sys.exit(1)
`;
}


/**
 * Find BL instruction in FLAC function
 */
function findBlInFunction(data: Buffer, funcAddr: number): number | null {
	// Search forward from function start for BL instruction
	for (let offset = 0; offset < 500; offset += 2) {
		const addr = funcAddr + offset;
		if (addr + 4 > data.length) break;

		const hw1 = data[addr] | (data[addr + 1] << 8);
		const hw2 = data[addr + 2] | (data[addr + 3] << 8);

		// Check if this is a BL instruction
		if ((hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000) {
			return addr;
		}

		// Check if 32-bit instruction to skip correctly
		const is32bit = hw1 >= 0xe800;
		if (is32bit) {
			offset += 2;
		}
	}

	return null;
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
 * Verify NOP slide boundary protection
 * Ensures patch code stays within discovered NOP slide boundaries
 */
function verifyNopSlideBoundaries(
	patchedData: Buffer,
	nopSlideAddr: number,
	firmwareSize: number
): { safe: boolean; message: string } {
	// Check if NOP slide is within firmware bounds
	if (nopSlideAddr < 0 || nopSlideAddr >= firmwareSize) {
		return {
			safe: false,
			message: `NOP slide at 0x${nopSlideAddr.toString(16)} is outside firmware bounds (0x${firmwareSize.toString(16)})`
		};
	}

	// Check for a reasonable NOP slide (at least 256 bytes)
	const MIN_NOP_SLIDE_SIZE = 256;
	if (nopSlideAddr + MIN_NOP_SLIDE_SIZE > firmwareSize) {
		return {
			safe: false,
			message: `NOP slide at 0x${nopSlideAddr.toString(16)} is too close to firmware end`
		};
	}

	// Verify the region is actually a NOP slide (check for zeros)
	const checkSize = Math.min(64, firmwareSize - nopSlideAddr);
	let zeroCount = 0;
	for (let i = 0; i < checkSize; i++) {
		if (patchedData[nopSlideAddr + i] === 0x00) {
			zeroCount++;
		}
	}

	// At least 80% should be zeros (NOP bytes)
	if (zeroCount < checkSize * 0.8) {
		return {
			safe: false,
			message: `Region at 0x${nopSlideAddr.toString(16)} doesn't appear to be a valid NOP slide (${zeroCount}/${checkSize} zeros)`
		};
	}

	return { safe: true, message: 'OK' };
}

/**
 * Apply patch using TypeScript patcher
 * Returns: { success: boolean, nopSlideAddr: number, blAddr: number | null }
 */
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

		// Read patched firmware and find BL instruction
		const patchedData = readFileSync(outputPath);
		const blAddr = findBlInFunction(patchedData, flacAddr);

		if (!blAddr) {
			console.error(`  ⚠ Could not find BL instruction in FLAC function`);
			return { success: false, nopSlideAddr: 0, blAddr: null };
		}

		// Decode BL at BL instruction address to find NOP slide (handler address)
		const nopSlideAddr = decodeBlTarget(patchedData, blAddr);

		// Verify NOP slide boundaries
		const boundaryCheck = verifyNopSlideBoundaries(patchedData, nopSlideAddr, patchedData.length);
		if (!boundaryCheck.safe) {
			console.error(`  ⚠ Boundary check warning: ${boundaryCheck.message}`);
		}

		return { success: true, nopSlideAddr, blAddr };
	} catch (error) {
		console.error(`Patch failed: ${error}`);
		return { success: false, nopSlideAddr: 0, blAddr: null };
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
	const twoPatchScenarios = SCENARIO_TEMPLATES.map(template => {
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
			expectedAfterSecond: { flac: expectedAfterSecondFlac, menu: expectedAfterSecondMenu },
			isSinglePatch: false
		};
	});

	const singlePatchScenarios = SINGLE_PATCH_SCENARIOS.map(template => {
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

		return {
			...template,
			firstColors,
			expectedAfterFirst: { flac: expectedAfterFirstFlac, menu: expectedAfterFirstMenu },
			isSinglePatch: true
		};
	});

	return [...twoPatchScenarios, ...singlePatchScenarios];
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
		isSinglePatch: boolean;           // Type 3: Single-patch scenario (no second patch)
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

		// GROUND TRUTH VERIFICATION
		// =========================
		// Validate that ThemeColorExtractor extracted colors are correct by reading
		// MOVW instructions from the original firmware's FLAC String function
		console.log('  Verifying ground truth colors...');
		try {
			// Use FLAC String function address (contains CMP R1, #4 + ITE block)
			// flacAddr points to the CMP instruction which is the start of FLAC String function
			const flacStringAddr = firmware.flacAddr;

			// Generate and run verification script
			const verifyScriptPath = join(OUTPUT_DIR, 'scripts', `verify_${firmware.version}_flac.py`);
			const verifyScript = generateUnicornScriptForOriginalFlac(
				firmwarePath,
				firmware.groundTruth.flacColors,
				flacStringAddr
			);
			writeFileSync(verifyScriptPath, verifyScript);

			const verifyResult = runUnicornTest(verifyScriptPath);
			if (verifyResult.success) {
				console.log('  ✓ Ground truth verification: PASSED');
			} else {
				console.log('  ⚠ Ground truth verification: FAILED');
				console.log(`    ${verifyResult.output.split('\n').slice(-3).join(' ')}`);
			}
		} catch (error) {
			console.log(`  ⚠ Ground truth verification skipped: ${error}`);
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
				verificationFailed: false,
				isSinglePatch: scenario.isSinglePatch || false
			};

			// First patch
			const firstOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_1.IMG`);
			let firstPatchResult = { success: false, nopSlideAddr: 0, blAddr: null as number | null };

			try {
				firstPatchResult = applyPatch(firmwarePath, scenario.firstColors, firstOutputPath, firmware.flacAddr);

				if (firstPatchResult.success && firstPatchResult.blAddr) {
					console.log(`    ✓ First patch: SUCCESS`);

					// Generate and run BL verification test (complete flow: FLAC function → BL → handler)
					const script1BLPath = join(OUTPUT_DIR, 'scripts', `test_${firmware.version}_${scenario.id}_1_bl.py`);
					const script1BL = generateUnicornScriptWithBLVerification(
						firmware,
						scenario.name,
						1,
						scenario.expectedAfterFirst.flac,
						firstOutputPath,
						firmware.flacAddr,
						firstPatchResult.blAddr,
						firstPatchResult.nopSlideAddr
					);
					writeFileSync(script1BLPath, script1BL);

					const unicorn1BL = runUnicornTest(script1BLPath);
					if (unicorn1BL.success) {
						console.log(`    ✓ First patch BL + Flow: VERIFIED`);
						scenarioResults.firstPatch = true;
					} else {
						console.log(`    ✗ First patch BL + Flow: FAILED`);
						console.log(`      ${unicorn1BL.output.split('\n').slice(-3).join(' ')}`);
					}
				} else {
					console.log(`    ✗ First patch: FAILED`);
				}
			} catch (error) {
				console.log(`    ✗ First patch: ERROR - ${error}`);
			}

			// Second patch (skip for single-patch scenarios)
			if (firstPatchResult.success && !scenario.isSinglePatch && 'secondColors' in scenario) {
				const secondOutputPath = join(OUTPUT_DIR, `${firmware.version}_${scenario.id}_2.IMG`);
				let secondPatchResult = { success: false, nopSlideAddr: 0, blAddr: null as number | null };

				try {
					secondPatchResult = applyPatch(firstOutputPath, (scenario as any).secondColors, secondOutputPath, firmware.flacAddr);

					if (secondPatchResult.success && secondPatchResult.blAddr) {
						console.log(`    ✓ Second patch: SUCCESS`);

						// CRITICAL: Verify second patch reuses the same NOP slide as first patch
						// This prevents the bootloop bug where second patch creates a new NOP slide
						if (secondPatchResult.nopSlideAddr !== firstPatchResult.nopSlideAddr) {
							const delta = secondPatchResult.nopSlideAddr - firstPatchResult.nopSlideAddr;
							console.log(`    ✗ Second patch created NEW NOP slide (should reuse existing)`);
							console.log(`      First:  0x${firstPatchResult.nopSlideAddr.toString(16)}`);
							console.log(`      Second: 0x${secondPatchResult.nopSlideAddr.toString(16)}`);
							console.log(`      Delta:  ${delta >= 0 ? '+' : ''}${delta} bytes`);
							scenarioResults.verificationFailed = true;
						} else {
							console.log(`    ✓ NOP slide reused: 0x${firstPatchResult.nopSlideAddr.toString(16)}`);
						}

						if ('expectedAfterSecond' in scenario) {
							// Generate and run BL verification test (complete flow: FLAC function → BL → handler)
							const script2BLPath = join(OUTPUT_DIR, 'scripts', `test_${firmware.version}_${scenario.id}_2_bl.py`);
							const script2BL = generateUnicornScriptWithBLVerification(
								firmware,
								scenario.name,
								2,
								(scenario as any).expectedAfterSecond.flac,
								secondOutputPath,
								firmware.flacAddr,
								secondPatchResult.blAddr,
								secondPatchResult.nopSlideAddr
							);
							writeFileSync(script2BLPath, script2BL);

							const unicorn2BL = runUnicornTest(script2BLPath);
							if (unicorn2BL.success) {
								console.log(`    ✓ Second patch BL + Flow: VERIFIED`);
								scenarioResults.secondPatch = true;
								scenarioResults.unicornVerify = true;
							} else {
								console.log(`    ✗ Second patch BL + Flow: FAILED`);
								console.log(`      ${unicorn2BL.output.split('\n').slice(-3).join(' ')}`);
								scenarioResults.verificationFailed = true;
							}
						}
					} else {
						console.log(`    ✗ Second patch: FAILED`);
						scenarioResults.patchApplicationFailed = true;
					}
				} catch (error) {
					console.log(`    ✗ Second patch: ERROR - ${error}`);
				}
			} else if (firstPatchResult.success && scenario.isSinglePatch) {
				// Single-patch scenario: mark as complete after first patch verification
				console.log(`    ⊘ Single-patch scenario: skipping second patch`);
				scenarioResults.unicornVerify = scenarioResults.firstPatch;
			}

			results.push(scenarioResults);
			completedTests += 2;
		}
	}

	// Print summary
	console.log('\n\n╔═══════════════════════════════════════════════════════════════════════════╗');
	console.log('║                           Test Summary                                  ║');
	console.log('╚═══════════════════════════════════════════════════════════════════════════╝');
	console.log();

	const singlePatchResults = results.filter(r => r.isSinglePatch);
	const twoPatchResults = results.filter(r => !r.isSinglePatch);

	const singlePatchPassed = singlePatchResults.filter(r => r.firstPatch && r.unicornVerify).length;
	const singlePatchTotal = singlePatchResults.length;

	const firstPatchPassed = twoPatchResults.filter(r => r.firstPatch).length;
	const firstPatchTotal = twoPatchResults.length;
	const secondPatchPassed = twoPatchResults.filter(r => r.secondPatch).length;
	const secondPatchAttempted = twoPatchResults.filter(r => r.firstPatch).length;

	// Count the two types of second patch failures
	const patchApplicationFailures = twoPatchResults.filter(r => r.patchApplicationFailed).length;
	const verificationFailures = twoPatchResults.filter(r => r.verificationFailed).length;

	console.log(`Single-Patch Scenarios (3 total):`);
	console.log(`  ${singlePatchPassed}/${singlePatchTotal} PASSED ✅`);
	console.log();

	console.log(`Two-Patch Scenarios (9 total):`);
	console.log(`  First Patch (FLAC Handler):`);
	console.log(`    ${firstPatchPassed}/${firstPatchTotal} PASSED ✅`);
	console.log();

	console.log(`  Second Patch:`);
	console.log(`    Attempted: ${secondPatchAttempted} (only runs if first patch succeeded)`);
	console.log(`    Passed: ${secondPatchPassed}/${secondPatchAttempted} ✅`);
	console.log(`    Failed: ${secondPatchAttempted - secondPatchPassed}/${secondPatchAttempted} ❌`);
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
		firstPatchPassed: firstPatchPassed + singlePatchPassed,
		firstPatchTotal: firstPatchTotal + singlePatchTotal,
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
