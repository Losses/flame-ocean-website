/**
 * Standalone Patch Script for Spawn Execution
 *
 * This script is executed as a separate process via spawn()
 * Receives task via command-line arguments (JSON file)
 * Returns result via stdout (JSON)
 */

import { readFileSync, unlinkSync } from 'fs';
import { ThemePatcher } from '../theme/patcher.js';
import { decodeBlTarget } from '../theme/thumb/encoders.js';

interface PatchTask {
	id: string;
	firmwarePath: string;
	colors: { flacColors?: number[]; menuColors?: number[] };
	outputPath: string;
	flacAddr: number;
}

interface PatchResult {
	id: string;
	success: boolean;
	nopSlideAddr: number;
	blAddr: number | null;
	error?: string;
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length < 1) {
		console.error('Usage: patch-spawn.ts <task-json-file>');
		process.exit(1);
	}

	const taskJsonFile = args[0];
	let task: PatchTask;

	// Read task from JSON file
	try {
		const taskContent = readFileSync(taskJsonFile, 'utf-8');
		task = JSON.parse(taskContent);
	} catch (error) {
		const result: PatchResult = {
			id: 'unknown',
			success: false,
			nopSlideAddr: 0,
			blAddr: null,
			error: `Failed to read task file: ${error instanceof Error ? error.message : String(error)}`
		};
		console.log(JSON.stringify(result));
		process.exit(1);
	}

	try {
		const firmwareData = readFileSync(task.firmwarePath);
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch(task.colors, task.outputPath, true);

		if (!result.success) {
			const patchResult: PatchResult = {
				id: task.id,
				success: false,
				nopSlideAddr: 0,
				blAddr: null,
				error: 'Patching failed'
			};
			console.log(JSON.stringify(patchResult));
			process.exit(1);
		}

		// Determine which BL address to use based on what was patched
		const blAddr = task.colors.flacColors && task.colors.flacColors.length > 0
			? result.patchPoints?.flac?.patchAddr
			: result.patchPoints?.menu?.patchAddr;

		if (!blAddr) {
			const patchResult: PatchResult = {
				id: task.id,
				success: false,
				nopSlideAddr: 0,
				blAddr: null,
				error: 'BL address not found in patch result'
			};
			console.log(JSON.stringify(patchResult));
			process.exit(1);
		}

		// Read patched firmware and decode BL target
		const patchedData = readFileSync(task.outputPath);

		// Validate inputs before decoding
		if (!patchedData || patchedData.length === 0) {
			throw new Error('Patched firmware data is empty');
		}

		if (typeof blAddr !== 'number' || isNaN(blAddr)) {
			throw new Error(`Invalid BL address: ${blAddr}`);
		}

		// Extract the 4-byte BL instruction from the patched firmware
		const blBytes = patchedData.slice(blAddr, blAddr + 4);

		if (!blBytes || blBytes.length !== 4) {
			throw new Error(`Invalid BL instruction at address ${blAddr}: expected 4 bytes, got ${blBytes?.length}`);
		}

		const nopSlideAddr = decodeBlTarget(blAddr, blBytes);

		const patchResult: PatchResult = {
			id: task.id,
			success: true,
			nopSlideAddr,
			blAddr
		};

		// Clean up task JSON file
		try {
			unlinkSync(taskJsonFile);
		} catch {
			// Ignore cleanup errors
		}

		console.log(JSON.stringify(patchResult));
		process.exit(0);
	} catch (error) {
		const patchResult: PatchResult = {
			id: task.id,
			success: false,
			nopSlideAddr: 0,
			blAddr: null,
			error: error instanceof Error ? error.message : String(error)
		};
		console.log(JSON.stringify(patchResult));

		// Clean up task JSON file
		try {
			unlinkSync(taskJsonFile);
		} catch {
			// Ignore cleanup errors
		}

		process.exit(1);
	}
}

main();
