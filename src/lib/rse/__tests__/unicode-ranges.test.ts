/**
 * Tests for Unicode range utilities
 */

import { describe, it, expect } from 'vitest';
import { UNICODE_RANGES, parseUnicodeRange, parseUnicodeRanges } from '../utils/unicode-ranges.js';

describe('UNICODE_RANGES', () => {
	it('should have all expected ranges', () => {
		expect(UNICODE_RANGES.length).toBeGreaterThan(100);
	});

	it('should have Basic Latin range', () => {
		const basicLatin = UNICODE_RANGES.find((r) => r.name === 'Basic_Latin');
		expect(basicLatin).toBeDefined();
		expect(basicLatin?.start).toBe(0x0000);
		expect(basicLatin?.end).toBe(0x007f);
	});

	it('should have CJK Unified range', () => {
		const cjkUnified = UNICODE_RANGES.find((r) => r.name === 'CJK_Unified');
		expect(cjkUnified).toBeDefined();
		expect(cjkUnified?.start).toBe(0x4e00);
		expect(cjkUnified?.end).toBe(0x9fff);
	});

	it('should have Hiragana range', () => {
		const hiragana = UNICODE_RANGES.find((r) => r.name === 'Hiragana');
		expect(hiragana).toBeDefined();
		expect(hiragana?.start).toBe(0x3040);
		expect(hiragana?.end).toBe(0x309f);
	});

	it('should have Katakana range', () => {
		const katakana = UNICODE_RANGES.find((r) => r.name === 'Katakana');
		expect(katakana).toBeDefined();
		expect(katakana?.start).toBe(0x30a0);
		expect(katakana?.end).toBe(0x30ff);
	});

	it('should have ranges in order', () => {
		for (let i = 1; i < UNICODE_RANGES.length; i++) {
			const prev = UNICODE_RANGES[i - 1];
			const curr = UNICODE_RANGES[i];
			expect(curr.start).toBeGreaterThan(prev.end);
		}
	});

	// Verify specific ranges from Python reference
	it('should match Python reference for key ranges', () => {
		const expectedRanges: Array<{ name: string; start: number; end: number }> = [
			{ name: 'Latin_1_Supplement', start: 0x0080, end: 0x00ff },
			{ name: 'Latin_Extended_A', start: 0x0100, end: 0x017f },
			{ name: 'Greek_Coptic', start: 0x0370, end: 0x03ff },
			{ name: 'Cyrillic', start: 0x0400, end: 0x04ff },
			{ name: 'Arabic', start: 0x0600, end: 0x06ff },
			{ name: 'Thai', start: 0x0e00, end: 0x0e7f },
			{ name: 'Hangul_Jamo', start: 0x1100, end: 0x11ff },
			{ name: 'CJK_Unified', start: 0x4e00, end: 0x9fff },
			{ name: 'Hangul_Syllables', start: 0xac00, end: 0xd7af }
		];

		for (const expected of expectedRanges) {
			const found = UNICODE_RANGES.find((r) => r.name === expected.name);
			expect(found).toBeDefined();
			expect(found?.start).toBe(expected.start);
			expect(found?.end).toBe(expected.end);
		}
	});
});

describe('parseUnicodeRange', () => {
	it('should parse valid range string', () => {
		const result = parseUnicodeRange('Basic_Latin:0x0000:0x007F');
		expect(result).toEqual({
			name: 'Basic_Latin',
			start: 0x0000,
			end: 0x007f
		});
	});

	it('should parse range with different hex case', () => {
		const result = parseUnicodeRange('CJK:0x4e00:0x9FFF');
		expect(result).toEqual({
			name: 'CJK',
			start: 0x4e00,
			end: 0x9fff
		});
	});

	it('should handle uppercase hex', () => {
		const result = parseUnicodeRange('Test:0XABC:0XDEF');
		expect(result?.start).toBe(0xabc);
		expect(result?.end).toBe(0xdef);
	});

	it('should return null for invalid format', () => {
		expect(parseUnicodeRange('invalid')).toBeNull();
		expect(parseUnicodeRange('name:0x1234')).toBeNull();
		expect(parseUnicodeRange('name:start:end:extra')).toBeNull();
	});

	it('should return null for invalid hex values', () => {
		expect(parseUnicodeRange('name:xyz:0x1234')).toBeNull();
		expect(parseUnicodeRange('name:0x1234:xyz')).toBeNull();
	});

	it('should return null for invalid ranges', () => {
		expect(parseUnicodeRange('name:0x100:0x50')).toBeNull(); // start > end
		expect(parseUnicodeRange('name:-1:0x100')).toBeNull();
	});
});

describe('parseUnicodeRanges', () => {
	it('should parse multiple ranges', () => {
		const result = parseUnicodeRanges([
			'Basic_Latin:0x0000:0x007F',
			'CJK:0x4e00:0x9fff'
		]);

		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			name: 'Basic_Latin',
			start: 0x0000,
			end: 0x007f
		});
		expect(result[1]).toEqual({
			name: 'CJK',
			start: 0x4e00,
			end: 0x9fff
		});
	});

	it('should skip invalid ranges', () => {
		const result = parseUnicodeRanges([
			'Basic_Latin:0x0000:0x007F',
			'invalid',
			'CJK:0x4e00:0x9fff'
		]);

		expect(result).toHaveLength(2);
	});

	it('should return empty array for empty input', () => {
		const result = parseUnicodeRanges([]);
		expect(result).toEqual([]);
	});

	it('should return empty array for all invalid', () => {
		const result = parseUnicodeRanges(['invalid1', 'invalid2']);
		expect(result).toEqual([]);
	});
});

describe('Range coverage', () => {
	it('should cover common characters', () => {
		// ASCII
		const ascii = UNICODE_RANGES.find((r) => 0x41 >= r.start && 0x41 <= r.end);
		expect(ascii).toBeDefined();

		// Latin-1 Supplement
		const latin1 = UNICODE_RANGES.find((r) => 0x00c0 >= r.start && 0x00c0 <= r.end);
		expect(latin1).toBeDefined();

		// Greek
		const greek = UNICODE_RANGES.find((r) => 0x03b1 >= r.start && 0x03b1 <= r.end); // alpha
		expect(greek).toBeDefined();

		// Cyrillic
		const cyrillic = UNICODE_RANGES.find((r) => 0x0430 >= r.start && 0x0430 <= r.end); // а
		expect(cyrillic).toBeDefined();

		// Hiragana
		const hiragana = UNICODE_RANGES.find((r) => 0x3042 >= r.start && 0x3042 <= r.end); // あ
		expect(hiragana).toBeDefined();

		// CJK
		const cjk = UNICODE_RANGES.find((r) => 0x4e2d >= r.start && 0x4e2d <= r.end); // 中
		expect(cjk).toBeDefined();
	});
});
