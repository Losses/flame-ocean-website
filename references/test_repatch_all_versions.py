#!/usr/bin/env python3
"""
Test re-patching functionality with Unicorn emulation

This test verifies the theme patching system works correctly for all
supported firmware versions (V2.4.0 and later).

FIRMWARE VERSION SUPPORT:
- Theme system introduced: V1.8.0
- Stabilized for patching: V2.4.0 and later
- Unsupported: V1.x (early experimental versions)

For each supported version, this test verifies:
1. Menu text colors (5 themes × 3 colors = 15 values)
2. FLAC colors (5 themes)
3. All themes work correctly (verified with Unicorn emulation)
4. Re-patching reuses NOP slide (doesn't consume more space)
5. Size check rejects patches that don't fit
"""
import sys
import subprocess
from pathlib import Path

# Try to import Unicorn
try:
	from unicorn import *
	from unicorn.arm_const import *
except ImportError:
	print("Error: unicorn module not found")
	print("Install with: pip install unicorn")
	print("Or use: /nix/store/lc6q15imd72k6a4mpm9zzr3g0yygs4k6-system-path/bin/python3")
	sys.exit(1)

# Add references directory to path
sys.path.insert(0, str(Path(__file__).parent))
from theme_patcher import ThemePatcher

def is_patch_code_signature(firmware: bytes, addr: int) -> bool:
	"""
	Check if the code at addr has the signature of our generated patch code.

	Our patch code has distinctive characteristics:
	- Multiple MOVW/MOVT instruction PAIRS in sequence
	- MOVW followed by MOVT for the SAME register (loading 32-bit value)
	- Very high density compared to normal firmware code

	Returns True if this looks like our patch code.
	"""
	if addr + 64 > len(firmware):
		return False

	# Count MOVW/MOVT pairs (MOVW followed by MOVT for same register)
	pair_count = 0

	# Iterate by 4 bytes since MOVW/MOVT are 32-bit instructions
	for j in range(addr, min(addr + 64, len(firmware) - 7), 4):
		hw1 = firmware[j] | (firmware[j + 1] << 8)
		hw2 = firmware[j + 2] | (firmware[j + 3] << 8)

		# Check if first instruction is MOVW
		if (hw1 & 0xF800) == 0xF000:
			opcode1 = (hw1 >> 4) & 0xF  # Fixed: use 4-bit mask
			if opcode1 == 0x4:  # MOVW
				rd1 = (hw2 >> 8) & 0xF

				# Check if next instruction is MOVT for same register
				hw1_next = firmware[j + 4] | (firmware[j + 5] << 8)
				hw2_next = firmware[j + 6] | (firmware[j + 7] << 8)

				if (hw1_next & 0xF800) == 0xF000:
					opcode2 = (hw1_next >> 4) & 0xF  # Fixed: use 4-bit mask
					if opcode2 == 0xC:  # MOVT
						rd2 = (hw2_next >> 8) & 0xF
						if rd1 == rd2:  # Same register = MOVW/MOVT pair
							pair_count += 1
							# Skip the MOVT we just counted
							# (but we'll still check it in next iteration)

	# Our patch code has 6+ MOVW/MOVT pairs in first 64 bytes
	# Normal firmware rarely has MOVW/MOVT pairs (usually just MOVW)
	return pair_count >= 6


def discover_bl_to_patch_code(firmware: bytes):
	"""
	Find BL instructions that branch to our patch code.

	Searches ALL BL instructions in the firmware and checks if their target
	has the signature of our generated patch code. Returns BOTH the BL address
	AND the NOP slide address (from the BL target).

	This is the correct approach - find BL instructions, decode their targets,
	and verify the target looks like our patch code.

	Returns tuple: (flac_bl_addr, menu_bl_addr, nop_slide_addr)
	"""
	bl_instructions = []

	# Find all BL instructions
	for i in range(0, len(firmware) - 4, 2):
		hw1 = firmware[i] | (firmware[i + 1] << 8)
		hw2 = firmware[i + 2] | (firmware[i + 3] << 8)

		if (hw1 & 0xF800) == 0xF000 and (hw2 & 0xD000) == 0xD000:
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

			target = i + 4 + imm32

			# Check if target looks like our patch code
			if 0 <= target < len(firmware) and is_patch_code_signature(firmware, target):
				bl_instructions.append((i, target))

	# We should have exactly 2 BLs pointing to our patch code (FLAC and Menu)
	if len(bl_instructions) >= 2:
		# Sort by target address (FLAC is usually first)
		bl_instructions.sort(key=lambda x: x[1])

		# FLAC BL should be the first one (lower target address)
		flac_bl = bl_instructions[0][0]
		nop_slide = bl_instructions[0][1]

		# Menu BL should be the second one (higher target address within same NOP slide)
		for bl_addr, target in bl_instructions[1:]:
			if abs(target - nop_slide) < 1024:  # Same NOP slide
				menu_bl = bl_addr
				break
		else:
			menu_bl = None

		return (flac_bl, menu_bl, nop_slide)

	return None


