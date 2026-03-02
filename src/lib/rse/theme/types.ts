/**
 * Theme System Type Definitions
 *
 * Types for theme color extraction, analysis, and patching.
 */

import type { Instruction } from './thumb/index.js';

/**
 * Color write record - represents a STRH instruction that writes a color
 */
export interface ColorWrite {
	/** Address of the STRH instruction */
	readonly addr: number;
	/** The decoded instruction */
	readonly instr: Instruction;
	/** The color value being written */
	readonly colorValue: number;
	/** Target register (base address register) */
	readonly targetReg: number;
	/** Source register (color data register) */
	readonly sourceReg: number;
	/** Theme condition value that caused this write (null if unconditional) */
	readonly themeCondition: number | null;
	/** The MOVW instruction that loaded this color (if known) */
	readonly movwInstr: MovwRecord | null;
}

/**
 * MOVW record - tracks MOVW instructions that load color values
 */
export interface MovwRecord {
	/** Address of the MOVW instruction */
	readonly addr: number;
	/** The decoded instruction */
	readonly instr: Instruction;
	/** The color value being loaded */
	readonly colorValue: number;
	/** Target register receiving the color */
	readonly targetReg: number;
	/** Theme condition value (null if unconditional) */
	readonly themeCondition: number | null;
}

/**
 * Theme function - a function in firmware that handles theme colors
 */
export interface ThemeFunction {
	/** Function start address */
	readonly addr: number;
	/** Function end address (0 if unknown) */
	readonly endAddr: number;
	/** Pattern type that identifies this function */
	readonly patternType: PatternType;
	/** Function type shorthand */
	readonly type?: 'flac' | 'menu' | 'progress' | 'marquee' | 'unknown';
	/** All color writes found in this function */
	readonly colorWrites: readonly ColorWrite[];
	/** Preloaded colors found by pattern matching */
	readonly preloadColors: Readonly<Record<number, number>>;
	/** MOVW instructions for preloaded colors (theme index -> MOVW record) */
	readonly preloadMovwRecords: Readonly<Record<number, MovwRecord>>;
	/** Number of themes supported by this function (detected from firmware) */
	readonly themeCount: number;
	/** UI element this function controls */
	uiElement: string;
	/** Register that holds the theme value (default: 0 for R0) */
	readonly themeRegister?: number;
	/** Analysis metadata */
	readonly metadata?: ThemeFunctionMetadata;
}

/**
 * Theme function metadata
 */
export interface ThemeFunctionMetadata {
	/** Confidence score (0-1) */
	readonly confidence: number;
	/** Detection method used */
	readonly detectionMethod: string;
	/** Additional analysis data */
	readonly analysisData?: Record<string, unknown>;
}

/**
 * Pattern type - how the theme function was identified
 */
export type PatternType = 'switch_case' | 'ite' | 'preload_store' | 'unknown';

/**
 * Analysis result from theme extraction
 */
export interface AnalysisResult {
	/** All discovered theme functions */
	readonly themeFunctions: readonly ThemeFunction[];
	/** Theme colors organized by register */
	readonly colors: ThemeColorMap;
	/** FLAC behavior analysis */
	readonly flacBehavior: FlacBehavior;
	/** Any errors encountered during analysis */
	readonly errors?: readonly string[];
	/** Firmware version detected */
	readonly version: string;
	/** Support level (full, partial, none) */
	readonly supportLevel?: SupportLevel;
	/** Whether firmware can be patched */
	readonly canPatch: boolean;
}

/**
 * Theme color map - theme ID -> element -> color
 * For color extraction: register -> array of color values
 */
export type ThemeColorMap = Map<number, number[]>;

/**
 * Create empty color map
 */
export function createColorMap(): ThemeColorMap {
	return new Map();
}

/**
 * FLAC behavior analysis result
 */
/**
 * Detailed FLAC behavior analysis result
 */
