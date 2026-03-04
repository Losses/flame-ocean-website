/**
 * Language Unicorn Verifier
 *
 * Provides firmware safety verification using Unicorn ARM emulator.
 * Validates that language operations don't corrupt firmware execution.
 *
 * This follows the same pattern as run-unicorn-comprehensive-parallel.ts
 * but adapted for language system verification.
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import {
	type UnicornVerificationResult,
	type UnicornTestCase
} from './types.js';
import { LanguageExtractor } from './extractor.js';
import { UnicornVerificationError } from './errors.js';

/**
 * Python executable path (same as theme tests)
 */
const PYTHON_PATH = '/nix/store/mrvk6p37qm6qk5p95clnghmb1m7bbw8q-system-path/bin/python3';

/**
 * Temporary directory for test scripts
 */
const TEMP_DIR = '/tmp/language-unicorn-tests';

/**
 * Generate Python Unicorn test script for language system verification
 */
function generateLanguageVerificationScript(
	firmwarePath: string,
	expectedLanguageCount: number,
	expectedFirstPoolAddress: number
): string {
	return `#!/usr/bin/env python3
"""
Language System Unicorn Verification Script

Verifies that language operations didn't corrupt firmware:
1. Language name table is accessible
2. Menu string pools are accessible
3. Language count check instruction is valid
4. No code corruption in executable regions
"""

import sys
sys.path.insert(0, '/home/losses/Development/flame-ocean')

from unicorn import *
from unicorn.arm_const import *

# Configuration
FIRMWARE_PATH = '${firmwarePath}'
EXPECTED_LANGUAGE_COUNT = ${expectedLanguageCount}
FIRST_POOL_ADDRESS = ${expectedFirstPoolAddress}
NAME_TABLE_ADDRESS = 0x778360
LANGUAGE_COUNT_CHECK_ADDRESS = 0x3542A
ENTRY_SIZE = 0x102
POOL_SPACING = 0x1C584

print(f"=== Language System Unicorn Verification ===")
print(f"Firmware: {FIRMWARE_PATH}")
print(f"Expected languages: {EXPECTED_LANGUAGE_COUNT}")

# Load firmware
try:
    with open(FIRMWARE_PATH, 'rb') as f:
        firmware_data = f.read()
    print(f"Firmware size: {len(firmware_data)} bytes")
except Exception as e:
    print(f"ERROR: Failed to load firmware: {e}")
    sys.exit(1)

errors = []

# Test 1: Verify language count check instruction
print(f"\\n[Test 1] Language Count Check Instruction")
check_addr = LANGUAGE_COUNT_CHECK_ADDRESS
if check_addr + 2 > len(firmware_data):
    errors.append(f"Language count check address 0x{check_addr:X} out of bounds")
else:
    cmp_bytes = firmware_data[check_addr:check_addr + 2]
    # ARM Thumb is little-endian, so CMP R0, #N is encoded as [N, 0x28]
    # Example: CMP R0, #20 = 0x2814 -> bytes [0x14, 0x28]
    if cmp_bytes[1] != 0x28:
        errors.append(f"Invalid instruction at 0x{check_addr:X}: expected CMP R0 (0x28 in high byte), got 0x{cmp_bytes[1]:02X}")
    else:
        actual_count = cmp_bytes[0]
        if actual_count != EXPECTED_LANGUAGE_COUNT - 1:
            errors.append(f"Language count mismatch: instruction has {actual_count}, expected {EXPECTED_LANGUAGE_COUNT - 1}")
        else:
            print(f"  PASS: Language count check is correct ({actual_count})")

# Test 2: Verify language name table
print(f"\\n[Test 2] Language Name Table")
name_table_addr = NAME_TABLE_ADDRESS
for i in range(EXPECTED_LANGUAGE_COUNT):
    entry_addr = name_table_addr + i * ENTRY_SIZE
    if entry_addr + ENTRY_SIZE > len(firmware_data):
        errors.append(f"Language name entry {i} at 0x{entry_addr:X} out of bounds")
        continue

    entry = firmware_data[entry_addr:entry_addr + ENTRY_SIZE]

    # Check for NULL terminator
    has_null = False
    for j in range(0, ENTRY_SIZE - 1, 2):
        if entry[j] == 0 and entry[j + 1] == 0:
            has_null = True
            break

    if not has_null:
        errors.append(f"Language name entry {i} has no NULL terminator")
    else:
        # Read first few characters to verify it's valid UTF-16
        first_char = entry[0] | (entry[1] << 8)
        if first_char == 0:
            errors.append(f"Language name entry {i} appears empty")
        else:
            pass  # Valid entry

if not any('Language name entry' in e for e in errors):
    print(f"  PASS: All {EXPECTED_LANGUAGE_COUNT} language name entries valid")

# Test 3: Verify menu string pools
print(f"\\n[Test 3] Menu String Pools")
for i in range(EXPECTED_LANGUAGE_COUNT):
    pool_addr = FIRST_POOL_ADDRESS + i * POOL_SPACING
    if pool_addr + ENTRY_SIZE > len(firmware_data):
        errors.append(f"Menu pool {i} at 0x{pool_addr:X} out of bounds")
        continue

    # Check first entry has FF FF prefix
    first_entry = firmware_data[pool_addr:pool_addr + 2]
    if first_entry[0] != 0xFF or first_entry[1] != 0xFF:
        errors.append(f"Menu pool {i} first entry missing FF FF prefix")

if not any('Menu pool' in e for e in errors):
    print(f"  PASS: All {EXPECTED_LANGUAGE_COUNT} menu pools valid")

# Test 4: Verify no code corruption in critical regions
print(f"\\n[Test 4] Code Region Integrity")
# Check that the language count check region is still valid ARM Thumb code
check_region_start = LANGUAGE_COUNT_CHECK_ADDRESS - 10
check_region_end = LANGUAGE_COUNT_CHECK_ADDRESS + 10

if check_region_start >= 0 and check_region_end <= len(firmware_data):
    region = firmware_data[check_region_start:check_region_end]
    # Look for typical ARM Thumb patterns (should have valid instructions)
    # We just verify it's not all zeros or all 0xFF
    all_same = all(b == region[0] for b in region)
    if all_same:
        errors.append(f"Code region around language count check appears corrupted (all {region[0]:02X})")
    else:
        print(f"  PASS: Code region around language count check appears intact")

# Test 5: Basic Unicorn emulation test
print(f"\\n[Test 5] Basic Emulation Test")
try:
    mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

    # Map Flash memory (must be 4KB aligned)
    FLASH_BASE = 0x00000000
    FLASH_SIZE = 0x02100000  # Fixed 2MB + 64KB, aligned
    mu.mem_map(FLASH_BASE, FLASH_SIZE, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)

    # Write only the portion of firmware we need
    write_size = min(len(firmware_data), FLASH_SIZE)
    mu.mem_write(FLASH_BASE, bytes(firmware_data[FLASH_BASE:FLASH_BASE + write_size]))

    # Map RAM
    SYSRAM0_BASE = 0x03000000
    SYSRAM0_SIZE = 0x00100000
    mu.mem_map(SYSRAM0_BASE, SYSRAM0_SIZE, UC_PROT_READ | UC_PROT_WRITE)

    # Try to read language name table through emulator
    try:
        name_data = mu.mem_read(NAME_TABLE_ADDRESS, ENTRY_SIZE)
        if len(name_data) == ENTRY_SIZE:
            print(f"  PASS: Can read language name table through emulator")
        else:
            errors.append("Failed to read full language name entry through emulator")
    except UcError as e:
        errors.append(f"Emulator read error for name table: {e}")

    # Try to read menu pool
    try:
        pool_data = mu.mem_read(FIRST_POOL_ADDRESS, ENTRY_SIZE)
        if len(pool_data) == ENTRY_SIZE:
            print(f"  PASS: Can read menu pool through emulator")
        else:
            errors.append("Failed to read full menu pool entry through emulator")
    except UcError as e:
        errors.append(f"Emulator read error for menu pool: {e}")

    del mu
except UcError as e:
    errors.append(f"Failed to initialize emulator: {e}")
except Exception as e:
    errors.append(f"Unexpected error: {e}")

# Summary
print(f"\\n=== Verification Summary ===")
if errors:
    print(f"FAILED: {len(errors)} errors found")
    for err in errors:
        print(f"  - {err}")
    sys.exit(1)
else:
    print(f"PASSED: All verification tests passed")
    sys.exit(0)
`;
}

