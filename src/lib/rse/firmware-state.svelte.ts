import FirmwareWorker from "$lib/workers/firmware-worker.ts?worker";
import {
  unloadFontFile,
  loadAndValidateFontFile,
  FontLoadingError,
  type FontLoadingResult,
} from "$lib/rse/utils/font-loading";
import { fileIO } from "$lib/rse/utils/file-io";
import {
  loadTofuFont,
  setTofuDebugMode,
  RARE_TEST_CHARS,
  type TofuDebugData,
} from "$lib/rse/utils/tofu-font";
import { detectTofu } from "$lib/rse/utils/tofu-detector";
import { imageToRgb565 } from "$lib/rse/utils/bitmap";
import { UNICODE_RANGES } from "$lib/rse/utils/unicode-ranges";
import { debugMode, debugAnimationComplete } from "$lib/stores";
import { extractThemeColors, type ColorWrite } from "$lib/rse/theme";
import { ThemePatcher } from "$lib/rse/theme/patcher.js";
import { ThemeColorExtractor } from "$lib/rse/theme/extractor.js";
import { patchSwitchCaseFunction } from "$lib/rse/theme/switch-case-patcher.js";

// Types
export interface FontPlaneInfo {
  name: string;
  start: number;
  end: number;
  smallCount: number;
  largeCount: number;
  estimatedCount: number;
  fontType: "SMALL" | "LARGE";
}

export interface BitmapFileInfo {
  name: string;
  width: number;
  height: number;
  size: number;
  offset?: number;
}

export interface ColorNodeData {
  themeId?: number;
  parentType?: 'menu' | 'flac' | 'progress' | 'marquee';
}

export interface TreeNode {
  id: string;
  label: string;
  type: "folder" | "font-type" | "plane" | "image" | "colors";
  data?: FontPlaneInfo | BitmapFileInfo | ColorNodeData;
  children?: TreeNode[];
}

export interface ColorEntry {
  semantic: string;
  color: number;
  themeId?: number;
  register?: number;
  instruction?: string;
  address?: string;
  rawBytes?: number[];
  movwInstruction?: string;
  movwAddress?: string;
  strhInstruction?: string;
  strhAddress?: string;
  isPatched?: boolean;
  isFlacPatched?: boolean;
}

export interface SequenceReplacement {
  imageName: string;
  width: number;
  height: number;
  offset: number;
  rgb565Data: Uint8Array;
}

export class FirmwareState {
  // Worker is the SINGLE SOURCE OF TRUTH for firmware data
  // originalFirmwareData is only kept for reference/revert purposes
  originalFirmwareData = $state<Uint8Array | null>(null);
  worker = $state<Worker | null>(null);
  isProcessing = $state(false);
  progress = $state(0);
  statusMessage = $state("Ready to load firmware");
  loadingTitle = $state<string | undefined>(undefined);
  selectedNode = $state<TreeNode | null>(null);
  expandedNodes = $state(new Set<string>());
  treeNodes = $state<TreeNode[]>([]);

  imageList = $state<BitmapFileInfo[]>([]);
  planeData = $state<{
    name: string;
    start: number;
    end: number;
    fonts: Array<{
      unicode: number;
      fontType: "SMALL" | "LARGE";
      pixels: boolean[][];
    }>;
  } | null>(null);
  imageData = $state<{
    name: string;
    width: number;
    height: number;
    rgb565Data: Uint8Array;
  } | null>(null);

  // Color data state
  colorData = $state<{
    menuColors: ColorEntry[];
    flacColors: ColorEntry[];
    progressColors: ColorEntry[];
    marqueeColors: ColorEntry[];
  } | null>(null);

  // Color detail window state
  showColorDetail = $state(false);
  selectedColorDetail = $state<ColorEntry | null>(null);

  // Color picker state
  showColorPicker = $state(false);
  colorPickerTarget = $state<{
    type: 'progress' | 'marquee' | 'flac';
    themeId: number;
  } | null>(null);

  // FLAC patch detection state
  flacPatched = $state(false);
  flacPatchAddress = $state<number | null>(null);

  // FLAC operation state
  private _pendingFlacOperation = false;
  private _flacOperationType: 'unlock' | 'edit' | null = null;
  private _flacOperationThemeId = 0;

  // Warning dialog state
  showWarning = $state(false);
  warningTitle = $state("");
  warningMessage = $state("");

  // Font debug window state
  showFontDebug = $state(false);
  fontDebugFileName = $state("");
  fontDebugMessage = $state("");
  fontDebugImages = $state<import("$lib/rse/utils/font-detection").FontDebugImage[]>([]);

  // Tofu debug window state
  showTofuDebug = $state(false);

  // Font size confirmation dialog state
  showFontSizeConfirmation = $state(false);
  pendingFontConfirmation = $state<{
    fontFamily: string;
    fontData: ArrayBuffer;
    fileName: string;
    debugImages?: import("$lib/rse/utils/font-detection").FontDebugImage[];
  } | null>(null);
  tofuDebugData = $state<TofuDebugData[]>([]);
  pendingReplacement = $state<{
    fontFamily: string;
    fontSize: 12 | 16;
    fontType: "SMALL" | "LARGE";
    codePoints: number[];
  } | null>(null);
  previewFontResult: FontLoadingResult | null = $state(null);

  replacedImages = $state<string[]>([]);
  replacedSmallFontCharacters = $state<Set<number>>(new Set());
  replacedLargeFontCharacters = $state<Set<number>>(new Set());

  debug = $state(false);
  debugAnimComplete = $state(true);

  constructor() {
    debugMode.subscribe((value) => {
      this.debug = value;
      setTofuDebugMode(value);
    });
    debugAnimationComplete.subscribe((value) => {
      this.debugAnimComplete = value;
    });
  }

  showLoadingWindow = $derived(
    this.isProcessing || (this.debug && !this.debugAnimComplete),
  );

  init() {
    this.worker = new FirmwareWorker();

    this.worker.onmessage = (e: MessageEvent) => {
      const { type, id, result, error, message } = e.data;

      if (type === "success") {
        if (id === "analyze") {
          if (this._pendingFlacOperation) {
            // FLAC unlock/edit in progress - handle completion specially
            // Don't clear the flag yet - it will be cleared after listImages completes
            this.statusMessage = "FLAC operation in progress. Loading resources...";
            // loadResources will call back into this handler for listPlanes/listImages
            this.loadResources();
          } else {
            this.statusMessage = "Firmware analyzed. Loading resources...";
            this.loadResources();
          }
        } else if (id === "listPlanes") {
          const planes = result as FontPlaneInfo[];
          this.buildFontTree(planes);
        } else if (id === "listImages") {
          const images = result as BitmapFileInfo[];
          this.imageList = images;
          // buildImageTree is now async, need to handle it properly
          this.buildImageTree(images)
            .then(() => {
              // Successfully completed
              // Check if this was a FLAC operation and handle completion
              if (this._pendingFlacOperation && this._flacOperationType) {
                const opType = this._flacOperationType;
                const themeId = this._flacOperationThemeId;
                this._pendingFlacOperation = false;
                this._flacOperationType = null;
                this._flacOperationThemeId = 0;

                if (opType === 'unlock') {
                  // FLAC unlock completed successfully
                  // buildColorTree() has already detected the patch status from the firmware
                  // Force update the selected color detail to reflect the new status
                  if (this.selectedColorDetail && this.selectedColorDetail.semantic.includes('Codec Info')) {
                    this.selectedColorDetail = {
                      ...this.selectedColorDetail,
                      isFlacPatched: this.flacPatched  // Update with new patch status
                    };
                  }
                  this.progress = 100;
                  this.statusMessage = "FLAC color editing unlocked successfully!";
                  setTimeout(() => {
                    this.showLoadingWindow = false;
                    this.isProcessing = false;
                  }, 500);
                } else if (opType === 'edit') {
                  // FLAC color edit completed successfully
                  this.progress = 100;
                  this.statusMessage = `Successfully updated FLAC color for theme ${themeId}`;

                  // Close color picker
                  this.showColorPicker = false;
                  this.colorPickerTarget = null;

                  setTimeout(() => {
                    this.showLoadingWindow = false;
                    this.isProcessing = false;

                    // Re-open the color detail with updated data
                    if (this.selectedColorDetail) {
                      const updatedEntry = this.colorData?.flacColors.find(c => c.themeId === themeId);
                      if (updatedEntry) {
                        this.selectedColorDetail = { ...updatedEntry, isFlacPatched: this.flacPatched };
                      }
                    }
                  }, 500);
                }
              } else {
                this.isProcessing = false;
                this.statusMessage = "Firmware loaded successfully";
              }
            })
            .catch(err => {
              console.error('Error building image tree:', err);
              this.statusMessage = `Error loading resources: ${err instanceof Error ? err.message : String(err)}`;
              this.isProcessing = false;
              this._pendingFlacOperation = false;
              this._flacOperationType = null;
              this._flacOperationThemeId = 0;
            });
        } else if (id === "extractPlane") {
          const data = result as any;
          this.planeData = data;
          this.isProcessing = false;
          this.statusMessage = `Loaded plane: ${data?.name ?? "Unknown"}`;
        } else if (id === "extractImage") {
          const data = result as any;
          this.imageData = data;
          this.isProcessing = false;
          this.statusMessage = `Loaded image: ${data?.name ?? "Unknown"}`;
        }
      } else if (type === "progress") {
        this.statusMessage = message;
      } else if (type === "error") {
        this.statusMessage = `Error: ${error}`;
        this.isProcessing = false;
      }
    };

    this.worker.onerror = (err) => {
      this.statusMessage = `Worker error: ${err.message}`;
      this.isProcessing = false;
    };

    return () => {
      this.worker?.terminate();
    };
  }

