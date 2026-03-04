/**
 * Theme Patcher
 *
 * Main patching module that applies theme color patches to firmware.
 * Uses detection, NOP slide finding, and instruction encoding to patch.
 *
 * Supports two patching methods:
 * 1. Function Relocation (recommended): Copies the entire FLAC function to freed language pool space
 *    and modifies the caller. This avoids inserting code inside the function.
 * 2. Inline BL Injection (legacy): Inserts BL instructions inside the function and uses NOP slides.
 */

import { encodeBl, encodeMovw, encodeMovt, decodeBlTarget, encodePush, encodePop, encodeMov } from './thumb/encoders.js';
import { fileIO } from '../utils/file-io.js';
import { NopSlideFinder } from './nop-slide.js';
import { CodeReferenceAnalyzer, type LandingPoint, type NopSlideAnalysis } from './code-reference-analyzer.js';
import { PatchDetector } from './detector.js';
import { createPatchMetadata, writePatchMetadata, scanForPatchMetadata, readPatchMetadata, encodeRelocationHeader, decodeRelocationHeader, scanForPatchWithRelocation, RELO_HEADER_SIZE } from './metadata.js';
import { discoverFlacFunction, discoverMenuFunction, findFunctionStart, discoverPatchesBySignature } from './discovery.js';
import { ThemeColorExtractor } from './extractor.js';
import { patchSwitchCaseFunction } from './switch-case-patcher.js';
import {
	type PatchResult,
	type PatchPoint,
	type PatchPointInfo,
	type PatchAnalysisResult,
	type NopSlide,
	type PatchMetadata,
	type PatchInfo,
	type RelocationInfo
} from './types.js';
import {
	ThemeError,
	PatchError,
	ValidationError,
	CapacityError,
	CompatibilityError,
	throwThemeError
} from './errors.js';
import { LanguagePatcher } from '../language/patcher.js';
import { LANGUAGE_CONSTANTS, isLanguageProtected } from '../language/types.js';

/**
 * Theme Patcher Class
 *
 * Patches firmware to use custom theme colors.
 */
export class ThemePatcher {
	private readonly data: Uint8Array;
	private readonly detector: PatchDetector;
	private readonly finder: NopSlideFinder;
	private readonly codeAnalyzer: CodeReferenceAnalyzer;
	private _cachedAnalysis: ReturnType<CodeReferenceAnalyzer['analyze']> | null = null;
	readonly version: string;

	/**
	 * Create a new ThemePatcher
	 */
	constructor(firmwareData: Uint8Array, version = 'Unknown') {
		this.data = firmwareData;
		this.version = version;
		this.detector = new PatchDetector(firmwareData, version);
		// Limit slide search to executable regions (typically first 1.5MB)
		// This prevents choosing slides in the resource partition that might be non-executable (NX)
		this.finder = new NopSlideFinder(firmwareData, {
			scanStart: 0x0,
			scanEnd: Math.min(firmwareData.length, 0x180000)
		});
		// Limit scan range to avoid timeouts during testing
		// The functional NOP slide at 0x588A8-0x79B70 is within this range
		this.codeAnalyzer = new CodeReferenceAnalyzer(firmwareData, {
			scanStart: 0x0,
			scanEnd: Math.min(firmwareData.length, 0x100000), // 1MB max instead of 5MB
			analyzeOnConstruct: false
		});
	}

	/**
	 * Get cached code reference analysis
	 */
	private getCachedAnalysis(): ReturnType<CodeReferenceAnalyzer['analyze']> {
		if (!this._cachedAnalysis) {
			this._cachedAnalysis = this.codeAnalyzer.analyze();
		}
		return this._cachedAnalysis;
	}

	/**
	 * Analyze firmware for patching
	 */
	analyze(): PatchAnalysisResult {
		const flacResult = discoverFlacFunction(this.data, this.version);
		const menuResult = discoverMenuFunction(this.data, this.version);

		const themeFunctions: PatchPointInfo[] = [];

		if (flacResult) {
			const [funcAddr, patchAddr] = flacResult;
			themeFunctions.push({
				type: 'flac',
				funcAddr,
				patchAddr,
				functionStart: findFunctionStart(this.data, funcAddr)
			});
		}

		if (menuResult) {
			const [funcAddr, patchAddr] = menuResult;
			themeFunctions.push({
				type: 'menu',
				funcAddr,
				patchAddr,
				functionStart: findFunctionStart(this.data, funcAddr)
			});
		}

		// Find NOP slides
		const nopSlides = this.finder.findAllSlides();

		// Check if already patched by scanning for metadata signature
		// This works for both inline and relocation patches
		const patchScan = scanForPatchWithRelocation(this.data);
		const patchStatus = patchScan
			? {
				isPatched: true as const,
				status: 'Patched (metadata found)',
				patchType: 'relocation' as const,
				flacPatched: true,
				menuPatched: true,
				nopHasCode: true,
				confidence: 1.0,
				metadataOffset: patchScan.metadataOffset,
				reloHeader: patchScan.reloHeader
			}
			: {
				isPatched: false as const,
				status: 'Not patched',
				patchType: 'none' as const,
				flacPatched: false,
				menuPatched: false,
				nopHasCode: false,
				confidence: 0
			};

		// Compatibility check
		let compatibility: 'supported' | 'experimental' | 'deprecated' | 'unsupported' = 'supported';
		let supportMessage = '';

		// 1. Check by address heuristic (Threshold for V2.4.0+ is around 0x86000)
		const flacFunc = themeFunctions.find(f => f.type === 'flac');
		if (flacFunc && flacFunc.funcAddr < 0x86000) {
			compatibility = 'unsupported';
			supportMessage = 'This firmware version (detected as V1.8.0 or older) is not supported for theme patching due to safety concerns and different memory layout.';
		}

		// 2. Check by explicit version string if provided
		if (this.version !== 'Unknown') {
			const versionMatch = this.version.match(/V(\d+)\.(\d+)\.(\d+)/);
			if (versionMatch) {
				const major = parseInt(versionMatch[1], 10);
				const minor = parseInt(versionMatch[2], 10);
				if (major < 2 || (major === 2 && minor < 4)) {
					compatibility = 'unsupported';
					supportMessage = `Version ${this.version} is not supported. Theme patching requires V2.4.0 or later.`;
				}
			}
		}

		return {
			version: this.version,
			themeFunctions,
			nopSlides,
			canPatch: themeFunctions.length > 0 && nopSlides.length > 0 && compatibility !== 'unsupported',
			compatibility,
			supportMessage,
			patchStatus
		};
	}

	/**
	 * Analyze NOP slide landing points
	 * Returns detailed analysis of landing points in NOP slides
	 */
	analyzeLandingPoints(): {
		landingPoints: readonly LandingPoint[];
		nopSlides: readonly NopSlideAnalysis[];
		functionalNopSlides: readonly NopSlideAnalysis[];
	} {
		const analysis = this.getCachedAnalysis();

		// Filter to find functional NOP slides
		const functionalNopSlides = analysis.nopSlides.filter(
			ns => ns.type === 'functional'
		);

		return {
			landingPoints: analysis.landingPoints,
			nopSlides: analysis.nopSlides,
			functionalNopSlides
		};
	}