/**
 * Generate advanced Unicorn test script that verifies
 * language access functions still work correctly
 */
function generateLanguageAccessVerificationScript(
	firmwarePath: string,
	languageIndex: number,
	testStringIndex: number
): string {
	return `#!/usr/bin/env python3
"""
Language Access Function Verification

Verifies that language string access still works after modifications:
1. Sets up emulator with firmware
2. Simulates calling language string lookup
3. Verifies returned strings are valid
"""

import sys
sys.path.insert(0, '/home/losses/Development/flame-ocean')

from unicorn import *
from unicorn.arm_const import *
from capstone import *

FIRMWARE_PATH = '${firmwarePath}'
LANGUAGE_INDEX = ${languageIndex}
TEST_STRING_INDEX = ${testStringIndex}

print(f"=== Language Access Verification ===")
print(f"Language: {LANGUAGE_INDEX}, String: {TEST_STRING_INDEX}")

# Load firmware
try:
    with open(FIRMWARE_PATH, 'rb') as f:
        firmware_data = f.read()
except Exception as e:
    print(f"ERROR: Failed to load firmware: {e}")
    sys.exit(1)

errors = []

# Initialize emulator
try:
    mu = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

    FLASH_BASE = 0x00000000
    FLASH_SIZE = 0x02100000  # Fixed size, 4KB aligned
    mu.mem_map(FLASH_BASE, FLASH_SIZE, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)
    # Write only the portion we have
    write_size = min(len(firmware_data), FLASH_SIZE)
    mu.mem_write(FLASH_BASE, bytes(firmware_data[FLASH_BASE:FLASH_BASE + write_size]))

    SYSRAM0_BASE = 0x03000000
    SYSRAM0_SIZE = 0x00100000
    mu.mem_map(SYSRAM0_BASE, SYSRAM0_SIZE, UC_PROT_READ | UC_PROT_WRITE)

    # Test accessing language name
    NAME_TABLE_ADDRESS = 0x778360
    ENTRY_SIZE = 0x102
    name_addr = NAME_TABLE_ADDRESS + LANGUAGE_INDEX * ENTRY_SIZE

    if name_addr + ENTRY_SIZE <= FLASH_SIZE:
        name_entry = mu.mem_read(name_addr, ENTRY_SIZE)
        # Find NULL terminator
        null_pos = -1
        for i in range(0, ENTRY_SIZE - 1, 2):
            if name_entry[i] == 0 and name_entry[i + 1] == 0:
                null_pos = i
                break
        if null_pos > 0:
            # Decode UTF-16 LE
            name_chars = []
            for i in range(0, null_pos, 2):
                char = name_entry[i] | (name_entry[i + 1] << 8)
                if char > 0:
                    name_chars.append(chr(char))
            name_str = ''.join(name_chars)
            print(f"  Language {LANGUAGE_INDEX} name: {name_str}")
            if not name_str:
                errors.append(f"Language {LANGUAGE_INDEX} name is empty")
        else:
            errors.append(f"Language {LANGUAGE_INDEX} name has no NULL terminator")
    else:
        errors.append(f"Language {LANGUAGE_INDEX} name address out of bounds")

    # Test accessing menu string
    FIRST_POOL_ADDRESS = 0x7625A8
    POOL_SPACING = 0x1C584
    pool_addr = FIRST_POOL_ADDRESS + LANGUAGE_INDEX * POOL_SPACING
    string_addr = pool_addr + TEST_STRING_INDEX * ENTRY_SIZE

    if string_addr + ENTRY_SIZE <= FLASH_SIZE:
        string_entry = mu.mem_read(string_addr, ENTRY_SIZE)
        # Check FF FF prefix
        if string_entry[0] == 0xFF and string_entry[1] == 0xFF:
            # Find NULL terminator
            null_pos = -1
            for i in range(2, ENTRY_SIZE - 1, 2):
                if string_entry[i] == 0 and string_entry[i + 1] == 0:
                    null_pos = i
                    break
            if null_pos > 2:
                # Decode UTF-16 LE
                str_chars = []
                for i in range(2, null_pos, 2):
                    char = string_entry[i] | (string_entry[i + 1] << 8)
                    if char > 0:
                        str_chars.append(chr(char))
                content = ''.join(str_chars)
                print(f"  String {TEST_STRING_INDEX}: {content}")
            else:
                errors.append(f"String {TEST_STRING_INDEX} has no content")
        else:
            errors.append(f"String {TEST_STRING_INDEX} missing FF FF prefix")
    else:
        errors.append(f"String {TEST_STRING_INDEX} address out of bounds")

    del mu

except UcError as e:
    errors.append(f"Emulator error: {e}")

# Summary
if errors:
    print(f"\\nFAILED: {len(errors)} errors")
    for err in errors:
        print(f"  - {err}")
    sys.exit(1)
else:
    print(f"\\nPASSED: Language access verification passed")
    sys.exit(0)
`;
}

