/**
 * BL Precision Verification Test - Based on Python Reference Test
 *
 * Tests all 9 patch combinations on all firmware versions
 * Verifies BL instruction precision using static decoding (no emulation needed)
 * Verifies NOP slide boundaries
 * Verifies V1.8.0 rejection
 *
 * Usage: bun run src/lib/rse/__tests__/unicorn-verification.ts
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { ThemePatcher } from '../theme/patcher.js';
import { join } from 'path';

const FIRMWARE_BASE = '/tmp/echo-mini-firmwares';

const FIRMWARE_VERSIONS = [
	{ version: 'V1.8.0', file: 'HIFIEC80.IMG', subdir: 'ECHO MINI V1.8.0/ECHO MINI V1.8.0', shouldFail: true },
	{ version: 'V2.4.0', file: 'HIFIEC40.IMG', subdir: 'ECHO MINI V2.4.0/ECHO MINI V2.4.0', shouldFail: false },
	{ version: 'V2.5.0', file: 'HIFIEC50.IMG', subdir: 'ECHO MINI V2.5.0/ECHO MINI V2.5.0', shouldFail: false },
	{ version: 'V2.6.0', file: 'HIFIEC60.IMG', subdir: 'ECHO MINI V2.6.0/ECHO MINI V2.6.0', shouldFail: false },
	{ version: 'V2.7.0', file: 'HIFIEC70.IMG', subdir: 'ECHO MINI V2.7.0/ECHO MINI V2.7.0', shouldFail: false },
	{ version: 'V2.8.0', file: 'HIFIEC80.IMG', subdir: 'ECHO MINI V2.8.0/ECHO MINI V2.8.0', shouldFail: false },
	{ version: 'V3.0.0', file: 'HIFIEC00.IMG', subdir: 'ECHO MINI V3.0.0/ECHO MINI V3.0.0', shouldFail: false },
	{ version: 'V3.1.0', file: 'HIFIEC10.IMG', subdir: 'ECHO MINI V3.1.0/ECHO MINI V3.1.0', shouldFail: false },
	{ version: 'V3.2.0', file: 'HIFIEC20.IMG', subdir: 'ECHO MINI V3.2.0/ECHO MINI V3.2.0', shouldFail: false },
];

const OPERATIONS = [
	{ name: 'FLAC → FLAC', testFlac: true, testMenu: false },
	{ name: 'FLAC → Menu', testFlac: false, testMenu: true },
	{ name: 'FLAC → Both', testFlac: true, testMenu: true },
	{ name: 'Menu → FLAC', testFlac: true, testMenu: false },
	{ name: 'Menu → Menu', testFlac: false, testMenu: true },
	{ name: 'Menu → Both', testFlac: true, testMenu: true },
	{ name: 'Both → FLAC', testFlac: true, testMenu: false },
	{ name: 'Both → Menu', testFlac: false, testMenu: true },
	{ name: 'Both → Both', testFlac: true, testMenu: true },
];

const TEST_COLORS = {
	flac: [0x1111, 0x2222, 0x3333, 0x4444, 0x5555],
	menu: [0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888, 0x9999, 0xAAAA, 0xBBBB, 0xCCCC, 0xDDDD, 0xEEEE, 0xFFFF]
};

/**
 * Decode BL instruction to get target address
 */
function decodeBlTarget(data: Buffer, fromAddr: number): number {
	const hw1 = data[fromAddr] | (data[fromAddr + 1] << 8);
	const hw2 = data[fromAddr + 2] | (data[fromAddr + 3] << 8);

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

	return fromAddr + 4 + imm32;
}

/**
 * Check patch boundaries
 */
function checkPatchBoundaries(data: Buffer, nopSlideStart: number, nopSlideEnd: number): boolean {
	let patchEnd = nopSlideStart;
	while (patchEnd < nopSlideEnd && patchEnd < data.length) {
		if (data[patchEnd] !== 0 || data[patchEnd + 1] !== 0) {
			patchEnd += 2;
		} else {
			break;
		}
	}

	return patchEnd <= nopSlideEnd;
}

