/**
 * RSE (Resource Extraction Library)
 *
 * Platform-neutral TypeScript port of Python firmware resource extraction scripts.
 *
 * @module rse
 */

// Types
export * from './types/index.js';

// Utilities
export * from './utils/struct.js';
export * from './utils/bytes.js';
export * from './utils/bitmap.js';
export * from './utils/unicode-ranges.js';
export * from './utils/tofu-font.js';
export * from './utils/font-extraction.js';
export * from './utils/font-detection.js';

// Extractors
export { FirmwareAnalyzer } from './extractors/firmware-analyzer.js';
export { FontExtractor } from './extractors/font-extractor.js';
export { ResourceExtractor } from './extractors/resource-extractor.js';
export { BatchProcessor } from './extractors/batch-processor.js';

// Re-export commonly used types
export type {
	BitmapMetadata,
	FirmwareAddresses,
	UnicodeRange,
	FontExtractionResult,
	BitmapExtractionResult,
	BatchResult,
	FirmwarePartition,
	FontPlaneInfo,
	BitmapFileInfo
} from './types/index.js';
