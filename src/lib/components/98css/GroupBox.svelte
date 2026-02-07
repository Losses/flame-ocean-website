<script lang="ts">
	import type { HTMLFieldsetAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props extends HTMLFieldsetAttributes {
		label?: string;
		children?: Snippet;
		class?: ClassValue;
	}

	let { label, children, class: className, ...restProps }: Props = $props();
</script>

<fieldset class={className} {...restProps}>
	{#if label}
		<legend>{label}</legend>
	{/if}
	{#if children}
		{@render children()}
	{/if}
</fieldset>
