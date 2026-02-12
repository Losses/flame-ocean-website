/**
 * Setup script to download and prepare test fixtures
 *
 * This script:
 * - Downloads all required ECHO MINI firmware files
 * - Extracts them to the expected location
 * - Runs the Python extractor to generate reference files
 *
 * Usage:
 *   bun run src/lib/rse/__tests__/setup-fixtures.ts
 */

import { existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Configuration
const BASE_DOWNLOAD_DIR = '/tmp/echo-mini-firmwares';
const FIRMWARE_URLS = [
	{ version: 'V3.1.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V3.1.0.zip' },
	{ version: 'V3.0.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V3.0.0.zip' },
	{ version: 'V2.8.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V2.8.0.zip' },
	{ version: 'V2.7.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V2.7.0.zip' },
	{ version: 'V2.6.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V2.6.0.zip' },
	{ version: 'V2.5.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V2.5.0.zip' },
	{ version: 'V2.4.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V2.4.0.zip' },
	{ version: 'V1.8.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V1.8.0.zip' },
	{ version: 'V1.7.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V1.7.0.zip' },
	{ version: 'V1.6.2', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V1.6.2.zip' },
	{ version: 'V1.5.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/EN/ECHO%20MINI%20V1.5.0%20.zip' },
	{ version: 'V1.4.6', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/EN/ECHO%20MINI%20V1.4.6.zip' },
	{ version: 'V1.4.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/EN/ECHO%20MINI%20V1.4.0.zip' },
	{ version: 'V1.3.0', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20EHCO%20MINI%20V1.3.0.zip' },
	{ version: 'V1.2.7', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V1.2.7.zip' },
	{ version: 'V1.2.5', url: 'https://fiio-firmware.fiio.net/ECHO%20MINI/ECHO%20MINI%20V1.2.5.zip' },
];

function exec(command: string, cwd?: string): void {
	try {
		execSync(command, { stdio: 'inherit', cwd });
	} catch (error) {
		throw new Error(`Command failed: ${command}\n${error}`);
	}
}

function downloadFile(url: string, destPath: string): void {
	console.log(`  Downloading: ${url}`);
	try {
		execSync(`curl -L -o "${destPath}" "${url}"`, { stdio: 'pipe' });
		console.log(`  Saved to: ${destPath}`);
	} catch (error) {
		throw new Error(`Failed to download: ${url}\n${error}`);
	}
}

function extractZip(zipPath: string, destDir: string): void {
	console.log(`  Extracting: ${zipPath}`);
	try {
		// Use Python's zipfile module (more reliable than unzip command)
		execSync(`python3 -c "
import zipfile
import sys
zip_path = '${zipPath}'
dest_dir = '${destDir}'
try:
    with zipfile.ZipFile(zip_path, 'r') as zip_ref:
        zip_ref.extractall(dest_dir)
    print(f'Extracted to {dest_dir}')
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
"`);
	} catch (error) {
		throw new Error(`Failed to extract: ${zipPath}\n${error}`);
	}
}

function ensureDir(path: string): void {
	if (!existsSync(path)) {
		mkdirSync(path, { recursive: true });
	}
}

function downloadAllFirmwares() {
	console.log('\n=== Downloading ECHO MINI Firmware Files ===\n');

	for (const { version, url } of FIRMWARE_URLS) {
		const versionDir = join(BASE_DOWNLOAD_DIR, `ECHO MINI ${version}`);
		const zipPath = join(BASE_DOWNLOAD_DIR, `ECHO MINI ${version}.zip`);

		// Skip if zip already exists
		if (existsSync(zipPath)) {
			console.log(`✓ ECHO MINI ${version} - zip already downloaded`);
		} else {
			// Download
			console.log(`\n→ ECHO MINI ${version}`);
			downloadFile(url, zipPath);
		}

		// Try to find the firmware file inside the zip
		let firmwareFilename: string;
		try {
			firmwareFilename = execSync(
				`python3 -c "import zipfile; z=zipfile.ZipFile('${zipPath.replace(/'/g, "\\'")}', 'r'); imgs=[n for n in z.namelist() if n.endswith('.IMG')]; print(imgs[0] if imgs else '')"`,
				{ encoding: 'utf-8' }
			).trim();
		} catch {
			console.log(`  ⚠️  Invalid zip file, skipping`);
			rmSync(zipPath);
			continue;
		}

		if (!firmwareFilename) {
			console.log(`  ⚠️  No .IMG file found in zip, skipping`);
			rmSync(zipPath);
			continue;
		}

		const firmwarePath = join(versionDir, firmwareFilename);

		// Skip if firmware already extracted
		if (existsSync(firmwarePath)) {
			console.log(`✓ ECHO MINI ${version} - already extracted`);
			// Clean up zip
			rmSync(zipPath);
			continue;
		}

		// Extract
		ensureDir(versionDir);
		extractZip(zipPath, versionDir);

		// Clean up zip file
		rmSync(zipPath);

		// Verify
		if (!existsSync(firmwarePath)) {
			console.log(`  ⚠️  Firmware not found after extraction: ${firmwarePath}`);
			continue;
		}

		console.log(`✓ ECHO MINI ${version} - complete`);
	}

	console.log('\n=== All firmware files downloaded ===\n');
}

function createBatchAutoStructure(): void {
	/**
	 * Create the "batch_auto" directory structure with symlinks to timestamped Python output.
	 * This allows the integration test to use a stable path.
	 */
	console.log('\n=== Creating batch_auto directory structure ===\n');

	const batchAutoDir = join(BASE_DOWNLOAD_DIR, 'extracted_bitmaps_smart', 'batch_auto');
	ensureDir(batchAutoDir);

	// Find the most recent timestamped batch directory
	const extractedBase = join(BASE_DOWNLOAD_DIR, 'extracted_bitmaps_smart');
	if (!existsSync(extractedBase)) {
		console.log('  ⊘ No extracted_bitmaps_smart directory found');
		return;
	}

	const batches = readdirSync(extractedBase)
		.filter((f) => f.startsWith('batch_') && f !== 'batch_auto')
		.sort()
		.reverse();

	if (batches.length === 0) {
		console.log('  ⊘ No batch directories found');
		return;
	}

	const latestBatch = batches[0];
	const latestBatchPath = join(extractedBase, latestBatch);
	console.log(`  Linking to latest batch: ${latestBatch}`);

	// Create symlinks for each version directory
	const versions = readdirSync(latestBatchPath);
	for (const version of versions) {
		const srcPath = join(latestBatchPath, version);
		const destPath = join(batchAutoDir, version);

		// Remove existing symlink or directory
		if (existsSync(destPath)) {
			rmSync(destPath, { recursive: true, force: true });
		}

		// Create symlink
		execSync(`ln -sf "${srcPath}" "${destPath}"`);
		console.log(`  ✓ ${version}`);
	}

	console.log('\n=== batch_auto structure created ===\n');
}

function preparePythonEnvironment(): void {
	/**
	 * Prepare the environment for Python extraction.
	 * Since Python script has hardcoded paths, we need to:
	 * 1. Create a reference directory structure
	 * 2. Copy/link firmware files to the expected location
	 */
	console.log('\n=== Preparing Python extraction environment ===\n');

	// The Python script looks for firmwares here:
	const pythonFirmwareDir = join(process.cwd(), 'references', 'firmwares');

	// Clean up old structure
	if (existsSync(pythonFirmwareDir)) {
		rmSync(pythonFirmwareDir, { recursive: true });
	}
	ensureDir(pythonFirmwareDir);

	// Link all firmware files into the Python structure
	let linkedCount = 0;
	for (const { version } of FIRMWARE_URLS) {
		const versionDir = join(BASE_DOWNLOAD_DIR, `ECHO MINI ${version}`);
		const firmwarePath = join(versionDir, 'HIFIEC80.IMG');

		if (!existsSync(firmwarePath)) {
			console.log(`  ⊘ ECHO MINI ${version} - not found, skipping`);
			continue;
		}

		// Create subdirectory for this version
		const versionLinkDir = join(pythonFirmwareDir, `ECHO MINI ${version}`);
		ensureDir(versionLinkDir);

		// Copy firmware file to Python-expected location
		const destPath = join(versionLinkDir, 'HIFIEC80.IMG');
		copyFileSync(firmwarePath, destPath);
		linkedCount++;
	}

	console.log(`  ✓ Linked ${linkedCount} firmware files for Python extraction`);
	console.log('=== Python environment ready ===\n');
}

function generatePythonReferences(): void {
	console.log('\n=== Generating Python Reference Files ===\n');

	const pythonScript = join(process.cwd(), 'references', 'extract_resource_smart.py');
	if (!existsSync(pythonScript)) {
		console.log(`  ⊘ Python script not found: ${pythonScript}`);
		return;
	}

	// Prepare environment first
	preparePythonEnvironment();

	// Run Python extractor from references directory
	// It will output to references/extracted_bitmaps_smart/batch_*/
	try {
		console.log('  Running Python extractor...');
		execSync(`python3 "${pythonScript}"`, {
			cwd: join(process.cwd(), 'references'),
			stdio: 'inherit'
		});
		console.log('  ✓ Generated reference files');
	} catch (error) {
		console.log(`  ✗ Failed: ${error}`);
		throw error;
	}

	// The Python script outputs to references/extracted_bitmaps_smart/batch_*
	// We need to move/copy this to the BASE_DOWNLOAD_DIR
	const pythonOutputBase = join(process.cwd(), 'references', 'extracted_bitmaps_smart');
	if (existsSync(pythonOutputBase)) {
		const targetBase = join(BASE_DOWNLOAD_DIR, 'extracted_bitmaps_smart');
		ensureDir(targetBase);

		// Copy all batch directories
		const batches = readdirSync(pythonOutputBase).filter((f) => f.startsWith('batch_'));
		for (const batch of batches) {
			const srcBatch = join(pythonOutputBase, batch);
			const destBatch = join(targetBase, batch);

			if (existsSync(destBatch)) {
				rmSync(destBatch, { recursive: true });
			}

			execSync(`cp -r "${srcBatch}" "${destBatch}"`);
			console.log(`  ✓ Copied ${batch}`);
		}

		// Create batch_auto symlinks
		createBatchAutoStructure();
	}

	console.log('\n=== Python reference generation complete ===\n');
}

function main() {
	const args = process.argv.slice(2);
	const skipDownload = args.includes('--skip-download');
	const skipPython = args.includes('--skip-python');

	if (skipDownload && skipPython) {
		console.log('Nothing to do (both --skip-download and --skip-python specified)');
		return;
	}

	try {
		// Create base directory
		ensureDir(BASE_DOWNLOAD_DIR);

		// Download and extract firmwares (unless skipped)
		if (!skipDownload) {
			downloadAllFirmwares();
		} else {
			console.log('\n⊘ Skipping firmware download (--skip-download specified)\n');
		}

		// Generate Python references (unless skipped)
		if (!skipPython) {
			generatePythonReferences();
		} else {
			console.log('\n⊘ Skipping Python reference generation (--skip-python specified)\n');
		}

		console.log('\n✅ Setup complete!');
		console.log(`\nFirmwares are in: ${BASE_DOWNLOAD_DIR}`);
		console.log(`Reference files are in: ${join(BASE_DOWNLOAD_DIR, 'extracted_bitmaps_smart', 'batch_auto')}\n`);
		console.log('To run tests:');
		console.log('  bun test src/lib/rse/__tests__/python-extraction-integration.test.ts');
	} catch (error) {
		console.error('\n❌ Setup failed:', error);
		process.exit(1);
	}
}

main();