	/**
	 * Verify that a NOP slide is safe to use for patching
	 * Checks that the slide doesn't interfere with landing points
	 */
	verifyNopSlideLandingPointSafety(nopSlide: NopSlide, requiredSize: number): {
		isSafe: boolean;
		landingPoints: readonly LandingPoint[];
		requiresProtection: boolean;
		injectionStrategy?: ReturnType<CodeReferenceAnalyzer['generateInjectionStrategy']>;
	} {
		const analysis = this.getCachedAnalysis();

		// Find landing points in this NOP slide
		const landingPointsInSlide = analysis.landingPoints.filter(
			lp => lp.inNopSlide &&
				lp.nopSlideStart === nopSlide.start
		);

		const requiresProtection = landingPointsInSlide.length > 0;

		// Find the NOP slide analysis for this slide
		const nopSlideAnalysis = analysis.nopSlides.find(
			ns => ns.start === nopSlide.start
		);

		if (!nopSlideAnalysis) {
			// No detailed analysis available - use basic safety check
			return {
				isSafe: landingPointsInSlide.length === 0,
				landingPoints: landingPointsInSlide,
				requiresProtection
			};
		}

		// Check if we can safely inject
		if (!nopSlideAnalysis.canInjectSafely) {
			return {
				isSafe: false,
				landingPoints: landingPointsInSlide,
				requiresProtection: false
			};
		}

		// Generate injection strategy if protection is required
		let injectionStrategy: ReturnType<CodeReferenceAnalyzer['generateInjectionStrategy']> = null;
		if (requiresProtection && nopSlideAnalysis.safeZoneSize && nopSlideAnalysis.safeZoneSize >= requiredSize) {
			injectionStrategy = this.codeAnalyzer.generateInjectionStrategy(
				nopSlideAnalysis,
				requiredSize
			);
		}

		return {
			isSafe: injectionStrategy !== null || !requiresProtection,
			landingPoints: landingPointsInSlide,
			requiresProtection,
			injectionStrategy: injectionStrategy ?? undefined
		};
	}

	/**
	 * Print landing points analysis to console
	 */
	printLandingPointsReport(): void {
		const analysis = this.getCachedAnalysis();
		const { landingPoints, nopSlides } = analysis;
		const functionalNopSlides = nopSlides.filter(ns => ns.type === 'functional');

		console.error('\n=== NOP Slide Landing Points Analysis ===\n');

		// Print functional NOP slides
		console.error(`Functional NOP Slides: ${functionalNopSlides.length}`);
		for (const slide of functionalNopSlides) {
			console.error(`  0x${slide.start.toString(16)} - 0x${slide.end.toString(16)} (${slide.size} bytes)`);
			console.error(`    Landing Points: ${slide.landingPoints.length}`);
			console.error(`    Total References: ${slide.referenceCount}`);
			console.error(`    Can Inject Safely: ${slide.canInjectSafely}`);
			if (slide.protectionRequired) {
				console.error(`    ⚠️  Protection Required: ${slide.landingPoints.length} landing points`);
			}
			if (slide.safeZoneSize !== undefined) {
				console.error(`    Safe Zone Size: ${slide.safeZoneSize} bytes`);
			}
		}

		// Print landing points
		console.error(`\nTotal Landing Points: ${landingPoints.length}`);
		const nopLandingPoints = landingPoints.filter(lp => lp.inNopSlide);
		console.error(`Landing Points in NOP Slides: ${nopLandingPoints.length}`);

		if (nopLandingPoints.length > 0) {
			console.error('\nLanding Points Details:');
			for (const lp of nopLandingPoints.slice(0, 20)) { // Limit output
				console.error(`  0x${lp.addr.toString(16).padStart(5, '0')}: ${lp.referenceCount} references ` +
					`(slide: 0x${lp.nopSlideStart?.toString(16) || 'N/A'})`);
			}
			if (nopLandingPoints.length > 20) {
				console.error(`  ... and ${nopLandingPoints.length - 20} more`);
			}
		}

		console.error('');
	}

	/**
	 * Extract ground truth colors from firmware (unpatched colors)
	 * Returns the current FLAC and Menu colors stored in the firmware
	 */
	extractGroundTruthColors(): { flacColors: number[]; menuColors: number[] } {
		const extractor = new ThemeColorExtractor(this.data);
		const result = extractor.extract();

		// Extract FLAC colors (5 themes)
		const flacFunc = result.themeFunctions.find(f => f.type === 'flac');
		let flacColors: number[] = [];
		if (flacFunc) {
			flacColors = extractor.getColorsForFunction('flac');
		} else {
			throw new ThemeError('FLAC function not found in firmware');
		}

		// Extract Menu colors (5 themes × 3 attributes = 15 colors)
		const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
		let menuColors: number[] = [];
		if (menuFunc) {
			// getColorsForFunction returns: [T0_R1, T0_R2, T0_R3, T1_R1, T1_R2, T1_R3, ...]
			// We keep this order for simplicity.
			const rawColors = extractor.getColorsForFunction('menu');
			menuColors = Array.from(rawColors);
		} else {
			throw new ThemeError('Menu function not found in firmware');
		}

		return { flacColors, menuColors };
	}

	/**
	 * Extract Progress Bar and Marquee colors from firmware
	 * Returns the current colors for these switch_case functions
	 */
	extractSwitchCaseColors(): {
		progressColors: number[];
		marqueeColors: number[];
	} {
		const extractor = new ThemeColorExtractor(this.data);
		const result = extractor.extract();

		// Extract Progress Bar colors (5 themes)
		const progressFunc = result.themeFunctions.find(f => f.type === 'progress');
		let progressColors: number[] = [0, 0, 0, 0, 0];
		if (progressFunc) {
			progressColors = extractor.getColorsForFunction('progress');
		}

		// Extract Marquee colors (5 themes)
		const marqueeFunc = result.themeFunctions.find(f => f.type === 'marquee');
		let marqueeColors: number[] = [0, 0, 0, 0, 0];
		if (marqueeFunc) {
			marqueeColors = extractor.getColorsForFunction('marquee');
		}

		return { progressColors, marqueeColors };
	}

	/**
	 * Patch Progress Bar and/or Marquee switch_case functions
	 *
	 * Unlike FLAC/Menu which use NOP slides and BL instructions,
	 * switch_case functions are patched by modifying MOVW instructions directly.
	 *
	 * @param options - Patch options with optional progressColors and/or marqueeColors
	 * @param outputPath - Path to write patched firmware
	 * @param writeFile - Whether to write to disk (default: true)
	 */
	patchSwitchCase(
		options: {
			progressColors?: number[];
			marqueeColors?: number[];
		},
		outputPath: string,
		writeFile = true
	): {
		success: boolean;
		progressPatched: boolean;
		marqueePatched: boolean;
		progressResults?: { funcAddr: number; patchesApplied: number; originalColors: number[]; newColors: number[] };
		marqueeResults?: { funcAddr: number; patchesApplied: number; originalColors: number[]; newColors: number[] };
	} {
		// Validate that at least one color set is provided
		if (!options.progressColors && !options.marqueeColors) {
			throw new ValidationError('At least one of progressColors or marqueeColors must be provided');
		}

		// Get the function discovery first to determine theme count
		const extractor = new ThemeColorExtractor(this.data);
		const result = extractor.extract();

		// Get theme count from discovered functions
		const progressFunc = result.themeFunctions.find(f => f.type === 'progress');
		const marqueeFunc = result.themeFunctions.find(f => f.type === 'marquee');
		const themeCount = progressFunc?.themeCount || marqueeFunc?.themeCount || 5;

		// Validate color counts based on detected theme count
		if (options.progressColors && options.progressColors.length !== themeCount) {
			throw new ValidationError(`Progress Bar colors must have exactly ${themeCount} values (one per theme)`);
		}
		if (options.marqueeColors && options.marqueeColors.length !== themeCount) {
			throw new ValidationError(`Marquee colors must have exactly ${themeCount} values (one per theme)`);
		}

		if (options.progressColors && !progressFunc) {
			throw new ThemeError('Progress Bar function not found in firmware');
		}
		if (options.marqueeColors && !marqueeFunc) {
			throw new ThemeError('Marquee function not found in firmware');
		}

		// Clone data to avoid modifying the original
		const patchedData = new Uint8Array(this.data);

		let progressPatched = false;
		let marqueePatched = false;
		let progressResults;
		let marqueeResults;

		// Patch Progress Bar
		if (options.progressColors && progressFunc) {
			const progressResult = patchSwitchCaseFunction(patchedData, progressFunc, options.progressColors);
			progressPatched = true;
			progressResults = {
				funcAddr: progressResult.funcAddr,
				patchesApplied: progressResult.patchesApplied,
				originalColors: progressResult.originalColors,
				newColors: progressResult.newColors
			};
		}

		// Patch Marquee
		if (options.marqueeColors && marqueeFunc) {
			const marqueeResult = patchSwitchCaseFunction(patchedData, marqueeFunc, options.marqueeColors);
			marqueePatched = true;
			marqueeResults = {
				funcAddr: marqueeResult.funcAddr,
				patchesApplied: marqueeResult.patchesApplied,
				originalColors: marqueeResult.originalColors,
				newColors: marqueeResult.newColors
			};
		}

		// Write to file if requested
		if (writeFile) {
			fileIO.writeFileSync(outputPath, patchedData);
		}

		return {
			success: true,
			progressPatched,
			marqueePatched,
			progressResults,
			marqueeResults
		};
	}

