# FlameOcean

A web-based firmware customization tool for Snowsky Echo Mini devices. FlameOcean allows you to extract, view, and replace resources embedded in Snowsky firmware binaries.

## Features

- **Firmware Analysis**: Parse and analyze Snowsky Echo Mini firmware files
- **Resource Extraction**: Extract and display font glyphs (SMALL/LARGE) organized by Unicode planes
- **Image Viewing**: View embedded bitmap images in RGB565 format
- **Image Replacement**: Replace firmware images with custom ones via drag-and-drop, paste, or file selection
- **Font Replacement**: Replace firmware fonts with custom pixel/bitmap fonts via drag-and-drop or paste
- **Batch Operations**: Replace multiple images at once by filename matching
- **Export**: Download modified firmware or export all images as a ZIP archive for easy editing

## Tech Stack

- Svelte 5 + SvelteKit
- TypeScript
- Web Workers for heavy processing

## Usage

1. Open the application in a web browser
2. Drop a firmware file (`.bin`) onto the window or click to browse
3. Navigate the resource tree to view fonts and images
4. Replace images by:
   - Dragging and dropping image files onto the viewer
   - Pasting images from clipboard (Ctrl+V)
   - Clicking the edit button and selecting files
5. Replace fonts by:
   - Dragging and dropping font files (.ttf, .otf, .woff, .woff2) onto the font viewer
   - Pasting font files from clipboard (Ctrl+V)
   - See [docs/font-replacement.md](docs/font-replacement.md) for detailed information
6. Export the modified firmware (Ctrl+S)

## Compatibility

This tool is designed and tested specifically for **Snowsky Echo Mini** firmware.

The underlying resource extraction logic may work with other Snowsky device firmware, but this has not been tested. Use at your own risk.

## WARNING

**This tool modifies device firmware. Improper use may brick your device.**

- Always backup your original firmware before making modifications
- Ensure replacement images match the exact dimensions of the original
- Flash modified firmware at your own risk
- There is no guarantee of recovery if something goes wrong

## NO SUPPORT

**Don't ask me for help.**

This tool is provided as-is, without any warranty or support. I will not provide:

- Troubleshooting assistance
- Recovery guidance for bricked devices
- Pay you for the broken device

Complaining to me about bricked devices will only earn you my scorn σ`∀´) .

## Development

```bash
bun install
bun run dev
```

## Building

```bash
bun run build
```

The static site will be output to `build/`.
