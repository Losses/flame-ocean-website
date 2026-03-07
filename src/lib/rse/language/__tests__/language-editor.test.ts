/**
 * Language Editor Comprehensive Tests
 *
 * Tests for language extraction, replacement, and knock down operations.
 * Uses Unicorn emulator for firmware safety verification.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
	LanguageExtractor,
	LanguagePatcher,
	LanguageUnicornVerifier,
	LANGUAGE_CONSTANTS,
	isLanguageProtected,
	getLanguageEncoding,
	isValidLanguageIndex
} from '../index.js';
import {
	ProtectedLanguageError,
	InvalidLanguageIndexError,
	StringTooLongError
} from '../errors.js';

// Test configuration
const FIRMWARE_BASE = '/tmp/echo-mini-firmwares';
const TEMP_DIR = '/tmp/language-editor-tests';
const FIRMWARE_PATH = join(FIRMWARE_BASE, 'ECHO MINI V3.1.0/ECHO MINI V3.1.0/HIFIEC10.IMG');

// Check if firmware exists
const firmwareExists = existsSync(FIRMWARE_PATH);

describe('Language Editor', () => {
	beforeAll(() => {
		// Create temp directory
		if (!existsSync(TEMP_DIR)) {
			mkdirSync(TEMP_DIR, { recursive: true });
		}
	});

	afterAll(() => {
		// Clean up temp directory
		if (existsSync(TEMP_DIR)) {
			rmSync(TEMP_DIR, { recursive: true, force: true });
		}
	});

	describe('LanguageExtractor', () => {
		it.skipIf(!firmwareExists)('should extract language system info', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const extractor = new LanguageExtractor(firmwareData, 'V3.1.0');

			const result = extractor.extract();

			expect(result.success).toBe(true);
			expect(result.systemInfo).toBeDefined();
			expect(result.systemInfo?.languageCount).toBe(21);
			expect(result.systemInfo?.languages).toHaveLength(21);
		});

		it.skipIf(!firmwareExists)('should list all languages', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const extractor = new LanguageExtractor(firmwareData, 'V3.1.0');

			const languages = extractor.listLanguages();

			expect(languages.length).toBe(21);
			expect(languages[0]?.name).toBe('简体中文');
			expect(languages[2]?.name).toBe('English');
		});

		it.skipIf(!firmwareExists)('should get specific language', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const extractor = new LanguageExtractor(firmwareData, 'V3.1.0');

			const english = extractor.getLanguage(2);

			expect(english).toBeDefined();
			expect(english?.name).toBe('English');
			expect(english?.encoding).toBe('utf-16-le');
			expect(english?.isProtected).toBe(true);
		});

		it.skipIf(!firmwareExists)('should extract menu strings', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const extractor = new LanguageExtractor(firmwareData, 'V3.1.0');

			const strings = extractor.getMenuStrings(2); // English

			expect(strings.length).toBeGreaterThan(0);
			expect(strings[0]?.hasPrefix).toBe(true);
			expect(strings[0]?.content).toBeDefined();
		});

		it.skipIf(!firmwareExists)('should analyze language system', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const extractor = new LanguageExtractor(firmwareData, 'V3.1.0');

			const analysis = extractor.analyze();

			expect(analysis.languageCount).toBe(21);
			expect(analysis.totalMenuPoolSize).toBeGreaterThan(0);
			// totalNameTableSize is languageCount * ENTRY_SIZE
			expect(analysis.totalNameTableSize).toBe(21 * 0x102);
		});
	});

	describe('LanguagePatcher', () => {
		it.skipIf(!firmwareExists)('should create backup', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			const backup = patcher.createBackup();

			expect(backup.length).toBe(firmwareData.length);
			expect(backup).toEqual(new Uint8Array(firmwareData));
		});

		it.skipIf(!firmwareExists)('should restore backup', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			patcher.createBackup();
			const restored = patcher.restoreBackup();

			expect(restored).toBe(true);
		});

		it.skipIf(!firmwareExists)('should replace menu string', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			// Replace English string with force to bypass protection
			const result = patcher.replaceEntry({
				languageIndex: 2, // English
				stringIndex: 0,
				newString: 'Test',
				force: true
			});

			expect(result.success).toBe(true);
			expect(result.newString).toBe('Test');
			expect(result.modification).toBeDefined();
		});

		it.skipIf(!firmwareExists)('should throw for string too long', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			// Create a very long string (UTF-16: 200 chars * 2 bytes = 400 bytes, way over 256 byte limit)
			const longString = 'A'.repeat(200);

			// Use a non-protected language (index 5 = Français)
			expect(() => patcher.replaceEntry({
				languageIndex: 5, // Français - not protected
				stringIndex: 0,
				newString: longString,
				force: false // Don't force, should throw
			})).toThrow(StringTooLongError);
		});

		it.skipIf(!firmwareExists)('should throw for protected language knock down', () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			expect(async () => {
				await patcher.knockDownLanguage({
					languageIndex: 0, // Chinese - protected
					createBackup: true,
					dryRun: true
				});
			}).toThrow(ProtectedLanguageError);
		});

		it.skipIf(!firmwareExists)('should verify knock down is safe', async () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			// Check a safe language to knock down (e.g., Hollands at index 15)
			const verification = await patcher.verifyKnockDown(15);

			expect(verification.safe).toBe(true);
			expect(verification.errors).toHaveLength(0);
		});

		it.skipIf(!firmwareExists)('should verify knock down is unsafe for protected', async () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			// Check a protected language (English at index 2)
			const verification = await patcher.verifyKnockDown(2);

			expect(verification.safe).toBe(false);
			expect(verification.errors.length).toBeGreaterThan(0);
		});

		it.skipIf(!firmwareExists)('should perform dry run knock down', async () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const patcher = new LanguagePatcher(firmwareData, 'V3.1.0');

			const result = await patcher.knockDownLanguage({
				languageIndex: 15, // Hollands
				createBackup: true,
				dryRun: true
			});

			expect(result.success).toBe(true);
			expect(result.freedBytes).toBeGreaterThan(0);
			expect(result.newLanguageCount).toBe(20);

			// Verify data wasn't actually modified (dry run)
			const currentData = patcher.getData();
			expect(new Uint8Array(currentData)).toEqual(new Uint8Array(firmwareData));
		});
	});

	describe('LanguageUnicornVerifier', () => {
		it.skipIf(!firmwareExists)('should verify language system', async () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const verifier = new LanguageUnicornVerifier(join(TEMP_DIR, 'unicorn'));

			const result = await verifier.verifyLanguageSystem(
				new Uint8Array(firmwareData),
				21 // Expected language count
			);

			expect(result.passed).toBe(true);
			expect(result.testCases.length).toBeGreaterThan(0);
		});

		it.skipIf(!firmwareExists)('should verify language access', async () => {
			const firmwareData = readFileSync(FIRMWARE_PATH);
			const verifier = new LanguageUnicornVerifier(join(TEMP_DIR, 'unicorn'));

			const result = await verifier.verifyLanguageAccess(
				new Uint8Array(firmwareData),
				2, // English
				0  // First string
			);

			expect(result.passed).toBe(true);
		});
	});

	describe('Utility Functions', () => {
		it('should identify protected languages', () => {
			expect(isLanguageProtected(0)).toBe(true);  // Chinese
			expect(isLanguageProtected(2)).toBe(true);  // English
			expect(isLanguageProtected(1)).toBe(false); // Traditional Chinese
			expect(isLanguageProtected(15)).toBe(false); // Hollands
		});

		it('should get correct encoding', () => {
			expect(getLanguageEncoding(0)).toBe('utf-16-be'); // Chinese (CJK)
			expect(getLanguageEncoding(1)).toBe('utf-16-be'); // Traditional Chinese (CJK)
			expect(getLanguageEncoding(2)).toBe('utf-16-le'); // English
			expect(getLanguageEncoding(3)).toBe('utf-16-be'); // Japanese (CJK)
			expect(getLanguageEncoding(4)).toBe('utf-16-be'); // Korean (CJK)
			expect(getLanguageEncoding(5)).toBe('utf-16-le'); // French
		});

		it('should validate language index', () => {
			expect(isValidLanguageIndex(0)).toBe(true);
			expect(isValidLanguageIndex(20)).toBe(true);
			expect(isValidLanguageIndex(-1)).toBe(false);
			expect(isValidLanguageIndex(21)).toBe(false);
			expect(isValidLanguageIndex(1.5)).toBe(false);
		});

		it('should have correct constants', () => {
			// These constants are still defined
			expect(LANGUAGE_CONSTANTS.POOL_SPACING).toBe(0x1C584);
			expect(LANGUAGE_CONSTANTS.ENTRY_SIZE).toBe(0x102);
			expect(LANGUAGE_CONSTANTS.MAX_LANGUAGES).toBe(21);
		});
	});

	describe('Constants', () => {
		it('should have correct language names', () => {
			expect(LANGUAGE_CONSTANTS.LANGUAGE_NAMES[0]).toBe('简体中文');
			expect(LANGUAGE_CONSTANTS.LANGUAGE_NAMES[2]).toBe('English');
			expect(LANGUAGE_CONSTANTS.LANGUAGE_NAMES[20]).toBe('Arabic');
		});

		it('should identify CJK languages', () => {
			expect(LANGUAGE_CONSTANTS.CJK_LANGUAGES).toContain(0); // Chinese
			expect(LANGUAGE_CONSTANTS.CJK_LANGUAGES).toContain(3); // Japanese
			expect(LANGUAGE_CONSTANTS.CJK_LANGUAGES).toContain(4); // Korean
			expect(LANGUAGE_CONSTANTS.CJK_LANGUAGES).not.toContain(2); // English
		});
	});
});

describe('Language Editor Integration Tests', () => {
	it.skipIf(!firmwareExists)('should perform complete knock down workflow', async () => {
		const firmwareData = readFileSync(FIRMWARE_PATH);
		const originalData = new Uint8Array(firmwareData);
		const patcher = new LanguagePatcher(originalData, 'V3.1.0');

		// 1. Extract initial state
		const extractor = patcher.getExtractor();
		const initialResult = extractor.extract();
		expect(initialResult.success).toBe(true);
		expect(initialResult.systemInfo?.languageCount).toBe(21);

		// 2. Verify knock down is safe
		const verification = await patcher.verifyKnockDown(15); // Hollands
		expect(verification.safe).toBe(true);

		// 3. Create backup
		const backup = patcher.createBackup();

		// 4. Perform knock down (dry run to avoid modifying real data)
		const result = await patcher.knockDownLanguage({
			languageIndex: 15,
			createBackup: false, // Already created
			dryRun: true
		});

		expect(result.success).toBe(true);
		expect(result.freedBytes).toBe(LANGUAGE_CONSTANTS.ENTRY_SIZE + LANGUAGE_CONSTANTS.POOL_SPACING);

		// 5. Verify backup still matches original
		expect(backup).toEqual(originalData);
	});

	it.skipIf(!firmwareExists)('should replace string and verify integrity', () => {
		const firmwareData = readFileSync(FIRMWARE_PATH);
		const patcher = new LanguagePatcher(new Uint8Array(firmwareData), 'V3.1.0');

		// Replace a string
		const result = patcher.replaceEntry({
			languageIndex: 2, // English
			stringIndex: 0,
			newString: 'Modified',
			force: true
		});

		expect(result.success).toBe(true);
		expect(result.newString).toBe('Modified');

		// Verify entry size is maintained
		expect(result.modification.newBytes.length).toBe(LANGUAGE_CONSTANTS.ENTRY_SIZE);

		// Verify FF FF prefix is present
		expect(result.modification.newBytes[0]).toBe(0xFF);
		expect(result.modification.newBytes[1]).toBe(0xFF);
	});
});

describe('Error Handling', () => {
	it('should throw InvalidLanguageIndexError for invalid index', () => {
		expect(() => {
			throw new InvalidLanguageIndexError(100, 21);
		}).toThrow('Invalid language index 100');
	});

	it('should throw ProtectedLanguageError for protected language', () => {
		expect(() => {
			throw new ProtectedLanguageError(0, '简体中文');
		}).toThrow('Cannot modify protected language');
	});

	it('should throw StringTooLongError for oversized string', () => {
		expect(() => {
			throw new StringTooLongError(300, 256);
		}).toThrow('String too long');
	});
});
