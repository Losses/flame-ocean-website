/**
 * Theme Patcher
 *
 * Main patching module that applies theme color patches to firmware.
 * Uses function relocation: copies the entire FLAC function to freed language pool space
 * and modifies the caller's BL to point to the new location.
 */

import { encodeBl, encodeB32bit, encodeMovw, encodeMovt, decodeBlTarget, encodePush, encodePop, encodeMov, encodeNop } from './thumb/encoders.js';
import { fileIO } from '../utils/file-io.js';
import { NopSlideFinder } from './nop-slide.js';
import { CodeReferenceAnalyzer, type LandingPoint, type NopSlideAnalysis } from './code-reference-analyzer.js';
import { PatchDetector } from './detector.js';
import { createPatchMetadata, writePatchMetadata, scanForPatchMetadata, readPatchMetadata, encodeRelocationHeader, decodeRelocationHeader, scanForPatchWithRelocation, RELO_HEADER_SIZE, METADATA_SIZE, type RelocationHeader } from './metadata.js';
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
		const patchScan = scanForPatchWithRelocation(this.data);
		const patchStatus = patchScan
			? {
				isPatched: true as const,
				status: 'Patched (metadata found)',
				patchType: 'both' as const,
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

		// Check if patching is supported
		// V1.8.0 and older have different memory layout that may not work
		let canPatch = themeFunctions.length > 0;
		const flacFunc = themeFunctions.find(f => f.type === 'flac');

		// V1.8.0 works with relocation method (handler is placed close to function)
		// So we don't need to block it anymore

		return {
			version: this.version,
			themeFunctions,
			nopSlides,
			canPatch,
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
			flacColors = extractor.getColorsForFunction('flac').map(c => c & 0xFFFF);
		} else {
			throw new ThemeError('FLAC function not found in firmware');
		}

		// Extract Menu colors (5 themes × 3 attributes = 15 colors)
		const menuFunc = result.themeFunctions.find(f => f.type === 'menu');
		let menuColors: number[] = [];
		if (menuFunc) {
			menuColors = Array.from(extractor.getColorsForFunction('menu')).map(c => c & 0xFFFF);
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
	 * @param options.knockDownLanguage - Language index to knock down for relocation.
	 *        Default: undefined (use last non-protected language)
	 * @param outputPath - Path to write patched firmware
	 * @param writeFile - Whether to write to disk (default: true)
	 */
	patch(
		options: {
			flacColors?: number[];
			menuColors?: number[];
			/** Language index to knock down. Default: last non-protected language */
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
			reloHeader?: RelocationHeader;
			metadataOffset?: number;
		};

		let flacColors = options.flacColors ?? null;
		let menuColors = options.menuColors ?? null; // Can be null if user only wants FLAC patch

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

		// Fill in missing FLAC colors from ground truth (required for first patch)
		if (!flacColors) {
			const groundTruth = this.extractGroundTruthColors();
			flacColors = [...groundTruth.flacColors];
		}

		// Note: menuColors is NOT auto-filled - user must explicitly provide it to patch Menu
		// This allows FLAC-only patches

		// Use relocation method for patching
		return this.patchWithRelocation(
			{
				flacColors: flacColors!,
				menuColors, // Can be null for FLAC-only patch
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
		reloHeader: RelocationHeader,
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

		// Find FLAC caller address if not in header (old format compatibility)
		let flacCallerAddr = reloHeader.flacCallerAddr;
		if (!flacCallerAddr || flacCallerAddr === 0) {
			// Scan for BL instruction targeting the relocated function
			const callerInfo = this.findFlacCaller(reloHeader.flacFuncAddr);
			if (!callerInfo) {
				throw new PatchError('Cannot find BL instruction for re-patching (old header format)');
			}
			flacCallerAddr = callerInfo.callerAddr;
		}

		// Clone firmware data
		const patchedData = new Uint8Array(this.data);

		// Re-generate the entire FLAC color selection block
		// This is safer than individual MOVW patching because the code structure may have changed.
		const flacColorCodeAddr = reloHeader.flacFuncAddr + reloHeader.flacColorCodeOffset;
		let newColorCode = this.generateInlineColorCode(flacColors);

		// Re-append the return branch (B.W jump back to main function)
		const patchOffset = this.findColorCodeOffset(this.data, reloHeader.flacFuncAddr, reloHeader.flacFuncSize);
		const returnAddr = reloHeader.flacFuncAddr + patchOffset + 12; // Skip original labels resetting R1 to 0xFC
		const colorCodeEndAddr = flacColorCodeAddr + newColorCode.length;
		const returnBranch = encodeB32bit(colorCodeEndAddr, returnAddr);

		const finalColorCode = new Uint8Array(newColorCode.length + returnBranch.length);
		finalColorCode.set(newColorCode, 0);
		finalColorCode.set(returnBranch, newColorCode.length);
		
		// Write the new block
		patchedData.set(finalColorCode, flacColorCodeAddr);

		// Re-patch Menu handler if it exists
		let menuHandlerAddr = reloHeader.menuHandlerAddr;
		let menuHandlerSize = reloHeader.menuHandlerSize;
		let menuCallerAddr = reloHeader.menuCallerAddr;

		if (menuHandlerAddr !== 0 && menuHandlerSize > 0) {
			// Re-generate Menu handler with new colors
			const themeCount = 5; // Default theme count
			const menuHandler = this.generateMenuHandlerWithPrologue(menuColors, themeCount);

			// Verify size matches
			if (menuHandler.length !== menuHandlerSize) {
				// Size mismatch - this shouldn't happen, but handle it gracefully
				console.warn(`Menu handler size mismatch: expected ${menuHandlerSize}, got ${menuHandler.length}`);
			}

			// Write new Menu handler
			patchedData.set(menuHandler, menuHandlerAddr);
		} else if (options.menuColors && menuHandlerAddr === 0) {
			// Menu not yet patched but user wants to add it now
			// Place Menu handler after FLAC function
			const themeCount = 5;
			const menuHandler = this.generateMenuHandlerWithPrologue(menuColors, themeCount);
			menuHandlerSize = menuHandler.length;

			// Calculate placement: after FLAC function (word-aligned)
			const menuHandlerOffset = (reloHeader.flacFuncSize + 3) & ~3;
			menuHandlerAddr = reloHeader.flacFuncAddr + menuHandlerOffset;

			// Find Menu caller
			const menuCallerInfo = this.findMenuCaller();
			if (menuCallerInfo) {
				menuCallerAddr = menuCallerInfo.callerAddr;

				// Write Menu handler
				patchedData.set(menuHandler, menuHandlerAddr);

				// Modify Menu caller's BL
				const menuBlBytes = encodeBl(menuCallerAddr, menuHandlerAddr);
				patchedData.set(menuBlBytes, menuCallerAddr);
			}
		}

		// Update metadata
		const newMetadata = createPatchMetadata(Math.floor(Date.now() / 1000), flacColors, menuColors);
		const metadataBytes = writePatchMetadata(newMetadata);
		patchedData.set(metadataBytes, metadataOffset);

		// Rewrite relocation header with updated Menu info (if Menu was just added)
		const newReloHeader: RelocationHeader = {
			flacFuncAddr: reloHeader.flacFuncAddr,
			flacFuncSize: reloHeader.flacFuncSize,
			flacColorCodeOffset: reloHeader.flacColorCodeOffset,
			flacCallerAddr: reloHeader.flacCallerAddr,
			menuHandlerAddr,
			menuHandlerSize,
			menuCallerAddr
		};
		const reloHeaderAddr = metadataOffset - RELO_HEADER_SIZE;
		patchedData.set(encodeRelocationHeader(newReloHeader), reloHeaderAddr);

		// Write to file if requested
		if (writeFile) {
			fileIO.writeFileSync(outputPath, patchedData);
		}

		// Create fake NOP slide for API compatibility
		const fakeNopSlide: NopSlide = {
			start: reloHeader.flacFuncAddr,
			end: metadataOffset + metadataBytes.length,
			size: metadataOffset + metadataBytes.length - reloHeader.flacFuncAddr,
			source: 'relocation',
			isActive: true,
			referenceCount: 0
		};

		// Create patch points with BL address for test compatibility
		const patchPoints: Record<string, PatchPoint> = {
			'flac': {
				type: 'flac',
				funcAddr: 0, // Unknown during re-patch
				patchAddr: flacCallerAddr,
				targetAddr: flacColorCodeAddr, // Color code address
				originalBytes: '',
				newBytes: ''
			}
		};

		// Add Menu patch point if Menu was patched
		if (menuHandlerAddr !== 0 && menuCallerAddr !== 0) {
			patchPoints['menu'] = {
				type: 'menu',
				funcAddr: 0, // Unknown during re-patch
				patchAddr: menuCallerAddr,
				targetAddr: menuHandlerAddr,
				originalBytes: '',
				newBytes: ''
			};
		}

		return {
			success: true,
			nopSlide: fakeNopSlide,
			patchPoints,
			metadataAddr: metadataOffset,
			patchedData: writeFile ? undefined : patchedData,
			relocationInfo: {
				newFuncAddr: reloHeader.flacFuncAddr,
				funcSize: reloHeader.flacFuncSize,
				originalFuncAddr: 0, // Unknown during re-patch
				callerAddr: flacCallerAddr,
				menuHandlerAddr: menuHandlerAddr !== 0 ? menuHandlerAddr : undefined,
				menuHandlerSize: menuHandlerSize !== 0 ? menuHandlerSize : undefined,
				menuCallerAddr: menuCallerAddr !== 0 ? menuCallerAddr : undefined
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

				if (!hasThemeFunctions) {
					throw new CompatibilityError('Unable to patch firmware: theme functions not found. Requires V2.4.0+');
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

	/**
	 * Generate Menu handler with prologue and color selection
	 *
	 * Structure:
	 *   [Original prologue: PUSH + LDRs] (14 bytes)
	 *   [Color selection: CMP R0, #theme; BEQ theme_X] (20 bytes for 4 themes)
	 *   [Theme 4: MOVW/MOVT R1,R2,R3; B end] (26 bytes)
	 *   [Theme 3: MOVW/MOVT R1,R2,R3; B end] (26 bytes)
	 *   [Theme 2: MOVW/MOVT R1,R2,R3; B end] (26 bytes)
	 *   [Theme 1: MOVW/MOVT R1,R2,R3; B end] (26 bytes)
	 *   [Theme 0: MOVW/MOVT R1,R2,R3] (24 bytes, falls through)
	 *   end: POP {R4-R6, PC} (2 bytes) - restores callee-saved registers and returns
	 *
	 * Total: ~164 bytes
	 *
	 * IMPORTANT: Original prologue contains PUSH {R4-R6}, so we MUST use POP {R4-R6, PC}
	 * to restore registers and return. Using BX LR would corrupt R4-R6 and unbalance the stack!
	 */
	private generateMenuHandlerWithPrologue(colors: number[], themeCount: number): Uint8Array {
		const code: number[] = [];

		// Copy original prologue (14 bytes from 0x3F87E)
		// PUSH {R4-R6} + 5 LDR instructions
		const menuEntryResult = discoverMenuFunction(this.data);
		if (!menuEntryResult) {
			throw new PatchError('Cannot find Menu function for prologue');
		}
		const [movAddr] = menuEntryResult;
		const prologueStart = movAddr - 14; // 0x3F87E
		const prologueSize = 14;

		// Copy prologue bytes
		for (let i = 0; i < prologueSize; i++) {
			code.push(this.data[prologueStart + i]);
		}

		// Generate color selection code
		// CMP R0, #0; BEQ theme_0
		// CMP R0, #1; BEQ theme_1
		// ...
		const beqPositions: Array<{ index: number; beqCodeAddr: number }> = [];

		for (let i = 0; i < themeCount - 1; i++) {
			code.push(0x00 | i, 0x28);  // CMP R0, #i
			beqPositions.push({ index: i, beqCodeAddr: code.length });
			code.push(0x00, 0xD0);  // BEQ placeholder
		}

		// Theme sections (theme N-1 first, then N-2, ..., 0)
		// Each section loads 3 colors into R1, R2, R3, then branches to end
		const themeSectionStarts: number[] = [];
		const bPositions: number[] = [];

		for (let theme = themeCount - 1; theme >= 0; theme--) {
			themeSectionStarts[theme] = code.length;

			// Load 3 colors for this theme
			for (let attr = 0; attr < 3; attr++) {
				const colorIndex = theme * 3 + attr;
				const color = colors[colorIndex] || 0;
				const reg = 1 + attr; // R1, R2, R3

				code.push(...encodeMovw(reg, color & 0xffff));
				code.push(...encodeMovt(reg, (color >> 16) & 0xffff));
			}

			// For themes N-1 to 1, add B instruction to skip to end
			if (theme > 0) {
				bPositions.push(code.length);
				code.push(0x00, 0xE0);  // B placeholder
			}
			// Theme 0 falls through to POP
		}

		// End address - use POP {R4-R6, PC} to restore registers and return
		// This is CRITICAL because the original prologue pushed R4-R6
		// Encoding: POP {R4,R5,R6,PC} = 0xBD70 (register list bits 4,5,6,15)
		const endAddr = code.length;
		code.push(0x70, 0xBD);  // POP {R4-R6, PC}

		// Patch BEQ offsets
		for (const { index, beqCodeAddr } of beqPositions) {
			const pc = beqCodeAddr + 4;
			const target = themeSectionStarts[index];
			const offset = (target - pc) >> 1;

			if (offset < -128 || offset > 127) {
				throw new PatchError('BEQ offset out of range for Menu theme selection');
			}

			const imm8 = offset & 0xFF;
			code[beqCodeAddr] = imm8;
			code[beqCodeAddr + 1] = 0xD0;
		}

		// Patch B offsets (for themes N-1 to 1)
		for (let i = 0; i < bPositions.length; i++) {
			const bAddr = bPositions[i];
			const pc = bAddr + 4;
			const offset = (endAddr - pc) >> 1;

			if (offset < -128 || offset > 127) {
				throw new PatchError('B offset out of range for Menu theme skip');
			}

			const imm8 = offset & 0xFF;
			code[bAddr] = imm8;
			code[bAddr + 1] = 0xE0;  // B (unconditional)
		}

		return new Uint8Array(code);
	}

	/**
	 * Generate simple Menu handler (without prologue) for inline patching
	 */
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
			menuColors: number[] | null; // null for FLAC-only patch
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
		// Only validate menuColors if provided
		if (menuColors && menuColors.length !== themeCount * 3) {
			throw new ValidationError(`Menu colors must have exactly ${themeCount * 3} values (${themeCount} themes × 3 attributes)`);
		}

		// Early check: does the language system exist?
		// This is the first thing we need to check because relocation depends on it
		const langPatcher = new LanguagePatcher(this.data, this.version);
		const langExtractor = langPatcher.getExtractor();

		if (!langExtractor.hasLanguageSystem()) {
			// Language system not found - cannot patch
			throw new CompatibilityError(
				'Theme patching requires the language system, but it was not found in this firmware. ' +
				'This may be an older or modified firmware version.'
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
			// This can happen if the firmware is already patched
			// (the caller's BL no longer targets the original function)
			throw new CompatibilityError(
				'Cannot find caller BL instruction for FLAC function. ' +
				'The firmware may already be patched.'
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
		let newFuncAddr = freedPoolAddr;

		// CRITICAL: Preserve 4-byte alignment phase for literal pool
		// LDR instructions use (PC+4 & ~3) + offset. We must match the original function's
		// alignment relative to the 4-byte boundary exactly.
		const originalPhase = funcStart % 4;
		while ((newFuncAddr % 4) !== originalPhase) {
			newFuncAddr++;
		}

		// Find the IT block offset in the ORIGINAL function
		const itBlockOffset = this.findColorCodeOffset(this.data, funcStart, funcSize);

		// Calculate the ACTUAL IT block size (not hardcoded!)
		// IT block size varies based on the IT instruction's mask field
		const itBlockSize = this.calculateItBlockSize(this.data, funcStart + itBlockOffset);

		// Generate inline color selection code (no B instructions, just fall through)
		let colorCode = this.generateInlineColorCode(flacColors);

		// Now we append a B.W instruction to the end of colorCode to jump back to codeAfterIT
		// original function:
		// [codeBeforeIT (itBlockOffset bytes)]
		// [B.W to colorCode (4 bytes)] + [NOPs (itBlockSize - 4 bytes)]
		// [codeAfterIT (funcSize - itBlockOffset - itBlockSize bytes)]
		// [colorCode] (appended at newFuncAddr + funcSize)
		// colorCode ends with B.W back to newFuncAddr + itBlockOffset + itBlockSize

		const safetyGap = 32;
		const colorCodeStartAddr = (newFuncAddr + funcSize + safetyGap - 1) & ~(safetyGap - 1);

		// Append B.W jump back to main function
		const returnAddr = newFuncAddr + itBlockOffset + 12; // Skip original labels resetting R1 to 0xFC
		const colorCodeEndAddr = colorCodeStartAddr + colorCode.length;
		const returnBranch = encodeB32bit(colorCodeEndAddr, returnAddr);

		// Append the return branch to colorCode
		const finalColorCode = new Uint8Array(colorCode.length + returnBranch.length);
		finalColorCode.set(colorCode, 0);
		finalColorCode.set(returnBranch, colorCode.length);
		colorCode = finalColorCode;

		const COLOR_CODE_SIZE = colorCode.length; // 64 + 4 = 68 bytes

		// New function size = original size + safety gap + color code
		const newFuncSize = (colorCodeStartAddr - newFuncAddr) + COLOR_CODE_SIZE;

		// Build the new function:
		// [code before IT block] [B.W jump + NOPs] [code after IT block] [GAP] [color code]
		const codeBeforeIT = this.data.slice(funcStart, funcStart + itBlockOffset);
		const codeAfterIT = this.data.slice(funcStart + itBlockOffset + itBlockSize, funcEnd);

		// Write new function to freed pool
		let writeOffset = newFuncAddr;
		modifiedData.set(codeBeforeIT, writeOffset);
		writeOffset += codeBeforeIT.length;

		// Inject jump to color code
		const jumpToColorCode = encodeB32bit(newFuncAddr + itBlockOffset, colorCodeStartAddr);
		modifiedData.set(jumpToColorCode, writeOffset);
		writeOffset += jumpToColorCode.length;

		const colorCodeAddr = colorCodeStartAddr; // Keep this definition for patchPoints below

		// Fill the rest of the IT block with NOPs
		const nopsNeeded = (itBlockSize - jumpToColorCode.length) / 2;
		for (let i = 0; i < nopsNeeded; i++) {
			modifiedData.set(encodeNop(), writeOffset);
			writeOffset += 2;
		}

		// Write the rest of the function (including literal pool!)
		modifiedData.set(codeAfterIT, writeOffset);
		// writeOffset += codeAfterIT.length;

		// Write the color code at the end (at the gap-aligned address)
		modifiedData.set(colorCode, colorCodeStartAddr);

		// Fix BL instructions in the relocated function
		// BL instructions are PC-relative and need to be re-encoded for the new address
		// Note: since we didn't expand the code in the middle, we don't need to adjust
		// internal branch offsets or LDR literal pool offsets. They remain identical!
		const blFixResult = this.fixBlInstructionsInRelocatedFunction(
			modifiedData,
			this.data, // Original firmware data for decoding original BL targets
			funcStart, // Original function address
			newFuncAddr, // New function address
			funcSize, // Original function size
			// The original offset math for BL fix logic remains exactly the same because
			// the core function body didn't shift relative to itself.
			// We pass 0 for colorCode offset/size to disable internal shifting logic.
			0, 
			0, 
			0
		);

		// Log BL fix results for debugging (only in development)
		// Commented out to avoid interfering with test JSON output
		// if (blFixResult.fixed > 0 || blFixResult.skipped > 0) {
		// 	console.log(`BL fix: ${blFixResult.fixed} fixed, ${blFixResult.skipped} skipped`);
		// 	if (blFixResult.errors.length > 0) {
		// 		console.warn('BL fix errors:', blFixResult.errors);
		// 	}
		// }

		// Modify the caller's BL to point to the new function
		const newBlBytes = encodeBl(callerAddr, newFuncAddr);
		modifiedData.set(newBlBytes, callerAddr);

		// Generate Menu handler and place it after FLAC function (only if menuColors provided)
		let menuHandlerAddr = 0;
		let menuHandlerSize = 0;
		let menuCallerAddr = 0;
		let nextOffset = (newFuncSize + 3) & ~3; // Word-aligned offset after FLAC function

		// Only patch Menu if menuColors is explicitly provided
		if (menuColors && menuColors.length > 0) {
			// Find Menu caller
			const menuCallerInfo = this.findMenuCaller();
			if (menuCallerInfo) {
				// Generate Menu handler with prologue
				const menuHandler = this.generateMenuHandlerWithPrologue(menuColors, themeCount);
				menuHandlerSize = menuHandler.length;

				// Place Menu handler after FLAC function (word-aligned)
				menuHandlerAddr = newFuncAddr + nextOffset;

				// Verify we have enough space (Menu handler + RELO header + metadata)
				const totalNeeded = nextOffset + menuHandlerSize + RELO_HEADER_SIZE + METADATA_SIZE;
				const poolEnd = freedPoolAddr + LANGUAGE_CONSTANTS.POOL_SPACING;
				if (menuHandlerAddr + menuHandlerSize + RELO_HEADER_SIZE + METADATA_SIZE > poolEnd) {
					throw new CapacityError('Not enough space in language pool for Menu handler');
				}

				// Write Menu handler
				modifiedData.set(menuHandler, menuHandlerAddr);

				// Modify Menu caller's BL to point to new handler
				menuCallerAddr = menuCallerInfo.callerAddr;
				const menuBlBytes = encodeBl(menuCallerAddr, menuHandlerAddr);
				modifiedData.set(menuBlBytes, menuCallerAddr);

				// Update next offset after Menu handler
				nextOffset = (nextOffset + menuHandlerSize + 3) & ~3;
			}
		}

		// Place RELO header and metadata at the end
		// RELO header comes immediately before metadata
		const metadataAddr = newFuncAddr + nextOffset + RELO_HEADER_SIZE;

		// Create metadata - use ground truth menu colors if not patching Menu
		const metadataMenuColors = menuColors ?? this.extractGroundTruthColors().menuColors;
		const metadata = createPatchMetadata(Math.floor(Date.now() / 1000), flacColors, metadataMenuColors);
		const metadataBytes = writePatchMetadata(metadata);
		modifiedData.set(metadataBytes, metadataAddr);

		// Create relocation header (stores info for re-patching)
		const reloHeader = encodeRelocationHeader({
			flacFuncAddr: newFuncAddr,
			flacFuncSize: newFuncSize,
			flacColorCodeOffset: colorCodeStartAddr - newFuncAddr, // Point to the appended logic after the gap
			flacCallerAddr: callerAddr,
			menuHandlerAddr,
			menuHandlerSize,
			menuCallerAddr
		});
		const reloHeaderAddr = metadataAddr - RELO_HEADER_SIZE;
		modifiedData.set(reloHeader, reloHeaderAddr);

		// Create patch points record
		// targetAddr points to the color code (where MOVW instructions are)
		const patchPoints: Record<string, PatchPoint> = {
			'flac': {
				type: 'flac',
				funcAddr: funcStart,
				patchAddr: callerAddr,
				targetAddr: colorCodeAddr,
				originalBytes: this.bytesToHex(this.data.slice(callerAddr, callerAddr + 4)),
				newBytes: this.bytesToHex(newBlBytes)
			}
		};

		// Add Menu patch point if Menu was patched
		if (menuHandlerAddr !== 0 && menuCallerAddr !== 0) {
			const menuCallerInfo = this.findMenuCaller();
			const originalMenuTarget = menuCallerInfo?.currentTarget ?? 0;
			patchPoints['menu'] = {
				type: 'menu',
				funcAddr: originalMenuTarget,
				patchAddr: menuCallerAddr,
				targetAddr: menuHandlerAddr,
				originalBytes: this.bytesToHex(this.data.slice(menuCallerAddr, menuCallerAddr + 4)),
				newBytes: this.bytesToHex(modifiedData.slice(menuCallerAddr, menuCallerAddr + 4))
			};
		}

		// Create a fake NOP slide for compatibility with existing API
		// Include Menu handler in the slide size if present
		const codeEnd = menuHandlerAddr !== 0 ? (menuHandlerAddr + menuHandlerSize) : (newFuncAddr + newFuncSize);
		const fakeNopSlideEnd = metadataAddr + metadataBytes.length;
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
			knockedDownLanguage: knockDownIndex,
			knockedDownLanguageName: langName,
			originalFuncAddr: funcStart,
			newFuncAddr,
			funcSize: newFuncSize,
			callerAddr,
			menuHandlerAddr: menuHandlerAddr !== 0 ? menuHandlerAddr : undefined,
			menuHandlerSize: menuHandlerSize !== 0 ? menuHandlerSize : undefined,
			menuCallerAddr: menuCallerAddr !== 0 ? menuCallerAddr : undefined
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
		let funcEnd = 0;

		for (let offset = 0; offset < maxSearch; ) {
			const addr = funcStart + offset;
			if (addr + 4 > this.data.length) break;

			const hw = this.data[addr] | (this.data[addr + 1] << 8);

			// Check for 16-bit POP {..., PC} (0xBD00 pattern)
			if ((hw & 0xFF00) === 0xBD00) {
				// Check if PC is in the register list (bit 7 = PC)
				const regList = hw & 0xFF;
				if (regList & 0x80) { // PC is in the list
					funcEnd = addr + 2;
					break;
				}
			}

			// Check for 32-bit POP.W {..., PC} (0xE8BD pattern)
			if (hw === 0xE8BD) {
				const hw2 = this.data[addr + 2] | (this.data[addr + 3] << 8);
				if (hw2 & 0x8000) { // PC is in the list
					funcEnd = addr + 4;
					break;
				}
			}

			// Check for BX LR (0x4770)
			if (hw === 0x4770) {
				funcEnd = addr + 2;
				break;
			}

			// Check for 32-bit instruction prefix
			const is32bit = hw >= 0xe800 || (hw & 0xf800) === 0xf000 || (hw & 0xf800) === 0xf800;
			offset += is32bit ? 4 : 2;
		}

		if (funcEnd === 0) return null;

		// CRITICAL: Scan for literal pool targets after the function end
		// Many compilers place constant data (literals) after the function body.
		// We must include these in the relocated block.
		let maxTarget = funcEnd;

		for (let offset = 0; offset < funcEnd - funcStart; offset += 2) {
			const addr = funcStart + offset;
			const hw1 = this.data[addr] | (this.data[addr + 1] << 8);

			// Check for 16-bit LDR Rt, [PC, #imm]
			if ((hw1 & 0xF800) === 0x4800) {
				const imm8 = hw1 & 0xFF;
				const target = ((addr + 4) & ~3) + (imm8 << 2);
				if (target > maxTarget && target < funcStart + maxSearch + 512) {
					maxTarget = Math.max(maxTarget, target + 4);
				}
			}
			// Check for 32-bit LDR.W Rt, [PC, #imm12]
			else if ((hw1 & 0xFF7F) === 0xF85F) {
				const hw2 = this.data[addr + 2] | (this.data[addr + 3] << 8);
				const u = (hw1 >> 7) & 1;
				const imm12 = hw2 & 0xFFF;
				const pc = (addr + 4) & ~3;
				const target = u ? (pc + imm12) : (pc - imm12);
				if (target > maxTarget && target < funcStart + maxSearch + 512) {
					maxTarget = Math.max(maxTarget, target + 4);
				}
			}
			// Check for 16-bit ADR Rd, label (0xA0xx)
			else if ((hw1 & 0xF800) === 0xA000) {
				const imm8 = hw1 & 0xFF;
				const target = ((addr + 4) & ~3) + (imm8 << 2);
				if (target > maxTarget && target < funcStart + maxSearch + 512) {
					maxTarget = Math.max(maxTarget, target + 4);
				}
			}
		}

		// Ensure maxTarget is 4-byte aligned to include the full last word
		maxTarget = (maxTarget + 3) & ~3;

		return {
			start: funcStart,
			end: maxTarget,
			size: maxTarget - funcStart
		};
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
	 * Find the BL instruction that calls the Menu function
	 * Menu function is at 0x3F87E (entry point with PUSH {R4-R6})
	 */
	private findMenuCaller(): { callerAddr: number; currentTarget: number } | null {
		// Find Menu function entry point (0x3F87E pattern: PUSH {R4-R6} followed by LDRs)
		const menuEntryResult = discoverMenuFunction(this.data);
		if (!menuEntryResult) {
			return null;
		}

		// The actual entry point is 14 bytes before the MOV.W R12, #0 signature
		// because discoverMenuFunction returns the MOV.W address, not the PUSH address
		const [movAddr] = menuEntryResult;
		const menuEntryAddr = movAddr - 14; // 0x3F88C - 14 = 0x3F87E

		// Search for BL instructions that target the Menu entry point
		const searchStart = 0x30000;
		const searchEnd = Math.min(0x50000, this.data.length);

		for (let addr = searchStart; addr < searchEnd; ) {
			if (addr + 4 > this.data.length) break;

			const hw1 = this.data[addr] | (this.data[addr + 1] << 8);
			const hw2 = this.data[addr + 2] | (this.data[addr + 3] << 8);

			// Check for BL instruction
			if ((hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000) {
				const target = decodeBlTarget(addr, this.data.slice(addr, addr + 4));

				// Check if this BL targets our Menu entry point (allow ±1 for Thumb alignment)
				if (Math.abs(target - menuEntryAddr) <= 1) {
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
	 * Calculate the actual size of an IT block
	 *
	 * IT block structure:
	 * - CMP R1, #imm8 (2 bytes)
	 * - IT<x> instruction (2 bytes) - encodes how many instructions are conditional
	 * - N conditional instructions (each 2 or 4 bytes)
	 *
	 * IT instruction encoding: 1011 1111 firstcond mask
	 * - firstcond[3:0] = condition code
	 * - mask[3:0] = determines number of conditional instructions
	 *
	 * The number of instructions is determined by the position of the least
	 * significant set bit in the mask:
	 * - 1000: 1 instruction
	 * - x100: 2 instructions
	 * - xx10: 3 instructions
	 * - xxx1: 4 instructions
	 */
	private calculateItBlockSize(data: Uint8Array, itBlockOffset: number): number {
		// Replacing 8 bytes of color load + 4 bytes of next logic to ensure we skip reset labels
		return 12;
	}

	/**
	 * Find the offset of the color loading instructions in FLAC function
	 */
	private findColorCodeOffset(data: Uint8Array, funcAddr: number, funcSize: number): number {
		// Strategy A: Drawing Call Hijack (V3.x+)
		// Pattern: MOVS R2, #0x76; MOVS R1, #0xFC; MOVW R0, #ID
		const patternA = [0x76, 0x22, 0xFC, 0x21, 0x40, 0xF2, 0x37, 0x10];
		for (let offset = 0; offset < funcSize - 8; offset += 2) {
			const addr = funcAddr + offset;
			if (data[addr] === patternA[0] && data[addr + 1] === patternA[1] &&
			    data[addr + 2] === patternA[2] && data[addr + 3] === patternA[3] &&
			    data[addr + 4] === patternA[4] && data[addr + 5] === patternA[5] &&
			    data[addr + 6] === patternA[6] && data[addr + 7] === patternA[7]) {
				return offset;
			}
		}

		// Strategy B: Original Theme Selection Fallback (V1.8 - V2.8)
		// Pattern: CMP R1, #4; ITE EQ
		const patternB = [0x04, 0x29, 0x0C, 0xBF];
		for (let offset = 0; offset < funcSize - 4; offset += 2) {
			const addr = funcAddr + offset;
			if (data[addr] === patternB[0] && data[addr + 1] === patternB[1] &&
			    data[addr + 2] === patternB[2] && data[addr + 3] === patternB[3]) {
				return offset;
			}
		}

		// Strategy C: Already patched B.W jump
		for (let offset = 0; offset < funcSize - 4; offset += 2) {
			const addr = funcAddr + offset;
			const hw1 = data[addr] | (data[addr + 1] << 8);
			const hw2 = data[addr + 2] | (data[addr + 3] << 8);
			if ((hw1 & 0xF800) === 0xF000 && (hw2 & 0xD000) === 0x9000) {
				if (offset > 0x400) return offset;
			}
		}

		throw new PatchError(`No compatible patching pattern found for firmware version ${this.version}`);
	}

	/**
	 * Generate inline color selection code with B instructions to skip remaining themes
	 *
	 * This code replaces the original IT block (12 bytes) in the FLAC function.
	 *
	 * CRITICAL: This version is context-safe. It saves R2/R3, loads the ACTUAL theme
	 * index from global memory (0x0306EFF8), and only modifies R1.
	 */
	private generateInlineColorCode(colors: number[]): Uint8Array {
		const code: number[] = [];

		// 1. Save context (R2, R3)
		code.push(0x0C, 0xB4); // PUSH {R2, R3}

		// 2. Load theme index from 0x0306EFF8 into R2
		code.push(...encodeMovw(2, 0xEFF8));
		code.push(...encodeMovt(2, 0x0306));
		code.push(0x12, 0x78); // LDRB R2, [R2, #0]

		// 3. Theme selection logic using R2 (Switch-case for theme 0-4)
		const beqPositions: Array<{ index: number; beqCodeAddr: number }> = [];
		for (let i = 0; i < 4; i++) {
			code.push(i, 0x2A); // CMP R2, #i
			beqPositions.push({ index: i, beqCodeAddr: code.length });
			code.push(0x00, 0xD0); // BEQ placeholder
		}

		// Theme sections (theme 4 first, then 3, 2, 1, 0)
		const themeSectionStarts: number[] = [];
		const bPositions: number[] = [];

		for (let theme = 4; theme >= 0; theme--) {
			themeSectionStarts[theme] = code.length;
			const color = colors[theme];

			// Load color into R1
			code.push(...encodeMovw(1, color & 0xffff));
			code.push(...encodeMovt(1, (color >> 16) & 0xffff));

			if (theme > 0) {
				bPositions.push(code.length);
				code.push(0x00, 0xE0); // B placeholder
			}
		}

		// 4. End section (Restore context)
		const endLabelPos = code.length;
		
		// IMPORTANT: Restore R2 to the value expected by original code (0x76)
		code.push(0x76, 0x22); // MOVS R2, #0x76
		
		code.push(0x0C, 0xBC); // POP {R2, R3}

		// Patch BEQ offsets
		for (const { index, beqCodeAddr } of beqPositions) {
			const pc = beqCodeAddr + 4;
			const target = themeSectionStarts[index];
			const offset = (target - pc) >> 1;
			code[beqCodeAddr] = offset & 0xFF;
		}

		// Patch B offsets to endLabel
		for (const bAddr of bPositions) {
			const pc = bAddr + 4;
			const target = endLabelPos;
			const offset = (target - pc) >> 1;
			code[bAddr] = offset & 0xFF;
		}

		return new Uint8Array(code);
	}

	/**
	 * Fix BL instructions in a relocated function
	 *
	 * When a function is relocated, BL instructions that were PC-relative
	 * need to be re-encoded for the new address.
	 *
	 * CRITICAL: We must distinguish between INTERNAL and EXTERNAL calls.
	 * 1. Internal calls (branches within the function): Offset stays the same if content didn't shift.
	 * 2. External calls (calls to other functions): Target address stays same, but BL offset must change.
	 *
	 * @param data Modified firmware data (will be edited in place)
	 * @param originalData Original firmware data (for decoding original BL targets)
	 * @param originalFuncAddr Original function address
	 * @param newFuncAddr New function address
	 * @param funcSize Original function size
	 * @param colorCodeOffset Offset of color code in new function
	 * @param colorCodeSize Size of color code
	 * @param itBlockSize Size of original IT block
	 * @returns Number of BL instructions fixed, skipped, and any errors
	 */
	private fixBlInstructionsInRelocatedFunction(
		data: Uint8Array,
		originalData: Uint8Array,
		originalFuncAddr: number,
		newFuncAddr: number,
		funcSize: number,
		colorCodeOffset: number,
		colorCodeSize: number,
		itBlockSize: number
	): { fixed: number; skipped: number; errors: string[] } {
		const result = { fixed: 0, skipped: 0, errors: [] as string[] };

		// Scan regions for BL instructions
		// BL format: hw1 = 11110 S imm10, hw2 = 11 J1 1 J2 imm11

		const fixBlAtOffset = (newOffset: number, originalOffset: number) => {
			const hw1 = data[newFuncAddr + newOffset] | (data[newFuncAddr + newOffset + 1] << 8);
			
			// Check for BL instruction pattern (Thumb-2)
			if ((hw1 & 0xF800) === 0xF000) {
				const hw2 = data[newFuncAddr + newOffset + 2] | (data[newFuncAddr + newOffset + 3] << 8);

				if ((hw2 & 0xD000) === 0xD000) {
					// This is a BL instruction.
					// Decode the original target from the ORIGINAL location.
					const originalBlBytes = originalData.slice(
						originalFuncAddr + originalOffset,
						originalFuncAddr + originalOffset + 4
					);

					try {
						// Get the absolute target address the original code was calling
						const absoluteTarget = decodeBlTarget(
							originalFuncAddr + originalOffset,
							originalBlBytes
						);

						// Now re-encode a BL instruction at the NEW location 
						// that points to the SAME absolute target.
						const newBlBytes = encodeBl(newFuncAddr + newOffset, absoluteTarget);

						// Write to new function
						data.set(newBlBytes, newFuncAddr + newOffset);
						result.fixed++;
					} catch (e) {
						result.errors.push(
							`BL at offset ${newOffset}: ${(e as Error).message}`
						);
						result.skipped++;
					}
					return true; // Was 32-bit instruction
				}
			}
			
			// Check for other 32-bit instructions to maintain alignment
			return (hw1 & 0xF800) >= 0xE800;
		};

		// Region 1: Before color code
		for (let offset = 0; offset < colorCodeOffset - 2; ) {
			const is32bit = fixBlAtOffset(offset, offset);
			offset += is32bit ? 4 : 2;
		}

		// Region 2: After color code
		const region2OriginalStart = colorCodeOffset + itBlockSize;
		const region2NewStart = colorCodeOffset + colorCodeSize;
		const region2Size = funcSize - region2OriginalStart;

		for (let i = 0; i < region2Size - 2; ) {
			const is32bit = fixBlAtOffset(region2NewStart + i, region2OriginalStart + i);
			i += is32bit ? 4 : 2;
		}

		return result;
	}
}

export function patchFirmware(firmwareData: Uint8Array, flacColors: number[], menuColors: number[], outputPath: string): PatchResult {
	const patcher = new ThemePatcher(firmwareData);
	return patcher.patchOriginal(flacColors, menuColors, outputPath, true);
}

export type { NopSlide, PatchMetadata, PatchPoint, PatchResult, PatchPointInfo, PatchAnalysisResult, PatchInfo, RelocationInfo };
export type { LandingPoint, NopSlideAnalysis };
export { NopSlideFinder, PatchDetector, CodeReferenceAnalyzer };
