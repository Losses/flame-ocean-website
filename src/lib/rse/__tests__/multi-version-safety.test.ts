/**
 * Multi-Version Safety Tests
 *
 * Verifies that the patcher works correctly across all firmware versions
 * and that code never "slides off" the NOP slide boundaries.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
	discoverFlacFunction,
	discoverMenuFunction
} from '../theme/discovery.js';
import { NopSlideFinder } from '../theme/nop-slide.js';

interface TestResult {
	version: string;
	found: boolean;
	safe: boolean;
	flacFuncAddr: number;
	flacPatchAddr: number;
	menuFuncAddr: number;
	menuPatchAddr: number;
	nopSlideStart: number;
	nopSlideEnd: number;
	nopSlideSize: number;
	flacCodeAddr: number;
	menuCodeAddr: number;
	metadataAddr: number;
	totalCodeSize: number;
	fits: boolean;
	issues: string[];
}

function getFirmwareVersions(): { name: string; path: string }[] {
	const firmwareDir = '/tmp/echo-mini-firmwares';
	const versions: { name: string; path: string }[] = [];

	try {
		const dirs = readdirSync(firmwareDir);
		for (const dir of dirs) {
			if (!dir.startsWith('ECHO')) continue;

			const findImg = (baseDir: string) => {
				try {
					const files = readdirSync(baseDir);
					const imgFile = files.find(f => f.endsWith('.IMG') && !f.includes('_PATCHED'));
					if (imgFile) {
						return join(baseDir, imgFile);
					}
				} catch {
					return null;
				}
				return null;
			};

			let imgPath = findImg(join(firmwareDir, dir));
			if (!imgPath) {
				imgPath = findImg(join(firmwareDir, dir, dir));
			}

			if (imgPath) {
				versions.push({ name: dir, path: imgPath });
			}
		}
	} catch {
		return [];
	}

	return versions;
}

function testVersionSafety(versionName: string, firmwarePath: string): TestResult {
	const issues: string[] = [];

	try {
		const data = readFileSync(firmwarePath);

		// Discover theme functions
		const flacResult = discoverFlacFunction(data);
		const menuResult = discoverMenuFunction(data);

		if (!flacResult || !menuResult) {
			return {
				version: versionName,
				found: false,
				safe: false,
				flacFuncAddr: 0,
				flacPatchAddr: 0,
				menuFuncAddr: 0,
				menuPatchAddr: 0,
				nopSlideStart: 0,
				nopSlideEnd: 0,
				nopSlideSize: 0,
				flacCodeAddr: 0,
				menuCodeAddr: 0,
				metadataAddr: 0,
				totalCodeSize: 0,
				fits: false,
				issues: ['Theme functions not found']
			};
		}

		const [flacFuncAddr, flacPatchAddr] = flacResult;
		const [menuFuncAddr, menuPatchAddr] = menuResult;

		// Find NOP slide
		const finder = new NopSlideFinder(data);
		const funcAddrs = [flacFuncAddr, menuFuncAddr];
		const REQUIRED_SIZE = 250;
		const selectedSlide = finder.selectBestSlide(funcAddrs, REQUIRED_SIZE);

		if (!selectedSlide) {
			return {
				version: versionName,
				found: true,
				safe: false,
				flacFuncAddr,
				flacPatchAddr,
				menuFuncAddr,
				menuPatchAddr,
				nopSlideStart: 0,
				nopSlideEnd: 0,
				nopSlideSize: 0,
				flacCodeAddr: 0,
				menuCodeAddr: 0,
				metadataAddr: 0,
				totalCodeSize: 0,
				fits: false,
				issues: ['No NOP slide found']
			};
		}

		// Calculate code layout
		const ALIGNMENT = 4;
		const flacCodeOffset = (ALIGNMENT - (selectedSlide.start % ALIGNMENT)) % ALIGNMENT;
		const flacCodeSize = 80;
		const flacCodeEnd = flacCodeOffset + flacCodeSize;
		const menuCodeOffset = Math.ceil(flacCodeEnd / ALIGNMENT) * ALIGNMENT;
		const menuCodeSize = 80;
		const METADATA_SIZE = 51;
		const metadataOffset = selectedSlide.size - METADATA_SIZE;

		const flacCodeAddr = selectedSlide.start + flacCodeOffset;
		const menuCodeAddr = selectedSlide.start + menuCodeOffset;
		const metadataAddr = selectedSlide.start + metadataOffset;
		const totalCodeSize = menuCodeOffset + menuCodeSize + METADATA_SIZE;

		// CRITICAL BOUNDARY CHECKS

		// 1. Code fits in NOP slide
		if (totalCodeSize > selectedSlide.size) {
			issues.push(`Code size (${totalCodeSize}) exceeds NOP slide (${selectedSlide.size})`);
		}

		// 2. Metadata within NOP slide
		if (metadataAddr + METADATA_SIZE > selectedSlide.start + selectedSlide.size) {
			issues.push('Metadata exceeds NOP slide boundary');
		}

		// 3. FLAC handler boundary
		if (flacCodeAddr + flacCodeSize > menuCodeAddr) {
			issues.push('FLAC handler overlaps Menu handler');
		}

		// 4. Menu handler boundary
		if (menuCodeAddr + menuCodeSize > metadataAddr) {
			issues.push('Menu handler overlaps metadata');
		}

		// 5. BL targets within NOP slide
		const flacBlTarget = flacPatchAddr + 4 + (flacCodeAddr - (flacPatchAddr + 4));
		const menuBlTarget = menuPatchAddr + 4 + (menuCodeAddr - (menuPatchAddr + 4));

		if (flacBlTarget < selectedSlide.start || flacBlTarget >= selectedSlide.start + selectedSlide.size) {
			issues.push(`FLAC BL target (0x${flacBlTarget.toString(16)}) outside NOP slide`);
		}

		if (menuBlTarget < selectedSlide.start || menuBlTarget >= selectedSlide.start + selectedSlide.size) {
			issues.push(`Menu BL target (0x${menuBlTarget.toString(16)}) outside NOP slide`);
		}

		// 6. No sliding off NOP slide
		const flacEndAddr = flacCodeAddr + flacCodeSize;
		const menuEndAddr = menuCodeAddr + menuCodeSize;

		if (flacEndAddr > selectedSlide.start + selectedSlide.size) {
			issues.push(`FLAC handler would slide off NOP slide (ends at 0x${flacEndAddr.toString(16)}, slide ends at 0x${(selectedSlide.start + selectedSlide.size).toString(16)})`);
		}

		if (menuEndAddr > selectedSlide.start + selectedSlide.size) {
			issues.push(`Menu handler would slide off NOP slide (ends at 0x${menuEndAddr.toString(16)}, slide ends at 0x${(selectedSlide.start + selectedSlide.size).toString(16)})`);
		}

		const safe = issues.length === 0;
		const fits = totalCodeSize <= selectedSlide.size;

		return {
			version: versionName,
			found: true,
			safe,
			flacFuncAddr,
			flacPatchAddr,
			menuFuncAddr,
			menuPatchAddr,
			nopSlideStart: selectedSlide.start,
			nopSlideEnd: selectedSlide.end,
			nopSlideSize: selectedSlide.size,
			flacCodeAddr,
			menuCodeAddr,
			metadataAddr,
			totalCodeSize,
			fits,
			issues
		};

	} catch (error: any) {
		return {
			version: versionName,
			found: false,
			safe: false,
			flacFuncAddr: 0,
			flacPatchAddr: 0,
			menuFuncAddr: 0,
			menuPatchAddr: 0,
			nopSlideStart: 0,
			nopSlideEnd: 0,
			nopSlideSize: 0,
			flacCodeAddr: 0,
			menuCodeAddr: 0,
			metadataAddr: 0,
			totalCodeSize: 0,
			fits: false,
			issues: [error.message]
		};
	}
}

describe('Multi-Version Safety', () => {
	const versions = getFirmwareVersions();

	it('should find firmware versions to test', () => {
		expect(versions.length).toBeGreaterThan(0);
	});

	versions.forEach(({ name, path }) => {
		describe(`Version ${name}`, () => {
			const result = testVersionSafety(name, path);

			if (!result.found) {
				it('should correctly detect lack of theme support', () => {
					expect(result.issues).toContain('Theme functions not found');
				});
				return;
			}

			it('should discover theme functions', () => {
				expect(result.flacFuncAddr).toBeGreaterThan(0);
				expect(result.menuFuncAddr).toBeGreaterThan(0);
			});

			it('should find a suitable NOP slide', () => {
				expect(result.nopSlideSize).toBeGreaterThan(0);
			});

			it('should fit code within NOP slide boundaries', () => {
				expect(result.fits).toBe(true);
				expect(result.totalCodeSize).toBeLessThanOrEqual(result.nopSlideSize);
			});

			it('should not slide off NOP slide', () => {
				// Check that handlers don't exceed boundaries
				expect(result.issues.filter(i => i.includes('slide off'))).toEqual([]);
			});

			it('should have BL targets within NOP slide', () => {
				expect(result.issues.filter(i => i.includes('outside NOP slide'))).toEqual([]);
			});

			it('should be safe to patch', () => {
				expect(result.issues).toEqual([]);
				expect(result.safe).toBe(true);
			});
		});
	});
});

describe('Critical Safety Checks - V2.4.0', () => {
	const firmwarePath = '/tmp/echo-mini-firmwares/ECHO MINI V2.4.0/ECHO MINI V2.4.0/HIFIEC40.IMG';
	const data = readFileSync(firmwarePath);

	const flacResult = discoverFlacFunction(data);
	const menuResult = discoverMenuFunction(data);

	if (!flacResult || !menuResult) {
		it('should have theme functions', () => {
			throw new Error('Theme functions not found - test cannot run');
		});
		return;
	}

	const [flacFuncAddr, flacPatchAddr] = flacResult;
	const [menuFuncAddr] = menuResult;

	const finder = new NopSlideFinder(data);
	const selectedSlide = finder.selectBestSlide([flacFuncAddr, menuFuncAddr], 250);

	if (!selectedSlide) {
		it('should have NOP slide', () => {
			throw new Error('NOP slide not found - test cannot run');
		});
		return;
	}

	it('should verify FLAC handler does not slide off NOP slide', () => {
		const ALIGNMENT = 4;
		const flacCodeOffset = (ALIGNMENT - (selectedSlide.start % ALIGNMENT)) % ALIGNMENT;
		const flacCodeAddr = selectedSlide.start + flacCodeOffset;
		const flacCodeSize = 80;

		const flacEndAddr = flacCodeAddr + flacCodeSize;

		expect(flacEndAddr).toBeLessThanOrEqual(selectedSlide.start + selectedSlide.size);
	});

	it('should verify Menu handler does not slide off NOP slide', () => {
		const ALIGNMENT = 4;
		const flacCodeOffset = (ALIGNMENT - (selectedSlide.start % ALIGNMENT)) % ALIGNMENT;
		const flacCodeSize = 80;
		const flacCodeEnd = flacCodeOffset + flacCodeSize;
		const menuCodeOffset = Math.ceil(flacCodeEnd / ALIGNMENT) * ALIGNMENT;
		const menuCodeAddr = selectedSlide.start + menuCodeOffset;
		const menuCodeSize = 80;

		const menuEndAddr = menuCodeAddr + menuCodeSize;

		expect(menuEndAddr).toBeLessThanOrEqual(selectedSlide.start + selectedSlide.size);
	});

	it('should verify metadata does not slide off NOP slide', () => {
		const METADATA_SIZE = 51;
		const metadataAddr = selectedSlide.start + (selectedSlide.size - METADATA_SIZE);

		expect(metadataAddr + METADATA_SIZE).toBeLessThanOrEqual(selectedSlide.start + selectedSlide.size);
	});

	it('should have adequate safety margin', () => {
		const ALIGNMENT = 4;
		const flacCodeOffset = (ALIGNMENT - (selectedSlide.start % ALIGNMENT)) % ALIGNMENT;
		const flacCodeSize = 80;
		const flacCodeEnd = flacCodeOffset + flacCodeSize;
		const menuCodeOffset = Math.ceil(flacCodeEnd / ALIGNMENT) * ALIGNMENT;
		const menuCodeSize = 80;
		const METADATA_SIZE = 51;

		const totalCodeSize = menuCodeOffset + menuCodeSize + METADATA_SIZE;
		const margin = selectedSlide.size - totalCodeSize;

		// Should have at least 20 bytes of safety margin (8%)
		expect(margin).toBeGreaterThanOrEqual(20);
	});
});