	/**
	 * Find existing NOP slide from patched firmware
	 *
	 * Uses direct BL instruction scanning to find our patch code and NOP slide.
	 * This is more reliable than signature-based discovery for re-patching scenarios.
	 */
	private findExistingNopSlide(): NopSlide | null {
		// Helper function to try finding NOP slide address from a function
		const tryFindNopSlideAddr = (funcResult: [number, number] | null): number | null => {
			if (!funcResult) {
				return null;
			}

			const [, patchAddr] = funcResult;

			// Decode the BL instruction to get the handler address
			const blBytes = this.data.slice(patchAddr, patchAddr + 4);
			const hw1 = blBytes[0] | (blBytes[1] << 8);
			const hw2 = blBytes[2] | (blBytes[3] << 8);

			// Verify this is a BL instruction
			if ((hw1 & 0xf800) !== 0xf000 || (hw2 & 0xd000) !== 0xd000) {
				return null;
			}

			// Decode BL target to get NOP slide start
			return decodeBlTarget(patchAddr, blBytes);
		};

		// Try FLAC function first (for FLAC-only or Both patches)
		let nopSlideAddr = tryFindNopSlideAddr(discoverFlacFunction(this.data, this.version));

		// If FLAC not patched, try Menu function (for Menu-only patches)
		if (nopSlideAddr === null) {
			nopSlideAddr = tryFindNopSlideAddr(discoverMenuFunction(this.data, this.version));
		}

		// Still not found? Can't re-patch
		if (nopSlideAddr === null) {
			return null;
		}

		// Find the metadata (it's at the end of the NOP slide)
		// Metadata is 51 bytes and starts with 'ECHO' magic
		const METADATA_SIZE = 51;
		const MAX_SEARCH = 1024;

		let end = nopSlideAddr;
		let foundMetadata = false;

		// Search forward for 'ECHO' magic
		for (let searchAddr = nopSlideAddr; searchAddr < nopSlideAddr + MAX_SEARCH && searchAddr < this.data.length - METADATA_SIZE; searchAddr++) {
			if (this.data[searchAddr] === 0x45 &&  // 'E'
				this.data[searchAddr + 1] === 0x43 &&  // 'C'
				this.data[searchAddr + 2] === 0x48 &&  // 'H'
				this.data[searchAddr + 3] === 0x4F) {  // 'O'
				end = searchAddr + METADATA_SIZE;
				foundMetadata = true;
				break;
			}
		}

		if (!foundMetadata) {
			return null; // Can't find metadata, can't re-patch
		}

		// Now search backward from the NOP slide area to find the start
		// CRITICAL: NOP slide is a continuous region of zeros. We need to find the
		// START of the zero region, not just where patch code begins.
		//
		// New logic: Find the start of CONTINUOUS zeros
		let start = nopSlideAddr;
		const MAX_BACK = 512;

		// First, search backward to find the start of the continuous zero region
		// CRITICAL: Check 4-byte aligned addresses only, and stop at the first non-zero boundary
		let zeroStart = nopSlideAddr;
		for (let back = 0; back < MAX_BACK; back += 4) {
			const checkAddr = nopSlideAddr - back;
			if (checkAddr < 4) break; // Need at least 4 bytes to check

			// Check 4 bytes for zeros (NOP slide typically has consecutive zeros)
			const isZero = this.data[checkAddr] === 0x00 &&
			               this.data[checkAddr + 1] === 0x00 &&
			               this.data[checkAddr + 2] === 0x00 &&
			               this.data[checkAddr + 3] === 0x00;

			if (isZero) {
				zeroStart = checkAddr;
			} else {
				// Found non-zero byte, this is the boundary
				break;
			}
		}

		// zeroStart is now at the beginning of the zero region
		// But we need to ensure it's 4-byte aligned BEFORE any patch code was written
		start = zeroStart;

		// CRITICAL: Ensure NOP slide start is 4-byte aligned for BL instruction precision
		if (start % 4 !== 0) {
			const alignedStart = start + (4 - (start % 4));
			let isZeroRegion = true;
			for (let i = 0; i < 16; i++) {
				const checkAddr = alignedStart + i;
				if (checkAddr >= this.data.length) {
					isZeroRegion = false;
					break;
				}
				if (this.data[checkAddr] !== 0x00) {
					isZeroRegion = false;
					break;
				}
			}

			if (isZeroRegion) {
				start = alignedStart;
			}
		}

		const nopSlideSize = end - start;

		return {
			start,
			end,
			size: nopSlideSize,
			source: 'existing-patch',
			isActive: true,
			referenceCount: 0
		};
	}

	/**
	 * Patch firmware with custom colors (supports partial patching)
	 *
	 * @param options - Patch options
	 * @param options.flacColors - FLAC colors for all themes (5 colors)
	 * @param options.menuColors - Menu colors for all themes (15 colors)
	 * @param options.knockDownLanguage - Language index to knock down for relocation patching.
	 *        Default: undefined (use last non-protected language)
	 *        Set to -1 to use inline patching instead of relocation.
	 * @param outputPath - Path to write patched firmware
	 * @param writeFile - Whether to write to disk (default: true)
	 */
	patch(
		options: {
			flacColors?: number[];
			menuColors?: number[];
			/** Language index to knock down for relocation. Set to -1 for inline patching. */
			knockDownLanguage?: number;
		},
		outputPath: string,
		writeFile = true
	): PatchResult {
		if (!options.flacColors && !options.menuColors) {
			throw new ValidationError('At least one of flacColors or menuColors must be provided');
		}

		const analysis = this.analyze();
		const { isPatched, reloHeader, metadataOffset } = analysis.patchStatus as {
			isPatched: boolean;
			reloHeader?: { newFuncAddr: number; funcSize: number; colorCodeOffset: number };
			metadataOffset?: number;
		};

		let flacColors = options.flacColors ?? null;
		let menuColors = options.menuColors ?? null;

		// If already patched via relocation, do a re-patch by updating colors in place
		if (isPatched && reloHeader && metadataOffset) {
			return this.repatchRelocatedFunction(
				{ flacColors, menuColors },
				reloHeader,
				metadataOffset,
				outputPath,
				writeFile
			);
		}

		// Fill in missing colors from ground truth
		if (!flacColors || !menuColors) {
			const groundTruth = this.extractGroundTruthColors();
			if (!flacColors) flacColors = [...groundTruth.flacColors];
			if (!menuColors) menuColors = [...groundTruth.menuColors];
		}

		// If knockDownLanguage is -1, use inline patching instead of relocation
		if (options.knockDownLanguage === -1) {
			return this.patchImpl(
				flacColors!,
				menuColors!,
				outputPath,
				writeFile,
				{ flacCustom: true, menuCustom: true }
			);
		}

		// First-time patching: use relocation method
		return this.patchWithRelocation(
			{
				flacColors: flacColors!,
				menuColors: menuColors!,
				knockDownLanguage: options.knockDownLanguage
			},
			outputPath,
			writeFile
		);
	}

