/**
 * Platform-neutral file I/O abstraction
 */

/**
 * File input type - can be a path string (Node.js) or a File object (browser)
 */
export type FileInput = string | File;

/**
 * File I/O interface for platform-neutral operations
 */
export interface FileIO {
	/**
	 * Read file as Uint8Array
	 * @param input - File path (Node.js) or File object (browser)
	 * @returns File data
	 */
	readFile(input: FileInput): Promise<Uint8Array>;

	/**
	 * Read file synchronously as Uint8Array
	 * @param input - File path (Node.js) or File object (browser)
	 * @returns File data
	 */
	readFileSync(input: FileInput): Uint8Array;

	/**
	 * Write data to file
	 * @param path - File path (browser download, Node.js write)
	 * @param data - Data to write
	 */
	writeFile(path: string, data: Uint8Array): Promise<void>;

	/**
	 * Write data to file synchronously (Node.js only)
	 * @param path - File path
	 * @param data - Data to write
	 */
	writeFileSync(path: string, data: Uint8Array): void;

	/**
	 * Create directory recursively
	 * @param path - Directory path
	 */
	mkdir(path: string): Promise<void>;

	/**
	 * Create directory recursively synchronously
	 * @param path - Directory path
	 */
	mkdirSync(path: string): void;

	/**
	 * Check if path exists
	 * @param path - File or directory path
	 */
	exists(path: string): Promise<boolean>;

	/**
	 * Check if path exists synchronously
	 * @param path - File or directory path
	 */
	existsSync(path: string): boolean;

	/**
	 * Check if running in Node.js environment
	 */
	isNode(): boolean;

	/**
	 * Check if running in browser environment
	 */
	isBrowser(): boolean;
}

/**
 * Detect current platform
 */
function detectPlatform(): 'node' | 'browser' {
	// Check for Node.js environment
	if (typeof process !== 'undefined' && process.versions?.node) {
		return 'node';
	}
	return 'browser';
}

/**
 * Node.js file I/O implementation
 */
class NodeFileIO implements FileIO {
	isNode(): boolean {
		return true;
	}

	isBrowser(): boolean {
		return false;
	}

	async readFile(input: FileInput): Promise<Uint8Array> {
		if (typeof input !== 'string') {
			throw new TypeError('Node.js environment requires file path string');
		}
		const fs = await import('node:fs/promises');
		const data = await fs.readFile(input);
		return new Uint8Array(data);
	}

	readFileSync(input: FileInput): Uint8Array {
		if (typeof input !== 'string') {
			throw new TypeError('Node.js environment requires file path string');
		}
		const fs = require('node:fs');
		const data = fs.readFileSync(input);
		return new Uint8Array(data);
	}

	async writeFile(path: string, data: Uint8Array): Promise<void> {
		const fs = await import('node:fs/promises');
		await fs.writeFile(path, data);
	}

	writeFileSync(path: string, data: Uint8Array): void {
		const fs = require('node:fs');
		fs.writeFileSync(path, data);
	}

	async mkdir(path: string): Promise<void> {
		const fs = await import('node:fs/promises');
		await fs.mkdir(path, { recursive: true });
	}

	mkdirSync(path: string): void {
		const fs = require('node:fs');
		fs.mkdirSync(path, { recursive: true });
	}

	async exists(path: string): Promise<boolean> {
		const fs = await import('node:fs/promises');
		try {
			await fs.access(path);
			return true;
		} catch {
			return false;
		}
	}

	existsSync(path: string): boolean {
		const fs = require('node:fs');
		return fs.existsSync(path);
	}
}

/**
 * Browser file I/O implementation
 */
class BrowserFileIO implements FileIO {
	isNode(): boolean {
		return false;
	}

	isBrowser(): boolean {
		return typeof window !== 'undefined';
	}

	async readFile(input: FileInput): Promise<Uint8Array> {
		if (typeof input !== 'string' && input instanceof File) {
			const arrayBuffer = await input.arrayBuffer();
			return new Uint8Array(arrayBuffer);
		}
		throw new TypeError('Browser environment requires File object');
	}

	readFileSync(_input: FileInput): Uint8Array {
		throw new Error('Synchronous file reading not supported in browser environment');
	}

	async writeFile(_path: string, data: Uint8Array): Promise<void> {
		// Trigger browser download
		const blob = new Blob([data as BlobPart]);
		const url = URL.createObjectURL(blob);
		try {
			const a = document.createElement('a');
			a.href = url;
			a.download = _path;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
		} finally {
			URL.revokeObjectURL(url);
		}
	}

	writeFileSync(_path: string, _data: Uint8Array): void {
		throw new Error('Synchronous file writing not supported in browser environment');
	}

	async mkdir(_path: string): Promise<void> {
		// No-op in browser
	}

	mkdirSync(_path: string): void {
		// No-op in browser
	}

	async exists(_path: string): Promise<boolean> {
		return false;
	}

	existsSync(_path: string): boolean {
		return false;
	}
}

/**
 * Get file I/O implementation for current platform
 */
export function getFileIO(): FileIO {
	const platform = detectPlatform();
	switch (platform) {
		case 'node':
			return new NodeFileIO();
		case 'browser':
			return new BrowserFileIO();
		default:
			return new BrowserFileIO();
	}
}

/**
 * Default file I/O instance
 */
export const fileIO = getFileIO();
