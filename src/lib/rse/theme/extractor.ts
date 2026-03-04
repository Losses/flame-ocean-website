/**
 * Theme Color Extractor
 *
 * Main extraction module that analyzes firmware to discover theme colors.
 * Uses function discovery and control flow simulation to extract color values.
 */

import { ThumbDecoder } from './thumb/index.js';
import { ThemeDiscovery, discoverMenuFunction } from './discovery.js';
import { ControlFlowSimulator } from './simulator.js';
import { BehaviorAnalyzer } from './behavior.js';
import { createColorMap, type ThemeFunction, type AnalysisResult, type FlacBehavior, type ColorWrite } from './types.js';
import {
	NotFoundError,
	AnalysisError,
	throwThemeError
} from './errors.js';
import { PatchDetector } from './detector.js';
import { scanForPatchMetadata } from './metadata.js';

/**
 * Check if there's actually a BL instruction at the given address
 * This is needed because discoverMenuFunction returns non-null even for unpatched firmware
 */
function hasBlInstructionAt(data: Uint8Array, addr: number): boolean {
	if (addr + 4 > data.length) return false;
	const hw1 = data[addr] | (data[addr + 1] << 8);
	const hw2 = data[addr + 2] | (data[addr + 3] << 8);
	return (hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000;
}

/**
 * Theme Color Extractor Class
 *
 * Analyzes firmware to discover and extract theme color values.
 */
export class ThemeColorExtractor {
	private readonly decoder: ThumbDecoder;
	private readonly discovery: ThemeDiscovery;
	private readonly behaviorAnalyzer: BehaviorAnalyzer;
	private readonly data: Uint8Array;

	/**
	 * Create a new ThemeColorExtractor
	 */
	constructor(firmwareData: Uint8Array) {
		this.data = firmwareData;
		this.decoder = new ThumbDecoder(firmwareData);
		this.discovery = new ThemeDiscovery(this.decoder);
		this.behaviorAnalyzer = new BehaviorAnalyzer(this.decoder);
	}

	/**
	 * Extract theme colors from firmware
	 */
	extract(): AnalysisResult {
		try {
			// Discover theme functions
			const functions = this.discovery.scanFirmware();

			if (functions.length === 0) {
				return {
					version: 'Unknown',
					themeFunctions: [],
					colors: createColorMap(),
					flacBehavior: {
						type: 'unknown',
						isFlac: false,
						colorFor4: 0,
						colorForOther: 0,
						movwAddr4: '',
						movwInstr4: '',
						movwAddrOther: '',
						movwInstrOther: ''
					},
					canPatch: false
				};
			}

			// Populate colorWrites for each function by simulating all themes
			// This matches the Python implementation which calls simulator for each theme
			const enrichedFunctions = functions.map(func => {
				// For switch_case patterns (Progress Bar and Marquee), colors are in preloadColors
				if (func.patternType === 'switch_case' && func.preloadColors) {
					// Colors already in preloadColors, no need to simulate
					return func;
				}

				// For FLAC and Menu (ite/preload_store patterns), simulate all themes
				const simulator = new ControlFlowSimulator(this.decoder);
				const allColorWrites: ColorWrite[] = [];
				const themeRegister = func.themeRegister ?? 0; // Default to R0
				const themeCount = func.themeCount ?? 5; // Use detected theme count

				for (let themeId = 0; themeId < themeCount; themeId++) {
					const [, colorWrites] = simulator.simulate(
						func.addr,
						func.endAddr || func.addr + 500,
						themeId,
						themeRegister
					);

					// Add all colorWrites from this theme simulation
					allColorWrites.push(...colorWrites);
				}

				// Return enriched function with populated colorWrites
				return {
					...func,
					colorWrites: allColorWrites
				} as ThemeFunction;
			});

			// Build mergedColors map for backward compatibility
			// Extract colors from colorWrites organized by register
			const mergedColors = createColorMap();
			for (const func of enrichedFunctions) {
				for (const write of func.colorWrites) {
					if (!mergedColors.has(write.targetReg)) {
						mergedColors.set(write.targetReg, []);
					}
					mergedColors.get(write.targetReg)!.push(write.colorValue);
				}
			}

			// Determine FLAC behavior using behavior analysis
			const flacBehavior = this.analyzeFlacBehavior(enrichedFunctions);

			return {
				version: 'Unknown',
				themeFunctions: enrichedFunctions,
				colors: mergedColors,
				flacBehavior,
				canPatch: enrichedFunctions.length > 0
			};
		} catch (error) {
			throwThemeError(error, AnalysisError, 'Failed to extract theme colors');
		}
	}

	/**
	 * Analyze FLAC behavior using behavior analyzer
	 */
	private analyzeFlacBehavior(functions: ThemeFunction[]): FlacBehavior {
		const flacFunc = functions.find(f => f.type === 'flac');

		if (!flacFunc) {
			return {
				type: 'unknown',
				isFlac: false,
				colorFor4: 0,
				colorForOther: 0,
				movwAddr4: '',
				movwInstr4: '',
				movwAddrOther: '',
				movwInstrOther: ''
			};
		}

		// Use behavior analyzer for detailed analysis
		return this.behaviorAnalyzer.analyzeFlacFunction(flacFunc.addr, 100);
	}

	/**
	 * Get specific colors for a function type
	 * Returns colors in the format expected by the patcher
	 */
	getColorsForFunction(funcType: 'flac' | 'menu' | 'progress' | 'marquee'): number[] {
		const result = this.extract();
		const func = result.themeFunctions.find(f => f.type === funcType);

		if (!func) {
			throw new NotFoundError(`${funcType} function not found`);
		}

		// For switch_case patterns (progress, marquee), extract from preloadColors
		if (func.patternType === 'switch_case' && func.preloadColors) {
			const colors: number[] = [];
			const themeCount = func.themeCount ?? 5;
			// Colors are indexed 0-themeCount-1 in preloadColors
			for (let i = 0; i < themeCount; i++) {
				colors.push(func.preloadColors[i] || 0);
			}
			return colors;
		}

		// For FLAC and Menu, extract colors from all themes
		const themeCount = func.themeCount ?? 5;
		const allColors: number[] = [];

		if (funcType === 'flac') {
			// For FLAC, check if firmware is patched by looking at flacBehavior
			// If flacColors array exists, firmware is patched - read from it
			// Otherwise, use colorForOther (themes 0-3) and colorFor4 (theme 4)
			const result = this.extract();

			if (result.flacBehavior.flacColors && result.flacBehavior.flacColors.length > 0) {
				// Patched firmware: use colors from metadata
				return [...result.flacBehavior.flacColors];
			} else {
				// Unpatched firmware: use colorForOther and colorFor4
				for (let themeId = 0; themeId < themeCount; themeId++) {
					if (themeId === 4) {
						allColors.push(result.flacBehavior.colorFor4);
					} else {
						allColors.push(result.flacBehavior.colorForOther);
					}
				}
			}
		} else if (funcType === 'menu') {
			// Menu: Check if firmware is patched by using discoverMenuFunction
			const menuDiscovery = discoverMenuFunction(this.data);
			// CRITICAL: discoverMenuFunction returns non-null even for unpatched firmware!
			// We must check if the second element (patch address) actually has a BL instruction
			const isPatched = menuDiscovery !== null && hasBlInstructionAt(this.data, menuDiscovery[1]);

			if (isPatched) {
				// Menu is patched - read metadata from NOP slide
				// [funcAddr, patchAddr] = menuDiscovery
				const [, patchAddr] = menuDiscovery;

				// Decode BL instruction to get NOP slide start
				const detector = new PatchDetector(this.data);
				const nopSlideStart = detector.decodeBlTarget(patchAddr);

				// Scan for metadata signature starting from NOP slide start
				// Metadata is stored at the end of the NOP slide, which varies in size
				// Search in a reasonable range (up to 1024 bytes from NOP slide start)
				const searchStart = nopSlideStart;
				const searchEnd = Math.min(nopSlideStart + 1024, this.data.length);

				// Look for "ECHO" signature in the search range
				let metadataOffset: number | null = null;
				for (let addr = searchStart; addr < searchEnd - 51; addr++) {
					// Check for "ECHO" magic (0x4F484345 in little-endian)
					if (this.data[addr] === 0x45 &&  // 'E'
					    this.data[addr + 1] === 0x43 && // 'C'
					    this.data[addr + 2] === 0x48 && // 'H'
					    this.data[addr + 3] === 0x4F) { // 'O'
						metadataOffset = addr;
						break;
					}
				}

				if (metadataOffset !== null) {
					const metadata = detector.readPatchMetadata({
						start: nopSlideStart,
						end: metadataOffset + 51,
						size: metadataOffset + 51 - nopSlideStart,
						source: 'extractor',
						isActive: true,
						referenceCount: 0
					});
					if (metadata && metadata.menuColors && metadata.menuColors.length === 15) {
						// Found valid metadata with Menu colors
						console.error('[DEBUG] Menu colors from metadata:', metadata.menuColors.map(c => '0x' + c.toString(16)));
						return [...metadata.menuColors];
					}
				}

				// Menu appears to be patched but metadata is invalid
				console.error('[ERROR] Menu is patched but metadata is invalid or missing');
				console.error('[ERROR] NOP slide start: 0x' + nopSlideStart.toString(16));
				console.error('[ERROR] Metadata offset:', metadataOffset);
				throw new NotFoundError(
					'Menu function is patched but metadata cannot be read.\n\n' +
					'This may indicate a corrupted patch.\n' +
					'Please start with a clean original firmware file.'
				);
			}

			// Unpatched firmware: use simulator
			console.error('[DEBUG] Menu is unpatched, using simulator');
			for (let themeId = 0; themeId < themeCount; themeId++) {
				const simulator = new ControlFlowSimulator(this.decoder);
				const themeRegister = func.themeRegister ?? 12; // Menu uses R12
				const [registers] = simulator.simulate(
					func.addr,
					func.endAddr || func.addr + 500,
					themeId,
					themeRegister
				);
				// Menu uses R1, R2, R3 for the three color attributes
				allColors.push(registers.get(1) || 0);
				allColors.push(registers.get(2) || 0);
				allColors.push(registers.get(3) || 0);
			}
			console.error('[DEBUG] Menu colors from simulator:', allColors.map(c => '0x' + c.toString(16)));
		}

		return allColors;
	}
}

/**
 * Convenience function to extract colors from firmware
 */
export function extractThemeColors(firmwareData: Uint8Array): AnalysisResult {
	const extractor = new ThemeColorExtractor(firmwareData);
	return extractor.extract();
}
