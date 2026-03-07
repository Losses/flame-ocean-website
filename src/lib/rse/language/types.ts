/**
 * Language Editor Type Definitions
 *
 * Types for multi-language string extraction, replacement, and deletion.
 * Based on ECHO MINI V3.1.0 firmware reverse engineering documentation.
 */

/**
 * Language encoding type
 */
export type LanguageEncoding = 'utf-16-le' | 'utf-16-be';

/**
 * Language entry type - determines format
 */
export type LanguageEntryType = 'name' | 'menu';

/**
 * Language name entry (no FF FF prefix)
 *
 * Format:
 * - UTF-16 LE string content
 * - NULL terminator (00 00)
 * - Padding to 0x102 bytes
 */
export interface LanguageNameEntry {
	/** Entry type */
	readonly type: 'name';
	/** Entry address in firmware */
	readonly address: number;
	/** Language index (0-20) */
	readonly index: number;
	/** Language name string */
	readonly name: string;
	/** Encoding used */
	readonly encoding: LanguageEncoding;
	/** Raw bytes (0x102 bytes) */
	readonly rawBytes: Uint8Array;
}

/**
 * Menu string entry (has FF FF prefix)
 *
 * Format:
 * - FF FF prefix (2 bytes)
 * - UTF-16 string content
 * - NULL terminator (00 00)
 * - Padding to 0x102 bytes
 */
export interface MenuStringEntry {
	/** Entry type */
	readonly type: 'menu';
	/** Entry address in firmware */
	readonly address: number;
	/** Language index (0-20) */
	readonly languageIndex: number;
	/** String index within language pool */
	readonly stringIndex: number;
	/** String content */
	readonly content: string;
	/** Encoding used */
	readonly encoding: LanguageEncoding;
	/** Raw bytes (0x102 bytes) */
	readonly rawBytes: Uint8Array;
	/** Whether this entry has FF FF prefix */
	readonly hasPrefix: boolean;
}

/**
 * Complete language information
 */
export interface LanguageInfo {
	/** Language index (0-20) */
	readonly index: number;
	/** Language name */
	readonly name: string;
	/** Language name entry address */
	readonly nameAddress: number;
	/** Menu string pool start address */
	readonly poolAddress: number;
	/** Menu string pool size in bytes */
	readonly poolSize: number;
	/** Number of menu strings in pool */
	readonly stringCount: number;
	/** Encoding for this language */
	readonly encoding: LanguageEncoding;
	/** All menu strings for this language */
	readonly strings: readonly MenuStringEntry[];
	/** Is this a protected language (Chinese, English) */
	readonly isProtected: boolean;
}

/**
 * Language system metadata
 */
export interface LanguageSystemInfo {
	/** Firmware version */
	readonly version: string;
	/** Total number of languages */
	readonly languageCount: number;
	/** Language name table address */
	readonly nameTableAddress: number;
	/** Language name table size */
	readonly nameTableSize: number;
	/** First menu pool address */
	readonly firstPoolAddress: number;
	/** Per-language pool size */
	readonly poolSpacing: number;
	/** Language count check address (CMP instruction) */
	readonly languageCountCheckAddress: number;
	/** Original language count value */
	readonly originalLanguageCountValue: number;
	/** All languages */
	readonly languages: readonly LanguageInfo[];
}

/**
 * Language replacement options
 */
export interface LanguageReplacementOptions {
	/** Language index to replace */
	readonly languageIndex: number;
	/** String index to replace (-1 for language name) */
	readonly stringIndex: number;
	/** New string content */
	readonly newString: string;
	/** Force replacement even if string is longer */
	readonly force?: boolean;
}

/**
 * Language knock down options
 */
export interface LanguageKnockDownOptions {
	/** Language index to knock down */
	readonly languageIndex: number;
	/** Create backup before operation */
	readonly createBackup?: boolean;
	/** Verify with Unicorn emulator */
	readonly verifyWithUnicorn?: boolean;
	/** Dry run - don't actually modify */
	readonly dryRun?: boolean;
}

/**
 * Language knock down result
 */
export interface LanguageKnockDownResult {
	/** Success status */
	readonly success: boolean;
	/** Language that was knocked down */
	readonly languageIndex: number;
	/** Language name that was removed */
	readonly languageName: string;
	/** Space freed in bytes */
	readonly freedBytes: number;
	/** New language count */
	readonly newLanguageCount: number;
	/** Modified addresses */
	readonly modifications: readonly AddressModification[];
	/** Original data backup (if requested) */
	readonly backup?: Uint8Array;
	/** Unicorn verification result */
	readonly unicornResult?: UnicornVerificationResult;
	/** Error message if failed */
	readonly error?: string;
}

/**
 * Address modification record
 */
export interface AddressModification {
	/** Address that was modified */
	readonly address: number;
	/** Description of modification */
	readonly description: string;
	/** Original bytes */
	readonly originalBytes: Uint8Array;
	/** New bytes */
	readonly newBytes: Uint8Array;
}

