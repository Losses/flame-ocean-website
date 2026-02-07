import { writable } from 'svelte/store';

export const debugMode = writable(false);

// Track when debug animation is complete
export const debugAnimationComplete = writable(true);

// Global function to toggle debug mode
export function initDebugShortcut() {
	if (typeof window === 'undefined') return;

	// Add global function to window/globalThis
	(globalThis as any).enableDebugMode = (enabled: boolean = true) => {
		debugMode.set(enabled);
		if (!enabled) {
			debugAnimationComplete.set(true);
		}
		console.log(`[Debug] Debug mode ${enabled ? 'enabled' : 'disabled'}`);
	};

	// Also add keyboard shortcut (Ctrl+Shift+D)
	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.ctrlKey && e.shiftKey && e.key === 'D') {
			e.preventDefault();
			debugMode.update((value) => {
				const newValue = !value;
				if (!newValue) {
					debugAnimationComplete.set(true);
				}
				console.log(`[Debug] Debug mode ${newValue ? 'enabled' : 'disabled'} (Ctrl+Shift+D)`);
				return newValue;
			});
		}
	};

	window.addEventListener('keydown', handleKeyDown);
	return () => window.removeEventListener('keydown', handleKeyDown);
}
