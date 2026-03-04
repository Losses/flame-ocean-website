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
	/** Detected name table address (found by searching for Chinese name pattern) */
	private detectedNameTableAddr: number | null = null;
	/** Detected first pool address */
	private detectedFirstPoolAddr: number | null = null;

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
				nameTableAddress: this.detectedNameTableAddr ?? LANGUAGE_CONSTANTS.NAME_TABLE_ADDRESS,
				nameTableSize: languageCount * LANGUAGE_CONSTANTS.ENTRY_SIZE,
				firstPoolAddress: this.detectedFirstPoolAddr ?? LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS,
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
	 * Quick check if language system exists (without full extraction)
	 */
	hasLanguageSystem(): boolean {
		return this.detectLanguageSystem();
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
	 *
	 * Uses search-based detection to find language system across different firmware versions.
	 * Searches for Chinese name "简体中文" pattern to locate the name table.
	 */
	private detectLanguageSystem(): boolean {
		// If already detected, return cached result
		if (this.detectedNameTableAddr !== null) {
			return true;
		}

		// Try hardcoded V3.1.0 addresses first (fast path)
		if (this.tryDetectAtAddress(LANGUAGE_CONSTANTS.NAME_TABLE_ADDRESS, LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS)) {
			return true;
		}

		// Search for Chinese name "简体中文" in UTF-16 LE
		// Pattern: 80 7B 53 4F 2D 4E 87 65 (简体中文)
		const chinesePattern = new Uint8Array([0x80, 0x7B, 0x53, 0x4F, 0x2D, 0x4E, 0x87, 0x65]);

		// Search in typical firmware regions (0x700000 - 0x800000)
		const searchStart = 0x700000;
		const searchEnd = Math.min(0x800000, this.data.length - chinesePattern.length);

		for (let addr = searchStart; addr < searchEnd; addr += 2) {
			// Quick check for first 2 bytes
			if (this.data[addr] === 0x80 && this.data[addr + 1] === 0x7B) {
				// Check full pattern
				let match = true;
				for (let i = 2; i < chinesePattern.length; i++) {
					if (this.data[addr + i] !== chinesePattern[i]) {
						match = false;
						break;
					}
				}

				if (match) {
					// Found Chinese name - now find the pool
					const poolAddr = this.findFirstPoolFromNameTable(addr);
					if (poolAddr !== null) {
						this.detectedNameTableAddr = addr;
						this.detectedFirstPoolAddr = poolAddr;
						return true;
					}
				}
			}
		}

		return false;
	}

	/**
	 * Try to detect language system at specific addresses
	 */
	private tryDetectAtAddress(nameTableAddr: number, poolAddr: number): boolean {
		if (nameTableAddr + 4 > this.data.length) {
			return false;
		}
		if (poolAddr + 4 > this.data.length) {
			return false;
		}

		// Check first language name entry (Chinese) - should NOT have FF FF prefix
		const firstEntry = this.data.slice(nameTableAddr, nameTableAddr + 4);
		if (firstEntry[0] === 0xFF && firstEntry[1] === 0xFF) {
			return false;
		}

		// Check first menu pool - should have FF FF prefix
		const firstPoolEntry = this.data.slice(poolAddr, poolAddr + 2);
		if (firstPoolEntry[0] !== 0xFF || firstPoolEntry[1] !== 0xFF) {
			return false;
		}

		// Valid detection
		this.detectedNameTableAddr = nameTableAddr;
		this.detectedFirstPoolAddr = poolAddr;
		return true;
	}

	/**
	 * Find first menu pool from name table address
	 *
	 * The pool is typically at a fixed offset before the name table.
	 * We search backwards for FF FF pattern that indicates menu pool start.
	 */
	private findFirstPoolFromNameTable(nameTableAddr: number): number | null {
		// Try V3.1.0 offset first (0x15DB8)
		const v310Offset = LANGUAGE_CONSTANTS.NAME_TABLE_ADDRESS - LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS;
		const expectedPool = nameTableAddr - v310Offset;

		if (expectedPool >= 0 && expectedPool + 4 <= this.data.length) {
			if (this.data[expectedPool] === 0xFF && this.data[expectedPool + 1] === 0xFF) {
				return expectedPool;
			}
		}

		// Search backwards for FF FF pattern (within 0x20000 bytes)
		const searchStart = Math.max(0, nameTableAddr - 0x20000);
		const searchEnd = nameTableAddr;

		for (let addr = searchEnd; addr >= searchStart; addr -= 2) {
			if (this.data[addr] === 0xFF && this.data[addr + 1] === 0xFF) {
				// Check if followed by valid UTF-16 text (not more FF or 00)
				if (addr + 4 <= this.data.length) {
					const nextByte = this.data[addr + 2];
					const nextByte2 = this.data[addr + 3];
					if (nextByte !== 0xFF && nextByte !== 0x00 && nextByte2 !== 0xFF) {
						// Verify this is aligned to a reasonable boundary
						if (addr % 2 === 0) {
							return addr;
						}
					}
				}
			}
		}

		return null;
	}

	/**
	 * Get the detected name table address
	 */
	getDetectedNameTableAddress(): number | null {
		if (this.detectedNameTableAddr === null) {
			this.detectLanguageSystem();
		}
		return this.detectedNameTableAddr;
	}

	/**
	 * Get the detected first pool address
	 */
	getDetectedFirstPoolAddress(): number | null {
		if (this.detectedFirstPoolAddr === null) {
			this.detectLanguageSystem();
		}
		return this.detectedFirstPoolAddr;
	}

	/**
	 * Calculate name entry address using detected base
	 */
	private getNameEntryAddress(languageIndex: number): number {
		const baseAddr = this.detectedNameTableAddr ?? LANGUAGE_CONSTANTS.NAME_TABLE_ADDRESS;
		return baseAddr + languageIndex * LANGUAGE_CONSTANTS.ENTRY_SIZE;
	}

	/**
	 * Calculate pool address using detected base
	 */
	private getPoolAddress(languageIndex: number): number {
		const baseAddr = this.detectedFirstPoolAddr ?? LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS;
		return baseAddr + languageIndex * LANGUAGE_CONSTANTS.POOL_SPACING;
	}

	/**
	 * Calculate string entry address within a pool
	 */
	private getStringEntryAddress(poolAddress: number, stringIndex: number): number {
		return poolAddress + stringIndex * LANGUAGE_CONSTANTS.ENTRY_SIZE;
	}

	/**
	 * Discover actual language count from firmware
	 */
	private discoverLanguageCount(): number {
		// Try to find language count by checking for valid entries
		let count = 0;
		for (let i = 0; i < LANGUAGE_CONSTANTS.MAX_LANGUAGES; i++) {
			const nameAddr = this.getNameEntryAddress(i);
			const poolAddr = this.getPoolAddress(i);

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
		const nameAddr = this.getNameEntryAddress(index);
		const poolAddr = this.getPoolAddress(index);

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
			const entryAddr = this.getStringEntryAddress(poolAddress, i);

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
