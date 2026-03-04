/**
 * Language Extractor
 *
 * Extracts language information from ECHO MINI firmware.
 * Discovers language names and menu string pools.
 */

import {
	type LanguageInfo,
	type LanguageSystemInfo,
	type LanguageExtractionResult,
	type MenuStringEntry,
	type LanguageNameEntry,
	type LanguageEncoding,
	LANGUAGE_CONSTANTS,
	getLanguageEncoding,
	isLanguageProtected,
	calculateNameEntryAddress,
	calculatePoolAddress,
	calculateStringEntryAddress,
	isValidLanguageIndex
} from './types.js';
import {
	LanguageError,
	LanguageSystemNotFoundError,
	EntryValidationError
} from './errors.js';

/**
 * Language Extractor Class
 *
 * Extracts and analyzes multi-language data from firmware.
 */
export class LanguageExtractor {
	private readonly data: Uint8Array;
	private readonly version: string;
	private cachedSystemInfo: LanguageSystemInfo | null = null;

	/**
	 * Create a new LanguageExtractor
	 */
	constructor(firmwareData: Uint8Array, version = 'Unknown') {
		this.data = firmwareData;
		this.version = version;
	}

	/**
	 * Extract complete language system information
	 */
	extract(): LanguageExtractionResult {
		try {
			// Check if language system exists
			if (!this.detectLanguageSystem()) {
				return {
					success: false,
					error: 'Language system not found. This may be an older firmware version.'
				};
			}

			// Discover language count
			const languageCount = this.discoverLanguageCount();
			if (languageCount === 0) {
				return {
					success: false,
					error: 'No languages found in firmware.'
				};
			}

			// Extract all languages
			const languages: LanguageInfo[] = [];
			for (let i = 0; i < languageCount; i++) {
				const langInfo = this.extractLanguage(i);
				if (langInfo) {
					languages.push(langInfo);
				}
			}

			// Build system info
			this.cachedSystemInfo = {
				version: this.version,
				languageCount,
				nameTableAddress: LANGUAGE_CONSTANTS.NAME_TABLE_ADDRESS,
				nameTableSize: languageCount * LANGUAGE_CONSTANTS.ENTRY_SIZE,
				firstPoolAddress: LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS,
				poolSpacing: LANGUAGE_CONSTANTS.POOL_SPACING,
				languageCountCheckAddress: LANGUAGE_CONSTANTS.LANGUAGE_COUNT_CHECK_ADDRESS,
				originalLanguageCountValue: LANGUAGE_CONSTANTS.MAX_LANGUAGES - 1, // 20 (0-indexed check)
				languages
			};

			return {
				success: true,
				systemInfo: this.cachedSystemInfo
			};
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error)
			};
		}
	}

	/**
	 * Get cached system info
	 */
	getSystemInfo(): LanguageSystemInfo | null {
		if (!this.cachedSystemInfo) {
			const result = this.extract();
			if (!result.success) {
				return null;
			}
		}
		return this.cachedSystemInfo;
	}

	/**
	 * List all languages
	 */
	listLanguages(): LanguageInfo[] {
		const systemInfo = this.getSystemInfo();
		return systemInfo ? [...systemInfo.languages] : [];
	}

	/**
	 * Get a specific language
	 */
	getLanguage(index: number): LanguageInfo | null {
		if (!isValidLanguageIndex(index)) {
			return null;
		}
		const languages = this.listLanguages();
		return languages[index] ?? null;
	}

	/**
	 * Get menu strings for a language
	 */
	getMenuStrings(languageIndex: number): MenuStringEntry[] {
		const lang = this.getLanguage(languageIndex);
		return lang ? [...lang.strings] : [];
	}

	/**
	 * Get a specific menu string
	 */
	getMenuString(languageIndex: number, stringIndex: number): MenuStringEntry | null {
		const strings = this.getMenuStrings(languageIndex);
		return strings[stringIndex] ?? null;
	}

	/**
	 * Detect if language system exists in firmware
	 */
	private detectLanguageSystem(): boolean {
		// Check if language name table has valid entries
		const nameTableAddr = LANGUAGE_CONSTANTS.NAME_TABLE_ADDRESS;
		if (nameTableAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE > this.data.length) {
			return false;
		}

		// Check first language name entry (Chinese) - should NOT have FF FF prefix
		const firstEntry = this.data.slice(nameTableAddr, nameTableAddr + 4);
		// Language names don't have FF FF prefix
		if (firstEntry[0] === 0xFF && firstEntry[1] === 0xFF) {
			// This might be a different structure
			return false;
		}

		// Check first menu pool - should have FF FF prefix
		const poolAddr = LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS;
		if (poolAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE > this.data.length) {
			return false;
		}

		const firstPoolEntry = this.data.slice(poolAddr, poolAddr + 2);
		if (firstPoolEntry[0] !== 0xFF || firstPoolEntry[1] !== 0xFF) {
			return false;
		}

		return true;
	}

	/**
	 * Discover actual language count from firmware
	 */
	private discoverLanguageCount(): number {
		// Try to find language count by checking for valid entries
		let count = 0;
		for (let i = 0; i < LANGUAGE_CONSTANTS.MAX_LANGUAGES; i++) {
			const nameAddr = calculateNameEntryAddress(i);
			const poolAddr = calculatePoolAddress(i);

			// Check if addresses are within bounds
			if (nameAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE > this.data.length) {
				break;
			}
			if (poolAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE > this.data.length) {
				break;
			}

			// Check if name entry is valid (not all zeros or all 0xFF)
			const nameEntry = this.data.slice(nameAddr, nameAddr + LANGUAGE_CONSTANTS.ENTRY_SIZE);
			if (this.isEmptyEntry(nameEntry)) {
				break;
			}

			count++;
		}

		return count;
	}

	/**
	 * Check if an entry is empty (all zeros or all 0xFF)
	 */
	private isEmptyEntry(entry: Uint8Array): boolean {
		if (entry.length === 0) return true;
		const first = entry[0];
		return entry.every(b => b === first);
	}

	/**
	 * Extract a single language
	 */
	private extractLanguage(index: number): LanguageInfo | null {
		if (!isValidLanguageIndex(index)) {
			return null;
		}

		const menuEncoding = getLanguageEncoding(index);
		const nameAddr = calculateNameEntryAddress(index);
		const poolAddr = calculatePoolAddress(index);

		// Language names always use UTF-16 LE (they're metadata, not content)
		// Extract language name with UTF-16 LE encoding
		const nameEntry = this.extractLanguageNameEntry(nameAddr, index, 'utf-16-le');
		if (!nameEntry) {
			return null;
		}

		// Extract menu strings with language-specific encoding
		const strings = this.extractMenuStrings(poolAddr, index, menuEncoding);
		const poolSize = strings.length * LANGUAGE_CONSTANTS.ENTRY_SIZE;

		return {
			index,
			name: nameEntry.name,
			nameAddress: nameAddr,
			poolAddress: poolAddr,
			poolSize,
			stringCount: strings.length,
			encoding: menuEncoding,
			strings,
			isProtected: isLanguageProtected(index)
		};
	}

	/**
	 * Extract language name entry
	 */
	private extractLanguageNameEntry(
		address: number,
		index: number,
		encoding: LanguageEncoding
	): LanguageNameEntry | null {
		if (address + LANGUAGE_CONSTANTS.ENTRY_SIZE > this.data.length) {
			return null;
		}

		const rawBytes = this.data.slice(address, address + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		// Language names don't have FF FF prefix
		// Find NULL terminator
		let nullPos = -1;
		for (let i = 0; i < rawBytes.length - 1; i += 2) {
			if (rawBytes[i] === 0 && rawBytes[i + 1] === 0) {
				nullPos = i;
				break;
			}
		}

		if (nullPos === -1) {
			// No NULL found, use entire entry
			nullPos = LANGUAGE_CONSTANTS.ENTRY_SIZE;
		}

		// Decode string
		const stringBytes = rawBytes.slice(0, nullPos);
		const name = this.decodeUtf16String(stringBytes, encoding);

		return {
			type: 'name',
			address,
			index,
			name,
			encoding,
			rawBytes
		};
	}

	/**
	 * Extract all menu strings from a pool
	 */
	private extractMenuStrings(
		poolAddress: number,
		languageIndex: number,
		encoding: LanguageEncoding
	): MenuStringEntry[] {
		const strings: MenuStringEntry[] = [];
		const poolSpacing = LANGUAGE_CONSTANTS.POOL_SPACING;
		const entrySize = LANGUAGE_CONSTANTS.ENTRY_SIZE;
		const maxStrings = Math.floor(poolSpacing / entrySize);

		for (let i = 0; i < maxStrings; i++) {
			const entryAddr = calculateStringEntryAddress(poolAddress, i);

			if (entryAddr + entrySize > this.data.length) {
				break;
			}

			// Check if we've reached the end of the pool
			if (entryAddr >= poolAddress + poolSpacing) {
				break;
			}

			const entry = this.extractMenuStringEntry(entryAddr, languageIndex, i, encoding);
			if (!entry) {
				break;
			}

			strings.push(entry);
		}

		return strings;
	}

	/**
	 * Extract a single menu string entry
	 */
	private extractMenuStringEntry(
		address: number,
		languageIndex: number,
		stringIndex: number,
		encoding: LanguageEncoding
	): MenuStringEntry | null {
		const entrySize = LANGUAGE_CONSTANTS.ENTRY_SIZE;

		if (address + entrySize > this.data.length) {
			return null;
		}

		const rawBytes = this.data.slice(address, address + entrySize);

		// Check for FF FF prefix
		const hasPrefix = rawBytes[0] === 0xFF && rawBytes[1] === 0xFF;

		// Find NULL terminator
		let nullPos = -1;
		const searchStart = hasPrefix ? 2 : 0;
		for (let i = searchStart; i < rawBytes.length - 1; i += 2) {
			if (rawBytes[i] === 0 && rawBytes[i + 1] === 0) {
				nullPos = i;
				break;
			}
		}

		if (nullPos === -1) {
			// No NULL found - might be an invalid entry
			// Try to use the entire content after prefix
			nullPos = entrySize;
		}

		// Decode string
		const stringBytes = rawBytes.slice(searchStart, nullPos);
		const content = this.decodeUtf16String(stringBytes, encoding);

		// Check if this is a valid entry (not empty)
		if (!content && !hasPrefix) {
			return null;
		}

		return {
			type: 'menu',
			address,
			languageIndex,
			stringIndex,
			content,
			encoding,
			rawBytes,
			hasPrefix
		};
	}

	/**
	 * Decode UTF-16 string from bytes
	 */
	private decodeUtf16String(bytes: Uint8Array, encoding: LanguageEncoding): string {
		if (bytes.length === 0) return '';

		try {
			// Use TextDecoder for UTF-16 LE
			if (encoding === 'utf-16-le') {
				const decoder = new TextDecoder('utf-16le');
				return decoder.decode(bytes);
			} else {
				// UTF-16 BE - need to swap bytes first
				const swapped = new Uint8Array(bytes.length);
				for (let i = 0; i < bytes.length - 1; i += 2) {
					swapped[i] = bytes[i + 1];
					swapped[i + 1] = bytes[i];
				}
				if (bytes.length % 2 === 1) {
					swapped[bytes.length - 1] = bytes[bytes.length - 1];
				}
				const decoder = new TextDecoder('utf-16le');
				return decoder.decode(swapped);
			}
		} catch {
			return '';
		}
	}

	/**
	 * Validate a language entry
	 */
	validateEntry(address: number, isMenu: boolean): { valid: boolean; error?: string } {
		if (address + LANGUAGE_CONSTANTS.ENTRY_SIZE > this.data.length) {
			return { valid: false, error: 'Address out of bounds' };
		}

		const entry = this.data.slice(address, address + LANGUAGE_CONSTANTS.ENTRY_SIZE);

		if (isMenu) {
			// Menu entries should have FF FF prefix
			if (entry[0] !== 0xFF || entry[1] !== 0xFF) {
				return { valid: false, error: 'Missing FF FF prefix for menu entry' };
			}
		}

		// Check for NULL terminator
		let hasNull = false;
		const searchStart = isMenu ? 2 : 0;
		for (let i = searchStart; i < entry.length - 1; i += 2) {
			if (entry[i] === 0 && entry[i + 1] === 0) {
				hasNull = true;
				break;
			}
		}

		if (!hasNull) {
			return { valid: false, error: 'No NULL terminator found' };
		}

		return { valid: true };
	}

	/**
	 * Analyze language system structure
	 */
	analyze(): {
		languageCount: number;
		totalMenuPoolSize: number;
		totalNameTableSize: number;
		languages: Array<{
			index: number;
			name: string;
			stringCount: number;
			poolSize: number;
		}>;
	} {
		const systemInfo = this.getSystemInfo();
		if (!systemInfo) {
			return {
				languageCount: 0,
				totalMenuPoolSize: 0,
				totalNameTableSize: 0,
				languages: []
			};
		}

		let totalMenuPoolSize = 0;
		const languages = systemInfo.languages.map(lang => {
			totalMenuPoolSize += lang.poolSize;
			return {
				index: lang.index,
				name: lang.name,
				stringCount: lang.stringCount,
				poolSize: lang.poolSize
			};
		});

		return {
			languageCount: systemInfo.languageCount,
			totalMenuPoolSize,
			totalNameTableSize: systemInfo.nameTableSize,
			languages
		};
	}
}
