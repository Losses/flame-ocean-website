/**
 * Resource Extractor - Smart bitmap extraction with offset misalignment detection
 */

import type {
	BitmapMetadata,
	MisalignmentDetection,
	DetectionInfo,
	DetectionCheck,
	BitmapExtractionResult,
	BitmapFileInfo
} from '../types/index.js';
import { BinaryReader, findBytes } from '../utils/struct.js';
import { convertToBmp, bmpToRgb565 } from '../utils/bitmap.js';
import { sanitizeFilename } from '../utils/bytes.js';
import { validateBitmapData } from '../utils/font-encoder.js';
import { fileIO, type FileInput } from '../utils/file-io.js';

// Constants
const METADATA_ENTRY_SIZE = 108;
const ROCK26_ENTRY_SIZE = 16;
const ROCK26_SIGNATURE = new TextEncoder().encode('ROCK26IMAGERES');

/**
 * Offset misalignment detection result
 */
export interface MisalignmentResult {
	readonly misalignment: number;
	readonly firstValidEntry: number;
	readonly detectionInfo: DetectionInfo;
}

/**
 * Metadata table location
 */
interface MetadataTableLocation {
	readonly offset: number;
	readonly method: string;
}

/**
 * Resource extractor class
 */
export class ResourceExtractor {
	private readonly reader: BinaryReader;
	private readonly firmware: Uint8Array;
	private readonly firmwarePath: string;

	constructor(firmwarePathOrData: FileInput | Uint8Array, firmwarePath?: string) {
		if (firmwarePathOrData instanceof Uint8Array) {
			this.firmware = firmwarePathOrData;
			this.firmwarePath = firmwarePath ?? 'unknown';
		} else {
			this.firmware = fileIO.readFileSync(firmwarePathOrData);
			this.firmwarePath = typeof firmwarePathOrData === 'string' ? firmwarePathOrData : 'unknown';
		}
		this.reader = new BinaryReader(this.firmware);
	}

	/**
	 * Find metadata table using ROCK26 anchor method
	 * @returns Table offset or null if not found
	 */
	private findMetadataTableByRock26Anchor(): number | null {
		const rock26Offset = this.reader.find(ROCK26_SIGNATURE);
		if (rock26Offset === -1) {
			return null;
		}

		const rock26EntriesStart = rock26Offset + 32;

		// Read ROCK26 Entry 0 offset as anchor
		const anchorOffset = this.reader.readU32LE(rock26EntriesStart + 12);

		// Search for this offset value in Part 5
		const matchingPositions: number[] = [];

		for (let pos = 0; pos < this.firmware.length - METADATA_ENTRY_SIZE; pos += 4) {
			try {
				const entryOffset = this.reader.readU32LE(pos + 20);

				if (entryOffset === anchorOffset) {
					// Verify it's a valid metadata entry
					const nameBytes = this.firmware.slice(pos + 32, pos + 96);
					const nullIdx = nameBytes.indexOf(0);
					const name =
						nullIdx >= 0
							? new TextDecoder('ascii').decode(nameBytes.slice(0, nullIdx))
							: new TextDecoder('ascii', { fatal: false }).decode(nameBytes);

					if (name.endsWith('.BMP') && name.length >= 3) {
						matchingPositions.push(pos);
					}
				}
			} catch {
				continue;
			}
		}

		if (matchingPositions.length === 0) {
			return null;
		}

		// Find the earliest valid entry by scanning backwards
		const firstMatch = Math.min(...matchingPositions);
		let tableStart = firstMatch;

		while (tableStart >= METADATA_ENTRY_SIZE) {
			const testPos = tableStart - METADATA_ENTRY_SIZE;
			const testEntry = this.firmware.slice(testPos, testPos + METADATA_ENTRY_SIZE);
			const nameBytes = testEntry.slice(32, 96);
			const nullIdx = nameBytes.indexOf(0);
			const testName =
				nullIdx >= 0
					? new TextDecoder('ascii').decode(nameBytes.slice(0, nullIdx))
					: new TextDecoder('ascii', { fatal: false }).decode(nameBytes);

			if (
				testName &&
				testName.endsWith('.BMP') &&
				testName.length >= 3 &&
				this.isPrintable(testName)
			) {
				tableStart = testPos;
			} else {
				break;
			}
		}

		return tableStart;
	}