export interface FlacBehavior {
	/** Type of FLAC behavior */
	type: 'standard' | 'bypass' | 'unknown';
	/** Whether this is confirmed as FLAC function */
	isFlac: boolean;
	/** Color value for theme ID 4 */
	colorFor4: number;
	/** Color value for other themes (non-4) */
	colorForOther: number;
	/** All 5 FLAC colors (one per theme), only available when reading from metadata */
	flacColors?: number[];
	/** Address of MOVW instruction for theme 4 */
	movwAddr4: string;
	/** MOVW instruction for theme 4 */
	movwInstr4: string;
	/** Address of MOVW instruction for other themes */
	movwAddrOther: string;
	/** MOVW instruction for other themes */
	movwInstrOther: string;
}

/**
 * Menu/Theme function behavior analysis result
 */
export interface MenuBehavior {
	/** Count of CMP R12, #0-4 instructions */
	cmpR12Count: number;
	/** Count of distinct MOVW R0 color values */
	distinctColors: number;
	/** Count of STRH instructions */
	strhCount: number;
	/** Set of color values found */
	colors: Set<number>;
}

/**
 * Patch information
 */
export interface PatchInfo {
	/** Whether firmware is patched */
	readonly isPatched: boolean;
	/** Type of patch applied */
	readonly patchType: PatchType;
	/** Whether FLAC is patched */
	readonly flacPatched: boolean;
	/** Whether menu colors are patched */
	readonly menuPatched: boolean;
	/** Whether NOP has code (indicating patch) */
	readonly nopHasCode: boolean;
	/** Target address of patch */
	readonly patchTargetAddr: number;
	/** Confidence score (0-1) */
	readonly confidence: number;
	/** Patch metadata if available */
	readonly metadata: PatchMetadata | null;
}

/**
 * Patch type classification
 */
export type PatchType = 'none' | 'flac_only' | 'menu_only' | 'full' | 'unknown';

/**
 * Support level for theme system
 */
export type SupportLevel = 'full' | 'partial' | 'none';

/**
 * NOP slide region - area of unused bytes that can be used for patch code
 */
export interface NopSlide {
	/** Start address of NOP slide */
	readonly start: number;
	/** End address of NOP slide */
	readonly end: number;
	/** Size in bytes */
	readonly size: number;
	/** Source identifier */
	readonly source: string;
	/** Whether this slide is active/selected */
	readonly isActive: boolean;
	/** Number of references to this slide */
	readonly referenceCount: number;
}

/**
 * Patch point - location in firmware where a patch is applied
 */
export interface PatchPoint {
	/** Function type */
	readonly type?: 'flac' | 'menu' | 'progress' | 'marquee';
	/** Function address */
	readonly funcAddr: number;
	/** Patch address (where BL is inserted) */
	readonly patchAddr: number;
	/** Target address (where BL branches to) */
	readonly targetAddr: number;
	/** Original bytes as hex string */
	readonly originalBytes: string;
	/** New bytes as hex string */
	readonly newBytes: string;
}

/**
 * Patch metadata - information stored in patched firmware
 */
export interface PatchMetadata {
	/** Magic number identifier */
	readonly magic: string;
	/** Metadata version */
	readonly version: number;
	/** Timestamp when patch was applied */
	readonly timestamp: number;
	/** FLAC colors for all themes */
	readonly flacColors: readonly number[];
	/** Menu colors for all themes */
	readonly menuColors: readonly number[];
	/** Checksum for verification */
	readonly checksum: number;

	/** Convert to bytes */
	toBytes(): Uint8Array;
}

/**
 * Patch result from applying a patch
 */
export interface PatchResult {
	/** Whether patching succeeded */
	readonly success: boolean;
	/** NOP slide used for patch code */
	readonly nopSlide: NopSlide;
	/** All patch points applied */
	readonly patchPoints: Readonly<Record<string, PatchPoint>>;
	/** Address where metadata was stored */
	readonly metadataAddr: number;
	/** Patched firmware data (only included when writeFile=false) */
	readonly patchedData?: Uint8Array;
}

/**
 * Patch point info - simplified patch point info for analysis
 */
