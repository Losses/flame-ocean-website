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
  import SequenceReplacer from "$lib/components/firmware/SequenceReplacer.svelte";
  import FirmwareWorker from "$lib/workers/firmware-worker.ts?worker";
  import {
    initDebugShortcut,
    debugMode,
    debugAnimationComplete,
  } from "$lib/stores";
  import { fileIO } from "$lib/rse/utils/file-io";
  import { imageToRgb565 } from "$lib/rse/utils/bitmap";

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
  let selectedNodeIds = $state(new Set<string>());
  let expandedNodes = $state(new Set<string>());
  let treeNodes = $state<TreeNode[]>([]);
  
  // Derived state for multi-selection
  let selectedImages = $derived(
    Array.from(selectedNodeIds)
        .map(id => findNodeById(treeNodes, id))
        .filter(n => n && n.type === 'image')
        .map(n => n!.data as BitmapFileInfo)
  );

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

    // Add paste listener for image replacement
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
        }
      }

      if (files.length === 0) return;

      // Smart Replacement Logic for Paste:
      if (files.length === 1 && selectedNode?.type === "image" && imageData) {
        await replaceCurrentlySelectedImage(files[0]);
      } else {
        await handlePasteFiles(files);
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

    // Auto-expand the font folders
    expandedNodes = new Set(["fonts", "fonts-small", "fonts-large"]);
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

  // Helper to get all visible nodes in flattened order for Shift selection
  function getVisibleNodes(nodes: TreeNode[], expanded: Set<string>): TreeNode[] {
    let visible: TreeNode[] = [];
    for (const node of nodes) {
      visible.push(node);
      if (node.children && expanded.has(node.id)) {
        visible = [...visible, ...getVisibleNodes(node.children, expanded)];
      }
    }
    return visible;
  }

  // Handle tree node selection from TreeView onSelect
  function handleSelectNode(nodeId: string, e?: MouseEvent | KeyboardEvent) {
    const node = findNodeById(treeNodes, nodeId);
    if (!node) return;

    if (e && (e instanceof MouseEvent || e instanceof KeyboardEvent)) {
      const ctrlKey = e.ctrlKey || e.metaKey;
      const shiftKey = e.shiftKey;

      if (shiftKey && selectedNodeIds.size > 0) {
        // Range selection
        const visibleNodes = getVisibleNodes(treeNodes, expandedNodes);
        const lastSelectedId = Array.from(selectedNodeIds).pop();
        const startIdx = visibleNodes.findIndex(n => n.id === lastSelectedId);
        const endIdx = visibleNodes.findIndex(n => n.id === nodeId);
        
        if (startIdx !== -1 && endIdx !== -1) {
          const [min, max] = [Math.min(startIdx, endIdx), Math.max(startIdx, endIdx)];
          const range = visibleNodes.slice(min, max + 1).map(n => n.id);
          const newSet = new Set(selectedNodeIds);
           range.forEach(id => newSet.add(id));
           selectedNodeIds = newSet;
        }
      } else if (ctrlKey) {
        // Toggle selection
        const newSet = new Set(selectedNodeIds);
        if (newSet.has(nodeId)) {
          newSet.delete(nodeId);
        } else {
          newSet.add(nodeId);
        }
        selectedNodeIds = newSet;
      } else {
        // Single selection
        selectedNodeIds = new Set([nodeId]);
      }
    } else {
        // Fallback for programmatic or basic selection
        selectedNodeIds = new Set([nodeId]);
    }

    // Update main view based on selection
    if (selectedNodeIds.size === 1) {
       handleNodeClick(node);
    } else if (selectedNodeIds.size > 1) {
       // Multiple selected: Clear single view
       planeData = null;
       imageData = null;
       selectedNode = null; // Or keep last clicked?
       // We will handle multi-selection view later (SequenceReplacer)
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
    if (!firmwareData || imageList.length === 0) {
      showWarningDialog("Error", "No firmware loaded or no images available.");
      return;
    }

    if (!worker) {
      showWarningDialog("Error", "Worker not available.");
      return;
    }

    isProcessing = true;
    statusMessage = `Preparing to replace ${files.length} image(s)...`;

    // Collect all valid replacements
    const replacements: Array<{
      image: BitmapFileInfo;
      rgb565Data: Uint8Array;
    }> = [];
    const notFound: string[] = [];
    const decodeError: string[] = [];

    // Convert all files to RGB565 in parallel
    const conversionPromises = files.map(async (file) => {
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
    selectedNodeIds = new Set();
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
    {#if firmwareData && treeNodes.length > 0}
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
                selected={selectedNodeIds}
                onSelect={(nodeId, e) => handleSelectNode(nodeId, e)}
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
              {#if selectedImages.length > 1}
                 <SequenceReplacer 
                    targetImages={selectedImages} 
                    onApply={handleSequenceReplace} 
                    onCancel={() => handleSelectNode(Array.from(selectedNodeIds)[0])} 
                 />
              {:else if selectedNode}
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
                    <FontGridRenderer fonts={planeData.fonts} zoom={10} />
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