	/**
	 * Check if string contains only printable characters
	 */
	private isPrintable(str: string): boolean {
		for (const c of str) {
			const code = c.charCodeAt(0);
			if (
				!(
					(code >= 32 && code <= 126) ||
					"._-(), ".includes(c) ||
					(code >= 0xa0 && code <= 0xff)
				)
			) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Find metadata table in Part 5
	 * @returns Table offset or null if not found
	 */
	findMetadataTableInPart5(): number | null {
		return this.findMetadataTableByRock26Anchor();
	}

	/**
	 * Parse metadata table from Part 5
	 * @param tableStart - Starting offset of the table
	 * @returns Array of metadata entries
	 */
	parseMetadataTable(tableStart: number): BitmapMetadata[] {
		const entries: BitmapMetadata[] = [];
		let pos = tableStart;

		while (pos + METADATA_ENTRY_SIZE <= this.firmware.length) {
			const entry = this.firmware.slice(pos, pos + METADATA_ENTRY_SIZE);

			const nameBytes = entry.slice(32, 96);
			const nullIdx = nameBytes.indexOf(0);
			const name =
				nullIdx >= 0
					? new TextDecoder('ascii', { fatal: false }).decode(nameBytes.slice(0, nullIdx))
					: '';

			if (!name || name.length < 3) {
				break;
			}

			const offset = this.reader.readU32LE(pos + 20);
			const width = this.reader.readU32LE(pos + 24);
			const height = this.reader.readU32LE(pos + 28);

			entries.push({
				index: entries.length,
				offset,
				width,
				height,
				name
			});

			pos += METADATA_ENTRY_SIZE;
		}

		return entries;
	}

	/**
	 * Detect offset misalignment using statistical analysis
	 * @param metadataEntries - Parsed metadata entries
	 * @param rock26Offset - Offset of ROCK26 table
	 * @returns Misalignment detection result
	 */
	detectOffsetMisalignment(
		metadataEntries: readonly BitmapMetadata[],
		rock26Offset: number
	): MisalignmentDetection {
		// Read ROCK26 table info
		const rock26Count = this.reader.readU32LE(rock26Offset + 16);

		// Read first N ROCK26 entry offsets
		const rock26Offsets: number[] = [];
		const rock26EntriesStart = rock26Offset + 32;

		const sampleCount = Math.min(20, rock26Count);
		for (let i = 0; i < sampleCount; i++) {
			const entryOffset = rock26EntriesStart + i * ROCK26_ENTRY_SIZE;
			const offset = this.reader.readU32LE(entryOffset + 12);
			rock26Offsets.push(offset);
		}

		const checks: DetectionCheck[] = [];

		// Statistical analysis: test different index shifts
		const offsetShiftVotes = new Map<number, number>();

		for (let rock26Idx = 0; rock26Idx < Math.min(20, rock26Offsets.length); rock26Idx++) {
			const rock26OffsetVal = rock26Offsets[rock26Idx];

			for (let shift = -3; shift <= 3; shift++) {
				const metadataIdx = rock26Idx + shift;

				if (metadataIdx >= 0 && metadataIdx < metadataEntries.length) {
					const metadataOffsetVal = metadataEntries[metadataIdx].offset;

					if (metadataOffsetVal === rock26OffsetVal) {
						offsetShiftVotes.set(shift, (offsetShiftVotes.get(shift) ?? 0) + 1);
					}
				}
			}
		}

		checks.push({
			name: 'ROCK26-Metadata correspondence statistics',
			result: Object.fromEntries(offsetShiftVotes)
		});

		let misalignment = 0;
		let firstValidEntry = 0;
		let conclusion = '';

		if (offsetShiftVotes.size > 0) {
			// Find shift with most votes
			let bestShift = 0;
			let confidence = 0;
			for (const [shift, votes] of offsetShiftVotes.entries()) {
				if (votes > confidence) {
					confidence = votes;
					bestShift = shift;
				}
			}

			checks.push({
				name: 'Statistical result',
				result: { bestShift, confidence, totalVotes: Array.from(offsetShiftVotes.values()).reduce((a, b) => a + b, 0) }
			});

			// Check Entry 0 status
			const entry0 = metadataEntries[0];
			const isEntry0Corrupted =
				entry0.offset === 0 ||
				entry0.offset >= this.firmware.length ||
				entry0.offset === 0xf564f564 ||
				entry0.offset === 0xb7b5d7b5 ||
				entry0.offset === 0x00000000 ||
				entry0.offset === 0xc308c308 ||
				entry0.offset === 0x45294529;

			checks.push({
				name: 'Entry 0 corruption detection',
				result: { corrupted: isEntry0Corrupted, offset: `0x${entry0.offset.toString(16)}` }
			});

			if (bestShift === 1) {
				misalignment = 1;
				firstValidEntry = 1;
				conclusion = `Detected +1 index misalignment (statistical confidence: ${confidence}/${Math.min(20, rock26Offsets.length)} samples match)`;
			} else if (bestShift === 0) {
				misalignment = 0;
				firstValidEntry = 0;
				conclusion = `No misalignment detected (statistical confidence: ${confidence}/${Math.min(20, rock26Offsets.length)} samples match)`;
			} else {
				misalignment = bestShift;
				firstValidEntry = Math.max(1, 1 - bestShift);
				conclusion = `Detected ${misalignment >= 0 ? '+' : ''}${misalignment} index misalignment (statistical confidence: ${confidence}/${Math.min(20, rock26Offsets.length)} samples match)`;
			}
		} else {
			// Fallback to single-point detection
			conclusion = 'Statistical analysis failed, falling back to single-point detection';

			if (rock26Offsets.length > 0) {
				let firstMatchIndex: number | null = null;
				for (let i = 0; i < metadataEntries.length; i++) {
					if (metadataEntries[i].offset === rock26Offsets[0]) {
						firstMatchIndex = i;
						break;
					}
				}

				if (firstMatchIndex !== null) {
					misalignment = firstMatchIndex - 1;
					firstValidEntry = 1;
					conclusion = `Fallback detection result: ${misalignment >= 0 ? '+' : ''}${misalignment} misalignment`;
				}
			}
		}

		const detectionInfo: DetectionInfo = {
			rock26Count,
			rock26SampleOffsets: rock26Offsets.slice(0, 5),
			metadataCount: metadataEntries.length,
			checks,
			conclusion
		};

		return {
			misalignment,
			firstValidEntry,
			detectionInfo
		};
	}

	/**
	 * Extract Part 5 bitmaps with smart misalignment detection
	 * @param outputDir - Output directory
	 * @param version - Firmware version string
	 * @param debug - Enable debug output
	 * @returns Extraction result
	 */
	extractPart5BitmapsSmart(
		outputDir: string,
		version: string,
		debug = false
	): BitmapExtractionResult | null {
		console.log(`\n${'='.repeat(80)}`);
		console.log(`Processing firmware: ${version} - ${this.firmwarePath}`);
		console.log(`${'='.repeat(80)}`);

		// Extract Part 5
		const part5Info = [
			this.reader.readU32LE(0x14c),
			this.reader.readU32LE(0x150),
			this.reader.readU32LE(0x154),
			this.reader.readU32LE(0x158)
		];
		const [part5Offset, part5Size] = part5Info;
		const part5Data = this.firmware.slice(part5Offset, part5Offset + part5Size);

		console.log(`  Part 5 offset: 0x${part5Offset.toString(16).padStart(8, '0')}`);
		console.log(`  Part 5 size: ${part5Data.length.toLocaleString()} bytes`);

		// Find ROCK26 table
		const rock26Offset = findBytes(part5Data, ROCK26_SIGNATURE);
		if (rock26Offset === -1) {
			console.log(`  ROCK26 table not found`);
			return null;
		}

		console.log(`  ROCK26 table at: 0x${rock26Offset.toString(16).toUpperCase()}`);

		// Find metadata table
		const tableStart = this.findMetadataTableInPart5();
		if (tableStart === null) {
			console.log(`  Metadata table not found`);
			return null;
		}

		console.log(`  Metadata table at: 0x${tableStart.toString(16).toUpperCase()}`);

		// Parse metadata table
		const metadataEntries = this.parseMetadataTable(tableStart);
		console.log(`  Parsed ${metadataEntries.length} metadata entries`);

		// Detect misalignment
		console.log(`\n  Detecting offset misalignment...`);
		const { misalignment, firstValidEntry, detectionInfo } = this.detectOffsetMisalignment(
			metadataEntries,
			rock26Offset
		);

		console.log(`  Detection result:`);
		console.log(`    ${detectionInfo.conclusion}`);
		console.log(`    Misalignment: ${misalignment >= 0 ? '+' : ''}${misalignment}`);
		console.log(`    First valid entry: ${firstValidEntry}`);

		if (debug) {
			console.log(`\n  Detection details:`);
			for (const check of detectionInfo.checks) {
				console.log(`    - ${check.name}: ${JSON.stringify(check.result)}`);
			}
		}

		// Create output directory
		const fullOutputDir = `${outputDir}/${version}`;
		this.ensureDir(fullOutputDir);

		// Extract bitmaps
		let successCount = 0;
		let errorCount = 0;

		console.log(`\n  Extracting bitmaps...`);
		console.log(`  ${'ID'.padStart(4)} ${'Name'.padEnd(30)} ${'Size'.padStart(10)} ${'Status'.padEnd(10)}`);
		console.log('-'.repeat(70));

		const startIndex = firstValidEntry;
		const endIndex = metadataEntries.length - (misalignment > 0 ? 1 : 0);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = metadataEntries[i];
			const resourceId = entry.index;

			// Adjust offset based on misalignment
			let offset: number;
			if (misalignment > 0) {
				const targetIndex = i + misalignment;
				if (targetIndex >= metadataEntries.length) continue;
				offset = metadataEntries[targetIndex].offset;
			} else if (misalignment < 0) {
				const targetIndex = i + misalignment;
				if (targetIndex < 0) continue;
				offset = metadataEntries[targetIndex].offset;
			} else {
				offset = entry.offset;
			}

			const name = entry.name;

			// Get width/height from next entry
			let width: number;
			let height: number;
			if (i + 1 < metadataEntries.length) {
				width = metadataEntries[i + 1].width;
				height = metadataEntries[i + 1].height;
			} else {
				width = entry.width;
				height = entry.height;
			}

			// Skip invalid entries
			if (
				offset === 0 ||
				offset >= part5Data.length ||
				width <= 0 ||
				height <= 0 ||
				width > 10000 ||
				height > 10000
			) {
				continue;
			}

			// Read and convert bitmap data
			const rawSize = width * height * 2;
			const rawData = part5Data.slice(offset, offset + rawSize);
			const bmpData = convertToBmp(rawData, width, height);

			if (bmpData !== null) {
				const safeName = sanitizeFilename(name);
				const finalName = safeName.toLowerCase().endsWith('.bmp') ? safeName : `${safeName}.bmp`;
				const outputPath = `${fullOutputDir}/${finalName}`;

				this.writeFile(outputPath, bmpData);

				successCount++;

				if (i < 12 || i % 200 === 0) {
					const whSource =
						i + 1 < metadataEntries.length ? `Entry[${i + 1}]` : `Entry[${i}]`;
					console.log(
						`  ${resourceId.toString().padStart(4)} ${name.padEnd(30)} ${width}x${height.toString().padStart(5)} (${whSource})   ✓`
					);
				}
			} else {
				errorCount++;
			}
		}

		console.log('-'.repeat(70));
		console.log(`  Complete: success=${successCount}, errors=${errorCount}`);

		return {
			version,
			total: endIndex - startIndex,
			success: successCount,
			error: errorCount,
			misalignment,
			detectionInfo
		};
	}

	/**
	 * Ensure directory exists (Node.js only)
	 */
	/**
	 * Ensure directory exists
	 */
	private ensureDir(path: string): void {
		fileIO.mkdirSync(path);
	}

	/**
	 * Write file
	 */
	private writeFile(path: string, data: Uint8Array): void {
		fileIO.writeFileSync(path, data);
	}

	/**
	 * List all bitmaps in the directory with file info (name, dimensions, size)
	 * @returns Array of bitmap file information
	 */
	listDirectory(): BitmapFileInfo[] {
		// Find metadata table
		const tableStart = this.findMetadataTableInPart5();
		if (tableStart === null) {
			return [];
		}

		// Parse metadata table
		const metadataEntries = this.parseMetadataTable(tableStart);

		// Find ROCK26 table for misalignment detection
		const rock26Offset = this.reader.find(ROCK26_SIGNATURE);
		if (rock26Offset === -1) {
			return [];
		}

		// Detect misalignment
		const { misalignment, firstValidEntry } = this.detectOffsetMisalignment(
			metadataEntries,
			rock26Offset
		);

		const files: BitmapFileInfo[] = [];
		const startIndex = firstValidEntry;
		const endIndex = metadataEntries.length - (misalignment > 0 ? 1 : 0);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = metadataEntries[i];

			// Adjust offset based on misalignment
			let offset: number;
			if (misalignment > 0) {
				const targetIndex = i + misalignment;
				if (targetIndex >= metadataEntries.length) continue;
				offset = metadataEntries[targetIndex].offset;
			} else if (misalignment < 0) {
				const targetIndex = i + misalignment;
				if (targetIndex < 0) continue;
				offset = metadataEntries[targetIndex].offset;
			} else {
				offset = entry.offset;
			}

			const name = entry.name;

			// Get width/height from next entry
			let width: number;
			let height: number;
			if (i + 1 < metadataEntries.length) {
				width = metadataEntries[i + 1].width;
				height = metadataEntries[i + 1].height;
			} else {
				width = entry.width;
				height = entry.height;
			}

			// Calculate size (RGB565 = 2 bytes per pixel)
			const size = width * height * 2;

			// Skip invalid entries
			if (
				offset === 0 ||
				width <= 0 ||
				height <= 0 ||
				width > 10000 ||
				height > 10000
			) {
				continue;
			}

			files.push({
				name,
				width,
				height,
				size
			});
		}

		return files;
	}

