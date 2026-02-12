/**
 * Tofu Detection - Generates tofu signature on main thread, runs detection in worker
 *
 * This ensures the debug preview tests the exact same tofu detection as replacement.
 */

import type { TofuDebugData } from './tofu-font.js';
import {
  loadTofuFont,
  isTofuFontLoaded,
  getTofuSignature,
  generateTofuSignature,
  type TofuSignature,
} from './tofu-font.js';

/**
 * Generate tofu signature on main thread (where it works reliably)
 */
export async function generateTofuSignatureOnMain(fontSize: 12 | 16): Promise<TofuSignature> {
  if (!isTofuFontLoaded()) {
    console.log('[TofuDetector] Loading tofu font...');
    await loadTofuFont();
  }

  let sig = getTofuSignature(fontSize);
  if (!sig) {
    console.log(`[TofuDetector] Generating tofu signature for ${fontSize}px...`);
    sig = await generateTofuSignature(fontSize);
  }

  console.log('[TofuDetector] Tofu signature:', {
    pixelCount: sig.pixels.flat().filter(Boolean).length,
    dimensions: `${sig.width}x${sig.height}`,
  });

  return sig;
}

/**
 * Convert tofu signature to number array for worker
 */
export function signatureToNumbers(sig: TofuSignature): number[][] {
  return sig.pixels.map((row) => row.map((p) => (p ? 1 : 0)));
}

/**
 * Run tofu detection in worker with passed signature
 */
export async function runTofuDetectionInWorker(
  worker: Worker,
  config: {
    fontData: ArrayBuffer;
    fontFamily: string;
    fontSize: 12 | 16;
    codePoints: number[];
    tofuSignature: number[][];
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
 * Full tofu detection workflow: generate signature, run in worker, return debug data
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
  console.log('[TofuDetector] Starting tofu detection...', {
    fontFamily: config.fontFamily,
    fontSize: config.fontSize,
    codePointsCount: config.codePoints.length,
  });

  try {
    // Step 1: Generate tofu signature on main thread
    const sig = await generateTofuSignatureOnMain(config.fontSize);
    console.log('[TofuDetector] Signature generated:', {
      width: sig.width,
      height: sig.height,
      pixelCount: sig.pixels.flat().filter(Boolean).length,
    });
    const sigNumbers = signatureToNumbers(sig);

    // Step 2: Run detection in worker
    console.log('[TofuDetector] Running detection in worker...');
    const result = await runTofuDetectionInWorker(worker, {
      fontData: config.fontData,
      fontFamily: config.fontFamily,
      fontSize: config.fontSize,
      codePoints: config.codePoints,
      tofuSignature: sigNumbers,
    });

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
