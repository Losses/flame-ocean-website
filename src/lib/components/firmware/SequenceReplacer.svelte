<script lang="ts">
  import type { BitmapFileInfo } from "../../rse/types";
  import { extractFrames } from "../../rse/utils/video-extractor";
  import { TreeView, LoadingWindow } from "../98css";
  import ImageRenderer from "./ImageRenderer.svelte";

  interface Props {
    targetImages: BitmapFileInfo[];
    onLoadImage: (image: BitmapFileInfo) => Promise<{
      name: string;
      width: number;
      height: number;
      rgb565Data: Uint8Array;
    } | null>;
    onApply: (mappings: { target: BitmapFileInfo; source: File }[]) => void;
    onCancel: () => void;
  }

  let { targetImages, onLoadImage, onApply, onCancel }: Props = $props();

  // Group parsing state
  interface ImageGroup {
    prefix: string;
    displayName: string;
    images: BitmapFileInfo[];
  }

  let selectedGroupId = $state<string>("");
  let selectedImageId = $state<string>("");

  // Source file state
  let sourceFiles = $state<File[]>([]);
  let sourceFileMap = $state<Map<string, File>>(new Map()); // target name → source file (for images)
  let isFromVideo = $state(false); // Track if sourceFiles came from video extraction
  let isDragOver = $state(false);
  let isExtracting = $state(false);
  let previewUrl = $state<string | null>(null);
  let currentSourceIndex = $state(0);

  // Target image data from firmware
  let targetImageData = $state<{
    name: string;
    width: number;
    height: number;
    rgb565Data: Uint8Array;
  } | null>(null);
  let isLoadingTarget = $state(false);

  // Action to store file input reference
  function fileInputAction(node: HTMLInputElement) {
    fileInputRef = node;
    return {};
  }

  let fileInputRef: HTMLInputElement;

  // Compute groups from target images (derived, no reactivity issues)
  let groups = $derived(parseImageGroups(targetImages));

  // Convert groups to tree nodes for TreeView
  let groupNodes = $derived(
    groups.map((group) => ({
      id: `group-${group.prefix}`,
      label: `${group.prefix} (${group.images.length})`,
      children: [],
    })),
  );

  // Convert files in selected group to tree nodes
  let fileNodes = $derived.by(() => {
    const selectedGroup = groups.find(
      (g) => `group-${g.prefix}` === selectedGroupId,
    );
    if (!selectedGroup) return [];
    return selectedGroup.images.map((img, idx) => ({
      id: `file-${selectedGroup.prefix}-${idx}`,
      label: `${img.name} (${img.width}x${img.height})`,
    }));
  });

  // Get selected group and image
  let selectedGroup = $derived(
    groups.find((g) => `group-${g.prefix}` === selectedGroupId),
  );
  let selectedImage = $derived(
    selectedGroup?.images.find(
      (_, idx) => `file-${selectedGroup.prefix}-${idx}` === selectedImageId,
    ) ?? null,
  );

  // Initialize selected group when groups change
  $effect(() => {
    if (groups.length > 0 && !selectedGroupId) {
      selectedGroupId = `group-${groups[0].prefix}`;
      selectedImageId = `file-${groups[0].prefix}-0`;
    }
  });

  // Parse images into groups based on filename patterns
  function parseImageGroups(images: BitmapFileInfo[]): ImageGroup[] {
    const groupMap = new Map<string, BitmapFileInfo[]>();

    for (const img of images) {
      const groupKey = extractGroupKey(img.name);
      // Skip images that don't match any pattern
      if (!groupKey.prefix) continue;

      if (!groupMap.has(groupKey.prefix)) {
        groupMap.set(groupKey.prefix, []);
      }
      groupMap.get(groupKey.prefix)!.push(img);
    }

    // Convert to array, validate dimensions, filter single-file groups, and sort
    return Array.from(groupMap.entries())
      .filter(([_, imgs]) => {
        // Must have multiple files
        if (imgs.length <= 1) return false;

        // All images in the group must have consistent dimensions
        const firstDim = `${imgs[0].width}x${imgs[0].height}`;
        return imgs.every((img) => `${img.width}x${img.height}` === firstDim);
      })
      .map(([prefix, imgs]) => ({
        prefix,
        displayName: `${prefix} (${imgs[0].width}x${imgs[0].height})`,
        images: imgs.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { numeric: true }),
        ),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  // Extract group prefix from filename (e.g., "Z_POWERON0_(0,0).BMP" -> "Z_POWERON")
  function extractGroupKey(filename: string): {
    prefix: string;
    number: string;
  } {
    // Pattern 1: Z_POWERON0_(0,0).BMP -> prefix: Z_POWERON (note the underscore before (x,y))
    const match1 = filename.match(/^(.+?)(\d+)_\((\d+),(\d+)\)\./);
    if (match1) {
      return { prefix: match1[1], number: match1[2] };
    }

    // Pattern 2: Z_POWERON_0_0.BMP -> prefix: Z_POWERON_
    const match2 = filename.match(/^(.+?)[_-](\d+)[_-](\d+)[_.]/);
    if (match2) {
      return { prefix: match2[1], number: match2[2] };
    }

    // Pattern 3: FRAME_0001.BMP -> prefix: FRAME_
    const match3 = filename.match(/^(.+?)[_-](\d+)[_.]/);
    if (match3) {
      const prefix = match3[1];
      // Add separator if not already present
      const finalPrefix =
        prefix.endsWith("_") || prefix.endsWith("-") ? prefix : prefix + "_";
      return { prefix: finalPrefix, number: match3[2] };
    }

    // No pattern found - return empty prefix to filter out this image
    return { prefix: "", number: "" };
  }

  // Handle group selection from TreeView
  async function handleGroupSelect(nodeId: string) {
    selectedGroupId = nodeId;
    const group = groups.find((g) => `group-${g.prefix}` === nodeId);
    if (group && group.images.length > 0) {
      selectedImageId = `file-${group.prefix}-0`;
      currentSourceIndex = 0;

      // Clear previous data to show loading state
      targetImageData = null;

      // Load target image from firmware
      await loadTargetImage(group.images[0]);

      // Clear sources when switching groups (mappings would be invalid)
      clearSources();
    }
    cleanupPreview();
    updatePreview();
  }

  // Handle image selection from TreeView
  async function handleImageSelect(nodeId: string) {
    selectedImageId = nodeId;
    const match = nodeId.match(/file-(.+)-(\d+)/);
    if (match) {
      const group = groups.find((g) => g.prefix === match[1]);
      if (group) {
        const idx = parseInt(match[2], 10);
        currentSourceIndex = idx;
      }
    }

    // Clear previous data to show loading state
    targetImageData = null;

    // Load target image from firmware
    if (selectedImage) {
      await loadTargetImage(selectedImage);
    }

    updatePreview();
  }

  // Load target image data from firmware
  async function loadTargetImage(image: BitmapFileInfo) {
    isLoadingTarget = true;
    try {
      const data = await onLoadImage(image);
      targetImageData = data;
    } catch (e) {
      console.error("Failed to load target image:", e);
      targetImageData = null;
    } finally {
      isLoadingTarget = false;
    }
  }

  async function handleFilesDrop(files: File[]) {
    if (files.length === 0) return;

    const videoFile = files.find((f) => f.type.startsWith("video/"));

    if (videoFile) {
      // VIDEO: Extract frames and use index-based matching
      isExtracting = true;
      isFromVideo = true;
      sourceFileMap.clear();
      try {
        const frames = await extractFrames(
          videoFile,
          selectedGroup?.images.length || 30,
        );
        sourceFiles = frames;
      } catch (e) {
        console.error("Failed to extract frames", e);
        alert(
          "Failed to extract frames from video: " +
            (e instanceof Error ? e.message : String(e)),
        );
      } finally {
        isExtracting = false;
      }
    } else {
      // IMAGES: Match by exact filename (with flexible extension)
      isFromVideo = false;
      sourceFiles = []; // Clear array-based source
      sourceFileMap.clear();

      if (selectedGroup) {
        // Create a map of dropped files by base filename (without extension)
        const droppedFileMap = new Map<string, File>();
        for (const file of files) {
          const baseName = file.name.replace(/\.[^.]+$/, ''); // Remove extension
          droppedFileMap.set(baseName, file);
        }

        // Match target images with dropped files by exact filename
        for (const targetImg of selectedGroup.images) {
          const targetBaseName = targetImg.name.replace(/\.[^.]+$/, '');
          const matchedFile = droppedFileMap.get(targetBaseName);
          if (matchedFile) {
            sourceFileMap.set(targetImg.name, matchedFile);
          }
        }
      }
    }
    updatePreview();
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      const files = Array.from(input.files);
      handleFilesDrop(files);
    }
    // Reset input so the same files can be selected again
    input.value = "";
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    isDragOver = true;
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    isDragOver = false;
    if (e.dataTransfer?.files) {
      const files = Array.from(e.dataTransfer.files);
      handleFilesDrop(files);
    }
  }

  function triggerFileInput() {
    fileInputRef?.click();
  }

  function updatePreview() {
    cleanupPreview();
    let sourceFile: File | undefined;

    if (isFromVideo) {
      // Video mode: Use index-based array
      sourceFile = sourceFiles[currentSourceIndex];
    } else {
      // Image mode: Look up by target image name
      if (selectedImage) {
        sourceFile = sourceFileMap.get(selectedImage.name);
      }
    }

    if (sourceFile) {
      previewUrl = URL.createObjectURL(sourceFile);
    }
  }

  function cleanupPreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  function clearSources() {
    sourceFiles = [];
    sourceFileMap.clear();
    isFromVideo = false;
  }

  function apply() {
    if (!selectedGroup) return;

    const mappings: { target: BitmapFileInfo; source: File }[] = [];

    if (isFromVideo) {
      // Video mode: Index-based matching for extracted frames
      if (sourceFiles.length === 0) return;

      for (
        let i = 0;
        i < selectedGroup.images.length && i < sourceFiles.length;
        i++
      ) {
        mappings.push({
          target: selectedGroup.images[i],
          source: sourceFiles[i],
        });
      }
    } else {
      // Image mode: Filename-based matching only
      if (sourceFileMap.size === 0) return;

      for (const targetImg of selectedGroup.images) {
        const sourceFile = sourceFileMap.get(targetImg.name);
        if (sourceFile) {
          mappings.push({
            target: targetImg,
            source: sourceFile,
          });
        }
      }
    }

    if (mappings.length > 0) {
      onApply(mappings);
      cleanupPreview();
    }
  }

  // Cleanup on unmount
  $effect(() => {
    return () => cleanupPreview();
  });
</script>

<div class="sequence-replacer">
  <div class="header">
    <h3>Replace Image Sequence</h3>
    <p>Select a group, then load replacement files with matching filenames (or drop a video)</p>
  </div>

  <div class="content">
    <!-- Column 1: Groups -->
    <div class="column groups">
      <h4>Groups ({groups.length})</h4>
      <TreeView
        nodes={groupNodes}
        selected={selectedGroupId}
        onSelect={handleGroupSelect}
      />
    </div>

    <!-- Column 2: Files in selected group -->
    <div class="column files">
      <h4>
        {selectedGroup?.displayName || "Files"}
        ({selectedGroup?.images.length || 0})
      </h4>
      {#if selectedGroup}
        <TreeView
          nodes={fileNodes}
          selected={selectedImageId}
          onSelect={handleImageSelect}
        />
      {:else}
        <div class="empty-msg">Select a group to view files</div>
      {/if}
    </div>

    <!-- Column 3: Replacement preview and actions -->
    <div
      class="column replace"
      role="region"
      aria-label="Replacement preview and file drop zone"
    >
      <!-- Preview section -->
      <div class="preview-section">
        <div class="preview-header">
          <h4>{selectedImage?.name ?? "Replace"}</h4>
          {#if selectedImage}
            <span class="header-dim"
              >{selectedImage.width}x{selectedImage.height}</span
            >
          {/if}
        </div>

        <div class="preview-area">
          {#if !selectedImage}
            <div class="empty-msg">Select an image to replace</div>
          {:else}
            {#if (isFromVideo && sourceFiles.length > 0) || (!isFromVideo && sourceFileMap.size > 0)}
              <div class="source-info">
                <span class="label">Source:</span>
                <span class="value"
                  >{isFromVideo
                    ? sourceFiles[currentSourceIndex]?.name || "--"
                    : (sourceFileMap.get(selectedImage?.name || "")?.name || "--")}</span
                >
                <span class="size"
                  >{isFromVideo
                    ? (sourceFiles[currentSourceIndex]
                      ? (sourceFiles[currentSourceIndex].size / 1024).toFixed(1) +
                        " KB"
                      : "--")
                    : (sourceFileMap.get(selectedImage?.name || "")
                      ? (sourceFileMap.get(selectedImage?.name || "")!.size / 1024).toFixed(1) +
                        " KB"
                      : "--")}</span
                >
              </div>
            {/if}

            <div class="preview-image">
              <div class="preview-column before-column">
                <div class="preview-label">Before</div>
                {#if !targetImageData}
                  <div class="canvas-wrapper">
                    <div class="canvas-placeholder">
                      <canvas
                        width={selectedImage.width * 2}
                        height={selectedImage.height * 2}
                      ></canvas>
                      {#if isLoadingTarget}
                        <span class="loading-text">Loading...</span>
                      {/if}
                    </div>
                    <div class="image-info">{selectedImage.name} - {selectedImage.width}x{selectedImage.height}</div>
                  </div>
                {:else}
                  <ImageRenderer
                    name={targetImageData.name}
                    width={targetImageData.width}
                    height={targetImageData.height}
                    rgb565Data={targetImageData.rgb565Data}
                    zoom={2}
                  />
                {/if}
              </div>
              <div class="preview-column after-column">
                <div class="preview-label">After</div>
                {#if ((isFromVideo && sourceFiles.length > 0) || (!isFromVideo && sourceFileMap.get(selectedImage?.name || ""))) && previewUrl}
                  <img src={previewUrl} alt="Preview" />
                {:else}
                  <div class="preview-placeholder">Drop replacement images</div>
                {/if}
              </div>
            </div>

          {/if}
        </div>
      </div>

      <!-- Drop zone section -->
      <div class="drop-section">
        <div class="drop-header">
          <h4>Replacement Files</h4>
        </div>

        <div
          class="drop-zone"
          class:drag-over={isDragOver}
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
            use:fileInputAction
            accept="image/*,video/*"
            multiple
            hidden
            onchange={handleFileSelect}
          />
          <div class="drop-zone-content">
            <img
              src={isDragOver ? "/folder-drag-accept.png" : "/folder.png"}
              alt="Folder"
              class="folder-icon"
            />
            <div class="drop-text">Drop images (same name) or video here</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer">
    <div class="buttons">
      <button onclick={onCancel}>Cancel</button>
      <button
        onclick={apply}
        disabled={!selectedGroup || ((isFromVideo && sourceFiles.length === 0) || (!isFromVideo && sourceFileMap.size === 0))}
        class="primary"
      >
        Apply ({isFromVideo ? Math.min(sourceFiles.length, selectedGroup?.images.length || 0) : sourceFileMap.size} images)
      </button>
    </div>
  </div>
</div>

{#if isExtracting}
  <LoadingWindow message="Extracting frames from video..." showProgress={true} />
{/if}

<style>
  .sequence-replacer {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
    box-sizing: border-box;
    background-color: #c0c0c0;
  }

  .header h3 {
    margin: 0;
    font-size: 16px;
  }
  .header p {
    margin: 4px 0 8px;
    font-size: 12px;
  }

  .content {
    display: flex;
    flex: 1;
    gap: 8px;
    overflow: hidden;
    margin-bottom: 8px;
  }

  .column {
    flex: 1;
    display: flex;
    flex-direction: column;
    background-color: #ffffff;
    border: 2px inset #ffffff;
    border-right-color: #dfdfdf;
    border-bottom-color: #dfdfdf;
    min-width: 0;
  }

  .column h4 {
    margin: 0;
    padding: 4px;
    background-color: #000080;
    color: white;
    font-size: 12px;
  }

  .column :global(.tree-view) {
    flex: 1;
  }

  .column.replace {
    display: flex;
    flex-direction: column;
    gap: 8px;
    background: transparent;
    border: 0;
  }

  .preview-section {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: #000080;
    padding: 4px 8px;
    gap: 8px;
    flex-shrink: 0;
  }

  .preview-header h4 {
    margin: 0;
    padding: 0;
    background-color: transparent;
    color: white;
    font-size: 12px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .header-dim {
    color: #cccccc;
    font-size: 11px;
    flex-shrink: 0;
  }

  .preview-area {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .drop-section {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-top: 2px solid #808080;
  }

  .drop-header {
    background-color: #000080;
    padding: 4px 8px;
    flex-shrink: 0;
  }

  .drop-header h4 {
    margin: 0;
    padding: 0;
    background-color: transparent;
    color: white;
    font-size: 12px;
  }

  .empty-msg {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #666;
    border: 2px dashed #999;
    margin: 4px;
    text-align: center;
  }

  .drop-zone {
    padding: 16px;
    box-shadow:
      inset -1px -1px #fff,
      inset 1px 1px grey,
      inset -2px -2px #dfdfdf,
      inset 2px 2px #0a0a0a;
    background-color: #ffffff;
    text-align: center;
    cursor: pointer;
    min-height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .drop-zone:hover {
    background-color: #eeeeee;
  }

  .drop-zone.drag-over {
    border: 2px inset #000080;
    background-color: #e0e0ff;
  }

  .drop-zone-content {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    justify-content: center;
  }

  .folder-icon {
    width: 32px;
    height: 32px;
    image-rendering: pixelated;
  }

  .drop-text {
    font-size: 12px;
    color: #000000;
  }

  .source-info {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    background-color: #f0f0f0;
    border: 1px inset #ffffff;
  }

  .label {
    font-weight: bold;
    color: #000080;
    min-width: 50px;
  }

  .value {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .size {
    color: #666;
    font-size: 10px;
  }

  .preview-image {
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-height: 200px;
    background-color: #e0e0e0;
    padding: 8px;
    box-shadow:
      inset -1px -1px #fff,
      inset 1px 1px grey,
      inset -2px -2px #dfdfdf,
      inset 2px 2px #0a0a0a;
  }

  .preview-column {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: #ffffff;
    border: 2px inset #ffffff;
    padding: 8px;
    min-height: 150px;
  }

  .preview-label {
    font-size: 10px;
    font-weight: bold;
    color: #000080;
    margin-bottom: 4px;
    text-transform: uppercase;
  }

  .preview-placeholder {
    color: #666;
    font-size: 11px;
    text-align: center;
  }

  .canvas-placeholder {
    position: relative;
    display: inline-block;
  }

  .canvas-placeholder canvas {
    display: block;
    background-color: #000000;
    border: 2px solid #808080;
    image-rendering: pixelated;
    max-width: 100%;
    height: auto;
  }

  .canvas-placeholder .loading-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #ffffff;
    font-size: 12px;
    pointer-events: none;
  }

  .canvas-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .canvas-wrapper .image-info {
    margin-top: 8px;
    font-size: 12px;
    color: #000000;
    text-align: center;
  }

  .preview-column :global(.image-container) {
    background-color: transparent;
    border: none;
    padding: 0;
  }

  .preview-column img {
    max-width: 100%;
    max-height: 200px;
    image-rendering: pixelated;
    object-fit: contain;
  }

  .footer {
    flex-shrink: 0;
  }

  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  button {
    min-width: 70px;
    height: 24px;
  }

  button.primary {
    font-weight: bold;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
