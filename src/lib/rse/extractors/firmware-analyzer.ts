/**
 * Firmware Analyzer - Heuristic address detection
 * Detects font data addresses in firmware images
 */

import { BinaryReader } from '../utils/struct.js';
import type { FirmwarePartition, FirmwareAddresses, AddressConfidence } from '../types/index.js';
import { fileIO, type FileInput } from '../utils/file-io.js';

// Constants
const LARGE_STRIDE = 33;
const SMALL_STRIDE = 32;
const FOOTER_SIGNATURES = new Set([0x90, 0x8f, 0x89, 0x8b, 0x8d, 0x8e, 0x8c]);
const ROCK26_SIGNATURE = new TextEncoder().encode('ROCK26IMAGERES');
const INVALID_VALUES = new Set([0x00, 0xff]);

/**
 * Firmware analyzer class
 */
export class FirmwareAnalyzer {
	private readonly reader: BinaryReader;
	private readonly firmware: Uint8Array;

	constructor(firmwarePathOrData: FileInput | Uint8Array) {
		if (firmwarePathOrData instanceof Uint8Array) {
			this.firmware = firmwarePathOrData;
		} else {
			this.firmware = fileIO.readFileSync(firmwarePathOrData);
		}
		this.reader = new BinaryReader(this.firmware);
	}

	/**
	 * Read partition information
	 * @returns Partition info for part_2_firmware_b
	 */
	getFirmwarePartition(): FirmwarePartition {
		// Partition table at 0x80 (part_2_firmware_b)
		const chunk = this.reader.slice(0x80, 0x90);
		const offset = chunk.readU32LE(0);
		const size = chunk.readU32LE(4);
		return { offset, size };
	}

	/**
	 * Detect SMALL_BASE (reliable method)
	 * @returns Small font base address
	 */
	detectSmallBase(): number {
		const config_78 = this.reader.readU16LE(0x78);
		const config_7a = this.reader.readU16LE(0x7a);
		return (config_7a << 16) | config_78;
	}

	/**
	 * Score a window for font data detection
	 * @param windowStart - Window start address
	 * @param windowEnd - Window end address
	 * @param baseAlignment - Optional alignment constraint
	 * @returns Score and first address
	 */
	private scoreWindow(
		windowStart: number,
		windowEnd: number,
		baseAlignment: number | null
	): { score: number; firstAddr: number } {
		let maxSequenceLength = 0;
		let maxSequenceStart = windowStart;
		let currentLength = 0;
		let currentStart = windowStart;
		let consecutiveAnomalies = 0;
		const maxAnomalies = 5;

		for (let offset = 0; offset < windowEnd - windowStart; offset += LARGE_STRIDE) {
			const addr = windowStart + offset;

			if (addr + 32 >= this.firmware.length) break;

			if (baseAlignment !== null && addr % LARGE_STRIDE !== baseAlignment) {
				continue;
			}

			const byte_32 = this.firmware[addr + 32];

			if (INVALID_VALUES.has(byte_32)) {
				if (currentLength > maxSequenceLength) {
					maxSequenceLength = currentLength;
					maxSequenceStart = currentStart;
				}
				currentLength = 0;
				consecutiveAnomalies = 0;
			} else if (FOOTER_SIGNATURES.has(byte_32)) {
				if (currentLength === 0) currentStart = addr;
				currentLength++;
				consecutiveAnomalies = 0;
			} else {
				consecutiveAnomalies++;
				if (consecutiveAnomalies <= maxAnomalies) {
					if (currentLength === 0) currentStart = addr;
					currentLength++;
				} else {
					if (currentLength > maxSequenceLength) {
						maxSequenceLength = currentLength;
						maxSequenceStart = currentStart;
					}
					currentLength = 0;
					consecutiveAnomalies = 0;
				}
			}
		}

		if (currentLength > maxSequenceLength) {
			maxSequenceLength = currentLength;
			maxSequenceStart = currentStart;
		}

		return { score: maxSequenceLength, firstAddr: maxSequenceStart };
	}

