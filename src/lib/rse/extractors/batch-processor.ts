/**
 * Batch Processor - Process multiple firmware versions
 */

import type { BitmapExtractionResult, FontExtractionResult, BatchResult } from '../types/index.js';
import { ResourceExtractor } from './resource-extractor.js';
import { FirmwareAnalyzer } from './firmware-analyzer.js';
import { FontExtractor } from './font-extractor.js';
import type { UnicodeRange } from '../types/index.js';
import { parseUnicodeRanges } from '../utils/unicode-ranges.js';

/**
 * Firmware file descriptor
 */
export interface FirmwareFile {
	/** Version identifier */
	readonly version: string;
	/** Path to firmware file */
	readonly path: string;
}

/**
 * Batch processor options
 */
export interface BatchProcessorOptions {
	/** Output directory */
	readonly outputDir: string;
	/** Unicode ranges to extract (optional) */
	 readonly unicodeRanges?: readonly string[];
	 /** Debug mode */
	 readonly debug?: boolean;
	/**
	 * Optional firmware file list
	 * If not provided, files must be discovered using discoverFirmwareFiles
	 */
	readonly firmwareFiles?: readonly FirmwareFile[];
}

/**
 * Batch processor class
 */
export class BatchProcessor {
	private readonly outputDir: string;
	private readonly unicodeRanges: readonly UnicodeRange[];
	private readonly debug: boolean;
	private readonly _firmwareFiles: readonly FirmwareFile[] | null;

	constructor(options: BatchProcessorOptions) {
		this.outputDir = options.outputDir;
		this.unicodeRanges = options.unicodeRanges
			? parseUnicodeRanges([...options.unicodeRanges])
			: [];
		this.debug = options.debug ?? false;
		this._firmwareFiles = options.firmwareFiles ?? null;
	}

	/**
	 * Get firmware files
	 * @throws Error if firmware files were not provided
	 */
	getFirmwareFiles(): FirmwareFile[] {
		if (this._firmwareFiles) {
			return [...this._firmwareFiles];
		}
		throw new Error(
			'Firmware files not provided. Pass firmwareFiles option or override getFirmwareFiles()'
		);
	}

	/**
	 * Extract resources from all firmware versions
	 * @returns Array of extraction results
	 */
	extractAllResources(): BitmapExtractionResult[] {
		const firmwareFiles = this.getFirmwareFiles();

		console.log('='.repeat(80));
		console.log('Extracting bitmaps from all firmware versions');
		console.log('='.repeat(80));
		console.log(`Firmware count: ${firmwareFiles.length}`);
		console.log(`Output directory: ${this.outputDir}`);
		console.log('Start time:', new Date().toISOString());

		const results: BitmapExtractionResult[] = [];

		for (const { version, path: filePath } of firmwareFiles) {
			try {
				const extractor = new ResourceExtractor(filePath, filePath);
				const result = extractor.extractPart5BitmapsSmart(
					this.outputDir,
					version,
					this.debug
				);

				if (result) {
					results.push(result);
				}
			} catch (error) {
				console.log(`\n  Error: ${error}`);
				console.error(error);
			}
		}

		this.printResourceSummary(results);

		return results;
	}

