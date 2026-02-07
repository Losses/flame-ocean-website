<script lang="ts">
	import type { HTMLSelectAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Option {
		value: string;
		label: string;
		disabled?: boolean;
	}

	interface Props extends Omit<HTMLSelectAttributes, 'value'> {
		children?: Snippet;
		class?: ClassValue;
		value?: string;
		disabled?: boolean;
		options?: Option[];
		placeholder?: string;
	}

	let {
		children,
		class: className,
		value = $bindable(''),
		disabled,
		options = [],
		placeholder,
		...restProps
	}: Props = $props();
</script>

<select {value} {disabled} class={className} {...restProps}>
	{#if placeholder}
		<option value="" disabled selected={!value}>{placeholder}</option>
	{/if}
	{#each options as option}
		<option value={option.value} disabled={option.disabled}>
			{option.label}
		</option>
	{/each}
	{#if children}
		{@render children()}
	{/if}
</select>
