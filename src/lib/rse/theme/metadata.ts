/**
 * Patch Metadata
 *
 * Handles reading/writing patch metadata stored in patched firmware.
 */

import type { PatchMetadata } from './types.js';

/** Magic number for patch metadata */
const PATCH_MAGIC = 'ECHO';
/** Current metadata version */
const METADATA_VERSION = 1;

/**
 * Patch metadata implementation
 */
class PatchMetadataImpl implements PatchMetadata {
	readonly magic = PATCH_MAGIC;
	version = METADATA_VERSION;
	timestamp = 0;
	flacColors: number[] = [];
	menuColors: number[] = [];
	checksum = 0;

	toBytes(): Uint8Array {
		const data: number[] = [];

		// Magic (4 bytes)
		for (let i = 0; i < PATCH_MAGIC.length; i++) {
			data.push(PATCH_MAGIC.charCodeAt(i));
		}

		// Version (1 byte)
		data.push(this.version);

		// Timestamp (4 bytes, little-endian)
		data.push(this.timestamp & 0xff);
		data.push((this.timestamp >> 8) & 0xff);
		data.push((this.timestamp >> 16) & 0xff);
		data.push((this.timestamp >> 24) & 0xff);

		// FLAC colors (5 * 2 bytes = 10 bytes)
		for (const c of this.flacColors) {
			data.push(c & 0xff);
			data.push((c >> 8) & 0xff);
		}

		// Menu colors (15 * 2 bytes = 30 bytes)
		for (const c of this.menuColors) {
			data.push(c & 0xff);
			data.push((c >> 8) & 0xff);
		}

		// Calculate checksum (CRC16 of everything so far)
		this.checksum = crc16(new Uint8Array(data));
		data.push(this.checksum & 0xff);
		data.push((this.checksum >> 8) & 0xff);

		return new Uint8Array(data);
	}

	static fromBytes(data: Uint8Array, offset = 0): PatchMetadataImpl | null {
		const requiredSize = 4 + 1 + 4 + 10 + 30 + 2; // 51 bytes
		if (data.length - offset < requiredSize) {
			return null;
		}

		// Check magic
		if (
			data[offset] !== 0x45 || // E
			data[offset + 1] !== 0x43 || // C
			data[offset + 2] !== 0x48 || // H
			data[offset + 3] !== 0x4f    // O
		) {
			return null;
		}

		const metadata = new PatchMetadataImpl();

		// Version
		metadata.version = data[offset + 4];

		// Timestamp
		metadata.timestamp =
			data[offset + 5] |
			(data[offset + 6] << 8) |
			(data[offset + 7] << 16) |
			(data[offset + 8] << 24);

		// FLAC colors
		metadata.flacColors = [];
		for (let i = 0; i < 5; i++) {
			const colorOffset = offset + 9 + i * 2;
			const color = data[colorOffset] | (data[colorOffset + 1] << 8);
			metadata.flacColors.push(color);
		}

		// Menu colors
		metadata.menuColors = [];
		for (let i = 0; i < 15; i++) {
			const colorOffset = offset + 19 + i * 2;
			const color = data[colorOffset] | (data[colorOffset + 1] << 8);
			metadata.menuColors.push(color);
		}

		// Verify checksum
		const storedChecksum = data[offset + 49] | (data[offset + 50] << 8);
		const calculatedChecksum = crc16(data.slice(offset, offset + 49));

		if (storedChecksum !== calculatedChecksum) {
			return null;
		}

		metadata.checksum = storedChecksum;
		return metadata;
	}
}

/**
 * CRC16 calculation
 */
export function crc16(data: Uint8Array): number {
	let crc = 0xffff;
	for (const byte of data) {
		crc ^= byte;
		for (let i = 0; i < 8; i++) {
			if (crc & 1) {
				crc = (crc >> 1) ^ 0xa001;
			} else {
				crc >>= 1;
			}
		}
	}
	return crc;
}

/**
 * Create patch metadata from color values
 */
export function createPatchMetadata(
	timestamp: number,
	flacColors: number[],
	menuColors: number[]
): PatchMetadata {
	const metadata = new PatchMetadataImpl();
	metadata.timestamp = timestamp;
	metadata.flacColors = [...flacColors];
	metadata.menuColors = [...menuColors];
	metadata.checksum = crc16(metadata.toBytes());
	return metadata;
}

/**
 * Read patch metadata from firmware data
 */
export function readPatchMetadata(data: Uint8Array, offset: number): PatchMetadata | null {
	return PatchMetadataImpl.fromBytes(data, offset);
}

/**
 * Write patch metadata to bytes
 */
export function writePatchMetadata(metadata: PatchMetadata): Uint8Array {
	return metadata.toBytes();
}

/**
 * Verify patch metadata checksum
 */
export function verifyPatchMetadata(metadata: PatchMetadata): boolean {
	const bytes = metadata.toBytes();
	const checksum = crc16(bytes.slice(0, bytes.length - 2));
	return checksum === metadata.checksum;
}

/**
 * Format timestamp as ISO string
 */
export function formatTimestamp(timestamp: number): string {
	const date = new Date(timestamp * 1000);
	return date.toISOString();
}

/**
 * Scan firmware for patch metadata
 *
 * Searches the entire firmware for valid "ECHO" metadata signatures.
 * Returns the first valid metadata found along with its offset.
 */
