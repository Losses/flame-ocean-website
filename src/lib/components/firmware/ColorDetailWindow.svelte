<script lang="ts">
	import { Window, WindowBody, TitleBar, Button, GroupBox, TableView, type TableRow, type TableCell } from '$lib/components/98css';

	export interface ColorDetail {
		semantic: string;
		color: number;
		themeId?: number;
		register?: number;
		instruction?: string;
		address?: string;
		rawBytes?: number[];
		movwInstruction?: string;
		movwAddress?: string;
		strhInstruction?: string;
		strhAddress?: string;
		isPatched?: boolean;
		isFlacPatched?: boolean;
	}

	interface Props {
		detail: ColorDetail;
		onclose: () => void;
		onedit?: () => void;
		onunlock?: () => void;
	}

	let { detail, onclose, onedit, onunlock }: Props = $props();

	const rgb565ToCss = (color: number): string => {
		const r = Math.round(((color >> 11) & 0x1f) * 255 / 31);
		const g = Math.round(((color >> 5) & 0x3f) * 255 / 63);
		const b = Math.round((color & 0x1f) * 255 / 31);
		return `rgb(${r}, ${g}, ${b})`;
	};

	const instructionRows = $derived.by<TableRow[]>(() => {
		const rows: TableRow[] = [];

		if (detail.semantic.includes('Codec Info') || detail.semantic.includes('FLAC')) {
			// FLAC format: FLAC: 0x44DE, then MOVW, then STRH
			rows.push({
				cells: [
					{ content: 'FLAC', class: 'mono' },
					{ content: '0x' + detail.color.toString(16).padStart(4, '0').toUpperCase(), class: 'mono' }
				]
			});

			if (detail.movwAddress && detail.movwInstruction) {
				rows.push({
					cells: [
						{ content: detail.movwAddress, class: 'mono' },
						{ content: detail.movwInstruction, class: 'mono' }
					]
				});
			} else {
				rows.push({
					cells: [
						{ content: '(preload)', class: 'mono' },
						{ content: '(preload)', class: 'mono' }
					]
				});
			}

			if (detail.strhAddress && detail.strhInstruction) {
				rows.push({
					cells: [
						{ content: detail.strhAddress, class: 'mono' },
						{ content: detail.strhInstruction, class: 'mono' }
					]
				});
			} else {
				rows.push({
					cells: [
						{ content: '-', class: 'mono' },
						{ content: '-', class: 'mono' }
					]
				});
			}
		} else {
			// Menu format: R3: 0x0000, then MOVW, then STRH
			if (detail.register !== undefined) {
				rows.push({
					cells: [
						{ content: 'R' + detail.register, class: 'mono' },
						{ content: '0x' + detail.color.toString(16).padStart(4, '0').toUpperCase(), class: 'mono' }
					]
				});
			} else {
				rows.push({
					cells: [
						{ content: '-', class: 'mono' },
						{ content: '0x' + detail.color.toString(16).padStart(4, '0').toUpperCase(), class: 'mono' }
					]
				});
			}

			if (detail.movwAddress && detail.movwInstruction) {
				rows.push({
					cells: [
						{ content: detail.movwAddress, class: 'mono' },
						{ content: detail.movwInstruction, class: 'mono' }
					]
				});
			} else {
				rows.push({
					cells: [
						{ content: '(preload)', class: 'mono' },
						{ content: '(preload)', class: 'mono' }
					]
				});
			}

			if (detail.strhAddress && detail.strhInstruction) {
				rows.push({
					cells: [
						{ content: detail.strhAddress, class: 'mono' },
						{ content: detail.strhInstruction, class: 'mono' }
					]
				});
			} else {
				rows.push({
					cells: [
						{ content: '-', class: 'mono' },
						{ content: '-', class: 'mono' }
					]
				});
			}
		}

		return rows;
	});

	const instructionHeaders = ['Key', 'Value'];

	// Show Edit button for Progress Bar, Marquee, and patched FLAC colors
	const showEditButton = $derived(
		detail.semantic.includes('Progress Bar') ||
		detail.semantic.includes('Marquee Overlay') ||
		(detail.semantic.includes('Codec Info') && detail.isFlacPatched)
	);

	// Show Unlock button for unpatched FLAC colors
	const showUnlockButton = $derived(
		detail.semantic.includes('Codec Info') && !detail.isFlacPatched
	);
</script>

<div class="color-detail-wrapper">
	<Window width="480px">
		<TitleBar onclose={onclose}>Color Properties</TitleBar>
		<WindowBody>
			<div class="detail-layout">
				<!-- Preview Section -->
				<GroupBox>
					<div class="preview-section">
						<div class="color-preview-large" style="background-color: {rgb565ToCss(detail.color)};">
						</div>
						<div class="preview-info">
							<div class="info-row">
								<span class="label">Semantic:</span>
								<span class="value">{detail.semantic}</span>
							</div>
							{#if detail.themeId !== undefined}
								<div class="info-row">
									<span class="label">Theme ID:</span>
									<span class="value">{detail.themeId}</span>
								</div>
							{/if}
							{#if detail.register !== undefined}
								<div class="info-row">
									<span class="label">Register:</span>
									<span class="value">R{detail.register}</span>
								</div>
							{/if}
						</div>
					</div>
				</GroupBox>

				<TableView
					headers={instructionHeaders}
					rows={instructionRows}
					height="96px"
					width="100%"
				/>

				<!-- Buttons -->
				<div class="button-row">
					{#if showUnlockButton && onunlock}
						<Button onclick={onunlock}>Unlock</Button>
					{:else if showEditButton && onedit}
						<Button onclick={onedit}>Edit</Button>
					{/if}
					<div style="flex: 1;"></div>
					<Button onclick={onclose}>Close</Button>
				</div>
			</div>
		</WindowBody>
	</Window>
</div>

<style>
	.color-detail-wrapper {
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

	.detail-layout {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.preview-section {
		display: flex;
		gap: 16px;
		align-items: flex-start;
	}

	.color-preview-large {
		width: 48px;
		height: 48px;
		border: 2px solid #808080;
		flex-shrink: 0;
	}

	.preview-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.label {
		color: #000000;
		font-weight: normal;
	}

	.value {
		color: #000000;
	}

	.button-row {
		display: flex;
		justify-content: flex-end;
		gap: 4px;
	}
</style>
