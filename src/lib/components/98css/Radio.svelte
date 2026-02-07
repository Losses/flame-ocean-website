<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props extends Omit<HTMLInputAttributes, 'type' | 'id'> {
		label?: string;
		children?: Snippet;
		class?: ClassValue;
		checked?: boolean;
		disabled?: boolean;
		value: string;
		name: string;
		fieldRowClass?: ClassValue;
	}

	let {
		label,
		children,
		class: className,
		checked = $bindable(false as boolean),
		disabled,
		value,
		name,
		fieldRowClass,
		...restProps
	}: Props = $props();

	const uid = Math.random().toString(36).substring(2, 11);
	const inputId = `radio-${uid}`;
	const fieldRowClassValue = $derived(clsx('field-row', fieldRowClass));
</script>

<div class={fieldRowClassValue}>
	<input id={inputId} type="radio" {checked} {disabled} {value} {name} {...restProps} />
	<label for={inputId}>
		{#if label}{label}{/if}
		{#if children}
			{@render children()}
		{/if}
	</label>
</div>
