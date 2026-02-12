/**
 * Tofu Detection - Runs detection entirely in worker
 *
 * This ensures the debug preview tests the exact same tofu detection as replacement.
 */

import type { TofuDebugData } from './tofu-font.js';

/**
 * Run tofu detection in worker
 */
export async function runTofuDetectionInWorker(
  worker: Worker,
  config: {
    fontData: ArrayBuffer;
    fontFamily: string;
    fontSize: 12 | 16;
    codePoints: number[];
  }
): Promise<{
  success: boolean;
  debugData: TofuDebugData[];
  error?: string;
}> {
  const messageId = 'tofuDetect';

  return new Promise((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const { type, id, result, error } = e.data;
      if (id !== messageId) return; // Ignore other messages

      if (type === 'success') {
        worker.removeEventListener('message', handler);
        resolve(result);
      } else if (type === 'error') {
        worker.removeEventListener('message', handler);
        reject(new Error(error || 'Analysis failed'));
      }
      // Progress messages are ignored
    };
    worker.addEventListener('message', handler);

    worker.postMessage({
      type: 'analyzeFonts',
      id: messageId,
      ...config,
    });
  });
}

/**
 * Full tofu detection workflow: run entirely in worker and return debug data
 */
export async function detectTofu(
  worker: Worker,
  config: {
    fontData: ArrayBuffer;
    fontFamily: string;
    fontSize: 12 | 16;
    codePoints: number[];
  }
): Promise<{
  success: boolean;
  debugData: TofuDebugData[];
  error?: string;
}> {
  console.log('[TofuDetector] Starting tofu detection in worker...', {
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    codePointsCount: config.codePoints.length,
  });

  try {
    // Run detection in worker - it now handles tofu signature generation internally
    const result = await runTofuDetectionInWorker(worker, config);

    console.log('[TofuDetector] Detection complete:', {
      success: result.success,
      total: result.debugData?.length,
      tofu: result.debugData?.filter((d: TofuDebugData) => d.match).length,
      error: result.error,
    });

    return result;
  } catch (error) {
    console.error('[TofuDetector] Error:', error);
    return {
      success: false,
      debugData: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
