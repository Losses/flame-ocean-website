<script lang="ts">
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface StatusField {
		text: string;
		class?: ClassValue;
	}

	interface Props {
		class?: ClassValue;
		statusFields: StatusField[];
	}

	let { class: className, statusFields }: Props = $props();

	const statusBarClass = $derived(clsx('status-bar', className));
</script>

<div class={statusBarClass}>
	{#each statusFields as field}
		<p class="status-bar-field" class:array={field.class}>{field.text}</p>
	{/each}
</div>
