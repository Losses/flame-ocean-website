<script lang="ts">
  import type { BitmapFileInfo } from '../../rse/types';
  import { extractFrames } from '../../rse/utils/video-extractor';

  interface Props {
    targetImages: BitmapFileInfo[];
    onApply: (mappings: { target: BitmapFileInfo; source: File }[]) => void;
    onCancel: () => void;
  }

  let { targetImages, onApply, onCancel }: Props = $props();

  let sourceFiles = $state<File[]>([]);
  let fileInput: HTMLInputElement;
  let isExtracting = $state(false);

  // Auto-map sources to targets
  let mappings = $derived.by(() => {
    const map: { target: BitmapFileInfo; source: File | null }[] = [];
    // Sort sources if they look like a sequence (e.g., Z_POWERON0_(0,0).BMP), otherwise keep order or sort by name
    const sortedSources = [...sourceFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    

    const sortedTargets = [...targetImages].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    for (let i = 0; i < sortedTargets.length; i++) {
        map.push({
            target: sortedTargets[i],
            source: sortedSources[i] || null
        });
    }
    return map;
  });

  async function processFiles(files: File[]) {
      if (files.length === 0) return;

      // Check for video file
      const videoFile = files.find(f => f.type.startsWith('video/'));
      
      if (videoFile) {
          isExtracting = true;
          try {
              // Extract frames matching the number of target images
              const frames = await extractFrames(videoFile, targetImages.length);
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
  }

  function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      processFiles(Array.from(input.files));
    }
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files) {
      processFiles(Array.from(e.dataTransfer.files));
    }
  }

  function handleDragOver(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function apply() {
    const validMappings = mappings
        .filter(m => m.source !== null)
        .map(m => ({ target: m.target, source: m.source! }));
    
    if (validMappings.length > 0) {
        onApply(validMappings);
        onCancel();
    }
  }
</script>

<div class="sequence-replacer">
  <div class="header">
    <h3>Replace Image Sequence</h3>
    <p>Map local files (or drop a Video) to selected firmware images.</p>
  </div>

  <div class="content">
    <div class="column targets">
      <h4>Target Images ({targetImages.length})</h4>
      <div class="list">
        {#each mappings as map}
          <div class="item">
            <span class="name">{map.target.name}</span>
            <span class="dim">{map.target.width}x{map.target.height}</span>
          </div>
        {/each}
      </div>
    </div>

    <div class="column sources"
         ondrop={handleDrop}
         ondragover={handleDragOver}
         role="region" 
         aria-label="File Drop Zone">
      
      <div class="sources-header">
        <h4>Source Files ({sourceFiles.length})</h4>
        <button onclick={() => fileInput.click()}>Select Files/Video...</button>
        <input 
            type="file" 
            multiple 
            accept="image/*,video/*" 
            hidden 
            bind:this={fileInput}
            onchange={handleFileSelect}
        />
      </div>

      <div class="list drop-zone">
        {#if isExtracting}
            <div class="empty-msg extracting">
                <p>Extracting {targetImages.length} frames from video...</p>
                <progress></progress>
            </div>
        {:else if sourceFiles.length === 0}
            <div class="empty-msg">Drag & Drop images or video here</div>
        {:else}
            {#each mappings as map}
                <div class="item source-item" class:missing={!map.source}>
                    {#if map.source}
                        <span class="name">{map.source.name}</span>
                        <span class="size">{(map.source.size / 1024).toFixed(1)} KB</span>
                    {:else}
                        <span class="placeholder">-- No File --</span>
                    {/if}
                </div>
            {/each}
        {/if}
      </div>
    </div>
  </div>


  <div class="footer">
    <div class="status">
        Mapped: {mappings.filter(m => m.source).length} / {targetImages.length}
    </div>
    <div class="buttons">
        <button onclick={onCancel}>Cancel</button>
        <button 
            onclick={apply} 
            disabled={mappings.filter(m => m.source).length === 0}
            class="primary"
        >
            Apply Replacement
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
  }

  .sources {
    background-color: #e0e0e0;
  }

  .column h4 {
    margin: 0;
    padding: 4px;
    background-color: #000080;
    color: white;
    font-size: 12px;
  }

  .sources-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background-color: #000080;
    padding-right: 2px;
  }

  .sources-header button {
    font-size: 10px;
    padding: 1px 4px;
    height: 18px;
  }

  .list {
    flex: 1;
    overflow-y: auto;
    padding: 2px;
    font-family: monospace;
    font-size: 12px;
  }

  .item {
    display: flex;
    justify-content: space-between;
    padding: 2px 4px;
    border-bottom: 1px dotted #ccc;
    height: 20px;
    align-items: center;
  }

  .source-item.missing {
    color: #888;
    background-color: #ffe0e0;
  }

  .dim { color: #888; font-size: 10px; }
  .size { color: #666; font-size: 10px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .drop-zone {
    display: flex;
    flex-direction: column;
  }

  .empty-msg {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: #666;
    border: 2px dashed #999;
    margin: 4px;
  }

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 4px;
  }

  .buttons {
    display: flex;
    gap: 8px;
  }

  button {
    min-width: 60px;
    height: 24px;
  }

  button.primary {
    font-weight: bold;
  }
</style>
