<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		name: string;
		width: number;
		height: number;
		rgb565Data: Uint8Array;
		zoom?: number;
	}

	let { name, width, height, rgb565Data, zoom = 1 }: Props = $props();

	let canvasElement: HTMLCanvasElement;
	let ctx: CanvasRenderingContext2D;

	onMount(() => {
		const canvas = canvasElement;
		ctx = canvas.getContext('2d')!;
		render();
	});

	// Convert RGB565 to RGB888
	function rgb565ToRgb888(pixel: number): { r: number; g: number; b: number } {
		const r = ((pixel >> 11) & 0x1f) * 255 / 31;
		const g = ((pixel >> 5) & 0x3f) * 255 / 63;
		const b = (pixel & 0x1f) * 255 / 31;
		return {
			r: Math.round(r),
			g: Math.round(g),
			b: Math.round(b)
		};
	}

	function render() {
		if (!rgb565Data.length || !ctx) return;

		// Calculate canvas size
		const scaledWidth = width * zoom;
		const scaledHeight = height * zoom;

		canvasElement.width = scaledWidth;
		canvasElement.height = scaledHeight;

		// Clear canvas
		ctx.fillStyle = '#c0c0c0';
		ctx.fillRect(0, 0, canvasElement.width, canvasElement.height);

		// If zooming, disable smoothing for pixelated look
		ctx.imageSmoothingEnabled = zoom === 1;

		// Draw each pixel
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const offset = (y * width + x) * 2;
				const pixel = rgb565Data[offset] | (rgb565Data[offset + 1] << 8);
				const { r, g, b } = rgb565ToRgb888(pixel);

				ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
				ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
			}
		}
	}
</script>

<div class="image-container">
	<canvas bind:this={canvasElement} class="image-canvas"></canvas>
	<div class="image-info">{name} - {width}x{height}</div>
</div>

<style>
	.image-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 8px;
		background-color: #c0c0c0;
		border: 2px solid;
		border-color: #dfdfdf #808080 #808080 #dfdfdf;
		max-width: 100%;
	}

	.image-info {
		margin-top: 8px;
		font-size: 12px;
		color: #000000;
		text-align: center;
	}

	.image-canvas {
		display: block;
		image-rendering: pixelated;
		background-color: #000000;
		border: 2px solid;
		border-color: #808080 #dfdfdf #dfdfdf #808080;
		max-width: 100%;
		height: auto;
	}
</style>
