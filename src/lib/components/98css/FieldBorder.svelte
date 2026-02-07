<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	type FieldBorderVariant = 'default' | 'disabled' | 'status';

	interface Props {
		children?: Snippet;
		class?: ClassValue;
		variant?: FieldBorderVariant;
		padding?: string;
	}

	let { children, class: className, variant = 'default', padding = '8px' }: Props = $props();

	const borderClass = $derived(clsx(
		className,
		variant === 'default' && 'field-border',
		variant === 'disabled' && 'field-border-disabled',
		variant === 'status' && 'status-field-border'
	));

	const style = $derived(`padding: ${padding};`);
</script>

<div class={borderClass} style={style}>
	{#if children}
		{@render children()}
	{/if}
</div>
