/**
 * Multi-version Language System Tests
 */

import { describe, it, expect, beforeAll } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LanguageExtractor } from '../index.js';

const BASE_DIR = '/tmp/echo-mini-firmwares';

function getAvailableVersions(): { version: string; path: string }[] {
	if (!existsSync(BASE_DIR)) {
		return [];
	}
	const versions: { version: string; path: string }[] = [];
	const dirs = readdirSync(BASE_DIR, { withFileTypes: true });

	for (const dir of dirs) {
		if (!dir.isDirectory() || !dir.name.startsWith('ECHO MINI V')) {
			continue;
		}
		const subDir = join(BASE_DIR, dir.name);
		const files = readdirSync(subDir);
		const directImg = files.find(f => f.endsWith('.IMG'));

		if (directImg) {
			versions.push({ version: dir.name, path: join(subDir, directImg) });
			continue;
		}

		const nestedDir = join(subDir, dir.name);
		if (existsSync(nestedDir)) {
			const nestedFiles = readdirSync(nestedDir);
			const nestedImg = nestedFiles.find(f => f.endsWith('.IMG'));
			if (nestedImg) {
				versions.push({ version: dir.name, path: join(nestedDir, nestedImg) });
			}
		}
	}

	return versions.sort((a, b) => a.version.localeCompare(b.version));
}

describe('Multi-Version Language System', () => {
	let versions: { version: string; path: string }[];

	beforeAll(() => {
		versions = getAvailableVersions();
		console.log('Found ' + versions.length + ' firmware versions');
	});

	it('should have versions', () => {
		expect(versions.length).toBeGreaterThan(0);
	});

	it('discovers addresses in all versions', () => {
		for (const item of versions) {
			const data = new Uint8Array(readFileSync(item.path));
			const ext = new LanguageExtractor(data, item.version);
			const info = ext.getSystemInfo();

			expect(info).toBeDefined();
			expect(info!.nameTableAddress).toBeGreaterThan(0);
			expect(info!.firstPoolAddress).toBeGreaterThan(0);
			expect(info!.languageCount).toBeGreaterThan(0);
		}
	});
});
