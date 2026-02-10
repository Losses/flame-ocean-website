# Font Replacement Feature

## Overview

The Font Replacement feature allows you to replace font glyphs in Snowsky Echo Mini firmware by dragging and dropping font files onto the interface. The system automatically detects whether your font is suitable for the SMALL (12px) or LARGE (16px) font size, validates that it is pixel-perfect (no anti-aliasing), and performs batch replacement of all available glyphs.

## Supported Font Formats

The following font file formats are supported:

- **TTF** (TrueType Font) - `.ttf`
- **OTF** (OpenType Font) - `.otf`
- **WOFF** (Web Open Font Format) - `.woff`
- **WOFF2** (Web Open Font Format 2.0) - `.woff2`

## How to Use

### Via Drag & Drop

1. Open a firmware file in FlameOcean
2. Navigate to the Font resource in the tree view
3. Drag a font file (.ttf, .otf, .woff, .woff2) onto the content panel
4. The system will automatically:
   - Detect if the font is suitable for SMALL (12px) or LARGE (16px) replacement
   - Validate that the font renders pixel-perfectly
   - Replace all available glyphs in the firmware

### Via Paste

1. Copy a font file to your clipboard
2. Press `Ctrl+V` (or `Cmd+V` on Mac) while viewing font glyphs
3. The replacement process will begin automatically

## Understanding the Pixel-Perfect Requirement

### What is Pixel-Perfect?

The Snowsky Echo Mini firmware uses bitmap fonts where each glyph is stored as a black-and-white pixel grid. For a font to be compatible, it must render at the target size (12px or 16px) with **only pure black and pure white pixels** - no grayscale or anti-aliased edges.

### Why is Anti-Aliasing a Problem?

Anti-aliasing creates smooth edges by adding gray pixels at the boundaries of characters. The firmware's font encoding system expects only black (foreground) and white (background) pixels. When anti-aliased fonts are detected:

1. The pixel values won't encode correctly to the firmware's format
2. The rendered text on the device will appear distorted or corrupted
3. The verification step will fail, rejecting the font file

### Valid vs Invalid Fonts

| Valid Font | Invalid Font |
|------------|--------------|
| Designed as bitmap/pixel font | Standard outline font (Helvetica, Arial, etc.) |
| Renders crisp at target size | Renders with anti-aliased edges |
| Only black and white pixels | Contains grayscale/anti-aliased pixels |
| Examples: "Press Start 2P", "Px437", "Unscii" | Examples: Most Google Fonts, system fonts |

### How to Find Compatible Fonts

Look for fonts described as:
- **Pixel fonts** or **Bitmap fonts**
- **8-bit fonts** or **Retro fonts**
- Fonts designed for specific sizes (e.g., "8px", "12px", "16px")

Popular compatible font families:
- Press Start 2P
- Px437 (IBM PC BIOS fonts)
- Unscii
- Pixel Operator
- VT323

## The Tofu Fallback Mechanism

### What is Tofu?

"Tofu" (�) is the placeholder character displayed when a font doesn't contain a particular glyph. The Font Replacement feature uses a special "tofu.ttf" font to detect which characters are missing from your provided font.

### How It Works

1. The system loads your custom font with tofu as a fallback: `"YourFont", "Tofu"`
2. For each Unicode character in the firmware's range:
   - The character is rendered using this font stack
   - If your font has the glyph, it renders normally
   - If your font is missing the glyph, the tofu character renders instead
3. By comparing rendered output against the known tofu signature, the system detects missing characters and skips them

### Why This Matters

Without tofu detection, missing characters would either:
- Cause rendering errors (if the font has no glyph at all)
- Replace the firmware glyph with incorrect data (if a default glyph is used)

The tofu mechanism ensures only valid characters are replaced, preserving the firmware's original glyphs for any missing characters.

## Visual Indicators

### Replaced Characters

After a successful font replacement, characters that have been replaced are indicated by **blue Unicode labels** in the font grid view.

- **Original characters**: Gray `U+XXXX` labels
- **Replaced characters**: Blue bold `U+XXXX` labels