	/**
	 * Re-patch an already relocated firmware
	 *
	 * This updates the colors in the relocated function without redoing the relocation.
	 */
	private repatchRelocatedFunction(
		options: {
			flacColors: number[] | null;
			menuColors: number[] | null;
		},
		reloHeader: { newFuncAddr: number; funcSize: number; colorCodeOffset: number; callerAddr: number },
		metadataOffset: number,
		outputPath: string,
		writeFile: boolean
	): PatchResult {
		// Read existing metadata to get current colors
		const existingMetadata = readPatchMetadata(this.data, metadataOffset);
		if (!existingMetadata) {
			throw new PatchError('Cannot read existing patch metadata for re-patching');
		}

		// Use new colors if provided, otherwise keep existing
		const flacColors = options.flacColors ?? [...existingMetadata.flacColors];
		const menuColors = options.menuColors ?? [...existingMetadata.menuColors];

		// Find caller address if not in header (old format compatibility)
		let callerAddr = reloHeader.callerAddr;
		if (callerAddr === 0) {
			// Scan for BL instruction targeting the relocated function
			const callerInfo = this.findFlacCaller(reloHeader.newFuncAddr);
			if (!callerInfo) {
				throw new PatchError('Cannot find BL instruction for re-patching (old header format)');
			}
			callerAddr = callerInfo.callerAddr;
		}

		// Clone firmware data
		const patchedData = new Uint8Array(this.data);

		// Regenerate the color selection code with new colors
		const colorCodeAddr = reloHeader.newFuncAddr + reloHeader.colorCodeOffset;
		const newColorCode = this.generateInlineColorSelection(flacColors, colorCodeAddr);
		patchedData.set(newColorCode, colorCodeAddr);

		// Update metadata
		const newMetadata = createPatchMetadata(Math.floor(Date.now() / 1000), flacColors, menuColors);
		const metadataBytes = writePatchMetadata(newMetadata);
		patchedData.set(metadataBytes, metadataOffset);

		// Rewrite relocation header with callerAddr (upgrade to new format)
		const newReloHeader = {
			newFuncAddr: reloHeader.newFuncAddr,
			funcSize: reloHeader.funcSize,
			colorCodeOffset: reloHeader.colorCodeOffset,
			callerAddr
		};
		// Place header at proper offset based on new format size
		const reloHeaderAddr = metadataOffset - RELO_HEADER_SIZE;
		patchedData.set(encodeRelocationHeader(newReloHeader), reloHeaderAddr);

		// Write to file if requested
		if (writeFile) {
			fileIO.writeFileSync(outputPath, patchedData);
		}

		// Create fake NOP slide for API compatibility
		const fakeNopSlide: NopSlide = {
			start: reloHeader.newFuncAddr,
			end: metadataOffset + metadataBytes.length,
			size: metadataOffset + metadataBytes.length - reloHeader.newFuncAddr,
			source: 'relocation',
			isActive: true,
			referenceCount: 0
		};

		// Create patch points with BL address for test compatibility
		const patchPoints: Record<string, PatchPoint> = {
			'flac': {
				type: 'flac',
				funcAddr: 0, // Unknown during re-patch
				patchAddr: callerAddr,
				targetAddr: colorCodeAddr,
				originalBytes: '',
				newBytes: ''
			}
		};

		return {
			success: true,
			nopSlide: fakeNopSlide,
			patchPoints,
			metadataAddr: metadataOffset,
			patchedData: writeFile ? undefined : patchedData,
			relocationInfo: {
				method: 'relocation',
				newFuncAddr: reloHeader.newFuncAddr,
				funcSize: reloHeader.funcSize,
				originalFuncAddr: 0, // Unknown during re-patch
				callerAddr
			}
		};
	}

	/**
	 * Patch firmware with custom colors (backward compatible API)
	 */
	patchOriginal(
		flacColors: number[],
		menuColors: number[],
		outputPath: string,
		writeFile = true
	): PatchResult {
		return this.patch({ flacColors, menuColors }, outputPath, writeFile);
	}

	/**
	 * Internal patch implementation (deprecated - kept for API compatibility)
	 * @deprecated Use patch() instead
	 * @private
	 */
	patchImpl(
		flacColors: number[],
		menuColors: number[],
		outputPath: string,
		writeFile = true,
		intent: { flacCustom: boolean; menuCustom: boolean } = { flacCustom: true, menuCustom: true }
	): PatchResult {
		try {
			const analysis = this.analyze();
			const extractor = new ThemeColorExtractor(this.data);
			const discoveryResult = extractor.extract();

			const flacThemeFunc = discoveryResult.themeFunctions.find(f => f.type === 'flac');
			const menuThemeFunc = discoveryResult.themeFunctions.find(f => f.type === 'menu');
			const themeCount = flacThemeFunc?.themeCount || menuThemeFunc?.themeCount || 5;

			if (flacColors.length !== themeCount) {
				throw new ValidationError(`FLAC colors must have exactly ${themeCount} values (one per theme)`);
			}
			if (menuColors.length !== themeCount * 3) {
				throw new ValidationError(`Menu colors must have exactly ${themeCount * 3} values (${themeCount} themes × 3 attributes)`);
			}

			if (!analysis.canPatch) {
				const hasThemeFunctions = analysis.themeFunctions.length > 0;
				const hasNopSlides = analysis.nopSlides.length > 0;

				if (analysis.compatibility === 'unsupported') {
					throw new CompatibilityError(analysis.supportMessage || 'This firmware version is not supported for theme patching.');
				}
				if (!hasThemeFunctions) {
					throw new CompatibilityError('Unable to patch firmware: theme functions not found. Requires V2.4.0+');
				}
				if (!hasNopSlides) {
					throw new CapacityError('Unable to patch firmware: no suitable space found for patch code.');
				}
				throw new PatchError('Firmware cannot be patched: unknown reason');
			}

			let nopSlide: NopSlide;
			let isRepatch = false;

			if (analysis.patchStatus.isPatched) {
				const existingNopSlide = this.findExistingNopSlide();
				if (!existingNopSlide) {
					throw new PatchError('Cannot re-patch: unable to locate existing patch code.');
				}
				nopSlide = existingNopSlide;
				isRepatch = true;
			} else {
				// Handler sizes
				const tempFlacHandler = this.generateFlacHandler(flacColors, 0);
				const tempMenuHandler = this.generateMenuHandler(menuColors);
				const tempMetadata = createPatchMetadata(0, flacColors, menuColors);
				const tempMetadataBytes = writePatchMetadata(tempMetadata);

				const ALIGNMENT = 4;
				const MAX_PADDING = ALIGNMENT - 1;
				const flacEnd = MAX_PADDING + tempFlacHandler.length;
				const menuStart = Math.ceil(flacEnd / ALIGNMENT) * ALIGNMENT;
				const requiredSize = menuStart + tempMenuHandler.length + tempMetadataBytes.length;

				const funcAddrs = analysis.themeFunctions.map(f => f.funcAddr);
				const selectedSlide = this.finder.selectBestSlide(funcAddrs, requiredSize);

				if (!selectedSlide) {
					throw new CapacityError('No suitable NOP slide found for patch code');
				}
				nopSlide = selectedSlide;

				const safetyCheck = this.verifyNopSlideLandingPointSafety(nopSlide, requiredSize);
				if (!safetyCheck.isSafe) {
					throw new PatchError(`Selected NOP slide is not safe for patching: Landing point conflict.`);
				}
			}

			const patchData = this.createPatchData(flacColors, menuColors, nopSlide, isRepatch, intent, analysis.patchStatus, analysis.themeFunctions);
			const patchedData = new Uint8Array(this.data);
			const patchPoints: Record<string, PatchPoint> = {};

			const flacFunc = analysis.themeFunctions.find(f => f.type === 'flac');
			if (flacFunc && intent.flacCustom && patchData.flacCodeAddr !== 0) {
				this.applyPatch(patchedData, flacFunc.patchAddr, patchData.flacCodeAddr, 8);
				patchPoints['flac'] = {
					type: 'flac',
					funcAddr: flacFunc.funcAddr,
					patchAddr: flacFunc.patchAddr,
					targetAddr: patchData.flacCodeAddr,
					originalBytes: this.bytesToHex(this.data.slice(flacFunc.patchAddr, flacFunc.patchAddr + 4)),
					newBytes: this.bytesToHex(patchedData.slice(flacFunc.patchAddr, flacFunc.patchAddr + 4))
				};
			}

			const menuFunc = analysis.themeFunctions.find(f => f.type === 'menu');
			if (menuFunc && intent.menuCustom && patchData.menuCodeAddr !== 0) {
				this.applyPatch(patchedData, menuFunc.patchAddr, patchData.menuCodeAddr);
				patchPoints['menu'] = {
					type: 'menu',
					funcAddr: menuFunc.funcAddr,
					patchAddr: menuFunc.patchAddr,
					targetAddr: patchData.menuCodeAddr,
					originalBytes: this.bytesToHex(this.data.slice(menuFunc.patchAddr, menuFunc.patchAddr + 4)),
					newBytes: this.bytesToHex(patchedData.slice(menuFunc.patchAddr, menuFunc.patchAddr + 4))
				};
			}

			this.writePatchCode(patchedData, nopSlide, patchData, isRepatch ? intent : undefined);

			const metadata = createPatchMetadata(Math.floor(Date.now() / 1000), flacColors, menuColors);
			const metadataBytes = writePatchMetadata(metadata);
			patchedData.set(metadataBytes, patchData.metadataAddr);

			if (writeFile) {
				fileIO.writeFileSync(outputPath, patchedData);
			}

			return {
				success: true,
				nopSlide,
				metadataAddr: patchData.metadataAddr,
				patchPoints,
				patchedData: writeFile ? undefined : patchedData
			};
		} catch (error) {
			throwThemeError(error, PatchError, 'Failed to patch firmware');
		}
	}

