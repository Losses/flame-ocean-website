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

  // File input
  // svelte-ignore non_reactive_update
  let fileInput: HTMLInputElement;
  // svelte-ignore non_reactive_update
  let dropZone: HTMLDivElement;
  let isDragOver = $state(false);

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

  // Initialize worker
  onMount(() => {
    // Initialize global debug shortcut (Ctrl+Shift+D)
    initDebugShortcut();

    // Add keyboard listener for Ctrl+S export
    window.addEventListener("keydown", handleKeyDown);

    // Add paste listener for image replacement
    window.addEventListener("paste", async (e: ClipboardEvent) => {
      // Prevent concurrent replacements
      if (isProcessing) {
        showWarningDialog("Busy", "A replacement is already in progress. Please wait.");
        return;
      }

      const items = e.clipboardData?.items;
      if (!items) return;

      // Collect all image files
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

      // Process files sequentially
      await handlePasteFiles(files);
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

  // Handle tree node selection from TreeView onSelect
  function handleSelectNode(nodeId: string) {
    const node = findNodeById(treeNodes, nodeId);
    if (node) {
      selectedNodeIds = new Set([nodeId]);
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
        (img) => img.name.replace(/\.[^.]*$/, "").toUpperCase() === pastedFileName
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
        message += `Not found in firmware (${notFound.length}):\n${notFound.slice(0, 5).join(', ')}${notFound.length > 5 ? '...' : ''}\n\n`;
      }

      if (decodeError.length > 0) {
        message += `Errors (${decodeError.length}):\n${decodeError.slice(0, 3).join('\n')}${decodeError.length > 3 ? '\n...' : ''}`;
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
          worker!.removeEventListener('message', handler);

          if (type === 'success') {
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
                  rgb565Data: r.rgb565Data
                };
              }
            }

            // Combine errors from main thread and worker
            const allNotFound = [...notFound, ...(data.notFound || [])];
            const allDimensionMismatch = [...decodeError.filter(e => e.includes('Dimension mismatch')), ...(data.dimensionMismatch || [])];
            const allReplaceError = [...decodeError.filter(e => !e.includes('Dimension mismatch')), ...(data.replaceError || [])];

            const totalErrors = allNotFound.length + allDimensionMismatch.length + allReplaceError.length;

            if (totalErrors > 0) {
              let message = `Successfully replaced: ${data.successCount}\n\n`;

              if (allNotFound.length > 0) {
                message += `Not found in firmware (${allNotFound.length}):\n${allNotFound.slice(0, 5).join(', ')}${allNotFound.length > 5 ? '...' : ''}\n\n`;
              }

              if (allDimensionMismatch.length > 0) {
                message += `Dimension mismatch (${allDimensionMismatch.length}):\n${allDimensionMismatch.slice(0, 3).join('\n')}${allDimensionMismatch.length > 3 ? '\n...' : ''}\n\n`;
              }

              if (allReplaceError.length > 0) {
                message += `Replacement errors (${allReplaceError.length}):\n${allReplaceError.slice(0, 3).join('\n')}${allReplaceError.length > 3 ? '\n...' : ''}\n\n`;
              }

              showWarningDialog("Replacement Completed with Errors", message.trim());
            } else {
              statusMessage = `Successfully replaced ${data.successCount} image(s)`;
            }
          } else if (type === 'error') {
            showWarningDialog("Replacement Error", `Failed to replace images: ${result}`);
          }

          isProcessing = false;
          resolve();
        }
      };

      worker!.addEventListener('message', handler);

      worker!.postMessage({
        type: "replaceImages",
        id: "replaceImages",
        firmware: new Uint8Array(),
        images: replacements.map(r => ({
          imageName: r.image.name,
          width: r.image.width,
          height: r.image.height,
          offset: r.image.offset!,
          rgb565Data: r.rgb565Data
        }))
      });
    });
  }

  // Export firmware with timestamp
  async function exportFirmware() {
    if (!firmwareData) {
      showWarningDialog("Export Error", "No firmware data to export.");
      return;
    }

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const filename = `firmware_modified_${timestamp}.bin`;

    try {
      await fileIO.writeFile(filename, firmwareData);
      statusMessage = `Firmware exported as ${filename}`;
    } catch (err) {
      showWarningDialog(
        "Export Error",
        `Failed to export firmware: ${err instanceof Error ? err.message : String(err)}`
      );
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

  // Trigger file input
  function triggerFileInput() {
    fileInput.click();
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
            <input
              type="file"
              bind:this={fileInput}
              hidden
              onchange={handleFileSelect}
            />
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
          <div class="browser-layout">
            <!-- Tree View -->
            <div class="tree-panel">
              <TreeView
                nodes={treeNodes}
                expanded={expandedNodes}
                selected={selectedNodeIds}
                onSelect={(nodeId) => handleSelectNode(nodeId)}
              />
            </div>

            <!-- Resource Content -->
            <div class="content-panel">
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
