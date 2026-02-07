/**
 * Web Worker for firmware data processing
 * Handles all heavy computation off the main thread
 */

// Re-implement essential utilities inline for the worker
// to avoid complex import issues with bundling

// Constants
const SMALL_STRIDE = 32;
const LARGE_STRIDE = 33;
const FOOTER_SIGNATURES = new Set([0x90, 0x8f, 0x89, 0x8b, 0x8d, 0x8e, 0x8c]);
const ROCK26_SIGNATURE = new TextEncoder().encode('ROCK26IMAGERES');
const METADATA_ENTRY_SIZE = 108;
const ROCK26_ENTRY_SIZE = 16;

// Worker message types
interface WorkerRequest {
	type: 'analyze' | 'listPlanes' | 'listImages' | 'extractPlane' | 'extractImage';
	id: string;
	firmware: Uint8Array;
}

interface FontPlaneInfo {
	name: string;
	start: number;
	end: number;
	estimatedCount: number;
}

interface BitmapFileInfo {
	name: string;
	width: number;
	height: number;
	size: number;
	offset?: number;
}

interface PlaneData {
	name: string;
	start: number;
	end: number;
	fonts: Array<{
		unicode: number;
		fontType: 'SMALL' | 'LARGE';
		pixels: boolean[][];
	}>;
}

interface ImageData {
	name: string;
	width: number;
	height: number;
	rgb565Data: Uint8Array; // Raw RGB565 data
}

type WorkerResponse =
	| { type: 'success'; id: string; result: FontPlaneInfo[] | BitmapFileInfo[] | PlaneData | ImageData }
	| { type: 'progress'; id: string; message: string }
	| { type: 'error'; id: string; error: string };

// Firmware data cache
let firmwareData: Uint8Array | null = null;
let SMALL_BASE = 0;
let LARGE_BASE = 0;
let LOOKUP_TABLE = 0x080000;

// Binary reading helpers
function readU16LE(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
	return (
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24)
	) >>> 0;
}

function findBytes(data: Uint8Array, pattern: Uint8Array, startOffset = 0): number {
	if (pattern.length === 0) return startOffset;
	if (pattern.length > data.length) return -1;

	for (let i = startOffset; i <= data.length - pattern.length; i++) {
		let found = true;
		for (let j = 0; j < pattern.length; j++) {
			if (data[i + j] !== pattern[j]) {
				found = false;
				break;
			}
		}
		if (found) return i;
	}
	return -1;
}

// Font decoding
function decodeV8(chunk: Uint8Array, lookupVal: number): boolean[][] {
	const configByte = lookupVal & 0xff;
	const swMcuBits = (configByte >> 3) & 1;
	const swMcuHwSwap = (configByte >> 4) & 1;
	const swMcuByteSwap = (configByte >> 5) & 1;

	const pixels: boolean[][] = [];

	for (let i = 0; i < chunk.length - 1; i += 2) {
		const b0 = chunk[i];
		const b1 = chunk[i + 1];

		let finalPixel: number;

		if (swMcuBits === 1) {
			let val = (b1 << 8) | b0;
			if (swMcuByteSwap === 1) {
				val = ((val & 0xff) << 8) | ((val >> 8) & 0xff);
			}
			finalPixel = val;
		} else {
			let cycle1: number;
			let cycle2: number;

			if (swMcuHwSwap === swMcuByteSwap) {
				cycle1 = b1;
				cycle2 = b0;
			} else {
				cycle1 = b0;
				cycle2 = b1;
			}

			if (swMcuByteSwap === 1) {
				[cycle1, cycle2] = [cycle2, cycle1];
			}

			if (swMcuHwSwap === 1) {
				[cycle1, cycle2] = [cycle2, cycle1];
			}

			finalPixel = cycle2 | (cycle1 << 8);
		}

		if (!(swMcuBits === 1 && swMcuByteSwap === 1)) {
			finalPixel = ((finalPixel & 0xff) << 8) | ((finalPixel >> 8) & 0xff);
		}

		const rowBits: boolean[] = [];
		for (let bit = 15; bit > 0; bit--) {
			rowBits.push(((finalPixel >> bit) & 1) === 1);
		}
		pixels.push(rowBits);
	}

	return pixels;
}

