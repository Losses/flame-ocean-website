<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    Window,
    WindowBody,
    TreeView,
    StatusBar,
    LoadingWindow,
    WarningWindow,
  } from "$lib/components/98css";
  import FontGridRenderer from "$lib/components/firmware/FontGridRenderer.svelte";
  import ImageRenderer from "$lib/components/firmware/ImageRenderer.svelte";
  import SequenceReplacerWindow from "$lib/components/firmware/SequenceReplacerWindow.svelte";
  import FirmwareWorker from "$lib/workers/firmware-worker.ts?worker";
  import {
    initDebugShortcut,
    debugMode,
    debugAnimationComplete,
  } from "$lib/stores";
  import { fileIO } from "$lib/rse/utils/file-io";
  import { imageToRgb565 } from "$lib/rse/utils/bitmap";
  import {
    loadAndValidateFontFile,
    unloadFontFile,
    FontLoadingError,
  } from "$lib/rse/utils/font-loading";
  import { extractCharacter } from "$lib/rse/utils/font-extraction";
  import { loadTofuFont } from "$lib/rse/utils/tofu-font";

  // Types
  interface FontPlaneInfo {
    name: string;
    start: number;
    end: number;
    smallCount: number;
    largeCount: number;
    estimatedCount: number;
    fontType: "SMALL" | "LARGE";
  }

  interface BitmapFileInfo {
    name: string;
    width: number;
    height: number;
    size: number;
    offset?: number;
  }

  interface TreeNode {
    id: string;
    label: string;
    type: "folder" | "font-type" | "plane" | "image";
    data?: FontPlaneInfo | BitmapFileInfo;
    children?: TreeNode[];
  }

  // State
  let firmwareData = $state<Uint8Array | null>(null);
  let originalFirmwareData = $state<Uint8Array | null>(null); // For rollback
  let worker: Worker | null = null;
  let isProcessing = $state(false);
  let progress = $state(0);
  let statusMessage = $state("Ready to load firmware");
  let selectedNode = $state<TreeNode | null>(null);
  let expandedNodes = $state(new Set<string>());
  let treeNodes = $state<TreeNode[]>([]);

  let imageList = $state<BitmapFileInfo[]>([]);
  let planeData = $state<{
    name: string;
    start: number;
    end: number;
    fonts: Array<{
      unicode: number;
      fontType: "SMALL" | "LARGE";
      pixels: boolean[][];
    }>;
  } | null>(null);
  let imageData = $state<{
    name: string;
    width: number;
    height: number;
    rgb565Data: Uint8Array;
  } | null>(null);

  // Warning dialog state
  let showWarning = $state(false);
  let warningTitle = $state("");
  let warningMessage = $state("");

  // Track replaced images - use array for better Svelte 5 reactivity
  let replacedImages = $state<string[]>([]);

  // Track replaced font characters - use Set for efficient lookup
  let replacedFontCharacters = $state<Set<number>>(new Set());

  // Show sequence replacer mode
  let showSequenceReplacer = $state(false);

  // File input
  // svelte-ignore non_reactive_update
  let fileInput: HTMLInputElement;
  // svelte-ignore non_reactive_update
  let dropZone: HTMLDivElement;
  let isDragOver = $state(false);
  let isImageDragOver = $state(false);

  // Edit/Replacement file input (for multiple files)
  // svelte-ignore non_reactive_update
  let editFileInput: HTMLInputElement;

  // Debug mode tracking - use state with subscribe for proper reactivity
  let debug = $state(false);
  let debugAnimComplete = $state(true);

  // Subscribe to stores
  debugMode.subscribe((value) => {
    debug = value;
  });
  debugAnimationComplete.subscribe((value) => {
    debugAnimComplete = value;
  });

  let showLoadingWindow = $derived(
    isProcessing || (debug && !debugAnimComplete),
  );

  // Update document title dynamically
  $effect(() => {
    if (!firmwareData && !isProcessing) {
      document.title = "FlameOcean";
    } else if (showLoadingWindow) {
      document.title = "Loading - FlameOcean";
    } else if (selectedNode?.type === "image" && imageData) {
      document.title = `${imageData.name} - FlameOcean`;
    } else if (selectedNode?.type === "plane" && planeData) {
      const fontType = (selectedNode.data as FontPlaneInfo)?.fontType;
      document.title = `${planeData.name} (${fontType}) - FlameOcean`;
    } else {
      document.title = "Resource Browser - FlameOcean";
    }
  });

  // Initialize worker
  onMount(() => {
    // Initialize global debug shortcut (Ctrl+Shift+D)
    initDebugShortcut();

    // Add keyboard listener for Ctrl+S export
    window.addEventListener("keydown", handleKeyDown);

    // Add paste listener for image and font replacement
    window.addEventListener("paste", async (e: ClipboardEvent) => {
      if (isProcessing) {
        showWarningDialog(
          "Busy",
          "A replacement is already in progress. Please wait.",
        );
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        } else if (item) {
          // Check for font files by MIME type
          const file = item.getAsFile();
          if (file && isFontFile(file)) {
            files.push(file);
          }
        }
      }

      if (files.length === 0) return;

      // Check for font files first
      const fontFiles = files.filter(isFontFile);
      if (fontFiles.length > 0) {
        // Process the first font file
        await replaceFont(fontFiles[0]);
        return;
      }

      // Smart Replacement Logic for Paste:
      const imageFiles = files.filter((f) => !isFontFile(f));
      if (imageFiles.length === 0) return;

      if (imageFiles.length === 1 && selectedNode?.type === "image" && imageData) {
        await replaceCurrentlySelectedImage(imageFiles[0]);
      } else {
        await handlePasteFiles(imageFiles);
      }
    });

    worker = new FirmwareWorker();

    worker.onmessage = (e: MessageEvent) => {
      const { type, id, result, error, message } = e.data;

      if (type === "success") {
        if (id === "analyze") {
          // After analysis, list planes and images
          statusMessage = "Firmware analyzed. Loading resources...";
          isProcessing = false;
          loadResources();
        } else if (id === "listPlanes") {
          const planes = result as FontPlaneInfo[];
          buildFontTree(planes);
        } else if (id === "listImages") {
          const images = result as BitmapFileInfo[];
          imageList = images;
          buildImageTree(images);
        } else if (id === "extractPlane") {
          const data = result as typeof planeData;
          planeData = data;
          isProcessing = false;
          statusMessage = `Loaded plane: ${data?.name ?? "Unknown"}`;
        } else if (id === "extractImage") {
          const data = result as typeof imageData;
          imageData = data;
          isProcessing = false;
          statusMessage = `Loaded image: ${data?.name ?? "Unknown"}`;
        }
      } else if (type === "progress") {
        statusMessage = message;
      } else if (type === "error") {
        statusMessage = `Error: ${error}`;
        isProcessing = false;
      }
    };

    worker.onerror = (err) => {
      statusMessage = `Worker error: ${err.message}`;
      isProcessing = false;
    };

    return () => {
      worker?.terminate();
      window.removeEventListener("keydown", handleKeyDown);
      // Note: paste listener is removed with page unmount
    };
  });

  // Load resources after analysis
  async function loadResources() {
    if (!worker || !firmwareData) return;

    // List fonts
    worker.postMessage({
      type: "listPlanes",
      id: "listPlanes",
      firmware: new Uint8Array(), // Empty, worker uses cached data
    });

    // List images
    worker.postMessage({
      type: "listImages",
      id: "listImages",
      firmware: new Uint8Array(),
    });
  }

  // Build font tree structure
  function buildFontTree(planes: FontPlaneInfo[]) {
    // Create SMALL font planes
    const smallPlanes = planes
      .filter((p) => p.smallCount > 0)
      .map((plane) => ({
        id: `plane-small-${plane.name}`,
        label: `${plane.name}`,
        type: "plane" as const,
        data: { ...plane, fontType: "SMALL" as const },
        children: [],
      }));

    // Create LARGE font planes
    const largePlanes = planes
      .filter((p) => p.largeCount > 0)
      .map((plane) => ({
        id: `plane-large-${plane.name}`,
        label: `${plane.name} (${plane.largeCount})`,
        type: "plane" as const,
        data: { ...plane, fontType: "LARGE" as const },
        children: [],
      }));

    treeNodes = [
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
      ...(treeNodes.length > 1 ? [treeNodes[1]] : []), // Preserve images if already added
    ];

    // Keep tree nodes collapsed by default
  }

  // Build image tree structure
  function buildImageTree(images: BitmapFileInfo[]) {
    const imageNodes = images.map((img, idx) => {
      return {
        id: `image-${idx}`,
        label: img.name,
        type: "image" as const,
        data: img, // Use the image data directly with offset from worker
        children: [],
      };
    });

    // Update or add images folder
    const imagesNode = {
      id: "images",
      label: "Firmware Images",
      type: "folder" as const,
      children: imageNodes,
    };

    if (treeNodes.length > 0 && treeNodes[0].id === "fonts") {
      treeNodes = [treeNodes[0], imagesNode];
    } else {
      treeNodes = [...treeNodes, imagesNode];
    }
  }

  // Handle tree node click
  function handleNodeClick(node: TreeNode) {
    if (isProcessing) return; // Don't allow new selection while processing

    // Clear old data first to avoid showing stale content
    planeData = null;
    imageData = null;

    selectedNode = node;

    if (node.type === "plane" && node.data) {
      loadPlane(node.data as FontPlaneInfo);
    } else if (node.type === "image" && node.data) {
      const image = node.data as BitmapFileInfo;
      if (image.offset === undefined) {
        statusMessage = `Error: Image ${image.name} has no offset information`;
        return;
      }
      loadImage(image);
    }
  }

  // Find node by ID (recursive helper)
  function findNodeById(nodes: TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = findNodeById(node.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  // Handle tree node selection from TreeView onSelect
  function handleSelectNode(nodeId: string) {
    const node = findNodeById(treeNodes, nodeId);
    if (node) {
      handleNodeClick(node);
    }
  }

  // Load font plane
  function loadPlane(plane: FontPlaneInfo) {
    if (!worker || !firmwareData || isProcessing) return;

    isProcessing = true;
    statusMessage = `Extracting ${plane.name} (${plane.fontType})...`;
    imageData = null; // Clear image data

    worker.postMessage({
      type: "extractPlane",
      id: "extractPlane",
      firmware: new Uint8Array(), // Worker uses cached data
      fontType: plane.fontType,
      planeName: plane.name,
      start: plane.start,
      end: plane.end,
    });
  }

  // Load image
  function loadImage(image: BitmapFileInfo) {
    if (!worker || !firmwareData || isProcessing) return;

    isProcessing = true;
    statusMessage = `Extracting ${image.name}...`;
    planeData = null; // Clear plane data

    worker.postMessage({
      type: "extractImage",
      id: "extractImage",
      firmware: new Uint8Array(),
      imageName: image.name,
      width: image.width,
      height: image.height,
      offset: image.offset,
    });
  }

  // File handling
  function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      loadFirmware(file);
    }
    // Reset input so the same file can be selected again
    target.value = "";
  }

  async function loadFirmware(file: File) {
    isProcessing = true;
    progress = 10;
    statusMessage = `Loading ${file.name}...`;

    try {
      const arrayBuffer = await file.arrayBuffer();
      firmwareData = new Uint8Array(arrayBuffer);
      // Store original for rollback
      originalFirmwareData = new Uint8Array(arrayBuffer);

      progress = 30;
      statusMessage = "Analyzing firmware...";

      // Analyze firmware
      worker!.postMessage({
        type: "analyze",
        id: "analyze",
        firmware: firmwareData,
      });

      progress = 100;
    } catch (err) {
      statusMessage = `Error loading file: ${err}`;
      isProcessing = false;
    }
  }

  // Handle paste event - searches for matching image by filename
  // Processes multiple files in batch via worker
  async function handlePasteFiles(files: File[]) {
    // Check for font files first - separate them from image processing
    const fontFiles = files.filter(isFontFile);
    const imageFiles = files.filter((f) => !isFontFile(f));

    if (fontFiles.length > 0) {
      // Font file detected - route to font replacement flow
      await replaceFont(fontFiles[0]);
      return;
    }

    if (!firmwareData || imageList.length === 0) {
      showWarningDialog("Error", "No firmware loaded or no images available.");
      return;
    }

    if (!worker) {
      showWarningDialog("Error", "Worker not available.");
      return;
    }

    isProcessing = true;
    statusMessage = `Preparing to replace ${imageFiles.length} image(s)...`;

    // Collect all valid replacements
    const replacements: Array<{
      image: BitmapFileInfo;
      rgb565Data: Uint8Array;
    }> = [];
    const notFound: string[] = [];
    const decodeError: string[] = [];

    // Convert all files to RGB565 in parallel
    const conversionPromises = imageFiles.map(async (file) => {
      const pastedFileName = file.name.replace(/\.[^.]*$/, "").toUpperCase();

      const matchingImage = imageList.find(
        (img) =>
          img.name.replace(/\.[^.]*$/, "").toUpperCase() === pastedFileName,
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
        const rgb565Result = await imageToRgb565(
          file,
          matchingImage.width,
          matchingImage.height,
        );

        if (!rgb565Result) {
          decodeError.push(
            `${file.name}: Dimension mismatch (expected ${matchingImage.width}x${matchingImage.height})`,
          );
          return null;
        }

        return { image: matchingImage, rgb565Data: rgb565Result.rgb565Data };
      } catch (err) {
        decodeError.push(`${file.name}: Failed to decode`);
        return null;
      }
    });

    const results = await Promise.all(conversionPromises);

    // Filter out null results and collect valid replacements
    for (const result of results) {
      if (result) {
        replacements.push(result);
      }
    }

    if (replacements.length === 0) {
      isProcessing = false;
      let message = "No valid images to replace.\n\n";

      if (notFound.length > 0) {
        message += `Not found in firmware (${notFound.length}):\n${notFound.slice(0, 5).join(", ")}${notFound.length > 5 ? "..." : ""}\n\n`;
      }

      if (decodeError.length > 0) {
        message += `Errors (${decodeError.length}):\n${decodeError.slice(0, 3).join("\n")}${decodeError.length > 3 ? "\n..." : ""}`;
      }

      showWarningDialog("Replacement Failed", message.trim());
      return;
    }

    statusMessage = `Sending ${replacements.length} image(s) to worker...`;

    // Send batch replacement request to worker
    await new Promise<void>((resolve) => {
      const handler = (e: MessageEvent) => {
        const { type, id, result } = e.data;

        if (id === "replaceImages") {
          // Only handle success/error messages, ignore progress
          if (type === "success") {
            worker!.removeEventListener("message", handler);

            const data = result as {
              successCount: number;
              notFound: string[];
              dimensionMismatch: string[];
              replaceError: string[];
              results: Array<{ imageName: string; rgb565Data: Uint8Array }>;
            };

            // Update image display for currently selected image
            for (const r of data.results) {
              if (imageData && imageData.name === r.imageName) {
                imageData = {
                  name: r.imageName,
                  width: imageData.width,
                  height: imageData.height,
                  rgb565Data: r.rgb565Data,
                };
              }
            }

            // Track replaced images - append new names to array
            for (const r of data.results) {
              if (!replacedImages.includes(r.imageName)) {
                replacedImages = [...replacedImages, r.imageName];
              }
            }

            // Combine errors from main thread and worker
            const allNotFound = [...notFound, ...(data.notFound || [])];
            const allDimensionMismatch = [
              ...decodeError.filter((e) => e.includes("Dimension mismatch")),
              ...(data.dimensionMismatch || []),
            ];
            const allReplaceError = [
              ...decodeError.filter((e) => !e.includes("Dimension mismatch")),
              ...(data.replaceError || []),
            ];

            const totalErrors =
              allNotFound.length +
              allDimensionMismatch.length +
              allReplaceError.length;

            if (totalErrors > 0) {
              let message = `Successfully replaced: ${data.successCount}\n\n`;

              if (allNotFound.length > 0) {
                message += `Not found in firmware (${allNotFound.length}):\n${allNotFound.slice(0, 5).join(", ")}${allNotFound.length > 5 ? "..." : ""}\n\n`;
              }

              if (allDimensionMismatch.length > 0) {
                message += `Dimension mismatch (${allDimensionMismatch.length}):\n${allDimensionMismatch.slice(0, 3).join("\n")}${allDimensionMismatch.length > 3 ? "\n..." : ""}\n\n`;
              }

              if (allReplaceError.length > 0) {
                message += `Replacement errors (${allReplaceError.length}):\n${allReplaceError.slice(0, 3).join("\n")}${allReplaceError.length > 3 ? "\n..." : ""}\n\n`;
              }

              showWarningDialog(
                "Replacement Completed with Errors",
                message.trim(),
              );
            } else {
              statusMessage = `Successfully replaced ${data.successCount} image(s)`;
            }

            isProcessing = false;
            resolve();
          } else if (type === "error") {
            worker!.removeEventListener("message", handler);
            showWarningDialog(
              "Replacement Error",
              `Failed to replace images: ${result}`,
            );
            isProcessing = false;
            resolve();
          }
          // For progress messages, just continue waiting
        }
      };

      worker!.addEventListener("message", handler);

      worker!.postMessage({
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

  // Export firmware with timestamp
  async function exportFirmware() {
    if (!firmwareData || !worker) {
      showWarningDialog("Export Error", "No firmware data to export.");
      return;
    }

    isProcessing = true;
    statusMessage = "Retrieving modified firmware...";

    try {
      // Request the modified firmware from the worker
      const modifiedFirmware = await new Promise<Uint8Array>(
        (resolve, reject) => {
          const handler = (e: MessageEvent) => {
            const data = e.data;
            if (data.id === "exportFirmware") {
              worker!.removeEventListener("message", handler);
              if (data.type === "success") {
                resolve(data.result as Uint8Array);
              } else {
                reject(
                  new Error(
                    data.error || "Failed to retrieve modified firmware",
                  ),
                );
              }
            }
          };

          worker!.addEventListener("message", handler);
          worker!.postMessage({
            type: "getFirmware",
            id: "exportFirmware",
            firmware: new Uint8Array(),
          });
        },
      );

      // Update the main thread's firmware data with the modified version
      firmwareData = modifiedFirmware;

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const filename = `firmware_modified_${timestamp}.bin`;

      await fileIO.writeFile(filename, firmwareData);
      statusMessage = `Firmware exported as ${filename}`;
    } catch (err) {
      showWarningDialog(
        "Export Error",
        `Failed to export firmware: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      isProcessing = false;
    }
  }

  // Bundle all firmware images as ZIP
  async function bundleImagesAsZip() {
    if (!firmwareData || !worker) {
      showWarningDialog("Export Error", "No firmware data to export.");
      return;
    }

    isProcessing = true;
    statusMessage = "Preparing image bundle...";

    try {
      // Request ZIP bundle from worker with progress tracking
      const zipData = await new Promise<Uint8Array>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const data = e.data;
          if (data.id === "bundleImagesAsZip") {
            // Only handle success/error, ignore progress
            if (data.type === "success") {
              worker!.removeEventListener("message", handler);
              resolve(data.result as Uint8Array);
            } else if (data.type === "error") {
              worker!.removeEventListener("message", handler);
              reject(new Error(data.error || "Failed to bundle images"));
            }
            // For progress messages, just continue waiting
          }
        };

        worker!.addEventListener("message", handler);
        worker!.postMessage({
          type: "bundleImagesAsZip",
          id: "bundleImagesAsZip",
          firmware: new Uint8Array(),
        });
      });

      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const filename = `firmware_images_${timestamp}.zip`;

      await fileIO.writeFile(filename, zipData);
      statusMessage = `Images exported as ${filename}`;
    } catch (err) {
      showWarningDialog(
        "Export Error",
        `Failed to bundle images: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      isProcessing = false;
    }
  }

  // Show warning dialog
  function showWarningDialog(title: string, message: string) {
    warningTitle = title;
    warningMessage = message;
    showWarning = true;
  }

  // Font file type detection
  const FONT_EXTENSIONS = [".ttf", ".otf", ".woff", ".woff2"];
  const FONT_MIME_TYPES = [
    "font/ttf",
    "font/otf",
    "font/woff",
    "font/woff2",
    "application/font-ttf",
    "application/font-otf",
    "application/font-woff",
    "application/font-woff2",
    "application/x-font-ttf",
    "application/x-font-otf",
    "application/x-font-woff",
  ];

  function isFontFile(file: File): boolean {
    const fileName = file.name.toLowerCase();
    const hasFontExtension = FONT_EXTENSIONS.some((ext) =>
      fileName.endsWith(ext),
    );
    const hasFontMime = FONT_MIME_TYPES.includes(file.type);
    return hasFontExtension || hasFontMime;
  }

  // Unicode ranges for font replacement
  // SMALL fonts support 0x0000-0xffff (Basic Latin, Latin-1, etc.)
  // LARGE fonts support CJK range 0x4e00-0x9fff
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

  // Orchestrate font replacement process
  async function replaceFont(file: File): Promise<void> {
    if (!worker || !firmwareData) {
      showWarningDialog("Error", "No firmware loaded or worker not available.");
      return;
    }

    if (isProcessing) {
      showWarningDialog("Busy", "A replacement is already in progress. Please wait.");
      return;
    }

    isProcessing = true;
    statusMessage = `Loading font file: ${file.name}...`;

    let fontResult: {
      fontFace: FontFace;
      fontFamily: string;
      detectedType: "SMALL" | "LARGE" | null;
      fileName: string;
      isPixelPerfect: boolean;
    } | null = null;

    try {
      // Step 1: Load and validate the font file
      fontResult = await loadAndValidateFontFile(file);
      const { fontFamily, detectedType } = fontResult;

      if (!detectedType) {
        showWarningDialog(
          "Invalid Font File",
          `The font file "${file.name}" could not be validated. ` +
            `Please ensure it is a pixel art font designed for 12px or 16px size.`
        );
        return;
      }

      statusMessage = `Font loaded as ${detectedType}. Preparing replacement...`;

      // Step 2: Load tofu font for missing character detection
      await loadTofuFont();

      // Step 3: Determine Unicode ranges to process based on font type
      const fontSize = detectedType === "SMALL" ? 12 : 16;
      let codePointsToProcess: number[] = [];

      if (detectedType === "SMALL") {
        // SMALL fonts: process ranges 0x0000-0xffff
        for (const range of UNICODE_RANGES) {
          const start = Math.max(range.start, 0x0000);
          const end = Math.min(range.end, 0xffff);
          if (start <= end) {
            for (let cp = start; cp <= end; cp++) {
              codePointsToProcess.push(cp);
            }
          }
        }
      } else {
        // LARGE fonts: only process CJK range 0x4e00-0x9fff
        for (let cp = 0x4e00; cp <= 0x9fff; cp++) {
          codePointsToProcess.push(cp);
        }
      }

      statusMessage = `Extracting ${codePointsToProcess.length} characters from font...`;

      // Step 4: Extract pixel data for all characters in the main thread
      // (canvas rendering not available in worker)
      const fontReplacements: Array<{ unicode: number; pixels: boolean[][] }> = [];

      for (let i = 0; i < codePointsToProcess.length; i++) {
        const codePoint = codePointsToProcess[i];

        // Update progress periodically
        if (i % 100 === 0 || i === codePointsToProcess.length - 1) {
          statusMessage = `Extracting character ${i + 1}/${codePointsToProcess.length}...`;
        }

        try {
          const result = await extractCharacter(codePoint, {
            fontFamily,
            fontSize,
            useTofuFallback: true,
          });
          fontReplacements.push({
            unicode: codePoint,
            pixels: result.pixels,
          });
        } catch {
          // Skip characters that fail extraction
          // (these will be filtered out by tofu check in worker)
        }
      }

      statusMessage = `Sending ${fontReplacements.length} characters to worker...`;

      // Step 5: Send to worker for batch replacement
      await new Promise<void>((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          const { type, id, result, error } = e.data;

          if (id === "replaceFonts") {
            if (type === "progress") {
              statusMessage = e.data.message;
              return;
            }

            worker!.removeEventListener("message", handler);

            if (type === "success") {
              const data = result as {
                successCount: number;
                skippedCount: number;
                errors: string[];
                replacedCharacters: number[];
                skippedCharacters: number[];
                skippedReasons: Map<number, string>;
              };

              // Add replaced characters to tracking set
              for (const char of data.replacedCharacters) {
                replacedFontCharacters = new Set([...replacedFontCharacters, char]);
              }

              // Show summary dialog
              let summaryMessage = `Font replacement completed!\n\n`;
              summaryMessage += `Successfully replaced: ${data.successCount} characters\n`;
              summaryMessage += `Skipped: ${data.skippedCount} characters`;

              if (data.errors.length > 0) {
                summaryMessage += `\n\nErrors: ${data.errors.length}`;
                summaryMessage += `\n${data.errors.slice(0, 3).join("\n")}`;
                if (data.errors.length > 3) {
                  summaryMessage += `\n...and ${data.errors.length - 3} more`;
                }
              }

              statusMessage = `Font replacement complete: ${data.successCount} replaced, ${data.skippedCount} skipped`;

              showWarningDialog("Font Replacement Complete", summaryMessage);
              resolve();
            } else {
              reject(new MessageEvent("error", { data: error }));
            }
          }
        };

        worker!.addEventListener("message", handler);

        worker!.postMessage({
          type: "replaceFonts",
          id: "replaceFonts",
          firmware: new Uint8Array(),
          fontType: detectedType,
          fontReplacements,
        });
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Show specific modal for invalid font files (non-pixel-perfect)
      if (err instanceof FontLoadingError) {
        showWarningDialog("Invalid Font File", errorMessage);
      } else {
        showWarningDialog(
          "Font Replacement Error",
          `Failed to replace font:\n${errorMessage}`
        );
      }
      statusMessage = `Font replacement failed: ${errorMessage}`;
    } finally {
      // Clean up font resources
      if (fontResult) {
        try {
          unloadFontFile(fontResult.fontFace, fontResult.fontFamily);
        } catch {
          // Ignore cleanup errors
        }
      }
      isProcessing = false;
    }
  }

  // Handle keyboard shortcuts (Ctrl+S for export)
  function handleKeyDown(e: KeyboardEvent) {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      exportFirmware();
    }
  }

  // Handle sequence replacement
  async function handleSequenceReplace(mappings: { target: BitmapFileInfo; source: File }[]) {
     isProcessing = true;
     statusMessage = `Processing ${mappings.length} images...`;

     const replacements: any[] = [];
     
     try {
         for (const { target, source } of mappings) {
             const rgb565Result = await imageToRgb565(
                source,
                target.width,
                target.height,
                { resize: true, grayscale: false }
             );
             
             if (!rgb565Result) throw new Error(`Failed to process ${source.name}`);

             replacements.push({
                 imageName: target.name,
                 width: target.width,
                 height: target.height,
                 offset: target.offset!,
                 rgb565Data: rgb565Result.rgb565Data
             });
         }

          await new Promise<void>((resolve, reject) => {
            const handler = (e: MessageEvent) => {
              const { type, id, result, error } = e.data;
              if (id === "replaceSequence") {
                if (type === "progress") return;
                
                worker!.removeEventListener("message", handler);
                if (type === "success") {
                  // Update replaced images list
                   for (const r of replacements) {
                       if (!replacedImages.includes(r.imageName)) {
                           replacedImages = [...replacedImages, r.imageName];
                       }
                   }
                   statusMessage = `Successfully replaced ${replacements.length} images`;
                   resolve();
                } else {
                   reject(new Error(error || "Worker failed to replace sequence"));
                }
              }
            };

            worker!.addEventListener("message", handler);
            
            worker!.postMessage({
              type: "replaceImages",
              id: "replaceSequence",
              firmware: new Uint8Array(),
              images: replacements,
            });
          });

     } catch (err) {
         showWarningDialog(
            "Sequence Replacement Failed", 
            err instanceof Error ? err.message : String(err)
         );
     } finally {
         isProcessing = false;
     }
  }

  // Drag and drop handlers
  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    isDragOver = true;
    dropZone.classList.add("drag-over");
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
    dropZone.classList.remove("drag-over");
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
    dropZone.classList.remove("drag-over");

    const file = e.dataTransfer?.files[0];
    if (file) {
      loadFirmware(file);
    }
  }

  // Drag & drop handlers for image replacement
  function handleImageDragOver(e: DragEvent) {
    e.preventDefault();
    // Check if any file is being dragged
    if (e.dataTransfer?.types.includes("Files")) {
      isImageDragOver = true;
    }
  }

  function handleImageDragLeave(e: DragEvent) {
    e.preventDefault();
    isImageDragOver = false;
  }

  async function handleImageDrop(e: DragEvent) {
    e.preventDefault();
    isImageDragOver = false;

    if (!firmwareData || imageList.length === 0) {
      return;
    }

    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;

    // Check for font files first
    const fontFiles = files.filter(isFontFile);
    if (fontFiles.length > 0) {
      // Font file detected - route to font replacement flow
      await replaceFont(fontFiles[0]);
      return;
    }

    // Smart Replacement Logic:
    // If exactly ONE file is dropped, AND we have an image selected,
    // we assume the user wants to replace THIS specific image with the dropped file.
    if (files.length === 1 && selectedNode?.type === "image" && imageData) {
      await replaceCurrentlySelectedImage(files[0]);
      return;
    }

    // Default: Process dropped files as batch replacement by filename
    await handlePasteFiles(files);
  }

  // Helper: Replace currently selected image with specific file (Smart Replace)
  async function replaceCurrentlySelectedImage(file: File) {
    if (!selectedNode || selectedNode.type !== "image" || !imageData) return;

    // Confirm replacement? (Optional, currently direct action)
    isProcessing = true;
    statusMessage = `Processing ${file.name} for ${imageData.name}...`;

    try {
      // Auto-resize and format the image to match the target
      const rgb565Result = await imageToRgb565(
        file,
        imageData.width,
        imageData.height,
        { resize: true, grayscale: false }
      );

      if (!rgb565Result) {
        throw new Error("Failed to process image");
      }

      // Send replacement to worker
      const replacement = {
        imageName: imageData.name,
        width: imageData.width,
        height: imageData.height,
        offset: (selectedNode.data as BitmapFileInfo).offset!,
        rgb565Data: rgb565Result.rgb565Data,
      };

      await new Promise<void>((resolve, reject) => {
         const handler = (e: MessageEvent) => {
          const { type, id, result, error } = e.data;
          
          if (id === "replaceSingleImage") {
            // Ignore progress messages
            if (type === "progress") return;

            worker!.removeEventListener("message", handler);
            
            if (type === "success") {
               // Update UI
               if (imageData) {
                   imageData.rgb565Data = replacement.rgb565Data;
               }
               if (!replacedImages.includes(replacement.imageName)) {
                  replacedImages = [...replacedImages, replacement.imageName];
               }
               statusMessage = `Successfully replaced ${replacement.imageName}`;
               resolve();
            } else {
               reject(new Error(error || "Worker failed to replace image"));
            }
          }
        };

        worker!.addEventListener("message", handler);
        
        worker!.postMessage({
          type: "replaceImages",
          id: "replaceSingleImage",
          firmware: new Uint8Array(),
          images: [replacement],
        });
      });

    } catch (err) {
      showWarningDialog(
        "Replacement Failed",
        `Failed to process ${file.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      isProcessing = false;
    }
  }

  // Trigger file input
  function triggerFileInput() {
    fileInput.click();
  }

  // Trigger edit file input for multiple file selection
  function triggerEditFileInput() {
    editFileInput.click();
  }

  // Handle edit file select (multiple files)
  async function handleEditFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const files = target.files;
    if (files && files.length > 0) {
      // Check for single file smart replacement context
      if (files.length === 1 && selectedNode?.type === "image" && imageData) {
        await replaceCurrentlySelectedImage(files[0]);
      } else {
        const fileArray = Array.from(files);
        await handlePasteFiles(fileArray);
      }
    }
    // Reset input so the same files can be selected again
    target.value = "";
  }

  // Handle close button on resource viewer - reset and show file picker
  function handleCloseResourceViewer() {
    firmwareData = null;
    treeNodes = [];
    imageList = [];
    selectedNode = null;
    planeData = null;
    imageData = null;
    statusMessage = "Ready to load firmware";
  }
</script>

<div class="page-wrapper">
  <!-- Hidden file input - always in DOM for toolbar button -->
  <input
    type="file"
    bind:this={fileInput}
    hidden
    onchange={handleFileSelect}
  />

  <div class="page-container">
    <!-- Drop Zone Window - hidden when loading or loaded -->
    {#if !firmwareData && !isProcessing}
      <Window title="FlameOcean" width="500px" showClose={false}>
        <WindowBody>
          <div
            bind:this={dropZone}
            class="drop-zone"
            ondragover={handleDragOver}
            ondragleave={handleDragLeave}
            ondrop={handleDrop}
            onclick={triggerFileInput}
            onkeydown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                triggerFileInput();
              }
            }}
            role="button"
            tabindex="0"
          >
            <div class="drop-zone-content">
              {#if !firmwareData}
                <img
                  src={isDragOver ? "/folder-drag-accept.png" : "/folder.png"}
                  alt="Folder"
                  class="folder-icon"
                />
                <div class="drop-text">
                  Drop firmware file here or click to browse
                </div>
              {:else}
                <img src="/folder.png" alt="Folder" class="folder-icon" />
                <div class="drop-text">
                  Firmware loaded! Click to load a different file
                </div>
              {/if}
            </div>
          </div>
        </WindowBody>
      </Window>
    {/if}

    <!-- Loading Window -->
    {#if showLoadingWindow}
      <LoadingWindow message={statusMessage} {progress} />
    {/if}

    <!-- Main Browser Interface -->
    {#if firmwareData && treeNodes.length > 0 && !showSequenceReplacer}
      <Window
        title="Resource Browser"
        class="browser-window"
        onclose={handleCloseResourceViewer}
      >
        <WindowBody>
          <!-- Toolbar with icon buttons -->
          <div class="toolbar">
            <button
              type="button"
              class="toolbar-button"
              title="Open Firmware (Ctrl+O)"
              onclick={triggerFileInput}
              disabled={!firmwareData}
            >
              <img src="/document-open.png" alt="" class="toolbar-icon" />
            </button>
            <button
              type="button"
              class="toolbar-button"
              title="Save Firmware (Ctrl+S)"
              onclick={exportFirmware}
              disabled={!firmwareData || isProcessing}
            >
              <img src="/document-save.png" alt="" class="toolbar-icon" />
            </button>
            <button
              type="button"
              class="toolbar-button"
              title="Download All Images as ZIP"
              onclick={bundleImagesAsZip}
              disabled={!firmwareData || isProcessing}
            >
              <img src="/document-export.png" alt="" class="toolbar-icon" />
            </button>
            <button
              type="button"
              class="toolbar-button"
              title="Edit Images (Ctrl+V)"
              onclick={triggerEditFileInput}
              disabled={!firmwareData || isProcessing}
            >
              <img src="/document-edit.png" alt="" class="toolbar-icon" />
            </button>
            <button
              type="button"
              class="toolbar-button"
              title="Replace Image Sequence"
              onclick={() => showSequenceReplacer = !showSequenceReplacer}
              disabled={!firmwareData || imageList.length === 0}
            >
              <img src="/video.png" alt="" class="toolbar-icon-small" />
            </button>
            <input
              type="file"
              accept=".bmp,.png,.jpg,.jpeg"
              multiple
              hidden
              class="hidden-input"
              bind:this={editFileInput}
              onchange={handleEditFileSelect}
            />
          </div>

          <div class="browser-layout">
            <!-- Tree View -->
            <div class="tree-panel">
              <TreeView
                nodes={treeNodes}
                expanded={expandedNodes}
                selected={selectedNode?.id ?? ''}
                onSelect={(nodeId) => handleSelectNode(nodeId)}
                {replacedImages}
              />
            </div>

            <!-- Resource Content -->
            <div
              class="content-panel"
              class:drag-over-images={isImageDragOver}
              ondragover={handleImageDragOver}
              ondragleave={handleImageDragLeave}
              ondrop={handleImageDrop}
              role="region"
              aria-label="Image viewer - drop images here to replace"
            >
              {#if selectedNode}
                {#if isProcessing}
                  <div class="empty-state">
                    <p>Loading {selectedNode.type}...</p>
                  </div>
                {:else if selectedNode.type === "plane" && planeData}
                  <div class="plane-header">
                    <h2>{planeData.name}</h2>
                    <p>
                      U+{planeData.start.toString(16).toUpperCase()} - U+{planeData.end
                        .toString(16)
                        .toUpperCase()}
                    </p>
                    <p>{planeData.fonts.length} glyphs found</p>
                  </div>
                  <div class="flex-grow">
                    <FontGridRenderer fonts={planeData.fonts} zoom={10} replacedChars={replacedFontCharacters} />
                  </div>
                {:else if selectedNode.type === "image" && imageData}
                  <ImageRenderer
                    name={imageData.name}
                    width={imageData.width}
                    height={imageData.height}
                    rgb565Data={imageData.rgb565Data}
                    zoom={2}
                  />
                {:else}
                  <div class="empty-state">
                    <p>No data available for this resource</p>
                  </div>
                {/if}
              {:else}
                <div class="empty-state">
                  <p>Select a resource from the tree to view its contents</p>
                </div>
              {/if}
            </div>
          </div>
        </WindowBody>
      </Window>
    {/if}

    <!-- Sequence Replacer Window -->
    {#if firmwareData && treeNodes.length > 0 && showSequenceReplacer}
      <SequenceReplacerWindow
        targetImages={imageList}
        worker={worker!}
        onApply={handleSequenceReplace}
        onClose={() => showSequenceReplacer = false}
      />
    {/if}
  </div>

  <!-- Status Bar Footer -->
  <footer class="status-footer">
    <div class="status-bar-window">
      <StatusBar statusFields={[{ text: statusMessage }]} />
    </div>
  </footer>

  <!-- Warning Dialog -->
  {#if showWarning}
    <WarningWindow
      title={warningTitle}
      message={warningMessage}
      onconfirm={() => (showWarning = false)}
      showCancel={false}
    />
  {/if}
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    padding: 0;
    overflow: hidden;
  }

  .page-wrapper {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: url("/background.png") no-repeat center center;
    background-size: cover;
  }

  .page-container {
    max-width: 100vw;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 20px;
    overflow-y: auto;
  }

  .status-footer {
    flex-shrink: 0;
    background-color: #c0c0c0;
    border-top: 2px solid #ffffff;
  }

  .status-footer :global(.window) {
    border: none;
    box-shadow: none;
    margin: 0;
  }

  .status-footer :global(.status-bar) {
    border: none;
    margin: 0;
    font-family: "Pixelated MS Sans Serif", Arial;
  }

  :global(.window) {
    margin: 0 auto;
  }

  .drop-zone {
    padding: 40px;
    border: 2px inset #808080;
    background-color: #ffffff;
    text-align: center;
    cursor: pointer;
  }

  .drop-zone:hover {
    background-color: #eeeeee;
  }

  .drop-zone :global(.drag-over) {
    border: 2px inset #000080;
    background-color: #e0e0ff;
  }

  .drop-zone-content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  .folder-icon {
    width: 64px;
    height: 64px;
    image-rendering: pixelated;
  }

  .drop-text {
    font-size: 14px;
    color: #000000;
  }

  :global(.browser-window) {
    max-width: 1024px;
    max-height: 768px;
    width: 100%;
    height: auto;
    margin: 64px;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
  }

  :global(.browser-window .window-body) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Toolbar styling */
  .toolbar {
    display: flex;
    gap: 2px;
    margin-bottom: 6px;
  }

  .toolbar-button {
    display: inline-flex;
    padding: 2px;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    min-height: 22px;
    border: 1px solid #ffffff;
    border-right-color: #000000;
    border-bottom-color: #000000;
    background-color: #c0c0c0;
    cursor: pointer;
  }

  .toolbar-button:active,
  .toolbar-button:active:not(:disabled) {
    border: 1px solid #000000;
    border-right-color: #ffffff;
    border-bottom-color: #ffffff;
    padding: 1px 0 0 1px;
  }

  .toolbar-button:hover:not(:disabled) {
    background-color: #dfdfdf;
  }

  .toolbar-button:focus {
    outline: 1px dotted #000000;
    outline-offset: -4px;
  }

  .toolbar-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toolbar-icon {
    width: 24px;
    height: 24px;
    image-rendering: pixelated;
    pointer-events: none;
  }

  .toolbar-icon-small {
    width: 16px;
    height: 16px;
    margin: 4px;
    image-rendering: pixelated;
    pointer-events: none;
  }

  .browser-layout {
    display: grid;
    grid-template-columns: 220px 1fr;
    grid-template-rows: 1fr;
    gap: 0;
    width: 100%;
    height: 600px;
    overflow: hidden;
  }

  .tree-panel {
    overflow: hidden;
    height: 100%;
  }

  .tree-panel :global(.tree-view) {
    height: 100%;
  }

  .content-panel {
    padding-left: 8px;
    padding-top: 8px;
    overflow: hidden;
    height: 100%;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  .content-panel.drag-over-images {
    background-color: #e0ffe0;
    border: 2px inset #008000;
  }

  .plane-header {
    padding-bottom: 8px;
  }

  .plane-header h2 {
    font-size: 16px;
    margin: 0 0 8px 0;
  }

  .plane-header p {
    font-size: 12px;
    margin: 4px 0;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: #808080;
  }

  .flex-grow {
    flex: 1 1 0;
    min-height: 0;
    box-sizing: border-box;
  }
</style>