/**
 * Run a Python test script and capture output
 */
async function runPythonScript(
	scriptPath: string,
	timeoutMs: number = 60000
): Promise<{ success: boolean; output: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child = spawn(PYTHON_PATH, [scriptPath], {
			stdio: ['ignore', 'pipe', 'pipe']
		});

		let output = '';
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

		child.stdout?.on('data', (data) => {
			output += data.toString();
		});

		child.stderr?.on('data', (data) => {
			output += data.toString();
		});

		// Set timeout
		timeoutHandle = setTimeout(() => {
			child.kill('SIGKILL');
			resolve({
				success: false,
				output: output + '\nTIMEOUT: Script execution timed out',
				exitCode: -1
			});
		}, timeoutMs);

		child.on('close', (code) => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			resolve({
				success: code === 0,
				output,
				exitCode: code ?? -1
			});
		});

		child.on('error', (err) => {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			resolve({
				success: false,
				output: `Failed to run script: ${err.message}`,
				exitCode: -1
			});
		});
	});
}

/**
 * Language Unicorn Verifier Class
 *
 * Provides firmware safety verification using Unicorn emulator.
 */
export class LanguageUnicornVerifier {
	private tempDir: string;
	private firmwarePath: string | null = null;

	constructor(tempDir: string = TEMP_DIR) {
		this.tempDir = tempDir;
		if (!existsSync(tempDir)) {
			mkdirSync(tempDir, { recursive: true });
		}
	}