function isValidFontData(pixels: boolean[][], fontType: 'LARGE' | 'SMALL'): boolean {
	const total = pixels.reduce((sum, row) => sum + row.length, 0);
	if (total === 0) return false;

	const filled = pixels.reduce((sum, row) => sum + row.filter((p) => p).length, 0);
	const ratio = filled / total;

	if (fontType === 'LARGE') {
		return ratio > 0.01 && ratio < 0.97;
	} else {
		return ratio > 0.01 && ratio < 0.95;
	}
}

// Unicode ranges (subset for demo)
const UNICODE_RANGES = [
	{ name: 'Basic_Latin', start: 0x0000, end: 0x007f },
	{ name: 'Latin_1_Supplement', start: 0x0080, end: 0x00ff },
	{ name: 'CJK_Unified', start: 0x4e00, end: 0x4fff },
	{ name: 'Hiragana', start: 0x3040, end: 0x309f },
	{ name: 'Katakana', start: 0x30a0, end: 0x30ff }
];

// Main worker handler
self.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
	const { type, id, firmware } = e.data;

	try {
		switch (type) {
			case 'analyze': {
				firmwareData = firmware;

				// Detect SMALL_BASE
				const config_78 = readU16LE(firmware, 0x78);
				const config_7a = readU16LE(firmware, 0x7a);
				SMALL_BASE = (config_7a << 16) | config_78;

				// Detect LARGE_BASE using simplified search
				self.postMessage({ type: 'progress', id, message: 'Searching for font data...' });

				// Use a simpler heuristic - search for sequences of valid footer signatures
				let bestScore = 0;
				let bestAddr = 0;

				for (let addr = 0x10000; addr < Math.min(firmware.length - 10000, 0x200000); addr += LARGE_STRIDE) {
					let score = 0;
					for (let i = 0; i < 100 && addr + i * LARGE_STRIDE + 32 < firmware.length; i++) {
						const byte_32 = firmware[addr + i * LARGE_STRIDE + 32];
						if (FOOTER_SIGNATURES.has(byte_32)) {
							score++;
						} else if (byte_32 === 0x00 || byte_32 === 0xff) {
							break;
						}
					}
					if (score > bestScore) {
						bestScore = score;
						bestAddr = addr;
					}
				}

				LARGE_BASE = bestAddr;

				self.postMessage({ type: 'success', id, result: [] });
				break;
			}

			case 'listPlanes': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const planes: FontPlaneInfo[] = [];

				for (const { name, start, end } of UNICODE_RANGES) {
					let count = 0;

					// Count SMALL fonts
					for (let uni = start; uni <= Math.min(end, 0xFFFF); uni++) {
						const addr = SMALL_BASE + uni * SMALL_STRIDE;
						if (addr + SMALL_STRIDE > firmwareData.length) continue;

						const chunk = firmwareData.slice(addr, addr + SMALL_STRIDE);
						if (chunk.every((b) => b === chunk[0])) continue;

						try {
							const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
							const pixels = decodeV8(chunk, lookupVal);
							if (pixels.length === 16 && isValidFontData(pixels, 'SMALL')) {
								count++;
							}
						} catch {
							continue;
						}
					}

					// Count LARGE fonts for CJK
					if (start >= 0x4e00) {
						for (let uni = start; uni <= end; uni++) {
							const addr = LARGE_BASE + (uni - 0x4e00) * LARGE_STRIDE;
							if (addr + LARGE_STRIDE > firmwareData.length) continue;

							const chunk = firmwareData.slice(addr, addr + LARGE_STRIDE);
							if (chunk.every((b) => b === chunk[0])) continue;

							try {
								const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
								const pixels = decodeV8(chunk, lookupVal);
								if (pixels.length === 16 && isValidFontData(pixels, 'LARGE')) {
									count++;
								}
							} catch {
								continue;
							}
						}
					}

					planes.push({ name, start, end, estimatedCount: count });
				}

				self.postMessage({ type: 'success', id, result: planes });
				break;
			}

			case 'listImages': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const images: BitmapFileInfo[] = [];

				// Find ROCK26 table
				const rock26Offset = findBytes(firmwareData, ROCK26_SIGNATURE);
				if (rock26Offset === -1) {
					self.postMessage({ type: 'success', id, result: images });
					return;
				}

				// Find metadata table using ROCK26 anchor
				const rock26EntriesStart = rock26Offset + 32;
				const anchorOffset = readU32LE(firmwareData, rock26EntriesStart + 12);

				// Search for the metadata table
				let tableStart = -1;
				for (let pos = 0; pos < firmwareData.length - METADATA_ENTRY_SIZE; pos += 4) {
					const entryOffset = readU32LE(firmwareData, pos + 20);
					if (entryOffset === anchorOffset) {
						// Verify it's a valid metadata entry
						const nameBytes = firmwareData.slice(pos + 32, pos + 96);
						const nullIdx = nameBytes.indexOf(0);
						const name = new TextDecoder('ascii').decode(nameBytes.slice(0, nullIdx > 0 ? nullIdx : 0));

						if (name.endsWith('.BMP') && name.length >= 3) {
							tableStart = pos;
							break;
						}
					}
				}

				if (tableStart === -1) {
					self.postMessage({ type: 'success', id, result: images });
					return;
				}

				// Parse metadata entries
				let pos = tableStart;
				while (pos + METADATA_ENTRY_SIZE <= firmwareData.length) {
					const nameBytes = firmwareData.slice(pos + 32, pos + 96);
					const nullIdx = nameBytes.indexOf(0);
					const decoder = new TextDecoder('ascii');
					const name = decoder.decode(nameBytes.slice(0, nullIdx >= 0 ? nullIdx : 0));

					if (!name || name.length < 3) break;

					const offset = readU32LE(firmwareData, pos + 20);
					const width = readU32LE(firmwareData, pos + 24);
					const height = readU32LE(firmwareData, pos + 28);

					// Skip invalid entries
					if (offset === 0 || width <= 0 || height <= 0 || width > 10000 || height > 10000) {
						break;
					}

					images.push({
						name,
						width,
						height,
						size: width * height * 2,
						offset
					});

					pos += METADATA_ENTRY_SIZE;
				}

				self.postMessage({ type: 'success', id, result: images });
				break;
			}

			case 'extractPlane': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const { planeName, start, end } = e.data as WorkerRequest & {
					planeName: string;
					start: number;
					end: number;
				};

				self.postMessage({ type: 'progress', id, message: `Extracting plane: ${planeName}...` });

				const fonts: PlaneData['fonts'] = [];

				// Extract SMALL fonts
				for (let uni = start; uni <= Math.min(end, 0xFFFF); uni++) {
					const addr = SMALL_BASE + uni * SMALL_STRIDE;
					if (addr + SMALL_STRIDE > firmwareData.length) continue;

					const chunk = firmwareData.slice(addr, addr + SMALL_STRIDE);
					if (chunk.every((b) => b === chunk[0])) continue;

					try {
						const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
						const pixels = decodeV8(chunk, lookupVal);
						if (pixels.length === 16 && isValidFontData(pixels, 'SMALL')) {
							fonts.push({ unicode: uni, fontType: 'SMALL', pixels });
						}
					} catch {
						continue;
					}
				}

				// Extract LARGE fonts for CJK range
				if (start >= 0x4e00) {
					for (let uni = start; uni <= end; uni++) {
						const addr = LARGE_BASE + (uni - 0x4e00) * LARGE_STRIDE;
						if (addr + LARGE_STRIDE > firmwareData.length) continue;

						const chunk = firmwareData.slice(addr, addr + LARGE_STRIDE);
						if (chunk.every((b) => b === chunk[0])) continue;

						try {
							const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
							const pixels = decodeV8(chunk, lookupVal);
							if (pixels.length === 16 && isValidFontData(pixels, 'LARGE')) {
								fonts.push({ unicode: uni, fontType: 'LARGE', pixels });
							}
						} catch {
							continue;
						}
					}
				}

				self.postMessage({
					type: 'success',
					id,
					result: { name: planeName, start, end, fonts } as PlaneData
				});
				break;
			}

			case 'extractImage': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const { imageName, width, height, offset } = e.data as WorkerRequest & {
					imageName: string;
					width: number;
					height: number;
					offset: number;
				};

				const rawSize = width * height * 2;
				const rgb565Data = firmwareData.slice(offset, offset + rawSize);

				self.postMessage({
					type: 'success',
					id,
					result: {
						name: imageName,
						width,
						height,
						rgb565Data
					} as ImageData
				});
				break;
			}

			default:
				self.postMessage({ type: 'error', id, error: `Unknown request type: ${type}` });
		}
	} catch (err) {
		self.postMessage({
			type: 'error',
			id,
			error: err instanceof Error ? err.message : String(err)
		});
	}
};

export {};