export interface PatchPointInfo {
	/** Function type (flac/menu/progress/marquee) */
	readonly type: 'flac' | 'menu' | 'progress' | 'marquee';
	/** Function address */
	readonly funcAddr: number;
	/** Patch address */
	readonly patchAddr: number;
	/** Function start address */
	readonly functionStart: number;
}

/**
 * Patch analysis result
 */
export interface PatchAnalysisResult {
	/** Detected firmware version */
	version: string;
	/** Theme functions found */
	themeFunctions: PatchPointInfo[];
	/** Available NOP slides */
	nopSlides: NopSlide[];
	/** Whether firmware can be patched */
	canPatch: boolean;
	/** Compatibility level */
	compatibility: 'supported' | 'experimental' | 'deprecated' | 'unsupported';
	/** Optional message explaining support status */
	supportMessage?: string;
	/** Patch detection status */
	patchStatus: {
		readonly isPatched: boolean;
		readonly status: string;
		readonly patchType: 'none' | 'flac_only' | 'menu_only' | 'full' | 'unknown';
		readonly flacPatched: boolean;
		readonly menuPatched: boolean;
		readonly nopHasCode: boolean;
		readonly confidence: number;
		readonly metadata?: PatchMetadata;
	};
}

/**
 * Create empty theme color map
 */
export function createThemeColorMap(): Map<number, Map<string, number>> {
	return new Map();
}

/**
 * Get color from theme color map (legacy API)
 */
export function getThemeColor(
	map: Map<number, Map<string, number>>,
	themeId: number,
	element: string
): number | undefined {
	return map.get(themeId)?.get(element);
}

/**
 * Set color in theme color map (legacy API)
 */
export function setThemeColor(
	map: Map<number, Map<string, number>>,
	themeId: number,
	element: string,
	color: number
): void {
	if (!map.has(themeId)) {
		map.set(themeId, new Map());
	}
	map.get(themeId)!.set(element, color);
}

/**
 * Check if function is a FLAC function
 */
export function isFlacFunction(func: ThemeFunction): boolean {
	return (
		func.patternType === 'ite' &&
		(func.uiElement.includes('FLAC') || func.uiElement === 'Unknown UI Element')
	);
}

/**
 * Check if function is a Menu function
 */
export function isMenuFunction(func: ThemeFunction): boolean {
	return (
		func.patternType === 'preload_store' &&
		(func.uiElement.includes('Menu') || func.uiElement === 'Unknown UI Element')
	);
}

/**
 * Check if function is a Progress Bar function
 */
export function isProgressFunction(func: ThemeFunction): boolean {
	return (
		func.patternType === 'switch_case' &&
		(func.uiElement.includes('Progress Bar') || func.uiElement === 'Unknown UI Element')
	);
}

/**
 * Check if function is a Marquee Overlay function
 */
export function isMarqueeFunction(func: ThemeFunction): boolean {
	return (
		func.patternType === 'switch_case' &&
		(func.uiElement.includes('Marquee') || func.uiElement === 'Unknown UI Element')
	);
}

/**
 * Get display name for pattern type
 */
export function getPatternTypeName(pattern: PatternType): string {
	const names: Record<PatternType, string> = {
		switch_case: 'Switch-Case Pattern',
		ite: 'ITE Pattern',
		preload_store: 'Preload-Store Pattern',
		unknown: 'Unknown Pattern'
	};
	return names[pattern] ?? 'Unknown';
}

/**
 * Validate color value (16-bit RGB565)
 */
export function isValidColor(color: number): boolean {
	return Number.isInteger(color) && color >= 0 && color <= 0xffff;
}

/**
 * Validate theme ID
 */
export function isValidThemeId(themeId: number): boolean {
	return Number.isInteger(themeId) && themeId >= 0 && themeId < 32;
}

/**
 * Format color as hex string
 */
export function formatColor(color: number): string {
	return `0x${color.toString(16).padStart(4, '0').toUpperCase()}`;
}

/**
 * Parse color from hex string
 */
export function parseColor(hex: string): number {
	if (hex.startsWith('0x') || hex.startsWith('0X')) {
		return parseInt(hex, 16);
	}
	return parseInt(hex, 16);
}
