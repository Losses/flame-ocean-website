<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ClassValue } from 'svelte/elements';
	import { clsx } from 'clsx';

	interface TreeNode {
		id: string;
		label: string;
		children?: TreeNode[];
		expanded?: boolean;
		disabled?: boolean;
	}

	interface Props {
		class?: ClassValue;
		nodes: TreeNode[];
		expanded?: Set<string>;
		selected?: Set<string>;
		replacedImages?: string[];
		onToggle?: (nodeId: string) => void;
		onSelect?: (nodeId: string, e?: MouseEvent | KeyboardEvent) => void;
		children?: Snippet;
	}

	let { class: className, nodes, expanded = $bindable(new Set<string>()), selected = $bindable(new Set<string>()), replacedImages = [], onToggle, onSelect, children }: Props =
		$props();

	const treeViewClass = $derived(clsx('tree-view', className));

	// Track which nodes are being programmatically updated to avoid ontoggle loop
	let programmaticUpdates = $state(new Set<string>());

	function isSelected(nodeId: string): boolean {
		return selected.has(nodeId);
	}

	function toggleNode(nodeId: string): void {
		const newExpanded = new Set(expanded);
		if (expanded.has(nodeId)) {
			newExpanded.delete(nodeId);
		} else {
			newExpanded.add(nodeId);
		}
		programmaticUpdates.add(nodeId);
		expanded = newExpanded;
		// Remove from tracking after a brief delay to allow the toggle event to fire
		requestAnimationFrame(() => {
			programmaticUpdates.delete(nodeId);
		});
		onToggle?.(nodeId);
	}

	function isExpanded(nodeId: string): boolean {
		return expanded.has(nodeId);
	}

	function handleToggle(nodeId: string, e: Event): void {
		// Ignore toggle events that originate from programmatic updates
		if (programmaticUpdates.has(nodeId)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		toggleNode(nodeId);
	}

	function handleLeafKeydown(nodeId: string, e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onSelect?.(nodeId, e);
		}
	}
</script>

<ul class={treeViewClass}>
	{#each nodes as node (node.id)}
		<li>
			{#if node.children && node.children.length > 0}
				<details open={isExpanded(node.id)} ontoggle={(e) => handleToggle(node.id, e)}>
					<summary>{node.label}</summary>
					<ul>
						{#each node.children as child (child.id)}
							<li>
								{#if child.children && child.children.length > 0}
									<details open={isExpanded(child.id)} ontoggle={(e) => handleToggle(child.id, e)}>
										<summary>{child.label}</summary>
										<ul>
											{#each child.children as grandchild (grandchild.id)}
												<li>
													{#if grandchild.children && grandchild.children.length > 0}
														{grandchild.label}
													{:else}
														<span
															class="leaf-node"
															class:selected={isSelected(grandchild.id)}
															class:replaced={replacedImages.includes(grandchild.label)}
															onclick={(e) => onSelect?.(grandchild.id, e)}
															onkeydown={(e) => handleLeafKeydown(grandchild.id, e)}
															role="button"
															tabindex="0"
														>
															{grandchild.label}
														</span>
													{/if}
												</li>
											{/each}
										</ul>
									</details>
								{:else}
									<span
										class="leaf-node"
										class:selected={isSelected(child.id)}
										class:replaced={replacedImages.includes(child.label)}
										onclick={(e) => onSelect?.(child.id, e)}
										onkeydown={(e) => handleLeafKeydown(child.id, e)}
										role="button"
										tabindex="0"
									>
										{child.label}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				</details>
			{:else}
				<span
					class="leaf-node"
					class:selected={isSelected(node.id)}
					class:replaced={replacedImages.includes(node.label)}
					onclick={(e) => onSelect?.(node.id, e)}
					onkeydown={(e) => handleLeafKeydown(node.id, e)}
					role="button"
					tabindex="0"
				>
					{node.label}
				</span>
			{/if}
		</li>
	{/each}
	{#if children}
		{@render children()}
	{/if}
</ul>

<style>
	.tree-view {
		max-height: 100%;
		overflow-y: auto;
	}

	.leaf-node {
		cursor: pointer;
		padding: 2px 4px;
		display: inline-block;
	}

	.leaf-node.selected {
		background-color: #000080;
		color: #ffffff;
	}

	.leaf-node.replaced {
		color: #0000ff;
		font-weight: bold;
	}

	.leaf-node:focus {
		outline: 1px dotted #000000;
	}
</style>
