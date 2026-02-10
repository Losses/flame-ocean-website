<script lang="ts">
  import type { Snippet } from "svelte";
  import { debugMode, debugAnimationComplete } from "$lib/stores";
  import Window from "./Window.svelte";
  import WindowBody from "./WindowBody.svelte";
  import StatusBar from "./StatusBar.svelte";
  import ProgressBar from "./ProgressBar.svelte";

  interface StatusField {
    text: string;
    class?: string;
  }

  interface Props {
    title?: string;
    message?: string;
    progress?: number;
    showProgress?: boolean;
    width?: string;
    children?: Snippet;
    statusFields?: StatusField[];
  }

  let {
    title,
    message,
    progress = 0,
    showProgress = true,
    width = "400px",
    children,
    statusFields,
  }: Props = $props();

  // Subscribe to global debug mode store using state for proper reactivity
  let debug = $state(false);
  debugMode.subscribe((value) => {
    debug = value;
  });

  // Debug mode: animate progress over 10 seconds
  let displayedProgress = $state(0);
  let debugFrameId: number | null = null;

  $effect(() => {
    if (debug) {
      // Mark animation as in progress
      debugAnimationComplete.set(false);

      // Animate from 0 to 100 over 10 seconds
      displayedProgress = 0;
      const startTime = Date.now();
      const duration = 10000; // 10 seconds

      const animate = () => {
        const elapsed = Date.now() - startTime;
        displayedProgress = Math.min((elapsed / duration) * 100, 100);

        if (displayedProgress < 100) {
          debugFrameId = requestAnimationFrame(animate);
        } else {
          // Animation complete
          debugAnimationComplete.set(true);
        }
      };

      debugFrameId = requestAnimationFrame(animate);

      return () => {
        if (debugFrameId !== null) {
          cancelAnimationFrame(debugFrameId);
          debugFrameId = null;
        }
      };
    } else {
      displayedProgress = progress;
    }
  });
</script>

<div class="loading-wrapper">
  <Window {title} {width} {statusFields}>
    <WindowBody>
      <div class="loading-content">
        {#if showProgress}
          <div class="loading-progress-row">
            <div class="loading-icon"></div>
            <div class="loading-progress-bar">
              <ProgressBar value={displayedProgress} />
            </div>
          </div>
        {/if}

        {#if message}
          <p class="loading-message">{message}</p>
        {/if}

        {#if children}
          {@render children()}
        {/if}
      </div>
    </WindowBody>
  </Window>
</div>

<style>
  .loading-wrapper {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
  }

  .loading-content {
    padding: 8px;
  }

  .loading-progress-row {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .loading-icon {
    width: 48px;
    height: 48px;
    background-image: url("/data-loading.svg");
    background-size: 384px 48px;
    animation: loading-animation 1s steps(8) infinite;
    flex-shrink: 0;
  }

  .loading-progress-bar {
    flex: 1;
  }

  @keyframes loading-animation {
    0% {
      background-position: 0px 0px;
    }
    100% {
      background-position: -384px 0px;
    }
  }

  .loading-message {
    margin: 12px 0 0 0;
    font-size: 12px;
    color: #000000;
    text-align: center;
  }
</style>
