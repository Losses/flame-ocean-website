/**
 * Binary data parsing utilities (platform-neutral)
 * Mirrors Python's struct module for TypeScript
 */

/**
 * Endianness enum
 */
export const enum Endianness {
	LittleEndian = '<',
	BigEndian = '>',
	Native = '@'
}

/**
 * Read unsigned 8-bit integer (byte)
 */
export function readU8(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset >= data.length) {
		throw new Error(`Offset ${offset} out of bounds for data length ${data.length}`);
	}
	return data[offset];
}

/**
 * Read unsigned 16-bit little-endian integer
 */
export function readU16LE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 16-bit read (data length ${data.length})`);
	}
	return data[offset] | (data[offset + 1] << 8);
}

/**
 * Read unsigned 16-bit big-endian integer
 */
export function readU16BE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 16-bit read (data length ${data.length})`);
	}
	return (data[offset] << 8) | data[offset + 1];
}

/**
 * Read unsigned 32-bit little-endian integer
 */
export function readU32LE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 32-bit read (data length ${data.length})`);
	}
	return (
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24)
	) >>> 0; // Ensure unsigned
}

/**
 * Read unsigned 32-bit big-endian integer
 */
export function readU32BE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 32-bit read (data length ${data.length})`);
	}
	return (
		(data[offset] << 24) |
		(data[offset + 1] << 16) |
		(data[offset + 2] << 8) |
		data[offset + 3]
	) >>> 0; // Ensure unsigned
}

/**
 * Read signed 32-bit little-endian integer
 */
export function readI32LE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 32-bit read (data length ${data.length})`);
	}
	const value =
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24);
	// Convert to signed 32-bit
	return value | ((value & 0x80000000) * 0x1fe);
}

/**
 * Read signed 32-bit big-endian integer
 */
export function readI32BE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 32-bit read (data length ${data.length})`);
	}
	const value =
		(data[offset] << 24) |
		(data[offset + 1] << 16) |
		(data[offset + 2] << 8) |
		data[offset + 3];
	// Convert to signed 32-bit
	return value | ((value & 0x80000000) * 0x1fe);
}

/**
 * Unpack multiple integers in little-endian format
 * @param data - The data buffer
 * @param offset - Starting offset
 * @param format - Array of format strings ('I' = u32, 'H' = u16, 'i' = i32, 'h' = i16)
 * @returns Array of unpacked values
 */
export function unpack(
	data: Uint8Array,
	offset: number,
	format: readonly string[]
): number[] {
	const result: number[] = [];
	let currentOffset = offset;

	for (const fmt of format) {
		switch (fmt) {
			case 'I':
				result.push(readU32LE(data, currentOffset));
				currentOffset += 4;
				break;
			case 'H':
				result.push(readU16LE(data, currentOffset));
				currentOffset += 2;
				break;
			case 'i':
				result.push(readI32LE(data, currentOffset));
				currentOffset += 4;
				break;
			case 'h':
				// Signed 16-bit
				result.push(readI16LE(data, currentOffset));
				currentOffset += 2;
				break;
			default:
				throw new Error(`Unknown format: ${fmt}`);
		}
	}

	return result;
}

/**
 * Read signed 16-bit little-endian integer
 */
function readI16LE(data: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 2 > data.length) {
		throw new Error(`Offset ${offset} out of bounds for 16-bit read (data length ${data.length})`);
	}
	const value = data[offset] | (data[offset + 1] << 8);
	return value | ((value & 0x8000) * 0x1fe);
}

/**
 * Write unsigned 16-bit integer in little-endian format
 */
export function writeU16LE(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

/**
 * Write unsigned 32-bit integer in little-endian format
 */
export function writeU32LE(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		(value >> 24) & 0xff
	]);
}

/**
 * Write signed 32-bit integer in little-endian format
 */
export function writeI32LE(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		(value >> 24) & 0xff
	]);
}

/**
 * Write unsigned 16-bit integer in big-endian format
 */
export function writeU16BE(value: number): Uint8Array {
	return new Uint8Array([(value >> 8) & 0xff, value & 0xff]);
}

/**
 * Write unsigned 32-bit integer in big-endian format
 */
export function writeU32BE(value: number): Uint8Array {
	return new Uint8Array([
		(value >> 24) & 0xff,
		(value >> 16) & 0xff,
		(value >> 8) & 0xff,
		value & 0xff
	]);
}

/**
 * Concatenate multiple Uint8Arrays
 */
export function concat(...arrays: Uint8Array[]): Uint8Array {
	const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}

/**
 * Slice data safely, returning smaller array if bounds exceeded
 */
export function safeSlice(data: Uint8Array, start: number, end?: number): Uint8Array {
	const actualEnd = end ?? data.length;
	if (start >= data.length) {
		return new Uint8Array(0);
	}
	return data.slice(start, Math.min(actualEnd, data.length));
}

/**
 * Find byte sequence in data
 * @returns Offset of first occurrence, or -1 if not found
 */
export function findBytes(data: Uint8Array, pattern: Uint8Array, startOffset = 0): number {
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

/**
 * Create a DataView wrapper for convenient reading
 */
export class BinaryReader {
	private readonly data: Uint8Array;
	private readonly view: DataView;

	constructor(data: Uint8Array) {
		this.data = data;
		this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	}

	get length(): number {
		return this.data.length;
	}

	slice(start: number, end?: number): BinaryReader {
		return new BinaryReader(this.data.slice(start, end));
	}

	readU8(offset: number): number {
		return this.data[offset];
	}

	readU16LE(offset: number): number {
		return this.view.getUint16(offset, true);
	}

	readU16BE(offset: number): number {
		return this.view.getUint16(offset, false);
	}

	readU32LE(offset: number): number {
		return this.view.getUint32(offset, true);
	}

	readU32BE(offset: number): number {
		return this.view.getUint32(offset, false);
	}

	readI32LE(offset: number): number {
		return this.view.getInt32(offset, true);
	}

	readI32BE(offset: number): number {
		return this.view.getInt32(offset, false);
	}

	/**
	 * Find byte pattern
	 */
	find(pattern: Uint8Array, startOffset = 0): number {
		return findBytes(this.data, pattern, startOffset);
	}

	/**
	 * Get raw data
	 */
	getData(): Uint8Array {
		return this.data;
	}
}