/**
 * Unicorn verification result
 */
export interface UnicornVerificationResult {
	/** Whether verification passed */
	readonly passed: boolean;
	/** Test cases run */
	readonly testCases: readonly UnicornTestCase[];
	/** Error details if failed */
	readonly errors: readonly string[];
}

/**
 * Individual Unicorn test case
 */
export interface UnicornTestCase {
	/** Test case name */
	readonly name: string;
	/** Whether test passed */
	readonly passed: boolean;
	/** Execution output */
	readonly output: string;
	/** Error if failed */
	readonly error?: string;
}

/**
 * Language extraction result
 */
export interface LanguageExtractionResult {
	/** Success status */
	readonly success: boolean;
	/** Language system info */
	readonly systemInfo?: LanguageSystemInfo;
	/** Error message if failed */
	readonly error?: string;
}

/**
 * Language replacement result
 */
export interface LanguageReplacementResult {
	/** Success status */
	readonly success: boolean;
	/** Entry that was modified */
	readonly entry: MenuStringEntry | LanguageNameEntry;
	/** Original string */
	readonly originalString: string;
	/** New string */
	readonly newString: string;
	/** Address modification */
	readonly modification: AddressModification;
	/** Error message if failed */
	readonly error?: string;
}

/**
 * Constants for language system
 *
 * IMPORTANT: All addresses are DISCOVERED DYNAMICALLY at runtime.
 * There are NO fallback hardcoded addresses - if discovery fails, the operation fails.
 *
 * Discovery methods:
 * - Name table: Search for UTF-16 LE "简体中文" pattern in firmware
 * - First pool: Relative to name table, validated by FF FF prefix
 * - Count check: Search for CMP R0, #N instruction followed by conditional branch
 */
export const LANGUAGE_CONSTANTS = {
	/** Entry size in bytes (258) */
	ENTRY_SIZE: 0x102,

	/** Menu string prefix */
	PREFIX: 0xFFFF,

	/** Per-language pool spacing */
	POOL_SPACING: 0x1C584,

	/** Maximum languages supported */
	MAX_LANGUAGES: 21,

	/** Protected language indices (cannot be knocked down) */
	PROTECTED_LANGUAGES: [0, 2], // Chinese, English

	/** Language names in order */
	LANGUAGE_NAMES: [
		'简体中文', '繁體中文', 'English', '日本語', '한글',
		'Français', 'Deutsch', 'Italiano', 'Spanish', 'Português',
		'Русский', 'Svenska', 'ภาษาไทย', 'język polski', 'Dansk',
		'Hollands', 'Ελληνικά', 'Čeština', 'Türkçe', 'עברית', 'Arabic'
	] as const,

	/** CJK languages that use UTF-16 BE */
	CJK_LANGUAGES: [0, 1, 3, 4, 12], // Chinese (Simplified/Traditional), Japanese, Korean, Thai
} as const;

/**
 * Determine encoding for a language
 */
export function getLanguageEncoding(languageIndex: number): LanguageEncoding {
	// CJK languages use UTF-16 BE, others use UTF-16 LE
	if (LANGUAGE_CONSTANTS.CJK_LANGUAGES.includes(languageIndex as any)) {
		return 'utf-16-be';
	}
	return 'utf-16-le';
}

/**
 * Check if a language is protected
 */
export function isLanguageProtected(languageIndex: number): boolean {
	return LANGUAGE_CONSTANTS.PROTECTED_LANGUAGES.includes(languageIndex as any);
}

/**
 * Calculate string entry address within a pool
 * Note: poolAddress must be provided by caller (from dynamic discovery)
 */
export function calculateStringEntryAddress(poolAddress: number, stringIndex: number): number {
	return poolAddress + stringIndex * LANGUAGE_CONSTANTS.ENTRY_SIZE;
}

/**
 * Validate language index
 */
export function isValidLanguageIndex(index: number): boolean {
	return Number.isInteger(index) && index >= 0 && index < LANGUAGE_CONSTANTS.MAX_LANGUAGES;
}

/**
 * Validate string content for replacement
 */
export function validateStringContent(content: string, encoding: LanguageEncoding): {
	valid: boolean;
	encodedLength: number;
	error?: string;
} {
	// Encode string
	const encoded = encoding === 'utf-16-le'
		? new TextEncoder().encode(content) // Actually need proper UTF-16 LE encoding
		: new TextEncoder().encode(content);

	// For UTF-16, each character is 2 bytes + NULL terminator
	const byteLength = content.length * 2 + 2;

	// Max available space is ENTRY_SIZE - 2 (prefix) - 2 (NULL)
	const maxSpace = LANGUAGE_CONSTANTS.ENTRY_SIZE - 4;

	if (byteLength > maxSpace) {
		return {
			valid: false,
			encodedLength: byteLength,
			error: `String too long: ${byteLength} bytes > ${maxSpace} max`
		};
	}

	return {
		valid: true,
		encodedLength: byteLength
	};
}
