/**
 * Web Worker for firmware data processing
 * Handles all heavy computation off the main thread
 */

// Import shared metadata utilities
import JSZip from "jszip";

import {
  decodeV8,
  isDataEmpty,
  sliceSmallFontPixels,
  padSmallFontPixels,
} from "../rse/utils/font-decoder";
import { type PixelData } from "../rse/types";
import { validateBitmapData, encodeV8 } from "../rse/utils/font-encoder";
import { buildBitmapListFromMetadata } from "../rse/utils/metadata";
import { convertToBmp, isValidFontData } from "../rse/utils/bitmap";
import { imageDataToPixels } from "../rse/utils/glyph-renderer";

// Constants
const SMALL_STRIDE = 32;
const LARGE_STRIDE = 33;
const INVALID_VALUES = new Set([0x00, 0xff]);
const FOOTER_SIGNATURES = new Set([0x90, 0x8f, 0x89, 0x8b, 0x8d, 0x8e, 0x8c]);

// Worker message types
interface WorkerRequest {
  type:
    | "analyze"
    | "listPlanes"
    | "listImages"
    | "extractPlane"
    | "extractImage"
    | "replaceImage"
    | "replaceImages"
    | "getFirmware"
    | "bundleImagesAsZip"
    | "replaceFonts"
    | "replaceFontsStreamStart"
    | "replaceFontsStreamAdd"
    | "replaceFontsStreamFinish"
    | "replaceFontsWorker" // Complete font replacement in worker
    | "analyzeFonts"; // Analyze font with tofu detection
  id: string;
  firmware: Uint8Array;
  fontType?: "SMALL" | "LARGE";
  planeName?: string;
  start?: number;
  end?: number;
  imageName?: string;
  width?: number;
  height?: number;
  offset?: number;
  rgb565Data?: Uint8Array; // Pre-converted RGB565 data
  images?: Array<{
    // For batch replacement
    imageName: string;
    width: number;
    height: number;
    offset: number;
    rgb565Data: Uint8Array;
  }>;
  // Font replacement fields (for batch mode)
  fontReplacements?: Array<{
    /** Unicode code point */
    unicode: number;
    /** Pixel data (16x16 boolean array) */
    pixels: boolean[][];
  }>;
  // Streaming font replacement fields
  totalCharacters?: number; // Total expected characters (for progress reporting)
  character?: {
    /** Unicode code point */
    unicode: number;
    /** Pixel data (16x16 boolean array) */
    pixels: boolean[][];
  };
  // Worker-based font extraction fields
  fontData?: ArrayBuffer; // Font file data for worker to load
  fontFamily?: string; // Font family name to use
  fontSize?: 12 | 16; // Font size
  codePoints?: number[]; // Code points to extract
}

interface FontPlaneInfo {
  name: string;
  start: number;
  end: number;
  smallCount: number;
  largeCount: number;
  estimatedCount: number;
}

interface BitmapFileInfo {
  name: string;
  width: number;
  height: number;
  size: number;
  offset?: number;
}

interface PlaneData {
  name: string;
  start: number;
  end: number;
  fonts: Array<{
    unicode: number;
    fontType: "SMALL" | "LARGE";
    pixels: PixelData;
  }>;
}

interface ImageData {
  name: string;
  width: number;
  height: number;
  rgb565Data: Uint8Array; // Raw RGB565 data
}

interface ReplaceImageResult {
  success: boolean;
  imageName: string;
  rgb565Data?: Uint8Array;
  error?: string;
}

interface ReplaceImagesResult {
  successCount: number;
  notFound: string[];
  dimensionMismatch: string[];
  replaceError: string[];
  results: Array<{
    imageName: string;
    rgb565Data: Uint8Array;
  }>;
}

interface ReplaceFontsResult {
  successCount: number;
  skippedCount: number;
  errors: string[];
  replacedCharacters: number[];
  skippedCharacters: number[];
  skippedReasons: Map<number, string>;
  fontType: "SMALL" | "LARGE"; // Which font type was replaced
}

type WorkerResponse =
  | {
      type: "success";
      id: string;
      result:
        | FontPlaneInfo[]
        | BitmapFileInfo[]
        | PlaneData
        | ImageData
        | ReplaceImageResult
        | ReplaceImagesResult
        | ReplaceFontsResult
        | Uint8Array;
    }
  | { type: "progress"; id: string; message: string }
  | {
      type: "progress";
      id: string;
      message: string;
      queueDepth: number;
      queueCapacity: number;
    }
  | { type: "queueReady"; id: string }
  | { type: "error"; id: string; error: string };

// Firmware data cache
let firmwareData: Uint8Array | null = null;
let SMALL_BASE = 0;
let LARGE_BASE = 0;
let LOOKUP_TABLE = 0x080000;

// Constants for streaming
const MAX_QUEUE_SIZE = 100;
const QUEUE_READY_THRESHOLD = 50; // Send "ready" signal when queue drops below this

// Streaming font replacement state
interface FontReplacementStreamState {
  id: string;
  fontType: "SMALL" | "LARGE";
  totalCharacters: number;
  receivedCharacters: number;
  processedCharacters: number;
  queue: Array<{
    unicode: number;
    pixels: boolean[][];
  }>;
  results: {
    replacedCharacters: number[];
    skippedCharacters: number[];
    skippedReasons: Map<number, string>;
    errors: string[];
    successCount: number;
  };
  isProcessing: boolean;
  isFinished: boolean;
  lastSentReady: boolean; // Track if we sent "ready" signal
}

let streamState: FontReplacementStreamState | null = null;

