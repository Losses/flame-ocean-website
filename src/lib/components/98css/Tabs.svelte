<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface Tab {
		id: string;
		label: string;
		disabled?: boolean;
	}

	interface Props {
		class?: ClassValue;
		tabs: Tab[];
		selectedTab?: string;
		onSelect?: (tabId: string) => void;
		multirows?: boolean;
		children?: Snippet;
		tabsSnippet?: Snippet;
	}

	let { class: className, tabs, selectedTab = $bindable(''), onSelect, multirows, children, tabsSnippet }: Props =
		$props();

	function selectTab(tabId: string): void {
		selectedTab = tabId;
		onSelect?.(tabId);
	}

	function isSelected(tabId: string): boolean {
		return selectedTab === tabId;
	}
</script>

<menu role="tablist" class={className} class:multirows>
	{#each tabs as tab}
		<li role="tab" aria-selected={isSelected(tab.id)}>
			<a
				href="#tabs"
				onclick={(e) => {
					e.preventDefault();
					if (!tab.disabled) {
						selectTab(tab.id);
					}
				}}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						if (!tab.disabled) {
							selectTab(tab.id);
						}
					}
				}}
				class:aria-disabled={tab.disabled}
			>
				{tab.label}
			</a>
		</li>
	{/each}
	{#if tabsSnippet}
		{@render tabsSnippet()}
	{/if}
</menu>

<div class="window" role="tabpanel">
	<div class="window-body">
		{#if children}
			{@render children()}
		{/if}
	</div>
</div>
