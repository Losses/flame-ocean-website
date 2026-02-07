/**
 * Web Worker for firmware data processing
 * Handles all heavy computation off the main thread
 */

// Import shared metadata utilities
import {
	findMetadataTableByRock26Anchor,
	parseMetadataTable,
	detectOffsetMisalignment,
	ROCK26_SIGNATURE
} from '../rse/utils/metadata.js';

// Constants
const SMALL_STRIDE = 32;
const LARGE_STRIDE = 33;
const FOOTER_SIGNATURES = new Set([0x90, 0x8f, 0x89, 0x8b, 0x8d, 0x8e, 0x8c]);
const INVALID_VALUES = new Set([0x00, 0xff]);

/**
 * Swap odd and even bytes to convert between big-endian and little-endian.
 * Firmware stores RGB565 data in big-endian format, but we need little-endian.
 */
function swapBytes16Bit(data: Uint8Array): Uint8Array {
	const result = new Uint8Array(data.length);
	for (let i = 0; i < data.length; i += 2) {
		// Swap adjacent bytes: [lo, hi] -> [hi, lo]
		result[i] = data[i + 1];
		result[i + 1] = data[i];
	}
	return result;
}

// Worker message types
interface WorkerRequest {
	type: 'analyze' | 'listPlanes' | 'listImages' | 'extractPlane' | 'extractImage';
	id: string;
	firmware: Uint8Array;
	fontType?: 'SMALL' | 'LARGE';
	planeName?: string;
	start?: number;
	end?: number;
	imageName?: string;
	width?: number;
	height?: number;
	offset?: number;
}

interface FontPlaneInfo {
	name: string;
	start: number;
	end: number;
	smallCount: number;
	largeCount: number;
	estimatedCount: number;
}

interface BitmapFileInfo {
	name: string;
	width: number;
	height: number;
	size: number;
	offset?: number;
}

interface PlaneData {
	name: string;
	start: number;
	end: number;
	fonts: Array<{
		unicode: number;
		fontType: 'SMALL' | 'LARGE';
		pixels: boolean[][];
	}>;
}

interface ImageData {
	name: string;
	width: number;
	height: number;
	rgb565Data: Uint8Array; // Raw RGB565 data
}

type WorkerResponse =
	| { type: 'success'; id: string; result: FontPlaneInfo[] | BitmapFileInfo[] | PlaneData | ImageData }
	| { type: 'progress'; id: string; message: string }
	| { type: 'error'; id: string; error: string };

// Firmware data cache
let firmwareData: Uint8Array | null = null;
let SMALL_BASE = 0;
let LARGE_BASE = 0;
let LOOKUP_TABLE = 0x080000;

