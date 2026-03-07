/**
 * Language Editor Error Classes
 *
 * Hierarchical error classes for different language operation failure scenarios.
 */

import { ThemeError } from '../theme/errors.js';

/**
 * Base Language Error class
 */
export class LanguageError extends ThemeError {
	constructor(message: string) {
		super(message);
		this.name = 'LanguageError';
		Object.setPrototypeOf(this, LanguageError.prototype);
	}

	getErrorCode(): string {
		return 'LANGUAGE_ERROR';
	}
}

/**
 * Invalid language index error
 */
export class InvalidLanguageIndexError extends LanguageError {
	constructor(index: number, maxLanguages: number) {
		super(`Invalid language index ${index}. Must be 0-${maxLanguages - 1}.`);
		this.name = 'InvalidLanguageIndexError';
		Object.setPrototypeOf(this, InvalidLanguageIndexError.prototype);
	}

	getErrorCode(): string {
		return 'INVALID_LANGUAGE_INDEX';
	}
}

/**
 * Protected language error - cannot modify protected languages
 */
export class ProtectedLanguageError extends LanguageError {
	constructor(index: number, name: string) {
		super(`Cannot modify protected language ${index} (${name}). Chinese and English are protected.`);
		this.name = 'ProtectedLanguageError';
		Object.setPrototypeOf(this, ProtectedLanguageError.prototype);
	}

	getErrorCode(): string {
		return 'PROTECTED_LANGUAGE';
	}
}

/**
 * String too long error
 */
export class StringTooLongError extends LanguageError {
	constructor(length: number, maxLength: number) {
		super(`String too long: ${length} bytes exceeds maximum ${maxLength} bytes.`);
		this.name = 'StringTooLongError';
		Object.setPrototypeOf(this, StringTooLongError.prototype);
	}

	getErrorCode(): string {
		return 'STRING_TOO_LONG';
	}
}

/**
 * Language system not found error
 */
export class LanguageSystemNotFoundError extends LanguageError {
	constructor(message?: string) {
		super(message ?? 'Language system not found in firmware. This may be an older version.');
		this.name = 'LanguageSystemNotFoundError';
		Object.setPrototypeOf(this, LanguageSystemNotFoundError.prototype);
	}

	getErrorCode(): string {
		return 'LANGUAGE_SYSTEM_NOT_FOUND';
	}
}

/**
 * Language knock down error
 */
export class LanguageKnockDownError extends LanguageError {
	constructor(message: string) {
		super(message);
		this.name = 'LanguageKnockDownError';
		Object.setPrototypeOf(this, LanguageKnockDownError.prototype);
	}

	getErrorCode(): string {
		return 'LANGUAGE_KNOCK_DOWN_ERROR';
	}
}

/**
 * Data rearrangement error
 */
export class DataRearrangementError extends LanguageError {
	constructor(message: string) {
		super(message);
		this.name = 'DataRearrangementError';
		Object.setPrototypeOf(this, DataRearrangementError.prototype);
	}

	getErrorCode(): string {
		return 'DATA_REARRANGEMENT_ERROR';
	}
}

/**
 * Unicorn verification error
 */
export class UnicornVerificationError extends LanguageError {
	constructor(message: string, public readonly testResults?: string[]) {
		super(message);
		this.name = 'UnicornVerificationError';
		Object.setPrototypeOf(this, UnicornVerificationError.prototype);
	}

	getErrorCode(): string {
		return 'UNICORN_VERIFICATION_ERROR';
	}
}

/**
 * Entry validation error
 */
export class EntryValidationError extends LanguageError {
	constructor(address: number, reason: string) {
		super(`Entry validation failed at 0x${address.toString(16).toUpperCase()}: ${reason}`);
		this.name = 'EntryValidationError';
		Object.setPrototypeOf(this, EntryValidationError.prototype);
	}

	getErrorCode(): string {
		return 'ENTRY_VALIDATION_ERROR';
	}
}

/**
 * Encoding error
 */
export class LanguageEncodingError extends LanguageError {
	constructor(message: string) {
		super(message);
		this.name = 'LanguageEncodingError';
		Object.setPrototypeOf(this, LanguageEncodingError.prototype);
	}

	getErrorCode(): string {
		return 'LANGUAGE_ENCODING_ERROR';
	}
}

/**
 * Address validation error - hardcoded address doesn't match expected pattern
 *
 * This error is thrown when the firmware doesn't contain expected data at
 * hardcoded addresses, indicating version incompatibility or firmware corruption.
 */
export class AddressValidationError extends LanguageError {
	constructor(
		public readonly address: number,
		public readonly expectedPattern: string,
		public readonly actualBytes: Uint8Array,
		message?: string
	) {
		super(
			message ??
			`Address validation failed at 0x${address.toString(16).toUpperCase()}: ` +
			`expected ${expectedPattern}, found ${Array.from(actualBytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`
		);
		this.name = 'AddressValidationError';
		Object.setPrototypeOf(this, AddressValidationError.prototype);
	}

	getErrorCode(): string {
		return 'ADDRESS_VALIDATION_ERROR';
	}
}

/**
 * Check if an error is a LanguageError
 */
export function isLanguageError(error: unknown): error is LanguageError {
	return error instanceof LanguageError;
}

/**
 * Get user-friendly error message for language errors
 */
export function getLanguageErrorMessage(error: unknown): string {
	if (isLanguageError(error)) {
		return error.getUserMessage();
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
