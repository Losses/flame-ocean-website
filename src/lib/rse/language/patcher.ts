/**
 * Language Patcher
 *
 * Provides functionality to replace language entries and safely knock down languages
 * with complete data rearrangement and firmware safety verification.
 */

import {
	type LanguageInfo,
	type LanguageReplacementOptions,
	type LanguageReplacementResult,
	type LanguageKnockDownOptions,
	type LanguageKnockDownResult,
	type AddressModification,
	type MenuStringEntry,
	type LanguageNameEntry,
	type LanguageEncoding,
	type LanguageSystemInfo,
	LANGUAGE_CONSTANTS,
	getLanguageEncoding,
	isLanguageProtected,
	isValidLanguageIndex
} from './types.js';
import { LanguageExtractor } from './extractor.js';
import {
	LanguageError,
	InvalidLanguageIndexError,
	ProtectedLanguageError,
	StringTooLongError,
	LanguageKnockDownError,
	DataRearrangementError,
	UnicornVerificationError,
	EntryValidationError,
	AddressValidationError
} from './errors.js';

/**
 * Language Patcher Class
 *
 * Handles language replacement and knock down operations with safety verification.
 */
export class LanguagePatcher {
	private data: Uint8Array;
	private readonly version: string;
	private readonly extractor: LanguageExtractor;
	private originalData: Uint8Array | null = null;
	private addressValidationCache: { valid: boolean; error?: AddressValidationError } | null = null;

	/**
	 * Create a new LanguagePatcher
	 */
	constructor(firmwareData: Uint8Array, version = 'Unknown') {
		this.data = new Uint8Array(firmwareData);
		this.version = version;
		this.extractor = new LanguageExtractor(this.data, version);
	}

	/**
	 * Validate that language system was discovered successfully
	 *
	 * Uses dynamic address discovery via LanguageExtractor instead of hardcoded addresses.
	 *
	 * @throws AddressValidationError if language system cannot be discovered
	 */
	validateHardcodedAddresses(): void {
		if (this.addressValidationCache) {
			if (!this.addressValidationCache.valid && this.addressValidationCache.error) {
				throw this.addressValidationCache.error;
			}
			return;
		}

		// Use extractor's dynamic discovery mechanism
		const systemInfo = this.extractor.getSystemInfo();
		if (!systemInfo) {
			const error = new AddressValidationError(
				0,
				'Language system',
				new Uint8Array(0),
				`Language system not found in firmware. ` +
				`Cannot find Chinese language name pattern "简体中文". ` +
				`This firmware version may not support the language system or uses a different format.`
			);
			this.addressValidationCache = { valid: false, error };
			throw error;
		}

		// Validate discovered addresses
		const nameTableAddr = systemInfo.nameTableAddress;
		if (nameTableAddr + 4 > this.data.length) {
			const error = new AddressValidationError(
				nameTableAddr,
				'UTF-16 language name data',
				new Uint8Array(0),
				`Discovered name table address 0x${nameTableAddr.toString(16)} is outside firmware bounds.`
			);
			this.addressValidationCache = { valid: false, error };
			throw error;
		}

		const firstPoolAddr = systemInfo.firstPoolAddress;
		if (firstPoolAddr + 2 > this.data.length) {
			const error = new AddressValidationError(
				firstPoolAddr,
				'FF FF menu string prefix',
				new Uint8Array(0),
				`Discovered first pool address 0x${firstPoolAddr.toString(16)} is outside firmware bounds.`
			);
			this.addressValidationCache = { valid: false, error };
			throw error;
		}

		// Note: languageCountCheckAddress is optional - only needed for knock down operations
		// It will be validated separately in knockDownLanguage methods

		this.addressValidationCache = { valid: true };
	}

	/**
	 * Get the discovered name table address
	 * @throws AddressValidationError if not discovered
	 */
	private getNameTableAddress(): number {
		const systemInfo = this.extractor.getSystemInfo();
		if (!systemInfo) {
			throw new AddressValidationError(
				0,
				'Language system',
				new Uint8Array(0),
				'Language system not discovered. Cannot determine name table address.'
			);
		}
		return systemInfo.nameTableAddress;
	}

