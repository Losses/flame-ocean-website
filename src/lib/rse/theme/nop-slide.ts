/**
 * NOP Slide Finder
 *
 * Finds unused regions in firmware that can be used for patch code.
 *
 * HYBRID APPROACH:
 * 1. Uses heuristics for selection (to match Python behavior)
 * 2. Uses CODE REFERENCE ANALYSIS for safety verification
 * 3. Generates protective jumps for functional NOP slides
 *
 * SAFETY VERIFICATION:
 * - Scans branch instructions to identify NOP slide landing points
 * - Verifies selected slides have zero code references
 * - Rejects functional NOP slides (execution flow mechanism)
 * - Provides data-driven safety instead of pure heuristics
 */

import type { NopSlide } from './types.js';
import { CodeReferenceAnalyzer } from './code-reference-analyzer.js';

/** Functional NOP slide region - EXECUTION FLOW MECHANISM, DO NOT USE! */
const FUNCTIONAL_NOP_START = 0x588A8;
const FUNCTIONAL_NOP_END = 0x79B70;

/** Maximum size for a region to be considered a NOP slide (larger = likely font storage) */
const MAX_SAFE_SLIDE_SIZE = 65536; // 64KB

/**
 * NOP Slide Finder Class
 *
 * Hybrid approach: heuristics for selection (Python compatibility),
 * code reference analysis for safety verification.
 */
export class NopSlideFinder {
	private readonly data: Readonly<Uint8Array>;
	private readonly codeAnalyzer: CodeReferenceAnalyzer;
	private readonly MIN_SLIDE_SIZE = 256;  // Minimum 256 bytes for safety (alignment + metadata)
	private readonly scanStart: number;
	private readonly scanEnd: number;

	constructor(firmwareData: Uint8Array, options: { scanStart?: number; scanEnd?: number } = {}) {
		this.data = firmwareData;
		this.scanStart = options.scanStart ?? 0;
		this.scanEnd = options.scanEnd ?? firmwareData.length;
		
		this.codeAnalyzer = new CodeReferenceAnalyzer(firmwareData, {
			scanStart: this.scanStart,
			scanEnd: Math.min(this.scanEnd, 0x1000000), // Code analyzer scan limit
			analyzeOnConstruct: false
		});
	}

	/**
	 * Check if a region overlaps with the functional NOP slide
	 */
	private overlapsFunctionalNopSlide(start: number, end: number): boolean {
		return !(end <= FUNCTIONAL_NOP_START || start >= FUNCTIONAL_NOP_END);
	}

	/**
	 * Check if a region is safe to use as a NOP slide
	 */
	private isSafeNopSlide(start: number, size: number): boolean {
		// CRITICAL: Must not overlap functional NOP slide
		if (this.overlapsFunctionalNopSlide(start, start + size)) {
			return false;
		}

		// Reject very large regions (likely font data storage)
		if (size > MAX_SAFE_SLIDE_SIZE) {
			return false;
		}

		return true;
	}

	/**
	 * Find all NOP slide regions using heuristic scan
	 * Returns slides sorted by size (largest first)
	 */
	findAllSlides(): NopSlide[] {
		const slides: NopSlide[] = [];
		let i = this.scanStart;
		const n = Math.min(this.data.length, this.scanEnd);

		while (i < n) {
			// Look for zero bytes
			if (this.data[i] === 0x00) {
				const start = i;

				// Count consecutive zeros
				while (i < n && this.data[i] === 0x00) {
					i++;
				}

				const size = i - start;

				// Apply safety checks
				if (size >= this.MIN_SLIDE_SIZE && this.isSafeNopSlide(start, size)) {
					slides.push({
						start,
						end: i,
						size,
						source: 'dynamic',
						isActive: false,
						referenceCount: 0
					});
				}
			} else {
				i++;
			}
		}

		// Sort by size descending (largest first)
		return slides.sort((a, b) => b.size - a.size);
	}

