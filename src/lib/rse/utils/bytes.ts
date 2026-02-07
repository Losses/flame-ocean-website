/**
 * Byte manipulation utilities
 */

/**
 * Swap odd and even bytes in place (converts BE <-> LE for 16-bit values)
 * @param data - Input data
 * @returns New data with bytes swapped
 */
export function swapBytes16Bit(data: Uint8Array): Uint8Array {
	const result = new Uint8Array(data.length);
	const len = data.length % 2 === 0 ? data.length : data.length - 1;

	for (let i = 0; i < len; i += 2) {
		result[i] = data[i + 1];
		result[i + 1] = data[i];
	}

	// Copy any remaining odd byte
	if (len < data.length) {
		result[len] = data[len];
	}

	return result;
}

/**
 * Pad data to minimum length with zeros
 */
export function padToLength(data: Uint8Array, minLength: number): Uint8Array {
	if (data.length >= minLength) return data;
	const result = new Uint8Array(minLength);
	result.set(data);
	return result;
}

/**
 * Calculate stride and padding information for BMP alignment
 * @param width - Image width in pixels (16-bit = 2 bytes per pixel)
 * @returns Stride information
 */
export function getStrideInfo(width: number): {
	srcStride: number;
	dstStride: number;
	padding: number;
} {
	const srcStride = width * 2;
	const dstStride = (srcStride + 3) & ~3; // Round up to multiple of 4
	const padding = dstStride - srcStride;
	return { srcStride, dstStride, padding };
}

/**
 * Restride data from compact to BMP-aligned format
 * @param raw_data - Raw pixel data
 * @param width - Image width
 * @param height - Image height
 * @returns Restridded data
 */
export function restrideToBmp(raw_data: Uint8Array, width: number, height: number): Uint8Array {
	const { srcStride, dstStride, padding } = getStrideInfo(width);

	// Fast path: no padding needed
	if (padding === 0 && raw_data.length === srcStride * height) {
		return raw_data;
	}

	const expectedLen = srcStride * height;
	const paddedData = raw_data.length < expectedLen ? padToLength(raw_data, expectedLen) : raw_data;

	const output = new Uint8Array(dstStride * height);
	for (let y = 0; y < height; y++) {
		const srcStart = y * srcStride;
		const srcEnd = srcStart + srcStride;
		const dstStart = y * dstStride;

		output.set(paddedData.slice(srcStart, srcEnd), dstStart);
		// Padding is already zeros from initialization
	}

	return output;
}

/**
 * Create BMP file header for RGB565 image
 * @param width - Image width
 * @param height - Image height
 * @returns BMP header bytes
 */
export function createBmpHeader(width: number, height: number): Uint8Array {
	const { dstStride } = getStrideInfo(width);
	const imageSize = dstStride * height;
	const headersSize = 14 + 40 + 12; // File header + DIB header + color masks
	const fileSize = headersSize + imageSize;

	const header = new Uint8Array(headersSize);
	let offset = 0;

	// File header
	const fileHeader = new Uint8Array([
		0x42,
		0x4d, // 'BM'
		...writeU32LE(fileSize),
		0x00,
		0x00,
		0x00,
		0x00, // Reserved
		...writeU32LE(headersSize) // Offset to pixel data
	]);
	header.set(fileHeader, offset);
	offset += 14;

	// DIB header (BITMAPINFOHEADER)
	const dibHeader = new Uint8Array([
		...writeU32LE(40), // biSize
		...writeI32LE(width), // biWidth
		...writeI32LE(-height), // biHeight (negative = top-down)
		...writeU16LE(1), // biPlanes
		...writeU16LE(16), // biBitCount
		...writeU32LE(3), // biCompression (BI_BITFIELDS)
		...writeU32LE(imageSize), // biSizeImage
		...writeI32LE(2835), // biXPelsPerMeter (72 DPI)
		...writeI32LE(2835), // biYPelsPerMeter
		...writeU32LE(0), // biClrUsed
		...writeU32LE(0) // biClrImportant
	]);
	header.set(dibHeader, offset);
	offset += 40;

	// Color masks (RGB565)
	const colorMasks = new Uint8Array([
		...writeU32LE(0xf800), // Red mask
		...writeU32LE(0x07e0), // Green mask
		...writeU32LE(0x001f) // Blue mask
	]);
	header.set(colorMasks, offset);

	return header;
}

/**
 * Write unsigned 32-bit integer in little-endian format
 */
function writeU32LE(value: number): Uint8Array {
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
function writeI32LE(value: number): Uint8Array {
	return new Uint8Array([
		value & 0xff,
		(value >> 8) & 0xff,
		(value >> 16) & 0xff,
		(value >> 24) & 0xff
	]);
}

/**
 * Write unsigned 16-bit integer in little-endian format
 */
function writeU16LE(value: number): Uint8Array {
	return new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
}

/**
 * Sanitize filename by replacing invalid characters
 * @param originalName - Original filename
 * @returns Sanitized filename
 */
export function sanitizeFilename(originalName: string): string {
	let safe = originalName.replace(/\//g, '_').replace(/\\/g, '_');
	return safe.replace(/[^a-zA-Z0-9._\-(), ]/g, '_').trim();
}

/**
 * Check if data is all zeros or all 0xFF
 */
export function isDataEmpty(data: Uint8Array): boolean {
	if (data.length === 0) return true;
	const first = data[0];
	return data.every((b) => b === first);
}

/**
 * Check if data appears to be valid (not all same value)
 */
export function isDataValid(data: Uint8Array): boolean {
	if (data.length === 0) return false;
	return !isDataEmpty(data);
}