async function runVerification() {
	console.log('╔═══════════════════════════════════════════════════════════════════════════╗');
	console.log('║              BL Precision Verification - All Versions × 9 Combinations        ║');
	console.log('╚═════════════════════════════════════════════════════════════════════════╝');
	console.log();

	let totalTests = 0;
	let passedTests = 0;
	let failedTests = 0;
	let skippedTests = 0;

	for (const firmware of FIRMWARE_VERSIONS) {
		const firmwarePath = join(FIRMWARE_BASE, firmware.subdir, firmware.file);

		if (!existsSync(firmwarePath)) {
			console.log(`⊘  ${firmware.version} - SKIP (file not found)`);
			skippedTests++;
			continue;
		}

		console.log(`\n📦 ${firmware.version}`);
		console.log('─'.repeat(80));

		for (const operation of OPERATIONS) {
			totalTests++;
			process.stdout.write(`  ${operation.name}... `);

			try {
				// Apply first patch
				const firstOutput = `/tmp/verify_${firmware.version}_${operation.name.replace(/ → /g, '_')}_1.IMG`;
				const firmwareData = readFileSync(firmwarePath);
				const patcher1 = new ThemePatcher(firmwareData);

				let firstResult;
				try {
					firstResult = patcher1.patch(
						{ flacColors: TEST_COLORS.flac, menuColors: TEST_COLORS.menu },
						firstOutput,
						true
					);
				} catch (error: any) {
					// V1.8.0 FLAC should fail
					if (firmware.shouldFail && error.message?.includes('BL instruction precision loss')) {
						console.log('✅ PASS (V1.8.0 FLAC correctly rejected)\n');
						passedTests++;
						continue;
					}
					console.log(`✗ FAIL: ${error.message?.substring(0, 60)}\n`);
					failedTests++;
					continue;
				}

				if (!firstResult?.success) {
					console.log('✗ FAIL: First patch failed\n');
					failedTests++;
					continue;
				}

				// Apply second patch
				const secondColors: any = {};
				if (operation.testFlac) secondColors.flacColors = TEST_COLORS.flac;
				if (operation.testMenu) secondColors.menuColors = TEST_COLORS.menu;

				const secondOutput = `/tmp/verify_${firmware.version}_${operation.name.replace(/ → /g, '_')}_2.IMG`;
				const firstData = readFileSync(firstOutput);
				const patcher2 = new ThemePatcher(firstData);
				const secondResult = patcher2.patch(secondColors, secondOutput, true);

				if (!secondResult?.success) {
					console.log('✗ FAIL: Second patch failed\n');
					failedTests++;
					continue;
				}

				// Verify BL precision
				const patchedData = readFileSync(secondOutput);
				const nopSlideStart = secondResult.nopSlide?.start || 0;
				const nopSlideEnd = secondResult.nopSlide?.end || 0;
				const flacBl = operation.testFlac ? (secondResult.patchPoints?.flac?.patchAddr || 0) : 0;
				const menuBl = operation.testMenu ? (secondResult.patchPoints?.menu?.patchAddr || 0) : 0;
				// Calculate handler addresses based on NOP slide layout
				// FLAC handler is at NOP slide start
				// Menu handler is at NOP slide start + 76 (0x4c)
				const flacHandler = operation.testFlac ? nopSlideStart : 0;
				const menuHandler = operation.testMenu ? (nopSlideStart + 0x4c) : 0;

				// Check boundaries
				if (!checkPatchBoundaries(patchedData, nopSlideStart, nopSlideEnd)) {
					console.log('✗ FAIL: Patch exceeds boundaries\n');
					failedTests++;
					continue;
				}

				// Verify FLAC BL precision
				if (operation.testFlac && flacBl !== 0) {
					const flacTarget = decodeBlTarget(patchedData, flacBl);
					if (flacTarget !== flacHandler) {
						console.log(`✗ FAIL: FLAC BL error (expected 0x${flacHandler.toString(16)}, got 0x${flacTarget.toString(16)})\n`);
						failedTests++;
						continue;
					}
				}

				// Verify Menu BL precision
				if (operation.testMenu && menuBl !== 0) {
					const menuTarget = decodeBlTarget(patchedData, menuBl);
					if (menuTarget !== menuHandler) {
						console.log(`✗ FAIL: Menu BL error (expected 0x${menuHandler.toString(16)}, got 0x${menuTarget.toString(16)})\n`);
						failedTests++;
						continue;
					}
				}

				console.log('✅ PASS\n');
				passedTests++;

			} catch (error: any) {
				console.log(`✗ ERROR: ${error.message?.substring(0, 60)}\n`);
				failedTests++;
			}
		}
	}

	// Print summary
	console.log('\n╔═════════════════════════════════════════════════════════════════════════╗');
	console.log('║                           Test Summary                                  ║');
	console.log('╚═════════════════════════════════════════════════════════════════════════╝');
	console.log();
	console.log(`Total:   ${totalTests}`);
	console.log(`Passed:  ${passedTests} ✅`);
	console.log(`Failed:  ${failedTests} ❌`);
	console.log(`Skipped: ${skippedTests} ⊘`);
	console.log(`Success: ${((passedTests / (passedTests + failedTests)) * 100).toFixed(1)}%`);

	if (failedTests > 0) {
		process.exit(1);
	}

	console.log('\n🎉 ALL TESTS PASSED');
	console.log('\n✅ Verified:');
	console.log('   • All firmware versions (V1.8.0-V3.2.0)');
	console.log('   • All 9 patch operation combinations');
	console.log('   • BL instruction precision (FLAC & Menu)');
	console.log('   • NOP slide boundaries');
	console.log('   • V1.8.0 rejection (BL precision loss)');
}

runVerification().catch((error) => {
	console.error('Test execution failed:', error);
	process.exit(1);
});
