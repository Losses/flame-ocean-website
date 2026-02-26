/**
 * Theme Module
 *
 * Theme color extraction and patching for firmware.
 * Provides functionality to discover, extract, and patch theme colors.
 */

// Thumb instruction decoding/encoding
export * from './thumb/index.js';

// Types
export * from './types.js';

// Errors
export * from './errors.js';

// Function discovery
export { ThemeDiscovery, discoverFlacFunction, discoverMenuFunction, findFunctionStart } from './discovery.js';

// Control flow simulation
export { ControlFlowSimulator } from './simulator.js';

// NOP slide finding
export { NopSlideFinder } from './nop-slide.js';

// Code reference analysis
export {
	CodeReferenceAnalyzer,
	analyzeCodeReferences
} from './code-reference-analyzer.js';

export type {
	BranchTarget,
	LandingPoint,
	NopSlideAnalysis
} from './code-reference-analyzer.js';

// Patch detection
export { PatchDetector, createPatchInfo, detectFirmwarePatched } from './detector.js';

// Behavior analysis
export { BehaviorAnalyzer } from './behavior.js';

// Patch metadata
export {
	createPatchMetadata,
	readPatchMetadata,
	writePatchMetadata,
	verifyPatchMetadata,
	formatTimestamp,
	crc16
} from './metadata.js';

// Instruction encoding
export { encodeBl, decodeBlTarget, encodeB16bit, encodeMovw, encodePush } from './thumb/encoders.js';

// Main extractor
export { ThemeColorExtractor, extractThemeColors } from './extractor.js';

// Main patcher
export {
	ThemePatcher,
	patchFirmware
} from './patcher.js';

// Re-export commonly used types
export type {
	ColorWrite,
	MovwRecord,
	ThemeFunction,
	FlacBehavior,
	AnalysisResult as ThemeAnalysisResult,
	ThemeColorMap,
	PatchMetadata,
	NopSlide,
	PatchPoint,
	PatchPointInfo,
	PatchResult,
	PatchAnalysisResult,
	PatchInfo
} from './types.js';
