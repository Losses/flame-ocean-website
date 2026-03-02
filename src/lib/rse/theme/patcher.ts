/**
 * Theme Patcher
 *
 * Main patching module that applies theme color patches to firmware.
 * Uses detection, NOP slide finding, and instruction encoding to patch.
 */

import { encodeBl, encodeMovw, encodeMovt, decodeBlTarget, encodePush, encodePop, encodeMov } from './thumb/encoders.js';
import { fileIO } from '../utils/file-io.js';
import { NopSlideFinder } from './nop-slide.js';
import { CodeReferenceAnalyzer, type LandingPoint, type NopSlideAnalysis } from './code-reference-analyzer.js';
import { PatchDetector } from './detector.js';
import { createPatchMetadata, writePatchMetadata } from './metadata.js';
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
	type PatchInfo
} from './types.js';
import {
	ThemeError,
	PatchError,
	ValidationError,
	CapacityError,
	CompatibilityError,
	throwThemeError
} from './errors.js';

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
		this.finder = new NopSlideFinder(firmwareData);
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

		// Check if already patched
		const flacAddr = flacResult ? flacResult[1] : null;
		const menuAddr = menuResult ? menuResult[1] : null;
		const patchStatus = this.detector.detectPatchStatus(flacAddr, menuAddr);

		return {
			version: this.version,
			themeFunctions,
			nopSlides,
			canPatch: themeFunctions.length > 0 && nopSlides.length > 0,
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
		// The problem with the old logic:
		// - It searched backward and found the first non-zero byte before patch code
		// - But this could be original firmware data (like 0x1C64B8: 00 00 80 00)
		// - The real NOP slide start is further back where zeros CONTINUOUSLY begin
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
		// The original NOP slide should be 4-byte aligned
		start = zeroStart;

		// CRITICAL: Ensure NOP slide start is 4-byte aligned for BL instruction precision
		// BL instructions in Thumb mode can only target addresses that are 4-byte aligned
		// (the offset is encoded with bit 0 implied as 1, so odd addresses lose precision)
		//
		// IMPORTANT: Only align if we're NOT already on a patch code boundary
		// If the start is already at patch code (non-zero), we found the wrong boundary
		if (start % 4 !== 0) {
			// Check if aligning would put us in zero region
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
				// Safe to align
				start = alignedStart;
			} else {
				// Would move into non-zero region, keep current start
				// This shouldn't happen if the zero region detection is correct
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
	 * @param options - Patch options with optional flacColors and/or menuColors
	 * @param outputPath - Path to write patched firmware
	 * @param writeFile - Whether to write to disk (default: true)
	 */
	patch(
		options: {
			flacColors?: number[];
			menuColors?: number[];
		},
		outputPath: string,
		writeFile = true
	): PatchResult {
		// Validate that at least one color set is provided
		if (!options.flacColors && !options.menuColors) {
			throw new ValidationError('At least one of flacColors or menuColors must be provided');
		}

		// Check if firmware is already patched
		const analysis = this.analyze();
		const isPatched = analysis.patchStatus.isPatched;

		// Extract or validate colors
		let flacColors = options.flacColors ?? null;
		let menuColors = options.menuColors ?? null;

		// If only one color set is provided, extract the other
		if (flacColors && !menuColors) {
			// FLAC only: extract Menu colors
			if (isPatched) {
				// Try to extract Menu colors from existing patch code
				const existingNopSlide = this.findExistingNopSlide();
				if (existingNopSlide) {
					// Try metadata first (fast)
					const metadata = this.detector.findPatchMetadata([existingNopSlide]);
					if (metadata && metadata.menuColors && metadata.menuColors.length === 15) {
						menuColors = [...metadata.menuColors];
						console.error('[INFO] Patching FLAC only - keeping existing Menu colors from metadata');
					} else {
						// Metadata unavailable - extract from patch code directly
						console.error('[WARN] Could not read Menu metadata, extracting from patch code');
						const extractedColors = this.detector.extractPatchedColors(existingNopSlide.start, 'menu');
						if (extractedColors.size === 15) {
							menuColors = Array.from(extractedColors.values());
							console.error('[INFO] Patching FLAC only - using Menu colors from patch code:', menuColors.map(c => '0x' + c.toString(16)));
						} else {
							// Can't extract colors - fall back to ground truth
							console.error('[WARN] Could not extract Menu colors, using ground truth');
							const groundTruth = this.extractGroundTruthColors();
							menuColors = [...groundTruth.menuColors];
							console.error('[INFO] Patching FLAC only - using ground truth Menu colors');
						}
					}
				} else {
					// Could not find NOP slide - use ground truth
					console.error('[WARN] Could not locate existing NOP slide, using ground truth');
					const groundTruth = this.extractGroundTruthColors();
					menuColors = [...groundTruth.menuColors];
					console.error('[INFO] Patching FLAC only - using ground truth Menu colors');
				}
			} else {
				// Not patched: extract ground truth
				const groundTruth = this.extractGroundTruthColors();
				menuColors = [...groundTruth.menuColors];
				console.error('[INFO] Patching FLAC only - using ground truth Menu colors');
			}
		} else if (!flacColors && menuColors) {
			// Menu only: extract FLAC colors
			if (isPatched) {
				// Try to extract FLAC colors from existing patch code
				const existingNopSlide = this.findExistingNopSlide();
				if (existingNopSlide) {
					// Try metadata first (fast)
					const metadata = this.detector.findPatchMetadata([existingNopSlide]);
					if (metadata && metadata.flacColors && metadata.flacColors.length === 5) {
						flacColors = [...metadata.flacColors];
						console.error('[INFO] Patching Menu only - keeping existing FLAC colors from metadata');
					} else {
						// Metadata unavailable - extract from patch code directly
						console.error('[WARN] Could not read FLAC metadata, extracting from patch code');
						const extractedColors = this.detector.extractPatchedColors(existingNopSlide.start, 'flac');
						if (extractedColors.size === 5) {
							flacColors = Array.from(extractedColors.values());
							console.error('[INFO] Patching Menu only - using FLAC colors from patch code:', flacColors.map(c => '0x' + c.toString(16)));
						} else {
							// Can't extract colors - fall back to ground truth
							console.error('[WARN] Could not extract FLAC colors, using ground truth');
							const groundTruth = this.extractGroundTruthColors();
							flacColors = [...groundTruth.flacColors];
							console.error('[INFO] Patching Menu only - using ground truth FLAC colors');
						}
					}
				} else {
					// Could not find NOP slide - use ground truth
					console.error('[WARN] Could not locate existing NOP slide, using ground truth');
					const groundTruth = this.extractGroundTruthColors();
					flacColors = [...groundTruth.flacColors];
					console.error('[INFO] Patching Menu only - using ground truth FLAC colors');
				}
			} else {
				// Not patched: extract ground truth
				const groundTruth = this.extractGroundTruthColors();
				flacColors = [...groundTruth.flacColors];
				console.error('[INFO] Patching Menu only - using ground truth FLAC colors');
			}
		}

		// Now call the internal implementation with both color sets and intent flags
		return this.patchImpl(
			flacColors!,
			menuColors!,
			outputPath,
			writeFile,
			{ flacCustom: !!options.flacColors, menuCustom: !!options.menuColors }
		);
	}

	/**
	 * Patch firmware with custom colors (backward compatible API)
	 *
	 * Original API that requires both FLAC and Menu colors.
	 * This method is kept for backward compatibility.
	 *
	 * @deprecated Use patch({ flacColors, menuColors }, outputPath) instead
	 */
	patchOriginal(
		flacColors: number[],
		menuColors: number[],
		outputPath: string,
		writeFile = true
	): PatchResult {
		return this.patchImpl(flacColors, menuColors, outputPath, writeFile, { flacCustom: true, menuCustom: true });
	}

	/**
	 * Internal patch implementation
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
			// Analyze firmware first to get theme count
			const analysis = this.analyze();

			// Get theme count from ThemeColorExtractor (discovery module)
			// We need to use the discovery directly since PatchPointInfo doesn't have themeCount
			const extractor = new ThemeColorExtractor(this.data);
			const discoveryResult = extractor.extract();

			// Find theme functions and get their themeCount
			const flacThemeFunc = discoveryResult.themeFunctions.find(f => f.type === 'flac');
			const menuThemeFunc = discoveryResult.themeFunctions.find(f => f.type === 'menu');
			const themeCount = flacThemeFunc?.themeCount || menuThemeFunc?.themeCount || 5;

			// Validate color counts based on detected theme count
			if (flacColors.length !== themeCount) {
				throw new ValidationError(`FLAC colors must have exactly ${themeCount} values (one per theme)`);
			}
			if (menuColors.length !== themeCount * 3) {
				throw new ValidationError(`Menu colors must have exactly ${themeCount * 3} values (${themeCount} themes × 3 attributes)`);
			}

			if (!analysis.canPatch) {
				// Determine why patching failed
				const hasThemeFunctions = analysis.themeFunctions.length > 0;
				const hasNopSlides = analysis.nopSlides.length > 0;

				if (!hasThemeFunctions) {
					throw new CompatibilityError(
						'Unable to patch firmware: theme functions not found.\n\n' +
						'This may be an older firmware version that does not support theme customization.\n' +
						'Theme system support: V2.4.0 and later\n\n' +
						'If you believe this is an error, please report it with your firmware version.'
					);
				}

				if (!hasNopSlides) {
					throw new CapacityError(
						'Unable to patch firmware: no suitable space found for patch code.\n\n' +
						'This firmware may have a different structure than expected.\n' +
						'Please report this issue with your firmware version.'
					);
				}

				throw new PatchError('Firmware cannot be patched: unknown reason');
			}

			// Check if already patched - if so, find existing NOP slide for re-patching
			let nopSlide: NopSlide;
			let isRepatch = false;

			if (analysis.patchStatus.isPatched) {
				console.error('[INFO] Firmware is already patched - attempting re-patch');
				const existingNopSlide = this.findExistingNopSlide();
				if (!existingNopSlide) {
					throw new PatchError(
						'Cannot re-patch: unable to locate existing patch code.\n\n' +
						'This may indicate a corrupted or incompatible patch.\n' +
						'Please start with a clean original firmware file.'
					);
				}
				nopSlide = existingNopSlide;
				isRepatch = true;
				console.error(`[INFO] Re-using existing NOP slide: 0x${nopSlide.start.toString(16)} - 0x${nopSlide.end.toString(16)} (${nopSlide.size} bytes)`);
			} else {
				// Find best NOP slide
				// Calculate required size dynamically based on actual handler sizes
				// We'll generate handlers first to get their sizes
				const tempFlacHandler = this.generateFlacHandler(flacColors);
				const tempMenuHandler = this.generateMenuHandler(menuColors);
				const tempMetadata = createPatchMetadata(
					Math.floor(Date.now() / 1000),
					flacColors,
					menuColors
				);
				const tempMetadataBytes = writePatchMetadata(tempMetadata);

				// Calculate required size:
				// - Padding for FLAC handler alignment (up to 3 bytes)
				// - FLAC handler: tempFlacHandler.length
				// - Menu handler: tempMenuHandler.length (aligned after FLAC)
				// - Metadata: tempMetadataBytes.length
				const ALIGNMENT = 4;
				// Maximum padding needed to align FLAC handler (we don't know the start address yet)
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

				// DEBUG: Log selected NOP slide details
				console.error(`[DEBUG] Selected NOP slide: 0x${nopSlide.start.toString(16)} - 0x${nopSlide.end.toString(16)} (${nopSlide.size} bytes)`);
				console.error(`[DEBUG] Required size: ${requiredSize} bytes`);

				// CRITICAL: Verify NOP slide landing point safety
				const safetyCheck = this.verifyNopSlideLandingPointSafety(nopSlide, requiredSize);

				if (!safetyCheck.isSafe) {
					// Print landing points report for debugging
					this.printLandingPointsReport();

					// Build appropriate error message based on why the slide is unsafe
					let reason = '';
					if (safetyCheck.landingPoints.length > 0 && safetyCheck.requiresProtection) {
						reason = `This NOP slide has ${safetyCheck.landingPoints.length} functional landing points that would be disrupted by patching.\n` +
							`The slide requires protection code, but there's not enough safe zone space (${requiredSize} bytes required).`;
					} else {
						reason = `This NOP slide is too small (${nopSlide.size} bytes < 256 bytes minimum).\n` +
							`The patcher requires a minimum of 256 bytes for safety and alignment.`;
					}

					throw new PatchError(
						`Selected NOP slide is not safe for patching:\n` +
						`  Slide: 0x${nopSlide.start.toString(16)} - 0x${nopSlide.end.toString(16)} (${nopSlide.size} bytes)\n` +
						`  Landing Points: ${safetyCheck.landingPoints.length}\n` +
						`  Required Size: ${requiredSize} bytes\n` +
						`  Requires Protection: ${safetyCheck.requiresProtection}\n\n` +
						reason +
						`\n\nPlease report this issue with your firmware version.`
					);
				}

				if (safetyCheck.requiresProtection) {
					console.error(`[INFO] NOP slide has ${safetyCheck.landingPoints.length} landing points - using protection strategy`);
					if (safetyCheck.injectionStrategy) {
						console.error(`[INFO] Injection strategy: entry protection at 0x${safetyCheck.injectionStrategy.entryProtectionAddr.toString(16)}, ` +
							`code at 0x${safetyCheck.injectionStrategy.injectionAddr.toString(16)}, ` +
							`exit protection at 0x${safetyCheck.injectionStrategy.exitProtectionAddr.toString(16)}`);
					}
				}
			}

			console.error('[DEBUG] Step 1: NOP slide selection and safety check completed');

			// Create patch data (skip safety check for re-patch)
			const patchData = this.createPatchData(flacColors, menuColors, nopSlide, isRepatch, intent, analysis.patchStatus);
			console.error('[DEBUG] Step 2: createPatchData() completed');

			// Apply patches
			const patchedData = new Uint8Array(this.data);
			const patchPoints: Record<string, PatchPoint> = {};

			// Patch FLAC function only if flacCustom is true
			const flacFunc = analysis.themeFunctions.find(f => f.type === 'flac');
			if (flacFunc && intent.flacCustom && patchData.flacCodeAddr !== 0) {
				// Pattern is 12 bytes: CMP(2) + ITE(2) + MOVW(4) + MOVW(4)
				// We replace with 4-byte BL + 8 bytes NOP
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

			// Patch Menu function only if menuCustom is true
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
			console.error('[DEBUG] Step 3: BL instruction patches applied');

			// Write patch code to NOP slide
			this.writePatchCode(patchedData, nopSlide, patchData, isRepatch ? intent : undefined);
			console.error('[DEBUG] Step 4: Patch code written to NOP slide');

			// Write metadata (using dynamic address from createPatchData)
			const metadata = createPatchMetadata(
				Math.floor(Date.now() / 1000),
				flacColors,
				menuColors
			);
			const metadataBytes = writePatchMetadata(metadata);
			console.error(`[DEBUG] Step 5: Writing ${metadataBytes.length} bytes of metadata to 0x${patchData.metadataAddr.toString(16)}`);
			patchedData.set(metadataBytes, patchData.metadataAddr);
			console.error('[DEBUG] Step 5: Metadata written successfully');

			// Write to file if requested
			if (writeFile) {
				console.error(`[DEBUG] Step 6: Writing patched firmware to ${outputPath}`);
				fileIO.writeFileSync(outputPath, patchedData);
				console.error('[DEBUG] Step 6: File written successfully');
			}

			return {
				success: true,
				nopSlide,
				metadataAddr: patchData.metadataAddr,
				patchPoints,
				patchedData: writeFile ? undefined : patchedData
			};
		} catch (error) {
			// Log the actual error before wrapping it
			console.error('[ERROR] Patch failed with error:', error);
			if (error instanceof Error) {
				console.error('[ERROR] Error name:', error.name);
				console.error('[ERROR] Error message:', error.message);
				console.error('[ERROR] Error stack:', error.stack);
			}
			throwThemeError(error, PatchError, 'Failed to patch firmware');
		}
	}

	/**
	 * Create patch data structure
	 *
	 * Layout is dynamically calculated:
	 * - Start: Protection/reserved area (configurable, default 32 bytes for B instruction)
	 * - After protection: FLAC handler code (if flacCustom)
	 * - After FLAC (aligned): Menu handler code (if menuCustom)
	 * - End: Metadata
	 *
	 * @param isRepatchInput - Skip safety checks when re-patching existing firmware
	 * @param intent - Which functions are being intentionally patched
	 */
	private createPatchData(
		flacColors: number[],
		menuColors: number[],
		nopSlide: NopSlide,
		isRepatchInput = false,
		intent: { flacCustom: boolean; menuCustom: boolean } = { flacCustom: true, menuCustom: true },
		patchStatus?: { flacPatched: boolean; menuPatched: boolean }
	): { flacCodeAddr: number; menuCodeAddr: number; code: Uint8Array; metadataAddr: number } {
		// DEBUG: Log input NOP slide
		console.error(`[DEBUG] createPatchData: nopSlide.start = 0x${nopSlide.start.toString(16)}, size = ${nopSlide.size}`);
		console.error(`[DEBUG] createPatchData: flacCustom=${intent.flacCustom}, menuCustom=${intent.menuCustom}`);

		// Calculate metadata size from the actual metadata structure
		const metadata = createPatchMetadata(
			Math.floor(Date.now() / 1000),
			flacColors,
			menuColors
		);
		const metadataBytes = writePatchMetadata(metadata);
		const METADATA_SIZE = metadataBytes.length;

		// Alignment for handlers (4-byte alignment for ARM instructions)
		// FLAC handler MUST be 4-byte aligned because BL targets require 4-byte alignment
		const ALIGNMENT = 4;

		// Generate handlers first so we know their sizes
		const actualFlacHandler = this.generateFlacHandler(flacColors);
		const actualMenuHandler = this.generateMenuHandler(menuColors);

		// During re-patching, preserve existing handlers even if they are not being updated this time.
		// This ensures that BL instructions from previous patches still point to valid handler code.
		const useFlacHandler = intent.flacCustom || patchStatus?.flacPatched;
		const useMenuHandler = intent.menuCustom || patchStatus?.menuPatched;

		// Determine which handlers to include in code buffer
		const flacHandler = useFlacHandler ? actualFlacHandler : new Uint8Array(0);
		const menuHandler = useMenuHandler ? actualMenuHandler : new Uint8Array(0);

		// Calculate layout using actual handler sizes
		let flacCodeOffset = 0;
		let flacCodeEnd = 0;
		let menuCodeOffset = 0;
		let menuCodeEnd = 0;

		if (actualFlacHandler.length > 0 && useFlacHandler) {
			// Calculate padding to ensure FLAC handler is 4-byte aligned
			flacCodeOffset = (ALIGNMENT - (nopSlide.start % ALIGNMENT)) % ALIGNMENT;
			flacCodeEnd = flacCodeOffset + actualFlacHandler.length;

			if (actualMenuHandler.length > 0 && useMenuHandler) {
				// Align menu handler start
				menuCodeOffset = Math.ceil(flacCodeEnd / ALIGNMENT) * ALIGNMENT;
				menuCodeEnd = menuCodeOffset + actualMenuHandler.length;
			}
		} else if (actualMenuHandler.length > 0 && useMenuHandler) {
			// Only menu handler, still align it
			menuCodeOffset = (ALIGNMENT - (nopSlide.start % ALIGNMENT)) % ALIGNMENT;
			menuCodeEnd = menuCodeOffset + actualMenuHandler.length;
		}

		// Metadata goes at the end
		const metadataOffset = nopSlide.size - METADATA_SIZE;

		// Calculate absolute addresses (0 if handler not generated)
		const flacCodeAddr = actualFlacHandler.length > 0 ? (nopSlide.start + flacCodeOffset) : 0;
		const menuCodeAddr = actualMenuHandler.length > 0 ? (nopSlide.start + menuCodeOffset) : 0;
		const metadataAddr = nopSlide.start + metadataOffset;

		// Calculate actual end of code
		const codeEnd = actualMenuHandler.length > 0 ? menuCodeEnd : flacCodeEnd;

		// Verify everything fits
		if (codeEnd > metadataOffset) {
			throw new CapacityError(
				`Not enough space in NOP slide:\n` +
				`  Available: ${nopSlide.size} bytes\n` +
				(actualFlacHandler.length > 0 ? `  FLAC handler: ${actualFlacHandler.length} bytes (offset ${flacCodeOffset})\n` : '') +
				(actualMenuHandler.length > 0 ? `  Menu handler: ${actualMenuHandler.length} bytes (offset ${menuCodeOffset})\n` : '') +
				`  Metadata: ${METADATA_SIZE} bytes (offset ${metadataOffset})\n` +
				`  Required: ${codeEnd + METADATA_SIZE} bytes\n` +
				`  Short by: ${codeEnd - metadataOffset} bytes`
			);
		}

		// SAFETY CHECK: Verify all bytes to be overwritten are NOPs (0x00)
		// Skip safety check when re-patching since we're overwriting our own code
		if (!isRepatchInput) {
			const ranges: { start: number; end: number; name: string }[] = [];
			if (actualFlacHandler.length > 0) {
				ranges.push({ start: nopSlide.start + flacCodeOffset, end: nopSlide.start + flacCodeEnd, name: 'FLAC handler' });
			}
			if (actualMenuHandler.length > 0) {
				ranges.push({ start: nopSlide.start + menuCodeOffset, end: nopSlide.start + menuCodeEnd, name: 'Menu handler' });
			}
			ranges.push({ start: metadataAddr, end: nopSlide.end, name: 'metadata' });
			this.verifyNopSlideSafety(nopSlide, ranges);
		}

		// Build the complete code buffer
		const code = new Uint8Array(nopSlide.size);

		// Set handlers
		if (flacHandler.length > 0) {
			code.set(actualFlacHandler, flacCodeOffset);
		}
		if (menuHandler.length > 0) {
			code.set(actualMenuHandler, menuCodeOffset);
		}
		// Metadata will be written separately in patch() method

		return {
			flacCodeAddr,
			menuCodeAddr,
			code,
			metadataAddr
		};
	}

	/**
	 * Verify that all bytes to be written are NOPs (0x00)
	 *
	 * This ensures we don't overwrite non-NOP-slide code or data.
	 * Takes an array of ranges to check, making it flexible for different layouts.
	 */
	private verifyNopSlideSafety(
		nopSlide: NopSlide,
		ranges: { start: number; end: number; name: string }[]
	): void {
		const nonNopPositions: { offset: number; value: number; range: string }[] = [];

		for (const range of ranges) {
			// Clamp range to NOP slide boundaries
			const clampedStart = Math.max(range.start, nopSlide.start);
			const clampedEnd = Math.min(range.end, nopSlide.end);

			for (let offset = clampedStart; offset < clampedEnd; offset++) {
				if (this.data[offset] !== 0x00) {
					nonNopPositions.push({ offset, value: this.data[offset], range: range.name });
				}
			}
		}

		if (nonNopPositions.length > 0) {
			const message = `Safety check failed: NOP slide contains non-NOP bytes\n` +
				`NOP Slide: 0x${nopSlide.start.toString(16)} - 0x${nopSlide.end.toString(16)} (${nopSlide.size} bytes)\n` +
				`Found ${nonNopPositions.length} non-NOP bytes:\n` +
				nonNopPositions.slice(0, 10).map(p =>
					`  0x${p.offset.toString(16)}: 0x${p.value.toString(16).padStart(2, '0')} (${p.range})`
				).join('\n') +
				(nonNopPositions.length > 10 ? `\n  ... and ${nonNopPositions.length - 10} more` : '');
			throw new ThemeError(message);
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
	private generateFlacHandler(colors: number[]): Uint8Array {
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
			
			// Load color into R1 (since STRH R1, [R0] is what we're replacing)
			// We can use R4 as temp if needed, but MOVW/MOVT can target R1 directly
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
	 * Generate Menu handler code
	 */
	private generateMenuHandler(colors: number[]): Uint8Array {
		const code: number[] = [];

		// Load colors using MOVW+MOVT pairs
		// CRITICAL: We load Theme 0 colors into R1, R2, R3 as expected by the Menu functions.
		// Theme 0 colors are at indices 0, 1, 2 in the non-interleaved colors array.
		for (let i = 0; i < Math.min(colors.length, 3); i++) {
			const reg = 1 + i; // R1, R2, R3
			const color = colors[i];

			// MOVW R{reg}, #color_low
			code.push(...encodeMovw(reg, color & 0xffff));

			// MOVT R{reg}, #color_high
			code.push(...encodeMovt(reg, (color >> 16) & 0xffff));
		}

		// BX LR
		code.push(0x70, 0x47);

		return new Uint8Array(code);
	}

	/**
	 * Apply patch at address
	 */
	private applyPatch(data: Uint8Array, patchAddr: number, targetAddr: number, nopBytes = 0): void {
		console.error(`[DEBUG] applyPatch: patchAddr=0x${patchAddr.toString(16)}, targetAddr=0x${targetAddr.toString(16)}`);
		const blInstruction = encodeBl(patchAddr, targetAddr);
		console.error(`[DEBUG] BL bytes: ${Array.from(blInstruction).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ')}`);
		data.set(blInstruction, patchAddr);

		// Fill remaining space with NOPs (0xBF00)
		for (let i = 0; i < nopBytes; i += 2) {
			data[patchAddr + 4 + i] = 0x00;
			data[patchAddr + 4 + i + 1] = 0xbf;
		}
	}

	/**
	 * Write patch code to NOP slide
	 *
	 * During re-patching with intent, only updates the sections being modified.
	 * Preserves existing handlers for functions not being re-patched.
	 */
	private writePatchCode(
		data: Uint8Array,
		nopSlide: NopSlide,
		patchData: { flacCodeAddr: number; menuCodeAddr: number; code: Uint8Array; metadataAddr: number },
		intent?: { flacCustom: boolean; menuCustom: boolean }
	): void {
		const start = nopSlide.start;
		const code = patchData.code;

		if (intent) {
			// Re-patching: selectively update sections
			console.error(`[DEBUG] writePatchCode (re-patch): flacCustom=${intent.flacCustom}, menuCustom=${intent.menuCustom}`);

			// Write FLAC handler if updating FLAC
			if (intent.flacCustom && patchData.flacCodeAddr > 0) {
				const flacOffset = patchData.flacCodeAddr - start;
				// Calculate FLAC handler size by looking for alignment padding
				// Next handler (if any) or metadata starts after FLAC
				let flacSize = code.length;
				if (intent.menuCustom && patchData.menuCodeAddr > 0) {
					flacSize = patchData.menuCodeAddr - patchData.flacCodeAddr;
				} else {
					// Only FLAC, metadata is at the end
					flacSize = patchData.metadataAddr - patchData.flacCodeAddr;
				}
				data.set(code.subarray(flacOffset, flacOffset + flacSize), patchData.flacCodeAddr);
				console.error(`[DEBUG] writePatchCode: Updated FLAC handler (${flacSize} bytes at 0x${patchData.flacCodeAddr.toString(16)})`);
			}

			// Write Menu handler if updating Menu
			if (intent.menuCustom && patchData.menuCodeAddr > 0) {
				const menuOffset = patchData.menuCodeAddr - start;
				// Menu handler goes until metadata
				const menuSize = patchData.metadataAddr - patchData.menuCodeAddr;
				data.set(code.subarray(menuOffset, menuOffset + menuSize), patchData.menuCodeAddr);
				console.error(`[DEBUG] writePatchCode: Updated Menu handler (${menuSize} bytes at 0x${patchData.menuCodeAddr.toString(16)})`);
			}

			// Always write metadata
			const metadataSize = 51; // Metadata is always 51 bytes
			data.set(code.subarray(code.length - metadataSize), patchData.metadataAddr);
			console.error(`[DEBUG] writePatchCode: Updated metadata (${metadataSize} bytes at 0x${patchData.metadataAddr.toString(16)})`);
		} else {
			// Initial patch: write entire buffer
			console.error(`[DEBUG] writePatchCode: writing ${code.length} bytes to 0x${start.toString(16)}`);
			data.set(code, start);
			console.error(`[DEBUG] writePatchCode: done`);
		}
	}

	/**
	 * Convert bytes to hex string
	 */
	private bytesToHex(bytes: Uint8Array): string {
		return Array.from(bytes)
			.map(b => b.toString(16).padStart(2, '0').toUpperCase())
			.join(' ');
	}
}

/**
 * Convenience function to patch firmware
 */
export function patchFirmware(
	firmwareData: Uint8Array,
	flacColors: number[],
	menuColors: number[],
	outputPath: string
): PatchResult {
	const patcher = new ThemePatcher(firmwareData);
	return patcher.patchOriginal(flacColors, menuColors, outputPath, true);
}

// Re-export types and functions for convenience
export type { NopSlide, PatchMetadata, PatchPoint, PatchResult, PatchPointInfo, PatchAnalysisResult, PatchInfo };
export type { LandingPoint, NopSlideAnalysis };
export { NopSlideFinder, PatchDetector, CodeReferenceAnalyzer };