	/**
	 * Read raw bitmap data (RGB565 format) for a bitmap file
	 * @param filename - Bitmap filename (e.g., "POWERON1.BMP")
	 * @returns Raw RGB565 bitmap data or null if not found
	 */
	readBitmap(filename: string): Uint8Array | null {
		// Find metadata table
		const tableStart = this.findMetadataTableInPart5();
		if (tableStart === null) {
			return null;
		}

		// Parse metadata table
		const metadataEntries = this.parseMetadataTable(tableStart);

		// Find ROCK26 table for misalignment detection
		const rock26Offset = this.reader.find(ROCK26_SIGNATURE);
		if (rock26Offset === -1) {
			return null;
		}

		// Detect misalignment
		const { misalignment, firstValidEntry } = this.detectOffsetMisalignment(
			metadataEntries,
			rock26Offset
		);

		// Find the entry by filename
		const targetIndex = metadataEntries.findIndex((e) => e.name === filename);
		if (targetIndex === -1) {
			return null;
		}

		// Check if index is in valid range
		const startIndex = firstValidEntry;
		const endIndex = metadataEntries.length - (misalignment > 0 ? 1 : 0);

		if (targetIndex < startIndex || targetIndex >= endIndex) {
			return null;
		}

		// Get the actual offset (considering misalignment)
		let offset: number;
		if (misalignment > 0) {
			const targetIndexAdjusted = targetIndex + misalignment;
			if (targetIndexAdjusted >= metadataEntries.length) return null;
			offset = metadataEntries[targetIndexAdjusted].offset;
		} else if (misalignment < 0) {
			const targetIndexAdjusted = targetIndex + misalignment;
			if (targetIndexAdjusted < 0) return null;
			offset = metadataEntries[targetIndexAdjusted].offset;
		} else {
			offset = metadataEntries[targetIndex].offset;
		}

		// Get width/height from next entry
		let width: number;
		let height: number;
		if (targetIndex + 1 < metadataEntries.length) {
			width = metadataEntries[targetIndex + 1].width;
			height = metadataEntries[targetIndex + 1].height;
		} else {
			width = metadataEntries[targetIndex].width;
			height = metadataEntries[targetIndex].height;
		}

		// Validate dimensions
		if (
			offset === 0 ||
			offset >= this.firmware.length ||
			width <= 0 ||
			height <= 0 ||
			width > 10000 ||
			height > 10000
		) {
			return null;
		}

		// Get Part 5 data
		const part5Offset = this.reader.readU32LE(0x14c);
		const part5Size = this.reader.readU32LE(0x150);
		const part5Data = this.firmware.slice(part5Offset, part5Offset + part5Size);

		// Calculate size and read data
		const rawSize = width * height * 2;
		if (offset + rawSize > part5Data.length) {
			return null;
		}

		return part5Data.slice(offset, offset + rawSize);
	}