	/**
	 * Get the discovered first pool address
	 * @throws AddressValidationError if not discovered
	 */
	private getFirstPoolAddress(): number {
		const systemInfo = this.extractor.getSystemInfo();
		if (!systemInfo) {
			throw new AddressValidationError(
				0,
				'Language system',
				new Uint8Array(0),
				'Language system not discovered. Cannot determine first pool address.'
			);
		}
		return systemInfo.firstPoolAddress;
	}

	/**
	 * Get the discovered language count check address
	 * @throws AddressValidationError if not discovered
	 */
	private getLanguageCountCheckAddress(): number {
		const systemInfo = this.extractor.getSystemInfo();
		if (!systemInfo) {
			throw new AddressValidationError(
				0,
				'Language system',
				new Uint8Array(0),
				'Language system not discovered. Cannot determine language count check address.'
			);
		}
		if (systemInfo.languageCountCheckAddress === 0) {
			throw new AddressValidationError(
				0,
				'CMP R0, #N instruction for language count check',
				new Uint8Array(0),
				`Language count check instruction not found. ` +
				`Cannot perform knock down operation without this address. ` +
				`This firmware version may have a different language count check implementation.`
			);
		}
		return systemInfo.languageCountCheckAddress;
	}

	/**
	 * Get the current firmware data
	 */
	getData(): Uint8Array {
		return this.data;
	}

	/**
	 * Get the language extractor
	 */
	getExtractor(): LanguageExtractor {
		return this.extractor;
	}

	/**
	 * Create a backup of current firmware state
	 */
	createBackup(): Uint8Array {
		this.originalData = new Uint8Array(this.data);
		return this.originalData;
	}

	/**
	 * Restore from backup
	 */
	restoreBackup(): boolean {
		if (!this.originalData) {
			return false;
		}
		this.data = new Uint8Array(this.originalData);
		return true;
	}

	/**
	 * Replace a language entry (name or menu string)
	 */
	replaceEntry(options: LanguageReplacementOptions): LanguageReplacementResult {
		const { languageIndex, stringIndex, newString, force = false } = options;

		// Validate hardcoded addresses before using them
		this.validateHardcodedAddresses();

		// Validate language index
		if (!isValidLanguageIndex(languageIndex)) {
			throw new InvalidLanguageIndexError(languageIndex, LANGUAGE_CONSTANTS.MAX_LANGUAGES);
		}

		// Check protection
		if (isLanguageProtected(languageIndex) && !force) {
			const langInfo = this.extractor.getLanguage(languageIndex);
			throw new ProtectedLanguageError(languageIndex, langInfo?.name ?? 'Unknown');
		}

		const encoding = getLanguageEncoding(languageIndex);

		if (stringIndex === -1) {
			// Replace language name
			return this.replaceLanguageName(languageIndex, newString, encoding, force);
		} else {
			// Replace menu string
			return this.replaceMenuString(languageIndex, stringIndex, newString, encoding, force);
		}
	}