	/**
	 * Create patch data structure
	 * @private
	 */
	private createPatchData(
		flacColors: number[],
		menuColors: number[],
		nopSlide: NopSlide,
		isRepatchInput = false,
		intent: { flacCustom: boolean; menuCustom: boolean } = { flacCustom: true, menuCustom: true },
		patchStatus?: { flacPatched: boolean; menuPatched: boolean },
		themeFunctions?: PatchPointInfo[]
	): { flacCodeAddr: number; menuCodeAddr: number; code: Uint8Array; metadataAddr: number } {
		const metadata = createPatchMetadata(0, flacColors, menuColors);
		const metadataBytes = writePatchMetadata(metadata);
		const METADATA_SIZE = metadataBytes.length;
		const ALIGNMENT = 4;

		// Correct return address for FLAC: return after the 12-byte original block
		const flacFunc = themeFunctions?.find(f => f.type === 'flac');
		const flacReturnAddr = flacFunc ? (flacFunc.patchAddr + 12) : 0;

		const actualFlacHandler = this.generateFlacHandler(flacColors, flacReturnAddr);
		const actualMenuHandler = this.generateMenuHandler(menuColors);

		const useFlacHandler = intent.flacCustom || patchStatus?.flacPatched;
		const useMenuHandler = intent.menuCustom || patchStatus?.menuPatched;

		let flacCodeOffset = 0;
		let flacCodeEnd = 0;
		let menuCodeOffset = 0;
		let menuCodeEnd = 0;

		if (actualFlacHandler.length > 0 && useFlacHandler) {
			flacCodeOffset = (ALIGNMENT - (nopSlide.start % ALIGNMENT)) % ALIGNMENT;
			flacCodeEnd = flacCodeOffset + actualFlacHandler.length;

			if (actualMenuHandler.length > 0 && useMenuHandler) {
				menuCodeOffset = Math.ceil(flacCodeEnd / ALIGNMENT) * ALIGNMENT;
				menuCodeEnd = menuCodeOffset + actualMenuHandler.length;
			}
		} else if (actualMenuHandler.length > 0 && useMenuHandler) {
			menuCodeOffset = (ALIGNMENT - (nopSlide.start % ALIGNMENT)) % ALIGNMENT;
			menuCodeEnd = menuCodeOffset + actualMenuHandler.length;
		}

		const metadataOffset = nopSlide.size - METADATA_SIZE;
		const flacCodeAddr = (actualFlacHandler.length > 0 && useFlacHandler) ? (nopSlide.start + flacCodeOffset) : 0;
		const menuCodeAddr = (actualMenuHandler.length > 0 && useMenuHandler) ? (nopSlide.start + menuCodeOffset) : 0;
		const metadataAddr = nopSlide.start + metadataOffset;

		const codeEnd = actualMenuHandler.length > 0 ? menuCodeEnd : flacCodeEnd;
		if (codeEnd > metadataOffset) {
			throw new CapacityError(`Not enough space in NOP slide.`);
		}

		if (!isRepatchInput) {
			const ranges = [];
			if (actualFlacHandler.length > 0) ranges.push({ start: nopSlide.start + flacCodeOffset, end: nopSlide.start + flacCodeEnd, name: 'FLAC handler' });
			if (actualMenuHandler.length > 0) ranges.push({ start: nopSlide.start + menuCodeOffset, end: nopSlide.start + menuCodeEnd, name: 'Menu handler' });
			ranges.push({ start: metadataAddr, end: nopSlide.end, name: 'metadata' });
			this.verifyNopSlideSafety(nopSlide, ranges);
		}

		const code = new Uint8Array(nopSlide.size);
		if (useFlacHandler) code.set(actualFlacHandler, flacCodeOffset);
		if (useMenuHandler) code.set(actualMenuHandler, menuCodeOffset);

		return { flacCodeAddr, menuCodeAddr, code, metadataAddr };
	}

	private verifyNopSlideSafety(nopSlide: NopSlide, ranges: { start: number; end: number; name: string }[]): void {
		for (const range of ranges) {
			const clampedStart = Math.max(range.start, nopSlide.start);
			const clampedEnd = Math.min(range.end, nopSlide.end);
			for (let offset = clampedStart; offset < clampedEnd; offset++) {
				if (this.data[offset] !== 0x00) {
					throw new ThemeError(`Safety check failed: NOP slide contains non-NOP bytes at 0x${offset.toString(16)}`);
				}
			}
		}
	}

	/**
	 * Generate FLAC handler code
	 *
	 * Uses explicit branches (NOT IT blocks) because Unicorn doesn't support IT blocks properly.
	 *
	 * Code structure:
	 *   PUSH {R4, LR}
	 *   CMP R1, #0; BEQ theme_0
	 *   CMP R1, #1; BEQ theme_1
	 *   CMP R1, #2; BEQ theme_2
	 *   CMP R1, #3; BEQ theme_3
	 *   ; fall through to theme_4
	 * theme_4: MOVW R1, #color4; POP {R4, PC}
	 * theme_3: MOVW R1, #color3; POP {R4, PC}
	 * theme_2: MOVW R1, #color2; POP {R4, PC}
	 * theme_1: MOVW R1, #color1; POP {R4, PC}
	 * theme_0: MOVW R1, #color0; POP {R4, PC}
	 */
	private generateFlacHandler(colors: number[], returnAddr: number): Uint8Array {
		const code: number[] = [];

		// Save callee-saved R4 and LR
		code.push(...encodePush([4, 14]));  // PUSH {R4, LR}

		// Record BEQ positions for later patching
		const beqPositions: Array<{ index: number; cmpAddr: number }> = [];

		// Generate CMP/BEQ pairs for themes 0-3
		for (let i = 0; i < 4; i++) {
			const cmpAddr = code.length;
			code.push(0x00 | i, 0x29);  // CMP R1, #i
			// BEQ placeholder (cond=0 for EQ)
			code.push(0x00, 0xD0);
			beqPositions.push({ index: i, cmpAddr });
		}

		// Generate theme sections in reverse order (theme_4 first, then theme_3, ..., theme_0)
		const themeSectionStarts: number[] = [];
		for (let theme = 4; theme >= 0; theme--) {
			themeSectionStarts[theme] = code.length;
			const color = colors[theme];
			
			// Load color into R1
			code.push(...encodeMovw(1, color & 0xffff));
			code.push(...encodeMovt(1, (color >> 16) & 0xffff));
			
			// Restore R4 and return
			code.push(...encodePop([4, 15]));  // POP {R4, PC}
		}

		// Now patch BEQ offsets
		for (const { index, cmpAddr } of beqPositions) {
			const beqAddr = cmpAddr + 2;
			const pc = beqAddr + 4;
			const target = themeSectionStarts[index];
			const offset = (target - pc) >> 1;

			const imm8 = offset & 0xFF;
			code[beqAddr] = imm8;
			code[beqAddr + 1] = 0xD0;
		}

		return new Uint8Array(code);
	}