  /**
   * Get current firmware data from worker (single source of truth)
   * Use this whenever you need the current firmware state
   */
  async getFirmwareFromWorker(): Promise<Uint8Array> {
    const worker = this.worker;
    if (!worker) {
      throw new Error("Worker not initialized");
    }

    return new Promise((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        const { type, id, result, error } = e.data;
        if (id === "getFirmware") {
          worker.removeEventListener("message", handler);
          if (type === "success") {
            resolve(result as Uint8Array);
          } else {
            reject(new Error(error || "Failed to get firmware from worker"));
          }
        }
      };
      worker.addEventListener("message", handler);
      worker.postMessage({
        type: "getFirmware",
        id: "getFirmware",
        firmware: new Uint8Array(), // Empty, worker returns cached data
      });
    });
  }

  async loadResources() {
    if (!this.worker) return;

    this.worker.postMessage({
      type: "listPlanes",
      id: "listPlanes",
      firmware: new Uint8Array(),
    });

    this.worker.postMessage({
      type: "listImages",
      id: "listImages",
      firmware: new Uint8Array(),
    });
  }

  buildFontTree(planes: FontPlaneInfo[]) {
    const smallPlanes = planes
      .filter((p) => p.smallCount > 0)
      .map((plane) => ({
        id: `plane-small-${plane.name}`,
        label: `${plane.name} (${plane.smallCount})`,
        type: "plane" as const,
        data: { ...plane, fontType: "SMALL" as const },
        children: [],
      }));

    const largePlanes = planes
      .filter((p) => p.largeCount > 0)
      .map((plane) => ({
        id: `plane-large-${plane.name}`,
        label: `${plane.name} (${plane.largeCount})`,
        type: "plane" as const,
        data: { ...plane, fontType: "LARGE" as const },
        children: [],
      }));

    // Preserve existing non-font nodes (images, colors) during rebuild
    const existingNodes = this.treeNodes.slice(1).filter(n => n.id !== "fonts");

    this.treeNodes = [
      {
        id: "fonts",
        label: "Fonts",
        type: "folder",
        children: [
          {
            id: "fonts-small",
            label: "SMALL Fonts",
            type: "font-type",
            children: smallPlanes,
          },
          {
            id: "fonts-large",
            label: "LARGE Fonts",
            type: "font-type",
            children: largePlanes,
          },
        ],
      },
      ...existingNodes,
    ];
  }

  async buildImageTree(images: BitmapFileInfo[]) {
    const imageNodes = images.map((img, idx) => {
      return {
        id: `image-${idx}`,
        label: img.name,
        type: "image" as const,
        data: img,
        children: [],
      };
    });

    const imagesNode = {
      id: "images",
      label: "Firmware Images",
      type: "folder" as const,
      children: imageNodes,
    };

    if (this.treeNodes.length > 0 && this.treeNodes[0].id === "fonts") {
      // Insert or replace images node after fonts node, preserve other nodes (like colors)
      const imagesIndex = this.treeNodes.findIndex(n => n.id === "images");
      if (imagesIndex !== -1) {
        this.treeNodes[imagesIndex] = imagesNode;
      } else {
        this.treeNodes = [this.treeNodes[0], imagesNode, ...this.treeNodes.slice(1)];
      }
    } else {
      this.treeNodes = [...this.treeNodes, imagesNode];
    }

    // Build color tree after images (last async operation)
    await this.buildColorTree();
  }

  async buildColorTree() {
    try {
      // Get firmware from worker (single source of truth)
      const firmwareData = await this.getFirmwareFromWorker();

      const patcher = new ThemePatcher(firmwareData, 'Unknown');
      const analysis = patcher.analyze();

      if (analysis.themeFunctions.length === 0) {
        return;
      }

      if (!analysis.canPatch) {
        return;
      }

      // Use patch detection results from analysis (no manual detection needed)
      this.flacPatched = analysis.patchStatus.flacPatched;
      this.flacPatchAddress = analysis.themeFunctions.find(f => f.type === 'flac')?.patchAddr ?? null;

      // Get theme functions with color writes for building the color tree
      // Note: extractThemeColors() populates colorWrites via simulation,
      // which we need for the UI. PatchPointInfo doesn't have this.
      const result = extractThemeColors(firmwareData);

      // Extract Menu colors (R0-R14 typically)
      const menuColorEntries: ColorEntry[] = [];
      const flacColorEntries: ColorEntry[] = [];
      const progressColorEntries: ColorEntry[] = [];
      const marqueeColorEntries: ColorEntry[] = [];

      // Register meaning mapping based on Python implementation
      // R1: Highlight/Foreground color
      // R2: Secondary color
      // R3: Foreground color
      const registerMeaning: Record<number, string> = {
        1: 'Highlight',
        2: 'Secondary',
        3: 'Foreground'
      };

      for (const func of result.themeFunctions) {
        if (func.type === 'menu' || func.uiElement.includes('Menu')) {
          // IMPORTANT: The simulator outputs ALL writes from ALL themes mixed together.
          // We need to filter by write.themeCondition to get the correct writes for each theme.
          // The extractor already simulates each theme separately, so func.colorWrites
          // contains writes from themes 0,1,2,3,4 all in one array.

          // Group writes by their themeCondition
          const writesByTheme: Map<number, ColorWrite[]> = new Map();
          for (const write of func.colorWrites) {
            const themeId = write.themeCondition ?? 0;
            if (!writesByTheme.has(themeId)) {
              writesByTheme.set(themeId, []);
            }
            writesByTheme.get(themeId)!.push(write);
          }

          // Now process each theme's writes separately
          for (const [targetTheme, themeWrites] of writesByTheme) {
            // Collect colors per theme, keeping only the LAST write to each register
            const themeColors: Map<number, ColorEntry> = new Map();

            for (const write of themeWrites) {
              // Only collect writes to R1, R2, R3 (these are the main color registers)
              if (write.targetReg !== 1 && write.targetReg !== 2 && write.targetReg !== 3) {
                continue;
              }

              // Format instructions like Python version: 0x3F894: MOVW R6, #0x2945
              const strhAddr = '0x' + write.addr.toString(16).toUpperCase().padStart(5, '0');
              const strhInstr = write.instr ? `${write.instr.mnemonic} ${write.instr.operands}` : 'STRH';

              let movwAddr: string | undefined;
              let movwInstr: string | undefined;
              if (write.movwInstr) {
                movwAddr = '0x' + write.movwInstr.addr.toString(16).toUpperCase().padStart(5, '0');
                movwInstr = `${write.movwInstr.instr.mnemonic} ${write.movwInstr.instr.operands}`;
              } else if (write.sourceReg === 12) {
                // R12 indicates preloaded value
                movwAddr = undefined;
                movwInstr = '(preload)';
              }

              // Get semantic meaning from target register (R1=Highlight, R2=Secondary, R3=Foreground)
              const registerMeaningKey = registerMeaning[write.targetReg] ?? `R${write.targetReg}`;

              // Create color entry
              const colorEntry: ColorEntry = {
                semantic: registerMeaningKey,
                color: write.colorValue,
                themeId: targetTheme,
                register: write.targetReg,
                movwAddress: movwAddr,
                movwInstruction: movwInstr,
                strhAddress: strhAddr,
                strhInstruction: strhInstr,
                isPatched: false
              };

              // Store in map - later writes to same register overwrite earlier ones
              // This gives us the FINAL color value for each register
              themeColors.set(write.targetReg, colorEntry);
            }

            // Add this theme's colors to the main array
            for (const [, entry] of themeColors) {
              menuColorEntries.push(entry);
            }
          }
        }

        if (func.type === 'flac' || func.uiElement.includes('FLAC')) {
          // For FLAC, use flacBehavior to generate all 5 theme colors
          // The simulator only gives us colorWrites for one theme branch, not all 5
          // flacBehavior has colorFor4 and colorForOther, plus instruction details

          if (result.flacBehavior.isFlac) {
            // Extract instruction addresses from flacBehavior
            const movwAddr4 = result.flacBehavior.movwAddr4 || '-';
            const movwInstr4 = result.flacBehavior.movwInstr4 || '-';
            const movwAddrOther = result.flacBehavior.movwAddrOther || '-';
            const movwInstrOther = result.flacBehavior.movwInstrOther || '-';

            // Also get STRH details from first colorWrite (if available)
            let strhAddr = '-';
            let strhInstr = '-';
            if (func.colorWrites.length > 0) {
              const write = func.colorWrites[0];
              strhAddr = '0x' + write.addr.toString(16).toUpperCase().padStart(5, '0');
              strhInstr = write.instr ? `${write.instr.mnemonic} ${write.instr.operands}` : 'STRH';
            }

            // Generate all 5 FLAC colors using flacBehavior
            for (let themeId = 0; themeId < 5; themeId++) {
              // Use flacColors array if available (from metadata), otherwise fall back to colorFor4/colorForOther
              const color = result.flacBehavior.flacColors && result.flacBehavior.flacColors.length === 5
                ? result.flacBehavior.flacColors[themeId]
                : (themeId === 4 ? result.flacBehavior.colorFor4 : result.flacBehavior.colorForOther);
              const movwAddr = themeId === 4 ? movwAddr4 : movwAddrOther;
              const movwInstr = themeId === 4 ? movwInstr4 : movwInstrOther;

              flacColorEntries.push({
                semantic: 'Codec Info',
                color: color,
                themeId: themeId,
                register: undefined,
                movwAddress: movwAddr === '-' ? undefined : movwAddr,
                movwInstruction: movwInstr === '-' ? undefined : movwInstr,
                strhAddress: strhAddr === '-' ? undefined : strhAddr,
                strhInstruction: strhInstr === '-' ? undefined : strhInstr,
                isPatched: this.flacPatched
              });
            }
          } else {
            // Fallback: extract from colorWrites (may not have all themes)
            for (const write of func.colorWrites) {
              const strhAddr = '0x' + write.addr.toString(16).toUpperCase().padStart(5, '0');
              const strhInstr = write.instr ? `${write.instr.mnemonic} ${write.instr.operands}` : 'STRH';

              let movwAddr: string | undefined;
              let movwInstr: string | undefined;
              if (write.movwInstr) {
                movwAddr = '0x' + write.movwInstr.addr.toString(16).toUpperCase().padStart(5, '0');
                movwInstr = `${write.movwInstr.instr.mnemonic} ${write.movwInstr.instr.operands}`;
              }

              flacColorEntries.push({
                semantic: 'Codec Info',
                color: write.colorValue,
                themeId: write.themeCondition ?? undefined,
                register: write.sourceReg,
                movwAddress: movwAddr,
                movwInstruction: movwInstr,
                strhAddress: strhAddr,
                strhInstruction: strhInstr,
                isPatched: this.flacPatched
              });
            }
          }
        }

        if (func.type === 'progress') {
          // Progress Bar uses preloadColors (switch_case pattern)
          for (let themeId = 0; themeId < 5; themeId++) {
            const color = func.preloadColors[themeId] ?? 0;
            const movwRecord = func.preloadMovwRecords?.[themeId];

            let movwAddr: string | undefined;
            let movwInstr: string | undefined;
            if (movwRecord) {
              movwAddr = '0x' + movwRecord.addr.toString(16).toUpperCase().padStart(5, '0');
              movwInstr = `${movwRecord.instr.mnemonic} ${movwRecord.instr.operands}`;
            }

            progressColorEntries.push({
              semantic: 'Progress Bar',
              color: color,
              themeId: themeId,
              register: undefined,
              movwAddress: movwAddr,
              movwInstruction: movwInstr,
              strhAddress: undefined,
              strhInstruction: undefined,
              isPatched: false
            });
          }
        }

        if (func.type === 'marquee') {
          // Marquee Overlay uses preloadColors (switch_case pattern)
          for (let themeId = 0; themeId < 5; themeId++) {
            const color = func.preloadColors[themeId] ?? 0;
            const movwRecord = func.preloadMovwRecords?.[themeId];

            let movwAddr: string | undefined;
            let movwInstr: string | undefined;
            if (movwRecord) {
              movwAddr = '0x' + movwRecord.addr.toString(16).toUpperCase().padStart(5, '0');
              movwInstr = `${movwRecord.instr.mnemonic} ${movwRecord.instr.operands}`;
            }

            marqueeColorEntries.push({
              semantic: 'Marquee Overlay',
              color: color,
              themeId: themeId,
              register: undefined,
              movwAddress: movwAddr,
              movwInstruction: movwInstr,
              strhAddress: undefined,
              strhInstruction: undefined,
              isPatched: false
            });
          }
        }
      }

      // Remove duplicates
      const uniqueMenuColors = this.deduplicateColors(menuColorEntries);
      const uniqueFlacColors = this.deduplicateColors(flacColorEntries);
      const uniqueProgressColors = this.deduplicateColors(progressColorEntries);
      const uniqueMarqueeColors = this.deduplicateColors(marqueeColorEntries);

      this.colorData = {
        menuColors: uniqueMenuColors,
        flacColors: uniqueFlacColors,
        progressColors: uniqueProgressColors,
        marqueeColors: uniqueMarqueeColors
      };

      // Build color tree node with theme sub-nodes for Menu colors
      // Create 5 theme sub-nodes for Menu colors (Theme 0-4)
      const menuThemeNodes: TreeNode[] = [];
      for (let themeId = 0; themeId < 5; themeId++) {
        const nodeData: ColorNodeData = { themeId, parentType: 'menu' };
        menuThemeNodes.push({
          id: `colors-menu-theme-${themeId}`,
          label: `Theme ${themeId}`,
          type: 'colors' as const,
          data: nodeData
        });
      }

      const menuColorNode: TreeNode = {
        id: 'colors-menu',
        label: 'General Text Colors',
        type: 'folder' as const,
        children: menuThemeNodes
      };

      // FLAC colors remain as a single node (no theme sub-groups)
      const flacNodeData: ColorNodeData = { parentType: 'flac' };
      const flacColorNode: TreeNode = {
        id: 'colors-flac',
        label: 'Codec Information Color',
        type: 'colors' as const,
        data: flacNodeData
      };

      // Progress Bar colors (single node with theme filtering in UI)
      const progressNodeData: ColorNodeData = { parentType: 'progress' };
      const progressColorNode: TreeNode = {
        id: 'colors-progress',
        label: 'Progress Bar Background',
        type: 'colors' as const,
        data: progressNodeData
      };

      // Marquee Overlay colors (single node with theme filtering in UI)
      const marqueeNodeData: ColorNodeData = { parentType: 'marquee' };
      const marqueeColorNode: TreeNode = {
        id: 'colors-marquee',
        label: 'Marquee Overlay Color',
        type: 'colors' as const,
        data: marqueeNodeData
      };

      const colorsNode: TreeNode = {
        id: 'colors',
        label: 'Colors',
        type: 'folder' as const,
        children: [menuColorNode, flacColorNode, progressColorNode, marqueeColorNode]
      };

      // Check if colors node already exists and update it in-place to preserve expanded state
      const existingColorsIndex = this.treeNodes.findIndex(n => n.id === 'colors');
      if (existingColorsIndex !== -1) {
        // Update existing node in-place to preserve the array reference
        this.treeNodes[existingColorsIndex] = colorsNode;
      } else {
        // Add to tree nodes if it doesn't exist
        this.treeNodes = [...this.treeNodes, colorsNode];
      }
    } catch (error) {
      // Log error for debugging
      console.error('Error building color tree:', error);
      // Don't add Colors node if extraction fails
    }
  }

  deduplicateColors(entries: ColorEntry[]): ColorEntry[] {
    const seen = new Set<string>();
    return entries.filter(entry => {
      // Include themeId in the key so entries with different themes are not deduplicated
      const key = `${entry.semantic}-${entry.color}-${entry.themeId ?? 'unknown'}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  handleNodeClick(node: TreeNode) {
    if (this.isProcessing) return;

    this.planeData = null;
    this.imageData = null;
    this.selectedNode = node;

    if (node.type === "plane" && node.data) {
      this.loadPlane(node.data as FontPlaneInfo);
    } else if (node.type === "image" && node.data) {
      const image = node.data as BitmapFileInfo;
      if (image.offset === undefined) {
        this.statusMessage = `Error: Image ${image.name} has no offset information`;
        return;
      }
      this.loadImage(image);
    } else if (node.type === "colors") {
      this.statusMessage = `Viewing ${node.label}`;
    }
  }

  openColorDetail(entry: ColorEntry) {
    // Include FLAC patch status for Codec Info colors
    const detailWithFlacStatus = { ...entry };
    if (entry.semantic.includes('Codec Info')) {
      detailWithFlacStatus.isFlacPatched = this.flacPatched;
    }
    this.selectedColorDetail = detailWithFlacStatus;
    this.showColorDetail = true;
  }

  showFlacUnlockWarning() {
    this.showWarningDialog(
      "Unlock FLAC Color Editing",
      "This will modify the firmware to enable FLAC color customization.\n\n" +
      "This operation:\n" +
      "- Injects custom code into the firmware (NOP slide)\n" +
      "- Modifies the FLAC function to use injected handlers\n" +
      "- Cannot be easily undone\n" +
      "- May affect firmware stability if done incorrectly\n\n" +
      "Do you want to continue?"
    );
    // Store the pending FLAC unlock action
    this.pendingFlacUnlock = true;
  }

  pendingFlacUnlock = $state(false);

  handleSelectNode(nodeId: string) {
    const node = this.findNodeById(this.treeNodes, nodeId);
    if (node) {
      this.handleNodeClick(node);
    }
  }

  findNodeById(nodes: TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = this.findNodeById(node.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  loadPlane(plane: FontPlaneInfo) {
    if (!this.worker || this.isProcessing) return;

    this.isProcessing = true;
    this.statusMessage = `Extracting ${plane.name} (${plane.fontType})...`;
    this.imageData = null;

    this.worker.postMessage({
      type: "extractPlane",
      id: "extractPlane",
      firmware: new Uint8Array(), // Worker has cached copy
      fontType: plane.fontType,
      planeName: plane.name,
      start: plane.start,
      end: plane.end,
    });
  }

  loadImage(image: BitmapFileInfo) {
    if (!this.worker || this.isProcessing) return;

    this.isProcessing = true;
    this.statusMessage = `Extracting ${image.name}...`;
    this.planeData = null;

    this.worker.postMessage({
      type: "extractImage",
      id: "extractImage",
      firmware: new Uint8Array(), // Worker has cached copy
      imageName: image.name,
      width: image.width,
      height: image.height,
      offset: image.offset,
    });
  }

  async loadFirmware(file: File) {
    this.isProcessing = true;
    this.progress = 10;
    this.statusMessage = `Loading ${file.name}...`;

    try {
      const arrayBuffer = await file.arrayBuffer();
      const firmwareData = new Uint8Array(arrayBuffer);
      this.originalFirmwareData = new Uint8Array(arrayBuffer);

      this.replacedImages = [];
      this.replacedSmallFontCharacters = new Set();
      this.replacedLargeFontCharacters = new Set();

      this.progress = 30;
      this.statusMessage = "Analyzing firmware...";

      // Send firmware to worker - worker becomes the source of truth
      this.worker!.postMessage({
        type: "analyze",
        id: "analyze",
        firmware: firmwareData,
      });

      this.progress = 100;
    } catch (err) {
      this.statusMessage = `Error loading file: ${err}`;
      this.isProcessing = false;
    }
  }

  showWarningDialog(title: string, message: string) {
    this.warningTitle = title;
    this.warningMessage = message;
    this.showWarning = true;
  }

  handleWarningConfirm() {
    // Handle FLAC unlock confirmation
    if (this.pendingFlacUnlock) {
      this.pendingFlacUnlock = false;
      this.performFlacUnlock();
    }
    this.showWarning = false;
  }

  handleWarningCancel() {
    // Cancel FLAC unlock
    if (this.pendingFlacUnlock) {
      this.pendingFlacUnlock = false;
      this.statusMessage = "FLAC unlock cancelled";
    }
    this.showWarning = false;
  }

  async performFlacUnlock() {
    // Get firmware from worker (single source of truth)
    const firmwareData = await this.getFirmwareFromWorker();

    this.isProcessing = true;
    this.showLoadingWindow = true;
    this.loadingTitle = "Unlocking FLAC Color Editing";
    this.progress = 10;
    this.statusMessage = "Patching firmware...";

    // Let the UI render the loading window before doing heavy work
    await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

    try {
      // Extract current FLAC colors from firmware
      const result = extractThemeColors(firmwareData);

      const flacFunc = result.themeFunctions.find(f => f.type === 'flac');
      if (!flacFunc) {
        throw new Error("FLAC function not found in firmware");
      }

      // Extract current FLAC colors using getColorsForFunction
      // This correctly handles both patched and unpatched firmware
      const extractor = new ThemeColorExtractor(firmwareData);
      const currentFlacColors = extractor.getColorsForFunction('flac');

      console.error('[DEBUG] Original FLAC colors:', currentFlacColors.map(c => '0x' + c.toString(16)));

      // Extract Menu colors (required for patching)
      // Use getColorsForFunction to correctly handle both patched and unpatched firmware
      const currentMenuColors = extractor.getColorsForFunction('menu');

      this.progress = 30;
      this.statusMessage = "Applying FLAC patch...";

      // Apply the patch using the worker (non-blocking)
      const patchedData = await new Promise<Uint8Array>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const { type, id: responseId, result, error } = e.data;
          if (responseId === "patchTheme") {
            if (type === "success") {
              this.worker!.removeEventListener("message", handler);
              const patchResult = result as { patchedData: Uint8Array; nopSlide: { start: number; end: number; size: number }; metadataAddr: number };
              resolve(patchResult.patchedData);
            } else if (type === "progress") {
              const data = e.data as { message: string };
              this.statusMessage = data.message;
              // Update progress based on the message
              if (data.message.includes("Preparing")) {
                this.progress = 35;
              } else if (data.message.includes("Analyzing")) {
                this.progress = 45;
              } else if (data.message.includes("applied")) {
                this.progress = 55;
              }
            } else if (type === "error") {
              this.worker!.removeEventListener("message", handler);
              reject(new Error(error || "Worker patching failed"));
            }
          }
        };
        this.worker!.addEventListener("message", handler);
        this.worker!.postMessage({
          type: "patchTheme",
          id: "patchTheme",
          firmware: firmwareData,
          flacColors: currentFlacColors,
          menuColors: currentMenuColors,
        });
      });

      this.progress = 60;
      this.statusMessage = "Verifying patch...";

      // Round-trip verification: extract colors from patched firmware
      const verifyResult = extractThemeColors(patchedData);
      const verifyFlacFunc = verifyResult.themeFunctions.find(f => f.type === 'flac');

      if (!verifyFlacFunc) {
        throw new Error("FLAC function not found in patched firmware - verification failed");
      }

      // Verify FLAC colors using getColorsForFunction
      // This correctly handles both original and patched firmware
      const verifyExtractor = new ThemeColorExtractor(patchedData);
      const actualFlacColors = verifyExtractor.getColorsForFunction('flac');

      console.error('[DEBUG] Patched FLAC colors:', actualFlacColors.map(c => '0x' + c.toString(16)));

      for (let i = 0; i < 5; i++) {
        const expectedColor = currentFlacColors[i];
        const actualColor = actualFlacColors[i];

        if (actualColor !== expectedColor) {
          throw new Error(`FLAC color verification failed for theme ${i}: expected 0x${expectedColor.toString(16)}, got 0x${actualColor.toString(16)}`);
        }
      }

      this.progress = 80;
      this.statusMessage = "Reloading firmware...";

      // Set flag to indicate FLAC unlock operation is in progress
      this._pendingFlacOperation = true;
      this._flacOperationType = 'unlock';

      // Send patched firmware to worker - main handler will process the response
      this.worker!.postMessage({
        type: "analyze",
        id: "analyze",
        firmware: patchedData,
      });

      // The rest of the workflow (loading resources, setting flacPatched, etc.)
      // will be handled by the main worker message handler
    } catch (err) {
      this.showLoadingWindow = false;
      this.isProcessing = false;
      this._pendingFlacOperation = false;
      this._flacOperationType = null;
      this.showWarningDialog("FLAC Unlock Failed", `Failed to unlock codec information color editing:\n${err instanceof Error ? err.message : String(err)}`);
      this.statusMessage = "Unknown error";
    }
  }

  isFontFile(file: File): boolean {
    const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
    const FONT_MIME_TYPES = [
      "font/ttf", "font/otf", "font/woff", "font/woff2",
      "application/font-ttf", "application/font-otf", "application/font-woff", "application/font-woff2",
      "application/x-font-ttf", "application/x-font-otf", "application/x-font-woff",
    ];
    const fileName = file.name.toLowerCase();
    return FONT_EXTENSIONS.some((ext) => fileName.endsWith(ext)) || FONT_MIME_TYPES.includes(file.type);
  }

  async handlePasteFiles(files: File[]) {
    const fontFiles = files.filter(f => this.isFontFile(f));
    const imageFiles = files.filter((f) => !this.isFontFile(f));

    if (fontFiles.length > 0) {
      await this.replaceFont(fontFiles[0]);
      return;
    }

    if (this.imageList.length === 0) {
      this.showWarningDialog("Error", "No firmware loaded or no images available.");
      return;
    }

    if (!this.worker) {
      this.showWarningDialog("Error", "Worker not available.");
      return;
    }

    this.isProcessing = true;
    this.statusMessage = `Preparing to replace ${imageFiles.length} image(s)...`;

    const replacements: Array<{
      image: BitmapFileInfo;
      rgb565Data: Uint8Array;
    }> = [];
    const notFound: string[] = [];
    const decodeError: string[] = [];

    const conversionPromises = imageFiles.map(async (file) => {
      const pastedFileName = file.name.replace(/\.[^.]*$/, "").toUpperCase();
      const matchingImage = this.imageList.find(
        (img) => img.name.replace(/\.[^.]*$/, "").toUpperCase() === pastedFileName,
      );

      if (!matchingImage) {
        notFound.push(file.name);
        return null;
      }

      if (!matchingImage.offset) {
        decodeError.push(`${file.name}: No offset information`);
        return null;
      }

      try {
        const rgb565Result = await imageToRgb565(file, matchingImage.width, matchingImage.height);
        if (!rgb565Result) {
          decodeError.push(`${file.name}: Dimension mismatch (expected ${matchingImage.width}x${matchingImage.height})`);
          return null;
        }
        return { image: matchingImage, rgb565Data: rgb565Result.rgb565Data };
      } catch (err) {
        decodeError.push(`${file.name}: Failed to decode`);
        return null;
      }
    });

    const results = await Promise.all(conversionPromises);
    for (const result of results) {
      if (result) replacements.push(result);
    }

    if (replacements.length === 0) {
      this.isProcessing = false;
      let message = "No valid images to replace.\n\n";
      if (notFound.length > 0) {
        message += `Not found in firmware (${notFound.length}):\n${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? "..." : ""}\n\n`;
      }
      if (decodeError.length > 0) {
        message += `Errors (${decodeError.length}):\n${decodeError.slice(0, 3).join("\n")}${decodeError.length > 3 ? "\n..." : ""}`;
      }
      this.showWarningDialog("Replacement Failed", message.trim());
      return;
    }

    this.statusMessage = `Sending ${replacements.length} image(s) to worker...`;

    await new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        const { type, id, result } = e.data;
        if (id === "replaceImages") {
          if (type === "success") {
            this.worker!.removeEventListener("message", handler);
            const data = result as any;
            for (const r of data.results) {
              if (this.imageData && this.imageData.name === r.imageName) {
                this.imageData = { ...this.imageData, rgb565Data: r.rgb565Data };
              }
              if (!this.replacedImages.includes(r.imageName)) {
                this.replacedImages = [...this.replacedImages, r.imageName];
              }
            }

            const totalErrors = notFound.length + decodeError.length + (data.notFound?.length || 0) + (data.dimensionMismatch?.length || 0) + (data.replaceError?.length || 0);

            if (totalErrors > 0) {
              let message = `Successfully replaced: ${data.successCount}\n\n`;
              if (notFound.length > 0) message += `Not found: ${notFound.slice(0, 5).join(", ")}\n`;
              this.showWarningDialog("Replacement Completed with Errors", message.trim());
            } else {
              this.statusMessage = `Successfully replaced ${data.successCount} image(s)`;
            }
            this.isProcessing = false;
            resolve();
          } else if (type === "error") {
            this.worker!.removeEventListener("message", handler);
            this.showWarningDialog("Replacement Error", `Failed to replace images: ${result}`);
            this.isProcessing = false;
            resolve();
          }
        }
      };
      this.worker!.addEventListener("message", handler);
      this.worker!.postMessage({
        type: "replaceImages",
        id: "replaceImages",
        firmware: new Uint8Array(),
        images: replacements.map((r) => ({
          imageName: r.image.name,
          width: r.image.width,
          height: r.image.height,
          offset: r.image.offset!,
          rgb565Data: r.rgb565Data,
        })),
      });
    });
  }

  async exportFirmware() {
    this.isProcessing = true;
    this.statusMessage = "Exporting firmware...";

    try {
      // Get firmware from worker (single source of truth)
      const firmwareData = await this.getFirmwareFromWorker();

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const filename = `firmware_modified_${timestamp}.bin`;
      await fileIO.writeFile(filename, firmwareData);
      this.statusMessage = `Firmware exported as ${filename}`;
    } catch (err) {
      this.showWarningDialog("Export Error", `Failed to export firmware: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async bundleImagesAsZip() {
    if (!this.worker) {
      this.showWarningDialog("Export Error", "No worker available.");
      return;
    }

    this.isProcessing = true;
    this.statusMessage = "Preparing image bundle...";

    try {
      // Get firmware from worker (single source of truth)
      const firmwareData = await this.getFirmwareFromWorker();

      const zipData = await new Promise<Uint8Array>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const data = e.data;
          if (data.id === "bundleImagesAsZip") {
            if (data.type === "success") {
              this.worker!.removeEventListener("message", handler);
              resolve(data.result as Uint8Array);
            } else if (data.type === "error") {
              this.worker!.removeEventListener("message", handler);
              reject(new Error(data.error || "Failed to bundle images"));
            }
          }
        };
        this.worker!.addEventListener("message", handler);
        // Pass current firmware data to worker
        this.worker!.postMessage({ type: "bundleImagesAsZip", id: "bundleImagesAsZip", firmware: firmwareData });
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const filename = `firmware_images_${timestamp}.zip`;
      await fileIO.writeFile(filename, zipData);
      this.statusMessage = `Images exported as ${filename}`;
    } catch (err) {
      this.showWarningDialog("Export Error", `Failed to bundle images: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  async replaceFont(file: File): Promise<void> {
    if (!this.worker) {
      this.showWarningDialog("Error", "No firmware loaded or worker not available.");
      return;
    }

    if (this.isProcessing) {
      this.showWarningDialog("Busy", "A replacement is already in progress. Please wait.");
      return;
    }

    this.isProcessing = true;
    this.loadingTitle = "Replacing Font Glyphs";
    this.statusMessage = `Loading font file: ${file.name}...`;
    this.progress = 0;

    let fontResult: FontLoadingResult | null = null;

    try {
      fontResult = await loadAndValidateFontFile(file);
      const { fontFamily, detectedType, isUncertain, debugImages, fontData, fileName: resultFileName } = fontResult;

      if (isUncertain) {
        this.pendingFontConfirmation = { fontFamily, fontData, fileName: resultFileName, debugImages };
        this.showFontSizeConfirmation = true;
        this.isProcessing = false;
        return;
      }

      if (!detectedType) {
        this.showWarningDialog("Invalid Font File", `The font file "${resultFileName}" could not be validated. Please ensure it is a pixel art font designed for 12px or 16px size.`);
        return;
      }

      const confirmedType = detectedType as "SMALL" | "LARGE";
      this.statusMessage = `Font loaded as ${confirmedType}. Preparing replacement...`;
      await loadTofuFont();

      const fontSize = confirmedType === "SMALL" ? 12 : 16;
      let codePointsToProcess: number[] = [];

      if (confirmedType === "SMALL") {
        for (const range of UNICODE_RANGES) {
          const start = Math.max(range.start, 0x0000);
          const end = Math.min(range.end, 0xffff);
          if (start <= end) {
            for (let cp = start; cp <= end; cp++) codePointsToProcess.push(cp);
          }
        }
      } else {
        for (let cp = 0x4e00; cp <= 0x9fff; cp++) codePointsToProcess.push(cp);
      }

      this.statusMessage = `Replacing ${codePointsToProcess.length} font characters...`;
      this.progress = 10;
      this.previewFontResult = fontResult;

      if (this.debug) {
        this.statusMessage = "Running tofu detection preview...";
        const previewCodePoints = [...codePointsToProcess.slice(0, 50), ...RARE_TEST_CHARS];
        await this.runTofuDetectionPreview(fontFamily, fontSize, previewCodePoints, fontData);

        if (this.tofuDebugData.length > 0) {
          this.pendingReplacement = { fontFamily, fontSize, fontType: confirmedType, codePoints: codePointsToProcess };
          this.showTofuDebug = true;
          this.isProcessing = false;
          return;
        }
      }

      await this.performFontReplacement(fontFamily, fontSize, confirmedType, codePointsToProcess, fontData);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (err instanceof FontLoadingError && err.debugImages && err.debugImages.length > 0) {
        this.fontDebugFileName = err.fileName;
        this.fontDebugMessage = errorMessage;
        this.fontDebugImages = err.debugImages;
        this.showFontDebug = true;
      } else {
        this.showWarningDialog("Font Replacement Error", `Failed to replace font:\n${errorMessage}`);
      }
      this.statusMessage = `Font replacement failed: ${errorMessage}`;
    } finally {
      if (fontResult && !this.showTofuDebug) unloadFontFile(fontResult.fontFace, fontResult.fontFamily);
      this.isProcessing = false;
      this.loadingTitle = undefined;
    }
  }

  async runTofuDetectionPreview(fontFamily: string, fontSize: 12 | 16, codePoints: number[], fontData: ArrayBuffer): Promise<void> {
    const result = await detectTofu(this.worker!, { fontFamily, fontSize, codePoints, fontData });
    if (!result.success) {
      this.tofuDebugData = [];
      throw new Error(`Tofu detection failed: ${result.error || 'Unknown error'}`);
    }
    this.tofuDebugData = result.debugData;
  }

  async performFontReplacement(fontFamily: string, fontSize: 12 | 16, fontType: "SMALL" | "LARGE", codePointsToProcess: number[], fontData: ArrayBuffer): Promise<void> {
    setTofuDebugMode(this.debug);
    let finishHandler: ((e: MessageEvent) => void) | null = null;
    const resultPromise = new Promise<void>((resolve, reject) => {
      finishHandler = (e: MessageEvent) => {
        const { type, id, result, error, message } = e.data;
        if (id === "replaceFontsWorker") {
          if (type === "progress") {
            this.statusMessage = message;
            this.progress = e.data.progress;
            return;
          }
          this.worker!.removeEventListener("message", finishHandler!);
          finishHandler = null;
          if (type === "success") {
            const data = result as any;
            const targetSet = fontType === "SMALL" ? this.replacedSmallFontCharacters : this.replacedLargeFontCharacters;
            const mergedChars = new Set([...targetSet, ...data.replacedCharacters]);
            if (fontType === "SMALL") this.replacedSmallFontCharacters = mergedChars;
            else this.replacedLargeFontCharacters = mergedChars;

            // Worker returns modified firmware - send it back to worker as new source of truth
            if (data.firmware) {
              this.worker!.postMessage({
                type: "analyze",
                id: "analyze",
                firmware: data.firmware,
              });
            }

            this.statusMessage = `Font replacement completed: ${data.successCount} replaced, ${data.skippedCount} skipped`;
            this.progress = 100;
            resolve();
          } else {
            reject(new Error(error || "Font replacement failed"));
          }
        }
      };
    });
    this.worker!.addEventListener("message", finishHandler!);
    const messageData = {
      type: "replaceFontsWorker",
      id: "replaceFontsWorker",
      fontData,
      fontFamily,
      fontSize,
      fontType,
      firmware: new Uint8Array(), // Worker will use its cached copy
      codePoints: codePointsToProcess,
    };
    try {
      this.worker!.postMessage(messageData);
    } catch (err) {
      throw err;
    }
    await resultPromise;
  }

  async confirmFontReplacement(): Promise<void> {
    if (!this.pendingReplacement) {
      this.showTofuDebug = false;
      return;
    }
    const pr = structuredClone(this.pendingReplacement);
    const { fontFamily, fontSize, fontType, codePoints } = pr;
    this.pendingReplacement = null;
    this.showTofuDebug = false;
    this.isProcessing = true;
    this.statusMessage = "Proceeding with font replacement...";
    this.progress = 5;
    const fontData = this.previewFontResult?.fontData;
    if (!fontData) {
      this.showWarningDialog("Error", "Font data not available");
      return;
    }
    try {
      await this.performFontReplacement(fontFamily, fontSize, fontType, codePoints, fontData);
    } catch (err) {
      this.showWarningDialog("Font Replacement Error", `Failed to replace font:\n${err instanceof Error ? err.message : String(err)}`);
      this.statusMessage = `Font replacement failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (this.previewFontResult) {
        unloadFontFile(this.previewFontResult.fontFace, this.previewFontResult.fontFamily);
        this.previewFontResult = null;
      }
      this.isProcessing = false;
      this.loadingTitle = undefined;
    }
  }

  cancelFontReplacement(): void {
    this.pendingReplacement = null;
    this.showTofuDebug = false;
    this.isProcessing = false;
    this.loadingTitle = undefined;
    this.statusMessage = "Font replacement cancelled";
    if (this.previewFontResult) {
      unloadFontFile(this.previewFontResult.fontFace, this.previewFontResult.fontFamily);
      this.previewFontResult = null;
    }
  }

  handleFontSizeConfirm(fontType: "SMALL" | "LARGE"): void {
    if (!this.pendingFontConfirmation) {
      this.showFontSizeConfirmation = false;
      return;
    }
    const { fontFamily, fontData, fileName } = this.pendingFontConfirmation;
    this.pendingFontConfirmation = null;
    this.showFontSizeConfirmation = false;
    this.continueFontReplacement(fontFamily, fontType, fontData, fileName);
  }

  handleFontSizeCancel(): void {
    this.pendingFontConfirmation = null;
    this.showFontSizeConfirmation = false;
    this.isProcessing = false;
    this.loadingTitle = undefined;
    this.statusMessage = "Font replacement cancelled";
  }

  async continueFontReplacement(fontFamily: string, fontType: "SMALL" | "LARGE", fontData: ArrayBuffer, fileName: string): Promise<void> {
    this.isProcessing = true;
    this.loadingTitle = "Replacing Font Glyphs";
    this.statusMessage = `Font loaded as ${fontType}. Preparing replacement...`;
    try {
      await loadTofuFont();
      const fontSize = fontType === "SMALL" ? 12 : 16;
      let codePointsToProcess: number[] = [];
      if (fontType === "SMALL") {
        for (const range of UNICODE_RANGES) {
          const start = Math.max(range.start, 0x0000);
          const end = Math.min(range.end, 0xffff);
          if (start <= end) {
            for (let cp = start; cp <= end; cp++) codePointsToProcess.push(cp);
          }
        }
      } else {
        for (let cp = 0x4e00; cp <= 0x9fff; cp++) codePointsToProcess.push(cp);
      }
      this.statusMessage = `Replacing ${codePointsToProcess.length} font characters...`;
      this.progress = 10;
      this.previewFontResult = { fontFace: new FontFace("ConfirmedFont", fontData), fontFamily, detectedType: fontType, isUncertain: false, fileName, isPixelPerfect: true, fontData };
      if (this.debug) {
        this.statusMessage = "Running tofu detection preview...";
        const previewCodePoints = [...codePointsToProcess.slice(0, 50), ...RARE_TEST_CHARS];
        await this.runTofuDetectionPreview(fontFamily, fontSize, previewCodePoints, fontData);
        if (this.tofuDebugData.length > 0) {
          this.pendingReplacement = { fontFamily, fontSize, fontType, codePoints: codePointsToProcess };
          this.showTofuDebug = true;
          this.isProcessing = false;
          return;
        }
      }
      await this.performFontReplacement(fontFamily, fontSize, fontType, codePointsToProcess, fontData);
    } catch (err) {
      this.showWarningDialog("Font Replacement Error", `Failed to replace font:\n${err instanceof Error ? err.message : String(err)}`);
      this.statusMessage = `Font replacement failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (this.previewFontResult) {
        unloadFontFile(this.previewFontResult.fontFace, this.previewFontResult.fontFamily);
        this.previewFontResult = null;
      }
      this.isProcessing = false;
      this.loadingTitle = undefined;
    }
  }

  async handleSequenceReplace(mappings: { target: BitmapFileInfo; source: File }[]) {
    this.isProcessing = true;
    this.statusMessage = `Processing ${mappings.length} images...`;
    const replacements: SequenceReplacement[] = [];
    try {
      for (const { target, source } of mappings) {
        const rgb565Result = await imageToRgb565(source, target.width, target.height, { resize: true, grayscale: false });
        if (!rgb565Result) throw new Error(`Failed to process ${source.name}`);
        replacements.push({ imageName: target.name, width: target.width, height: target.height, offset: target.offset!, rgb565Data: rgb565Result.rgb565Data });
      }
      await new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const { type, id, error } = e.data;
          if (id === "replaceSequence") {
            if (type === "progress") return;
            this.worker!.removeEventListener("message", handler);
            if (type === "success") {
              for (const r of replacements) {
                if (!this.replacedImages.includes(r.imageName)) this.replacedImages = [...this.replacedImages, r.imageName];
              }
              this.statusMessage = `Successfully replaced ${replacements.length} images`;
              resolve();
            } else reject(new Error(error || "Worker failed to replace sequence"));
          }
        };
        this.worker!.addEventListener("message", handler);
        this.worker!.postMessage({ type: "replaceImages", id: "replaceSequence", firmware: new Uint8Array(), images: replacements });
      });
    } catch (err) {
      this.showWarningDialog("Sequence Replacement Failed", err instanceof Error ? err.message : String(err));
    } finally {
      this.isProcessing = false;
    }
  }

  async replaceCurrentlySelectedImage(file: File) {
    if (!this.selectedNode || this.selectedNode.type !== "image" || !this.imageData) return;
    this.isProcessing = true;
    this.statusMessage = `Processing ${file.name} for ${this.imageData.name}...`;
    try {
      const rgb565Result = await imageToRgb565(file, this.imageData.width, this.imageData.height, { resize: true, grayscale: false });
      if (!rgb565Result) throw new Error("Failed to process image");
      const replacement = { imageName: this.imageData.name, width: this.imageData.width, height: this.imageData.height, offset: (this.selectedNode.data as BitmapFileInfo).offset!, rgb565Data: rgb565Result.rgb565Data };
      await new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const { type, id, error } = e.data;
          if (id === "replaceSingleImage") {
            if (type === "progress") return;
            this.worker!.removeEventListener("message", handler);
            if (type === "success") {
              if (this.imageData) this.imageData = { ...this.imageData, rgb565Data: replacement.rgb565Data };
              if (!this.replacedImages.includes(replacement.imageName)) this.replacedImages = [...this.replacedImages, replacement.imageName];
              this.statusMessage = `Successfully replaced ${replacement.imageName}`;
              resolve();
            } else reject(new Error(error || "Worker failed to replace image"));
          }
        };
        this.worker!.addEventListener("message", handler);
        this.worker!.postMessage({ type: "replaceImages", id: "replaceSingleImage", firmware: new Uint8Array(), images: [replacement] });
      });
    } catch (err) {
      this.showWarningDialog("Replacement Failed", `Failed to process ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  openColorPicker(type: 'progress' | 'marquee' | 'flac', themeId: number) {
    this.colorPickerTarget = { type, themeId };
    this.showColorPicker = true;
  }

  closeColorPicker() {
    this.showColorPicker = false;
    this.colorPickerTarget = null;
  }

  /**
   * Rebuild color entries from extraction result
   * Extracts color entries for all color types and updates this.colorData
   */
  rebuildColorEntries(result: import('$lib/rse/theme').AnalysisResult) {
    // Extract colors again using the same logic as buildColorTree
    const menuColorEntries: ColorEntry[] = [];
    const flacColorEntries: ColorEntry[] = [];
    const progressColorEntries: ColorEntry[] = [];
    const marqueeColorEntries: ColorEntry[] = [];

    const registerMeaning: Record<number, string> = {
      1: 'Highlight',
      2: 'Secondary',
      3: 'Foreground'
    };

    for (const func of result.themeFunctions) {
      if (func.type === 'menu' || func.uiElement.includes('Menu')) {
        // Group writes by their themeCondition
        const writesByTheme: Map<number, import("$lib/rse/theme").ColorWrite[]> = new Map();
        for (const write of func.colorWrites) {
          const themeId = write.themeCondition ?? 0;
          if (!writesByTheme.has(themeId)) {
            writesByTheme.set(themeId, []);
          }
          writesByTheme.get(themeId)!.push(write);
        }

        // Process each theme's writes separately
        for (const [targetTheme, themeWrites] of writesByTheme) {
          const themeColors: Map<number, ColorEntry> = new Map();

          for (const write of themeWrites) {
            if (write.targetReg !== 1 && write.targetReg !== 2 && write.targetReg !== 3) {
              continue;
            }

            const strhAddr = '0x' + write.addr.toString(16).toUpperCase().padStart(5, '0');
            const strhInstr = write.instr ? `${write.instr.mnemonic} ${write.instr.operands}` : 'STRH';

            let movwAddr: string | undefined;
            let movwInstr: string | undefined;
            if (write.movwInstr) {
              movwAddr = '0x' + write.movwInstr.addr.toString(16).toUpperCase().padStart(5, '0');
              movwInstr = `${write.movwInstr.instr.mnemonic} ${write.movwInstr.instr.operands}`;
            } else if (write.sourceReg === 12) {
              movwAddr = undefined;
              movwInstr = '(preload)';
            }

            const registerMeaningKey = registerMeaning[write.targetReg] ?? `R${write.targetReg}`;

            const colorEntry: ColorEntry = {
              semantic: registerMeaningKey,
              color: write.colorValue,
              themeId: targetTheme,
              register: write.targetReg,
              movwAddress: movwAddr,
              movwInstruction: movwInstr,
              strhAddress: strhAddr,
              strhInstruction: strhInstr,
              isPatched: false
            };

            themeColors.set(write.targetReg, colorEntry);
          }

          for (const [, entry] of themeColors) {
            menuColorEntries.push(entry);
          }
        }
      }

      if (func.type === 'flac' || func.uiElement.includes('FLAC')) {
        if (result.flacBehavior.isFlac) {
          const movwAddr4 = result.flacBehavior.movwAddr4 || '-';
          const movwInstr4 = result.flacBehavior.movwInstr4 || '-';
          const movwAddrOther = result.flacBehavior.movwAddrOther || '-';
          const movwInstrOther = result.flacBehavior.movwInstrOther || '-';

          let strhAddr = '-';
          let strhInstr = '-';
          if (func.colorWrites.length > 0) {
            const write = func.colorWrites[0];
            strhAddr = '0x' + write.addr.toString(16).toUpperCase().padStart(5, '0');
            strhInstr = write.instr ? `${write.instr.mnemonic} ${write.instr.operands}` : 'STRH';
          }

          for (let themeId = 0; themeId < 5; themeId++) {
            // Use flacColors array if available (from metadata), otherwise fall back to colorFor4/colorForOther
            const color = result.flacBehavior.flacColors && result.flacBehavior.flacColors.length === 5
              ? result.flacBehavior.flacColors[themeId]
              : (themeId === 4 ? result.flacBehavior.colorFor4 : result.flacBehavior.colorForOther);
            const movwAddr = themeId === 4 ? movwAddr4 : movwAddrOther;
            const movwInstr = themeId === 4 ? movwInstr4 : movwInstrOther;

            flacColorEntries.push({
              semantic: 'Codec Info',
              color: color,
              themeId: themeId,
              register: undefined,
              movwAddress: movwAddr === '-' ? undefined : movwAddr,
              movwInstruction: movwInstr === '-' ? undefined : movwInstr,
              strhAddress: strhAddr === '-' ? undefined : strhAddr,
              strhInstruction: strhInstr === '-' ? undefined : strhInstr,
              isPatched: this.flacPatched,
              isFlacPatched: this.flacPatched
            });
          }
        } else {
          for (const write of func.colorWrites) {
            const strhAddr = '0x' + write.addr.toString(16).toUpperCase().padStart(5, '0');
            const strhInstr = write.instr ? `${write.instr.mnemonic} ${write.instr.operands}` : 'STRH';

            let movwAddr: string | undefined;
            let movwInstr: string | undefined;
            if (write.movwInstr) {
              movwAddr = '0x' + write.movwInstr.addr.toString(16).toUpperCase().padStart(5, '0');
              movwInstr = `${write.movwInstr.instr.mnemonic} ${write.movwInstr.instr.operands}`;
            }

            flacColorEntries.push({
              semantic: 'Codec Info',
              color: write.colorValue,
              themeId: write.themeCondition ?? undefined,
              register: write.sourceReg,
              movwAddress: movwAddr,
              movwInstruction: movwInstr,
              strhAddress: strhAddr,
              strhInstruction: strhInstr,
              isPatched: this.flacPatched,
              isFlacPatched: this.flacPatched
            });
          }
        }
      }

      if (func.type === 'progress') {
        for (let themeId = 0; themeId < 5; themeId++) {
          const color = func.preloadColors[themeId] ?? 0;
          const movwRecord = func.preloadMovwRecords?.[themeId];

          let movwAddr: string | undefined;
          let movwInstr: string | undefined;
          if (movwRecord) {
            movwAddr = '0x' + movwRecord.addr.toString(16).toUpperCase().padStart(5, '0');
            movwInstr = `${movwRecord.instr.mnemonic} ${movwRecord.instr.operands}`;
          }

          progressColorEntries.push({
            semantic: 'Progress Bar',
            color: color,
            themeId: themeId,
            register: undefined,
            movwAddress: movwAddr,
            movwInstruction: movwInstr,
            strhAddress: undefined,
            strhInstruction: undefined,
            isPatched: false
          });
        }
      }

      if (func.type === 'marquee') {
        for (let themeId = 0; themeId < 5; themeId++) {
          const color = func.preloadColors[themeId] ?? 0;
          const movwRecord = func.preloadMovwRecords?.[themeId];

          let movwAddr: string | undefined;
          let movwInstr: string | undefined;
          if (movwRecord) {
            movwAddr = '0x' + movwRecord.addr.toString(16).toUpperCase().padStart(5, '0');
            movwInstr = `${movwRecord.instr.mnemonic} ${movwRecord.instr.operands}`;
          }

          marqueeColorEntries.push({
            semantic: 'Marquee Overlay',
            color: color,
            themeId: themeId,
            register: undefined,
            movwAddress: movwAddr,
            movwInstruction: movwInstr,
            strhAddress: undefined,
            strhInstruction: undefined,
            isPatched: false
          });
        }
      }
    }

    // Remove duplicates
    const uniqueMenuColors = this.deduplicateColors(menuColorEntries);
    const uniqueFlacColors = this.deduplicateColors(flacColorEntries);
    const uniqueProgressColors = this.deduplicateColors(progressColorEntries);
    const uniqueMarqueeColors = this.deduplicateColors(marqueeColorEntries);

    this.colorData = {
      menuColors: uniqueMenuColors,
      flacColors: uniqueFlacColors,
      progressColors: uniqueProgressColors,
      marqueeColors: uniqueMarqueeColors
    };
  }

  async handleColorSelect(rgb: { r: number; g: number; b: number }) {
    if (!this.colorPickerTarget) return;

    const { type, themeId } = this.colorPickerTarget;
    this.isProcessing = true;
    this.statusMessage = `Updating ${type} color for theme ${themeId}...`;

    try {
      // Convert RGB to RGB565
      const r5 = Math.round((rgb.r / 255) * 31);
      const g5 = Math.round((rgb.g / 255) * 63);
      const b5 = Math.round((rgb.b / 255) * 31);
      const rgb565 = (r5 << 11) | (g5 << 5) | b5;

      // FLAC color editing (requires full patch re-application)
      if (type === 'flac') {
        if (!this.flacPatched) {
          throw new Error("FLAC color editing is not unlocked. Please unlock first.");
        }

        this.showLoadingWindow = true;
        this.loadingTitle = "Updating FLAC Color";
        this.progress = 10;

        // Let the UI render the loading window before doing heavy work
        await new Promise(resolve => requestAnimationFrame(() => resolve(undefined)));

        try {
          // Get firmware from worker (single source of truth)
          const firmwareData = await this.getFirmwareFromWorker();

          this.progress = 20;
          this.statusMessage = "Extracting current colors...";

          // Extract current FLAC and Menu colors from firmware
          const result = extractThemeColors(firmwareData);
          const flacFunc = result.themeFunctions.find(f => f.type === 'flac');
          const menuFunc = result.themeFunctions.find(f => f.type === 'menu');

          if (!flacFunc || !menuFunc) {
            throw new Error("FLAC or Menu function not found in firmware");
          }

          // Extract current FLAC colors using getColorsForFunction
          // This correctly handles both patched and unpatched firmware
          const extractor = new ThemeColorExtractor(firmwareData);
          const currentFlacColors = extractor.getColorsForFunction('flac');
          currentFlacColors[themeId] = rgb565;  // Update the selected theme color

          // Extract current Menu colors
          // Use getColorsForFunction to correctly handle both patched and unpatched firmware
          const currentMenuColors = extractor.getColorsForFunction('menu');

          this.progress = 40;
          this.statusMessage = "Applying patch...";

          // Apply FLAC and Menu patch using the worker (non-blocking)
          const patchedData = await new Promise<Uint8Array>((resolve, reject) => {
            const handler = (e: MessageEvent) => {
              const { type, id: responseId, result, error } = e.data;
              if (responseId === "patchThemeEdit") {
                if (type === "success") {
                  this.worker!.removeEventListener("message", handler);
                  const patchResult = result as { patchedData: Uint8Array; nopSlide: { start: number; end: number; size: number }; metadataAddr: number };
                  resolve(patchResult.patchedData);
                } else if (type === "progress") {
                  const data = e.data as { message: string };
                  this.statusMessage = data.message;
                  // Update progress based on the message
                  if (data.message.includes("Preparing")) {
                    this.progress = 45;
                  } else if (data.message.includes("Analyzing")) {
                    this.progress = 50;
                  } else if (data.message.includes("applied")) {
                    this.progress = 55;
                  }
                } else if (type === "error") {
                  this.worker!.removeEventListener("message", handler);
                  reject(new Error(error || "Worker patching failed"));
                }
              }
            };
            this.worker!.addEventListener("message", handler);
            this.worker!.postMessage({
              type: "patchTheme",
              id: "patchThemeEdit",
              firmware: firmwareData,
              flacColors: currentFlacColors,
              menuColors: currentMenuColors,
            });
          });

          this.progress = 60;
          this.statusMessage = "Verifying patch...";

          // Round-trip verification: extract colors from patched firmware
          const verifyResult = extractThemeColors(patchedData);

          // Verify FLAC colors using getColorsForFunction
          // This correctly handles both patched and unpatched firmware
          const verifyExtractor = new ThemeColorExtractor(patchedData);
          const actualFlacColors = verifyExtractor.getColorsForFunction('flac');

          for (let i = 0; i < 5; i++) {
            const expectedColor = currentFlacColors[i];
            const actualColor = actualFlacColors[i];

            if (actualColor !== expectedColor) {
              throw new Error(`FLAC color verification failed for theme ${i}: expected 0x${expectedColor.toString(16)}, got 0x${actualColor.toString(16)}`);
            }
          }

          // Verify Menu colors weren't affected
          const verifyMenuFunc = verifyResult.themeFunctions.find(f => f.type === 'menu');
          if (verifyMenuFunc) {
            const verifyWritesByTheme: Map<number, import("$lib/rse/theme").ColorWrite[]> = new Map();
            for (const write of verifyMenuFunc.colorWrites) {
              const tId = write.themeCondition ?? 0;
              if (!verifyWritesByTheme.has(tId)) {
                verifyWritesByTheme.set(tId, []);
              }
              verifyWritesByTheme.get(tId)!.push(write);
            }

            for (let tId = 0; tId < 5; tId++) {
              const themeWrites = verifyWritesByTheme.get(tId) || [];
              const themeColors: Map<number, number> = new Map();
              for (const write of themeWrites) {
                if (write.targetReg === 1 || write.targetReg === 2 || write.targetReg === 3) {
                  themeColors.set(write.targetReg, write.colorValue);
                }
              }

              const r1 = themeColors.get(1) ?? 0;
              const r2 = themeColors.get(2) ?? 0;
              const r3 = themeColors.get(3) ?? 0;

              if (r1 !== currentMenuColors[tId]) {
                throw new Error(`Menu R1 color for theme ${tId} was modified: expected 0x${currentMenuColors[tId].toString(16)}, got 0x${r1.toString(16)}`);
              }
              if (r2 !== currentMenuColors[tId + 5]) {
                throw new Error(`Menu R2 color for theme ${tId} was modified: expected 0x${currentMenuColors[tId + 5].toString(16)}, got 0x${r2.toString(16)}`);
              }
              if (r3 !== currentMenuColors[tId + 10]) {
                throw new Error(`Menu R3 color for theme ${tId} was modified: expected 0x${currentMenuColors[tId + 10].toString(16)}, got 0x${r3.toString(16)}`);
              }
            }
          }

          this.progress = 80;
          this.statusMessage = "Reloading firmware...";

          // Set flag to indicate FLAC edit operation is in progress
          this._pendingFlacOperation = true;
          this._flacOperationType = 'edit';
          this._flacOperationThemeId = themeId;

          // Send patched firmware to worker - main handler will process the response
          this.worker!.postMessage({
            type: "analyze",
            id: "analyze",
            firmware: patchedData,
          });

          // The rest of the workflow will be handled by the main worker message handler
          return;
        } catch (err) {
          this.showLoadingWindow = false;
          this.isProcessing = false;
          this._pendingFlacOperation = false;
          this._flacOperationType = null;
          this._flacOperationThemeId = 0;
          throw err;
        }
      }

      // Progress Bar and Marquee color editing (switch_case patching)
      // Get firmware from worker (single source of truth)
      const firmwareData = await this.getFirmwareFromWorker();

      const extractor = new ThemeColorExtractor(firmwareData);
      const extractResult = extractor.extract();

      const targetFunc = extractResult.themeFunctions.find(f => f.type === type);
      if (!targetFunc) {
        throw new Error(`${type} function not found in firmware`);
      }

      // Clone firmware data to avoid modifying the original
      const patchedFirmware = new Uint8Array(firmwareData);

      // Get current colors - preloadColors is a Record<number, number>
      const currentColors = targetFunc.preloadColors ?? {};
      const colorsToUpdate: number[] = [];
      for (let i = 0; i < 5; i++) {
        colorsToUpdate[i] = currentColors[i] ?? 0;
      }
      colorsToUpdate[themeId] = rgb565;

      // Apply the patch directly
      patchSwitchCaseFunction(patchedFirmware, targetFunc, colorsToUpdate);

      // Round-trip verification: extract colors from patched firmware
      const verifyExtractor = new ThemeColorExtractor(patchedFirmware);
      const verifyResult = verifyExtractor.extract();
      const verifyFunc = verifyResult.themeFunctions.find(f => f.type === type);

      if (!verifyFunc) {
        throw new Error(`${type} function not found in patched firmware`);
      }

      const updatedColorsRecord = verifyFunc.preloadColors ?? {};
      const updatedColors: number[] = [];
      for (let i = 0; i < 5; i++) {
        updatedColors[i] = updatedColorsRecord[i] ?? 0;
      }

      // Verify the specific color was applied correctly
      if (updatedColors[themeId] !== rgb565) {
        throw new Error(`Round-trip verification failed: expected 0x${rgb565.toString(16)}, got 0x${updatedColors[themeId].toString(16)}`);
      }

      // Verify other colors weren't affected
      for (let i = 0; i < 5; i++) {
        if (i !== themeId && updatedColors[i] !== colorsToUpdate[i]) {
          throw new Error(`Color ${i} was modified: expected 0x${colorsToUpdate[i].toString(16)}, got 0x${updatedColors[i].toString(16)}`);
        }
      }

      // Send patched firmware to worker (worker becomes source of truth)
      this.worker!.postMessage({
        type: "analyze",
        id: "analyze",
        firmware: patchedFirmware,
      });

      // Refresh color data using the extraction logic
      const result = extractThemeColors(patchedFirmware);

      if (result.themeFunctions.length === 0) {
        throw new Error("No theme functions found in patched firmware");
      }

      // Rebuild color entries with updated data
      this.rebuildColorEntries(result);

      this.statusMessage = `Successfully updated ${type} color for theme ${themeId} to RGB(${rgb.r}, ${rgb.g}, ${rgb.b})`;
      this.showColorPicker = false;
      this.colorPickerTarget = null;

      // Re-open the color detail with updated data
      if (this.selectedColorDetail) {
        const updatedEntry = (type === 'progress' ? this.colorData?.progressColors : this.colorData?.marqueeColors)?.find(c => c.themeId === themeId);
        if (updatedEntry) {
          this.selectedColorDetail = updatedEntry;
        }
      }
    } catch (err) {
      this.showWarningDialog("Color Update Failed", `Failed to update color:\n${err instanceof Error ? err.message : String(err)}`);
      this.statusMessage = `Color update failed`;
    } finally {
      this.isProcessing = false;
    }
  }

  handleCloseResourceViewer() {
    this.treeNodes = [];
    this.imageList = [];
    this.selectedNode = null;
    this.planeData = null;
    this.imageData = null;
    this.statusMessage = "Ready to load firmware";
    this.replacedImages = [];
    this.replacedSmallFontCharacters = new Set();
    this.replacedLargeFontCharacters = new Set();
  }
}
