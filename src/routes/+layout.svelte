<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import '98.css';

	let { children } = $props();


</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<style>
	:global(html, body) {
		max-width: 100vw;
		overflow-x: hidden;
	}
</style>

{@render children()}
