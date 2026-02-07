<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props {
		children?: Snippet;
		class?: ClassValue;
		inactive?: boolean;
		showClose?: boolean;
		showMinimize?: boolean;
		showMaximize?: boolean;
		showRestore?: boolean;
		showHelp?: boolean;
		maximizeDisabled?: boolean;
		onclose?: () => void;
		onminimize?: () => void;
		onmaximize?: () => void;
		onrestore?: () => void;
		onhelp?: () => void;
	}

	let {
		children,
		class: className,
		inactive,
		showClose = true,
		showMinimize,
		showMaximize,
		showRestore,
		showHelp,
		maximizeDisabled,
		onclose,
		onminimize,
		onmaximize,
		onrestore,
		onhelp
	}: Props = $props();

	const titleBarClass = $derived(clsx('title-bar', className, inactive ? 'inactive' : ''));
</script>

<div class={titleBarClass}>
	<div class="title-bar-text">
		{#if children}
			{@render children()}
		{/if}
	</div>
	<div class="title-bar-controls">
		{#if showMinimize}
			<button aria-label="Minimize" onclick={onminimize}></button>
		{/if}
		{#if showMaximize}
			<button aria-label="Maximize" onclick={onmaximize} disabled={maximizeDisabled}></button>
		{/if}
		{#if showRestore}
			<button aria-label="Restore" onclick={onrestore}></button>
		{/if}
		{#if showHelp}
			<button aria-label="Help" onclick={onhelp}></button>
		{/if}
		{#if showClose}
			<button aria-label="Close" class="close" onclick={onclose}></button>
		{/if}
	</div>
</div>