// Binary reading helpers
function readU16LE(data: Uint8Array, offset: number): number {
	return data[offset] | (data[offset + 1] << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
	return (
		data[offset] |
		(data[offset + 1] << 8) |
		(data[offset + 2] << 16) |
		(data[offset + 3] << 24)
	) >>> 0;
}

function findBytes(data: Uint8Array, pattern: Uint8Array, startOffset = 0): number {
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

// Font decoding
function decodeV8(chunk: Uint8Array, lookupVal: number): boolean[][] {
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
		for (let bit = 15; bit > 0; bit--) {
			rowBits.push(((finalPixel >> bit) & 1) === 1);
		}
		pixels.push(rowBits);
	}

	return pixels;
}

function isValidFontData(pixels: boolean[][], fontType: 'LARGE' | 'SMALL'): boolean {
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
 * Score a window for font data detection
 * Matches FirmwareAnalyzer.scoreWindow() algorithm
 */
function scoreWindow(
	firmware: Uint8Array,
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

		if (addr + 32 >= firmware.length) break;

		if (baseAlignment !== null && addr % LARGE_STRIDE !== baseAlignment) {
			continue;
		}

		const byte_32 = firmware[addr + 32];

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
 * Matches FirmwareAnalyzer.searchOffsetTable() algorithm
 */
function searchOffsetTable(firmware: Uint8Array): number | null {
	// Get partition info (part_2_firmware_b at 0x80)
	const partitionOffset = readU32LE(firmware, 0x80);
	const partitionSize = readU32LE(firmware, 0x84);
	const searchStart = partitionOffset;
	const searchEnd = partitionOffset + partitionSize;

	const windowSize = 20902 * LARGE_STRIDE;
	let currentStride = Math.floor(windowSize / 2);
	const minStride = 100;

	let currentRegions: Array<{ start: number; end: number }> = [
		{ start: searchStart, end: searchEnd }
	];
	let bestAddr: number | null = null;
	let bestScore = -1;
	let baseAlignment: number | null = null;

	while (currentStride > minStride && currentRegions.length > 0) {
		const regionResults: Array<{ windowStart: number; score: number; firstAddr: number }> =
			[];

		for (const region of currentRegions) {
			for (let windowStart = region.start; windowStart < region.end; windowStart += currentStride) {
				const windowEnd = Math.min(windowStart + windowSize, firmware.length);
				const { score, firstAddr } = scoreWindow(
					firmware,
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

		if (baseAlignment === null && topWindows.length > 0) {
			const bestFirstAddr = topWindows[0].firstAddr;
			baseAlignment = bestFirstAddr % LARGE_STRIDE;
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

	return bestAddr;
}

// Unicode ranges (complete list matching RSE reference)
const UNICODE_RANGES = [
	{ name: 'Basic_Latin', start: 0x0000, end: 0x007f },
	{ name: 'Latin_1_Supplement', start: 0x0080, end: 0x00ff },
	{ name: 'Latin_Extended_A', start: 0x0100, end: 0x017f },
	{ name: 'Latin_Extended_B', start: 0x0180, end: 0x024f },
	{ name: 'IPA_Extensions', start: 0x0250, end: 0x02af },
	{ name: 'Spacing_Modifier', start: 0x02b0, end: 0x02ff },
	{ name: 'Combining_Diacritics', start: 0x0300, end: 0x036f },
	{ name: 'Greek_Coptic', start: 0x0370, end: 0x03ff },
	{ name: 'Cyrillic', start: 0x0400, end: 0x04ff },
	{ name: 'Cyrillic_Supplement', start: 0x0500, end: 0x052f },
	{ name: 'Armenian', start: 0x0530, end: 0x058f },
	{ name: 'Hebrew', start: 0x0590, end: 0x05ff },
	{ name: 'Arabic', start: 0x0600, end: 0x06ff },
	{ name: 'Syriac', start: 0x0700, end: 0x074f },
	{ name: 'Arabic_Supplement', start: 0x0750, end: 0x077f },
	{ name: 'Thaana', start: 0x0780, end: 0x07bf },
	{ name: 'NKo', start: 0x07c0, end: 0x07ff },
	{ name: 'Samaritan', start: 0x0800, end: 0x083f },
	{ name: 'Mandaic', start: 0x0840, end: 0x085f },
	{ name: 'Arabic_Extended_B', start: 0x0870, end: 0x089f },
	{ name: 'Arabic_Extended_A', start: 0x08a0, end: 0x08ff },
	{ name: 'Devanagari', start: 0x0900, end: 0x097f },
	{ name: 'Bengali', start: 0x0980, end: 0x09ff },
	{ name: 'Gurmukhi', start: 0x0a00, end: 0x0a7f },
	{ name: 'Gujarati', start: 0x0a80, end: 0x0aff },
	{ name: 'Oriya', start: 0x0b00, end: 0x0b7f },
	{ name: 'Tamil', start: 0x0b80, end: 0x0bff },
	{ name: 'Telugu', start: 0x0c00, end: 0x0c7f },
	{ name: 'Kannada', start: 0x0c80, end: 0x0cff },
	{ name: 'Malayalam', start: 0x0d00, end: 0x0d7f },
	{ name: 'Sinhala', start: 0x0d80, end: 0x0dff },
	{ name: 'Thai', start: 0x0e00, end: 0x0e7f },
	{ name: 'Lao', start: 0x0e80, end: 0x0eff },
	{ name: 'Tibetan', start: 0x0f00, end: 0x0fff },
	{ name: 'Myanmar', start: 0x1000, end: 0x109f },
	{ name: 'Georgian', start: 0x10a0, end: 0x10ff },
	{ name: 'Hangul_Jamo', start: 0x1100, end: 0x11ff },
	{ name: 'Ethiopic', start: 0x1200, end: 0x137f },
	{ name: 'Ethiopic_Supplement', start: 0x1380, end: 0x139f },
	{ name: 'Cherokee', start: 0x13a0, end: 0x13ff },
	{ name: 'UCAS', start: 0x1400, end: 0x167f },
	{ name: 'Ogham', start: 0x1680, end: 0x169f },
	{ name: 'Runic', start: 0x16a0, end: 0x16ff },
	{ name: 'Tagalog', start: 0x1700, end: 0x171f },
	{ name: 'Hanunoo', start: 0x1720, end: 0x173f },
	{ name: 'Buhid', start: 0x1740, end: 0x175f },
	{ name: 'Tagbanwa', start: 0x1760, end: 0x177f },
	{ name: 'Khmer', start: 0x1780, end: 0x17ff },
	{ name: 'Mongolian', start: 0x1800, end: 0x18af },
	{ name: 'UCAS_Extended', start: 0x18b0, end: 0x18ff },
	{ name: 'Limbu', start: 0x1900, end: 0x194f },
	{ name: 'Tai_Le', start: 0x1950, end: 0x197f },
	{ name: 'New_Tai_Lue', start: 0x1980, end: 0x19df },
	{ name: 'Khmer_Symbols', start: 0x19e0, end: 0x19ff },
	{ name: 'Buginese', start: 0x1a00, end: 0x1a1f },
	{ name: 'Tai_Tham', start: 0x1a20, end: 0x1aaf },
	{ name: 'Balinese', start: 0x1b00, end: 0x1b7f },
	{ name: 'Sundanese', start: 0x1b80, end: 0x1bbf },
	{ name: 'Batak', start: 0x1bc0, end: 0x1bff },
	{ name: 'Lepcha', start: 0x1c00, end: 0x1c4f },
	{ name: 'Ol_Chiki', start: 0x1c50, end: 0x1c7f },
	{ name: 'Cyrillic_Extended_C', start: 0x1c80, end: 0x1c8f },
	{ name: 'Georgian_Extended', start: 0x1c90, end: 0x1cbf },
	{ name: 'Vedic_Extensions', start: 0x1cd0, end: 0x1cff },
	{ name: 'Phonetic_Extensions', start: 0x1d00, end: 0x1d7f },
	{ name: 'Phonetic_Extensions_Sup', start: 0x1d80, end: 0x1dbf },
	{ name: 'Combining_Diacritics_Sup', start: 0x1dc0, end: 0x1dff },
	{ name: 'Latin_Extended_Additional', start: 0x1e00, end: 0x1eff },
	{ name: 'Greek_Extended', start: 0x1f00, end: 0x1fff },
	{ name: 'General_Punctuation', start: 0x2000, end: 0x206f },
	{ name: 'Superscripts_Subscripts', start: 0x2070, end: 0x209f },
	{ name: 'Currency_Symbols', start: 0x20a0, end: 0x20cf },
	{ name: 'Combining_Diacritics_Sym', start: 0x20d0, end: 0x20ff },
	{ name: 'Letterlike_Symbols', start: 0x2100, end: 0x214f },
	{ name: 'Number_Forms', start: 0x2150, end: 0x218f },
	{ name: 'Arrows', start: 0x2190, end: 0x21ff },
	{ name: 'Mathematical_Operators', start: 0x2200, end: 0x22ff },
	{ name: 'Misc_Technical', start: 0x2300, end: 0x23ff },
	{ name: 'Control_Pictures', start: 0x2400, end: 0x243f },
	{ name: 'OCR', start: 0x2440, end: 0x245f },
	{ name: 'Enclosed_Alphanumerics', start: 0x2460, end: 0x24ff },
	{ name: 'Box_Drawing', start: 0x2500, end: 0x257f },
	{ name: 'Block_Elements', start: 0x2580, end: 0x259f },
	{ name: 'Geometric_Shapes', start: 0x25a0, end: 0x25ff },
	{ name: 'Misc_Symbols', start: 0x2600, end: 0x26ff },
	{ name: 'Dingbats', start: 0x2700, end: 0x27bf },
	{ name: 'Misc_Math_Symbols_A', start: 0x27c0, end: 0x27ef },
	{ name: 'Supplemental_Arrows_A', start: 0x27f0, end: 0x27ff },
	{ name: 'Braille_Patterns', start: 0x2800, end: 0x28ff },
	{ name: 'Supplemental_Arrows_B', start: 0x2900, end: 0x297f },
	{ name: 'Misc_Math_Symbols_B', start: 0x2980, end: 0x29ff },
	{ name: 'Supplemental_Math_Op', start: 0x2a00, end: 0x2aff },
	{ name: 'Misc_Symbols_Arrows', start: 0x2b00, end: 0x2bff },
	{ name: 'Glagolitic', start: 0x2c00, end: 0x2c5f },
	{ name: 'Latin_Extended_C', start: 0x2c60, end: 0x2c7f },
	{ name: 'Coptic', start: 0x2c80, end: 0x2cff },
	{ name: 'Georgian_Supplement', start: 0x2d00, end: 0x2d2f },
	{ name: 'Tifinagh', start: 0x2d30, end: 0x2d7f },
	{ name: 'Ethiopic_Extended', start: 0x2d80, end: 0x2ddf },
	{ name: 'Cyrillic_Extended_A', start: 0x2de0, end: 0x2dff },
	{ name: 'Supplemental_Punctuation', start: 0x2e00, end: 0x2e7f },
	{ name: 'CJK_Radicals_Sup', start: 0x2e80, end: 0x2eff },
	{ name: 'Kangxi_Radicals', start: 0x2f00, end: 0x2fdf },
	{ name: 'Ideographic_Description', start: 0x2ff0, end: 0x2fff },
	{ name: 'CJK_Symbols_Punctuation', start: 0x3000, end: 0x303f },
	{ name: 'Hiragana', start: 0x3040, end: 0x309f },
	{ name: 'Katakana', start: 0x30a0, end: 0x30ff },
	{ name: 'Bopomofo', start: 0x3100, end: 0x312f },
	{ name: 'Hangul_Compatibility', start: 0x3130, end: 0x318f },
	{ name: 'Kanbun', start: 0x3190, end: 0x319f },
	{ name: 'Bopomofo_Extended', start: 0x31a0, end: 0x31bf },
	{ name: 'CJK_Strokes', start: 0x31c0, end: 0x31ef },
	{ name: 'Katakana_Phonetic', start: 0x31f0, end: 0x31ff },
	{ name: 'Enclosed_CJK', start: 0x3200, end: 0x32ff },
	{ name: 'CJK_Compatibility', start: 0x3300, end: 0x33ff },
	{ name: 'CJK_Extension_A', start: 0x3400, end: 0x4dbf },
	{ name: 'Yijing_Hexagrams', start: 0x4dc0, end: 0x4dff },
	{ name: 'CJK_Unified', start: 0x4e00, end: 0x9fff },
	{ name: 'Yi_Syllables', start: 0xa000, end: 0xa48f },
	{ name: 'Yi_Radicals', start: 0xa490, end: 0xa4cf },
	{ name: 'Lisu', start: 0xa4d0, end: 0xa4ff },
	{ name: 'Vai', start: 0xa500, end: 0xa63f },
	{ name: 'Cyrillic_Extended_B', start: 0xa640, end: 0xa69f },
	{ name: 'Bamum', start: 0xa6a0, end: 0xa6ff },
	{ name: 'Modifier_Tone_Letters', start: 0xa700, end: 0xa71f },
	{ name: 'Latin_Extended_D', start: 0xa720, end: 0xa7ff },
	{ name: 'Syloti_Nagri', start: 0xa800, end: 0xa82f },
	{ name: 'Indic_Number_Forms', start: 0xa830, end: 0xa83f },
	{ name: 'Phags_pa', start: 0xa840, end: 0xa87f },
	{ name: 'Saurashtra', start: 0xa880, end: 0xa8df },
	{ name: 'Devanagari_Extended', start: 0xa8e0, end: 0xa8ff },
	{ name: 'Kayah_Li', start: 0xa900, end: 0xa92f },
	{ name: 'Rejang', start: 0xa930, end: 0xa95f },
	{ name: 'Hangul_Jamo_Extended_A', start: 0xa960, end: 0xa97f },
	{ name: 'Javanese', start: 0xa980, end: 0xa9df },
	{ name: 'Myanmar_Extended_B', start: 0xa9e0, end: 0xa9ff },
	{ name: 'Cham', start: 0xaa00, end: 0xaa5f },
	{ name: 'Myanmar_Extended_A', start: 0xaa60, end: 0xaa7f },
	{ name: 'Tai_Viet', start: 0xaa80, end: 0xaadf },
	{ name: 'Meetei_Mayek_Ext', start: 0xaae0, end: 0xaaff },
	{ name: 'Ethiopic_Extended_A', start: 0xab00, end: 0xab2f },
	{ name: 'Latin_Extended_E', start: 0xab30, end: 0xab6f },
	{ name: 'Cherokee_Supplement', start: 0xab70, end: 0xabbf },
	{ name: 'Meetei_Mayek', start: 0xabc0, end: 0xabff },
	{ name: 'Hangul_Syllables', start: 0xac00, end: 0xd7af },
	{ name: 'Hangul_Jamo_Extended_B', start: 0xd7b0, end: 0xd7ff },
	{ name: 'Private_Use_Area', start: 0xe000, end: 0xf8ff },
	{ name: 'CJK_Compatibility_Ideographs', start: 0xf900, end: 0xfaff },
	{ name: 'Alphabetic_Presentation_Forms', start: 0xfb00, end: 0xfb4f },
	{ name: 'Arabic_Presentation_Forms_A', start: 0xfb50, end: 0xfdff },
	{ name: 'Variation_Selectors', start: 0xfe00, end: 0xfe0f },
	{ name: 'Vertical_Forms', start: 0xfe10, end: 0xfe1f },
	{ name: 'Combining_Half_Marks', start: 0xfe20, end: 0xfe2f },
	{ name: 'CJK_Compatibility_Forms', start: 0xfe30, end: 0xfe4f },
	{ name: 'Small_Form_Variants', start: 0xfe50, end: 0xfe6f },
	{ name: 'Arabic_Presentation_Forms_B', start: 0xfe70, end: 0xfeff },
	{ name: 'Halfwidth_Fullwidth', start: 0xff00, end: 0xffef },
	{ name: 'Specials', start: 0xfff0, end: 0xffff }
];

// Main worker handler
self.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
	const { type, id, firmware } = e.data;

	try {
		switch (type) {
			case 'analyze': {
				firmwareData = firmware;

				// Detect SMALL_BASE
				const config_78 = readU16LE(firmware, 0x78);
				const config_7a = readU16LE(firmware, 0x7a);
				SMALL_BASE = (config_7a << 16) | config_78;

				// Detect LARGE_BASE using full window-scoring algorithm
				self.postMessage({ type: 'progress', id, message: 'Searching for font data...' });

				const largeBase = searchOffsetTable(firmware);
				if (largeBase === null) {
					self.postMessage({ type: 'error', id, error: 'Could not find valid LARGE_BASE' });
					return;
				}
				LARGE_BASE = largeBase;

				self.postMessage({ type: 'success', id, result: [] });
				break;
			}

			case 'listPlanes': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const planes: FontPlaneInfo[] = [];

				for (const { name, start, end } of UNICODE_RANGES) {
					let smallCount = 0;
					let largeCount = 0;

					// Count SMALL fonts
					for (let uni = start; uni <= Math.min(end, 0xFFFF); uni++) {
						const addr = SMALL_BASE + uni * SMALL_STRIDE;
						if (addr + SMALL_STRIDE > firmwareData.length) continue;

						const chunk = firmwareData.slice(addr, addr + SMALL_STRIDE);
						if (chunk.every((b) => b === chunk[0])) continue;

						try {
							const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
							const pixels = decodeV8(chunk, lookupVal);
							if (pixels.length === 16 && isValidFontData(pixels, 'SMALL')) {
								smallCount++;
							}
						} catch {
							continue;
						}
					}

					// Count LARGE fonts for all ranges (not just CJK)
					for (let uni = start; uni <= end; uni++) {
						const addr = LARGE_BASE + (uni - 0x4e00) * LARGE_STRIDE;
						if (addr + LARGE_STRIDE > firmwareData.length) continue;

						const chunk = firmwareData.slice(addr, addr + LARGE_STRIDE);
						if (chunk.every((b) => b === chunk[0])) continue;

						try {
							const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
							const pixels = decodeV8(chunk, lookupVal);
							if (pixels.length === 16 && isValidFontData(pixels, 'LARGE')) {
								largeCount++;
							}
						} catch {
							continue;
						}
					}

					planes.push({ name, start, end, smallCount, largeCount, estimatedCount: smallCount + largeCount });
				}

				self.postMessage({ type: 'success', id, result: planes });
				break;
			}

			case 'listImages': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const images: BitmapFileInfo[] = [];

				// Extract Part 5 data first (matches Python: part5_offset = img_data[0x14c:0x150])
				const part5Offset = readU32LE(firmwareData, 0x14c);
				const part5Size = readU32LE(firmwareData, 0x150);
				const part5Data = firmwareData.slice(part5Offset, part5Offset + part5Size);

				// Find ROCK26 table within Part 5
				const rock26Offset = findBytes(part5Data, ROCK26_SIGNATURE);
				if (rock26Offset === -1) {
					self.postMessage({ type: 'success', id, result: images });
					return;
				}

				// Find metadata table using ROCK26 anchor (within Part 5)
				const tableStart = findMetadataTableByRock26Anchor(part5Data, rock26Offset);
				if (tableStart === null) {
					self.postMessage({ type: 'success', id, result: images });
					return;
				}

				// Parse all metadata entries
				const allEntries = parseMetadataTable(part5Data, tableStart);

				// Detect misalignment using ROCK26 offsets
				const { misalignment, firstValidEntry } = detectOffsetMisalignment(
					allEntries,
					part5Data,
					rock26Offset
				);

				// Build image list with misalignment correction
				// For each entry, use width/height from the NEXT entry (Python behavior)
				const startIndex = firstValidEntry;
				const endIndex = allEntries.length - (misalignment > 0 ? 1 : 0);

				for (let i = startIndex; i < endIndex; i++) {
					const entry = allEntries[i];

					// Get width/height from next entry (or current if last entry)
					let width: number;
					let height: number;
					if (i + 1 < allEntries.length) {
						width = allEntries[i + 1].width;
						height = allEntries[i + 1].height;
					} else {
						width = entry.width;
						height = entry.height;
					}

					// Apply misalignment correction to offset
					let offset: number;
					if (misalignment > 0) {
						const targetIndex = i + misalignment;
						if (targetIndex >= allEntries.length) continue;
						offset = allEntries[targetIndex].offset;
					} else if (misalignment < 0) {
						const targetIndex = i + misalignment;
						if (targetIndex < 0) continue;
						offset = allEntries[targetIndex].offset;
					} else {
						offset = entry.offset;
					}

					// Skip invalid entries
					if (offset === 0 || width <= 0 || height <= 0 || width > 10000 || height > 10000) {
						continue;
					}

					images.push({
						name: entry.name,
						width,
						height,
						size: width * height * 2,
						offset
					});
				}

				self.postMessage({ type: 'success', id, result: images });
				break;
			}

			case 'extractPlane': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const { planeName, start, end, fontType = 'SMALL' } = e.data as WorkerRequest & {
					planeName: string;
					start: number;
					end: number;
					fontType: 'SMALL' | 'LARGE';
				};

				self.postMessage({ type: 'progress', id, message: `Extracting plane: ${planeName} (${fontType})...` });

				const fonts: PlaneData['fonts'] = [];

				if (fontType === 'SMALL') {
					// Extract SMALL fonts only
					for (let uni = start; uni <= Math.min(end, 0xFFFF); uni++) {
						const addr = SMALL_BASE + uni * SMALL_STRIDE;
						if (addr + SMALL_STRIDE > firmwareData.length) continue;

						const chunk = firmwareData.slice(addr, addr + SMALL_STRIDE);
						if (chunk.every((b) => b === chunk[0])) continue;

						try {
							const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
							const pixels = decodeV8(chunk, lookupVal);
							if (pixels.length === 16 && isValidFontData(pixels, 'SMALL')) {
								fonts.push({ unicode: uni, fontType: 'SMALL', pixels });
							}
						} catch {
							continue;
						}
					}
				} else {
					// Extract LARGE fonts only
					for (let uni = start; uni <= end; uni++) {
						const addr = LARGE_BASE + (uni - 0x4e00) * LARGE_STRIDE;
						if (addr + LARGE_STRIDE > firmwareData.length) continue;

						const chunk = firmwareData.slice(addr, addr + LARGE_STRIDE);
						if (chunk.every((b) => b === chunk[0])) continue;

						try {
							const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
							const pixels = decodeV8(chunk, lookupVal);
							if (pixels.length === 16 && isValidFontData(pixels, 'LARGE')) {
								fonts.push({ unicode: uni, fontType: 'LARGE', pixels });
							}
						} catch {
							continue;
						}
					}
				}

				self.postMessage({
					type: 'success',
					id,
					result: { name: planeName, start, end, fonts } as PlaneData
				});
				break;
			}

			case 'extractImage': {
				if (!firmwareData) {
					self.postMessage({ type: 'error', id, error: 'Firmware not analyzed. Call analyze first.' });
					return;
				}

				const { imageName, width, height, offset } = e.data as WorkerRequest & {
					imageName: string;
					width: number;
					height: number;
					offset: number;
				};

				// Get Part 5 data (offset is relative to Part 5)
				const part5Offset = readU32LE(firmwareData, 0x14c);
				const part5Size = readU32LE(firmwareData, 0x150);
				const part5Data = firmwareData.slice(part5Offset, part5Offset + part5Size);

				const rawSize = width * height * 2;
				// Firmware stores RGB565 in big-endian, convert to little-endian
				const rawRgb565 = part5Data.slice(offset, offset + rawSize);
				const rgb565Data = swapBytes16Bit(rawRgb565);

				self.postMessage({
					type: 'success',
					id,
					result: {
						name: imageName,
						width,
						height,
						rgb565Data
					} as ImageData
				});
				break;
			}

			default:
				self.postMessage({ type: 'error', id, error: `Unknown request type: ${type}` });
		}
	} catch (err) {
		self.postMessage({
			type: 'error',
			id,
			error: err instanceof Error ? err.message : String(err)
		});
	}
};

export {};