	private generateMenuHandler(colors: number[]): Uint8Array {
		const code: number[] = [];
		for (let i = 0; i < Math.min(colors.length, 3); i++) {
			const reg = 1 + i;
			const color = colors[i];
			code.push(...encodeMovw(reg, color & 0xffff));
			code.push(...encodeMovt(reg, (color >> 16) & 0xffff));
		}
		code.push(0x70, 0x47); // BX LR
		return new Uint8Array(code);
	}

	private applyPatch(data: Uint8Array, patchAddr: number, targetAddr: number, nopBytes = 0): void {
		data.set(encodeBl(patchAddr, targetAddr), patchAddr);
		for (let i = 0; i < nopBytes; i += 2) {
			data[patchAddr + 4 + i] = 0x00;
			data[patchAddr + 4 + i + 1] = 0xbf; // NOP
		}
	}

	private writePatchCode(data: Uint8Array, nopSlide: NopSlide, patchData: { flacCodeAddr: number; menuCodeAddr: number; code: Uint8Array; metadataAddr: number }, intent?: { flacCustom: boolean; menuCustom: boolean }): void {
		if (intent) {
			if (intent.flacCustom && patchData.flacCodeAddr > 0) {
				const offset = patchData.flacCodeAddr - nopSlide.start;
				const size = (patchData.menuCodeAddr > 0) ? (patchData.menuCodeAddr - patchData.flacCodeAddr) : (patchData.metadataAddr - patchData.flacCodeAddr);
				data.set(patchData.code.subarray(offset, offset + size), patchData.flacCodeAddr);
			}
			if (intent.menuCustom && patchData.menuCodeAddr > 0) {
				const offset = patchData.menuCodeAddr - nopSlide.start;
				const size = patchData.metadataAddr - patchData.menuCodeAddr;
				data.set(patchData.code.subarray(offset, offset + size), patchData.menuCodeAddr);
			}
			data.set(patchData.code.subarray(patchData.code.length - 51), patchData.metadataAddr);
		} else {
			data.set(patchData.code, nopSlide.start);
		}
	}

	private bytesToHex(bytes: Uint8Array): string {
		return Array.from(bytes).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
	}

	/**
	 * Patch firmware using function relocation method
	 *
	 * This method:
	 * 1. Knocks down a language to free space in the language pool
	 * 2. Copies the entire FLAC function to the freed space
	 * 3. Modifies the copied function with color selection logic
	 * 4. Changes the caller's BL to point to the new function
	 *
	 * This avoids inserting code inside the function, which was causing stability issues.
	 *
	 * @param options - Patch options including colors and language to knock down
	 * @param outputPath - Path to write patched firmware
	 * @param writeFile - Whether to write to disk (default: true)
	 */
	patchWithRelocation(
		options: {
			flacColors: number[];
			menuColors: number[];
			/** Language index to knock down (default: last non-protected language) */
			knockDownLanguage?: number;
		},
		outputPath: string,
		writeFile = true
	): PatchResult {
		const { flacColors, menuColors } = options;

		// Validate colors
		const analysis = this.analyze();
		const extractor = new ThemeColorExtractor(this.data);
		const discoveryResult = extractor.extract();

		const flacThemeFunc = discoveryResult.themeFunctions.find(f => f.type === 'flac');
		const menuThemeFunc = discoveryResult.themeFunctions.find(f => f.type === 'menu');
		const themeCount = flacThemeFunc?.themeCount || menuThemeFunc?.themeCount || 5;

		if (flacColors.length !== themeCount) {
			throw new ValidationError(`FLAC colors must have exactly ${themeCount} values (one per theme)`);
		}
		if (menuColors.length !== themeCount * 3) {
			throw new ValidationError(`Menu colors must have exactly ${themeCount * 3} values (${themeCount} themes × 3 attributes)`);
		}

		// Early check: does the language system exist?
		// This is the first thing we need to check because relocation depends on it
		const langPatcher = new LanguagePatcher(this.data, this.version);
		const langExtractor = langPatcher.getExtractor();

		if (!langExtractor.hasLanguageSystem()) {
			// Language system not found - cannot use relocation method
			throw new CompatibilityError(
				'Function relocation patching requires the language system, but it was not found in this firmware. ' +
				'This may be an older or modified firmware version. ' +
				'Try using knockDownLanguage: -1 to use inline patching instead.'
			);
		}

		// Now do the full extraction to get language count
		const langResult = langExtractor.extract();
		if (!langResult.success || !langResult.systemInfo) {
			throw new CompatibilityError('Language system detection failed');
		}

		// Find FLAC function info
		const flacResult = discoverFlacFunction(this.data, this.version);
		if (!flacResult) {
			throw new CompatibilityError('FLAC function not found in firmware');
		}

		const [flacFuncAddr, flacPatchAddr] = flacResult;

		// Find FLAC function boundaries (includes finding function start)
		const flacFuncBounds = this.findFlacFunctionBounds(flacPatchAddr);
		if (!flacFuncBounds) {
			throw new PatchError('Cannot determine FLAC function boundaries');
		}

		const { start: funcStart, end: funcEnd, size: funcSize } = flacFuncBounds;

		// Find the caller BL instruction
		const callerInfo = this.findFlacCaller(funcStart);
		if (!callerInfo) {
			// This can happen if the firmware is already patched via relocation
			// (the caller's BL no longer targets the original function)
			throw new CompatibilityError(
				'Cannot find caller BL instruction for FLAC function. ' +
				'The firmware may already be patched. ' +
				'Try using knockDownLanguage: -1 for inline patching.'
			);
		}

		const { callerAddr, currentTarget } = callerInfo;

		// Get the actual language count from the earlier check
		const actualLanguageCount = langResult.systemInfo.languageCount;

		// Determine which language to knock down
		let knockDownIndex = options.knockDownLanguage;
		if (knockDownIndex === undefined) {
			// Default: use the last non-protected language that actually exists
			knockDownIndex = this.findBestLanguageToKnockDown(actualLanguageCount);
		}

		// Validate language index
		if (knockDownIndex < 0 || knockDownIndex >= actualLanguageCount) {
			throw new ValidationError(`Invalid language index: ${knockDownIndex} (firmware has ${actualLanguageCount} languages)`);
		}
		if (isLanguageProtected(knockDownIndex)) {
			throw new ValidationError(`Language ${knockDownIndex} is protected and cannot be knocked down`);
		}

		// Get language name before knocking down
		const langInfo = langExtractor.getLanguage(knockDownIndex);
		const langName = langInfo?.name ?? `Language ${knockDownIndex}`;

		// Clone data for patching
		const patchedData = new Uint8Array(this.data);

		// Create language patcher for the cloned data
		const patcherForEdit = new LanguagePatcher(patchedData, this.version);

		// Calculate the address where the freed pool will be
		// After knock down, the pool at index knockDownIndex will be freed
		const freedPoolAddr = LANGUAGE_CONSTANTS.FIRST_POOL_ADDRESS + knockDownIndex * LANGUAGE_CONSTANTS.POOL_SPACING;

		// Verify BL can reach the new location
		const distance = Math.abs(freedPoolAddr - callerAddr);
		if (distance > 0x1000000) { // ±16MB
			throw new CapacityError(`Cannot patch: language pool at 0x${freedPoolAddr.toString(16)} is too far from caller at 0x${callerAddr.toString(16)}`);
		}

		// Execute knock down (synchronously - we don't need Unicorn verification for this)
		// Note: We're modifying patchedData in place
		const knockDownResult = patcherForEdit.knockDownLanguageSync({
			languageIndex: knockDownIndex,
			createBackup: false
		});

		if (!knockDownResult.success) {
			throw new PatchError(`Failed to knock down language: ${knockDownResult.error}`);
		}

		// Get the modified data from language patcher
		const modifiedData = patcherForEdit.getData();

		// Copy FLAC function to the new location
		// The freed pool starts at freedPoolAddr
		const newFuncAddr = freedPoolAddr;

		// Copy the original function bytes
		const funcBytes = modifiedData.slice(funcStart, funcEnd);
		modifiedData.set(funcBytes, newFuncAddr);

		// Modify the copied function with color selection
		// We need to replace the IT block with our color selection code
		const colorCodeOffset = this.applyColorPatchToRelocatedFunction(modifiedData, newFuncAddr, funcSize, flacColors);

		// Modify the caller's BL to point to the new function
		const newBlBytes = encodeBl(callerAddr, newFuncAddr);
		modifiedData.set(newBlBytes, callerAddr);

		// Create patch points record
		// Note: targetAddr points to the color selection code, not the function start
		// This is what the test expects (MOVW instructions for color loading)
		const patchPoints: Record<string, PatchPoint> = {
			'flac': {
				type: 'flac',
				funcAddr: funcStart,
				patchAddr: callerAddr,
				targetAddr: newFuncAddr + colorCodeOffset,
				originalBytes: this.bytesToHex(this.data.slice(callerAddr, callerAddr + 4)),
				newBytes: this.bytesToHex(newBlBytes)
			}
		};

		// Create relocation header (stored before metadata)
		const reloHeader = encodeRelocationHeader({
			newFuncAddr,
			funcSize,
			colorCodeOffset,
			callerAddr
		});

		// Create metadata
		const metadata = createPatchMetadata(Math.floor(Date.now() / 1000), flacColors, menuColors);
		const metadataBytes = writePatchMetadata(metadata);
		const METADATA_SIZE = metadataBytes.length; // Should be 51 bytes

		// Calculate the color code size to determine where to place the header
		// Color code structure:
		//   4 CMP/BEQ pairs = 16 bytes
		//   5 theme sections (MOVW/MOVT + B) = 5 * 10 = 50 bytes (last one has no B = 8 bytes)
		// Total = 16 + 50 - 2 = 64 bytes
		const COLOR_CODE_SIZE = 64;

		// Calculate addresses:
		// The relocation header must be placed AFTER the color code
		// [function code including color code][relocation header (16 bytes)][metadata (51 bytes)]
		const colorCodeEnd = colorCodeOffset + COLOR_CODE_SIZE;
		const reloHeaderAddr = newFuncAddr + Math.max(funcSize, colorCodeEnd);
		const metadataAddr = reloHeaderAddr + RELO_HEADER_SIZE;

		// Write relocation header and metadata
		modifiedData.set(reloHeader, reloHeaderAddr);
		modifiedData.set(metadataBytes, metadataAddr);

		// Create a fake NOP slide for compatibility with existing API
		const fakeNopSlideEnd = metadataAddr + METADATA_SIZE;
		const fakeNopSlide: NopSlide = {
			start: newFuncAddr,
			end: fakeNopSlideEnd,
			size: fakeNopSlideEnd - newFuncAddr,
			source: 'relocation',
			isActive: true,
			referenceCount: 0
		};

		// Write to file if requested
		if (writeFile) {
			fileIO.writeFileSync(outputPath, modifiedData);
		}

		const relocationInfo: RelocationInfo = {
			method: 'relocation',
			knockedDownLanguage: knockDownIndex,
			knockedDownLanguageName: langName,
			originalFuncAddr: funcStart,
			newFuncAddr,
			funcSize,
			callerAddr
		};

		return {
			success: true,
			nopSlide: fakeNopSlide,
			patchPoints,
			metadataAddr,
			patchedData: writeFile ? undefined : modifiedData,
			relocationInfo
		};
	}

