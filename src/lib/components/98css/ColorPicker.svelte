<script lang="ts">
	import { onMount } from 'svelte';
	import Button from './Button.svelte';
	import Window from './Window.svelte';

	interface Props {
		storageKey?: string;
		onColorSelect?: (rgb: { r: number; g: number; b: number }) => void;
		onClose?: () => void;
	}

	let { storageKey = 'win98_oklch_custom_colors', onColorSelect, onClose }: Props = $props();

	// Constants
	const MAX_CHROMA = 0.37;
	const BASIC_COLORS = [
		'#FF8080',
		'#FFFF80',
		'#80FF80',
		'#00FF80',
		'#80FFFF',
		'#0080FF',
		'#FF80C0',
		'#FF80FF',
		'#FF0000',
		'#FFFF00',
		'#80FF00',
		'#00FF40',
		'#00FFFF',
		'#0080C0',
		'#8080C0',
		'#FF00FF',
		'#804040',
		'#FF8040',
		'#00FF00',
		'#008080',
		'#004080',
		'#8080FF',
		'#800040',
		'#FF0080',
		'#800000',
		'#FF8000',
		'#008000',
		'#008040',
		'#0000FF',
		'#0000A0',
		'#800080',
		'#8000FF',
		'#400000',
		'#804000',
		'#004000',
		'#004040',
		'#000080',
		'#000040',
		'#400040',
		'#400080',
		'#000000',
		'#808000',
		'#808080',
		'#808040',
		'#C0C0C0',
		'#408080',
		'#FFFFFF',
		'#408040'
	];

	// State
	let isExpanded = $state(false);
	let oklch = $state({ l: 0.7, c: 0.15, h: 200 });
	let selectedIndex: number | null = $state(null);
	let customColors = $state<string[]>(Array(16).fill('#FFFFFF'));

	// Refs
	let spectrumCanvas = $state<HTMLCanvasElement | undefined>();
	let lumCanvas = $state<HTMLCanvasElement | undefined>();
	let isDraggingSpectrum = $state(false);
	let isDraggingLum = $state(false);

	// Initialize custom colors from localStorage
	onMount(() => {
		try {
			const saved = localStorage.getItem(storageKey);
			if (saved) {
				const parsed = JSON.parse(saved);
				if (Array.isArray(parsed)) {
					const validColors = parsed.slice(0, 16);
					while (validColors.length < 16) {
						validColors.push('#FFFFFF');
					}
					customColors = validColors;
				}
			}
		} catch (e) {
			console.error('Failed to load colors:', e);
		}
	});

	// Sync customColors to localStorage
	$effect(() => {
		localStorage.setItem(storageKey, JSON.stringify(customColors));
	});

	// Derived RGB values
	let rgb = $derived.by(() => {
		const [r, g, b] = oklchToRgb(oklch.l, oklch.c, oklch.h);
		return { r, g, b };
	});

	// Draw main spectrum
	$effect(() => {
		if (!isExpanded || !spectrumCanvas) return;

		const ctx = spectrumCanvas.getContext('2d');
		if (!ctx) return;
		const width = spectrumCanvas.width;
		const height = spectrumCanvas.height;

		const imgData = ctx.createImageData(width, height);
		const data = imgData.data;

		for (let y = 0; y < height; y++) {
			const cVal = MAX_CHROMA * (1 - y / height);
			for (let x = 0; x < width; x++) {
				const hVal = (x / width) * 360;
				const [r, g, b] = oklchToRgb(oklch.l, cVal, hVal);

				const idx = (y * width + x) * 4;
				data[idx] = r;
				data[idx + 1] = g;
				data[idx + 2] = b;
				data[idx + 3] = 255;
			}
		}
		ctx.putImageData(imgData, 0, 0);
	});

	// Draw luminance bar
	$effect(() => {
		if (!isExpanded || !lumCanvas) return;

		const ctx = lumCanvas.getContext('2d');
		if (!ctx) return;
		const width = lumCanvas.width;
		const height = lumCanvas.height;

		const imgData = ctx.createImageData(width, height);
		const data = imgData.data;

		for (let y = 0; y < height; y++) {
			const lVal = 1 - y / height;
			const [r, g, b] = oklchToRgb(lVal, oklch.c, oklch.h);

			for (let x = 0; x < width; x++) {
				const idx = (y * width + x) * 4;
				data[idx] = r;
				data[idx + 1] = g;
				data[idx + 2] = b;
				data[idx + 3] = 255;
			}
		}
		ctx.putImageData(imgData, 0, 0);
	});

	// Global mouse event handlers
	$effect(() => {
		const handleUp = () => {
			isDraggingSpectrum = false;
			isDraggingLum = false;
		};
		const handleMove = (e: MouseEvent) => {
			if (isDraggingSpectrum) handleSpectrumInteract(e);
			if (isDraggingLum) handleLumInteract(e);
		};

		window.addEventListener('mouseup', handleUp);
		window.addEventListener('mousemove', handleMove);

		return () => {
			window.removeEventListener('mouseup', handleUp);
			window.removeEventListener('mousemove', handleMove);
		};
	});

	// Helper functions
	function clamp(x: number, min: number, max: number) {
		return Math.min(Math.max(x, min), max);
	}

	function linearToSrgb(c: number) {
		return c >= 0.0031308 ? 1.055 * Math.pow(c, 1.0 / 2.4) - 0.055 : 12.92 * c;
	}

	function srgbToLinear(c: number) {
		return c >= 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
	}

	function oklchToRgb(l: number, c: number, h: number) {
		const hRad = h * (Math.PI / 180);
		const a = c * Math.cos(hRad);
		const b = c * Math.sin(hRad);

		const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
		const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
		const s_ = l - 0.0894841775 * a - 1.291485548 * b;

		const l__ = l_ * l_ * l_;
		const m__ = m_ * m_ * m_;
		const s__ = s_ * s_ * s_;

		let r = +4.0767416621 * l__ - 3.3077115913 * m__ + 0.2309699292 * s__;
		let g = -1.2684380046 * l__ + 2.6097574011 * m__ - 0.3413193965 * s__;
		let bl = -0.0041960863 * l__ - 0.7034186147 * m__ + 1.707614701 * s__;

		r = linearToSrgb(r);
		g = linearToSrgb(g);
		bl = linearToSrgb(bl);

		return [
			Math.round(clamp(r, 0, 1) * 255),
			Math.round(clamp(g, 0, 1) * 255),
			Math.round(clamp(bl, 0, 1) * 255)
		];
	}

	function rgbToOklch(r: number, g: number, b: number) {
		r = srgbToLinear(r / 255);
		g = srgbToLinear(g / 255);
		b = srgbToLinear(b / 255);

		const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
		const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
		const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

		const l__ = Math.cbrt(l_);
		const m__ = Math.cbrt(m_);
		const s__ = Math.cbrt(s_);

		const L = 0.2104542553 * l__ + 0.793617785 * m__ - 0.0040720468 * s__;
		const a = 1.9779984951 * l__ - 2.428592205 * m__ + 0.4505937099 * s__;
		const B = 0.0259040371 * l__ + 0.7827717662 * m__ - 0.808675766 * s__;

		const C = Math.sqrt(a * a + B * B);
		let H = Math.atan2(B, a) * (180 / Math.PI);
		if (H < 0) H += 360;

		return { l: L, c: C, h: H };
	}

	function handleSpectrumInteract(e: MouseEvent) {
		if (!spectrumCanvas) return;
		const rect = spectrumCanvas.getBoundingClientRect();
		let x = e.clientX - rect.left;
		let y = e.clientY - rect.top;

		x = Math.max(0, Math.min(x, 200));
		y = Math.max(0, Math.min(y, 200));

		const newH = (x / 200) * 360;
		const newC = MAX_CHROMA * (1 - y / 200);

		oklch = { ...oklch, h: newH, c: newC };
	}

	function handleLumInteract(e: MouseEvent) {
		if (!lumCanvas) return;
		const rect = lumCanvas.getBoundingClientRect();
		let y = e.clientY - rect.top;
		y = Math.max(0, Math.min(y, 200));
		const newL = 1 - y / 200;
		oklch = { ...oklch, l: newL };
	}

	function updateFromRgb(field: 'r' | 'g' | 'b', value: string) {
		let val = parseInt(value) || 0;
		val = Math.max(0, Math.min(255, val));
		const currentRgb = rgb;
		const newRgb = { ...currentRgb, [field]: val };
		const newOklch = rgbToOklch(newRgb.r, newRgb.g, newRgb.b);
		oklch = newOklch;
	}

	function updateFromOklch(field: 'l' | 'c' | 'h', value: string) {
		let val = parseFloat(value) || 0;
		if (field === 'h') {
			val = Math.max(0, Math.min(360, val));
			oklch = { ...oklch, h: val };
		} else if (field === 'c') {
			val = Math.max(0, Math.min(100, val));
			oklch = { ...oklch, c: (val / 100) * MAX_CHROMA };
		} else if (field === 'l') {
			val = Math.max(0, Math.min(100, val));
			oklch = { ...oklch, l: val / 100 };
		}
	}

	function handleCustomColorAdd() {
		const currentRgb = rgb;
		const colorString = `rgb(${currentRgb.r}, ${currentRgb.g}, ${currentRgb.b})`;
		customColors = [colorString, ...customColors.slice(0, 15)];
	}

	function selectColor(hexOrRgb: string) {
		let r: number, g: number, b: number;
		if (hexOrRgb.startsWith('#')) {
			const hex = hexOrRgb.substring(1);
			r = parseInt(hex.substring(0, 2), 16);
			g = parseInt(hex.substring(2, 4), 16);
			b = parseInt(hex.substring(4, 6), 16);
		} else {
			const parts = hexOrRgb.match(/\d+/g);
			if (parts) {
				r = parseInt(parts[0]);
				g = parseInt(parts[1]);
				b = parseInt(parts[2]);
			} else {
				return;
			}
		}
		const newOklch = rgbToOklch(r, g, b);
		oklch = newOklch;
	}

	function handleOkClick() {
		onColorSelect?.(rgb);
		onClose?.();
	}

	function toggleExpanded() {
		isExpanded = !isExpanded;
	}