export function scanForPatchMetadata(data: Uint8Array): { metadata: PatchMetadata; offset: number } | null {
	const METADATA_SIZE = 51; // 4 + 1 + 4 + 10 + 30 + 2

	// Scan from 0x100000 onwards (skip low memory where "ECHO" might appear coincidentally)
	// Patch metadata is stored in language pools which start at 0x1C584
	for (let offset = 0x100000; offset <= data.length - METADATA_SIZE; offset++) {
		// Quick check for "ECHO" magic
		if (data[offset] === 0x45 &&     // E
		    data[offset + 1] === 0x43 && // C
		    data[offset + 2] === 0x48 && // H
		    data[offset + 3] === 0x4f) { // O

			const metadata = PatchMetadataImpl.fromBytes(data, offset);
			if (metadata) {
				return { metadata, offset };
			}
		}
	}

	return null;
}

/** Relocation header magic */
const RELO_MAGIC = 'RELO';
/** Relocation header size */
export const RELO_HEADER_SIZE_OLD = 16; // 4 + 4 + 4 + 4 (without callerAddr)
export const RELO_HEADER_SIZE = 20; // 4 + 4 + 4 + 4 + 4 (with callerAddr)

/**
 * Relocation header - stored before metadata
 *
 * Contains information needed to relocate-patch an already patched firmware.
 */
export interface RelocationHeader {
	/** New function address in language pool */
	newFuncAddr: number;
	/** Function size in bytes */
	funcSize: number;
	/** Offset of color selection code within the function */
	colorCodeOffset: number;
	/** Address of the BL instruction that calls the relocated function */
	callerAddr: number;
}

/**
 * Encode relocation header to bytes
 */
export function encodeRelocationHeader(header: RelocationHeader): Uint8Array {
	const data = new Uint8Array(RELO_HEADER_SIZE);
	let offset = 0;

	// Magic "RELO"
	data[offset++] = 0x52; // R
	data[offset++] = 0x45; // E
	data[offset++] = 0x4C; // L
	data[offset++] = 0x4F; // O

	// New function address (4 bytes, little-endian)
	data[offset++] = header.newFuncAddr & 0xff;
	data[offset++] = (header.newFuncAddr >> 8) & 0xff;
	data[offset++] = (header.newFuncAddr >> 16) & 0xff;
	data[offset++] = (header.newFuncAddr >> 24) & 0xff;

	// Function size (4 bytes, little-endian)
	data[offset++] = header.funcSize & 0xff;
	data[offset++] = (header.funcSize >> 8) & 0xff;
	data[offset++] = (header.funcSize >> 16) & 0xff;
	data[offset++] = (header.funcSize >> 24) & 0xff;

	// Color code offset (4 bytes, little-endian)
	data[offset++] = header.colorCodeOffset & 0xff;
	data[offset++] = (header.colorCodeOffset >> 8) & 0xff;
	data[offset++] = (header.colorCodeOffset >> 16) & 0xff;
	data[offset++] = (header.colorCodeOffset >> 24) & 0xff;

	// Caller address (BL instruction address, 4 bytes, little-endian)
	data[offset++] = header.callerAddr & 0xff;
	data[offset++] = (header.callerAddr >> 8) & 0xff;
	data[offset++] = (header.callerAddr >> 16) & 0xff;
	data[offset++] = (header.callerAddr >> 24) & 0xff;

	return data;
}

/**
 * Decode relocation header from bytes
 *
 * Supports both old format (16 bytes, no callerAddr) and new format (20 bytes, with callerAddr)
 */
export function decodeRelocationHeader(data: Uint8Array, offset: number): RelocationHeader | null {
	// Minimum size for old format (without callerAddr)
	if (offset + RELO_HEADER_SIZE_OLD > data.length) {
		return null;
	}

	// Check magic "RELO"
	if (data[offset] !== 0x52 ||     // R
	    data[offset + 1] !== 0x45 || // E
	    data[offset + 2] !== 0x4C || // L
	    data[offset + 3] !== 0x4F) { // O
		return null;
	}

	let pos = offset + 4;

	const newFuncAddr = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
	pos += 4;

	const funcSize = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
	pos += 4;

	const colorCodeOffset = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
	pos += 4;

	// Check if we have enough bytes for callerAddr (new format)
	let callerAddr = 0;
	if (offset + RELO_HEADER_SIZE <= data.length) {
		callerAddr = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24);
	}

	return { newFuncAddr, funcSize, colorCodeOffset, callerAddr };
}

/**
 * Scan firmware for patch with relocation header
 *
 * Returns metadata, relocation header, and metadata offset if found.
 * Supports both old format (16 bytes) and new format (20 bytes) headers.
 */
export function scanForPatchWithRelocation(data: Uint8Array): {
	metadata: PatchMetadata;
	metadataOffset: number;
	reloHeader: RelocationHeader;
} | null {
	const result = scanForPatchMetadata(data);
	if (!result) {
		return null;
	}

	// Try new format first (20 bytes before metadata)
	let reloHeaderOffset = result.offset - RELO_HEADER_SIZE;
	if (reloHeaderOffset >= 0) {
		const reloHeader = decodeRelocationHeader(data, reloHeaderOffset);
		if (reloHeader && reloHeader.callerAddr !== 0) {
			return {
				metadata: result.metadata,
				metadataOffset: result.offset,
				reloHeader
			};
		}
	}

	// Try old format (16 bytes before metadata)
	reloHeaderOffset = result.offset - RELO_HEADER_SIZE_OLD;
	if (reloHeaderOffset >= 0) {
		const reloHeader = decodeRelocationHeader(data, reloHeaderOffset);
		if (reloHeader) {
			return {
				metadata: result.metadata,
				metadataOffset: result.offset,
				reloHeader
			};
		}
	}

	return null;
}

/**
 * Get the size of patch metadata in bytes
 */
export const METADATA_SIZE = 51;
