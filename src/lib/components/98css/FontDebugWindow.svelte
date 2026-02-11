<script lang="ts">
  import type { FontDebugImage } from "$lib/rse/utils/font-detection";
  import { Button, Window, WindowBody } from "./index.js";

  interface Props {
    fileName?: string;
    message?: string;
    debugImages?: FontDebugImage[];
    onclose?: () => void;
    width?: string;
  }

  let {
    fileName = "",
    message = "",
    debugImages = [],
    onclose,
    width = "900px",
  }: Props = $props();

  function handleClose() {
    onclose?.();
  }
</script>

<div class="font-debug-wrapper">
  <Window
    {width}
    title="Font Detection Details"
    showClose={true}
    onclose={handleClose}
  >
    <WindowBody>
      <div class="font-debug-content">
        <div class="error-message">
          <div class="error-icon">
            <img src="/dialog-error.png" alt="error" />
          </div>
          <div class="error-text">
            {#if fileName}
              <p class="file-name">File: {fileName}</p>
            {/if}
            {#if message}
              <p>{message}</p>
            {/if}
          </div>
        </div>

        <div class="debug-images">
          {#each debugImages as debugImage (debugImage.fontSize)}
            <div class="debug-image-item">
              <div class="debug-image-header">
                <span class="font-size-label">{debugImage.fontSize}px Test</span
                >

                {#if debugImage.antiAliasedCount > 0}
                  <span class="fail">FAILED:</span> Found {debugImage.antiAliasedCount}
                  gray pixels
                {:else}
                  <span class="pass">PASSED</span>
                {/if}
              </div>
              <div class="debug-image-container">
                <img
                  src={debugImage.dataUrl}
                  alt="Font test at {debugImage.fontSize}px"
                  style="width: {debugImage.fontSize *
                    52 *
                    3}px; height: {debugImage.fontSize * 2 * 3}px;"
                />
              </div>
            </div>
          {/each}
        </div>

        <div class="debug-buttons">
          <Button variant="primary" onclick={handleClose}>Close</Button>
        </div>
      </div>
    </WindowBody>
  </Window>
</div>

<style>
  .font-debug-wrapper {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    background-color: rgba(0, 0, 0, 0.1);
  }

  .font-debug-content {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .error-message {
    display: flex;
    gap: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid #c0c0c0;
  }

  .error-icon {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .error-icon img {
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }

  .error-text {
    flex: 1;
    min-width: 0;
  }

  .error-text p {
    margin: 4px 0;
    font-size: 12px;
    color: #000000;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  .file-name {
    font-weight: bold;
  }

  .debug-images {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-height: 400px;
    overflow-y: auto;
    overflow-x: hidden;
    padding-right: 4px;
  }

  .debug-image-item {
    border: 2px inset #ffffff;
    padding: 8px;
    background-color: #ffffff;
  }

  .debug-image-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: bold;
  }

  .font-size-label {
    color: #000080;
  }

  .fail {
    color: #cc0000;
    font-weight: bold;
  }

  .pass {
    color: #008000;
    font-weight: bold;
  }

  .debug-image-container {
    background-color: #e0e0e0;
    border: 1px solid #808080;
    padding: 4px;
    display: flex;
    justify-content: flex-start;
    margin-bottom: 8px;
    overflow-x: auto;
  }

  .debug-image-container img {
    image-rendering: pixelated;
    display: block;
  }

  .debug-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 8px;
    border-top: 1px solid #c0c0c0;
  }

  :global(.debug-buttons button) {
    min-width: 75px;
  }
</style>
