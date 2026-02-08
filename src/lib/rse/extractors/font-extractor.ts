/**
 * Font Extractor - Extract fonts from firmware data
 */

import type {
	FirmwareAddresses,
	UnicodeRange,
	FontExtractionResult,
	RangeResult,
	PixelData,
	FontPlaneInfo
} from '../types/index.js';
import { UNICODE_RANGES } from '../utils/unicode-ranges.js';
import { createMonoBmp, isValidFontData, parseMonoBmp } from '../utils/bitmap.js';
import { encodeV8, validateFontData } from '../utils/font-encoder.js';
import { fileIO } from '../utils/file-io.js';

// Constants
const SMALL_STRIDE = 32;
const LARGE_STRIDE = 33;

/**
 * Font extractor class
 */
export class FontExtractor {
	private readonly firmware: Uint8Array;
	private readonly SMALL_BASE: number;
	private readonly LARGE_BASE: number;
	private readonly LOOKUP_TABLE: number;
	private readonly SMALL_STRIDE = SMALL_STRIDE;
	private readonly LARGE_STRIDE = LARGE_STRIDE;
	private unicodeRanges: readonly UnicodeRange[] = UNICODE_RANGES;

	constructor(
		firmware: Uint8Array,
		addresses: FirmwareAddresses,
		unicodeRanges?: readonly UnicodeRange[]
	) {
		this.firmware = firmware;
		this.SMALL_BASE = addresses.SMALL_BASE;
		this.LARGE_BASE = addresses.LARGE_BASE;
		this.LOOKUP_TABLE = addresses.LOOKUP_TABLE;
		if (unicodeRanges) {
			this.unicodeRanges = unicodeRanges;
		}
	}

	/**
	 * Convert Unicode value to small font address
	 */
	unicodeToSmallAddr(unicodeVal: number): number {
		return this.SMALL_BASE + unicodeVal * this.SMALL_STRIDE;
	}

	/**
	 * Convert Unicode value to large font address
	 */
	unicodeToLargeAddr(unicodeVal: number): number {
		return this.LARGE_BASE + (unicodeVal - 0x4e00) * this.LARGE_STRIDE;
	}

	/**
	 * Get lookup table value for Unicode character
	 */
	getLookup(unicodeVal: number): number {
		return this.firmware[this.LOOKUP_TABLE + (unicodeVal >> 3)];
	}

	/**
	 * Decode font data chunk using v8 algorithm
	 * @param chunk - Raw font data
	 * @param lookupVal - Lookup table value
	 * @returns Decoded pixel data
	 */
	decodeV8(chunk: Uint8Array, lookupVal: number): PixelData {
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
			for (let bit = 15; bit >= 0; bit--) {
				rowBits.push(((finalPixel >> bit) & 1) === 1);
			}
			pixels.push(rowBits);
		}