// Binary reading helpers
function readU16LE(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

function findBytes(
  data: Uint8Array,
  pattern: Uint8Array,
  startOffset = 0,
): number {
  if (pattern.length === 0) return startOffset;
  if (pattern.length > data.length) return -1;

  for (let i = startOffset; i <= data.length - pattern.length; i++) {
    let found = true;
    for (let j = 0; j < pattern.length; j++) {
      if (data[i + j] !== pattern[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

/**
 * Score a window for font data detection
 * Matches FirmwareAnalyzer.scoreWindow() algorithm
 */
function scoreWindow(
  firmware: Uint8Array,
  windowStart: number,
  windowEnd: number,
  baseAlignment: number | null,
): { score: number; firstAddr: number } {
  let maxSequenceLength = 0;
  let maxSequenceStart = windowStart;
  let currentLength = 0;
  let currentStart = windowStart;
  let consecutiveAnomalies = 0;
  const maxAnomalies = 5;

  for (
    let offset = 0;
    offset < windowEnd - windowStart;
    offset += LARGE_STRIDE
  ) {
    const addr = windowStart + offset;

    if (addr + 32 >= firmware.length) break;

    if (baseAlignment !== null && addr % LARGE_STRIDE !== baseAlignment) {
      continue;
    }

    const byte_32 = firmware[addr + 32];

    if (INVALID_VALUES.has(byte_32)) {
      if (currentLength > maxSequenceLength) {
        maxSequenceLength = currentLength;
        maxSequenceStart = currentStart;
      }
      currentLength = 0;
      consecutiveAnomalies = 0;
    } else if (FOOTER_SIGNATURES.has(byte_32)) {
      if (currentLength === 0) currentStart = addr;
      currentLength++;
      consecutiveAnomalies = 0;
    } else {
      consecutiveAnomalies++;
      if (consecutiveAnomalies <= maxAnomalies) {
        if (currentLength === 0) currentStart = addr;
        currentLength++;
      } else {
        if (currentLength > maxSequenceLength) {
          maxSequenceLength = currentLength;
          maxSequenceStart = currentStart;
        }
        currentLength = 0;
        consecutiveAnomalies = 0;
      }
    }
  }

  if (currentLength > maxSequenceLength) {
    maxSequenceLength = currentLength;
    maxSequenceStart = currentStart;
  }

  return { score: maxSequenceLength, firstAddr: maxSequenceStart };
}

/**
 * Search for large font offset table using window scanning
 * Matches FirmwareAnalyzer.searchOffsetTable() algorithm
 */
function searchOffsetTable(firmware: Uint8Array): number | null {
  // Get partition info (part_2_firmware_b at 0x80)
  const partitionOffset = readU32LE(firmware, 0x80);
  const partitionSize = readU32LE(firmware, 0x84);
  const searchStart = partitionOffset;
  const searchEnd = partitionOffset + partitionSize;

  const windowSize = 20902 * LARGE_STRIDE;
  let currentStride = Math.floor(windowSize / 2);
  const minStride = 100;

  let currentRegions: Array<{ start: number; end: number }> = [
    { start: searchStart, end: searchEnd },
  ];
  let bestAddr: number | null = null;
  let bestScore = -1;
  let baseAlignment: number | null = null;

  while (currentStride > minStride && currentRegions.length > 0) {
    const regionResults: Array<{
      windowStart: number;
      score: number;
      firstAddr: number;
    }> = [];

    for (const region of currentRegions) {
      for (
        let windowStart = region.start;
        windowStart < region.end;
        windowStart += currentStride
      ) {
        const windowEnd = Math.min(windowStart + windowSize, firmware.length);
        const { score, firstAddr } = scoreWindow(
          firmware,
          windowStart,
          windowEnd,
          baseAlignment,
        );

        if (score > bestScore) {
          bestScore = score;
          bestAddr = firstAddr;
        }

        regionResults.push({ windowStart, score, firstAddr });
      }
    }

    regionResults.sort((a, b) => b.score - a.score);
    const topWindows = regionResults.slice(0, 5);

    if (baseAlignment === null && topWindows.length > 0) {
      const bestFirstAddr = topWindows[0].firstAddr;
      baseAlignment = bestFirstAddr % LARGE_STRIDE;
    }

    const nextStride = Math.max(minStride, Math.floor(currentStride / 2));
    currentRegions = [];

    for (const win of topWindows) {
      const firstAddr = win.firstAddr;
      const charsExtend = Math.floor(currentStride / LARGE_STRIDE) + 1;

      let regionStart = firstAddr - charsExtend * LARGE_STRIDE;
      let regionEnd = firstAddr + charsExtend * LARGE_STRIDE;

      regionStart = Math.max(searchStart, regionStart);
      regionEnd = Math.min(searchEnd, regionEnd);

      currentRegions.push({ start: regionStart, end: regionEnd });
    }

    currentStride = nextStride;
  }

  return bestAddr;
}

/**
 * Process a single character from the stream queue
 */
function processStreamCharacter(
  unicode: number,
  pixels: boolean[][],
  state: FontReplacementStreamState,
): { success: boolean; skip: boolean; error?: string } {
  const expectedSize = state.fontType === "SMALL" ? 12 : 16;

  // Validate pixel data dimensions
  if (pixels.length !== expectedSize) {
    const errorMsg = `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: Invalid pixel data height (got ${pixels.length}, expected ${expectedSize})`;
    state.results.errors.push(errorMsg);
    state.results.skippedCharacters.push(unicode);
    state.results.skippedReasons.set(unicode, "invalid_pixel_data");
    return { success: false, skip: true };
  }

  for (let row = 0; row < pixels.length; row++) {
    if (pixels[row].length !== expectedSize) {
      const errorMsg = `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: Invalid pixel data width at row ${row} (got ${pixels[row].length}, expected ${expectedSize})`;
      state.results.errors.push(errorMsg);
      state.results.skippedCharacters.push(unicode);
      state.results.skippedReasons.set(unicode, "invalid_pixel_data");
      return { success: false, skip: true };
    }
  }

  // Calculate firmware address based on font type
  let addr: number;
  let chunkSize: number;

  if (state.fontType === "SMALL") {
    if (unicode > 0xffff) {
      state.results.skippedCharacters.push(unicode);
      state.results.skippedReasons.set(unicode, "not_in_firmware");
      return { success: false, skip: true };
    }
    addr = SMALL_BASE + unicode * SMALL_STRIDE;
    chunkSize = SMALL_STRIDE;
  } else {
    if (unicode < 0x4e00 || unicode > 0x9fff) {
      state.results.skippedCharacters.push(unicode);
      state.results.skippedReasons.set(unicode, "not_in_firmware");
      return { success: false, skip: true };
    }
    addr = LARGE_BASE + (unicode - 0x4e00) * LARGE_STRIDE;
    chunkSize = LARGE_STRIDE;
  }

  // Check if address is valid
  if (!firmwareData || addr + chunkSize > firmwareData.length) {
    state.results.skippedCharacters.push(unicode);
    state.results.skippedReasons.set(unicode, "not_in_firmware");
    return { success: false, skip: true };
  }

  // Get lookup value for encoding
  const lookupVal = firmwareData[LOOKUP_TABLE + (unicode >> 3)];

  // Prepare pixel data for encoding
  let pixelsToEncode: PixelData;
  if (state.fontType === "SMALL") {
    pixelsToEncode = padSmallFontPixels(pixels as PixelData);
  } else {
    pixelsToEncode = pixels as PixelData;
  }

  try {
    // Encode pixels to firmware format
    const encodedChunk = encodeV8(pixelsToEncode, lookupVal);

    // For LARGE fonts, add the footer byte
    const chunkToWrite =
      state.fontType === "LARGE"
        ? new Uint8Array(LARGE_STRIDE)
        : new Uint8Array(SMALL_STRIDE);

    chunkToWrite.set(encodedChunk);

    if (state.fontType === "LARGE") {
      const originalData = firmwareData.slice(addr, addr + LARGE_STRIDE);
      chunkToWrite[LARGE_STRIDE - 1] = originalData[LARGE_STRIDE - 1];
    }

    // Write encoded data to firmware
    firmwareData.set(chunkToWrite, addr);

    // Verify by reading back
    const writtenData = firmwareData.slice(addr, addr + chunkSize);
    let verified = true;

    for (let j = 0; j < chunkSize; j++) {
      if (writtenData[j] !== chunkToWrite[j]) {
        verified = false;
        break;
      }
    }

    if (!verified) {
      return {
        success: false,
        skip: false,
        error: `Verification failed for U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: written data does not match original`,
      };
    }

    // Success
    state.results.replacedCharacters.push(unicode);
    state.results.successCount++;
    return { success: true, skip: false };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    state.results.errors.push(
      `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: ${errorMsg}`,
    );
    state.results.skippedCharacters.push(unicode);
    state.results.skippedReasons.set(unicode, "encoding_error");
    return { success: false, skip: true };
  }
}

/**
 * Process the stream queue
 */
async function processStreamQueue(): Promise<void> {
  if (!streamState || streamState.isProcessing) {
    return;
  }

  streamState.isProcessing = true;

  while (streamState.queue.length > 0) {
    const character = streamState.queue.shift();
    if (!character) break;

    const { unicode, pixels } = character;

    // Report progress periodically with queue depth
    if (streamState.processedCharacters % 10 === 0) {
      self.postMessage({
        type: "progress",
        id: streamState.id,
        message: `Processing U+${unicode.toString(16).toUpperCase().padStart(4, "0")} (${streamState.processedCharacters + 1}/${streamState.totalCharacters})...`,
        queueDepth: streamState.queue.length,
        queueCapacity: MAX_QUEUE_SIZE,
      });
    }

    // Process the character
    const result = processStreamCharacter(unicode, pixels, streamState);
    streamState.processedCharacters++;

    // If there was a critical error (not a skip), abort
    if (!result.success && !result.skip && result.error) {
      console.error(`[worker] CRITICAL ERROR: ${result.error}`);
      self.postMessage({
        type: "error",
        id: streamState.id,
        error: result.error,
      });
      streamState.isProcessing = false;
      streamState = null;
      return;
    }

    // Send queueReady signal when queue drops below threshold
    // This tells main thread it can send more characters
    if (
      streamState.queue.length < QUEUE_READY_THRESHOLD &&
      !streamState.lastSentReady
    ) {
      self.postMessage({
        type: "queueReady",
        id: streamState.id,
      });
      streamState.lastSentReady = true;
    }

    // Reset flag when queue grows again
    if (streamState.queue.length >= QUEUE_READY_THRESHOLD) {
      streamState.lastSentReady = false;
    }

    // Yield to event loop periodically to prevent blocking
    if (streamState.processedCharacters % 50 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  streamState.isProcessing = false;

  // CRITICAL FIX: If new items were added while we were processing,
  // immediately restart processing to prevent deadlock
  if (streamState.queue.length > 0) {
    await processStreamQueue();
    return;
  }

  // If we're finished and queue is empty, send completion
  if (streamState.isFinished && streamState.queue.length === 0) {
    self.postMessage({
      type: "progress",
      id: streamState.id,
      message: "Stream processing complete...",
    });
  } else if (!streamState.isFinished && streamState.queue.length === 0) {
    // Queue is empty but stream not finished - waiting for more characters
  }
}

/**
 * Wait for stream completion
 */
async function waitForStreamCompletion(): Promise<void> {
  if (!streamState) return;

  let iterations = 0;
  const maxIterations = 10000; // Safety limit

  // Wait for queue to be empty and processing to finish
  while (streamState.queue.length > 0 || streamState.isProcessing) {
    iterations++;

    if (iterations > maxIterations) {
      console.error(
        `[worker] waitForStreamCompletion TIMEOUT - queue.length=${streamState.queue.length}, isProcessing=${streamState.isProcessing}`,
      );
      throw new Error(
        `waitForStreamCompletion timeout after ${maxIterations} iterations`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Unicode ranges (complete list matching RSE reference)
const UNICODE_RANGES = [
  { name: "Basic_Latin", start: 0x0000, end: 0x007f },
  { name: "Latin_1_Supplement", start: 0x0080, end: 0x00ff },
  { name: "Latin_Extended_A", start: 0x0100, end: 0x017f },
  { name: "Latin_Extended_B", start: 0x0180, end: 0x024f },
  { name: "IPA_Extensions", start: 0x0250, end: 0x02af },
  { name: "Spacing_Modifier", start: 0x02b0, end: 0x02ff },
  { name: "Combining_Diacritics", start: 0x0300, end: 0x036f },
  { name: "Greek_Coptic", start: 0x0370, end: 0x03ff },
  { name: "Cyrillic", start: 0x0400, end: 0x04ff },
  { name: "Cyrillic_Supplement", start: 0x0500, end: 0x052f },
  { name: "Armenian", start: 0x0530, end: 0x058f },
  { name: "Hebrew", start: 0x0590, end: 0x05ff },
  { name: "Arabic", start: 0x0600, end: 0x06ff },
  { name: "Syriac", start: 0x0700, end: 0x074f },
  { name: "Arabic_Supplement", start: 0x0750, end: 0x077f },
  { name: "Thaana", start: 0x0780, end: 0x07bf },
  { name: "NKo", start: 0x07c0, end: 0x07ff },
  { name: "Samaritan", start: 0x0800, end: 0x083f },
  { name: "Mandaic", start: 0x0840, end: 0x085f },
  { name: "Arabic_Extended_B", start: 0x0870, end: 0x089f },
  { name: "Arabic_Extended_A", start: 0x08a0, end: 0x08ff },
  { name: "Devanagari", start: 0x0900, end: 0x097f },
  { name: "Bengali", start: 0x0980, end: 0x09ff },
  { name: "Gurmukhi", start: 0x0a00, end: 0x0a7f },
  { name: "Gujarati", start: 0x0a80, end: 0x0aff },
  { name: "Oriya", start: 0x0b00, end: 0x0b7f },
  { name: "Tamil", start: 0x0b80, end: 0x0bff },
  { name: "Telugu", start: 0x0c00, end: 0x0c7f },
  { name: "Kannada", start: 0x0c80, end: 0x0cff },
  { name: "Malayalam", start: 0x0d00, end: 0x0d7f },
  { name: "Sinhala", start: 0x0d80, end: 0x0dff },
  { name: "Thai", start: 0x0e00, end: 0x0e7f },
  { name: "Lao", start: 0x0e80, end: 0x0eff },
  { name: "Tibetan", start: 0x0f00, end: 0x0fff },
  { name: "Myanmar", start: 0x1000, end: 0x109f },
  { name: "Georgian", start: 0x10a0, end: 0x10ff },
  { name: "Hangul_Jamo", start: 0x1100, end: 0x11ff },
  { name: "Ethiopic", start: 0x1200, end: 0x137f },
  { name: "Ethiopic_Supplement", start: 0x1380, end: 0x139f },
  { name: "Cherokee", start: 0x13a0, end: 0x13ff },
  { name: "UCAS", start: 0x1400, end: 0x167f },
  { name: "Ogham", start: 0x1680, end: 0x169f },
  { name: "Runic", start: 0x16a0, end: 0x16ff },
  { name: "Tagalog", start: 0x1700, end: 0x171f },
  { name: "Hanunoo", start: 0x1720, end: 0x173f },
  { name: "Buhid", start: 0x1740, end: 0x175f },
  { name: "Tagbanwa", start: 0x1760, end: 0x177f },
  { name: "Khmer", start: 0x1780, end: 0x17ff },
  { name: "Mongolian", start: 0x1800, end: 0x18af },
  { name: "UCAS_Extended", start: 0x18b0, end: 0x18ff },
  { name: "Limbu", start: 0x1900, end: 0x194f },
  { name: "Tai_Le", start: 0x1950, end: 0x197f },
  { name: "New_Tai_Lue", start: 0x1980, end: 0x19df },
  { name: "Khmer_Symbols", start: 0x19e0, end: 0x19ff },
  { name: "Buginese", start: 0x1a00, end: 0x1a1f },
  { name: "Tai_Tham", start: 0x1a20, end: 0x1aaf },
  { name: "Balinese", start: 0x1b00, end: 0x1b7f },
  { name: "Sundanese", start: 0x1b80, end: 0x1bbf },
  { name: "Batak", start: 0x1bc0, end: 0x1bff },
  { name: "Lepcha", start: 0x1c00, end: 0x1c4f },
  { name: "Ol_Chiki", start: 0x1c50, end: 0x1c7f },
  { name: "Cyrillic_Extended_C", start: 0x1c80, end: 0x1c8f },
  { name: "Georgian_Extended", start: 0x1c90, end: 0x1cbf },
  { name: "Vedic_Extensions", start: 0x1cd0, end: 0x1cff },
  { name: "Phonetic_Extensions", start: 0x1d00, end: 0x1d7f },
  { name: "Phonetic_Extensions_Sup", start: 0x1d80, end: 0x1dbf },
  { name: "Combining_Diacritics_Sup", start: 0x1dc0, end: 0x1dff },
  { name: "Latin_Extended_Additional", start: 0x1e00, end: 0x1eff },
  { name: "Greek_Extended", start: 0x1f00, end: 0x1fff },
  { name: "General_Punctuation", start: 0x2000, end: 0x206f },
  { name: "Superscripts_Subscripts", start: 0x2070, end: 0x209f },
  { name: "Currency_Symbols", start: 0x20a0, end: 0x20cf },
  { name: "Combining_Diacritics_Sym", start: 0x20d0, end: 0x20ff },
  { name: "Letterlike_Symbols", start: 0x2100, end: 0x214f },
  { name: "Number_Forms", start: 0x2150, end: 0x218f },
  { name: "Arrows", start: 0x2190, end: 0x21ff },
  { name: "Mathematical_Operators", start: 0x2200, end: 0x22ff },
  { name: "Misc_Technical", start: 0x2300, end: 0x23ff },
  { name: "Control_Pictures", start: 0x2400, end: 0x243f },
  { name: "OCR", start: 0x2440, end: 0x245f },
  { name: "Enclosed_Alphanumerics", start: 0x2460, end: 0x24ff },
  { name: "Box_Drawing", start: 0x2500, end: 0x257f },
  { name: "Block_Elements", start: 0x2580, end: 0x259f },
  { name: "Geometric_Shapes", start: 0x25a0, end: 0x25ff },
  { name: "Misc_Symbols", start: 0x2600, end: 0x26ff },
  { name: "Dingbats", start: 0x2700, end: 0x27bf },
  { name: "Misc_Math_Symbols_A", start: 0x27c0, end: 0x27ef },
  { name: "Supplemental_Arrows_A", start: 0x27f0, end: 0x27ff },
  { name: "Braille_Patterns", start: 0x2800, end: 0x28ff },
  { name: "Supplemental_Arrows_B", start: 0x2900, end: 0x297f },
  { name: "Misc_Math_Symbols_B", start: 0x2980, end: 0x29ff },
  { name: "Supplemental_Math_Op", start: 0x2a00, end: 0x2aff },
  { name: "Misc_Symbols_Arrows", start: 0x2b00, end: 0x2bff },
  { name: "Glagolitic", start: 0x2c00, end: 0x2c5f },
  { name: "Latin_Extended_C", start: 0x2c60, end: 0x2c7f },
  { name: "Coptic", start: 0x2c80, end: 0x2cff },
  { name: "Georgian_Supplement", start: 0x2d00, end: 0x2d2f },
  { name: "Tifinagh", start: 0x2d30, end: 0x2d7f },
  { name: "Ethiopic_Extended", start: 0x2d80, end: 0x2ddf },
  { name: "Cyrillic_Extended_A", start: 0x2de0, end: 0x2dff },
  { name: "Supplemental_Punctuation", start: 0x2e00, end: 0x2e7f },
  { name: "CJK_Radicals_Sup", start: 0x2e80, end: 0x2eff },
  { name: "Kangxi_Radicals", start: 0x2f00, end: 0x2fdf },
  { name: "Ideographic_Description", start: 0x2ff0, end: 0x2fff },
  { name: "CJK_Symbols_Punctuation", start: 0x3000, end: 0x303f },
  { name: "Hiragana", start: 0x3040, end: 0x309f },
  { name: "Katakana", start: 0x30a0, end: 0x30ff },
  { name: "Bopomofo", start: 0x3100, end: 0x312f },
  { name: "Hangul_Compatibility", start: 0x3130, end: 0x318f },
  { name: "Kanbun", start: 0x3190, end: 0x319f },
  { name: "Bopomofo_Extended", start: 0x31a0, end: 0x31bf },
  { name: "CJK_Strokes", start: 0x31c0, end: 0x31ef },
  { name: "Katakana_Phonetic", start: 0x31f0, end: 0x31ff },
  { name: "Enclosed_CJK", start: 0x3200, end: 0x32ff },
  { name: "CJK_Compatibility", start: 0x3300, end: 0x33ff },
  { name: "CJK_Extension_A", start: 0x3400, end: 0x4dbf },
  { name: "Yijing_Hexagrams", start: 0x4dc0, end: 0x4dff },
  { name: "CJK_Unified", start: 0x4e00, end: 0x9fff },
  { name: "Yi_Syllables", start: 0xa000, end: 0xa48f },
  { name: "Yi_Radicals", start: 0xa490, end: 0xa4cf },
  { name: "Lisu", start: 0xa4d0, end: 0xa4ff },
  { name: "Vai", start: 0xa500, end: 0xa63f },
  { name: "Cyrillic_Extended_B", start: 0xa640, end: 0xa69f },
  { name: "Bamum", start: 0xa6a0, end: 0xa6ff },
  { name: "Modifier_Tone_Letters", start: 0xa700, end: 0xa71f },
  { name: "Latin_Extended_D", start: 0xa720, end: 0xa7ff },
  { name: "Syloti_Nagri", start: 0xa800, end: 0xa82f },
  { name: "Indic_Number_Forms", start: 0xa830, end: 0xa83f },
  { name: "Phags_pa", start: 0xa840, end: 0xa87f },
  { name: "Saurashtra", start: 0xa880, end: 0xa8df },
  { name: "Devanagari_Extended", start: 0xa8e0, end: 0xa8ff },
  { name: "Kayah_Li", start: 0xa900, end: 0xa92f },
  { name: "Rejang", start: 0xa930, end: 0xa95f },
  { name: "Hangul_Jamo_Extended_A", start: 0xa960, end: 0xa97f },
  { name: "Javanese", start: 0xa980, end: 0xa9df },
  { name: "Myanmar_Extended_B", start: 0xa9e0, end: 0xa9ff },
  { name: "Cham", start: 0xaa00, end: 0xaa5f },
  { name: "Myanmar_Extended_A", start: 0xaa60, end: 0xaa7f },
  { name: "Tai_Viet", start: 0xaa80, end: 0xaadf },
  { name: "Meetei_Mayek_Ext", start: 0xaae0, end: 0xaaff },
  { name: "Ethiopic_Extended_A", start: 0xab00, end: 0xab2f },
  { name: "Latin_Extended_E", start: 0xab30, end: 0xab6f },
  { name: "Cherokee_Supplement", start: 0xab70, end: 0xabbf },
  { name: "Meetei_Mayek", start: 0xabc0, end: 0xabff },
  { name: "Hangul_Syllables", start: 0xac00, end: 0xd7af },
  { name: "Hangul_Jamo_Extended_B", start: 0xd7b0, end: 0xd7ff },
  { name: "Private_Use_Area", start: 0xe000, end: 0xf8ff },
  { name: "CJK_Compatibility_Ideographs", start: 0xf900, end: 0xfaff },
  { name: "Alphabetic_Presentation_Forms", start: 0xfb00, end: 0xfb4f },
  { name: "Arabic_Presentation_Forms_A", start: 0xfb50, end: 0xfdff },
  { name: "Variation_Selectors", start: 0xfe00, end: 0xfe0f },
  { name: "Vertical_Forms", start: 0xfe10, end: 0xfe1f },
  { name: "Combining_Half_Marks", start: 0xfe20, end: 0xfe2f },
  { name: "CJK_Compatibility_Forms", start: 0xfe30, end: 0xfe4f },
  { name: "Small_Form_Variants", start: 0xfe50, end: 0xfe6f },
  { name: "Arabic_Presentation_Forms_B", start: 0xfe70, end: 0xfeff },
  { name: "Halfwidth_Fullwidth", start: 0xff00, end: 0xffef },
  { name: "Specials", start: 0xfff0, end: 0xffff },
];

// Main worker handler
self.onmessage = async (e: MessageEvent<WorkerRequest>): Promise<void> => {
  const { type, id, firmware } = e.data;

  try {
    switch (type) {
      case "analyze": {
        firmwareData = firmware;

        // Detect SMALL_BASE
        const config_78 = readU16LE(firmware, 0x78);
        const config_7a = readU16LE(firmware, 0x7a);
        SMALL_BASE = (config_7a << 16) | config_78;

        // Detect LARGE_BASE using full window-scoring algorithm
        self.postMessage({
          type: "progress",
          id,
          message: "Searching for font data...",
        });

        const largeBase = searchOffsetTable(firmware);
        if (largeBase === null) {
          self.postMessage({
            type: "error",
            id,
            error: "Could not find valid LARGE_BASE",
          });
          return;
        }
        LARGE_BASE = largeBase;

        self.postMessage({ type: "success", id, result: [] });
        break;
      }

      case "listPlanes": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const planes: FontPlaneInfo[] = [];

        for (const { name, start, end } of UNICODE_RANGES) {
          let smallCount = 0;
          let largeCount = 0;

          // Count SMALL fonts
          for (let uni = start; uni <= Math.min(end, 0xffff); uni++) {
            const addr = SMALL_BASE + uni * SMALL_STRIDE;
            if (addr + SMALL_STRIDE > firmwareData.length) continue;

            const chunk = firmwareData.slice(addr, addr + SMALL_STRIDE);
            if (isDataEmpty(chunk)) continue;

            try {
              const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
              const pixels = decodeV8(chunk, lookupVal);
              if (pixels.length === 16 && isValidFontData(pixels, "SMALL")) {
                smallCount++;
              }
            } catch {
              continue;
            }
          }

          // Count LARGE fonts for all ranges (not just CJK)
          for (let uni = start; uni <= end; uni++) {
            const addr = LARGE_BASE + (uni - 0x4e00) * LARGE_STRIDE;
            if (addr + LARGE_STRIDE > firmwareData.length) continue;

            const chunk = firmwareData.slice(addr, addr + LARGE_STRIDE);
            if (isDataEmpty(chunk)) continue;

            try {
              const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
              const pixels = decodeV8(chunk, lookupVal);
              if (pixels.length === 16 && isValidFontData(pixels, "LARGE")) {
                largeCount++;
              }
            } catch {
              continue;
            }
          }

          planes.push({
            name,
            start,
            end,
            smallCount,
            largeCount,
            estimatedCount: smallCount + largeCount,
          });
        }

        self.postMessage({ type: "success", id, result: planes });
        break;
      }

      case "listImages": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const images = buildBitmapListFromMetadata(firmwareData, true);
        self.postMessage({ type: "success", id, result: images });
        break;
      }

      case "extractPlane": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const {
          planeName,
          start,
          end,
          fontType = "SMALL",
        } = e.data as WorkerRequest & {
          planeName: string;
          start: number;
          end: number;
          fontType: "SMALL" | "LARGE";
        };

        self.postMessage({
          type: "progress",
          id,
          message: `Extracting plane: ${planeName} (${fontType})...`,
        });

        const fonts: PlaneData["fonts"] = [];

        if (fontType === "SMALL") {
          // Extract SMALL fonts only
          for (let uni = start; uni <= Math.min(end, 0xffff); uni++) {
            const addr = SMALL_BASE + uni * SMALL_STRIDE;
            if (addr + SMALL_STRIDE > firmwareData.length) continue;

            const chunk = firmwareData.slice(addr, addr + SMALL_STRIDE);
            if (isDataEmpty(chunk)) continue;

            try {
              const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
              const pixels = decodeV8(chunk, lookupVal);
              if (pixels.length === 16 && isValidFontData(pixels, "SMALL")) {
                // Slice to SMALL_FONT_SIZE x SMALL_FONT_SIZE for SMALL fonts
                fonts.push({
                  unicode: uni,
                  fontType: "SMALL",
                  pixels: sliceSmallFontPixels(pixels),
                });
              }
            } catch {
              continue;
            }
          }
        } else {
          // Extract LARGE fonts only
          for (let uni = start; uni <= end; uni++) {
            const addr = LARGE_BASE + (uni - 0x4e00) * LARGE_STRIDE;
            if (addr + LARGE_STRIDE > firmwareData.length) continue;

            const chunk = firmwareData.slice(addr, addr + LARGE_STRIDE);
            if (isDataEmpty(chunk)) continue;

            try {
              const lookupVal = firmwareData[LOOKUP_TABLE + (uni >> 3)];
              const pixels = decodeV8(chunk, lookupVal);
              if (pixels.length === 16 && isValidFontData(pixels, "LARGE")) {
                fonts.push({ unicode: uni, fontType: "LARGE", pixels });
              }
            } catch {
              continue;
            }
          }
        }

        self.postMessage({
          type: "success",
          id,
          result: { name: planeName, start, end, fonts } as PlaneData,
        });
        break;
      }

      case "extractImage": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const { imageName, width, height, offset } = e.data as WorkerRequest & {
          imageName: string;
          width: number;
          height: number;
          offset: number;
        };

        // Get Part 5 data (offset is relative to Part 5)
        const part5Offset = readU32LE(firmwareData, 0x14c);
        const part5Size = readU32LE(firmwareData, 0x150);
        const part5Data = firmwareData.slice(
          part5Offset,
          part5Offset + part5Size,
        );

        const rawSize = width * height * 2;
        // Firmware stores RGB565 in big-endian format (hardware requirement)
        const rgb565Data = part5Data.slice(offset, offset + rawSize);

        self.postMessage({
          type: "success",
          id,
          result: {
            name: imageName,
            width,
            height,
            rgb565Data,
          } as ImageData,
        });
        break;
      }

      case "replaceImage": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const { imageName, width, height, offset, rgb565Data } =
          e.data as WorkerRequest & {
            imageName: string;
            width: number;
            height: number;
            offset: number;
            rgb565Data: Uint8Array;
          };

        // Report progress
        self.postMessage({
          type: "progress",
          id,
          message: `Replacing ${imageName}...`,
        });

        // Validate dimensions
        if (!validateBitmapData(rgb565Data, width, height)) {
          self.postMessage({
            type: "error",
            id,
            error: "Invalid bitmap data dimensions",
          });
          return;
        }

        // Get Part 5 info
        const part5Offset = readU32LE(firmwareData, 0x14c);
        const part5Size = readU32LE(firmwareData, 0x150);

        // Calculate actual offset in firmware (Part 5 offset + offset within Part 5)
        const actualOffset = part5Offset + offset;
        const rawSize = width * height * 2;

        // Validate bounds (both within firmware and within Part 5)
        if (offset + rawSize > part5Size) {
          self.postMessage({
            type: "error",
            id,
            error: "Replacement data exceeds Part 5 bounds",
          });
          return;
        }

        if (actualOffset + rawSize > firmwareData.length) {
          self.postMessage({
            type: "error",
            id,
            error: "Replacement data exceeds firmware bounds",
          });
          return;
        }

        // Write data to firmware (modifies cached firmware)
        firmwareData.set(rgb565Data, actualOffset);

        // Verify by reading back
        self.postMessage({
          type: "progress",
          id,
          message: `Verifying ${imageName}...`,
        });
        const writtenData = firmwareData.slice(
          actualOffset,
          actualOffset + rawSize,
        );

        // Compare byte-by-byte
        let verified = true;
        for (let i = 0; i < rawSize; i++) {
          if (writtenData[i] !== rgb565Data[i]) {
            verified = false;
            break;
          }
        }

        if (!verified) {
          self.postMessage({
            type: "error",
            id,
            error: "Verification failed: written data does not match original",
          });
          return;
        }

        self.postMessage({
          type: "success",
          id,
          result: {
            success: true,
            imageName: imageName,
            rgb565Data,
          } as ReplaceImageResult,
        });
        break;
      }

      case "replaceImages": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const { images } = e.data as WorkerRequest & {
          images: Array<{
            imageName: string;
            width: number;
            height: number;
            offset: number;
            rgb565Data: Uint8Array;
          }>;
        };

        if (!images || images.length === 0) {
          self.postMessage({
            type: "error",
            id,
            error: "No images to replace",
          });
          return;
        }

        const results: Array<{ imageName: string; rgb565Data: Uint8Array }> =
          [];
        const notFound: string[] = [];
        const dimensionMismatch: string[] = [];
        const replaceError: string[] = [];
        let successCount = 0;

        // Get Part 5 info once
        const part5Offset = readU32LE(firmwareData, 0x14c);
        const part5Size = readU32LE(firmwareData, 0x150);

        // Process each image sequentially
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          const { imageName, width, height, offset, rgb565Data } = img;

          self.postMessage({
            type: "progress",
            id,
            message: `Replacing ${i + 1}/${images.length}: ${imageName}...`,
          });

          // Validate dimensions
          if (!validateBitmapData(rgb565Data, width, height)) {
            dimensionMismatch.push(`${imageName}: Invalid dimensions`);
            continue;
          }

          // Calculate actual offset in firmware
          const actualOffset = part5Offset + offset;
          const rawSize = width * height * 2;

          // Validate bounds
          if (offset + rawSize > part5Size) {
            replaceError.push(`${imageName}: Exceeds Part 5 bounds`);
            continue;
          }

          if (actualOffset + rawSize > firmwareData.length) {
            replaceError.push(`${imageName}: Exceeds firmware bounds`);
            continue;
          }

          // Write data to firmware
          firmwareData.set(rgb565Data, actualOffset);

          // Verify by reading back
          const writtenData = firmwareData.slice(
            actualOffset,
            actualOffset + rawSize,
          );
          let verified = true;
          for (let j = 0; j < rawSize; j++) {
            if (writtenData[j] !== rgb565Data[j]) {
              verified = false;
              break;
            }
          }

          if (!verified) {
            replaceError.push(`${imageName}: Verification failed`);
            continue;
          }

          results.push({ imageName, rgb565Data });
          successCount++;
        }

        self.postMessage({
          type: "success",
          id,
          result: {
            successCount,
            notFound,
            dimensionMismatch,
            replaceError,
            results,
          } as ReplaceImagesResult,
        });
        break;
      }

      case "getFirmware": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        // Return the modified firmware data
        self.postMessage({
          type: "success",
          id,
          result: firmwareData,
        });
        break;
      }

      case "bundleImagesAsZip": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        self.postMessage({
          type: "progress",
          id,
          message: "Collecting image list...",
        });

        // Extract Part 5 data for later use in ZIP processing
        const part5Offset = readU32LE(firmwareData, 0x14c);
        const part5Size = readU32LE(firmwareData, 0x150);
        const part5Data = firmwareData.slice(
          part5Offset,
          part5Offset + part5Size,
        );

        // Build image list using shared function
        const images = buildBitmapListFromMetadata(firmwareData, true);

        if (images.length === 0) {
          self.postMessage({
            type: "error",
            id,
            error: "No images found in firmware",
          });
          return;
        }

        self.postMessage({
          type: "progress",
          id,
          message: `Found ${images.length} images. Creating ZIP archive...`,
        });

        // Create ZIP file
        const zip = new JSZip();

        // Process each image
        for (let i = 0; i < images.length; i++) {
          const img = images[i];

          // Update progress periodically
          if (i % 10 === 0 || i === images.length - 1) {
            self.postMessage({
              type: "progress",
              id,
              message: `Adding image ${i + 1}/${images.length}: ${img.name}...`,
            });
          }

          // Extract RGB565 data from Part 5
          const rawSize = img.width * img.height * 2;
          const rawRgb565 = part5Data.slice(img.offset!, img.offset! + rawSize);

          // Convert to BMP
          const bmpData = convertToBmp(rawRgb565, img.width, img.height);

          if (!bmpData) {
            console.warn(`Failed to convert ${img.name} to BMP`);
            continue;
          }

          // Add to ZIP with .bmp extension
          zip.file(`${img.name}.bmp`, bmpData);
        }

        self.postMessage({
          type: "progress",
          id,
          message: "Generating ZIP file...",
        });

        // Generate ZIP blob as ArrayBuffer
        const zipBlob = await zip.generateAsync({ type: "arraybuffer" });

        self.postMessage({
          type: "success",
          id,
          result: new Uint8Array(zipBlob),
        });
        break;
      }

      case "replaceFonts": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const { fontType = "SMALL", fontReplacements } =
          e.data as WorkerRequest & {
            fontType: "SMALL" | "LARGE";
            fontReplacements: Array<{
              unicode: number;
              pixels: boolean[][];
            }>;
          };

        if (!fontReplacements || fontReplacements.length === 0) {
          self.postMessage({
            type: "error",
            id,
            error: "No font replacements provided",
          });
          return;
        }

        self.postMessage({
          type: "progress",
          id,
          message: `Starting font replacement for ${fontReplacements.length} characters...`,
        });

        const replacedCharacters: number[] = [];
        const skippedCharacters: number[] = [];
        const skippedReasons = new Map<number, string>();
        const errors: string[] = [];
        let successCount = 0;

        // Determine expected pixel size based on font type
        const expectedSize = fontType === "SMALL" ? 12 : 16;

        // Process each character replacement
        for (let i = 0; i < fontReplacements.length; i++) {
          const { unicode, pixels } = fontReplacements[i];

          // Report progress periodically
          if (i % 10 === 0 || i === fontReplacements.length - 1) {
            self.postMessage({
              type: "progress",
              id,
              message: `Processing U+${unicode.toString(16).toUpperCase().padStart(4, "0")} (${i + 1}/${fontReplacements.length})...`,
            });
          }

          // Validate pixel data dimensions
          if (pixels.length !== expectedSize) {
            errors.push(
              `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: Invalid pixel data height (got ${pixels.length}, expected ${expectedSize})`,
            );
            skippedCharacters.push(unicode);
            skippedReasons.set(unicode, "invalid_pixel_data");
            continue;
          }

          for (let row = 0; row < pixels.length; row++) {
            if (pixels[row].length !== expectedSize) {
              errors.push(
                `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: Invalid pixel data width at row ${row} (got ${pixels[row].length}, expected ${expectedSize})`,
              );
              skippedCharacters.push(unicode);
              skippedReasons.set(unicode, "invalid_pixel_data");
              continue;
            }
          }

          // Calculate firmware address based on font type
          let addr: number;
          let chunkSize: number;

          if (fontType === "SMALL") {
            // SMALL fonts use direct addressing from SMALL_BASE
            if (unicode > 0xffff) {
              skippedCharacters.push(unicode);
              skippedReasons.set(unicode, "not_in_firmware");
              continue;
            }
            addr = SMALL_BASE + unicode * SMALL_STRIDE;
            chunkSize = SMALL_STRIDE;
          } else {
            // LARGE fonts use offset addressing from LARGE_BASE (CJK range 0x4e00-0x9fff)
            if (unicode < 0x4e00 || unicode > 0x9fff) {
              skippedCharacters.push(unicode);
              skippedReasons.set(unicode, "not_in_firmware");
              continue;
            }
            addr = LARGE_BASE + (unicode - 0x4e00) * LARGE_STRIDE;
            chunkSize = LARGE_STRIDE;
          }

          // Check if address is valid
          if (addr + chunkSize > firmwareData.length) {
            skippedCharacters.push(unicode);
            skippedReasons.set(unicode, "not_in_firmware");
            continue;
          }

          // Get lookup value for encoding
          const lookupVal = firmwareData[LOOKUP_TABLE + (unicode >> 3)];

          // Prepare pixel data for encoding
          let pixelsToEncode: PixelData;
          if (fontType === "SMALL") {
            // Pad SMALL font pixels from 12x12 to 16x16 for encoding
            pixelsToEncode = padSmallFontPixels(pixels as PixelData);
          } else {
            pixelsToEncode = pixels as PixelData;
          }

          try {
            // Encode pixels to firmware format
            const encodedChunk = encodeV8(pixelsToEncode, lookupVal);

            // For LARGE fonts, add the footer byte
            const chunkToWrite =
              fontType === "LARGE"
                ? new Uint8Array(LARGE_STRIDE)
                : new Uint8Array(SMALL_STRIDE);

            chunkToWrite.set(encodedChunk);

            if (fontType === "LARGE") {
              // Copy existing footer byte from original data
              const originalData = firmwareData.slice(
                addr,
                addr + LARGE_STRIDE,
              );
              chunkToWrite[LARGE_STRIDE - 1] = originalData[LARGE_STRIDE - 1];
            }

            // Write encoded data to firmware
            firmwareData.set(chunkToWrite, addr);

            // Verify by reading back
            const writtenData = firmwareData.slice(addr, addr + chunkSize);
            let verified = true;

            for (let j = 0; j < chunkSize; j++) {
              if (writtenData[j] !== chunkToWrite[j]) {
                verified = false;
                break;
              }
            }

            if (!verified) {
              self.postMessage({
                type: "error",
                id,
                error: `Verification failed for U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: written data does not match original`,
              });
              return;
            }

            // Success
            replacedCharacters.push(unicode);
            successCount++;
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            errors.push(
              `U+${unicode.toString(16).toUpperCase().padStart(4, "0")}: ${errorMsg}`,
            );
            skippedCharacters.push(unicode);
            skippedReasons.set(unicode, "encoding_error");
          }
        }

        self.postMessage({
          type: "success",
          id,
          result: {
            successCount,
            skippedCount: skippedCharacters.length,
            errors,
            replacedCharacters,
            skippedCharacters,
            skippedReasons,
            fontType,
          } as ReplaceFontsResult,
        });
        break;
      }

      case "replaceFontsStreamStart": {
        if (!firmwareData) {
          self.postMessage({
            type: "error",
            id,
            error: "Firmware not analyzed. Call analyze first.",
          });
          return;
        }

        const { fontType = "SMALL", totalCharacters = 0 } =
          e.data as WorkerRequest & {
            fontType: "SMALL" | "LARGE";
            totalCharacters: number;
          };

        // Initialize streaming state
        streamState = {
          id,
          fontType,
          totalCharacters,
          receivedCharacters: 0,
          processedCharacters: 0,
          queue: [],
          results: {
            replacedCharacters: [],
            skippedCharacters: [],
            skippedReasons: new Map(),
            errors: [],
            successCount: 0,
          },
          isProcessing: false,
          isFinished: false,
          lastSentReady: false,
        };

        self.postMessage({
          type: "progress",
          id,
          message: `Streaming font replacement initialized for ${fontType} fonts...`,
        });
        break;
      }

      case "replaceFontsStreamAdd": {
        if (!streamState) {
          self.postMessage({
            type: "error",
            id,
            error:
              "Stream not initialized. Call replaceFontsStreamStart first.",
          });
          return;
        }

        const { character } = e.data as WorkerRequest & {
          character: {
            unicode: number;
            pixels: boolean[][];
          };
        };

        if (!character) {
          self.postMessage({
            type: "error",
            id,
            error: "No character data provided",
          });
          return;
        }

        // Add character to queue
        streamState.queue.push(character);
        streamState.receivedCharacters++;

        // Only send progress update every 50 characters to reduce message storm
        if (streamState.receivedCharacters % 50 === 0) {
          self.postMessage({
            type: "progress",
            id: streamState.id,
            message: `Received character ${streamState.receivedCharacters}/${streamState.totalCharacters}...`,
            queueDepth: streamState.queue.length,
            queueCapacity: MAX_QUEUE_SIZE,
          });
        }

        // If queue is full, reset the ready flag so we'll send it again when there's space
        // If queue was full but now has space (items were processed), send ready signal
        if (streamState.queue.length >= MAX_QUEUE_SIZE) {
          streamState.lastSentReady = false;
        } else if (
          streamState.queue.length < QUEUE_READY_THRESHOLD &&
          !streamState.lastSentReady &&
          streamState.isProcessing
        ) {
          self.postMessage({
            type: "queueReady",
            id: streamState.id,
          });
          streamState.lastSentReady = true;
        }

        // Start processing queue if not already processing
        // Use setTimeout to avoid race condition with isProcessing flag
        if (!streamState.isProcessing && streamState.queue.length > 0) {
          // Use setTimeout to break out of the message handler and allow isProcessing to be set
          setTimeout(() => {
            if (!streamState!.isProcessing && streamState!.queue.length > 0) {
              processStreamQueue().catch((err) => {
                console.error("[worker] Queue processing error:", err);
              });
            }
          }, 0);
        }
        break;
      }

      case "replaceFontsStreamFinish": {
        if (!streamState) {
          self.postMessage({
            type: "error",
            id,
            error:
              "Stream not initialized. Call replaceFontsStreamStart first.",
          });
          return;
        }

        // Mark as finished
        streamState.isFinished = true;

        // Wait for queue to drain and send final result
        await waitForStreamCompletion();

        // Send final success message
        self.postMessage({
          type: "success",
          id: streamState.id,
          result: {
            successCount: streamState.results.successCount,
            skippedCount: streamState.results.skippedCharacters.length,
            errors: streamState.results.errors,
            replacedCharacters: streamState.results.replacedCharacters,
            skippedCharacters: streamState.results.skippedCharacters,
            skippedReasons: streamState.results.skippedReasons,
            fontType: streamState.fontType,
          } as ReplaceFontsResult,
        });

        // Clean up state
        streamState = null;
        break;
      }

      // =========================================================================
      // Analyze Fonts - Run tofu detection and return debug data
      // =========================================================================

      case "analyzeFonts": {
        const {
          fontData,
          fontFamily,
          fontSize = 12,
          codePoints = [],
        } = e.data as WorkerRequest & {
          fontData?: ArrayBuffer;
          fontFamily?: string;
          fontSize?: 12 | 16;
          codePoints?: number[];
        };

        if (!fontData || !fontFamily || codePoints.length === 0) {
          self.postMessage({
            type: "error",
            id,
            error: "Missing required parameters for analyzeFonts",
          });
          return;
        }

        try {
          console.log("[analyzeFonts] Starting analysis:", { fontFamily, fontSize, codePointsCount: codePoints.length });

          // Load fonts into worker's font set
          const userFontFace = new FontFace(fontFamily, fontData);
          await userFontFace.load();
          // @ts-ignore - fonts API exists in workers
          self.fonts.add(userFontFace);
          console.log("[analyzeFonts] User font loaded:", fontFamily);

          // ALWAYS load tofu font for fallback rendering (needed when user font has missing glyphs)
          // Fetch tofu font from server
          // @ts-ignore - fonts API exists in workers
          let tofuFontFace: FontFace | null = null;

          const tofuResponse = await fetch("/AND-Regular.ttf");
          if (!tofuResponse.ok) {
            throw new Error(`Failed to fetch tofu font: ${tofuResponse.statusText}`);
          }
          const tofuBuffer = await tofuResponse.arrayBuffer();
          tofuFontFace = new FontFace("Adobe-NotDef", tofuBuffer);
          await tofuFontFace.load();
          // @ts-ignore - fonts API exists in workers
          self.fonts.add(tofuFontFace);

          // IMPORTANT: Wait for ALL fonts to be fully ready before rendering
          // Without this, Firefox worker may not render fonts properly
          // @ts-ignore - fonts API exists in workers
          await self.fonts.ready;
          console.log("[analyzeFonts] All fonts ready");

          // Constants
          const TOFU_SCALE = 4;
          const TOFU_PADDING = 10;
          const canvasSize = fontSize * TOFU_SCALE + TOFU_PADDING * 2;

          console.log("[analyzeFonts] Creating canvas:", { canvasSize, fontSize, TOFU_SCALE, TOFU_PADDING });

          // Canvas for rendering
          const canvas = new OffscreenCanvas(canvasSize, canvasSize);
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) {
            throw new Error("Failed to get canvas context");
          }

          console.log("[analyzeFonts] Canvas created");

          // Helper: Get tofu signature for this font size
          async function getTofuSignature(): Promise<boolean[][]> {
            console.log("[analyzeFonts] Generating tofu signature for size:", fontSize);
            ctx!.fillStyle = "#ffffff";
            ctx!.fillRect(0, 0, canvas.width, canvas.height);
            ctx!.font = `${fontSize * TOFU_SCALE}px Adobe-NotDef`;
            ctx!.textBaseline = "top";
            ctx!.textAlign = "left";
            ctx!.imageSmoothingEnabled = false;
            ctx!.textRendering = "geometricPrecision";
            ctx!.fillStyle = "#000000"; // Ensure black text
            ctx!.fillText("\uFFFD", TOFU_PADDING, TOFU_PADDING);

            const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageDataToPixels(imageData, 128);

            const patternSize = fontSize * TOFU_SCALE;
            const pattern: boolean[][] = [];
            let blackPixels = 0;
            for (let y = TOFU_PADDING; y < TOFU_PADDING + patternSize; y++) {
              const row: boolean[] = [];
              for (let x = TOFU_PADDING; x < TOFU_PADDING + patternSize; x++) {
                const p = pixels[y]?.[x] ?? false;
                if (p) blackPixels++;
                row.push(p);
              }
              pattern.push(row);
            }
            console.log("[analyzeFonts] Tofu signature generated, black pixels:", blackPixels);
            return pattern;
          }

          // Generate tofu signature internally
          const tofuSigForWorker = await getTofuSignature();

          // Helper: Analyze a single character and return TofuDebugData-compatible format
          async function analyzeCharacter(char: string, codePoint: number): Promise<{
            codePoint: number;
            char: string;
            fontSize: number;
            renderedPixels: boolean[][];
            tofuPixels: boolean[][];
            match: boolean;
            matchPercentage: number;
            boundingBox1: { x: number; y: number; width: number; height: number };
            boundingBox2: { x: number; y: number; width: number; height: number };
          }> {
            // Clear canvas
            ctx!.fillStyle = "#ffffff";
            ctx!.fillRect(0, 0, canvas.width, canvas.height);

            // Render user font with tofu fallback
            ctx!.font = `${fontSize * TOFU_SCALE}px ${fontFamily}, Adobe-NotDef`;
            ctx!.textBaseline = "top";
            ctx!.textAlign = "left";
            ctx!.imageSmoothingEnabled = false;
            ctx!.textRendering = "geometricPrecision";
            ctx!.fillStyle = "#000000"; // Ensure black text
            ctx!.fillText(char, TOFU_PADDING, TOFU_PADDING);

            const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageDataToPixels(imageData, 128);

            // Get tofu signature
            const tofuPattern = tofuSigForWorker;

            // Pattern matching - find best match position and ratio
            const patternSize = fontSize * TOFU_SCALE;
            let bestMatchRatio = 0;
            let bestStartY = 0, bestStartX = 0;

            for (let startY = 0; startY <= canvasSize - patternSize; startY++) {
              for (let startX = 0; startX <= canvasSize - patternSize; startX++) {
                let matches = 0;
                let total = 0;
                for (let py = 0; py < patternSize; py++) {
                  for (let px = 0; px < patternSize; px++) {
                    if (pixels[startY + py]?.[startX + px] === tofuPattern[py]?.[px]) {
                      matches++;
                    }
                    total++;
                  }
                }
                const ratio = matches / total;
                if (ratio > bestMatchRatio) {
                  bestMatchRatio = ratio;
                  bestStartY = startY;
                  bestStartX = startX;
                }
              }
            }

            // Count tofu black pixels
            let tofuBlackCount = 0;
            for (const row of tofuPattern) {
              for (const p of row) {
                if (p) tofuBlackCount++;
              }
            }

            // Count rendered char black pixels
            let charBlackCount = 0;
            for (let y = 0; y < canvasSize; y++) {
              for (let x = 0; x < canvasSize; x++) {
                if (pixels[y]?.[x]) charBlackCount++;
              }
            }

            // Check if tofu
            const blackPixelRatio = tofuBlackCount > 0 ? charBlackCount / tofuBlackCount : 0;
            const isTofu = bestMatchRatio >= 0.98 && blackPixelRatio > 0.5;

            // Extract rendered pixels (center crop like tofu pattern)
            const renderedPattern: boolean[][] = [];
            for (let y = TOFU_PADDING; y < TOFU_PADDING + patternSize; y++) {
              const row: boolean[] = [];
              for (let x = TOFU_PADDING; x < TOFU_PADDING + patternSize; x++) {
                row.push(pixels[y]?.[x] ?? false);
              }
              renderedPattern.push(row);
            }

            return {
              codePoint,
              char,
              fontSize,
              renderedPixels: renderedPattern,
              tofuPixels: tofuPattern,
              match: isTofu,
              matchPercentage: bestMatchRatio * 100,
              // Bounding boxes for debug display
              boundingBox1: { x: bestStartX, y: bestStartY, width: patternSize, height: patternSize },
              boundingBox2: { x: 0, y: 0, width: 0, height: 0 }, // Not needed in worker
            };
          }

          // Analyze all characters
          type AnalysisResult = {
            codePoint: number;
            char: string;
            fontSize: number;
            renderedPixels: boolean[][];
            tofuPixels: boolean[][];
            match: boolean;
            matchPercentage: number;
            boundingBox1: { x: number; y: number; width: number; height: number };
            boundingBox2: { x: number; y: number; width: number; height: number };
          };
          const results: AnalysisResult[] = [];
          console.log("[analyzeFonts] Starting loop, codePoints:", codePoints.length);

          for (let i = 0; i < codePoints.length; i++) {
            const codePoint = codePoints[i];
            const char = String.fromCodePoint(codePoint);

            // Progress
            if (i % 50 === 0) {
              self.postMessage({
                type: "progress",
                id,
                message: `Analyzing character ${i + 1}/${codePoints.length}`,
                progress: Math.round((i / codePoints.length) * 100),
              });
            }

            console.log("[analyzeFonts] Analyzing:", i, codePoint, char);
            const result = await analyzeCharacter(char, codePoint);
            results.push(result);

            // Yield periodically
            if (i % 50 === 0) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          console.log("[analyzeFonts] Loop complete, results:", results.length);

          // Clean up fonts
          // @ts-ignore - fonts API exists in workers
          self.fonts.delete(userFontFace);
          // Only delete tofu font if it was loaded in worker
          if (tofuFontFace) {
            // @ts-ignore - fonts API exists in workers
            self.fonts.delete(tofuFontFace);
          }

          console.log("[analyzeFonts] Analysis complete:", {
            total: results.length,
            tofuCount: results.filter((r: AnalysisResult) => r.match).length,
          });

          // Convert to TofuDebugData format for main thread
          const debugData = results.map((r) => ({
            codePoint: r.codePoint,
            char: r.char,
            fontSize: r.fontSize,
            renderedPixels: r.renderedPixels,
            tofuPixels: r.tofuPixels,
            match: r.match,
            matchPercentage: r.matchPercentage,
            tofuPixelCount: r.tofuPixels.flat().filter(Boolean).length,
            charPixelCount: r.renderedPixels.flat().filter(Boolean).length,
            boundingBox1: r.boundingBox1,
            boundingBox2: r.boundingBox2,
          }));

          console.log("[analyzeFonts] Sending success:", {
            debugDataCount: debugData.length,
            firstMatch: debugData.find(d => d.match),
          });

          self.postMessage({
            type: "success",
            id,
            result: {
              success: true,
              debugData,
              tofuSignature: tofuSigForWorker?.map((row) => row.map((p) => (p ? 1 : 0))) || [],
              tofuPixelCount: tofuSigForWorker?.flat().filter(Boolean).length || 0,
            },
          });
        } catch (error) {
          console.error("[analyzeFonts] Error:", error);
          self.postMessage({
            type: "error",
            id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        break;
      }

      // Note: Tofu detection is now handled by tofu-detector.ts on main thread
      // This avoids Firefox worker issues with FontFace rendering

      // =========================================================================
      // Complete Font Replacement in Worker
      // =========================================================================

      case "replaceFontsWorker": {
        const {
          fontData,
          fontFamily,
          fontSize = 12,
          fontType = "SMALL",
          firmware,
          codePoints = []
        } = e.data as WorkerRequest & {
          fontData?: ArrayBuffer;
          fontFamily?: string;
          fontSize?: 12 | 16;
          fontType?: "SMALL" | "LARGE";
          firmware?: Uint8Array;
          codePoints?: number[];
        };

        if (!fontData || !fontFamily || !firmware || codePoints.length === 0) {
          self.postMessage({
            type: "error",
            id,
            error: "Missing required parameters for replaceFontsWorker",
          });
          return;
        }

        try {
          console.log("[replaceFontsWorker] Starting font replacement:", { fontFamily, fontSize, fontType, codePointsCount: codePoints.length });

          // Load fonts into worker's font set
          const userFontFace = new FontFace(fontFamily, fontData);
          await userFontFace.load();
          // @ts-ignore - fonts API exists in workers
          self.fonts.add(userFontFace);
          console.log("[replaceFontsWorker] User font loaded:", fontFamily);

          // Load tofu font for detection (fetch from server)
          console.log("[replaceFontsWorker] Fetching tofu font from /AND-Regular.ttf...");
          const tofuResponse = await fetch("/AND-Regular.ttf");
          if (!tofuResponse.ok) {
            throw new Error(`Failed to fetch tofu font: ${tofuResponse.status} ${tofuResponse.statusText}`);
          }
          const tofuBuffer = await tofuResponse.arrayBuffer();
          console.log("[replaceFontsWorker] Tofu font fetched, size:", tofuBuffer.byteLength);
          const tofuFontFace = new FontFace("Adobe-NotDef", tofuBuffer);
          await tofuFontFace.load();
          console.log("[replaceFontsWorker] Tofu font loaded, family:", tofuFontFace.family);
          // @ts-ignore - fonts API exists in workers
          self.fonts.add(tofuFontFace);

          // IMPORTANT: Wait for fonts to be fully ready before rendering
          // Without this, Firefox worker may not render fonts properly
          // @ts-ignore - fonts API exists in workers
          await self.fonts.ready;
          console.log("[replaceFontsWorker] Fonts ready");

          // Constants
          const TOFU_SCALE = 4;
          const TOFU_PADDING = 10;
          const canvasSize = fontSize * TOFU_SCALE + TOFU_PADDING * 2;

          // Canvas for rendering
          const canvas = new OffscreenCanvas(canvasSize, canvasSize);
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) {
            throw new Error("Failed to get canvas context");
          }
          console.log("[replaceFontsWorker] Canvas created:", canvasSize, "x", canvasSize);

          // Set firmware data
          firmwareData = firmware;

          // Results tracking
          const results = {
            replacedCharacters: [] as number[],
            successCount: 0,
            skippedCharacters: [] as number[],
            errors: [] as string[],
          };

          // Helper: Get tofu signature for this font size
          async function getTofuSignature(): Promise<boolean[][]> {
            // Render tofu char
            ctx!.fillStyle = "#ffffff";
            ctx!.fillRect(0, 0, canvas.width, canvas.height);
            console.log("[replaceFontsWorker] Rendering tofu char with font:", `${fontSize * TOFU_SCALE}px Adobe-NotDef`);
            ctx!.font = `${fontSize * TOFU_SCALE}px Adobe-NotDef`;
            ctx!.textBaseline = "top";
            ctx!.textAlign = "left";
            ctx!.imageSmoothingEnabled = false;
            ctx!.textRendering = "geometricPrecision";
            ctx!.fillStyle = "#000000"; // Ensure black text
            ctx!.fillText("\uFFFD", TOFU_PADDING, TOFU_PADDING);

            const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageDataToPixels(imageData, 128);

            // Count total black pixels in full canvas for debug
            let fullBlackPixels = 0;
            for (const row of pixels) {
              for (const p of row) {
                if (p) fullBlackPixels++;
              }
            }
            console.log("[replaceFontsWorker] Full canvas black pixels:", fullBlackPixels);

            // Extract center pattern
            const patternSize = fontSize * TOFU_SCALE;
            const pattern: boolean[][] = [];
            for (let y = TOFU_PADDING; y < TOFU_PADDING + patternSize; y++) {
              const row: boolean[] = [];
              for (let x = TOFU_PADDING; x < TOFU_PADDING + patternSize; x++) {
                row.push(pixels[y]?.[x] ?? false);
              }
              pattern.push(row);
            }
            return pattern;
          }

          // Get tofu signature once
          const tofuSignature = await getTofuSignature();
          console.log("[replaceFontsWorker] Tofu signature generated, pattern size:", tofuSignature.length, "x", tofuSignature[0]?.length);

          // Count black pixels in tofu signature for debug
          let tofuBlackPixels = 0;
          for (const row of tofuSignature) {
            for (const p of row) {
              if (p) tofuBlackPixels++;
            }
          }
          console.log("[replaceFontsWorker] Tofu signature black pixels:", tofuBlackPixels, "out of", tofuSignature.length * tofuSignature[0]?.length);

          // Debug: Show first few rows of tofu signature pattern
          console.log("[replaceFontsWorker] Tofu signature pattern (first 4 rows):");
          for (let y = 0; y < Math.min(4, tofuSignature.length); y++) {
            const rowStr = tofuSignature[y].map((p: boolean) => p ? "##" : "  ").join("");
            console.log(`[replaceFontsWorker]   Row ${y}: ${rowStr}`);
          }

          // Helper: Render char and extract pixels
          async function renderAndExtract(char: string, unicode: number): Promise<boolean[][] | null> {
            // Clear canvas
            ctx!.fillStyle = "#ffffff";
            ctx!.fillRect(0, 0, canvas.width, canvas.height);

            // Render user font with tofu fallback
            ctx!.font = `${fontSize * TOFU_SCALE}px ${fontFamily}, Adobe-NotDef`;
            ctx!.textBaseline = "top";
            ctx!.textAlign = "left";
            ctx!.imageSmoothingEnabled = false;
            ctx!.textRendering = "geometricPrecision";
            ctx!.fillStyle = "#000000"; // Ensure black text
            ctx!.fillText(char, TOFU_PADDING, TOFU_PADDING);

            const imageData = ctx!.getImageData(0, 0, canvas.width, canvas.height);
            const pixels = imageDataToPixels(imageData, 128);

            // Tofu detection - scan for signature
            let bestMatchRatio = 0;
            let bestMatchPos = { x: 0, y: 0 };
            const patternSize = fontSize * TOFU_SCALE;

            // Count black pixels in tofu signature for comparison
            let tofuBlackCount = 0;
            for (let py = 0; py < patternSize; py++) {
              for (let px = 0; px < patternSize; px++) {
                if (tofuSignature[py]?.[px]) tofuBlackCount++;
              }
            }

            for (let startY = 0; startY <= canvasSize - patternSize; startY++) {
              for (let startX = 0; startX <= canvasSize - patternSize; startX++) {
                let matches = 0;
                let total = 0;

                for (let py = 0; py < patternSize; py++) {
                  for (let px = 0; px < patternSize; px++) {
                    const renderedY = startY + py;
                    const renderedX = startX + px;
                    if (pixels[renderedY]?.[renderedX] === tofuSignature[py]?.[px]) {
                      matches++;
                    }
                    total++;
                  }
                }

                const ratio = matches / total;
                if (ratio > bestMatchRatio) {
                  bestMatchRatio = ratio;
                  bestMatchPos = { x: startX, y: startY };
                }
              }
            }

            // Count black pixels in rendered character
            let charBlackPixels = 0;
            for (let y = 0; y < canvasSize; y++) {
              for (let x = 0; x < canvasSize; x++) {
                if (pixels[y]?.[x]) charBlackPixels++;
              }
            }

            // Debug first 20 characters
            if (unicode < 0x14) {
              console.log(`[replaceFontsWorker] U+${unicode.toString(16).toUpperCase().padStart(4, '0')} "${char}": tofuBlack=${tofuBlackCount}, charBlack=${charBlackPixels}, bestMatch=${(bestMatchRatio * 100).toFixed(1)}% @ (${bestMatchPos.x},${bestMatchPos.y})`);
            }

            // If tofu (98%+ match AND has similar black pixel count), skip
            // This prevents blank/missing glyphs from being marked as tofu
            const blackPixelRatio = tofuBlackCount > 0 ? charBlackPixels / tofuBlackCount : 0;
            const isTofuMatch = bestMatchRatio >= 0.98 && blackPixelRatio > 0.5;

            if (isTofuMatch) {
              // Debug output for tofu match
              if (unicode < 0x20) {
                console.log(`[replaceFontsWorker]   -> SKIPPING as tofu (match=${(bestMatchRatio * 100).toFixed(1)}%, blackRatio=${(blackPixelRatio * 100).toFixed(1)}%)`);
              }
              return null;
            }

            // Extract and downsample
            const pattern: boolean[][] = [];
            for (let y = TOFU_PADDING; y < TOFU_PADDING + patternSize; y++) {
              const row: boolean[] = [];
              for (let x = TOFU_PADDING; x < TOFU_PADDING + patternSize; x++) {
                row.push(pixels[y]?.[x] ?? false);
              }
              pattern.push(row);
            }

            // Downsample to target size
            const downsampled: boolean[][] = [];
            for (let y = 0; y < patternSize; y += TOFU_SCALE) {
              const row: boolean[] = [];
              for (let x = 0; x < patternSize; x += TOFU_SCALE) {
                row.push(pattern[y]?.[x] ?? false);
              }
              downsampled.push(row);
            }

            return downsampled;
          }

          // Helper: Convert ImageData to boolean pixels
          function imageDataToPixels(imageData: globalThis.ImageData, threshold: number): boolean[][] {
            const data = imageData.data;
            const pixels: boolean[][] = [];
            const width = imageData.width;
            const height = imageData.height;

            for (let y = 0; y < height; y++) {
              const row: boolean[] = [];
              for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
                row.push(brightness < threshold);
              }
              pixels.push(row);
            }
            return pixels;
          }

          // Process all characters
          const SMALL_BASE = 0x3e648;
          const SMALL_STRIDE = 32;
          const LARGE_BASE = 0x4a000;
          const LARGE_STRIDE = 33;
          const LOOKUP_TABLE = 0x4e7bc;

          for (let i = 0; i < codePoints.length; i++) {
            const unicode = codePoints[i];
            const char = String.fromCodePoint(unicode);

            // Progress update - send every 100 chars
            if (i % 1 === 0) {
              self.postMessage({
                type: "progress",
                id,
                message: `Processing U+${unicode.toString(16).toUpperCase().padStart(4, '0')} (${i + 1}/${codePoints.length})...`,
                progress: Math.floor((i / codePoints.length) * 100),
              });
            }

            // Render and extract
            const pixels = await renderAndExtract(char, unicode);

            if (!pixels) {
              results.skippedCharacters.push(unicode);
              continue;
            }

            // Write to firmware
            let addr: number;
            let chunkSize: number;

            if (fontType === "SMALL") {
              if (unicode > 0xffff) {
                results.skippedCharacters.push(unicode);
                continue;
              }
              addr = SMALL_BASE + unicode * SMALL_STRIDE;
              chunkSize = SMALL_STRIDE;
            } else {
              if (unicode < 0x4e00 || unicode > 0x9fff) {
                results.skippedCharacters.push(unicode);
                continue;
              }
              addr = LARGE_BASE + (unicode - 0x4e00) * LARGE_STRIDE;
              chunkSize = LARGE_STRIDE;
            }

            if (addr + chunkSize > firmwareData!.length) {
              results.skippedCharacters.push(unicode);
              continue;
            }

            // Encode and write
            const lookupVal = firmwareData![LOOKUP_TABLE + (unicode >> 3)];
            const encoded = encodeV8(pixels, lookupVal);

            if (fontType === "LARGE") {
              const footer = firmwareData![addr + LARGE_STRIDE - 1];
              encoded[LARGE_STRIDE - 1] = footer;
            }

            firmwareData!.set(encoded, addr);

            // Verify
            const written = firmwareData!.slice(addr, addr + chunkSize);
            let verified = true;
            for (let j = 0; j < chunkSize; j++) {
              if (written[j] !== encoded[j]) {
                verified = false;
                break;
              }
            }

            if (!verified) {
              results.errors.push(`Verification failed for U+${unicode.toString(16).toUpperCase()}`);
              continue;
            }

            results.replacedCharacters.push(unicode);
            results.successCount++;

            // Yield periodically
            if (i % 50 === 0) {
              await new Promise((r) => setTimeout(r, 0));
            }
          }

          // Clean up
          // @ts-ignore - fonts API exists in workers
          self.fonts.delete(userFontFace);
          // @ts-ignore - fonts API exists in workers
          self.fonts.delete(tofuFontFace);

          // Return final firmware
          const resultFirmware = firmwareData!.slice(0);
          console.log("[replaceFontsWorker] Sending success result:", {
            successCount: results.successCount,
            skippedCount: results.skippedCharacters.length,
            firmwareLength: resultFirmware.length,
          });

          self.postMessage({
            type: "success",
            id,
            result: {
              ...results,
              firmware: resultFirmware,
              fontType,
            },
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          const errorStack = err instanceof Error ? err.stack : "";
          console.error("[replaceFontsWorker] Error:", errorMsg, errorStack);
          self.postMessage({
            type: "error",
            id,
            error: `Font replacement failed: ${errorMsg}`,
            details: errorStack,
          });
        }
        break;
      }

      default:
        self.postMessage({
          type: "error",
          id,
          error: `Unknown request type: ${type}`,
        });
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export {};
