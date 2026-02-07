<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';
	import TitleBar from './TitleBar.svelte';
	import WindowBody from './WindowBody.svelte';
	import StatusBar from './StatusBar.svelte';

	interface StatusField {
		text: string;
		class?: ClassValue;
	}

	interface Props {
		title?: string;
		children?: Snippet;
		class?: ClassValue;
		width?: string;
		height?: string;
		inactive?: boolean;
		showClose?: boolean;
		showMinimize?: boolean;
		showMaximize?: boolean;
		showRestore?: boolean;
		showHelp?: boolean;
		maximizeDisabled?: boolean;
		statusFields?: StatusField[];
	}

	let {
		title,
		children,
		class: className,
		width,
		height,
		inactive,
		showClose = true,
		showMinimize,
		showMaximize,
		showRestore,
		showHelp,
		maximizeDisabled,
		statusFields
	}: Props = $props();

	const windowClass = $derived(clsx('window', className));
	const style = $derived(`${width ? `width: ${width};` : ''}${height ? `height: ${height};` : ''}`);
</script>

<div class={windowClass} style={style}>
	{#if title}
		<TitleBar
			{inactive}
			{showClose}
			{showMinimize}
			{showMaximize}
			{showRestore}
			{showHelp}
			{maximizeDisabled}
		>
			{title}
		</TitleBar>
	{/if}
	{#if children}
		{@render children()}
	{/if}
	{#if statusFields && statusFields.length > 0}
		<StatusBar {statusFields} />
	{/if}
</div>
