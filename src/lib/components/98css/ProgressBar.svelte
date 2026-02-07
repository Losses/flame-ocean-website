<script lang="ts">
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Props {
		class?: ClassValue;
		value: number;
		max?: number;
		segmented?: boolean;
	}

	let { class: className, value, max = 100, segmented = false }: Props = $props();

	const percentage = $derived(Math.min(Math.max((value / max) * 100, 0), 100));
	const containerClass = $derived(clsx('progress-indicator', className, segmented ? 'segmented' : ''));
	const barStyle = $derived(`width: ${percentage}%;`);
</script>

<div class={containerClass}>
	<span class="progress-indicator-bar" style={barStyle}></span>
</div>