This visual feedback helps you quickly identify which glyphs have been successfully replaced.

## Troubleshooting

### "Invalid Font File" Error

**Problem**: The font file was rejected with an error message indicating it's not pixel-perfect.

**Solutions**:
1. **Use a bitmap font**: Ensure you're using a font designed as a bitmap/pixel font for the target size (12px or 16px)
2. **Check font size**: Some bitmap fonts are designed for specific sizes - make sure you're using one designed for 12px or 16px
3. **Test the font**: Try rendering the font at the target size in an image editor - zoom in and verify there are no gray pixels

### Font Detected as Wrong Size

**Problem**: Your 12px font is being detected as LARGE (16px) or vice versa.

**Explanation**: The system tests both sizes and classifies based on which produces pixel-perfect rendering. If a font renders cleanly at 16px but not 12px, it's classified as LARGE even if you intended it for SMALL.

**Solution**: Use a font specifically designed for the target size. Many bitmap font families offer variants for different sizes.

### Some Characters Were Skipped

**Problem**: The summary dialog shows that some characters were skipped.

**This is normal behavior**. Characters are skipped for two reasons:

1. **Missing from font**: The font doesn't contain a glyph for that Unicode character
2. **Not in firmware**: The character doesn't exist in the firmware's address space

Check the summary dialog for a list of skipped characters and their reasons.

### No Characters Were Replaced

**Problem**: The font loaded successfully but 0 characters were replaced.

**Possible causes**:
1. The font is actually a standard vector font being rendered at 12px/16px, but the characters don't match what the firmware expects
2. The font's encoding tables don't include the Unicode ranges needed
3. All characters in the firmware ranges are missing from the font

**Solution**: Try a different bitmap font, preferably one known to work with embedded systems.

## Technical Details

### Font Size Detection

The system renders test characters (A-Z, a-z) at both 12px and 16px on an HTML canvas, then scans for anti-aliased pixels by checking for grayscale values (where R=G=B but the value is neither 0 nor 255).

### Unicode Ranges

- **SMALL fonts**: Support Unicode ranges 0x0000-0xFFFF (Basic Latin, Latin-1 Supplement, Latin Extended-A/B, etc.)
- **LARGE fonts**: Support CJK Unified Ideographs range 0x4E00-0x9FFF

### Encoding Process

1. Font is rendered to canvas using tofu fallback
2. Pixel data is extracted as boolean array (true=black, false=white)
3. Boolean array is encoded to V8 format using lookup tables
4. Data is written to firmware at calculated address
5. Data is read back and verified byte-by-byte
6. Process repeats for each character in range

### Quality Assurance

Every character replacement is immediately verified:
1. After writing to firmware, the data is read back
2. Read-back bytes are compared against original input
3. On any mismatch, the entire batch operation halts
4. An error is reported with the Unicode value of the failing character

This ensures data integrity - either all characters are replaced correctly, or none are.

## API Reference

### Main Entry Points

```typescript
// Load and validate a font file
import { loadAndValidateFontFile } from '$lib/rse/font-loading';

const result = await loadAndValidateFontFile(fileObject);
// Returns: FontLoadingResult with fontFace, fontFamily, detectedType, etc.

// Extract character pixels
import { extractCharacter } from '$lib/rse/font-extraction';

const pixels = await extractCharacter(0x0041, 'Arial_12px', 'SMALL');
// Returns: PixelData (boolean[][])

// Detect font type
import { detectFontTypeFromFile } from '$lib/rse/font-detection';

const type = await detectFontTypeFromFile(fileObject);
// Returns: 'SMALL' | 'LARGE' | null
```

## Development Notes

### Architecture

- **Main thread**: Font loading, validation, canvas rendering, pixel extraction
- **Worker thread**: V8 encoding, firmware writing, verification

This split is necessary because Web Workers don't have DOM access to `canvas`, `document.fonts`, or `FontFace` APIs.

### Testing

Unit tests are provided for:
- Font type detection (`font-detection.test.ts`)
- Tofu comparison logic (`tofu-comparison.test.ts`)
- QA verification (`font-verification.test.ts`)

Run tests with: `bun test`
