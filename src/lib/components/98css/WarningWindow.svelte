<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Button, Window, WindowBody } from './index.js';

	interface Props {
		title?: string;
		message?: string;
		children?: Snippet;
		onconfirm?: () => void;
		oncancel?: () => void;
		confirmText?: string;
		cancelText?: string;
		icon?: 'warning' | 'error' | 'info' | 'question';
		width?: string;
		showCancel?: boolean;
	}

	let {
		title = 'Warning',
		message,
		children,
		onconfirm,
		oncancel,
		confirmText = 'OK',
		cancelText = 'Cancel',
		icon = 'warning',
		width = '400px',
		showCancel = true
	}: Props = $props();

	function handleConfirm() {
		onconfirm?.();
	}

	function handleCancel() {
		oncancel?.();
	}

	const iconPath = $derived(
		icon === 'warning'
			? '/dialog-warning.png'
			: icon === 'error'
				? '/dialog-error.png'
				: icon === 'info'
					? '/dialog-info.png'
					: '/dialog-info.png'
	);
</script>

<div class="warning-wrapper">
	<Window {width} title={title} showClose={false}>
		<WindowBody>
			<div class="warning-content">
				<div class="warning-row">
					<div class="warning-icon">
						<img src={iconPath} alt={icon} />
					</div>
					<div class="warning-text">
						{#if message}
							<p>{message}</p>
						{/if}
						{#if children}
							{@render children()}
						{/if}
					</div>
				</div>
				<div class="warning-buttons">
					{#if showCancel}
						<Button onclick={handleCancel}>{cancelText}</Button>
					{/if}
					<Button variant="primary" onclick={handleConfirm}>{confirmText}</Button>
				</div>
			</div>
		</WindowBody>
	</Window>
</div>

<style>
	.warning-wrapper {
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

	.warning-content {
		padding-top: 8px;
		padding-left: 8px;
		padding-right: 4px;
		padding-bottom: 4px;
	}

	.warning-row {
		display: flex;
		gap: 16px;
		margin-bottom: 16px;
	}

	.warning-icon {
		flex-shrink: 0;
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.warning-icon img {
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}

	.warning-text {
		flex: 1;
		min-width: 0;
	}

	.warning-text p {
		margin: 0;
		font-size: 12px;
		color: #000000;
		white-space: pre-wrap;
		word-wrap: break-word;
	}

	.warning-buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 8px;
	}

	:global(.warning-buttons button) {
		min-width: 75px;
	}
</style>
