<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props {
		children?: Snippet;
		class?: ClassValue;
	}

	let { children, class: className }: Props = $props();

	const windowBodyClass = $derived(clsx('window-body', className));
</script>

<div class={windowBodyClass}>
	{#if children}
		{@render children()}
	{/if}
</div>
