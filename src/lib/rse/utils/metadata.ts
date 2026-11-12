/**
 * Shared metadata extraction utilities
 * Used by both ResourceExtractor and firmware-worker
 *
 * IMPORTANT: Bootloader Field Reorganization
 * ===========================================
 * Flash metadata stores width/height fields in Entry[i+1], not Entry[i].
 * This is NOT corruption - it's the Bootloader's runtime construction pattern:
 *   Flash Entry[i+1].width  → runtime descriptor[i].width
 *   Flash Entry[i+1].height → runtime descriptor[i].height
 */

import type { BitmapFileInfo } from '../types/index.js';
import { readU32LE, findBytes } from './struct.js';

// Constants
export const METADATA_ENTRY_SIZE = 108;
export const ROCK26_ENTRY_SIZE = 16;
export const ROCK26_SIGNATURE = new TextEncoder().encode('ROCK26IMAGERES');

export interface MetadataEntry {
	name: string;
	offset: number;
	width: number;
	height: number;
}

export interface MisalignmentDetection {
	misalignment: number;
	firstValidEntry: number;
	detectionInfo: {
		rock26Count: number;
		rock26SampleOffsets: number[];
		metadataCount: number;
		conclusion: string;
	};
}

/**
 * Decode ASCII string from bytes, ignoring non-ASCII bytes
 * Matches Python's decode('ascii', errors='ignore') behavior
 */
export function decodeASCII(nameBytes: Uint8Array): string {
	const validBytes = nameBytes.filter(b => b < 128);
	return String.fromCharCode(...validBytes);
}

/**
 * Decode ASCII string from null-terminated bytes
 */
export function decodeNullTerminatedASCII(nameBytes: Uint8Array): string {
	const nullIdx = nameBytes.indexOf(0);
	if (nullIdx >= 0) {
		return decodeASCII(nameBytes.slice(0, nullIdx));
	}
	return decodeASCII(nameBytes);
}

/**
 * Check if string contains only printable characters
 * Matches Python logic: all(c.isprintable() or c in '._-(), ' for c in test_name)
 */
export function isPrintable(str: string): boolean {
	const extraChars = new Set(['.', '_', '-', '(', ')', ',', ' ']);
	for (const c of str) {
		const code = c.charCodeAt(0);
		// Must be either printable OR in extra characters set
		const isPrintableChar = code >= 32 && code <= 126;
		const isExtraChar = extraChars.has(c);
		if (!isPrintableChar && !isExtraChar) {
			return false;
		}
	}
	return true;
}

/**
 * Find metadata table using ROCK26 anchor method
 * @param part5Data - Part 5 firmware data
 * @param rock26Offset - Offset of ROCK26 table within part5Data
 * @returns Table offset within Part 5, or null if not found
 */
export function findMetadataTableByRock26Anchor(
	part5Data: Uint8Array,
	rock26Offset: number
): number | null {
	const rock26EntriesStart = rock26Offset + 32;
	const anchorOffset = readU32LE(part5Data, rock26EntriesStart + 12);

	// Search for all matching positions in Part 5
	const matchingPositionsInPart5: number[] = [];

	// The table is not always 4-byte aligned (e.g. V4.0.0), so every position must be
	// considered. Jump straight to the next occurrence of the anchor's first byte
	// instead of testing positions one by one.
	const scanEnd = part5Data.length - METADATA_ENTRY_SIZE;
	const anchorByte0 = anchorOffset & 0xff;
	for (let pos = 0; pos < scanEnd; pos++) {
		const next = part5Data.indexOf(anchorByte0, pos + 20);
		if (next === -1 || next - 20 >= scanEnd) break;
		pos = next - 20;
		try {
			const entryOffset = readU32LE(part5Data, pos + 20);

			if (entryOffset === anchorOffset) {
				// Verify it's a valid metadata entry
				const nameBytes = part5Data.slice(pos + 32, pos + 96);
				const nullIdx = nameBytes.indexOf(0);
				const name = decodeNullTerminatedASCII(nameBytes);

				if (name.endsWith('.BMP') && name.length >= 3) {
					matchingPositionsInPart5.push(pos);
				}
			}
		} catch {
			continue;
		}
	}

	if (matchingPositionsInPart5.length === 0) {
		return null;
	}

	// Find the earliest valid entry by scanning backwards
	const firstMatch = Math.min(...matchingPositionsInPart5);
	let tableStart = firstMatch;

	while (tableStart >= METADATA_ENTRY_SIZE) {
		const testPos = tableStart - METADATA_ENTRY_SIZE;
		const testEntry = part5Data.slice(testPos, testPos + METADATA_ENTRY_SIZE);
		const testName = decodeNullTerminatedASCII(testEntry.slice(32, 96));

		if (testName && testName.endsWith('.BMP') && testName.length >= 3 && isPrintable(testName)) {
			tableStart = testPos;
		} else {
			break;
		}
	}

	return tableStart;
}