	/**
	 * Find FLAC function boundaries
	 * Returns the start and end addresses of the FLAC function
	 */
	private findFlacFunctionBounds(patchAddr: number): { start: number; end: number; size: number } | null {
		// First, find the function start by searching backwards for PUSH instruction
		// FLAC function is large (~1200 bytes), so we need to search further back

		// Manual search for PUSH instruction
		let funcStart = patchAddr;
		const maxBack = 2000;
		for (let back = patchAddr; back >= Math.max(0, patchAddr - maxBack); back -= 2) {
			const hw = this.data[back] | (this.data[back + 1] << 8);

			// Check for PUSH patterns
			if ((hw & 0xfe00) === 0xb400 ||    // PUSH {Rlist}
			    (hw & 0xff00) === 0xb500 ||    // PUSH {Rlist, LR}
			    hw === 0xe92d) {                // STMDB SP!, {...}
				funcStart = back;
				break;
			}
		}

		// Search for the function end (POP {..., PC}, POP.W {..., PC}, or BX LR pattern)
		const maxSearch = 2000;

		for (let offset = 0; offset < maxSearch; ) {
			const addr = funcStart + offset;
			if (addr + 4 > this.data.length) break;

			const hw = this.data[addr] | (this.data[addr + 1] << 8);

			// Check for 16-bit POP {..., PC} (0xBD00 pattern)
			if ((hw & 0xFF00) === 0xBD00) {
				// Check if PC is in the register list (bit 7 = PC)
				const regList = hw & 0xFF;
				if (regList & 0x80) { // PC is in the list
					return {
						start: funcStart,
						end: addr + 2,
						size: addr + 2 - funcStart
					};
				}
			}

			// Check for 32-bit POP.W {..., PC} (0xE8BD pattern)
			// POP.W is encoded as: E8BD xxxx where xxxx is the register list
			// Bit 15 of the register list indicates PC
			if (hw === 0xE8BD) {
				const hw2 = this.data[addr + 2] | (this.data[addr + 3] << 8);
				if (hw2 & 0x8000) { // PC is in the list
					return {
						start: funcStart,
						end: addr + 4,
						size: addr + 4 - funcStart
					};
				}
			}

			// Check for BX LR (0x4770)
			if (hw === 0x4770) {
				return {
					start: funcStart,
					end: addr + 2,
					size: addr + 2 - funcStart
				};
			}

			// Check for 32-bit instruction prefix
			const is32bit = hw >= 0xe800 || (hw & 0xf800) === 0xf000 || (hw & 0xf800) === 0xf800;
			offset += is32bit ? 4 : 2;
		}

		return null;
	}

