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
		onToggle?: (nodeId: string) => void;
		children?: Snippet;
	}

	let { class: className, nodes, expanded = $bindable(new Set<string>()), onToggle, children }: Props =
		$props();

	const treeViewClass = $derived(clsx('tree-view', className));

	function toggleNode(nodeId: string): void {
		const newExpanded = new Set(expanded);
		if (expanded.has(nodeId)) {
			newExpanded.delete(nodeId);
		} else {
			newExpanded.add(nodeId);
		}
		expanded = newExpanded;
		onToggle?.(nodeId);
	}

	function isExpanded(nodeId: string): boolean {
		return expanded.has(nodeId);
	}
</script>

<ul class={treeViewClass}>
	{#each nodes as node}
		<li>
			{#if node.children && node.children.length > 0}
				<details open={isExpanded(node.id)} ontoggle={() => toggleNode(node.id)}>
					<summary>{node.label}</summary>
					<ul>
						{#each node.children as child}
							<li>
								{#if child.children && child.children.length > 0}
									<details open={isExpanded(child.id)} ontoggle={() => toggleNode(child.id)}>
										<summary>{child.label}</summary>
										<ul>
											{#each child.children as grandchild}
												<li>{grandchild.label}</li>
											{/each}
										</ul>
									</details>
								{:else}
									{child.label}
								{/if}
							</li>
						{/each}
					</ul>
				</details>
			{:else}
				{node.label}
			{/if}
		</li>
	{/each}
	{#if children}
		{@render children()}
	{/if}
</ul>