	/**
	 * Select best NOP slide for patching using heuristics (Python-compatible)
	 * Then verify with code reference analysis for safety
	 *
	 * @param funcAddrs - Addresses of functions that will link to this slide
	 * @param requiredSize - Minimum size needed
	 */
	selectBestSlide(funcAddrs: number[], requiredSize: number): NopSlide | null {
		const slides = this.findAllSlides();
		const candidates: Array<{
			slide: NopSlide;
			utilization: number;
			maxDistance: number;
		}> = [];

		for (const slide of slides) {
			// Enforce 4-byte alignment for BL targets (ARM Thumb2 requirement)
			const alignedStart = (slide.start + 3) & ~3;
			const adjustedSize = slide.end - alignedStart;

			if (adjustedSize < requiredSize) continue;

			// Check distance to theme functions
			const distances = funcAddrs.map((f) => Math.abs(alignedStart - f));
			const maxDistance = distances.length > 0 ? Math.max(...distances) : 0;

			// Must be within BL range (±16MB)
			if (maxDistance > 16777216) continue;

			candidates.push({
				slide: {
					...slide,
					start: alignedStart,
					end: alignedStart + requiredSize,
					size: requiredSize,
					source: 'selected'
				},
				utilization: requiredSize / adjustedSize,
				maxDistance
			});
		}

		if (candidates.length === 0) return null;

		// Sort by: closest to 100% utilization, then by distance
		candidates.sort((a, b) => {
			const utilDiff = Math.abs(1 - a.utilization) - Math.abs(1 - b.utilization);
			if (utilDiff !== 0) return utilDiff;
			return a.maxDistance - b.maxDistance;
		});

		// Get best candidate from heuristics
		const bestCandidate = candidates[0].slide;

		// SAFETY VERIFICATION: Use code reference analysis to verify safety
		// This ensures we're not using a functional NOP slide
		try {
			const analysis = this.codeAnalyzer.analyze();

			// Check if the selected slide has any code references
			const hasReferences = analysis.landingPoints.some(
				lp => lp.inNopSlide &&
					lp.nopSlideStart === bestCandidate.start &&
					lp.referenceCount > 0
			);

			if (hasReferences) {
				// Selected slide has code references - try to find a safer one
				const safeCandidate = candidates.find(c => {
					const slideRef = analysis.landingPoints.some(
						lp => lp.inNopSlide &&
							lp.nopSlideStart === c.slide.start &&
							lp.referenceCount > 0
					);
					return !slideRef;
				});

				if (safeCandidate) {
					return safeCandidate.slide;
				}

				// No safe candidate found - return null instead of risking functional NOP slide
				console.warn(`Best NOP slide at 0x${bestCandidate.start.toString(16)} has code references`);
				return null;
			}
		} catch (error) {
			// Code reference analysis failed - proceed with caution
			console.warn('Code reference analysis failed, using heuristic selection:', error);
		}

		return bestCandidate;
	}

	/**
	 * Find NOP slides near a specific address
	 */
	findSlidesNearAddress(targetAddr: number, searchRange = 0x10000): NopSlide[] {
		const start = Math.max(0, targetAddr - searchRange);
		const end = Math.min(this.data.length, targetAddr + searchRange);

		const slides: NopSlide[] = [];
		let i = start;

		while (i < end) {
			if (this.data[i] === 0x00) {
				const slideStart = i;

				while (i < end && this.data[i] === 0x00) {
					i++;
				}

				const size = i - slideStart;
				if (size >= this.MIN_SLIDE_SIZE) {
					slides.push({
						start: slideStart,
						end: i,
						size,
						source: 'near',
						isActive: false,
						referenceCount: 0
					});
				}
			} else {
				i++;
			}
		}

		return slides.sort((a, b) => b.size - a.size);
	}

	/**
	 * Verify a NOP slide is actually all zeros
	 */
	verifySlide(slide: NopSlide): boolean {
		if (slide.end > this.data.length) return false;

		for (let i = slide.start; i < slide.end; i++) {
			if (this.data[i] !== 0x00) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Calculate distance from NOP slide to target addresses
	 */
	calculateDistances(slide: NopSlide, targets: number[]): Map<number, number> {
		const distances = new Map<number, number>();

		for (const target of targets) {
			const dist = Math.abs(slide.start - target);
			distances.set(target, dist);
		}

		return distances;
	}

	/**
	 * Get detailed code reference analysis results
	 * Performs full analysis (can be slow)
	 */
	getDetailedAnalysis() {
		return this.codeAnalyzer.analyze();
	}

	/**
	 * Generate protection code for functional NOP slide
	 * Returns B instruction bytes that jump over injected code
	 */
	generateProtectionCode(fromAddr: number, toAddr: number): Uint8Array {
		return this.codeAnalyzer.generateProtectionCode(fromAddr, toAddr);
	}
}