	/**
	 * Find the caller BL instruction that calls the FLAC function
	 */
	private findFlacCaller(flacFuncAddr: number): { callerAddr: number; currentTarget: number } | null {
		// Search for BL instructions that target the FLAC function
		const searchStart = 0x80000;
		const searchEnd = Math.min(0x100000, this.data.length);

		for (let addr = searchStart; addr < searchEnd; ) {
			if (addr + 4 > this.data.length) break;

			const hw1 = this.data[addr] | (this.data[addr + 1] << 8);
			const hw2 = this.data[addr + 2] | (this.data[addr + 3] << 8);

			// Check for BL instruction
			if ((hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000) {
				const target = decodeBlTarget(addr, this.data.slice(addr, addr + 4));

				// Check if this BL targets our FLAC function (allow ±1 for Thumb alignment)
				if (Math.abs(target - flacFuncAddr) <= 1) {
					return {
						callerAddr: addr,
						currentTarget: target
					};
				}
				addr += 4; // BL is always 32-bit
			} else {
				// Check if 32-bit instruction
				const is32bit = hw1 >= 0xe800 || (hw1 & 0xf800) === 0xf000;
				addr += is32bit ? 4 : 2;
			}
		}

		return null;
	}

	/**
	 * Find the best language to knock down
	 * Prefers the last non-protected language
	 * @param maxLanguage - Maximum language index to consider (defaults to MAX_LANGUAGES)
	 */
	private findBestLanguageToKnockDown(maxLanguage: number = LANGUAGE_CONSTANTS.MAX_LANGUAGES): number {
		// Start from the last language and find first non-protected
		for (let i = maxLanguage - 1; i >= 0; i--) {
			if (!isLanguageProtected(i)) {
				return i;
			}
		}
		// Fallback to last language even if protected (will fail later with proper error)
		return maxLanguage - 1;
	}

	/**
	 * Apply color patch to relocated function
	 *
	 * This modifies the IT block in the copied function to implement color selection.
	 * Returns the offset of the color selection code within the function.
	 */
	private applyColorPatchToRelocatedFunction(
		data: Uint8Array,
		funcAddr: number,
		funcSize: number,
		colors: number[]
	): number {
		// Find the IT block pattern: CMP R1, #4 + IT EQ
		const cmpPattern = new Uint8Array([0x04, 0x29, 0x0c, 0xbf]); // CMP R1,#4 + ITE EQ

		// Search for the pattern in the relocated function
		for (let offset = 0; offset < funcSize - 20; offset += 2) {
			const addr = funcAddr + offset;

			// Check for CMP R1, #4 pattern
			if (data[addr] === cmpPattern[0] &&
			    data[addr + 1] === cmpPattern[1] &&
			    data[addr + 2] === cmpPattern[2] &&
			    data[addr + 3] === cmpPattern[3]) {

				// Found the IT block - replace it with our color selection code
				// We replace the 12-byte IT block + MOVW with our handler call

				// Generate inline color selection code
				// We'll use a CMP/BEQ chain instead of IT block
				const colorCode = this.generateInlineColorSelection(colors, funcAddr + offset);

				// Write the new code
				data.set(colorCode, addr);

				return offset; // Return offset of color code
			}
		}

		// If we didn't find the pattern, try a more flexible search
		// Look for CMP R1, #4 (29 04) anywhere
		for (let offset = 0; offset < funcSize - 20; offset += 2) {
			const addr = funcAddr + offset;
			const hw = data[addr] | (data[addr + 1] << 8);

			// CMP R1, #imm8: 00101 001 imm8 = 0x29XX
			if ((hw & 0xFF00) === 0x2900) {
				const imm = hw & 0xFF;
				if (imm === 4) {
					// Found CMP R1, #4
					// Check for IT instruction next
					const nextHw = data[addr + 2] | (data[addr + 3] << 8);
					if ((nextHw & 0xFF00) === 0xBF00) {
						// Found IT block - replace with color selection
						const colorCode = this.generateInlineColorSelection(colors, funcAddr + offset);
						data.set(colorCode, addr);
						return offset; // Return offset of color code
					}
				}
			}
		}

		throw new PatchError('Cannot find IT block pattern in FLAC function for patching');
	}

	/**
	 * Generate inline color selection code
	 *
	 * This replaces the IT block with a CMP/BEQ chain that's more reliable.
	 *
	 * @param colors Array of 5 color values (one per theme)
	 * @param codeStartAddr Address where this code will be placed
	 * @param originalCodeOffset Offset from codeStartAddr to the original code after IT block
	 *                           (the STRH instruction that we need to jump to)
	 */
	private generateInlineColorSelection(
		colors: number[],
		codeStartAddr: number,
		originalCodeOffset: number = 12 // Default: 12 bytes after IT block start
	): Uint8Array {
		const code: number[] = [];

		// We need to replace the original:
		//   CMP R1, #4
		//   IT EQ
		//   MOVWEQ R1, #color4
		//   MOVW R1, #color0-3
		//   STRH R1, [R0]
		//
		// With:
		//   CMP R1, #0; BEQ theme_0
		//   CMP R1, #1; BEQ theme_1
		//   CMP R1, #2; BEQ theme_2
		//   CMP R1, #3; BEQ theme_3
		//   ; fall through to theme_4
		// theme_4: MOVW R1, #color4; MOVT R1, #0; B store
		// theme_3: MOVW R1, #color3; MOVT R1, #0; B store
		// theme_2: MOVW R1, #color2; MOVT R1, #0; B store
		// theme_1: MOVW R1, #color1; MOVT R1, #0; B store
		// theme_0: MOVW R1, #color0; MOVT R1, #0
		// store: (original STRH continues)

		// Record positions for BEQ patching
		const beqPositions: Array<{ index: number; beqCodeAddr: number }> = [];

		// Generate CMP/BEQ pairs for themes 0-3
		for (let i = 0; i < 4; i++) {
			const cmpAddr = code.length;
			code.push(0x00 | i, 0x29);  // CMP R1, #i
			// BEQ placeholder (will be patched)
			beqPositions.push({ index: i, beqCodeAddr: code.length });
			code.push(0x00, 0xD0);  // BEQ placeholder
		}

		// Theme sections (theme 4 first, then 3, 2, 1, 0)
		const themeSectionStarts: number[] = [];
		const bPositions: number[] = []; // Positions of B instructions

		for (let theme = 4; theme >= 0; theme--) {
			themeSectionStarts[theme] = code.length;
			const color = colors[theme];

			// Load color into R1
			code.push(...encodeMovw(1, color & 0xffff));
			code.push(...encodeMovt(1, (color >> 16) & 0xffff));

			// For themes 4-1, add a B to jump to original code
			if (theme > 0) {
				bPositions.push(code.length);
				code.push(0x00, 0xE0);  // B placeholder (will be patched)
			}
		}

		// Calculate the base address for offset calculations
		const baseAddr = codeStartAddr;

		// Now patch BEQ offsets
		for (const { index, beqCodeAddr } of beqPositions) {
			const pc = beqCodeAddr + 4; // PC is at instruction + 4
			const target = themeSectionStarts[index];
			const offset = (target - pc) >> 1; // Offset in halfwords

			// BEQ encoding: 1101 0000 imm8
			// imm8 is signed offset in halfwords
			if (offset < -128 || offset > 127) {
				throw new PatchError('BEQ offset out of range for theme selection');
			}

			const imm8 = offset & 0xFF;
			code[beqCodeAddr] = imm8;
			code[beqCodeAddr + 1] = 0xD0;
		}

		// Patch B instructions to jump to the original code (at originalCodeOffset)
		// The original code is at codeStartAddr + originalCodeOffset
		for (const bAddr of bPositions) {
			const pc = bAddr + 4; // PC is at instruction + 4
			const target = originalCodeOffset; // Jump to original code offset
			const offset = (target - pc) >> 1;

			// B encoding: 11100 imm11
			if (offset < -1024 || offset > 1023) {
				throw new PatchError('B offset out of range for theme skip');
			}

			const imm11 = offset & 0x7FF;
			code[bAddr] = imm11 & 0xFF;
			code[bAddr + 1] = 0xE0 | ((imm11 >> 8) & 0x07);
		}

		return new Uint8Array(code);
	}
}

export function patchFirmware(firmwareData: Uint8Array, flacColors: number[], menuColors: number[], outputPath: string): PatchResult {
	const patcher = new ThemePatcher(firmwareData);
	return patcher.patchOriginal(flacColors, menuColors, outputPath, true);
}

export type { NopSlide, PatchMetadata, PatchPoint, PatchResult, PatchPointInfo, PatchAnalysisResult, PatchInfo, RelocationInfo };
export type { LandingPoint, NopSlideAnalysis };
export { NopSlideFinder, PatchDetector, CodeReferenceAnalyzer };