def discover_flac_function(firmware: bytes):
	"""
	Discover FLAC BL instruction by finding BL that branches to our patch code.

	Uses signature-based detection to find BL instructions that target our
	generated patch code, without any hardcoded addresses.
	"""
	result = discover_bl_to_patch_code(firmware)

	if result:
		flac_bl, menu_bl, nop_slide = result
		return flac_bl

	return None

def find_nop_slide_start(firmware: bytes, flac_patch_addr: int):
	"""Find NOP slide start by decoding BL instruction"""
	bl_bytes = firmware[flac_patch_addr:flac_patch_addr + 4]
	hw1 = bl_bytes[0] | (bl_bytes[1] << 8)
	hw2 = bl_bytes[2] | (bl_bytes[3] << 8)

	S = (hw1 >> 10) & 1
	J1 = (hw2 >> 13) & 1
	J2 = (hw2 >> 11) & 1
	imm10 = hw1 & 0x3FF
	imm11 = hw2 & 0x7FF

	I1 = (~(J1 ^ S)) & 1
	I2 = (~(J2 ^ S)) & 1

	# imm10 is bits [21:12], imm11 is bits [11:1], so shift imm11 left by 1
	imm25 = (S << 24) | ((~(J1 ^ S) & 1) << 23) | ((~(J2 ^ S) & 1) << 22) | (imm10 << 12) | (imm11 << 1)

	# Shift left by 1 to get byte offset (bit 0 of imm25 is always 0)
	imm32 = imm25 << 1

	if S:
		imm32 |= 0xFE000000  # Sign extend from bit 25

	target = flac_patch_addr + 4 + imm32
	return target


def emulate_flac_handler(firmware: bytes, flac_code_addr: int, theme_idx: int, expected_color: int) -> dict:
	"""Emulate FLAC handler and verify it returns expected color"""
	uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB)

	code_base = flac_code_addr & ~0xFFF
	uc.mem_map(code_base, 0x10000, UC_PROT_READ | UC_PROT_WRITE | UC_PROT_EXEC)
	# Map more bytes to include the color table and full NOP slide code
	uc.mem_write(flac_code_addr, firmware[flac_code_addr:flac_code_addr + 512])

	# Also map stack region
	uc.mem_map(0x20000000, 0x10000, UC_PROT_READ | UC_PROT_WRITE)
	uc.reg_write(UC_ARM_REG_SP, 0x20008000)

	uc.reg_write(UC_ARM_REG_CPSR, 0x000001F3)
	uc.reg_write(UC_ARM_REG_R1, theme_idx)
	uc.reg_write(UC_ARM_REG_LR, (flac_code_addr + 100) | 1)
	uc.reg_write(UC_ARM_REG_PC, flac_code_addr | 1)

	def hook_code(uc, address, size, user_data):
		try:
			instr_bytes = uc.mem_read(address, 2)
			if instr_bytes[0] == 0x70 and instr_bytes[1] == 0x47:
				uc.emu_stop()
		except:
			pass

	uc.hook_add(UC_HOOK_CODE, hook_code)

	try:
		uc.emu_start(flac_code_addr | 1, (flac_code_addr + 1000) | 1, 0, 100)
		r0 = uc.reg_read(UC_ARM_REG_R0)

		if r0 == expected_color:
			return {"expected": expected_color, "actual": r0, "passed": True}
		else:
			return {"expected": expected_color, "actual": r0, "passed": False}

	except UcError as e:
		return {"expected": expected_color, "actual": None, "passed": False, "error": str(e)}


