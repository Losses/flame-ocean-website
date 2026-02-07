<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    Window,
    WindowBody,
    TreeView,
    StatusBar,
    LoadingWindow,
  } from "$lib/components/98css";
  import FontGridRenderer from "$lib/components/firmware/FontGridRenderer.svelte";
  import ImageRenderer from "$lib/components/firmware/ImageRenderer.svelte";
  import FirmwareWorker from "$lib/workers/firmware-worker.ts?worker";
  import {
    initDebugShortcut,
    debugMode,
    debugAnimationComplete,
  } from "$lib/stores";

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
</script>

<div class="page-wrapper">
  <div class="page-container">
    <!-- Drop Zone Window - hidden when loading or loaded -->
    {#if !firmwareData && !isProcessing}
      <Window title="Firmware Browser" width="500px">
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
      <Window title="Resource Browser" class="browser-window">
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
    font-family: "Tahoma", "MS Sans Serif", sans-serif;
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
