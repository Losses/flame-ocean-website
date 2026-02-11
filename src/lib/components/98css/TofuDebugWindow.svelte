<script lang="ts">
  import { Button, Window, WindowBody } from "./index.js";
  import { isTestChar, getTestCharCategory, pixelsToDataURL } from "$lib/rse/utils/tofu-font";

  interface TofuDebugData {
    codePoint: number;
    char: string;
    fontSize: number;
    renderedPixels: boolean[][];
    tofuPixels: boolean[][];
    match: boolean;
    matchPercentage: number;
    boundingBox1: { x: number; y: number; width: number; height: number };
    boundingBox2: { x: number; y: number; width: number; height: number };
  }

  interface Props {
    debugData: TofuDebugData[];
    onclose?: () => void;
    onconfirm?: () => void;
    showConfirm?: boolean;
  }

  let { debugData = [], onclose, onconfirm, showConfirm = false }: Props = $props();

  function getCharDescription(codePoint: number): string {
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  }
</script>

<div class="tofu-debug-wrapper">
  <Window
    width="1200px"
    title={showConfirm ? "Tofu Detection Preview" : "Tofu Detection Debug"}
    showClose={!showConfirm}
    onclose={onclose}
  >
    <WindowBody>
      <div class="tofu-debug-content">
        <div class="debug-info">
          <p>Showing {debugData.length} character comparison(s)</p>
          <p>Green = PASS (tofu detected, will skip), Red = FAIL (not tofu, will replace)</p>
          <p>
            Includes {debugData.filter(d => isTestChar(d.codePoint)).length} rare Unicode test chars
            (marked with [TEST] badge)
          </p>
        </div>

        <div class="debug-items">
          {#each debugData as item (item.codePoint)}
            <div
              class="debug-item"
              class:pass={item.match}
              class:fail={!item.match}
            >
              <div class="debug-item-header">
                <span class="char-info">
                  "{item.char}" ({getCharDescription(item.codePoint)})
                  {item.fontSize}px
                  {#if isTestChar(item.codePoint)}
                    <span class="test-char-badge">[TEST: {getTestCharCategory(item.codePoint)}]</span>
                  {/if}
                </span>
                <span class="match-result">
                  {#if item.match}
                    <span class="pass-label">TOFU DETECTED ({(item.matchPercentage * 100).toFixed(1)}%)</span>
                  {:else}
                    <span class="fail-label">NOT TOFU ({(item.matchPercentage * 100).toFixed(1)}%)</span>
                  {/if}
                </span>
              </div>

              <div class="pixel-comparison">
                <div class="pixel-view">
                  <div class="pixel-label">Rendered Glyph</div>
                  <img
                    src={pixelsToDataURL(item.renderedPixels)}
                    alt="Rendered"
                    style="width: {item.renderedPixels[0]?.length * 5 || 12}px"
                  />
                  <div class="bbox-info">
                    BBox: {item.boundingBox1.width}x{item.boundingBox1.height}
                    at ({item.boundingBox1.x},{item.boundingBox1.y})
                  </div>
                </div>

                <div class="pixel-view">
                  <div class="pixel-label">Tofu Signature</div>
                  <img
                    src={pixelsToDataURL(item.tofuPixels)}
                    alt="Tofu"
                    style="width: {item.tofuPixels[0]?.length * 5 || 12}px"
                  />
                  <div class="bbox-info">
                    BBox: {item.boundingBox2.width}x{item.boundingBox2.height}
                    at ({item.boundingBox2.x},{item.boundingBox2.y})
                  </div>
                </div>
              </div>
            </div>
          {/each}
        </div>

        <div class="debug-buttons">
          {#if showConfirm}
            <Button onclick={() => onclose?.()}>Cancel</Button>
            <Button variant="primary" onclick={() => onconfirm?.()}>Confirm Replacement</Button>
          {:else}
            <Button variant="primary" onclick={onclose}>Close</Button>
          {/if}
        </div>
      </div>
    </WindowBody>
  </Window>
</div>

<style>
  .tofu-debug-wrapper {
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

  .tofu-debug-content {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .debug-info {
    padding: 8px;
    background-color: #ffffcc;
    border: 1px solid #808080;
  }

  .debug-info p {
    margin: 4px 0;
    font-size: 12px;
  }

  .debug-items {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-height: 500px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .debug-item {
    border: 2px inset #ffffff;
    padding: 8px;
    background-color: #ffffff;
  }

  .debug-item.pass {
    background-color: #ccffcc;
  }

  .debug-item.fail {
    background-color: #ffcccc;
  }

  .debug-item-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
    font-size: 12px;
    font-weight: bold;
  }

  .char-info {
    color: #000080;
  }

  .pass-label {
    color: #008000;
    font-weight: bold;
  }

  .fail-label {
    color: #cc0000;
    font-weight: bold;
  }

  .test-char-badge {
    margin-left: 8px;
    padding: 2px 6px;
    background-color: #800080;
    color: #ffffff;
    font-size: 9px;
    font-weight: bold;
    border-radius: 2px;
  }

  .pixel-comparison {
    display: flex;
    gap: 16px;
    justify-content: flex-start;
    flex-wrap: wrap;
  }

  .pixel-view {
    border: 1px solid #808080;
    padding: 8px;
    background-color: #ffffff;
  }

  .pixel-label {
    font-size: 11px;
    font-weight: bold;
    margin-bottom: 4px;
    color: #000080;
  }

  .pixel-view img {
    image-rendering: pixelated;
    display: block;
    border: 1px solid #c0c0c0;
    background-color: #e0e0e0;
  }

  .bbox-info {
    font-size: 10px;
    color: #666;
    margin-top: 4px;
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
