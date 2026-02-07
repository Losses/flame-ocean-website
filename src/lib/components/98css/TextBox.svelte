<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	type InputType = 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search';

	interface Props {
		label?: string;
		labelSnippet?: Snippet;
		class?: ClassValue;
		value?: string;
		placeholder?: string;
		disabled?: boolean;
		type?: InputType | 'textarea';
		rows?: number;
		fieldRowClass?: ClassValue;
		fieldRowStacked?: boolean;
		width?: string;
	}

	let {
		label,
		labelSnippet,
		class: className,
		value = $bindable(''),
		placeholder,
		disabled,
		type = 'text',
		rows = 8,
		fieldRowClass,
		fieldRowStacked = false,
		width
	}: Props = $props();

	const uid = Math.random().toString(36).substring(2, 11);
	const inputId = `text-${uid}`;
	const fieldRowClassValue = $derived(clsx(fieldRowStacked ? 'field-row-stacked' : 'field-row', fieldRowClass));
	const style = $derived(width ? `width: ${width}` : undefined);
</script>

<div class={fieldRowClassValue} style={style}>
	<label for={inputId}>
		{label}
		{#if labelSnippet}
			{@render labelSnippet()}
		{/if}
	</label>
	{#if type === 'textarea'}
		<textarea id={inputId} {value} {placeholder} {disabled} {rows} class={className}></textarea>
	{:else}
		<input id={inputId} {value} {placeholder} {disabled} {type} class={className} />
	{/if}
</div>
