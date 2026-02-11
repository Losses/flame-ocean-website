/**
 * Tofu Fallback Font Utilities
 *
 * Uses Adobe NotDef font to detect missing characters.
 * Adobe NotDef is a special font that renders a distinctive .notdef glyph
 * for any character, allowing us to detect when a user's font is missing a glyph.
 *
 * This module now uses shared glyph rendering utilities from glyph-renderer.ts
 * for consistent pixel-perfect rendering across all font operations.
 */

import type { PixelData } from "../types/index.js";
import {
  imageDataToPixels,
  renderGlyphToPixels,
  buildFontStackString,
  pixelsToDataURL,
  type FontSize,
} from "./glyph-renderer.js";

/**
 * Tofu pixel signature for a font size
 * Stores canonical pixel representation of Adobe NotDef's .notdef glyph
 */
export interface TofuSignature {
  /** Font size for this signature */
  fontSize: number;
  /** Character used to generate signature */
  char: string;
  /** Pixel grid (2D boolean array) of Adobe NotDef render */
  pixels: boolean[][];
  /** Canvas dimensions used */
  width: number;
  height: number;
  /** Size of the 4x4 pattern extracted from signature */
  patternSize?: number;
}

/**
 * Registered tofu font state
 */
interface TofuFontState {
  /** FontFace object for Adobe NotDef */
  fontFace: FontFace | null;
  /** Font family name */
  fontFamily: string;
  /** Whether font is loaded */
  loaded: boolean;
  /** Cached signatures by font size */
  signatures: Map<number, TofuSignature>;
}

/**
 * Global tofu font state
 */
const tofuState: TofuFontState = {
  fontFace: null,
  fontFamily: "Adobe-NotDef",
  loaded: false,
  signatures: new Map(),
};

/**
 * Font family name for tofu fallback
 */
export const TOFU_FONT_FAMILY = "Adobe-NotDef";

/**
 * Default test character for tofu signature generation
 * Using a character that won't exist in most pixel fonts
 */
const DEFAULT_TOFU_TEST_CHAR = "\uFFFD"; // Replacement character

/**
 * Scale factor for tofu pattern extraction
 * Tofu pattern is rendered at 4x the font size
 */
const TOFU_PATTERN_SCALE = 4;

/**
 * Padding pixels on each side for padded canvas
 * Allows for font metric variations (ascent/descent differences)
 */
const PADDING_PIXELS = 10;

/**
 * Calculate padded canvas size for a given font size
 * Canvas is (fontSize * TOFU_PATTERN_SCALE) + (PADDING_PIXELS * 2)
 * @param fontSize - Font size in pixels (12 or 16)
 * @returns Total canvas size including padding
 */
function getPaddedCanvasSize(fontSize: FontSize): number {
  return fontSize * TOFU_PATTERN_SCALE + PADDING_PIXELS * 2;
}

/**
 * Debug data for tofu detection comparison
 */
export interface TofuDebugData {
  /** Unicode code point */
  codePoint: number;
  /** Character string */
  char: string;
  /** Font size */
  fontSize: number;
  /** Rendered pixels from user font */
  renderedPixels: boolean[][];
  /** Tofu signature pixels */
  tofuPixels: boolean[][];
  /** Whether they match (is tofu) */
  match: boolean;
  /** Match percentage */
  matchPercentage: number;
  /** Bounding box of rendered pixels */
  boundingBox1: { x: number; y: number; width: number; height: number };
  /** Bounding box of tofu signature */
  boundingBox2: { x: number; y: number; width: number; height: number };
}

// Store debug data when debug mode is enabled
let debugDataCollection: TofuDebugData[] = [];
export let debugModeEnabled = false;

/**
 * Test characters used to verify tofu detection is working correctly
 * These characters are very unlikely to exist in typical pixel fonts
 */
export const RARE_TEST_CHARS: number[] = [
  0x3331, 0x3300, 0x3400, 0x3130, 0x3100, 0x2072, 0x1a20, 0x1a00, 0x1980,
  0x0e00, 0x0a00, 0x0600,
];

/**
 * Check if a code point is one of rare test characters
 */
export function isTestChar(codePoint: number): boolean {
  return RARE_TEST_CHARS.includes(codePoint);
}

/**
 * Get category of a test character
 */
