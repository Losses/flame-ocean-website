/**
 * Worker Context Utilities
 *
 * Provides cross-environment utilities that work in both main thread and worker contexts.
 * Use this module when code needs to run in either environment.
 */

// Check if running in a worker context
export function isWorkerContext(): boolean {
	return typeof document === 'undefined';
}

// Get fonts container that works in both worker and main thread
export function getFontsContainer(): FontFaceSet {
	if (isWorkerContext()) {
		// In workers, self.fonts has ready returning Promise<FontFaceSet>
		return (self as unknown as { fonts: FontFaceSet }).fonts;
	}
	// In main thread, document.fonts has ready returning Promise<void>
	return document.fonts;
}

// Get the fonts ready promise - typed correctly for each environment
export function getFontsReady(): Promise<unknown> {
	if (isWorkerContext()) {
		// Worker: ready returns Promise<FontFaceSet>, need to await and discard result
		return (self as unknown as { fonts: { ready: Promise<FontFaceSet> } }).fonts.ready.then(() => undefined);
	}
	// Main: ready returns Promise<void>
	return document.fonts.ready;
}

// Create offscreen canvas that works in both worker and main thread
export function createOffscreenCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
	if (isWorkerContext() && typeof OffscreenCanvas !== 'undefined') {
		return new OffscreenCanvas(width, height);
	}
	return document.createElement('canvas');
}

// Get 2D context with proper typing
export function get2dContext(
	canvas: OffscreenCanvas | HTMLCanvasElement
): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) {
		throw new Error('Failed to get canvas context');
	}
	return ctx;
}
