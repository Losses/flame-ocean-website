/**
 * Theme Color Extractor
 *
 * Main extraction module that analyzes firmware to discover theme colors.
 * Uses function discovery and control flow simulation to extract color values.
 */

import { ThumbDecoder } from './thumb/index.js';
import { ThemeDiscovery } from './discovery.js';
import { ControlFlowSimulator } from './simulator.js';
import { BehaviorAnalyzer } from './behavior.js';
import { createColorMap, type ThemeFunction, type AnalysisResult, type FlacBehavior, type ColorWrite } from './types.js';
import {
	NotFoundError,
	AnalysisError,
	throwThemeError
} from './errors.js';

/**
 * Theme Color Extractor Class
 *
 * Analyzes firmware to discover and extract theme color values.
 */
export class ThemeColorExtractor {
	private readonly decoder: ThumbDecoder;
	private readonly discovery: ThemeDiscovery;
	private readonly behaviorAnalyzer: BehaviorAnalyzer;

	/**
	 * Create a new ThemeColorExtractor
	 */
	constructor(firmwareData: Uint8Array) {
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
			// FLAC: Return one color per theme (from R0)
			for (let themeId = 0; themeId < themeCount; themeId++) {
				const simulator = new ControlFlowSimulator(this.decoder);
				const themeRegister = func.themeRegister ?? 1; // FLAC uses R1
				const [registers] = simulator.simulate(
					func.addr,
					func.endAddr || func.addr + 500,
					themeId,
					themeRegister
				);
				// FLAC returns color in R0
				const value = registers.get(0) || 0;
				allColors.push(value);
			}
		} else if (funcType === 'menu') {
			// Menu: Return 3 colors per theme (R1, R2, R3 for each theme)
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