export function getTestCharCategory(codePoint: number): string {
  if (codePoint >= 0xff00) return "Fullwidth/Halfwidth";
  if (codePoint >= 0x2600) return "Symbols";
  if (codePoint >= 0x2500) return "Box/Block";
  if (codePoint >= 0x2300) return "Technical";
  if (codePoint >= 0x2190) return "Arrow/Math";
  if (codePoint >= 0x0180) return "Latin Extended";
  return "Other";
}

/**
 * Enable/disable tofu debug collection
 */
export function setTofuDebugMode(enabled: boolean): void {
  console.log(`[Tofu] setTofuDebugMode(${enabled}) - clearing collection`);
  debugModeEnabled = enabled;
  if (enabled) {
    debugDataCollection = [];
  }
}

/**
 * Get collected debug data and clear collection
 */
export function getTofuDebugData(): TofuDebugData[] {
  const data = [...debugDataCollection];
  console.log(`[Tofu] getTofuDebugData() returning ${data.length} items`);
  console.log(
    `[Tofu] Code points in collection:`,
    data.map((d) => `0x${d.codePoint.toString(16).padStart(4, "0")}`),
  );
  debugDataCollection = [];
  return data;
}

/**
 * Initialize tofu font system by loading Adobe NotDef
 * @returns Promise that resolves when initialized
 */
