<script lang="ts">
	import {
		Button,
		Checkbox,
		Radio,
		GroupBox,
		TextBox,
		Slider,
		Dropdown,
		Window,
		WindowBody,
		TreeView,
		Tabs,
		TableView,
		ProgressBar,
		FieldBorder
	} from '$lib/components/98css';

	// Form state
	let buttonText = $state('Click me');
	let checked = $state(false);
	let radio1 = $state(true);
	let radio2 = $state(false);
	let radioDiners = $state(true);
	let radioDriveIns = $state(false);
	let radioDives = $state(false);
	let textField = $state('');
	let textAreaValue = $state('');
	let sliderValue = $state(5);
	let dropdownValue = $state('3');
	let selectedTab = $state('desktop');
	let selectedTableRow = $state<string | null>(null);
	let progress = $state(40);

	// TreeView data
	const treeNodes = [
		{
			id: 'css',
			label: 'CSS',
			children: [
				{ id: 'selectors', label: 'Selectors' },
				{ id: 'specificity', label: 'Specificity' },
				{ id: 'properties', label: 'Properties' }
			]
		},
		{
			id: 'javascript',
			label: 'JavaScript',
			children: [
				{
					id: 'avoid',
					label: 'Avoid at all costs',
					children: [
						{ id: 'unless', label: 'Unless' },
						{
							id: 'nested',
							label: 'Nested',
							children: [
								{ id: 'deep1', label: 'Deep 1' },
								{ id: 'deep2', label: 'Deep 2' }
							]
						}
					]
				}
			]
		}
	];

	// Tabs data
	const tabs = [
		{ id: 'desktop', label: 'Desktop' },
		{ id: 'mycomputer', label: 'My computer' },
		{ id: 'controlpanel', label: 'Control panel' },
		{ id: 'devices', label: 'Devices manager' }
	];

	// TableView data
	const tableHeaders = ['Name', 'Version', 'Company'];
	const tableRows = [
		{
			key: 'row1',
			cells: [
				{ content: 'MySQL ODBC 3.51 Driver' },
				{ content: '3.51.11.00' },
				{ content: 'MySQL AB' }
			]
		},
		{
			key: 'row2',
			cells: [{ content: 'SQL Server' }, { content: '3.70.06.23' }, { content: 'Microsoft Corporation' }]
		},
		{
			key: 'row3',
			cells: [{ content: 'SQL Server' }, { content: '3.70.06.23' }, { content: 'Microsoft Corporation' }]
		},
		{
			key: 'row4',
			cells: [{ content: 'SQL Server' }, { content: '3.70.06.23' }, { content: 'Microsoft Corporation' }]
		},
		{
			key: 'row5',
			cells: [{ content: 'SQL Server' }, { content: '3.70.06.23' }, { content: 'Microsoft Corporation' }]
		}
	];

	// Dropdown options
	const ratingOptions = [
		{ value: '5', label: '5 - Incredible!' },
		{ value: '4', label: '4 - Great!' },
		{ value: '3', label: '3 - Pretty good' },
		{ value: '2', label: '2 - Not so great' },
		{ value: '1', label: '1 - Unfortunate' }
	];

	function handleButtonClick(): void {
		buttonText = 'I was clicked!';
	}
</script>