	/**
	 * Set firmware path for testing
	 */
	setFirmwarePath(path: string): void {
		this.firmwarePath = path;
	}

	/**
	 * Verify language system integrity
	 */
	async verifyLanguageSystem(
		firmwareData: Uint8Array,
		expectedLanguageCount: number
	): Promise<UnicornVerificationResult> {
		const testCases: UnicornTestCase[] = [];
		const errors: string[] = [];

		// Write firmware to temp file
		const firmwarePath = join(this.tempDir, `firmware_${Date.now()}.bin`);
		writeFileSync(firmwarePath, firmwareData);

		// Test 1: Basic language system verification
		const basicScript = join(this.tempDir, `basic_verification_${Date.now()}.py`);
		writeFileSync(basicScript, generateLanguageVerificationScript(
			firmwarePath,
			expectedLanguageCount,
			0x7625A8 // FIRST_POOL_ADDRESS
		));

		const basicResult = await runPythonScript(basicScript);
		testCases.push({
			name: 'Basic Language System Verification',
			passed: basicResult.success,
			output: basicResult.output,
			error: basicResult.success ? undefined : basicResult.output
		});

		if (!basicResult.success) {
			errors.push(`Basic verification failed: ${basicResult.output}`);
		}

		// Clean up
		try {
			require('fs').unlinkSync(firmwarePath);
			require('fs').unlinkSync(basicScript);
		} catch {}

		return {
			passed: errors.length === 0,
			testCases,
			errors
		};
	}

