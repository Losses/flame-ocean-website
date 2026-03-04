/**
 * Language Editor Module
 *
 * Provides multi-language string extraction, replacement, and deletion
 * functionality for ECHO MINI firmware.
 *
 * ## Features
 *
 * - List all languages in firmware
 * - Extract language names and menu strings
 * - Replace language entries (menu strings and names)
 * - Safely knock down languages with data rearrangement
 * - Full Unicorn emulator verification
 *
 * ## Usage
 *
 * ```typescript
 * import { LanguageExtractor, LanguagePatcher, LanguageUnicornVerifier } from './language';
 *
 * // Extract language information
 * const extractor = new LanguageExtractor(firmwareData);
 * const result = extractor.extract();
 * if (result.success) {
 *   console.log(`Found ${result.systemInfo.languageCount} languages`);
 *   for (const lang of result.systemInfo.languages) {
 *     console.log(`  ${lang.index}: ${lang.name} (${lang.stringCount} strings)`);
 *   }
 * }
 *
 * // Replace a string
 * const patcher = new LanguagePatcher(firmwareData);
 * const replaceResult = patcher.replaceEntry({
 *   languageIndex: 2,  // English
 *   stringIndex: 0,    // First string
 *   newString: 'Custom Title'
 * });
 *
 * // Knock down a language
 * const knockDownResult = await patcher.knockDownLanguage({
 *   languageIndex: 15, // Hollands
 *   createBackup: true,
 *   verifyWithUnicorn: true
 * });
 * ```
 *
 * ## Safety
 *
 * All operations include validation and verification:
 *
 * 1. **Protected Languages**: Chinese (0) and English (2) cannot be knocked down
 * 2. **Entry Size**: All entries maintain 0x102 byte size
 * 3. **NULL Termination**: Strings are properly NULL-terminated
 * 4. **Unicorn Verification**: Firmware is verified with ARM emulator
 * 5. **Backup/Rollback**: Automatic backup and rollback on failure
 */

// Types
export {
	type LanguageInfo,
	type LanguageSystemInfo,
	type LanguageNameEntry,
	type MenuStringEntry,
	type LanguageEncoding,
	type LanguageEntryType,
	type LanguageReplacementOptions,
	type LanguageReplacementResult,
	type LanguageKnockDownOptions,
	type LanguageKnockDownResult,
	type LanguageExtractionResult,
	type AddressModification,
	type UnicornVerificationResult,
	type UnicornTestCase,
	LANGUAGE_CONSTANTS,
	getLanguageEncoding,
	isLanguageProtected,
	calculateNameEntryAddress,
	calculatePoolAddress,
	calculateStringEntryAddress,
	isValidLanguageIndex,
	validateStringContent
} from './types.js';

// Errors
export {
	LanguageError,
	InvalidLanguageIndexError,
	ProtectedLanguageError,
	StringTooLongError,
	LanguageSystemNotFoundError,
	LanguageKnockDownError,
	DataRearrangementError,
	UnicornVerificationError,
	EntryValidationError,
	LanguageEncodingError,
	isLanguageError,
	getLanguageErrorMessage
} from './errors.js';

// Extractor
export { LanguageExtractor } from './extractor.js';

// Patcher
export { LanguagePatcher } from './patcher.js';

// Verifier
export { LanguageUnicornVerifier } from './verifier.js';