</script>

<Window title="Edit Colors" onclose={onClose} class="color-dialog">
	<div class="window-body">
		<div class="dialog-content">
			<!-- LEFT SECTION -->
			<div class="section-left">
				<div>
					<div style="margin-bottom: 4px">Basic colors:</div>
					<div class="color-grid">
						{#each BASIC_COLORS as color, i (color)}
							<div
								class="color-swatch"
								class:selected={selectedIndex === 100 + i}
								style="background-color: {color}"
								onclick={() => {
									selectedIndex = 100 + i;
									selectColor(color);
								}}
								title={color}
								role="button"
								tabindex="0"
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										selectedIndex = 100 + i;
										selectColor(color);
									}
								}}
							></div>
						{/each}
					</div>
				</div>

				<div style="margin-top: 12px">
					<div style="margin-bottom: 4px">Custom colors:</div>
					<div class="color-grid">
						{#each customColors as color, i (i)}
							<div
								class="color-swatch"
								class:selected={selectedIndex === i}
								style="background-color: {color}"
								onclick={() => {
									selectedIndex = i;
									selectColor(color);
								}}
								role="button"
								tabindex="0"
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										selectedIndex = i;
										selectColor(color);
									}
								}}
							></div>
						{/each}
					</div>
				</div>

				<Button
					class="full-width-btn"
					onclick={toggleExpanded}
					disabled={isExpanded}
				>
					Define Custom Colors &gt;&gt;
				</Button>

				<div class="actions">
					<button onclick={handleOkClick} style="min-width: 70px; margin-right: 8px">OK</button>
					<button onclick={onClose} style="min-width: 70px">Cancel</button>
				</div>
			</div>

			<!-- RIGHT SECTION (Conditional) -->
			{#if isExpanded}
				<div class="section-right">
					<div style="display: flex; align-items: flex-start">
						<!-- Main Spectrum Box -->
						<div
							class="spectrum-container"
							role="slider"
							aria-label="Color spectrum"
							aria-valuemin="0"
							aria-valuemax="360"
							aria-valuenow={oklch.h}
							tabindex="0"
							onmousedown={(e) => {
								isDraggingSpectrum = true;
								handleSpectrumInteract(e);
							}}
						>
							<div class="main-spectrum-wrapper">
								<canvas
									bind:this={spectrumCanvas}
									width={200}
									height={200}
									class="main-spectrum-canvas"
								></canvas>
								<div
									class="spectrum-cursor"
									style="left: {(oklch.h / 360) * 200}px; top: {(1 - oklch.c / MAX_CHROMA) * 200}px;"
								>
									<div class="spectrum-cursor-inner"></div>
								</div>
							</div>
						</div>

						<!-- Luminance Slider -->
						<div
							class="lum-slider-wrapper"
							role="slider"
							aria-label="Lightness"
							aria-valuemin="0"
							aria-valuemax="100"
							aria-valuenow={Math.round(oklch.l * 100)}
							tabindex="0"
							onmousedown={(e) => {
								isDraggingLum = true;
								handleLumInteract(e);
							}}
						>
							<canvas
								bind:this={lumCanvas}
								width={20}
								height={200}
								class="lum-canvas"
							></canvas>
							<div
								class="lum-arrow"
								role="slider"
								aria-label="Lightness arrow"
								aria-valuenow={Math.round(oklch.l * 100)}
								tabindex="0"
								onmousedown={(e) => {
									isDraggingLum = true;
									e.stopPropagation();
									handleLumInteract(e);
								}}
								style="top: {(1 - oklch.l) * 200 + 2}px;"
							></div>
						</div>
					</div>

					<!-- Inputs and Preview -->
					<div class="inputs-area">
						<div class="preview-column">
							<div
								class="preview-box"
								style="background-color: rgb({rgb.r}, {rgb.g}, {rgb.b})"
							></div>
							<div>Solid Color</div>
						</div>

						<div class="input-group">
							<div class="value-row">
								<label for="hue-input" title="Hue (0-360)">Hue:</label>
								<input
									id="hue-input"
									type="text"
									value={Math.round(oklch.h)}
									oninput={(e) => updateFromOklch('h', e.currentTarget.value)}
								/>
							</div>
							<div class="value-row">
								<label for="chr-input" title="Chroma (0-100)">Chr:</label>
								<input
									id="chr-input"
									type="text"
									value={Math.round((oklch.c / MAX_CHROMA) * 100)}
									oninput={(e) => updateFromOklch('c', e.currentTarget.value)}
								/>
							</div>
							<div class="value-row">
								<label for="lit-input" title="Lightness (0-100)">Lit:</label>
								<input
									id="lit-input"
									type="text"
									value={Math.round(oklch.l * 100)}
									oninput={(e) => updateFromOklch('l', e.currentTarget.value)}
								/>
							</div>
						</div>

						<div class="input-group">
							<div class="value-row">
								<label for="red-input">Red:</label>
								<input
									id="red-input"
									type="text"
									value={rgb.r}
									oninput={(e) => updateFromRgb('r', e.currentTarget.value)}
								/>
							</div>
							<div class="value-row">
								<label for="green-input">Green:</label>
								<input
									id="green-input"
									type="text"
									value={rgb.g}
									oninput={(e) => updateFromRgb('g', e.currentTarget.value)}
								/>
							</div>
							<div class="value-row">
								<label for="blue-input">Blue:</label>
								<input
									id="blue-input"
									type="text"
									value={rgb.b}
									oninput={(e) => updateFromRgb('b', e.currentTarget.value)}
								/>
							</div>
						</div>
					</div>

					<Button
						class="full-width-btn"
						onclick={handleCustomColorAdd}
						style="margin-top: auto"
					>
						Add to Custom Colors
					</Button>
				</div>
			{/if}
		</div>
	</div>
</Window>

<style>
	.color-dialog {
		width: auto;
		display: inline-block;
	}

	.dialog-content {
		display: flex;
		gap: 16px;
		padding: 4px;
		align-items: flex-start;
	}

	.section-left {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.section-right {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	/* Color Grids */
	.color-grid {
		display: grid;
		grid-template-columns: repeat(8, 1fr);
		gap: 4px;
	}

	.color-swatch {
		width: 20px;
		height: 20px;
		border: 2px solid;
		border-color: #808080 #ffffff #ffffff #808080;
		box-sizing: border-box;
		cursor: pointer;
	}

	.color-swatch:active {
		border-color: #ffffff #808080 #808080 #ffffff;
	}

	.color-swatch.selected {
		box-shadow: 0 0 0 1px #000;
	}

	/* Spectrum Area */
	.spectrum-container {
		display: flex;
		background: #d4d0c8;
		padding: 0;
		border: 2px solid;
		border-color: #808080 #ffffff #ffffff #808080;
		position: relative;
		width: fit-content;
	}

	.main-spectrum-wrapper {
		position: relative;
		width: 200px;
		height: 200px;
		cursor: crosshair;
	}

	.main-spectrum-canvas {
		display: block;
		border: none;
	}

	.spectrum-cursor {
		position: absolute;
		width: 11px;
		height: 11px;
		transform: translate(-5px, -5px);
		pointer-events: none;
	}

	/* Crosshair graphic */
	.spectrum-cursor::before,
	.spectrum-cursor::after {
		content: '';
		position: absolute;
		background: black;
	}

	.spectrum-cursor::before {
		top: 0;
		left: 4px;
		width: 3px;
		height: 11px;
	}

	.spectrum-cursor::after {
		top: 4px;
		left: 0;
		width: 11px;
		height: 3px;
	}

	/* Inner white cross */
	.spectrum-cursor-inner {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
	}

	.spectrum-cursor-inner::before,
	.spectrum-cursor-inner::after {
		content: '';
		position: absolute;
		background: white;
		z-index: 2;
	}

	.spectrum-cursor-inner::before {
		top: 1px;
		left: 5px;
		width: 1px;
		height: 9px;
	}

	.spectrum-cursor-inner::after {
		top: 5px;
		left: 1px;
		width: 9px;
		height: 1px;
	}

	.lum-slider-wrapper {
		position: relative;
		width: 26px;
		height: 204px;
		cursor: ns-resize;
		margin-left: 10px;
	}

	.lum-canvas {
		display: block;
		border: 2px solid;
		border-color: #808080 #ffffff #ffffff #808080;
	}

	.lum-arrow {
		position: absolute;
		left: 26px;
		width: 0;
		height: 0;
		border-top: 5px solid transparent;
		border-bottom: 5px solid transparent;
		border-right: 8px solid black;
		transform: translateY(-5px);
		pointer-events: auto;
		cursor: ns-resize;
	}

	/* Inputs Area */
	.inputs-area {
		display: flex;
		gap: 10px;
		margin-top: 0;
	}

	.preview-column {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
	}

	.preview-box {
		width: 60px;
		height: 50px;
		border: 2px solid;
		border-color: #808080 #ffffff #ffffff #808080;
		margin-top: 0;
		margin-bottom: 4px;
	}

	.input-group {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.value-row {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 6px;
	}

	.value-row label {
		min-width: 30px;
	}

	.value-row input {
		width: 40px;
	}

	.actions {
		margin-top: 0;
		display: flex;
		justify-content: flex-start;
	}

	.full-width-btn {
		width: 100%;
	}

	button {
		min-width: 70px;
	}
</style>
