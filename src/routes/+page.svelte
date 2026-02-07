<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Window,
		WindowBody,
		TreeView,
		Button,
		ProgressBar,
		StatusBar
	} from '$lib/components/98css';
	import FontGridRenderer from '$lib/components/firmware/FontGridRenderer.svelte';
	import ImageRenderer from '$lib/components/firmware/ImageRenderer.svelte';
	import FirmwareWorker from '$lib/workers/firmware-worker.ts?worker';

	// Types
	interface FontPlaneInfo {
		name: string;
		start: number;
		end: number;
		estimatedCount: number;
	}

	interface BitmapFileInfo {
		name: string;
		width: number;
		height: number;
		size: number;
		offset?: number;
	}

	interface TreeNode {
		id: string;
		label: string;
		type: 'folder' | 'plane' | 'image';
		data?: FontPlaneInfo | BitmapFileInfo;
		children?: TreeNode[];
	}

	// State
	let firmwareData = $state<Uint8Array | null>(null);
	let worker: Worker | null = null;
	let isProcessing = $state(false);
	let progress = $state(0);
	let statusMessage = $state('Ready to load firmware');
	let selectedNode = $state<TreeNode | null>(null);
	let expandedNodes = $state(new Set<string>(['fonts', 'images']));
	let treeNodes = $state<TreeNode[]>([]);
	let imageList = $state<BitmapFileInfo[]>([]);
	let planeData = $state<{ name: string; start: number; end: number; fonts: Array<{ unicode: number; fontType: 'SMALL' | 'LARGE'; pixels: boolean[][] }> } | null>(null);
	let imageData = $state<{ name: string; width: number; height: number; rgb565Data: Uint8Array } | null>(null);

	// File input
	let fileInput: HTMLInputElement;
	let dropZone: HTMLDivElement;

	// Initialize worker
	onMount(() => {
		worker = new FirmwareWorker();

		worker.onmessage = (e: MessageEvent) => {
			const { type, id, result, error, message } = e.data;

			if (type === 'success') {
				if (id === 'analyze') {
					// After analysis, list planes and images
					statusMessage = 'Firmware analyzed. Loading resources...';
					loadResources();
				} else if (id === 'listPlanes') {
					const planes = result as FontPlaneInfo[];
					buildFontTree(planes);
				} else if (id === 'listImages') {
					const images = result as BitmapFileInfo[];
					imageList = images;
					buildImageTree(images);
				} else if (id === 'extractPlane') {
					const data = result as typeof planeData;
					planeData = data;
					isProcessing = false;
					statusMessage = `Loaded plane: ${data?.name ?? 'Unknown'}`;
				} else if (id === 'extractImage') {
					const data = result as typeof imageData;
					imageData = data;
					isProcessing = false;
					statusMessage = `Loaded image: ${data?.name ?? 'Unknown'}`;
				}
			} else if (type === 'progress') {
				statusMessage = message;
			} else if (type === 'error') {
				statusMessage = `Error: ${error}`;
				isProcessing = false;
			}
		};

		worker.onerror = (err) => {
			statusMessage = `Worker error: ${err.message}`;
			isProcessing = false;
		};

		return () => {
			worker?.terminate();
		};
	});

	// Load resources after analysis
	async function loadResources() {
		if (!worker || !firmwareData) return;

		// List fonts
		worker.postMessage({
			type: 'listPlanes',
			id: 'listPlanes',
			firmware: new Uint8Array() // Empty, worker uses cached data
		});

		// List images
		worker.postMessage({
			type: 'listImages',
			id: 'listImages',
			firmware: new Uint8Array()
		});
	}

	// Build font tree structure
	function buildFontTree(planes: FontPlaneInfo[]) {
		const fontNodes = planes
			.filter((p) => p.estimatedCount > 0)
			.map((plane) => ({
				id: `plane-${plane.name}`,
				label: `${plane.name} (${plane.estimatedCount})`,
				type: 'plane' as const,
				data: plane,
				children: []
			}));

		treeNodes = [
			{
				id: 'fonts',
				label: 'Unicode Planes',
				type: 'folder',
				children: fontNodes
			},
			...(treeNodes.length > 1 ? [treeNodes[1]] : []) // Preserve images if already added
		];
	}

	// Build image tree structure
	function buildImageTree(images: BitmapFileInfo[]) {
		const imageNodes = images.map((img, idx) => {
			return {
				id: `image-${idx}`,
				label: `${img.name} (${img.width}x${img.height})`,
				type: 'image' as const,
				data: img, // Use the image data directly with offset from worker
				children: []
			};
		});

		// Update or add images folder
		const imagesNode = {
			id: 'images',
			label: 'Firmware Images',
			type: 'folder' as const,
			children: imageNodes
		};

		if (treeNodes.length > 0 && treeNodes[0].id === 'fonts') {
			treeNodes = [treeNodes[0], imagesNode];
		} else {
			treeNodes = [...treeNodes, imagesNode];
		}
	}

	// Handle tree node click
	function handleNodeClick(node: TreeNode) {
		selectedNode = node;

		if (node.type === 'plane' && node.data) {
			loadPlane(node.data as FontPlaneInfo);
		} else if (node.type === 'image' && node.data) {
			loadImage(node.data as BitmapFileInfo & { offset: number });
		}
	}

	// Find node by ID (recursive helper)
	function findNodeById(nodes: TreeNode[], id: string): TreeNode | null {
		for (const node of nodes) {
			if (node.id === id) return node;
			if (node.children) {
				const found = findNodeById(node.children, id);
				if (found) return found;
			}
		}
		return null;
	}

	// Handle tree node selection from TreeView onSelect
	function handleSelectNode(nodeId: string) {
		const node = findNodeById(treeNodes, nodeId);
		if (node) {
			handleNodeClick(node);
		}
	}

	// Load font plane
	function loadPlane(plane: FontPlaneInfo) {
		if (!worker || !firmwareData || isProcessing) return;

		isProcessing = true;
		statusMessage = `Extracting ${plane.name}...`;
		imageData = null; // Clear image data

		worker.postMessage({
			type: 'extractPlane',
			id: 'extractPlane',
			firmware: new Uint8Array(), // Worker uses cached data
			planeName: plane.name,
			start: plane.start,
			end: plane.end
		});
	}

	// Load image
	function loadImage(image: BitmapFileInfo & { offset: number }) {
		if (!worker || !firmwareData || isProcessing) return;

		isProcessing = true;
		statusMessage = `Extracting ${image.name}...`;
		planeData = null; // Clear plane data

		worker.postMessage({
			type: 'extractImage',
			id: 'extractImage',
			firmware: new Uint8Array(),
			imageName: image.name,
			width: image.width,
			height: image.height,
			offset: image.offset!
		});
	}

	// File handling
	function handleFileSelect(e: Event) {
		const target = e.target as HTMLInputElement;
		const file = target.files?.[0];
		if (file) {
			loadFirmware(file);
		}
	}

	async function loadFirmware(file: File) {
		isProcessing = true;
		progress = 10;
		statusMessage = `Loading ${file.name}...`;

		try {
			const arrayBuffer = await file.arrayBuffer();
			firmwareData = new Uint8Array(arrayBuffer);

			progress = 30;
			statusMessage = 'Analyzing firmware...';

			// Analyze firmware
			worker!.postMessage({
				type: 'analyze',
				id: 'analyze',
				firmware: firmwareData
			});

			progress = 100;
		} catch (err) {
			statusMessage = `Error loading file: ${err}`;
			isProcessing = false;
		}
	}

	// Drag and drop handlers
	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		dropZone.classList.add('drag-over');
	}

	function handleDragLeave(e: DragEvent) {
		e.preventDefault();
		dropZone.classList.remove('drag-over');
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		dropZone.classList.remove('drag-over');

		const file = e.dataTransfer?.files[0];
		if (file) {
			loadFirmware(file);
		}
	}

	// Trigger file input
	function triggerFileInput() {
		fileInput.click();
	}