	/**
	 * Search for large font offset table using window scanning
	 * @returns Detected LARGE_BASE address
	 */
	searchOffsetTable(): number | null {
		const partition = this.getFirmwarePartition();
		const searchStart = partition.offset;
		const searchEnd = partition.offset + partition.size;

		console.log(`  Searching for LARGE_BASE (window spacing score method)...`);
		console.log(`  Partition: part_2_firmware_b (0x${searchStart.toString(16).padStart(8, '0')} - 0x${searchEnd.toString(16).padStart(8, '0')})`);
		console.log(`  Signatures: ${[...FOOTER_SIGNATURES].sort((a, b) => a - b).join(', ')}`);

		const windowSize = 20902 * LARGE_STRIDE;
		let currentStride = Math.floor(windowSize / 2);
		const minStride = 100;

		let currentRegions: Array<{ start: number; end: number }> = [
			{ start: searchStart, end: searchEnd }
		];
		let iteration = 0;
		let bestAddr: number | null = null;
		let bestScore = -1;
		let baseAlignment: number | null = null;

		while (currentStride > minStride && currentRegions.length > 0) {
			iteration++;
			console.log(`\n  Round ${iteration} (stride: ${currentStride} bytes)...`);

			if (baseAlignment !== null) {
				console.log(`    Using grid alignment: addr % 33 = ${baseAlignment}`);
			}

			const regionResults: Array<{ windowStart: number; score: number; firstAddr: number }> =
				[];

			for (const region of currentRegions) {
				for (let windowStart = region.start; windowStart < region.end; windowStart += currentStride) {
					const windowEnd = Math.min(windowStart + windowSize, this.firmware.length);
					const { score, firstAddr } = this.scoreWindow(
						windowStart,
						windowEnd,
						baseAlignment
					);

					if (score > bestScore) {
						bestScore = score;
						bestAddr = firstAddr;
					}

					regionResults.push({ windowStart, score, firstAddr });
				}
			}

			regionResults.sort((a, b) => b.score - a.score);
			const topWindows = regionResults.slice(0, 5);

			console.log(`    Found ${regionResults.length} windows, keeping top 5`);
			for (let i = 0; i < Math.min(3, topWindows.length); i++) {
				const win = topWindows[i];
				console.log(
					`    [${i}] window:0x${win.windowStart.toString(16).padStart(6, '0')}, first:0x${win.firstAddr.toString(16).padStart(6, '0')}, score:${win.score}`
				);
			}

			if (baseAlignment === null && topWindows.length > 0) {
				const bestFirstAddr = topWindows[0].firstAddr;
				baseAlignment = bestFirstAddr % LARGE_STRIDE;
				console.log(
					`    Determined grid alignment: 0x${bestFirstAddr.toString(16).padStart(6, '0')} % ${LARGE_STRIDE} = ${baseAlignment}`
				);
			}

			const nextStride = Math.max(minStride, Math.floor(currentStride / 2));
			currentRegions = [];

			for (const win of topWindows) {
				const firstAddr = win.firstAddr;
				const charsExtend = Math.floor(currentStride / LARGE_STRIDE) + 1;

				let regionStart = firstAddr - charsExtend * LARGE_STRIDE;
				let regionEnd = firstAddr + charsExtend * LARGE_STRIDE;

				regionStart = Math.max(searchStart, regionStart);
				regionEnd = Math.min(searchEnd, regionEnd);

				currentRegions.push({ start: regionStart, end: regionEnd });
			}

			currentStride = nextStride;
		}

		if (bestAddr !== null) {
			console.log(`\n  Best candidate: 0x${bestAddr.toString(16).padStart(8, '0')}`);
			console.log(`  Score: ${bestScore}`);
		}

		return bestAddr;
	}

	/**
	 * Quick footer check
	 * @param largeBase - Base address to check
	 * @param preferredFooter - Preferred footer value (default 0x90)
	 * @returns True if likely valid
	 */
	private quickFooterCheck(largeBase: number, preferredFooter = 0x90): boolean {
		let matchCount = 0;

		for (let i = 0; i < 3; i++) {
			const addr = largeBase + i * LARGE_STRIDE;

			if (addr + LARGE_STRIDE > this.firmware.length) {
				return false;
			}

			const byte_32 = this.firmware[addr + 32];

			if (byte_32 === preferredFooter) {
				matchCount++;
			} else if (byte_32 !== 0x8f) {
				return false;
			}
		}

		return matchCount >= 2;
	}

	/**
	 * Validate detected addresses
	 * @param addresses - Detected addresses
	 * @returns Confidence metrics
	 */
	private validateAddresses(addresses: Omit<FirmwareAddresses, 'confidence'>): AddressConfidence {
		const confidence: AddressConfidence = {
			smallFontValid: 0,
			largeFontValid: 0,
			movw0042Count: 0
		};

		// Validate SMALL font
		for (const charCode of [0x0041, 0x0042, 0x0043]) {
			// 'A', 'B', 'C'
			const addr = addresses.SMALL_BASE + charCode * SMALL_STRIDE;
			if (addr + SMALL_STRIDE <= this.firmware.length) {
				const chunk = this.firmware.slice(addr, addr + SMALL_STRIDE);
				if (!this.isDataEmpty(chunk)) {
					confidence.smallFontValid++;
				}
			}
		}

		// Validate LARGE font
		for (const charCode of [0x4e00, 0x4e01, 0x4e02]) {
			const addr = addresses.LARGE_BASE + (charCode - 0x4e00) * LARGE_STRIDE;
			if (addr + LARGE_STRIDE <= this.firmware.length) {
				const chunk = this.firmware.slice(addr, addr + LARGE_STRIDE);
				if (!this.isDataEmpty(chunk)) {
					confidence.largeFontValid++;
				}
			}
		}

		// Search for MOVW #0x0042 instructions
		let movwCount = 0;
		for (let i = 0; i < this.firmware.length - 6; i++) {
			if (
				this.firmware[i] === 0xf2 &&
				this.firmware[i + 1] === 0x40 &&
				this.firmware[i + 4] === 0x42
			) {
				movwCount++;
			}
		}
		confidence.movw0042Count = movwCount;

		return confidence;
	}

	/**
	 * Check if data is all zeros or all 0xFF
	 */
	private isDataEmpty(data: Uint8Array): boolean {
		if (data.length === 0) return true;
		const first = data[0];
		return data.every((b) => b === first);
	}

	/**
	 * Detect all key addresses
	 * @returns Detected addresses or null if failed
	 */
	detectAddresses(): FirmwareAddresses | null {
		const results: Omit<FirmwareAddresses, 'confidence'> = {
			SMALL_BASE: this.detectSmallBase(),
			LARGE_BASE: 0,
			LOOKUP_TABLE: 0x080000
		};

		// Detect LARGE_BASE
		const largeBase = this.searchOffsetTable();

		if (largeBase === null) {
			console.error('Error: Could not find valid LARGE_BASE');
			return null;
		}

		results.LARGE_BASE = largeBase;

		// Validate
		const confidence = this.validateAddresses(results);

		return {
			...results,
			confidence
		};
	}

	/**
	 * Get raw firmware data
	 */
	getData(): Uint8Array {
		return this.firmware;
	}

	/**
	 * Get the binary reader
	 */
	getReader(): BinaryReader {
		return this.reader;
	}
}
