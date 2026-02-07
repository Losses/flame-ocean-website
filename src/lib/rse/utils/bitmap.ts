/**
 * Bitmap conversion utilities (RGB565 to BMP)
 */

import { restrideToBmp, createBmpHeader, sanitizeFilename } from './bytes.js';
import { swapBytes16Bit } from './bytes.js';
import type { PixelData } from '../types/index.js';

/**
 * Convert raw RGB565 data to BMP format
 * @param rawData - Raw RGB565 pixel data
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns BMP file data, or null if invalid dimensions
 */
export function convertToBmp(
	rawData: Uint8Array,
	width: number,
	height: number
): Uint8Array | null {
	// Validate dimensions
	if (width <= 0 || height <= 0) {
		return null;
	}

	const expectedSize = width * height * 2;
	let paddedData = rawData;

	// Pad to expected size if needed
	if (rawData.length < expectedSize) {
		paddedData = new Uint8Array(expectedSize);
		paddedData.set(rawData);
	}

	// 1. Byte swap (BE -> LE)
	const pixelData = swapBytes16Bit(paddedData.slice(0, expectedSize));

	// 2. Row alignment
	const alignedData = restrideToBmp(pixelData, width, height);

	// 3. Add BMP header
	const header = createBmpHeader(width, height);

	// Concatenate header and data
	const result = new Uint8Array(header.length + alignedData.length);
	result.set(header, 0);
	result.set(alignedData, header.length);

	return result;
}

/**
 * Create a monochrome BMP image from pixel data
 * @param pixels - 2D array of boolean pixel values
 * @param width - Image width (default 15)
 * @param height - Image height (default 16)
 * @returns BMP file data
 */
export function createMonoBmp(
	pixels: PixelData,
	width: number = 15,
	height: number = 16
): Uint8Array {
	const bfType = 0x4d42; // 'BM'
	const bfOffBits = 62;
	const biSize = 40;
	const biWidth = width;
	const biHeight = height;
	const biBitCount = 1;
	const rowBytes = ((width + 31) >> 5) << 2; // ((width + 31) / 32) * 4
	const biSizeImage = rowBytes * height;
	const fileSize = bfOffBits + biSizeImage;

	const buffer = new Uint8Array(fileSize);
	let offset = 0;

	// BMP file header
	const write16 = (val: number): void => {
		buffer[offset++] = val & 0xff;
		buffer[offset++] = (val >> 8) & 0xff;
	};
	const write32 = (val: number): void => {
		buffer[offset++] = val & 0xff;
		buffer[offset++] = (val >> 8) & 0xff;
		buffer[offset++] = (val >> 16) & 0xff;
		buffer[offset++] = (val >> 24) & 0xff;
	};

	write16(bfType);
	write32(fileSize);
	write16(0); // Reserved
	write16(0);
	write32(bfOffBits);

	// DIB header
	write32(biSize);
	write32(biWidth);
	write32(biHeight);
	write16(1); // Planes
	write16(biBitCount);
	write32(0); // Compression
	write32(biSizeImage);
	write32(2835); // X pixels per meter
	write32(2835); // Y pixels per meter
	write32(2); // Colors used
	write32(2); // Important colors

	// Color table (white and black)
	for (const color of [0xffffff, 0x000000]) {
		buffer[offset++] = color & 0xff;
		buffer[offset++] = (color >> 8) & 0xff;
		buffer[offset++] = (color >> 16) & 0xff;
		buffer[offset++] = 0; // Reserved
	}

	// Pixel data (bottom-up)
	for (let y = height - 1; y >= 0; y--) {
		const rowDataStart = offset;
		let currentByte = 0;
		let bitCount = 0;

		for (let x = 0; x < width; x++) {
			const bit = y < pixels.length && x < pixels[y].length ? (pixels[y][x] ? 1 : 0) : 0;
			currentByte = (currentByte << 1) | bit;
			bitCount++;

			if (bitCount === 8) {
				buffer[offset++] = currentByte;
				currentByte = 0;
				bitCount = 0;
			}
		}

		// Write remaining bits
		if (bitCount > 0) {
			currentByte <<= 8 - bitCount;
			buffer[offset++] = currentByte;
		}

		// Pad to row boundary
		while (offset - rowDataStart < rowBytes) {
			buffer[offset++] = 0;
		}
	}

	return buffer;
}

/**
 * Validate font pixel data
 * @param pixels - 2D pixel array
 * @param fontType - "LARGE" or "SMALL"
 * @returns True if data appears valid
 */
export function isValidFontData(pixels: PixelData, fontType: 'LARGE' | 'SMALL'): boolean {
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