/**
 * Parse metadata table from Part 5
 * @param part5Data - Part 5 firmware data
 * @param tableStart - Starting offset of the table (relative to Part 5)
 * @returns Array of metadata entries
 */
export function parseMetadataTable(
	part5Data: Uint8Array,
	tableStart: number
): MetadataEntry[] {
	const entries: MetadataEntry[] = [];
	let pos = tableStart;

	while (pos + METADATA_ENTRY_SIZE <= part5Data.length) {
		const nameBytes = part5Data.slice(pos + 32, pos + 96);
		const name = decodeNullTerminatedASCII(nameBytes);

		if (!name || name.length < 3) {
			break;
		}

		const offset = readU32LE(part5Data, pos + 20);
		const width = readU32LE(part5Data, pos + 24);
		const height = readU32LE(part5Data, pos + 28);

		entries.push({
			name,
			offset,
			width,
			height
		});

		pos += METADATA_ENTRY_SIZE;
	}

	return entries;
}

/**
 * Detect offset misalignment using statistical analysis
 * @param metadataEntries - Parsed metadata entries
 * @param part5Data - Part 5 firmware data
 * @param rock26Offset - Offset of ROCK26 table within part5Data
 * @returns Misalignment detection result
 */
export function detectOffsetMisalignment(
	metadataEntries: readonly MetadataEntry[],
	part5Data: Uint8Array,
	rock26Offset: number
): MisalignmentDetection {
	const rock26Count = readU32LE(part5Data, rock26Offset + 16);

	// Read first N ROCK26 entry offsets from part5Data
	const rock26Offsets: number[] = [];
	const rock26EntriesStart = rock26Offset + 32;

	const sampleCount = Math.min(20, rock26Count);
	for (let i = 0; i < sampleCount; i++) {
		const entryOffset = rock26EntriesStart + i * ROCK26_ENTRY_SIZE;
		const offset = readU32LE(part5Data, entryOffset + 12);
		rock26Offsets.push(offset);
	}

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

		// Check for Flash metadata structure pattern
		// Entry 0 offset appears invalid because fields are stored in Entry[1]
		const entry0 = metadataEntries[0];
		const hasFlashMetadataStructure =
			entry0.offset === 0 ||
			entry0.offset >= part5Data.length ||
			entry0.offset === 0xf564f564 ||
			entry0.offset === 0xb7b5d7b5 ||
			entry0.offset === 0x00000000 ||
			entry0.offset === 0xc308c308 ||
			entry0.offset === 0x45294529;

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
			firstValidEntry = Math.max(1, 1 - misalignment);
			conclusion = `Detected ${misalignment >= 0 ? '+' : ''}${misalignment} index misalignment (statistical confidence: ${confidence}/${Math.min(20, rock26Offsets.length)} samples match)`;
		}
	} else {
		conclusion = 'Statistical analysis failed, unable to detect misalignment';
	}

	return {
		misalignment,
		firstValidEntry,
		detectionInfo: {
			rock26Count,
			rock26SampleOffsets: rock26Offsets.slice(0, 5),
			metadataCount: metadataEntries.length,
			conclusion
		}
	};
}

/**
 * Build list of bitmap files from firmware metadata
 * Shared function used by both ResourceExtractor and firmware-worker
 *
 * @param firmwareData - Full firmware data
 * @param includeOffset - Whether to include offset in results (default: false)
 * @returns Array of bitmap file information
 */
export function buildBitmapListFromMetadata(
	firmwareData: Uint8Array,
	includeOffset = false
): BitmapFileInfo[] {
	// Extract Part 5 data
	const part5Offset = readU32LE(firmwareData, 0x14c);
	const part5Size = readU32LE(firmwareData, 0x150);
	const part5Data = firmwareData.slice(part5Offset, part5Offset + part5Size);

	// Find ROCK26 signature
	const rock26Offset = findBytes(part5Data, ROCK26_SIGNATURE);
	if (rock26Offset === -1) {
		return [];
	}

	// Find metadata table using ROCK26 anchor
	const tableStart = findMetadataTableByRock26Anchor(part5Data, rock26Offset);
	if (tableStart === null) {
		return [];
	}

	// Parse metadata entries
	const metadataEntries = parseMetadataTable(part5Data, tableStart);

	// Detect misalignment
	const { misalignment } = detectOffsetMisalignment(
		metadataEntries,
		part5Data,
		rock26Offset
	);

	const files: BitmapFileInfo[] = [];
	// When misalignment = 1, Entry 0 CAN still be extracted using Entry[1]'s offset
	const startIndex = 0;
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

		// Get width/height from Entry[i+1] (Bootloader field reorganization)
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
			name: entry.name,
			width,
			height,
			size,
			...(includeOffset && { offset })
		});
	}

	return files;
}