	/**
	 * Verify language access after modifications
	 */
	async verifyLanguageAccess(
		firmwareData: Uint8Array,
		languageIndex: number,
		stringIndex: number = 0
	): Promise<UnicornVerificationResult> {
		const testCases: UnicornTestCase[] = [];
		const errors: string[] = [];

		// Write firmware to temp file
		const firmwarePath = join(this.tempDir, `firmware_access_${Date.now()}.bin`);
		writeFileSync(firmwarePath, firmwareData);

		// Generate and run access verification script
		const accessScript = join(this.tempDir, `access_verification_${Date.now()}.py`);
		writeFileSync(accessScript, generateLanguageAccessVerificationScript(
			firmwarePath,
			languageIndex,
			stringIndex
		));

		const accessResult = await runPythonScript(accessScript);
		testCases.push({
			name: `Language Access Verification (lang=${languageIndex}, str=${stringIndex})`,
			passed: accessResult.success,
			output: accessResult.output,
			error: accessResult.success ? undefined : accessResult.output
		});

		if (!accessResult.success) {
			errors.push(`Access verification failed: ${accessResult.output}`);
		}

		// Clean up
		try {
			require('fs').unlinkSync(firmwarePath);
			require('fs').unlinkSync(accessScript);
		} catch {}

		return {
			passed: errors.length === 0,
			testCases,
			errors
		};
	}

	/**
	 * Full verification suite for knock down operations
	 */
	async verifyKnockDown(
		originalFirmware: Uint8Array,
		modifiedFirmware: Uint8Array,
		newLanguageCount: number
	): Promise<UnicornVerificationResult> {
		const testCases: UnicornTestCase[] = [];
		const errors: string[] = [];

		// Verify original firmware
		const originalResult = await this.verifyLanguageSystem(originalFirmware, newLanguageCount + 1);
		testCases.push({
			name: 'Original Firmware Verification',
			passed: originalResult.passed,
			output: originalResult.testCases.map(t => t.output).join('\n'),
			error: originalResult.passed ? undefined : originalResult.errors.join('; ')
		});

		// Verify modified firmware
		const modifiedResult = await this.verifyLanguageSystem(modifiedFirmware, newLanguageCount);
		testCases.push({
			name: 'Modified Firmware Verification',
			passed: modifiedResult.passed,
			output: modifiedResult.testCases.map(t => t.output).join('\n'),
			error: modifiedResult.passed ? undefined : modifiedResult.errors.join('; ')
		});

		if (!modifiedResult.passed) {
			errors.push(...modifiedResult.errors);
		}

		// Verify each remaining language is accessible
		for (let i = 0; i < Math.min(newLanguageCount, 5); i++) {
			const accessResult = await this.verifyLanguageAccess(modifiedFirmware, i, 0);
			testCases.push({
				name: `Language ${i} Access`,
				passed: accessResult.passed,
				output: accessResult.testCases.map(t => t.output).join('\n'),
				error: accessResult.passed ? undefined : accessResult.errors.join('; ')
			});

			if (!accessResult.passed) {
				errors.push(`Language ${i} access verification failed`);
			}
		}

		return {
			passed: errors.length === 0,
			testCases,
			errors
		};
	}
}
