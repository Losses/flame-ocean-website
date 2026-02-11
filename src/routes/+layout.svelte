<script lang="ts">
	import { onMount } from 'svelte';
	import favicon from '$lib/assets/favicon.svg';
	import '98.css';
	import { debugMode } from '$lib/stores';

	let { children } = $props();
	let isDebugMode = $state(false);

	onMount(() => {
		const unsubscribe = debugMode.subscribe((value) => {
			isDebugMode = value;
			if (value) {
				document.body.classList.add('debug-mode');
			} else {
				document.body.classList.remove('debug-mode');
			}
		});

		return () => unsubscribe();
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<style>
	:global(html, body) {
		max-width: 100vw;
		overflow-x: hidden;
	}

	/* Debug mode titlebar gradient */
	:global(body.debug-mode .title-bar) {
		background: linear-gradient(90deg, #59b9b9, #b78089);
	}
</style>

{@render children()}
