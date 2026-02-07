<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props extends Omit<HTMLInputAttributes, 'type'> {
		label?: string;
		class?: ClassValue;
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		disabled?: boolean;
		hasBoxIndicator?: boolean;
		vertical?: boolean;
		width?: string;
		minLabel?: string;
		maxLabel?: string;
	}

	let {
		label,
		class: className,
		value = $bindable(5),
		min = 1,
		max = 11,
		step,
		disabled,
		hasBoxIndicator = false,
		vertical = false,
		width,
		minLabel,
		maxLabel
	}: Props = $props();

	const uid = Math.random().toString(36).substring(2, 11);
	const inputId = `range-${uid}`;
	const style = $derived(width ? `width: ${width}` : undefined);
</script>

<div class="field-row" style={style}>
	{#if label}
		<label for={inputId}>{label}</label>
	{/if}
	{#if minLabel}
		<label for={inputId}>{minLabel}</label>
	{/if}
	<div class:is-vertical={vertical}>
		<input
			id={inputId}
			type="range"
			{value}
			{min}
			{max}
			{step}
			{disabled}
			class={className}
			class:has-box-indicator={hasBoxIndicator}
		/>
	</div>
	{#if maxLabel}
		<label for={inputId}>{maxLabel}</label>
	{/if}
</div>