export async function loadTofuFont(): Promise<void> {
  if (tofuState.loaded) {
    return;
  }

  try {
    // Fetch Adobe NotDef font file
    const response = await fetch("/AND-Regular.ttf");
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Adobe NotDef font: ${response.statusText}`,
      );
    }

    const buffer = await response.arrayBuffer();

    // Create FontFace object
    const fontFace = new FontFace(TOFU_FONT_FAMILY, buffer);

    // Load and add to document fonts
    await fontFace.load();
    document.fonts.add(fontFace);

    // Store in state
    tofuState.fontFace = fontFace;
    tofuState.loaded = true;
  } catch (error) {
    console.error("Failed to load Adobe NotDef font:", error);
    throw new Error(
      `Failed to load tofu font: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Generate an Adobe NotDef signature for a specific font size
 * @param fontSize - Font size in pixels
 * @param testChar - Optional test character (defaults to replacement character)
 * @returns The Adobe NotDef signature
 */
export async function generateTofuSignature(
  fontSize: number,
  testChar = DEFAULT_TOFU_TEST_CHAR,
): Promise<TofuSignature> {
  // Check if already cached
  const cached = tofuState.signatures.get(fontSize);
  if (cached) {
    return cached;
  }

  if (!tofuState.loaded) {
    throw new Error("Tofu font not loaded. Call loadTofuFont() first.");
  }

  // Render in padded canvas and extract the 4x4 pattern from center
  // This creates a canonical tofu signature that can be scanned across user renders
  const paddedPixels = await renderInPaddedCanvas(testChar, TOFU_FONT_FAMILY, fontSize as FontSize);

  // Extract the center 4x4 pattern (the actual tofu signature)
  const patternSize = fontSize * TOFU_PATTERN_SCALE;
  const padding = PADDING_PIXELS;
  const pattern: boolean[][] = [];

  for (let y = padding; y < padding + patternSize; y++) {
    const row: boolean[] = [];
    for (let x = padding; x < padding + patternSize; x++) {
      row.push(paddedPixels[y][x] ?? false);
    }
    pattern.push(row);
  }

  const signature: TofuSignature = {
    fontSize,
    char: testChar,
    pixels: pattern,
    width: patternSize,
    height: patternSize,
    patternSize,
  };

  // Cache signature
  tofuState.signatures.set(fontSize, signature);

  return signature;
}

/**
 * Get tofu signature for a font size
 * @param fontSize - Font size in pixels
 * @returns The tofu signature or null if not generated
 */
export function getTofuSignature(fontSize: number): TofuSignature | null {
  return tofuState.signatures.get(fontSize) || null;
}

/**
 * Check if tofu font system is ready
 * @returns True if Adobe NotDef is loaded
 */
export function isTofuFontLoaded(): boolean {
  return tofuState.loaded;
}

/**
 * Get the tofu font family name for use in CSS font stacks
 * @returns The tofu font family name
 */
export function getTofuFontFamily(): string {
  return TOFU_FONT_FAMILY;
}

/**
 * Render character in padded canvas with font stack
 * Uses larger canvas with padding to accommodate font metric variations
 * @param char - Character to render
 * @param fontFamily - Font family (or stack) to use
 * @param fontSize - Font size in pixels (12 or 16)
 * @returns Rendered pixel data in padded canvas
 */
async function renderInPaddedCanvas(
  char: string,
  fontFamily: string,
  fontSize: FontSize,
): Promise<boolean[][]> {
  const canvasSize = getPaddedCanvasSize(fontSize);
  const scaledFontSize = fontSize * 10; // Use same scale factor as glyph-renderer

  const canvas = document.createElement('canvas');
  canvas.width = canvasSize;
  canvas.height = canvasSize;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  // Clear with background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Configure font rendering at scaled size
  ctx.font = `${scaledFontSize}px ${fontFamily}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.imageSmoothingEnabled = false;

  // Render character centered vertically in the padded canvas
  // This allows for ascent/descent variations
  const yOffset = PADDING_PIXELS;
  ctx.fillStyle = '#000000';
  ctx.fillText(char, 0, yOffset);

  // Extract pixel data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageDataToPixels(imageData, 128);

  // Clean up
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0;
  canvas.height = 0;

  return pixels;
}

/**
 * Result of pattern scanning for tofu detection
 */
interface PatternScanResult {
  /** Whether tofu pattern was found with sufficient confidence */
  readonly isMatch: boolean;
  /** Best match ratio found (0-1) */
  readonly matchRatio: number;
  /** Position where best match was found */
  readonly matchPosition: { x: number; y: number } | null;
}

/**
 * Scan for tofu pattern in rendered canvas
 * Slides the 4x4 tofu pattern across the rendered canvas looking for best match
 * @param rendered - Rendered pixel grid from user font
 * @param pattern - 4x4 tofu pattern to scan for
 * @param matchThreshold - Minimum match ratio to consider it tofu (default 0.98)
 * @returns PatternScanResult with match status, ratio, and position
 */
function scanForTofuPattern(
  rendered: boolean[][],
  pattern: boolean[][],
  matchThreshold = 0.98,
): PatternScanResult {
  const patternHeight = pattern.length;
  const patternWidth = pattern[0]?.length || 4;
  const renderedHeight = rendered.length;
  const renderedWidth = rendered[0]?.length || 0;

  // Try every position where pattern could fit
  let bestMatchRatio = 0;
  let bestMatchPosition: { x: number; y: number } | null = null;

  for (let startY = 0; startY <= renderedHeight - patternHeight; startY++) {
    for (let startX = 0; startX <= renderedWidth - patternWidth; startX++) {
      let matches = 0;
      let total = 0;

      // Compare pattern at this position
      for (let py = 0; py < patternHeight; py++) {
        for (let px = 0; px < patternWidth; px++) {
          const renderedY = startY + py;
          const renderedX = startX + px;

          // Check bounds
          if (
            renderedY >= 0 &&
            renderedY < renderedHeight &&
            renderedX >= 0 &&
            renderedX < renderedWidth
          ) {
            const pRendered = rendered[renderedY]?.[renderedX] ?? false;
            const pPattern = pattern[py]?.[px] ?? false;

            if (pRendered === pPattern) {
              matches++;
            }
            total++;
          }
        }
      }

      const matchRatio = total > 0 ? matches / total : 0;
      if (matchRatio > bestMatchRatio) {
        bestMatchRatio = matchRatio;
        bestMatchPosition = { x: startX, y: startY };
      }
    }
  }

  return {
    isMatch: bestMatchRatio >= matchThreshold,
    matchRatio: bestMatchRatio,
    matchPosition: bestMatchPosition,
  };
}

/**
 * Unload tofu font and clean up resources
 */
export function unloadTofuFont(): void {
  if (tofuState.fontFace) {
    try {
      document.fonts.delete(tofuState.fontFace);
    } catch {
      // Ignore cleanup errors
    }
    tofuState.fontFace = null;
  }
  tofuState.loaded = false;
  tofuState.signatures.clear();
}

/**
 * Compare two pixel grids for equality
 * Used to detect if a rendered character matches system fallback
 *
 * NOTE: This is a legacy function kept for compatibility.
 * New code uses scanForTofuPattern() for robust pattern-based comparison.
 */
export function pixelsMatch(
  pixels1: boolean[][],
  pixels2: boolean[][],
): boolean {
  if (pixels1.length !== pixels2.length) {
    return false;
  }

  for (let y = 0; y < pixels1.length; y++) {
    const row1 = pixels1[y];
    const row2 = pixels2[y];
    if (row1.length !== row2.length) {
      return false;
    }
    for (let x = 0; x < row1.length; x++) {
      if (row1[x] !== row2[x]) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Check if a rendered character matches system fallback signature
 * Uses pattern scanning to detect tofu in user's font render
 * @param pixels - Rendered character pixels from user font
 * @param fontSize - Font size used for rendering
 * @returns True if character appears to use system fallback (missing from font)
 */
export function isTofuCharacter(pixels: PixelData, fontSize: number): boolean {
  const signature = getTofuSignature(fontSize);
  if (!signature) {
    // No signature available, cannot determine
    return false;
  }

  // Convert readonly PixelData to mutable boolean[][] for internal processing
  const mutablePixels = pixels.map((row) => [...row]);

  // Use pattern scanning to detect tofu
  // Scan the 4x4 tofu pattern across the rendered canvas
  const result = scanForTofuPattern(mutablePixels, signature.pixels);
  return result.isMatch;
}

/**
 * Find bounding box of non-white pixels in a pixel grid
 */
function findBoundingBox(pixels: boolean[][]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  let minX = pixels[0]?.length || 0;
  let minY = pixels.length;
  let maxX = 0;
  let maxY = 0;
  let found = false;

  for (let y = 0; y < pixels.length; y++) {
    for (let x = 0; x < pixels[y].length; x++) {
      if (pixels[y][x]) {
        found = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  if (!found) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/**
 * Crop a pixel grid to its bounding box
 */
function cropToBoundingBox(
  pixels: boolean[][],
  bbox: { x: number; y: number; width: number; height: number },
): boolean[][] {
  const result: boolean[][] = [];

  for (let y = bbox.y; y < bbox.y + bbox.height && y < pixels.length; y++) {
    const row: boolean[] = [];
    for (let x = bbox.x; x < bbox.x + bbox.width && x < pixels[y].length; x++) {
      row.push(pixels[y][x]);
    }
    result.push(row);
  }

  return result;
}

/**
 * Compare two pixel regions with tolerance for minor differences
 * Uses a more robust approach that handles position offsets
 */
function comparePixelRegions(
  pixels1: boolean[][],
  pixels2: boolean[][],
  // Optional debug capture
  codePoint?: number,
  char?: string,
  fontSize?: number,
): boolean {
  // Find bounding boxes for both pixel grids
  const bbox1 = findBoundingBox(pixels1);
  const bbox2 = findBoundingBox(pixels2);

  // Initialize match result and percentage
  let isMatch = false;
  let matchPercentage = 0;

  // If either is empty, compare emptiness
  if (bbox1.width === 0 || bbox1.height === 0) {
    isMatch = bbox2.width === 0 || bbox2.height === 0;
    matchPercentage = isMatch ? 1.0 : 0.0;

    // Capture debug data for empty renders before returning
    if (debugModeEnabled && codePoint !== undefined && char && fontSize) {
      const isTest = isTestChar(codePoint);
      console.log(
        `[Tofu] Collecting debug data for EMPTY 0x${codePoint.toString(16).padStart(4, "0")}${isTest ? " [TEST]" : ""}: match=${isMatch}, percentage=${(matchPercentage * 100).toFixed(1)}%, collection size now: ${debugDataCollection.length + 1}`,
      );
      debugDataCollection.push({
        codePoint,
        char,
        fontSize,
        renderedPixels: pixels1.map((row) => [...row]),
        tofuPixels: pixels2.map((row) => [...row]),
        match: isMatch,
        matchPercentage,
        boundingBox1: { ...bbox1 },
        boundingBox2: { ...bbox2 },
      });
    }

    return isMatch;
  }
  if (bbox2.width === 0 || bbox2.height === 0) {
    isMatch = false;
    matchPercentage = 0.0;

    // Capture debug data for empty signature before returning
    if (debugModeEnabled && codePoint !== undefined && char && fontSize) {
      const isTest = isTestChar(codePoint);
      console.log(
        `[Tofu] Collecting debug data for EMPTY SIGNATURE 0x${codePoint.toString(16).padStart(4, "0")}${isTest ? " [TEST]" : ""}: match=${isMatch}, percentage=${(matchPercentage * 100).toFixed(1)}%, collection size now: ${debugDataCollection.length + 1}`,
      );
      debugDataCollection.push({
        codePoint,
        char,
        fontSize,
        renderedPixels: pixels1.map((row) => [...row]),
        tofuPixels: pixels2.map((row) => [...row]),
        match: isMatch,
        matchPercentage,
        boundingBox1: { ...bbox1 },
        boundingBox2: { ...bbox2 },
      });
    }

    return isMatch;
  }

  // Crop to bounding boxes
  const cropped1 = cropToBoundingBox(pixels1, bbox1);
  const cropped2 = cropToBoundingBox(pixels2, bbox2);

  // Handle empty cropped arrays (shouldn't happen after bbox checks, but be safe)
  if (
    cropped1.length === 0 ||
    cropped1[0]?.length === 0 ||
    cropped2.length === 0 ||
    cropped2[0]?.length === 0
  ) {
    isMatch = false;
    matchPercentage = 0.0;

    // Capture debug data for empty crops before returning
    if (debugModeEnabled && codePoint !== undefined && char && fontSize) {
      const isTest = isTestChar(codePoint);
      console.log(
        `[Tofu] Collecting debug data for EMPTY CROP 0x${codePoint.toString(16).padStart(4, "0")}${isTest ? " [TEST]" : ""}: match=${isMatch}, percentage=${(matchPercentage * 100).toFixed(1)}%, collection size now: ${debugDataCollection.length + 1}`,
      );
      debugDataCollection.push({
        codePoint,
        char,
        fontSize,
        renderedPixels: pixels1.map((row) => [...row]),
        tofuPixels: pixels2.map((row) => [...row]),
        match: isMatch,
        matchPercentage,
        boundingBox1: { ...bbox1 },
        boundingBox2: { ...bbox2 },
      });
    }

    return isMatch;
  }

  // Check if sizes are wildly different (not the same character)
  const size1 = cropped1.length * cropped1[0].length;
  const size2 = cropped2.length * cropped2[0].length;
  const maxSize = Math.max(size1, size2);

  if (Math.abs(size1 - size2) > maxSize * 0.3) {
    // More than 30% size difference = definitely not the same
    isMatch = false;
    matchPercentage =
      size1 + size2 > 0 ? Math.min(size1, size2) / Math.max(size1, size2) : 0.0;

    // Capture debug data for size mismatch before returning
    if (debugModeEnabled && codePoint !== undefined && char && fontSize) {
      const isTest = isTestChar(codePoint);
      console.log(
        `[Tofu] Collecting debug data for SIZE MISMATCH 0x${codePoint.toString(16).padStart(4, "0")}${isTest ? " [TEST]" : ""}: match=${isMatch}, percentage=${(matchPercentage * 100).toFixed(1)}%, collection size now: ${debugDataCollection.length + 1}`,
      );
      debugDataCollection.push({
        codePoint,
        char,
        fontSize,
        renderedPixels: pixels1.map((row) => [...row]),
        tofuPixels: pixels2.map((row) => [...row]),
        match: isMatch,
        matchPercentage,
        boundingBox1: { ...bbox1 },
        boundingBox2: { ...bbox2 },
      });
    }

    return isMatch;
  }

  // Try different offsets to find the best match
  // This handles cases where fonts render the same glyph at slightly different positions
  const maxOffset = 2; // Allow up to 2 pixels offset in each direction
  let bestMatchPercentage = 0;

  for (let dy = -maxOffset; dy <= maxOffset; dy++) {
    for (let dx = -maxOffset; dx <= maxOffset; dx++) {
      let matches = 0;
      let total = 0;

      // Compare crops with offset
      for (let y = 0; y < cropped1.length; y++) {
        for (let x = 0; x < cropped1[y].length; x++) {
          // Calculate corresponding position in crop2 with offset
          const y2 = y + dy;
          const x2 = x + dx;

          // Check if position is valid in crop2
          if (
            y2 >= 0 &&
            y2 < cropped2.length &&
            x2 >= 0 &&
            x2 < cropped2[y2].length
          ) {
            const p1 = cropped1[y][x];
            const p2 = cropped2[y2][x2];
            if (p1 === p2) {
              matches++;
            }
            total++;
          }
        }
      }

      const percentage = total > 0 ? matches / total : 0;
      if (percentage > bestMatchPercentage) {
        bestMatchPercentage = percentage;
      }
    }
  }

  // Calculate match percentage using best offset found
  matchPercentage = bestMatchPercentage;
  isMatch = matchPercentage >= 0.95;

  // Capture debug data if debug mode is enabled
  if (debugModeEnabled && codePoint !== undefined && char && fontSize) {
    const isTest = isTestChar(codePoint);
    console.log(
      `[Tofu] Collecting debug data for 0x${codePoint.toString(16).padStart(4, "0")}${isTest ? " [TEST]" : ""}: match=${isMatch}, percentage=${(matchPercentage * 100).toFixed(1)}%, collection size now: ${debugDataCollection.length + 1}`,
    );
    debugDataCollection.push({
      codePoint,
      char,
      fontSize,
      renderedPixels: pixels1.map((row) => [...row]),
      tofuPixels: pixels2.map((row) => [...row]),
      match: isMatch,
      matchPercentage,
      boundingBox1: { ...bbox1 },
      boundingBox2: { ...bbox2 },
    });
  }

  // Require at least 95% match for tofu detection
  // This is stricter than before to reduce false positives
  return isMatch;
}

/**
 * Render a single character using user font with Adobe NotDef fallback
 * Now uses padded canvas rendering for robust tofu detection
 * @param char - Character to render
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @returns Rendered pixel data in padded canvas
 */
export async function renderCharacterWithTofu(
  char: string,
  fontFamily: string,
  fontSize: 12 | 16,
): Promise<boolean[][]> {
  // Build font stack with tofu fallback
  const fontStack = tofuState.loaded
    ? buildFontStackString(fontFamily, TOFU_FONT_FAMILY)
    : buildFontStackString(fontFamily);

  // Render in padded canvas using the same approach as signature
  return await renderInPaddedCanvas(char, fontStack, fontSize as FontSize);
}

/**
 * Result of checking if a character should be skipped during font replacement
 */
export interface SkipCharacterResult {
  /** Whether character should be skipped */
  readonly shouldSkip: boolean;
  /** Unicode code point of character */
  readonly codePoint: number;
  /** Character string */
  readonly char: string;
  /** Reason for skipping (if applicable) */
  readonly reason?: "missing_from_font" | "not_in_firmware" | null;
}

/**
 * Check if a character should be skipped during font replacement
 *
 * Checks by rendering the character and comparing against Adobe NotDef's .notdef glyph.
 * If they match (within tolerance), the character is missing from the user's font.
 *
 * @param codePoint - Unicode code point of character to check
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @param existsInFirmware - Optional callback to check if character exists in firmware address space
 * @returns SkipCharacterResult with skip decision and reason
 */
export async function shouldSkipCharacter(
  codePoint: number,
  fontFamily: string,
  fontSize: 12 | 16,
  existsInFirmware?: (codePoint: number) => boolean,
): Promise<SkipCharacterResult> {
  // Convert code point to string
  const char = String.fromCodePoint(codePoint);
  const isTest = isTestChar(codePoint);
  console.log(
    `[shouldSkip] 0x${codePoint.toString(16).padStart(4, "0")} (${char})${isTest ? " [TEST]" : ""} existsInFirmware=${!!existsInFirmware}`,
  );

  // Check if character exists in firmware (if callback provided)
  if (existsInFirmware) {
    const exists = existsInFirmware(codePoint);
    if (!exists) {
      console.log(
        `[shouldSkip] 0x${codePoint.toString(16).padStart(4, "0")} NOT in firmware, returning early`,
      );
      return {
        shouldSkip: true,
        codePoint,
        char,
        reason: "not_in_firmware",
      };
    }
  }

  // Check if character is missing from font by comparing against Adobe NotDef
  if (tofuState.loaded) {
    // Get or generate tofu signature for this size
    let signature = getTofuSignature(fontSize);
    if (!signature) {
      console.log(`[tofu] Generating signature for ${fontSize}px...`);
      signature = await generateTofuSignature(fontSize);
      console.log(
        `[tofu] Signature generated: ${signature.width}x${signature.height}, pixels:`,
        signature.pixels,
      );
    }

    // Render character in padded canvas (will use Adobe NotDef if missing)
    const pixels = await renderCharacterWithTofu(char, fontFamily, fontSize);

    // Use pattern scanning to detect if tofu
    // This handles font metric variations by scanning for the pattern
    const result = scanForTofuPattern(pixels, signature.pixels);
    const isTofu = result.isMatch;

    // Collect debug data if debug mode is enabled
    if (debugModeEnabled) {
      const bbox1 = findBoundingBox(pixels);
      const bbox2 = findBoundingBox(signature.pixels);

      console.log(
        `[Tofu] Collecting debug data for 0x${codePoint.toString(16).padStart(4, "0")}${isTest ? " [TEST]" : ""}: isMatch=${isTofu}, matchRatio=${(result.matchRatio * 100).toFixed(1)}%, collection size now: ${debugDataCollection.length + 1}`,
      );

      // Store the rendered pixels (padded canvas) and signature pattern (4x4)
      debugDataCollection.push({
        codePoint,
        char,
        fontSize,
        renderedPixels: pixels.map((row) => [...row]),
        tofuPixels: signature.pixels.map((row) => [...row]),
        match: isTofu,
        matchPercentage: result.matchRatio,
        boundingBox1: { ...bbox1 },
        boundingBox2: { ...bbox2 },
      });
    }

    // Log test characters and control characters for debugging
    if (isTest) {
      console.log(
        `[tofu] TEST CHAR 0x${codePoint.toString(16).padStart(4, "0")}: isTofu=${isTofu}, matchRatio=${(result.matchRatio * 100).toFixed(1)}%, shouldSkip=true`,
      );
    } else if (codePoint < 0x20) {
      console.log(
        `[tofu] 0x${codePoint.toString(16).padStart(4, "0")}: isTofu=${isTofu}, pixels=${pixels.length}x${pixels[0]?.length}`,
      );
      console.log(`[tofu] Signature: ${signature.width}x${signature.height}`);
    }

    if (isTofu) {
      console.log(
        `[shouldSkip] 0x${codePoint.toString(16).padStart(4, "0")}: TOFU DETECTED, shouldSkip=true`,
      );
      return {
        shouldSkip: true,
        codePoint,
        char,
        reason: "missing_from_font",
      };
    }
    console.log(
      `[shouldSkip] 0x${codePoint.toString(16).padStart(4, "0")}: NOT tofu, shouldSkip=false`,
    );
  }

  console.log(
    `[shouldSkip] 0x${codePoint.toString(16).padStart(4, "0")}: tofu font not loaded, shouldSkip=false`,
  );
  return {
    shouldSkip: false,
    codePoint,
    char,
    reason: null,
  };
}

/**
 * Check if multiple characters should be skipped during font replacement
 *
 * Batch version of shouldSkipCharacter for processing multiple characters efficiently.
 *
 * @param codePoints - Array of Unicode code points to check
 * @param fontFamily - Primary font family name
 * @param fontSize - Font size in pixels (12 or 16)
 * @param existsInFirmware - Optional callback to check if character exists in firmware address space
 * @returns Array of SkipCharacterResult for each character
 */
export async function shouldSkipCharacters(
  codePoints: number[],
  fontFamily: string,
  fontSize: 12 | 16,
  existsInFirmware?: (codePoint: number) => boolean,
): Promise<{
  results: SkipCharacterResult[];
  skippedCharacters: number[];
  skippedReasons: Map<number, string>;
}> {
  const results: SkipCharacterResult[] = [];
  const skippedCharacters: number[] = [];
  const skippedReasons = new Map<number, string>();

  // Process each character
  for (const codePoint of codePoints) {
    const result = await shouldSkipCharacter(
      codePoint,
      fontFamily,
      fontSize,
      existsInFirmware,
    );
    results.push(result);

    if (result.shouldSkip) {
      skippedCharacters.push(codePoint);
      skippedReasons.set(codePoint, result.reason || "unknown");
    }
  }

  return {
    results,
    skippedCharacters,
    skippedReasons,
  };
}

// Export pixelsToDataURL for use in debug windows
export { pixelsToDataURL };