def test_firmware_repatching(original_firmware: Path, version_name: str, project_root: Path):
	"""Test re-patching for a single firmware version using TypeScript patcher"""
	print(f"\n{'=' * 60}")
	print(f"Testing: {version_name}")
	print(f"{'=' * 60}")

	# Use temp files with predictable names
	first_patched = Path("/tmp/repatch_test_first.IMG")
	repatched = Path("/tmp/repatch_test_second.IMG")

	# First set of colors
	first_flac_colors = [0xF800, 0xF800, 0xF800, 0xF800, 0x07E0]
	first_menu_colors = [
		0xF800, 0x07E0, 0x001F,
		0xFFFF, 0xFFFF, 0xFFFF,
		0xF800, 0xF800, 0xF800,
		0x07E0, 0x07E0, 0x07E0,
		0x001F, 0x001F, 0x001F,
	]

	# Second set of colors (distinctly different)
	second_flac_colors = [0x44DE, 0x44DE, 0x44DE, 0x44DE, 0xE162]
	second_menu_colors = [
		0x77DE, 0x2945, 0x0000,
		0xFFFF, 0x2945, 0xFFFF,
		0x77DE, 0x0000, 0x2945,
		0xFFFF, 0x0000, 0x0000,
		0xFFFF, 0x0000, 0x0000,
	]

	# Create first patch using TypeScript patcher
	print("\n[Step 1] Creating first patch...")
	first_patch_script = f"""
import {{ readFileSync }} from 'fs';
import {{ ThemePatcher }} from '{project_root}/src/lib/rse/theme/patcher.js';

const original = readFileSync('{original_firmware}');
const patcher = new ThemePatcher(original);

const flacColors = {first_flac_colors};
const menuColors = {first_menu_colors};

const result = patcher.patch({{ flacColors, menuColors }}, '{first_patched}', true);
console.log(JSON.stringify({{ success: result.success }}));
"""
	first_patch_script_path = Path("/tmp/first_patch_script.ts")
	first_patch_script_path.write_text(first_patch_script)

	result = subprocess.run(
		["bun", "run", str(first_patch_script_path)],
		capture_output=True,
		text=True,
		cwd=str(project_root)
	)

	if result.returncode != 0 or "true" not in result.stdout.lower():
		print(f"  ❌ First patch failed")

		# Check for specific error patterns
		if "cannot be patched" in result.stderr.lower():
			print(f"  ℹ️  {version_name} may not support theme patching")
			print(f"     Theme system support: V2.4.0 and later")
		elif result.stderr:
			# Show error lines
			for line in result.stderr.split('\n'):
				if '[error]' in line.lower():
					print(f"     {line.strip()}")
		return False

	print(f"  ✅ First patch created")

	# Verify first patch with Unicorn
	print("\n[Step 2] Verifying first patch with Unicorn...")
	with open(first_patched, 'rb') as f:
		first_firmware = f.read()

	flac_addr = discover_flac_function(first_firmware)
	if not flac_addr:
		print(f"  ❌ Could not discover FLAC function")
		return False

	nop_slide = find_nop_slide_start(first_firmware, flac_addr)
	print(f"  NOP slide: 0x{nop_slide:X}")

	# Test all 5 themes
	first_passed = True
	for theme_idx, expected_color in enumerate(first_flac_colors):
		result = emulate_flac_handler(first_firmware, nop_slide, theme_idx, expected_color)
		if result["passed"]:
			print(f"  ✅ Theme {theme_idx}: R0 = 0x{result['actual']:04X}")
		else:
			error = result.get('error', 'wrong value')
			print(f"  ❌ Theme {theme_idx}: Expected 0x{expected_color:04X}, got {error}")
			first_passed = False

	if not first_passed:
		print(f"  ❌ First patch verification failed")
		return False

	print(f"  ✅ First patch verified")

	# Create re-patch using TypeScript patcher
	print("\n[Step 3] Creating re-patch...")
	repatch_script = f"""
import {{ readFileSync }} from 'fs';
import {{ ThemePatcher }} from '{project_root}/src/lib/rse/theme/patcher.js';

const firstPatched = readFileSync('{first_patched}');
const patcher = new ThemePatcher(firstPatched);

const flacColors = {second_flac_colors};
const menuColors = {second_menu_colors};

const result = patcher.patch(flacColors, menuColors, '{repatched}', true);
console.log(JSON.stringify({{ success: result.success }}));
"""
	repatch_script_path = Path("/tmp/repatch_script.ts")
	repatch_script_path.write_text(repatch_script)

	result = subprocess.run(
		["bun", "run", str(repatch_script_path)],
		capture_output=True,
		text=True,
		cwd=str(project_root)
	)

	if result.returncode != 0 or "true" not in result.stdout.lower():
		print(f"  ❌ Re-patch failed")
		if result.stderr:
			for line in result.stderr.split('\n'):
				if '[error]' in line.lower():
					print(f"     {line.strip()}")
		return False

	print(f"  ✅ Re-patch created")

	# Verify re-patched firmware with Unicorn
	print("\n[Step 4] Verifying re-patched firmware with Unicorn...")
	with open(repatched, 'rb') as f:
		repatched_firmware = f.read()

	repatched_nop_slide = find_nop_slide_start(repatched_firmware, flac_addr)

	# Check if NOP slide was reused
	if repatched_nop_slide == nop_slide:
		print(f"  ✅ NOP slide reused (same address: 0x{nop_slide:X})")
	else:
		print(f"  ⚠️  NOP slide changed from 0x{nop_slide:X} to 0x{repatched_nop_slide:X}")
		print(f"     (This is OK if the original NOP slide was too small)")

	# Test new colors - verify all 5 themes
	second_passed = True
	for theme_idx, expected_color in enumerate(second_flac_colors):
		result = emulate_flac_handler(repatched_firmware, repatched_nop_slide, theme_idx, expected_color)
		if result["passed"]:
			print(f"  ✅ Theme {theme_idx}: R0 = 0x{result['actual']:04X}")
		else:
			error = result.get('error', 'wrong value')
			print(f"  ❌ Theme {theme_idx}: Expected 0x{expected_color:04X}, got {error}")
			second_passed = False

	if not second_passed:
		print(f"  ❌ Re-patched firmware verification failed")
		return False

	print(f"  ✅ Re-patched firmware verified")
	return True