	/**
	 * Replace language name entry
	 */
	private replaceLanguageName(
		languageIndex: number,
		newString: string,
		encoding: LanguageEncoding,
		force: boolean
	): LanguageReplacementResult {
		const nameTableAddr = this.getNameTableAddress();
		const address = nameTableAddr + languageIndex * LANGUAGE_CONSTANTS.ENTRY_SIZE;

		// Get original entry
		const originalEntry = this.extractor.getLanguage(languageIndex);
		if (!originalEntry) {
			throw new LanguageError(`Language ${languageIndex} not found`);
		}

		const originalString = originalEntry.name;

		// Encode new string
		const encoded = this.encodeUtf16String(newString, encoding);
		const totalLength = encoded.length + 2; // +2 for NULL terminator

		// Check size (language names don't have FF FF prefix)
		const maxSpace = LANGUAGE_CONSTANTS.ENTRY_SIZE - 2;
		if (totalLength > maxSpace) {
			if (!force) {
				throw new StringTooLongError(totalLength, maxSpace);
			}
			// If force is true, truncate the string
			encoded.fill(0, maxSpace - 2);
		}

		// Read original bytes for modification record
		const originalBytes = this.data.slice(address, address + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		// Create new entry
		const newEntry = new Uint8Array(LANGUAGE_CONSTANTS.ENTRY_SIZE);
		newEntry.set(encoded.slice(0, maxSpace), 0);
		// NULL terminator is already zeros
		// Rest is already zeros (padding)

		// Apply change
		this.data.set(newEntry, address);

		// Validate new entry
		const validation = this.extractor.validateEntry(address, false);
		if (!validation.valid) {
			// Rollback
			this.data.set(originalBytes, address);
			throw new EntryValidationError(address, validation.error ?? 'Unknown error');
		}

		const newBytes = this.data.slice(address, address + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		return {
			success: true,
			entry: {
				type: 'name',
				address,
				index: languageIndex,
				name: newString,
				encoding,
				rawBytes: newBytes
			},
			originalString,
			newString,
			modification: {
				address,
				description: `Replaced language name at index ${languageIndex}`,
				originalBytes,
				newBytes
			}
		};
	}

	/**
	 * Replace menu string entry
	 */
	private replaceMenuString(
		languageIndex: number,
		stringIndex: number,
		newString: string,
		encoding: LanguageEncoding,
		force: boolean
	): LanguageReplacementResult {
		const firstPoolAddr = this.getFirstPoolAddress();
		const poolAddress = firstPoolAddr + languageIndex * LANGUAGE_CONSTANTS.POOL_SPACING;
		const address = poolAddress + stringIndex * LANGUAGE_CONSTANTS.ENTRY_SIZE;

		// Get original entry
		const originalEntry = this.extractor.getMenuString(languageIndex, stringIndex);
		if (!originalEntry) {
			throw new LanguageError(`Menu string ${stringIndex} not found in language ${languageIndex}`);
		}

		const originalString = originalEntry.content;

		// Encode new string
		const encoded = this.encodeUtf16String(newString, encoding);
		const totalLength = 2 + encoded.length + 2; // FF FF prefix + string + NULL terminator

		// Check size
		const maxSpace = LANGUAGE_CONSTANTS.ENTRY_SIZE - 2; // -2 for FF FF prefix
		if (totalLength > maxSpace) {
			if (!force) {
				throw new StringTooLongError(totalLength, maxSpace);
			}
			// If force is true, truncate the string
		}

		// Read original bytes
		const originalBytes = this.data.slice(address, address + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		// Create new entry with FF FF prefix
		const newEntry = new Uint8Array(LANGUAGE_CONSTANTS.ENTRY_SIZE);
		newEntry[0] = 0xFF;
		newEntry[1] = 0xFF;
		// Set encoded string, truncated if necessary
		const maxEncodedLength = LANGUAGE_CONSTANTS.ENTRY_SIZE - 4; // -2 for prefix, -2 for NULL
		newEntry.set(encoded.slice(0, maxEncodedLength), 2);
		// NULL terminator and padding are already zeros

		// Apply change
		this.data.set(newEntry, address);

		// Validate new entry
		const validation = this.extractor.validateEntry(address, true);
		if (!validation.valid) {
			// Rollback
			this.data.set(originalBytes, address);
			throw new EntryValidationError(address, validation.error ?? 'Unknown error');
		}

		const newBytes = this.data.slice(address, address + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		return {
			success: true,
			entry: {
				type: 'menu',
				address,
				languageIndex,
				stringIndex,
				content: newString,
				encoding,
				rawBytes: newBytes,
				hasPrefix: true
			},
			originalString,
			newString,
			modification: {
				address,
				description: `Replaced menu string ${stringIndex} in language ${languageIndex}`,
				originalBytes,
				newBytes
			}
		};
	}

	/**
	 * Knock down a language (delete and rearrange data)
	 *
	 * This is a CRITICAL operation that:
	 * 1. Removes the language name entry
	 * 2. Removes the menu string pool
	 * 3. Rearranges all subsequent data
	 * 4. Updates the language count check
	 */
	async knockDownLanguage(options: LanguageKnockDownOptions): Promise<LanguageKnockDownResult> {
		const {
			languageIndex,
			createBackup = true,
			verifyWithUnicorn = true,
			dryRun = false
		} = options;

		// Validate hardcoded addresses before using them
		this.validateHardcodedAddresses();

		// Validate language index
		if (!isValidLanguageIndex(languageIndex)) {
			throw new InvalidLanguageIndexError(languageIndex, LANGUAGE_CONSTANTS.MAX_LANGUAGES);
		}

		// Check protection
		if (isLanguageProtected(languageIndex)) {
			const langInfo = this.extractor.getLanguage(languageIndex);
			throw new ProtectedLanguageError(languageIndex, langInfo?.name ?? 'Unknown');
		}

		// Get language info
		const langInfo = this.extractor.getLanguage(languageIndex);
		if (!langInfo) {
			throw new LanguageError(`Language ${languageIndex} not found`);
		}

		// Create backup if requested
		let backup: Uint8Array | undefined;
		if (createBackup) {
			backup = this.createBackup();
		}

		// Calculate space to be freed
		const nameEntrySize = LANGUAGE_CONSTANTS.ENTRY_SIZE;
		const poolSize = LANGUAGE_CONSTANTS.POOL_SPACING;
		const totalFreedBytes = nameEntrySize + poolSize;

		const modifications: AddressModification[] = [];
		const systemInfo = this.extractor.getSystemInfo();

		try {
			if (!dryRun) {
				// Step 1: Rearrange language name table
				this.rearrangeNameTable(languageIndex, modifications);

				// Step 2: Rearrange menu string pools
				this.rearrangeMenuPools(languageIndex, modifications);

				// Step 3: Update language count check
				this.updateLanguageCountCheck(modifications);

				// Step 4: Clear freed space at the end
				this.clearFreedSpace(languageIndex, modifications);
			}

			// Calculate new language count
			const newLanguageCount = (systemInfo?.languageCount ?? LANGUAGE_CONSTANTS.MAX_LANGUAGES) - 1;

			return {
				success: true,
				languageIndex,
				languageName: langInfo.name,
				freedBytes: totalFreedBytes,
				newLanguageCount,
				modifications,
				backup,
				error: undefined
			};
		} catch (error) {
			// Rollback on error
			if (backup) {
				this.data = new Uint8Array(backup);
			}

			return {
				success: false,
				languageIndex,
				languageName: langInfo.name,
				freedBytes: 0,
				newLanguageCount: systemInfo?.languageCount ?? LANGUAGE_CONSTANTS.MAX_LANGUAGES,
				modifications: [],
				backup,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Synchronous version of knockDownLanguage for use in patching workflows
	 *
	 * This version skips Unicorn verification since it's not needed for the patching use case.
	 */
	knockDownLanguageSync(options: Omit<LanguageKnockDownOptions, 'verifyWithUnicorn'>): LanguageKnockDownResult {
		const {
			languageIndex,
			createBackup = true,
			dryRun = false
		} = options;

		// Validate hardcoded addresses before using them
		this.validateHardcodedAddresses();

		// Validate language index
		if (!isValidLanguageIndex(languageIndex)) {
			throw new InvalidLanguageIndexError(languageIndex, LANGUAGE_CONSTANTS.MAX_LANGUAGES);
		}

		// Check protection
		if (isLanguageProtected(languageIndex)) {
			const langInfo = this.extractor.getLanguage(languageIndex);
			throw new ProtectedLanguageError(languageIndex, langInfo?.name ?? 'Unknown');
		}

		// Get language info
		const langInfo = this.extractor.getLanguage(languageIndex);
		if (!langInfo) {
			throw new LanguageError(`Language ${languageIndex} not found`);
		}

		// Create backup if requested
		let backup: Uint8Array | undefined;
		if (createBackup) {
			backup = this.createBackup();
		}

		// Calculate space to be freed
		const nameEntrySize = LANGUAGE_CONSTANTS.ENTRY_SIZE;
		const poolSize = LANGUAGE_CONSTANTS.POOL_SPACING;
		const totalFreedBytes = nameEntrySize + poolSize;

		const modifications: AddressModification[] = [];
		const systemInfo = this.extractor.getSystemInfo();

		try {
			if (!dryRun) {
				// Step 1: Rearrange language name table
				this.rearrangeNameTable(languageIndex, modifications);

				// Step 2: Rearrange menu string pools
				this.rearrangeMenuPools(languageIndex, modifications);

				// Step 3: Update language count check
				this.updateLanguageCountCheck(modifications);

				// Step 4: Clear freed space at the end
				this.clearFreedSpace(languageIndex, modifications);
			}

			// Calculate new language count
			const newLanguageCount = (systemInfo?.languageCount ?? LANGUAGE_CONSTANTS.MAX_LANGUAGES) - 1;

			return {
				success: true,
				languageIndex,
				languageName: langInfo.name,
				freedBytes: totalFreedBytes,
				newLanguageCount,
				modifications,
				backup,
				error: undefined
			};
		} catch (error) {
			// Rollback on error
			if (backup) {
				this.data = new Uint8Array(backup);
			}

			return {
				success: false,
				languageIndex,
				languageName: langInfo.name,
				freedBytes: 0,
				newLanguageCount: systemInfo?.languageCount ?? LANGUAGE_CONSTANTS.MAX_LANGUAGES,
				modifications: [],
				backup,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Rearrange language name table after deletion
	 */
	private rearrangeNameTable(deletedIndex: number, modifications: AddressModification[]): void {
		const nameTableAddr = this.getNameTableAddress();
		const entrySize = LANGUAGE_CONSTANTS.ENTRY_SIZE;
		const systemInfo = this.extractor.getSystemInfo();

		if (!systemInfo) {
			throw new DataRearrangementError('Cannot get system info for name table rearrangement');
		}

		// Move all entries after deletedIndex forward by one entry
		for (let i = deletedIndex + 1; i < systemInfo.languageCount; i++) {
			const srcAddr = nameTableAddr + i * entrySize;
			const dstAddr = nameTableAddr + (i - 1) * entrySize;

			const originalSrcBytes = this.data.slice(srcAddr, srcAddr + entrySize);
			const originalDstBytes = this.data.slice(dstAddr, dstAddr + entrySize);

			// Move entry
			this.data.set(originalSrcBytes, dstAddr);

			modifications.push({
				address: dstAddr,
				description: `Moved language name entry ${i} to position ${i - 1}`,
				originalBytes: originalDstBytes,
				newBytes: this.data.slice(dstAddr, dstAddr + entrySize)
			});
		}
	}

	/**
	 * Rearrange menu string pools after deletion
	 */
	private rearrangeMenuPools(deletedIndex: number, modifications: AddressModification[]): void {
		const firstPoolAddr = this.getFirstPoolAddress();
		const poolSpacing = LANGUAGE_CONSTANTS.POOL_SPACING;
		const systemInfo = this.extractor.getSystemInfo();

		if (!systemInfo) {
			throw new DataRearrangementError('Cannot get system info for pool rearrangement');
		}

		// Move all pools after deletedIndex forward by one pool spacing
		for (let i = deletedIndex + 1; i < systemInfo.languageCount; i++) {
			const srcAddr = firstPoolAddr + i * poolSpacing;
			const dstAddr = firstPoolAddr + (i - 1) * poolSpacing;

			const originalSrcBytes = this.data.slice(srcAddr, srcAddr + poolSpacing);
			const originalDstBytes = this.data.slice(dstAddr, dstAddr + poolSpacing);

			// Move pool
			this.data.set(originalSrcBytes, dstAddr);

			modifications.push({
				address: dstAddr,
				description: `Moved menu pool ${i} to position ${i - 1}`,
				originalBytes: originalDstBytes,
				newBytes: this.data.slice(dstAddr, dstAddr + poolSpacing)
			});
		}
	}

	/**
	 * Update language count check instruction
	 *
	 * Uses dynamically discovered address from LanguageExtractor.
	 * FAIL-FAST if the address doesn't contain expected CMP R0, #N instruction.
	 */
	private updateLanguageCountCheck(modifications: AddressModification[]): void {
		const checkAddr = this.getLanguageCountCheckAddress();
		const systemInfo = this.extractor.getSystemInfo();

		if (!systemInfo) {
			throw new DataRearrangementError('Cannot get system info for count check update');
		}

		// Check if address was discovered
		if (checkAddr === 0) {
			throw new AddressValidationError(
				0,
				'CMP R0, #N instruction for language count check',
				new Uint8Array(0),
				`Language count check address not discovered. ` +
				`Cannot update language count check without a valid address.`
			);
		}

		// Read current instruction
		const originalBytes = this.data.slice(checkAddr, checkAddr + 2);

		// CRITICAL: Validate this is actually a CMP R0, #N instruction
		// ARM Thumb is little-endian: CMP R0, #N is encoded as [N, 0x28]
		// Example: CMP R0, #20 = 0x2814 -> bytes [0x14, 0x28]
		// The second byte MUST be 0x28 for CMP R0, #N
		if (originalBytes[1] !== 0x28) {
			// This is NOT a CMP R0, #N instruction!
			// It could be a BL instruction (0xF7xx, 0xF8xx) or something else
			// FAIL-FAST: Throw error instead of silently skipping
			throw new AddressValidationError(
				checkAddr,
				'CMP R0, #N instruction ([N, 0x28])',
				originalBytes,
				`Language count check address 0x${checkAddr.toString(16)} does not contain ` +
				`a valid CMP R0, #N instruction (found: 0x${originalBytes[1].toString(16).padStart(2, '0')}` +
				`${originalBytes[0].toString(16).padStart(2, '0')}). ` +
				`This firmware may have already been patched or uses a different address for language count check.`
			);
		}

		const currentCount = originalBytes[0]; // Low byte is the immediate value

		// Additional validation: count should be in reasonable range (10-30 for languages)
		// If the count is way off (like 251 = 0xFB), this is definitely not the language count check
		if (currentCount < 10 || currentCount > 30) {
			throw new AddressValidationError(
				checkAddr,
				`CMP R0, #N with N in range 10-30 (language count)`,
				originalBytes,
				`Language count check value ${currentCount} at 0x${checkAddr.toString(16)} ` +
				`is outside expected range (10-30). ` +
				`This address likely does not contain the language count check for this firmware version.`
			);
		}

		const newCount = currentCount - 1;

		// Create new CMP instruction (little-endian)
		const newBytes = new Uint8Array([newCount, 0x28]);

		// Apply change
		this.data.set(newBytes, checkAddr);

		modifications.push({
			address: checkAddr,
			description: `Updated language count check from ${currentCount} to ${newCount}`,
			originalBytes,
			newBytes
		});
	}

	/**
	 * Clear freed space at the end of data regions
	 */
	private clearFreedSpace(deletedIndex: number, modifications: AddressModification[]): void {
		const systemInfo = this.extractor.getSystemInfo();

		if (!systemInfo) {
			return;
		}

		const nameTableAddr = this.getNameTableAddress();
		const firstPoolAddr = this.getFirstPoolAddress();

		// Clear freed name entry space
		const lastNameAddr = nameTableAddr +
			(systemInfo.languageCount - 1) * LANGUAGE_CONSTANTS.ENTRY_SIZE;
		const originalNameBytes = this.data.slice(lastNameAddr, lastNameAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE);
		this.data.fill(0, lastNameAddr, lastNameAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		modifications.push({
			address: lastNameAddr,
			description: 'Cleared freed name entry space',
			originalBytes: originalNameBytes,
			newBytes: new Uint8Array(LANGUAGE_CONSTANTS.ENTRY_SIZE)
		});

		// Clear freed pool space
		const lastPoolAddr = firstPoolAddr +
			(systemInfo.languageCount - 1) * LANGUAGE_CONSTANTS.POOL_SPACING;
		const originalPoolBytes = this.data.slice(lastPoolAddr, lastPoolAddr + LANGUAGE_CONSTANTS.POOL_SPACING);
		this.data.fill(0, lastPoolAddr, lastPoolAddr + LANGUAGE_CONSTANTS.POOL_SPACING);

		modifications.push({
			address: lastPoolAddr,
			description: 'Cleared freed menu pool space',
			originalBytes: originalPoolBytes,
			newBytes: new Uint8Array(LANGUAGE_CONSTANTS.POOL_SPACING)
		});
	}

	/**
	 * Encode string to UTF-16 bytes
	 */
	private encodeUtf16String(str: string, encoding: LanguageEncoding): Uint8Array {
		// Use TextEncoder for UTF-16
		const encoder = new TextEncoder();

		if (encoding === 'utf-16-le') {
			// JavaScript strings are UTF-16 internally
			// We need to manually encode to UTF-16 LE
			const bytes: number[] = [];
			for (let i = 0; i < str.length; i++) {
				const code = str.charCodeAt(i);
				bytes.push(code & 0xFF);
				bytes.push((code >> 8) & 0xFF);
			}
			return new Uint8Array(bytes);
		} else {
			// UTF-16 BE
			const bytes: number[] = [];
			for (let i = 0; i < str.length; i++) {
				const code = str.charCodeAt(i);
				bytes.push((code >> 8) & 0xFF);
				bytes.push(code & 0xFF);
			}
			return new Uint8Array(bytes);
		}
	}

	/**
	 * Verify knock down operation is safe
	 */
	async verifyKnockDown(languageIndex: number): Promise<{ safe: boolean; errors: string[] }> {
		const errors: string[] = [];

		// Validate hardcoded addresses first (FAIL-FAST)
		try {
			this.validateHardcodedAddresses();
		} catch (error) {
			if (error instanceof AddressValidationError) {
				errors.push(error.message);
				return { safe: false, errors };
			}
			throw error;
		}

		// Check language exists
		const langInfo = this.extractor.getLanguage(languageIndex);
		if (!langInfo) {
			errors.push(`Language ${languageIndex} not found`);
			return { safe: false, errors };
		}

		// Check not protected
		if (isLanguageProtected(languageIndex)) {
			errors.push(`Language ${languageIndex} (${langInfo.name}) is protected and cannot be knocked down`);
		}

		// Check not the only language
		const systemInfo = this.extractor.getSystemInfo();
		if (systemInfo && systemInfo.languageCount <= 1) {
			errors.push('Cannot knock down the last remaining language');
		}

		// Validate language count check address was discovered (FAIL-FAST)
		if (systemInfo) {
			const checkAddr = systemInfo.languageCountCheckAddress;
			if (checkAddr === 0) {
				errors.push(
					`Language count check instruction not found. ` +
					`This firmware version may be incompatible with language patching.`
				);
			} else if (checkAddr + 2 <= this.data.length) {
				const cmpBytes = this.data.slice(checkAddr, checkAddr + 2);
				// ARM Thumb is little-endian: CMP R0, #N is encoded as [N, 0x28]
				if (cmpBytes[1] !== 0x28 || cmpBytes[0] < 10 || cmpBytes[0] > 30) {
					errors.push(
						`Language count check address 0x${checkAddr.toString(16)} does not contain ` +
						`a valid CMP R0, #N instruction with language count.`
					);
				}
			}
		}

		return {
			safe: errors.length === 0,
			errors
		};
	}
}