	/**
	 * Replace bitmap data for a bitmap file
	 * @param filename - Bitmap filename (e.g., "POWERON1.BMP")
	 * @param data - Raw RGB565 bitmap data
	 * @returns True if successful, false otherwise
	 */
	replaceBitmap(filename: string, data: Uint8Array): boolean {
		// Find metadata table
		const tableStart = this.findMetadataTableInPart5();
		if (tableStart === null) {
			return false;
		}

		// Parse metadata table
		const metadataEntries = this.parseMetadataTable(tableStart);

		// Find ROCK26 table for misalignment detection
		const rock26Offset = this.reader.find(ROCK26_SIGNATURE);
		if (rock26Offset === -1) {
			return false;
		}

		// Detect misalignment
		const { misalignment, firstValidEntry } = this.detectOffsetMisalignment(
			metadataEntries,
			rock26Offset
		);

		// Find the entry by filename
		const targetIndex = metadataEntries.findIndex((e) => e.name === filename);
		if (targetIndex === -1) {
			return false;
		}

		// Check if index is in valid range
		const startIndex = firstValidEntry;
		const endIndex = metadataEntries.length - (misalignment > 0 ? 1 : 0);

		if (targetIndex < startIndex || targetIndex >= endIndex) {
			return false;
		}

		// Get the actual offset (considering misalignment)
		let metadataOffset: number;
		if (misalignment > 0) {
			const targetIndexAdjusted = targetIndex + misalignment;
			if (targetIndexAdjusted >= metadataEntries.length) return false;
			metadataOffset = metadataEntries[targetIndexAdjusted].offset;
		} else if (misalignment < 0) {
			const targetIndexAdjusted = targetIndex + misalignment;
			if (targetIndexAdjusted < 0) return false;
			metadataOffset = metadataEntries[targetIndexAdjusted].offset;
		} else {
			metadataOffset = metadataEntries[targetIndex].offset;
		}

		// Get width/height from next entry
		let width: number;
		let height: number;
		if (targetIndex + 1 < metadataEntries.length) {
			width = metadataEntries[targetIndex + 1].width;
			height = metadataEntries[targetIndex + 1].height;
		} else {
			width = metadataEntries[targetIndex].width;
			height = metadataEntries[targetIndex].height;
		}

		// Validate data
		if (!validateBitmapData(data, width, height)) {
			return false;
		}

		// Get Part 5 data
		const part5Offset = this.reader.readU32LE(0x14c);
		const part5Size = this.reader.readU32LE(0x150);

		// Validate offset is within Part 5
		if (metadataOffset >= part5Size) {
			return false;
		}

		// Calculate actual offset in firmware
		const actualOffset = part5Offset + metadataOffset;
		const rawSize = width * height * 2;

		// Validate bounds
		if (actualOffset + rawSize > this.firmware.length) {
			return false;
		}

		// Write data to firmware (mutates the original array)
		this.firmware.set(data, actualOffset);
		return true;
	}

	/**
	 * Replace bitmap data from BMP file
	 * @param filename - Bitmap filename (e.g., "POWERON1.BMP")
	 * @param bmpData - BMP file data (RGB565 format)
	 * @returns True if successful, false otherwise
	 */
	replaceBitmapFromBmp(filename: string, bmpData: Uint8Array): boolean {
		// Convert BMP to RGB565
		const rawData = bmpToRgb565(bmpData);
		if (!rawData) {
			return false;
		}

		return this.replaceBitmap(filename, rawData);
	}

	/**
	 * Get firmware data with modifications
	 * @returns Modified firmware data
	 */
	getFirmwareData(): Uint8Array {
		return this.firmware;
	}
}