	/**
	 * Print resource extraction summary
	 */
	private printResourceSummary(results: readonly BitmapExtractionResult[]): void {
		console.log(`\n${'='.repeat(80)}`);
		console.log('Summary Report');
		console.log('='.repeat(80));
		console.log(` ${'Version'.padEnd(20)} ${'Misalignment'.padStart(8)} ${'Total'.padStart(6)} ${'Success'.padStart(6)} ${'Errors'.padStart(6)}`);
		console.log('-'.repeat(80));

		// Count misalignment patterns
		const misalignmentCounts = new Map<number, number>();
		let totalSuccess = 0;

		for (const r of results) {
			const misalignment = r.misalignment;
			misalignmentCounts.set(misalignment, (misalignmentCounts.get(misalignment) ?? 0) + 1);

			console.log(
				` ${r.version.padEnd(20)} ${(misalignment >= 0 ? '+' : '') + misalignment.toString().padStart(7)}   ${r.total.toString().padStart(6)} ${r.success.toString().padStart(6)} ${r.error.toString().padStart(6)}`
			);
			totalSuccess += r.success;
		}

		console.log('-'.repeat(80));
		console.log(
			` ${'Total'.padEnd(20)} ${''.padStart(8)} ${results.reduce((sum, r) => sum + r.total, 0).toString().padStart(6)} ${totalSuccess.toString().padStart(6)} ${results.reduce((sum, r) => sum + r.error, 0).toString().padStart(6)}`
		);

		console.log(`\nMisalignment pattern statistics:`);
		for (const [misalignment, count] of Array.from(misalignmentCounts.entries()).sort(
			(a, b) => a[0] - b[0]
		)) {
			console.log(`  Misalignment ${misalignment >= 0 ? '+' : ''}${misalignment}: ${count} version(s)`);
		}

		console.log(`\nComplete! All bitmaps saved to: ${this.outputDir}`);
		console.log(`   Total extracted: ${totalSuccess} bitmap files`);
	}

	/**
	 * Extract fonts from all firmware versions
	 * @returns Array of batch results
	 */
	extractAllFonts(): BatchResult[] {
		const firmwareFiles = this.getFirmwareFiles();

		console.log('='.repeat(80));
		console.log('Extracting fonts from all firmware versions');
		console.log('='.repeat(80));
		console.log(`Found ${firmwareFiles.length} firmware versions`);
		console.log('='.repeat(80));
		console.log();

		const results: BatchResult[] = [];

		for (const { version, path: filePath } of firmwareFiles) {
			console.log(`\nProcessing: ${version}`);
			console.log(`  Firmware: ${filePath}`);

			const outputDir = `${this.outputDir}/${version}`;

			try {
				const analyzer = new FirmwareAnalyzer(filePath);
				const addresses = analyzer.detectAddresses();

				if (addresses === null) {
					console.log(`  Failed: Could not detect addresses`);
					results.push({
						version,
						status: '❌',
						small: 0,
						large: 0
					});
					continue;
				}

				const extractor = new FontExtractor(
					analyzer.getData(),
					addresses,
					this.unicodeRanges.length > 0 ? this.unicodeRanges : undefined
				);

				console.log(`  Output: ${outputDir}`);

				const result = extractor.extractAll(outputDir);

				console.log(`  Success: SMALL=${result.smallCount}, LARGE=${result.largeCount}`);
				results.push({
					version,
					status: '✅',
					small: result.smallCount,
					large: result.largeCount
				});
			} catch (error) {
				console.log(`  Failed: ${error}`);
				results.push({
					version,
					status: '❌',
					small: 0,
					large: 0
				});
			}
		}

		this.printFontSummary(results);

		return results;
	}

	/**
	 * Print font extraction summary
	 */
	private printFontSummary(results: readonly BatchResult[]): void {
		console.log();
		console.log('='.repeat(80));
		console.log('Batch extraction complete');
		console.log('='.repeat(80));
		console.log();
		console.log(` ${'Version'.padEnd(25)} ${'Status'.padStart(5)} ${'SMALL'.padStart(10)} ${'LARGE'.padStart(10)}`);
		console.log('-'.repeat(60));

		let totalSmall = 0;
		let totalLarge = 0;
		let successCount = 0;

		for (const r of results) {
			console.log(
				` ${r.version.padEnd(25)} ${r.status.padStart(5)} ${r.small.toString().padStart(10)} ${r.large.toString().padStart(10)}`
			);
			totalSmall += r.small;
			totalLarge += r.large;
			if (r.status === '✅') {
				successCount++;
			}
		}

		console.log('-'.repeat(60));
		console.log(`Total: ${successCount}/${results.length} successful`);
		console.log(`Total extracted: SMALL=${totalSmall}, LARGE=${totalLarge}`);
		console.log(`Output directory: ${this.outputDir}/`);
	}
}
