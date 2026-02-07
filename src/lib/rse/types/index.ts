/**
 * Type definitions for RSE (Resource Extraction Library)
 * Platform-neutral firmware resource extraction types
 */

/**
 * Represents a partition in the firmware image
 */
export interface FirmwarePartition {
	/** Offset in bytes from the start of the firmware */
	readonly offset: number;
	/** Size in bytes */
	readonly size: number;
}

/**
 * Metadata entry for a bitmap resource
 */
export interface BitmapMetadata {
	/** Index in the metadata table */
	readonly index: number;
	/** Offset where the bitmap data is stored */
	readonly offset: number;
	/** Width of the bitmap in pixels */
	readonly width: number;
	/** Height of the bitmap in pixels */
	readonly height: number;
	/** Name of the resource (e.g., "POWERON1.BMP") */
	readonly name: string;
}

/**
 * Result of offset misalignment detection
 */
export interface MisalignmentDetection {
	/** The detected misalignment (can be positive, negative, or zero) */
	readonly misalignment: number;
	/** Index of the first valid entry */
	readonly firstValidEntry: number;
	/** Detailed detection information */
	readonly detectionInfo: DetectionInfo;
}

/**
 * Detailed detection information
 */
export interface DetectionInfo {
	/** Rock26 table count */
	readonly rock26Count: number;
	/** Sample offsets from Rock26 table */
	readonly rock26SampleOffsets: readonly number[];
	/** Metadata entry count */
	readonly metadataCount: number;
	/** Detection checks performed */
	readonly checks: readonly DetectionCheck[];
	/** Detection conclusion */
	readonly conclusion: string;
}

/**
 * A single detection check result
 */
export interface DetectionCheck {
	/** Name of the check */
	readonly name: string;
	/** Check result data */
	readonly result: string | number | boolean | Record<string, unknown>;
}

/**
 * Result of bitmap extraction
 */
export interface BitmapExtractionResult {
	/** Firmware version */
	readonly version: string;
	/** Total entries processed */
	readonly total: number;
	/** Successfully extracted bitmaps */
	readonly success: number;
	/** Failed extractions */
	readonly error: number;
	/** Detected misalignment */
	readonly misalignment: number;
	/** Detection information */
	readonly detectionInfo: DetectionInfo;
}

/**
 * Stride information for bitmap operations
 */
export interface StrideInfo {
	/** Source stride (bytes per row) */
	readonly srcStride: number;
	/** Destination stride (aligned) */
	readonly dstStride: number;
	/** Padding bytes per row */
	readonly padding: number;
}

/**
 * RGB565 color value
 */
export type RGB565 = number & { readonly __rgb565: unique symbol };

/**
 * Unicode range definition
 */
export interface UnicodeRange {
	/** Name of the range (e.g., "Basic_Latin", "CJK_Unified") */
	readonly name: string;
	/** Start code point */
	readonly start: number;
	/** End code point (inclusive) */
	readonly end: number;
}

/**
 * Detected firmware addresses
 */
export interface FirmwareAddresses {
	/** Base address for small font */
	SMALL_BASE: number;
	/** Base address for large font */
	LARGE_BASE: number;
	/** Lookup table address */
	LOOKUP_TABLE: number;
	/** Confidence metrics */
	confidence: AddressConfidence;
}

/**
 * Confidence metrics for detected addresses
 */
export interface AddressConfidence {
	/** Number of valid small font samples found */
	smallFontValid: number;
	/** Number of valid large font samples found */
	largeFontValid: number;
	/** Count of MOVW #0x0042 instructions */
	movw0042Count: number;
}

/**
 * Font extraction options
 */
export interface FontExtractionOptions {
	/** Custom Unicode ranges to extract (optional) */
	readonly unicodeRanges?: readonly UnicodeRange[];
	/** Output directory path */
	readonly outputDir: string;
}

/**
 * Font extraction result
 */
export interface FontExtractionResult {
	/** Total small fonts extracted */
	readonly smallCount: number;
	/** Total large fonts extracted */
	readonly largeCount: number;
	/** Results per range */
	readonly rangeResults: readonly RangeResult[];
}

/**
 * Result for a single Unicode range
 */
export interface RangeResult {
	/** Range name */
	readonly name: string;
	/** Start code point */
	readonly start: number;
	/** End code point */
	readonly end: number;
	/** Small fonts extracted in this range */
	readonly smallCount: number;
	/** Large fonts extracted in this range */
	readonly largeCount: number;
}

/**
 * Window scoring result for heuristic search
 */
export interface WindowScore {
	/** Window start address */
	readonly windowStart: number;
	/** Score (sequence length) */
	readonly score: number;
	/** First address in the sequence */
	readonly firstAddr: number;
}

/**
 * Search region for heuristic algorithms
 */
export interface SearchRegion {
	/** Region start address */
	readonly start: number;
	/** Region end address */
	readonly end: number;
}

/**
 * Sequence found in firmware
 */
export interface FirmwareSequence {
	/** Start address */
	readonly start: number;
	/** Sequence length */
	readonly length: number;
	/** First value in the sequence */
	readonly firstValue: number;
}

/**
 * Pixel data for monochrome bitmap
 */
export type PixelRow = readonly boolean[];
export type PixelData = readonly PixelRow[];

/**
 * BMP file header
 */
export interface BMPHeader {
	/** File type (should be 'BM') */
	readonly fileType: number;
	/** File size in bytes */
	readonly fileSize: number;
	/** Offset to pixel data */
	readonly offset: number;
	/** DIB header size */
	readonly dibHeaderSize: number;
	/** Image width */
	readonly width: number;
	/** Image height */
	readonly height: number;
	/** Bits per pixel */
	readonly bitsPerPixel: number;
	/** Image size in bytes */
	readonly image_size: number;
}

/**
 * Configuration for byte swapping operations
 */
export interface ByteSwapConfig {
	/** Whether to swap bits */
	readonly swMcuBits: number;
	/** Whether to swap hardware */
	readonly swMcuHwSwap: number;
	/** Whether to swap bytes */
	readonly swMcuByteSwap: number;
}

/**
 * Batch extraction result
 */
export interface BatchResult {
	/** Firmware version */
	readonly version: string;
	/** Status emoji */
	readonly status: string;
	/** Small font count */
	readonly small: number;
	/** Large font count */
	readonly large: number;
}
