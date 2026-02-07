/**
 * Unicode range definitions (complete planes)
 * Matches the Python reference implementation
 */

import type { UnicodeRange } from '../types/index.js';

/**
 * Complete Unicode range definitions
 */
export const UNICODE_RANGES: readonly UnicodeRange[] = [
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
] as const;

/**
 * Parse Unicode range from string format "name:start:end"
 * @param rangeStr - Range string
 * @returns Parsed range or null if invalid
 */
export function parseUnicodeRange(rangeStr: string): UnicodeRange | null {
	const parts = rangeStr.split(':');
	if (parts.length !== 3) return null;

	const [name, startStr, endStr] = parts;
	const start = Number.parseInt(startStr, 16);
	const end = Number.parseInt(endStr, 16);

	if (Number.isNaN(start) || Number.isNaN(end)) return null;
	if (start < 0 || end < start) return null;

	return { name, start, end };
}

/**
 * Parse multiple Unicode ranges from strings
 */
export function parseUnicodeRanges(rangeStrings: string[]): UnicodeRange[] {
	const ranges: UnicodeRange[] = [];
	for (const str of rangeStrings) {
		const range = parseUnicodeRange(str);
		if (range) ranges.push(range);
	}
	return ranges;
}
