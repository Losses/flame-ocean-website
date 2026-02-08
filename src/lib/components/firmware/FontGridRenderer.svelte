<script lang="ts">
	import { Grid } from 'svelte-virtual';
	import { onMount, onDestroy } from 'svelte';

	interface FontData {
		unicode: number;
		fontType: 'SMALL' | 'LARGE';
		pixels: boolean[][];
	}

	interface Props {
		fonts: FontData[];
		zoom?: number;
	}

	let { fonts, zoom = 10 }: Props = $props();

	const LARGE_FONT_SIZE = 16;

	// Get font dimensions with fallback
	const fontWidth = $derived(fonts[0]?.pixels[0]?.length ?? LARGE_FONT_SIZE);
	const fontHeight = $derived(fonts[0]?.pixels.length ?? LARGE_FONT_SIZE);

	// Calculate item dimensions (reactive) - uses the actual font dimensions
	const itemWidth = $derived(fontWidth * zoom + 20);
	const itemHeight = $derived(fontHeight * zoom + 30);
	const itemCount = $derived(fonts.length);

	// Container height state
	let containerHeight = $state(600);
	let containerElement: HTMLDivElement;
	let resizeObserver: ResizeObserver;

	// Measure container height using ResizeObserver
	function observeContainer() {
		resizeObserver = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const rect = entry.contentRect;
				containerHeight = rect.height;
			}
		});

		if (containerElement) {
			resizeObserver.observe(containerElement);
		}
	}

	onMount(() => {
		observeContainer();
		return () => {
			resizeObserver?.disconnect();
		};
	});

	// Helper function to get hex string
	function getHexString(unicode: number): string {
		return 'U+' + unicode.toString(16).padStart(4, '0').toUpperCase();
	}

	// Action to render font on canvas
	function renderFont(canvas: HTMLCanvasElement, font: FontData) {
		function draw() {
			const ctx = canvas.getContext('2d');
			if (!ctx) return;

			// Set canvas size based on actual font dimensions
			const fontWidth = font.pixels[0]?.length ?? LARGE_FONT_SIZE;
			const fontHeight = font.pixels.length;
			canvas.width = fontWidth * zoom;
			canvas.height = fontHeight * zoom;

			// Clear canvas
			ctx.clearRect(0, 0, canvas.width, canvas.height);

			// Draw font pixels
			for (let py = 0; py < font.pixels.length; py++) {
				for (let px = 0; px < font.pixels[py].length; px++) {
					if (font.pixels[py][px]) {
						ctx.fillStyle = '#000000';
						ctx.fillRect(px * zoom, py * zoom, zoom, zoom);
					}
				}
			}
		}

		draw();

		return {
			update: (newFont: FontData) => {
				if (newFont !== font) {
					draw();
				}
			}
		};
	}
</script>

<div bind:this={containerElement} class="font-grid-container">
	<Grid
		itemCount={itemCount}
		itemWidth={itemWidth}
		itemHeight={itemHeight}
		height={containerHeight}
	>
		<div slot="item" let:index let:style class="font-item" {style}>
			<div class="canvas-wrapper">
				<canvas
					use:renderFont={fonts[index]}
					class="font-canvas"
					width={(fonts[index]?.pixels[0]?.length ?? LARGE_FONT_SIZE) * zoom}
					height={(fonts[index]?.pixels.length ?? LARGE_FONT_SIZE) * zoom}
				></canvas>
			</div>
			<div class="unicode-label">{getHexString(fonts[index].unicode)}</div>
		</div>
	</Grid>
</div>

<style>
	.font-grid-container {
		display: block;
		background-color: #c0c0c0;
		border: 2px solid;
		border-color: #dfdfdf #808080 #808080 #dfdfdf;
		padding: 4px;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		box-sizing: border-box;
	}

	.font-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 4px;
		box-sizing: border-box;
	}

	.canvas-wrapper {
		border: 2px solid;
		border-color: #808080 #dfdfdf #dfdfdf #808080;
		padding: 2px;
		background-color: #ffffff;
		display: inline-block;
	}

	.font-canvas {
		display: block;
		image-rendering: pixelated;
	}

	.unicode-label {
		color: #000000;
		margin-top: 4px;
		text-align: center;
	}
</style>