		return pixels;
	}

	/**
	 * Extract font range
	 * @param start - Start Unicode code point
	 * @param end - End Unicode code point
	 * @param fontType - "SMALL" or "LARGE"
	 * @param outputDir - Output directory
	 * @param rangeName - Optional range name
	 * @returns Number of fonts extracted
	 */
	extractFontRange(
		start: number,
		end: number,
		fontType: 'SMALL' | 'LARGE',
		outputDir: string,
		rangeName = ''
	): number {
		const rangePrefix = rangeName
			? `U+${start.toString(16).padStart(4, '0').toUpperCase()}-${end.toString(16).padStart(4, '0').toUpperCase()}_${rangeName}`
			: `U+${start.toString(16).padStart(4, '0').toUpperCase()}-${end.toString(16).padStart(4, '0').toUpperCase()}`;

		const stride = fontType === 'SMALL' ? this.SMALL_STRIDE : this.LARGE_STRIDE;
		const addrFunc =
			fontType === 'SMALL' ? this.unicodeToSmallAddr.bind(this) : this.unicodeToLargeAddr.bind(this);

		let count = 0;

		for (let uni = start; uni <= end; uni++) {
			const addr = addrFunc(uni);

			if (addr < 0 || addr + stride > this.firmware.length) {
				continue;
			}

			const chunk = this.firmware.slice(addr, addr + stride);

			// Skip empty data
			if (this.isDataEmpty(chunk)) {
				continue;
			}

			try {
				const lookupVal = this.getLookup(uni);
				let pixels = this.decodeV8(chunk, lookupVal);

				if (pixels.length !== 16) {
					continue;
				}

				if (!isValidFontData(pixels, fontType)) {
					continue;
				}

				const header = lookupVal & 0xff;
				const name = `0x${addr.toString(16).padStart(6, '0')}_H${header.toString(16).padStart(2, '0')}_U+${uni.toString(16).padStart(4, '0').toUpperCase()}.bmp`;

				// For SMALL fonts, only extract the top-left 10x10 pixels
				if (fontType === 'SMALL') {
					pixels = pixels.slice(0, 10).map((row) => row.slice(0, 10));
					this.writeBmp(`${outputDir}/${fontType}/${rangePrefix}/${name}`, pixels, 10, 10);
				} else {
					this.writeBmp(`${outputDir}/${fontType}/${rangePrefix}/${name}`, pixels, 16, 16);
				}
				count++;

				if (count % 100 === 0) {
					console.log(`  ${fontType}: ${count} extracted (U+${uni.toString(16).padStart(4, '0').toUpperCase()})...`);
				}
			} catch {
				continue;
			}
		}

		console.log(`  ${fontType} ${rangePrefix}: ${count} extracted`);
		return count;
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
	 * Write BMP to file
	 */
	private writeBmp(path: string, pixels: PixelData, width: number = 16, height: number = 16): void {
		const bmpData = createMonoBmp(pixels, width, height);
		fileIO.writeFileSync(path, bmpData);
	}

	/**
	 * Extract all fonts in all Unicode ranges
	 * @param outputDir - Output directory
	 * @returns Extraction result
	 */
	extractAll(outputDir: string): FontExtractionResult {
		console.log('\nScanning Unicode ranges...');
		console.log('='.repeat(80));

		const rangeResults: RangeResult[] = [];
		let totalSmall = 0;
		let totalLarge = 0;

		for (const { name, start, end } of this.unicodeRanges) {
			console.log(`\nProcessing: ${name} (U+${start.toString(16).padStart(4, '0').toUpperCase()} - U+${end.toString(16).padStart(4, '0').toUpperCase()})`);

			const sCount = this.extractFontRange(start, end, 'SMALL', outputDir, name);
			totalSmall += sCount;

			const lCount = this.extractFontRange(start, end, 'LARGE', outputDir, name);
			totalLarge += lCount;

			rangeResults.push({
				name,
				start,
				end,
				smallCount: sCount,
				largeCount: lCount
			});
		}

		console.log('\n' + '='.repeat(80));
		console.log('DONE!');
		console.log(`  SMALL: ${totalSmall} fonts extracted`);
		console.log(`  LARGE: ${totalLarge} fonts extracted`);
		console.log(`  Output: ${outputDir}`);
		console.log('='.repeat(80));

		return {
			smallCount: totalSmall,
			largeCount: totalLarge,
			rangeResults
		};
	}

	/**
	 * Extract all fonts and return as data (no file writing)
	 * Useful for testing or browser environments
	 * @returns Map of filename to BMP data
	 */
	extractAllAsData(): Map<string, Uint8Array> {
		const results = new Map<string, Uint8Array>();

		for (const { name, start, end } of this.unicodeRanges) {
			for (const fontType of ['SMALL', 'LARGE'] as const) {
				const stride = fontType === 'SMALL' ? this.SMALL_STRIDE : this.LARGE_STRIDE;
				const addrFunc =
					fontType === 'SMALL'
						? this.unicodeToSmallAddr.bind(this)
						: this.unicodeToLargeAddr.bind(this);

				for (let uni = start; uni <= end; uni++) {
					const addr = addrFunc(uni);

					if (addr < 0 || addr + stride > this.firmware.length) {
						continue;
					}

					const chunk = this.firmware.slice(addr, addr + stride);

					if (this.isDataEmpty(chunk)) {
						continue;
					}

					try {
						const lookupVal = this.getLookup(uni);
						let pixels = this.decodeV8(chunk, lookupVal);

						if (pixels.length !== 16 || !isValidFontData(pixels, fontType)) {
							continue;
						}

						const header = lookupVal & 0xff;
						const filename = `${fontType}/${name}_U+${uni.toString(16).padStart(4, '0').toUpperCase()}_H${header.toString(16).padStart(2, '0')}.bmp`;

						// For SMALL fonts, only extract the top-left 10x10 pixels
						if (fontType === 'SMALL') {
							pixels = pixels.slice(0, 10).map((row) => row.slice(0, 10));
							results.set(filename, createMonoBmp(pixels, 10, 10));
						} else {
							results.set(filename, createMonoBmp(pixels, 16, 16));
						}
					} catch {
						continue;
					}
				}
			}
		}

		return results;
	}

	/**
	 * List all font planes/ranges with estimated font counts
	 * @returns Array of font plane information
	 */
	listPlanes(): FontPlaneInfo[] {
		const planes: FontPlaneInfo[] = [];

		for (const { name, start, end } of this.unicodeRanges) {
			// Count SMALL fonts in this range
			let smallCount = 0;
			for (let uni = start; uni <= end; uni++) {
				const addr = this.unicodeToSmallAddr(uni);
				const stride = this.SMALL_STRIDE;

				if (addr < 0 || addr + stride > this.firmware.length) {
					continue;
				}

				const chunk = this.firmware.slice(addr, addr + stride);
				if (this.isDataEmpty(chunk)) {
					continue;
				}

				try {
					const lookupVal = this.getLookup(uni);
					const pixels = this.decodeV8(chunk, lookupVal);
					if (pixels.length === 16 && isValidFontData(pixels, 'SMALL')) {
						smallCount++;
					}
				} catch {
					continue;
				}
			}

			// Count LARGE fonts in this range
			let largeCount = 0;
			for (let uni = start; uni <= end; uni++) {
				const addr = this.unicodeToLargeAddr(uni);
				const stride = this.LARGE_STRIDE;

				if (addr < 0 || addr + stride > this.firmware.length) {
					continue;
				}

				const chunk = this.firmware.slice(addr, addr + stride);
				if (this.isDataEmpty(chunk)) {
					continue;
				}

				try {
					const lookupVal = this.getLookup(uni);
					const pixels = this.decodeV8(chunk, lookupVal);
					if (pixels.length === 16 && isValidFontData(pixels, 'LARGE')) {
						largeCount++;
					}
				} catch {
					continue;
				}
			}

			planes.push({
				name,
				start,
				end,
				estimatedCount: smallCount + largeCount
			});
		}

		return planes;
	}

	/**
	 * Read raw font data for a Unicode character
	 * @param unicode - Unicode code point
	 * @param fontType - "SMALL" or "LARGE"
	 * @returns Raw font data or null if not found
	 */
	readFont(unicode: number, fontType: 'SMALL' | 'LARGE'): Uint8Array | null {
		const stride = fontType === 'SMALL' ? this.SMALL_STRIDE : this.LARGE_STRIDE;
		const addrFunc =
			fontType === 'SMALL' ? this.unicodeToSmallAddr.bind(this) : this.unicodeToLargeAddr.bind(this);

		const addr = addrFunc(unicode);
		if (addr < 0 || addr + stride > this.firmware.length) {
			return null;
		}

		return this.firmware.slice(addr, addr + stride);
	}

	/**
	 * Read font data as pixel array for a Unicode character
	 * @param unicode - Unicode code point
	 * @param fontType - "SMALL" or "LARGE"
	 * @returns Pixel data or null if not found/invalid
	 */
	readFontAsPixels(unicode: number, fontType: 'SMALL' | 'LARGE'): PixelData | null {
		const chunk = this.readFont(unicode, fontType);
		if (!chunk) return null;

		if (this.isDataEmpty(chunk)) return null;

		try {
			const lookupVal = this.getLookup(unicode);
			const pixels = this.decodeV8(chunk, lookupVal);

			if (pixels.length !== 16 || !isValidFontData(pixels, fontType)) {
				return null;
			}

			return pixels;
		} catch {
			return null;
		}
	}

	/**
	 * Replace font data for a Unicode character
	 * @param unicode - Unicode code point
	 * @param fontType - "SMALL" or "LARGE"
	 * @param data - Raw font data (must match stride size)
	 * @returns True if successful, false otherwise
	 */
	replaceFont(unicode: number, fontType: 'SMALL' | 'LARGE', data: Uint8Array): boolean {
		const stride = fontType === 'SMALL' ? this.SMALL_STRIDE : this.LARGE_STRIDE;
		const addrFunc =
			fontType === 'SMALL' ? this.unicodeToSmallAddr.bind(this) : this.unicodeToLargeAddr.bind(this);

		// Validate data
		if (!validateFontData(data, stride)) {
			return false;
		}

		const addr = addrFunc(unicode);
		if (addr < 0 || addr + stride > this.firmware.length) {
			return false;
		}

		// Write data to firmware (mutates the original array)
		this.firmware.set(data, addr);
		return true;
	}

	/**
	 * Replace font data from pixel array
	 * @param unicode - Unicode code point
	 * @param fontType - "SMALL" or "LARGE"
	 * @param pixels - Pixel data (10x10 for SMALL, 16x16 for LARGE)
	 * @returns True if successful, false otherwise
	 */
	replaceFontFromPixels(unicode: number, fontType: 'SMALL' | 'LARGE', pixels: PixelData): boolean {
		let pixelsToEncode: boolean[][];

		// Validate and pad pixel data based on font type
		if (fontType === 'SMALL') {
			// SMALL fonts: expect 10x10, pad to 16x16 for encoding
			if (pixels.length !== 10) {
				return false;
			}
			for (const row of pixels) {
				if (row.length !== 10) {
					return false;
				}
			}

			// Validate with font type (using 10x10 data)
			if (!isValidFontData(pixels, fontType)) {
				return false;
			}

			// Pad 10x10 to 16x16 for encoding (fill with zeros)
			pixelsToEncode = [];
			for (let i = 0; i < 16; i++) {
				if (i < 10) {
					// Pad each row to 16 columns
					pixelsToEncode.push([...pixels[i], ...new Array(6).fill(false)]);
				} else {
					// Add empty rows
					pixelsToEncode.push(new Array(16).fill(false));
				}
			}
		} else {
			// LARGE fonts: expect 16x16
			if (pixels.length !== 16) {
				return false;
			}
			for (const row of pixels) {
				if (row.length !== 16) {
					return false;
				}
			}

			// Validate with font type
			if (!isValidFontData(pixels, fontType)) {
				return false;
			}

			pixelsToEncode = pixels as boolean[][];
		}

		// Get lookup value for encoding
		const lookupVal = this.getLookup(unicode);

		// Encode pixels to font data
		try {
			const data = encodeV8(pixelsToEncode as PixelData, lookupVal);
			return this.replaceFont(unicode, fontType, data);
		} catch {
			return false;
		}
	}

	/**
	 * Replace font data from BMP file data
	 * @param unicode - Unicode code point
	 * @param fontType - "SMALL" or "LARGE"
	 * @param bmpData - BMP file data (monochrome, 10x10 for SMALL, 16x16 for LARGE)
	 * @returns True if successful, false otherwise
	 */
	replaceFontFromBmp(unicode: number, fontType: 'SMALL' | 'LARGE', bmpData: Uint8Array): boolean {
		// Parse BMP to pixels
		const pixels = parseMonoBmp(bmpData);
		if (!pixels) {
			return false;
		}

		return this.replaceFontFromPixels(unicode, fontType, pixels);
	}

	/**
	 * Get firmware data with modifications
	 * @returns Modified firmware data
	 */
	getFirmwareData(): Uint8Array {
		return this.firmware;
	}
}
