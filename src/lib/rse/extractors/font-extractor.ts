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
import { decodeV8, isDataEmpty, sliceSmallFontPixels, SMALL_FONT_SIZE } from '../utils/font-decoder.js';
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
			if (isDataEmpty(chunk)) {
				continue;
			}

			try {
				const lookupVal = this.getLookup(uni);
				let pixels = decodeV8(chunk, lookupVal);

				if (pixels.length !== 16) {
					continue;
				}

				if (!isValidFontData(pixels, fontType)) {
					continue;
				}

				const header = lookupVal & 0xff;
				const name = `0x${addr.toString(16).padStart(6, '0')}_H${header.toString(16).padStart(2, '0')}_U+${uni.toString(16).padStart(4, '0').toUpperCase()}.bmp`;

				// For SMALL fonts, only extract the top-left SMALL_FONT_SIZE x SMALL_FONT_SIZE pixels
				if (fontType === 'SMALL') {
					pixels = pixels.slice(0, SMALL_FONT_SIZE).map((row) => row.slice(0, SMALL_FONT_SIZE));
					this.writeBmp(`${outputDir}/${fontType}/${rangePrefix}/${name}`, pixels, SMALL_FONT_SIZE, SMALL_FONT_SIZE);
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

					if (isDataEmpty(chunk)) {
						continue;
					}

					try {
						const lookupVal = this.getLookup(uni);
						let pixels = decodeV8(chunk, lookupVal);

						if (pixels.length !== 16 || !isValidFontData(pixels, fontType)) {
							continue;
						}

						const header = lookupVal & 0xff;
						const filename = `${fontType}/${name}_U+${uni.toString(16).padStart(4, '0').toUpperCase()}_H${header.toString(16).padStart(2, '0')}.bmp`;

						// For SMALL fonts, only extract the top-left SMALL_FONT_SIZE x SMALL_FONT_SIZE pixels
						if (fontType === 'SMALL') {
							pixels = pixels.slice(0, SMALL_FONT_SIZE).map((row) => row.slice(0, SMALL_FONT_SIZE));
							results.set(filename, createMonoBmp(pixels, SMALL_FONT_SIZE, SMALL_FONT_SIZE));
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
				if (isDataEmpty(chunk)) {
					continue;
				}

				try {
					const lookupVal = this.getLookup(uni);
					const pixels = decodeV8(chunk, lookupVal);
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
				if (isDataEmpty(chunk)) {
					continue;
				}

				try {
					const lookupVal = this.getLookup(uni);
					const pixels = decodeV8(chunk, lookupVal);
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

		if (isDataEmpty(chunk)) return null;

		try {
			const lookupVal = this.getLookup(unicode);
			let pixels = decodeV8(chunk, lookupVal);

			if (pixels.length !== 16 || !isValidFontData(pixels, fontType)) {
				return null;
			}

			// For SMALL fonts, return only the top-left 10x10 pixels
			if (fontType === 'SMALL') {
				pixels = sliceSmallFontPixels(pixels);
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
	 * @param pixels - Pixel data (SMALL_FONT_SIZE x SMALL_FONT_SIZE for SMALL, 16x16 for LARGE)
	 * @returns True if successful, false otherwise
	 */
	replaceFontFromPixels(unicode: number, fontType: 'SMALL' | 'LARGE', pixels: PixelData): boolean {
		let pixelsToEncode: boolean[][];

		// Validate and pad pixel data based on font type
		if (fontType === 'SMALL') {
			// SMALL fonts: expect SMALL_FONT_SIZE x SMALL_FONT_SIZE, pad to 16x16 for encoding
			if (pixels.length !== SMALL_FONT_SIZE) {
				return false;
			}
			for (const row of pixels) {
				if (row.length !== SMALL_FONT_SIZE) {
					return false;
				}
			}

			// Validate with font type (using SMALL_FONT_SIZE x SMALL_FONT_SIZE data)
			if (!isValidFontData(pixels, fontType)) {
				return false;
			}

			// Pad SMALL_FONT_SIZE x SMALL_FONT_SIZE to 16x16 for encoding (fill with zeros)
			pixelsToEncode = [];
			for (let i = 0; i < 16; i++) {
				if (i < SMALL_FONT_SIZE) {
					// Pad each row to 16 columns
					pixelsToEncode.push([...pixels[i], ...new Array(16 - SMALL_FONT_SIZE).fill(false)]);
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
	 * @param bmpData - BMP file data (monochrome, SMALL_FONT_SIZE x SMALL_FONT_SIZE for SMALL, 16x16 for LARGE)
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