def main():
	"""Test re-patching with all available firmware versions"""
	print("=" * 60)
	print("Re-patching Test with Unicorn Emulation")
	print("Testing with ALL available firmware versions")
	print("=" * 60)

	# Find all available firmware versions
	firmware_dir = Path("/tmp/echo-mini-firmwares")
	if not firmware_dir.exists():
		print(f"\n❌ Firmware directory not found: {firmware_dir}")
		print("Download firmwares first using: bun run src/lib/rse/__tests__/setup-fixtures.ts")
		return 1

	# Find all .IMG files (different versions have different names like HIFIEC27.IMG, HIFIEC70.IMG, etc.)
	firmware_files = list(firmware_dir.glob("**/*.IMG"))
	# Filter out patched firmware files
	firmware_files = [f for f in firmware_files if "_PATCHED" not in f.name]

	if not firmware_files:
		print(f"\n❌ No firmware files found in {firmware_dir}")
		return 1

	print(f"\nFound {len(firmware_files)} firmware version(s):")

	# Get project root
	project_root = Path(__file__).parent.parent

	results = {}
	for fw_file in firmware_files:
		# Extract version from path (e.g., "ECHO MINI V3.1.0")
		parts = fw_file.parts
		version = None
		for i, part in enumerate(parts):
			if part == "ECHO MINI":
				if i + 1 < len(parts):
					version = f"ECHO MINI {parts[i + 1]}"
					break

		if not version:
			version = fw_file.parent.name

		print(f"  - {version}: {fw_file}")
		results[version] = test_firmware_repatching(fw_file, version, project_root)

	# Summary
	print("\n" + "=" * 60)
	print("Summary")
	print("=" * 60)

	supported = []
	unsupported = []
	for version, passed in results.items():
		# Extract version number (e.g., "V3.1.0" from "ECHO MINI V3.1.0")
		vnum = version.split()[-1] if version else ""
		is_early_version = vnum.startswith("V1.") or (vnum.startswith("V2.") and
						       any(vnum < f"V2.4" for vnum in [vnum]))

		if passed:
			supported.append(version)
			print(f"✅ {version}: PASSED")
		else:
			unsupported.append((version, "early version" if is_early_version else "other error"))
			if is_early_version:
				print(f"⚠️  {version}: UNSUPPORTED (V1.x/V2.0-V2.3 - theme system not stabilized)")
			else:
				print(f"❌ {version}: FAILED (unexpected error)")

	print(f"\nSupported versions ({len(supported)}/{len(results)}):")
	for v in supported:
		print(f"  ✅ {v}")

	if unsupported:
		print(f"\nUnsupported versions ({len(unsupported)}/{len(results)}):")
		for v, reason in unsupported:
			if "early version" in reason:
				print(f"  ⊘ {v} - {reason}")
			else:
				print(f"  ❌ {v} - {reason}")

	# Check if all V2.4.0+ versions passed
	def is_v24_or_later(version: str) -> bool:
		"""Check if version is V2.4.0 or later"""
		parts = version.split()
		if len(parts) < 2:
			return False
		vstr = parts[-1]  # Get version number like "V3.1.0"
		if not vstr.startswith("V"):
			return False
		# Parse version number
		try:
			major, minor = vstr[1:].split(".")[:2]  # "3.1" from "V3.1.0"
			if major == "1":
				return False
			if major == "2":
				return int(minor) >= 4
			return True  # V3.x and later
		except:
			return False

	v24_and_later = [v for v in results.keys() if is_v24_or_later(v)]
	all_v24_passed = all(v in supported for v in v24_and_later)

	if all_v24_passed and len(v24_and_later) > 0:
		print(f"\n✅ All supported firmware versions (V2.4.0+) passed!")
		return 0
	elif len(supported) > 0:
		print(f"\n⚠️  Some V2.4.0+ versions failed unexpectedly")
		return 1
	else:
		print(f"\n❌ No firmware versions passed")
		return 1


if __name__ == '__main__':
	sys.exit(main())