</script>

<div class="container">
	<h1>Firmware Browser</h1>
	<p>Drag and drop a firmware file or click to browse</p>

	<!-- Drop Zone -->
	<div
		bind:this={dropZone}
		class="drop-zone"
		ondragover={handleDragOver}
		ondragleave={handleDragLeave}
		ondrop={handleDrop}
		onclick={triggerFileInput}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				triggerFileInput();
			}
		}}
		role="button"
		tabindex="0"
	>
		<input type="file" bind:this={fileInput} hidden onchange={handleFileSelect} />
		<div class="drop-zone-content">
			{#if !firmwareData}
				<div class="drop-icon">📁</div>
				<div class="drop-text">Drop firmware file here or click to browse</div>
			{:else}
				<div class="drop-icon">✅</div>
				<div class="drop-text">Firmware loaded! Click to load a different file</div>
			{/if}
		</div>
	</div>

	<!-- Progress Bar -->
	{#if isProcessing}
		<Window title="Processing" width="600px">
			<WindowBody>
				<ProgressBar value={progress} />
				<p>{statusMessage}</p>
			</WindowBody>
		</Window>
	{/if}

	<!-- Main Browser Interface -->
	{#if firmwareData && treeNodes.length > 0}
		<div class="browser-layout">
			<!-- Tree View -->
			<Window title="Resources" class="tree-window">
				<WindowBody>
					<TreeView
						nodes={treeNodes}
						expanded={expandedNodes}
						onSelect={(nodeId) => handleSelectNode(nodeId)}
					/>
				</WindowBody>
			</Window>

			<!-- Resource Browser -->
			<Window title="Resource Browser" class="browser-window">
				<WindowBody>
					{#if selectedNode}
						{#if selectedNode.type === 'plane' && planeData}
							<div class="plane-header">
								<h2>{planeData.name}</h2>
								<p>U+{planeData.start.toString(16).toUpperCase()} - U+{planeData.end.toString(16).toUpperCase()}</p>
								<p>{planeData.fonts.length} fonts found</p>
							</div>
							<FontGridRenderer fonts={planeData.fonts} zoom={10} />
						{:else if selectedNode.type === 'image' && imageData}
							<ImageRenderer
								name={imageData.name}
								width={imageData.width}
								height={imageData.height}
								rgb565Data={imageData.rgb565Data}
								zoom={2}
							/>
						{/if}
					{:else}
						<div class="empty-state">
							<p>Select a resource from the tree to view its contents</p>
						</div>
					{/if}
				</WindowBody>
			</Window>
		</div>
	{/if}

	<!-- Status Bar -->
	<StatusBar statusFields={[{ text: statusMessage }]} />
</div>

<style>
	.container {
		padding: 20px;
		max-width: 1600px;
		margin: 0 auto;
		font-family: 'Tahoma', sans-serif;
	}

	h1 {
		font-size: 24px;
		margin-bottom: 10px;
	}

	p {
		margin: 8px 0;
	}

	.drop-zone {
		margin: 20px 0;
		padding: 40px;
		border: 3px dashed #808080;
		background-color: #c0c0c0;
		text-align: center;
		cursor: pointer;
		transition: background-color 0.2s;
	}

	.drop-zone:hover,
	.drop-zone :global(.drag-over) {
		background-color: #d0d0d0;
		border-color: #000080;
	}

	.drop-zone-content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
	}

	.drop-icon {
		font-size: 48px;
	}

	.drop-text {
		font-size: 14px;
		color: #000000;
	}

	.browser-layout {
		display: grid;
		grid-template-columns: 350px 1fr;
		gap: 10px;
		margin-top: 20px;
	}

	:global(.tree-window) {
		min-height: 400px;
	}

	:global(.browser-window) {
		min-height: 400px;
	}

	.plane-header {
		margin-bottom: 16px;
		padding-bottom: 8px;
		border-bottom: 1px solid #808080;
	}

	.plane-header h2 {
		font-size: 16px;
		margin: 0 0 8px 0;
	}

	.plane-header p {
		font-size: 12px;
		margin: 4px 0;
	}

	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 300px;
		color: #808080;
	}
</style>
