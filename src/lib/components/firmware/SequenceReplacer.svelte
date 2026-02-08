<script lang="ts">
  import type { BitmapFileInfo } from '../../rse/types';
  import { extractFrames } from '../../rse/utils/video-extractor';
  import { TreeView } from '../98css';

  interface Props {
    targetImages: BitmapFileInfo[];
    onApply: (mappings: { target: BitmapFileInfo; source: File }[]) => void;
    onCancel: () => void;
  }

  let { targetImages, onApply, onCancel }: Props = $props();

  // Group parsing state
  interface ImageGroup {
    prefix: string;
    displayName: string;
    images: BitmapFileInfo[];
  }

  let selectedGroupId = $state<string>('');
  let selectedImageId = $state<string>('');

  // Source file state
  let sourceFiles = $state<File[]>([]);
  let isDragOver = $state(false);
  let isExtracting = $state(false);
  let previewUrl = $state<string | null>(null);
  let currentSourceIndex = $state(0);

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
      children: []
    }))
  );

  // Convert files in selected group to tree nodes
  let fileNodes = $derived.by(() => {
    const selectedGroup = groups.find((g) => `group-${g.prefix}` === selectedGroupId);
    if (!selectedGroup) return [];
    return selectedGroup.images.map((img, idx) => ({
      id: `file-${selectedGroup.prefix}-${idx}`,
      label: `${img.name} (${img.width}x${img.height})`
    }));
  });

  // Get selected group and image
  let selectedGroup = $derived(groups.find((g) => `group-${g.prefix}` === selectedGroupId));
  let selectedImage = $derived(
    selectedGroup?.images.find((_, idx) => `file-${selectedGroup.prefix}-${idx}` === selectedImageId) ?? null
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
        return imgs.every(img => `${img.width}x${img.height}` === firstDim);
      })
      .map(([prefix, imgs]) => ({
        prefix,
        displayName: `${prefix} (${imgs[0].width}x${imgs[0].height})`,
        images: imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  // Extract group prefix from filename (e.g., "Z_POWERON0_(0,0).BMP" -> "Z_POWERON")
  function extractGroupKey(filename: string): { prefix: string; number: string } {
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
      const finalPrefix = (prefix.endsWith('_') || prefix.endsWith('-')) ? prefix : prefix + '_';
      return { prefix: finalPrefix, number: match3[2] };
    }

    // No pattern found - return empty prefix to filter out this image
    return { prefix: '', number: '' };
  }

  // Handle group selection from TreeView
  function handleGroupSelect(nodeId: string) {
    selectedGroupId = nodeId;
    const group = groups.find((g) => `group-${g.prefix}` === nodeId);
    if (group && group.images.length > 0) {
      selectedImageId = `file-${group.prefix}-0`;
      currentSourceIndex = 0;
    }
    cleanupPreview();
  }

  // Handle image selection from TreeView
  function handleImageSelect(nodeId: string) {
    selectedImageId = nodeId;
    const match = nodeId.match(/file-(.+)-(\d+)/);
    if (match) {
      const group = groups.find((g) => g.prefix === match[1]);
      if (group) {
        const idx = parseInt(match[2], 10);
        currentSourceIndex = idx;
      }
    }
    updatePreview();
  }

  async function handleFilesDrop(files: File[]) {
    if (files.length === 0) return;

    const videoFile = files.find(f => f.type.startsWith('video/'));

    if (videoFile) {
      isExtracting = true;
      try {
        const frames = await extractFrames(videoFile, selectedGroup?.images.length || 30);
        sourceFiles = frames;
      } catch (e) {
        console.error("Failed to extract frames", e);
        alert("Failed to extract frames from video: " + (e instanceof Error ? e.message : String(e)));
      } finally {
        isExtracting = false;
      }
    } else {
      sourceFiles = files;
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
    input.value = '';
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
    if (sourceFiles[currentSourceIndex]) {
      const file = sourceFiles[currentSourceIndex];
      previewUrl = URL.createObjectURL(file);
    }
  }

  function cleanupPreview() {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
  }

  function nextImage() {
    if (!selectedGroup) return;
    const idx = selectedGroup.images.findIndex(img => img.name === selectedImage?.name);
    if (idx < selectedGroup.images.length - 1) {
      selectedImageId = `file-${selectedGroup.prefix}-${idx + 1}`;
      currentSourceIndex = idx + 1;
      updatePreview();
    }
  }

  function prevImage() {
    if (!selectedGroup) return;
    const idx = selectedGroup.images.findIndex(img => img.name === selectedImage?.name);
    if (idx > 0) {
      selectedImageId = `file-${selectedGroup.prefix}-${idx - 1}`;
      currentSourceIndex = idx - 1;
      updatePreview();
    }
  }

  function apply() {
    if (!selectedGroup || sourceFiles.length === 0) return;

    const mappings: { target: BitmapFileInfo; source: File }[] = [];
    for (let i = 0; i < selectedGroup.images.length && i < sourceFiles.length; i++) {
      mappings.push({
        target: selectedGroup.images[i],
        source: sourceFiles[i]
      });
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
    <p>Select a group, then load replacement files (or drop a video)</p>
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
        {selectedGroup?.displayName || 'Files'}
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
    <div class="column replace" role="region" aria-label="Replacement preview and file drop zone">

      <div class="replace-header">
        <h4>Replace</h4>
      </div>

      <div class="replace-content">
        {#if isExtracting}
          <div class="empty-msg extracting">
            <p>Extracting frames from video...</p>
            <progress></progress>
          </div>
        {:else if !selectedImage}
          <div class="empty-msg">Select an image to replace</div>
        {:else if sourceFiles.length === 0}
          <div
            class="drop-zone"
            class:drag-over={isDragOver}
            ondragover={handleDragOver}
            ondragleave={handleDragLeave}
            ondrop={handleDrop}
            onclick={triggerFileInput}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
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
              <div class="drop-text">
                Drop images or video here
              </div>
            </div>
          </div>
        {:else}
          <div class="preview-panel">
            <div class="preview-info">
              <div class="target-info">
                <span class="label">Target:</span>
                <span class="value">{selectedImage.name}</span>
                <span class="dim">{selectedImage.width}x{selectedImage.height}</span>
              </div>
              <div class="source-info">
                <span class="label">Source:</span>
                <span class="value">{sourceFiles[currentSourceIndex]?.name || '--'}</span>
                <span class="size">{sourceFiles[currentSourceIndex]
                  ? ((sourceFiles[currentSourceIndex].size / 1024).toFixed(1) + ' KB')
                  : '--'}</span>
              </div>
            </div>

            <div class="preview-image">
              {#if previewUrl}
                <img src={previewUrl} alt="Preview" />
              {:else}
                <div class="no-preview">No preview available</div>
              {/if}
            </div>

            <div class="navigation">
              <button onclick={prevImage} disabled={currentSourceIndex === 0}>
                &lt; Prev
              </button>
              <span class="position">
                {currentSourceIndex + 1} / {selectedGroup?.images.length || 0}
              </span>
              <button onclick={nextImage} disabled={currentSourceIndex >= (selectedGroup?.images.length || 0) - 1}>
                Next &gt;
              </button>
            </div>

            <div class="mapping-status">
              Mapped: {Math.min(sourceFiles.length, selectedGroup?.images.length || 0)} / {selectedGroup?.images.length || 0}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="footer">
    <div class="buttons">
      <button onclick={onCancel}>Cancel</button>
      <button
        onclick={apply}
        disabled={!selectedGroup || sourceFiles.length === 0}
        class="primary"
      >
        Apply ({selectedGroup?.images.length || 0} images)
      </button>
    </div>
  </div>
</div>

<style>
  .sequence-replacer {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 8px;
    box-sizing: border-box;
    background-color: #c0c0c0;
  }

  .header h3 { margin: 0; font-size: 16px; }
  .header p { margin: 4px 0 8px; font-size: 12px; }

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

  .replace-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: #000080;
    padding-right: 2px;
  }

  .replace-content {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
    display: flex;
    flex-direction: column;
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
    padding: 40px;
    border: 2px inset #808080;
    background-color: #ffffff;
    text-align: center;
    cursor: pointer;
    margin: 4px;
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

  .preview-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .preview-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
  }

  .target-info, .source-info {
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
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 150px;
    background-color: #e0e0e0;
    border: 2px inset #ffffff;
    padding: 8px;
  }

  .preview-image img {
    max-width: 100%;
    max-height: 200px;
    image-rendering: pixelated;
    object-fit: contain;
  }

  .no-preview {
    color: #999;
    font-size: 11px;
  }

  .navigation {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 12px;
  }

  .navigation button {
    min-width: 60px;
    height: 24px;
    font-size: 11px;
  }

  .position {
    min-width: 60px;
    text-align: center;
  }

  .mapping-status {
    text-align: center;
    font-size: 11px;
    padding: 4px;
    background-color: #f0f0f0;
    border: 1px inset #ffffff;
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