<div class="container">
	<h1>98.css Component Library Demo</h1>
	<p>A collection of Svelte TypeScript components wrapping 98.css styles.</p>

	<div class="grid">
		<!-- Buttons -->
		<Window title="Buttons" width="300px">
			<WindowBody>
				<Button onclick={handleButtonClick}>{buttonText}</Button>
				<br /><br />
				<Button variant="primary">OK</Button>
				<br /><br />
				<Button disabled>Disabled</Button>
			</WindowBody>
		</Window>

		<!-- Checkbox -->
		<Window title="Checkbox" width="300px">
			<WindowBody>
				<Checkbox label="This is a checkbox" bind:checked={checked} />
				<p>Checked: {checked ? 'Yes' : 'No'}</p>
			</WindowBody>
		</Window>

		<!-- Radio Buttons -->
		<Window title="Radio Buttons" width="300px">
			<WindowBody>
				<Radio label="Option 1" name="example" value="option1" bind:checked={radio1} />
				<Radio label="Option 2" name="example" value="option2" bind:checked={radio2} />
				<p>Selected: {radio1 ? 'option1' : radio2 ? 'option2' : 'none'}</p>
			</WindowBody>
		</Window>

		<!-- TextBox -->
		<Window title="TextBox" width="300px">
			<WindowBody>
				<TextBox label="Occupation:" bind:value={textField} placeholder="Enter occupation" />
				<br />
				<TextBox
					label="Address:"
					bind:value={textAreaValue}
					type="textarea"
					rows={4}
					fieldRowStacked
				/>
			</WindowBody>
		</Window>

		<!-- Slider -->
		<Window title="Slider" width="300px">
			<WindowBody>
				<Slider label="Volume:" bind:value={sliderValue} min={1} max={11} />
				<p>Value: {sliderValue}</p>
				<br />
				<Slider label="Cowbell:" bind:value={sliderValue} min={1} max={3} step={1} hasBoxIndicator vertical />
			</WindowBody>
		</Window>

		<!-- Dropdown -->
		<Window title="Dropdown" width="300px">
			<WindowBody>
				<Dropdown bind:value={dropdownValue} options={ratingOptions} placeholder="Select rating" />
				<p>Selected: {dropdownValue}</p>
			</WindowBody>
		</Window>

		<!-- GroupBox -->
		<Window title="GroupBox" width="300px">
			<WindowBody>
				<GroupBox label="Select one:">
					<div class="field-row">
						<Radio label="Diners" name="group-example" value="diners" bind:checked={radioDiners} />
					</div>
					<div class="field-row">
						<Radio label="Drive-Ins" name="group-example" value="driveins" bind:checked={radioDriveIns} />
					</div>
					<div class="field-row">
						<Radio label="Dives" name="group-example" value="dives" bind:checked={radioDives} />
					</div>
				</GroupBox>
			</WindowBody>
		</Window>

		<!-- TreeView -->
		<Window title="TreeView" width="300px">
			<WindowBody>
				<TreeView nodes={treeNodes} />
			</WindowBody>
		</Window>

		<!-- Tabs -->
		<Window title="Tabs" width="400px">
			<WindowBody>
				<p>Hello, world!</p>
				<Tabs bind:selectedTab={selectedTab} {tabs}>
					{#if selectedTab === 'desktop'}
						<p>Desktop content</p>
					{:else if selectedTab === 'mycomputer'}
						<p>My Computer content</p>
					{:else if selectedTab === 'controlpanel'}
						<p>Control Panel content</p>
					{:else if selectedTab === 'devices'}
						<p>Devices Manager content</p>
					{/if}
				</Tabs>
			</WindowBody>
		</Window>

		<!-- TableView -->
		<Window title="TableView" width="300px">
			<WindowBody>
				<TableView
					headers={tableHeaders}
					rows={tableRows}
					bind:selectedRow={selectedTableRow}
					interactive
				/>
				<p>Selected row: {selectedTableRow ?? 'None'}</p>
			</WindowBody>
		</Window>

		<!-- ProgressBar -->
		<Window title="ProgressBar" width="300px">
			<WindowBody>
				<ProgressBar value={progress} />
				<br />
				<ProgressBar value={progress} segmented />
				<br />
				<Button onclick={() => progress = Math.min(progress + 10, 100)}>Increase</Button>
				<Button onclick={() => progress = Math.max(progress - 10, 0)}>Decrease</Button>
			</WindowBody>
		</Window>

		<!-- FieldBorder -->
		<Window title="FieldBorder" width="300px">
			<WindowBody>
				<FieldBorder variant="default">Work area</FieldBorder>
				<br />
				<FieldBorder variant="disabled">Disabled work area</FieldBorder>
				<br />
				<FieldBorder variant="status">Dynamic content</FieldBorder>
			</WindowBody>
		</Window>
	</div>
</div>

<style>
	.container {
		padding: 20px;
		max-width: 1400px;
		margin: 0 auto;
		font-family: 'Tahoma', sans-serif;
	}

	h1 {
		font-size: 24px;
		margin-bottom: 10px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 20px;
		margin-top: 20px;
	}

	p {
		margin: 8px 0;
	}
</style>
