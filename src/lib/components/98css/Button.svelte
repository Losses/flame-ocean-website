<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props extends HTMLButtonAttributes {
		children?: Snippet;
		class?: ClassValue;
		variant?: 'default' | 'primary';
		disabled?: boolean;
		type?: 'button' | 'submit' | 'reset';
	}

	let {
		children,
		class: className,
		variant,
		type = 'button',
		disabled,
		...restProps
	}: Props = $props();

	const buttonClass = $derived(clsx(className, variant === 'primary' ? 'default' : ''));
</script>

<button {type} {disabled} class={buttonClass} {...restProps}>
	{#if children}
		{@render children()}
	{/if}
</button>
