/**
 * Bitmap conversion utilities (RGB565 to BMP)
 */

import { restrideToBmp, createBmpHeader } from './bytes.js';
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
 * @param width - Image width (default 16)
 * @param height - Image height (default 16)
 * @returns BMP file data
 */
export function createMonoBmp(
	pixels: PixelData,
	width: number = 16,
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

/**
 * Parse monochrome BMP to pixel data
 * @param bmpData - BMP file data
 * @returns Pixel data or null if invalid
 */
export function parseMonoBmp(bmpData: Uint8Array): PixelData | null {
	if (bmpData.length < 62) return null;

	// Check 'BM' signature
	if (bmpData[0] !== 0x42 || bmpData[1] !== 0x4d) return null;

	// Read header using DataView
	const view = new DataView(bmpData.buffer, bmpData.byteOffset, bmpData.byteLength);

	// Get pixel data offset
	const pixelDataOffset = view.getUint32(10, true);

	// Get dimensions
	const width = view.getInt32(18, true);
	const height = Math.abs(view.getInt32(22, true));
	const bitsPerPixel = view.getUint16(28, true);

	// Validate format (1-bit monochrome)
	if (bitsPerPixel !== 1) return null;
	if (width <= 0 || height <= 0 || width > 100 || height > 100) return null;

	const pixels: boolean[][] = [];
	const rowBytes = ((width + 31) >> 5) << 2; // ((width + 31) / 32) * 4

	// Read pixel data (bottom-up)
	for (let y = height - 1; y >= 0; y--) {
		const rowOffset = pixelDataOffset + y * rowBytes;
		const row: boolean[] = [];

		for (let x = 0; x < width; x++) {
			const byteIndex = Math.floor(x / 8);
			const bitIndex = 7 - (x % 8);
			const byteValue = bmpData[rowOffset + byteIndex];
			const pixel = ((byteValue >> bitIndex) & 1) === 1;
			row.push(pixel);
		}

		pixels.push(row);
	}

	return pixels as PixelData;
}

/**
 * Convert BMP to raw RGB565 data
 * @param bmpData - BMP file data
 * @returns Raw RGB565 data or null if invalid
 */
export function bmpToRgb565(bmpData: Uint8Array): Uint8Array | null {
	if (bmpData.length < 62) return null;

	// Check 'BM' signature
	if (bmpData[0] !== 0x42 || bmpData[1] !== 0x4d) return null;

	const view = new DataView(bmpData.buffer, bmpData.byteOffset, bmpData.byteLength);

	// Get pixel data offset
	const pixelDataOffset = view.getUint32(10, true);

	// Get dimensions
	const width = view.getUint32(18, true);
	const height = Math.abs(view.getInt32(22, true));
	const bitsPerPixel = view.getUint16(28, true);

	// Validate format (16-bit RGB565 with BI_BITFIELDS)
	if (bitsPerPixel !== 16) return null;
	if (width <= 0 || height <= 0 || width > 10000 || height > 10000) return null;

	// Check compression (should be BI_BITFIELDS = 3)
	const compression = view.getUint32(30, true);
	if (compression !== 3) return null;

	const srcStride = width * 2;
	const { srcStride: actualStride } = getStrideInfoFromBmp(width);

	// Read pixel data
	const pixelData = bmpData.slice(pixelDataOffset);
	const rawData = new Uint8Array(width * height * 2);

	for (let y = 0; y < height; y++) {
		const srcStart = y * actualStride;
		const dstStart = y * srcStride;

		// Copy row data and apply byte swap (BMP is LE, firmware is BE)
		for (let x = 0; x < srcStride; x += 2) {
			rawData[dstStart + x] = pixelData[srcStart + x + 1];
			rawData[dstStart + x + 1] = pixelData[srcStart + x];
		}
	}

	return rawData;
}

/**
 * Get stride info from BMP width
 */
function getStrideInfoFromBmp(width: number): { srcStride: number; padding: number } {
	const srcStride = width * 2;
	const dstStride = (srcStride + 3) & ~3;
	const padding = dstStride - srcStride;
	return { srcStride, padding };
}

/**
 * Convert any image format (PNG, JPG, etc.) to RGB565 data
 * Works in browser environment using Canvas/Image APIs
 * @param file - Image file
 * @param targetWidth - Expected width for validation
 * @param targetHeight - Expected height for validation
 * @returns Object with RGB565 data and actual dimensions, or null if failed
 */
export async function imageToRgb565(
	file: File,
	targetWidth: number,
	targetHeight: number,
	options: { resize?: boolean; grayscale?: boolean } = {}
): Promise<{ rgb565Data: Uint8Array; width: number; height: number } | null> {
	// Create a bitmap from the file
	const bitmap = await createImageBitmap(file);

	// Validate dimensions match
	if (!options.resize && (bitmap.width !== targetWidth || bitmap.height !== targetHeight)) {
		return null;
	}

	// Create canvas to read pixel data
	const canvas = document.createElement('canvas');
	canvas.width = targetWidth;
	canvas.height = targetHeight;
	const ctx = canvas.getContext('2d');

	if (!ctx) {
		return null;
	}

	// Configure context for pixelated scaling (nearest neighbor)
	ctx.imageSmoothingEnabled = false;

	// Apply grayscale filter if requested
	if (options.grayscale) {
		ctx.filter = 'grayscale(100%)';
	}

	// Draw the image to canvas
	ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);

	// Get pixel data
	const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
	const pixels = imageData.data;

	// Convert RGBA to RGB565
	const rgb565Data = new Uint8Array(targetWidth * targetHeight * 2);
	let dataOffset = 0;

	for (let i = 0; i < pixels.length; i += 4) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];
		// Ignore alpha (pixels[i + 3])

		// Convert to RGB565 (5 bits red, 6 bits green, 5 bits blue)
		const rgb565 = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

		// Store as big-endian (firmware format)
		rgb565Data[dataOffset++] = (rgb565 >> 8) & 0xff;
		rgb565Data[dataOffset++] = rgb565 & 0xff;
	}

	// Cleanup
	ctx.clearRect(0, 0, canvas.width, canvas.height);
	canvas.width = 0;
	canvas.height = 0;

	return {
		rgb565Data,
		width: targetWidth,
		height: targetHeight
	};
}
