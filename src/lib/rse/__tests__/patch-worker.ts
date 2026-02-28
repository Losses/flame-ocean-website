/**
 * Worker Thread for Parallel Firmware Patching
 *
 * Receives patching tasks from main thread and applies them in parallel
 */

import { parentPort } from 'worker_threads';
import { readFileSync } from 'fs';
import { ThemePatcher } from '../theme/patcher.js';

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

// Listen for task from main thread
parentPort!.on('message', (task: PatchTask) => {
	try {
		const firmwareData = readFileSync(task.firmwarePath);
		const patcher = new ThemePatcher(firmwareData);
		const result = patcher.patch(task.colors, task.outputPath, true);

		if (!result.success) {
			parentPort!.postMessage({
				id: task.id,
				success: false,
				nopSlideAddr: 0,
				blAddr: null,
				error: 'Patching failed'
			} as PatchResult);
			return;
		}

		// Determine which BL address to use based on what was patched
		const blAddr = task.colors.flacColors && task.colors.flacColors.length > 0
			? result.patchPoints?.flac?.patchAddr
			: result.patchPoints?.menu?.patchAddr;

		if (!blAddr) {
			parentPort!.postMessage({
				id: task.id,
				success: false,
				nopSlideAddr: 0,
				blAddr: null,
				error: 'BL address not found in patch result'
			} as PatchResult);
			return;
		}

		// Read patched firmware and decode BL target
		const patchedData = readFileSync(task.outputPath);
		const { decodeBlTarget } = require('../theme/thumb/encoders.js');

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

		parentPort!.postMessage({
			id: task.id,
			success: true,
			nopSlideAddr,
			blAddr
		} as PatchResult);
	} catch (error) {
		parentPort!.postMessage({
			id: task.id,
			success: false,
			nopSlideAddr: 0,
			blAddr: null,
			error: error instanceof Error ? error.message : String(error)
		} as PatchResult);
	}
});
