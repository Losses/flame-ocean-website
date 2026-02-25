/**
 * Theme Function Discovery
 *
 * Discovers theme-related functions in firmware by analyzing instruction patterns.
 * Ported from theme_extractor.py ThemeDiscovery class.
 */

import type { Instruction } from './thumb/index.js';
import { ThumbDecoder } from './thumb/index.js';
import type { ThemeFunction, FlacBehavior } from './types.js';
import { DiscoveryError } from './errors.js';
import { decodeBlTarget } from './thumb/encoders.js';

/**
 * Pattern matching results for function discovery
 */
interface PatternMatch {
	readonly addr: number;
	readonly confidence: number;
	readonly patternType: 'switch_case' | 'ite' | 'preload_store';
	readonly metadata: PatternMetadata;
}

interface PatternMetadata {
	readonly cmpCount?: number;
	readonly movwColors: readonly number[];
	readonly hasSeparator?: boolean;
	readonly register?: number;
}

/**
 * FLAC function signature bytes
 */
const FLAC_SIGNATURE = new Uint8Array([0x04, 0x29, 0x0c, 0xbf]); // CMP R1,#4 + ITE EQ
const MENU_SIGNATURE = new Uint8Array([0x4f, 0xf0, 0x00, 0x0c]); // MOV.W R12, #0

/**
 * Check if instruction at addr is a MOVW (32-bit Thumb instruction)
 * MOVW: first halfword starts with 11110 i 100100 (0xF2xx or 0xF6xx)
 */
function isMovwInstruction(data: Uint8Array, addr: number): boolean {
	if (addr + 4 > data.length) return false;
	const hw = data[addr] | (data[addr + 1] << 8);
	return (hw & 0xfb00) === 0xf200;
}

/**
 * Discover theme count by analyzing CMP patterns in firmware
 */
export function discoverThemeCount(data: Uint8Array): [number, string[]] {
	const decoder = new ThumbDecoder(data);
	const themeCountFreq = analyzeCmpPatterns(decoder, data);

	// Find the theme count with the highest frequency
	let bestEntry: [number, number] | null = null;
	for (const [k, v] of themeCountFreq.entries()) {
		if (k >= 5 && (!bestEntry || v > bestEntry[1])) {
			bestEntry = [k, v];
		}
	}

	if (bestEntry) {
		return [bestEntry[0], []];
	}

	// Fallback to checking for 4-theme support
	for (const [k, v] of themeCountFreq.entries()) {
		if (k >= 4 && (!bestEntry || v > bestEntry[1])) {
			bestEntry = [k, v];
		}
	}

	return bestEntry ? [bestEntry[0], []] : [5, ['Fallback - assuming 5 themes']];
}

/**
 * Analyze CMP patterns in firmware to determine theme count
 */
function analyzeCmpPatterns(decoder: ThumbDecoder, data: Uint8Array): Map<number, number> {
	const themeCountFreq = new Map<number, number>();
	const searchStart = 0x20000;
	const searchEnd = Math.min(0x150000, data.length);

	for (let addr = searchStart; addr < searchEnd; addr += 2) {
		const hw = decoder['readU16'](addr);
		if (hw === 0) continue;

		// Look for PUSH instructions as function boundaries
		const isPush = (hw & 0xff00) === 0xb500 || (hw & 0xffff0000) === 0x92d0000e;
		if (isPush) {
			const count = countThemeIndicesInFunction(decoder, addr);
			if (count > 0) {
				themeCountFreq.set(count, (themeCountFreq.get(count) ?? 0) + 1);
			}
		}
	}

	return themeCountFreq;
}

/**
 * Count theme indices in a function by analyzing CMP instructions
 */
function countThemeIndicesInFunction(decoder: ThumbDecoder, funcAddr: number): number {
	const themeIndices = new Set<number>();
	const maxScan = 500;

	for (let offset = 0; offset < maxScan;) {
		const hw = decoder['readU16'](funcAddr + offset);
		const is32bit = hw >= 0xe800;
		const instr = decoder.decode(funcAddr + offset);
		const mn = instr.mnemonic.toUpperCase();

		if (mn.includes('CMP')) {
			const imm = instr.imm;
			if (imm >= 0 && imm <= 15) {
				themeIndices.add(imm);
			}
		}

		offset += is32bit ? 4 : 2;
	}

	if (themeIndices.size === 0) return 0;

	// Find longest consecutive sequence
	let maxConsecutive = 0;
	const sortedIndices = Array.from(themeIndices).sort((a, b) => a - b);

	for (const start of sortedIndices) {
		let count = 0;
		for (let i = start; i <= Math.max(...themeIndices); i++) {
			if (themeIndices.has(i)) {
				count++;
			} else {
				break;
			}
		}
		if (count > maxConsecutive) {
			maxConsecutive = count;
		}
	}

	return maxConsecutive >= 2 ? maxConsecutive : 0;
}

/**
 * Theme Discovery Class
 */
export class ThemeDiscovery {
	constructor(private readonly decoder: ThumbDecoder) {}

	/**
	 * Detect FLAC function by searching for CMP+ITE pattern
	 */
	static detectFlacFunction(
		data: Uint8Array,
		searchStart = 0x80000,
		searchEnd = 0x100000
	): [number, number] | null {
		const actualEnd = Math.min(searchEnd, data.length - 4);

		for (let addr = searchStart; addr < actualEnd; addr += 2) {
			// Check for CMP R1,#4 pattern
			if (data[addr] === FLAC_SIGNATURE[0] &&
				data[addr + 1] === FLAC_SIGNATURE[1] &&
				data[addr + 2] === FLAC_SIGNATURE[2] &&
				data[addr + 3] === FLAC_SIGNATURE[3]) {
				return [addr, addr];
			}
		}

		return null;
	}

	/**
	 * Detect Menu function by searching for MOV.W R12,#0 pattern followed by MOVW instructions
	 *
	 * The theme menu function has the signature: MOV.W R12, #0 followed by MOVW instructions
	 * that load theme color addresses. We distinguish it from other functions by checking
	 * for the MOVW pattern.
	 */
	static detectMenuFunction(
		data: Uint8Array,
		searchStart = 0x30000,
		searchEnd = 0x50000
	): [number, number] | null {
		const actualEnd = Math.min(searchEnd, data.length - 20); // Need space for MOVW check

		for (let addr = searchStart; addr < actualEnd; addr += 2) {
			// Check for MOV.W R12, #0 pattern
			if (data[addr] === MENU_SIGNATURE[0] &&
				data[addr + 1] === MENU_SIGNATURE[1] &&
				data[addr + 2] === MENU_SIGNATURE[2] &&
				data[addr + 3] === MENU_SIGNATURE[3]) {
				// Check for MOVW instructions in the next few instructions
				let hasMovw = false;
				for (const checkOffset of [4, 6, 8, 10, 12]) {
					const checkAddr = addr + checkOffset;
					if (isMovwInstruction(data, checkAddr)) {
						hasMovw = true;
						break;
					}
				}

				if (hasMovw) {
					return [addr, addr];
				}
			}
		}

		return null;
	}

	/**
	 * Find function start by tracing back to PUSH instruction
	 */
	static findFunctionStart(data: Uint8Array, addr: number, maxBack = 200): number {
		for (let back = addr; back >= Math.max(0, addr - maxBack); back -= 2) {
			const hw = data[back] | (data[back + 1] << 8);

			// Check for PUSH patterns
			if ((hw & 0xfe00) === 0xb400 ||    // PUSH {Rlist}
			    (hw & 0xff00) === 0xb500 ||    // PUSH {Rlist, LR}
			    hw === 0xe92d) {                // STMDB SP!, {...}
				return back;
			}
		}

		return addr;
	}

	/**
	 * Find the first BL instruction in a function
	 * Searches forward from function start to find the first BL instruction
	 */
	static findFirstBlInFunction(data: Uint8Array, funcAddr: number, maxSearch = 2000): number | null {
		for (let offset = 0; offset < maxSearch; offset += 2) {
			const addr = funcAddr + offset;
			if (addr + 4 > data.length) break;

			if (isBlInstruction(data, addr)) {
				return addr;
			}

			// Check if instruction is 32-bit to skip correctly
			const hw = data[addr] | (data[addr + 1] << 8);
			const is32bit = hw >= 0xe800;
			if (is32bit) {
				offset += 2; // Skip extra 2 bytes for 32-bit instruction
			}
		}

		return null;
	}

	/**
	 * Detect FLAC function by analyzing behavior
	 */
	static detectFlacByContext(decoder: ThumbDecoder, funcAddr: number): FlacBehavior {
		const data = decoder.getData();

		// First check: Is this firmware patched with FLAC colors?
		// If there's a patch metadata in the NOP slide, use that instead of scanning
		const patches = discoverPatchesBySignature(data);
		if (patches && patches.flacBlAddr > 0) {
			// Firmware is patched - read colors from metadata
			// Find the metadata (it's at the end of the NOP slide, 51 bytes, starts with 'ECHO')
			const nopSlideAddr = patches.nopSlideAddr;
			const MAX_SEARCH = 1024;
			let metadataAddr = null;

			for (let searchAddr = nopSlideAddr; searchAddr < nopSlideAddr + MAX_SEARCH && searchAddr < data.length - 51; searchAddr++) {
				if (data[searchAddr] === 0x45 &&  // 'E'
					data[searchAddr + 1] === 0x43 &&  // 'C'
					data[searchAddr + 2] === 0x48 &&  // 'H'
					data[searchAddr + 3] === 0x4F) {  // 'O'
					metadataAddr = searchAddr;
					break;
				}
			}

			if (metadataAddr !== null) {
				// Found metadata - read FLAC colors
				// Metadata structure: magic(4) + version(4) + timestamp(4) + flacColors(5*4) + menuColors(15*4) + checksum(2)
				const flacColorsOffset = 12; // After magic + version + timestamp
				const colorFor4 = data[metadataAddr + flacColorsOffset + 3] | (data[metadataAddr + flacColorsOffset + 4] << 8);
				const colorForOther = data[metadataAddr + flacColorsOffset] | (data[metadataAddr + flacColorsOffset + 1] << 8);

				return {
					type: 'standard',
					isFlac: true,
					colorFor4: colorFor4,
					colorForOther: colorForOther,
					movwAddr4: '',
					movwInstr4: '',
					movwAddrOther: '',
					movwInstrOther: ''
				};
			}
		}

		// Not patched or metadata not found - fall back to scanning
		let foundSeparator = false;
		const scanRange = 1200;

		// Step 1: Search for '|' character operation (MOVS Rx, #0x7C = 124 '|')
		for (let offset = 0; offset < scanRange;) {
			const hw = decoder.readU16(funcAddr + offset);
			const is32bit = hw >= 0xe800;
			const instr = decoder.decode(funcAddr + offset);

			if (instr.mnemonic.toUpperCase() === 'MOVS' && instr.imm === 0x7c) {
				foundSeparator = true;
				break;
			}

			offset += is32bit ? 4 : 2;
		}

		if (!foundSeparator) {
			return {
				type: 'unknown',
				isFlac: false,
				colorFor4: 0,
				colorForOther: 0,
				movwAddr4: '',
				movwInstr4: '',
				movwAddrOther: '',
				movwInstrOther: ''
			};
		}

		// Step 2: Search for FLAC color pattern after separator
		for (let offset = 0; offset < scanRange;) {
			const hw = decoder.readU16(funcAddr + offset);
			const is32bit = hw >= 0xe800;
			const instr = decoder.decode(funcAddr + offset);

			// Look for CMP Rx, #4 followed by IT
			if (instr.mnemonic.toUpperCase().includes('CMP') && instr.imm === 4) {
				// Check for IT instruction next
				if (offset + 4 <= scanRange) {
					const nextHw = decoder.readU16(funcAddr + offset + (is32bit ? 4 : 2));
					if ((nextHw & 0xff00) === 0xbf00 && (nextHw & 0xf) !== 0) {
						// Found CMP + IT pattern - this is standard FLAC behavior
						return {
							type: 'standard',
							isFlac: false,
							colorFor4: 0,
							colorForOther: 0,
							movwAddr4: '',
							movwInstr4: '',
							movwAddrOther: '',
							movwInstrOther: ''
						};
					}
				}
			}

			offset += is32bit ? 4 : 2;
		}

		return {
			type: 'unknown',
			isFlac: false,
			colorFor4: 0,
			colorForOther: 0,
			movwAddr4: '',
			movwInstr4: '',
			movwAddrOther: '',
			movwInstrOther: ''
		};
	}

	/**
	 * Detect switch_case pattern functions (Progress Bar and Marquee)
	 *
	 * Scans for CMP R0, #0-4 sequences followed by MOVW color loads.
	 * Distinguishes Progress Bar (has STRH) from Marquee (no STRH).
	 */
	detectSwitchCasePatterns(data: Uint8Array, seenAddrs: Set<number>): ThemeFunction[] {
		const functions: ThemeFunction[] = [];
		const searchEnd = Math.min(0x100000, data.length);

		// Collect CMP R0, #0-9 candidates
		const cmpCandidates: Array<{ addr: number; imm: number }> = [];

		for (let addr = 0; addr < searchEnd; addr += 2) {
			const hw = data[addr] | (data[addr + 1] << 8);

			// 16-bit CMP R0, #imm8: Encoding 00101 Rn imm8 (bits[15:11] = 00101)
			if ((hw >> 11) === 0b00101) {
				const rd = (hw >> 8) & 0x7;
				const imm = hw & 0xff;
				if (rd === 0 && imm < 10) {
					cmpCandidates.push({ addr, imm });
				}
			}
			// 32-bit CMP.W R0, #imm: F1BC 0Fxx
			else if (hw === 0xF1BC) {
				const hw2 = data[addr + 2] | (data[addr + 3] << 8);
				if ((hw2 & 0xFF00) === 0x0F00) {
					const imm = hw2 & 0xFF;
					if (imm < 10) {
						cmpCandidates.push({ addr, imm });
					}
				}
			}
		}

		// Group consecutive CMPs (within 20 bytes)
		let i = 0;
		while (i < cmpCandidates.length) {
			const consecutive = [cmpCandidates[i]];
			let j = i + 1;

			while (j < cmpCandidates.length) {
				if (cmpCandidates[j].addr - consecutive[consecutive.length - 1].addr <= 20) {
					consecutive.push(cmpCandidates[j]);
					j++;
				} else {
					break;
				}
			}

			// Need at least 3 consecutive CMPs with different immediates
			if (consecutive.length >= 3) {
				const imms = new Set(consecutive.map(c => c.imm));
				if (imms.size >= 3) {
					// Detect the maximum theme ID from CMP immediates
					const maxThemeId = Math.max(...Array.from(imms));
					const funcStart = ThemeDiscovery.findFunctionStart(data, consecutive[0].addr);

					if (funcStart && !seenAddrs.has(funcStart)) {
						seenAddrs.add(funcStart);

						// Collect MOVW color values from function
						const cmpStart = consecutive[0].addr;
						const funcEnd = consecutive[consecutive.length - 1].addr + 100;
						const preloadColors: Record<number, number> = {};
						const preloadMovwRecords: Record<number, import('./types.js').MovwRecord> = {};

						let lastCmpIndex = -1;
						let lastCmpAddr = 0;
						let beqTargetForColor0 = 0;

						for (let addr = cmpStart; addr < funcEnd && addr + 4 <= data.length;) {
							const hw = data[addr] | (data[addr + 1] << 8);

							// Check for CMP.W R12, #imm (F1BC 0Fmm)
							if (hw === 0xF1BC) {
								const hw2_cmp = data[addr + 2] | (data[addr + 3] << 8);
								if ((hw2_cmp & 0xFF00) === 0x0F00) {
									const imm = hw2_cmp & 0xFF;
									if (imm >= 0 && imm <= maxThemeId) {
										lastCmpIndex = imm;
										lastCmpAddr = addr;
									}
								}
								addr += 4;
								continue;
							}

							// Check for BEQ instruction (D0xx - 16-bit conditional branch)
							if ((hw & 0xF000) === 0xD000 && lastCmpIndex === 0 && beqTargetForColor0 === 0) {
								const offsetByte = hw & 0xFF;
								const signedOffset = offsetByte < 128 ? offsetByte : offsetByte - 256;
								beqTargetForColor0 = addr + 4 + (signedOffset * 2);
							}

							// Check if this address is the BEQ target for color 0
							const isAtBeqTarget = addr === beqTargetForColor0 && beqTargetForColor0 > 0;

							// Check if we're close to the last CMP (for colors 1-4)
							const distFromCmp = addr - lastCmpAddr;
							const isNearCmp = distFromCmp > 0 && distFromCmp <= 15;

							// Check if MOVW (32-bit): (hw & 0xFBF0) == 0xF240
							if ((hw & 0xFBF0) === 0xF240 && (isNearCmp || isAtBeqTarget)) {
								const hw2 = data[addr + 2] | (data[addr + 3] << 8);
								const imm4 = hw & 0xF;  // imm4 is in bits [3:0]
								const iBit = (hw >> 10) & 1;
								const imm3 = (hw2 >> 12) & 0x7;
								const rd = (hw2 >> 8) & 0xF;
								const imm8 = hw2 & 0xFF;
								const imm16 = (imm4 << 12) | (iBit << 11) | (imm3 << 8) | imm8;

								// Only collect MOVW to R0 (color register)
								if (rd === 0) {
									// colorIdx should match the CMP immediate value, not the lastCmpIndex
									// When isAtBeqTarget is true, we're at the BEQ target for CMP #0, so use 0
									// Otherwise, the colorIdx is determined by which CMP we're processing
									const colorIdx = isAtBeqTarget ? 0 : lastCmpIndex;
									if (colorIdx >= 0 && colorIdx <= maxThemeId) {
										preloadColors[colorIdx] = imm16;
										// Decode the MOVW instruction for detailed tracking
										const instr = this.decoder.decode(addr);
										preloadMovwRecords[colorIdx] = {
											addr,
											instr,
											colorValue: imm16,
											targetReg: rd,
											themeCondition: null
										};
									}
								}
								addr += 4;
							} else {
								// Check if 32-bit instruction
								const is32bit = hw >= 0xe800;
								addr += is32bit ? 4 : 2;
							}
						}

						// Analyze behavior to determine UI element type
						const behavior = this.analyzeSwitchCaseBehavior(funcStart);

						// Distinguish Progress Bar vs Marquee by STRH presence
						let uiElement = 'Unknown UI Element';
						let funcType: 'progress' | 'marquee' | 'unknown' = 'unknown';

						if (behavior.cmpR12Count >= 5 && behavior.distinctColors === 5) {
							if (behavior.strhCount > 0) {
								uiElement = 'Progress Bar Background';
								funcType = 'progress';
							} else {
								uiElement = 'Marquee/Scrolling Text Overlay';
								funcType = 'marquee';
							}
						}

						functions.push({
							addr: funcStart,
							endAddr: funcEnd,
							patternType: 'switch_case',
							type: funcType,
							colorWrites: [],
							preloadColors,
							preloadMovwRecords,
							uiElement
						});
					}
				}
			}

			i = j > i + 1 ? j : i + 1;
		}

		return functions;
	}

	/**
	 * Analyze switch_case function behavior to distinguish Progress Bar from Marquee
	 */
	private analyzeSwitchCaseBehavior(funcAddr: number): {
		cmpR12Count: number;
		distinctColors: number;
		strhCount: number;
		colors: Set<number>;
	} {
		const scanRange = 200;
		const result = {
			cmpR12Count: 0,
			distinctColors: 0,
			strhCount: 0,
			colors: new Set<number>()
		};

		for (let offset = 0; offset < scanRange;) {
			const hw = this.decoder.readU16(funcAddr + offset);
			const is32bit = hw >= 0xe800;
			const instr = this.decoder.decode(funcAddr + offset);
			const mn = instr.mnemonic.toUpperCase();
			const ops = instr.operands;

			// Count CMP R12, #0-4
			if (mn.includes('CMP') && ops.includes('R12')) {
				const imm = instr.imm;
				if (imm >= 0 && imm <= 4) {
					result.cmpR12Count++;
				}
			}

			// Count MOVW R0 color values
			if (mn.includes('MOVW') && ops.includes('R0')) {
				const imm = instr.imm;
				if (imm !== undefined) {
					result.colors.add(imm);
				}
			}

			// Count STRH instructions
			if (mn.includes('STRH')) {
				result.strhCount++;
			}

			offset += is32bit ? 4 : 2;
		}

		result.distinctColors = result.colors.size;
		return result;
	}

	/**
	 * Find all theme functions in firmware
	 */
	scanFirmware(maxScanSize = 0x100000): ThemeFunction[] {
		const data = this.decoder.getData();
		const functions: ThemeFunction[] = [];
		const seenAddrs = new Set<number>();

		// Search for FLAC function using improved discovery (supports patched firmware)
		const flacResult = discoverFlacFunction(data);
		if (flacResult) {
			const [funcAddr] = flacResult;
			const funcStart = ThemeDiscovery.findFunctionStart(data, funcAddr);
			if (!seenAddrs.has(funcStart)) {
				seenAddrs.add(funcStart);
				const funcEnd = this.findFunctionEnd(funcStart, 2000);
				const flacBehavior = ThemeDiscovery.detectFlacByContext(this.decoder, funcStart);

				functions.push({
					addr: funcStart,
					endAddr: funcEnd,
					patternType: 'ite',
					type: 'flac',
					colorWrites: [],
					preloadColors: {},
					preloadMovwRecords: {},
					uiElement: flacBehavior.type !== 'unknown' ? 'FLAC String Text' : 'Unknown UI Element',
					themeRegister: 1 // FLAC uses R1 for theme value
				});
			}
		}

		// Search for Menu function using improved discovery (supports patched firmware)
		const menuResult = discoverMenuFunction(data);
		if (menuResult) {
			const [funcAddr] = menuResult;
			const funcStart = ThemeDiscovery.findFunctionStart(data, funcAddr);
			if (!seenAddrs.has(funcStart)) {
				seenAddrs.add(funcStart);
				const funcEnd = this.findFunctionEnd(funcStart, 2000);

				functions.push({
					addr: funcStart,
					endAddr: funcEnd,
					patternType: 'preload_store',
					type: 'menu',
					colorWrites: [],
					preloadColors: {},
					preloadMovwRecords: {},
					uiElement: 'Menu Text Colors'
				});
			}
		}

		// Search for switch_case pattern functions (Progress Bar and Marquee)
		const switchCaseFunctions = this.detectSwitchCasePatterns(data, seenAddrs);
		for (const func of switchCaseFunctions) {
			functions.push(func);
		}

		return functions;
	}

	/**
	 * Find function end by searching for POP + BX LR sequence
	 *
	 * For patched functions, BL instructions can be far from function start,
	 * so we need to search a larger range.
	 */
	private findFunctionEnd(addr: number, maxSearch = 2000): number {
		const data = this.decoder.getData();
		const searchEnd = Math.min(addr + maxSearch, data.length);
		let itBlockRemaining = 0;
		let lastPopBxAddr = 0;

		while (addr < searchEnd) {
			const hw = this.decoder.readU16(addr);
			const is32bit = hw >= 0xe800;
			const instrSize = is32bit ? 4 : 2;

			// Handle IT block
			if (itBlockRemaining > 0) {
				itBlockRemaining--;
				addr += instrSize;
				continue;
			}

			// Check IT instruction
			if ((hw & 0xff00) === 0xbf00) {
				const mask = hw & 0xf;
				if (mask !== 0) {
					// Calculate IT block size from mask
					if (mask & 0x1) itBlockRemaining = 4;
					else if (mask & 0x2) itBlockRemaining = 3;
					else if (mask & 0x4) itBlockRemaining = 2;
					else itBlockRemaining = 1;
				}
				addr += instrSize;
				continue;
			}

			// Check POP + BX LR sequence
			if ((hw & 0xff00) === 0xbc00) {
				const nextAddr = addr + 2;
				if (nextAddr + 2 <= data.length) {
					const nextHw = this.decoder.readU16(nextAddr);
					if (nextHw === 0x4770) {
						lastPopBxAddr = nextAddr + 2;
					}
				}
			}

			addr += instrSize;
		}

		return lastPopBxAddr > 0 ? lastPopBxAddr : addr;
	}

	/**
	 * Check if instruction at address is 32-bit
	 */
	private is32BitInstruction(addr: number): boolean {
		if (addr + 2 > this.decoder['getData']().length) return false;
		const hw = this.decoder['readU16'](addr);
		return (hw & 0xf800) === 0xe800 || (hw & 0xf800) === 0xf000 || (hw & 0xf800) === 0xf800;
	}
}

/**
 * Check if data at address is a BL instruction
 */
function isBlInstruction(data: Uint8Array, addr: number): boolean {
	if (addr + 4 > data.length) return false;
	const hw1 = data[addr] | (data[addr + 1] << 8);
	const hw2 = data[addr + 2] | (data[addr + 3] << 8);
	return (hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000;
}

/**
 * Discover FLAC function using default parameters
 *
 * First tries signature-based detection for patched firmware, then falls back to
 * CMP+ITE pattern search for unpatched firmware.
 */
export function discoverFlacFunction(data: Uint8Array, version?: string): [number, number] | null {
	// Try signature-based detection first (for patched firmware)
	const patches = discoverPatchesBySignature(data);
	if (patches && patches.flacBlAddr > 0) {
		// FLAC function is patched
		// Find the CMP+ITE pattern by searching backwards from the BL instruction
		// The FLAC function doesn't necessarily start with PUSH, so we look for the CMP pattern
		const cmpAddrResult = ThemeDiscovery.detectFlacFunction(data);
		if (cmpAddrResult) {
			const [cmpAddr] = cmpAddrResult;
			// Verify the CMP is before the BL and within reasonable distance
			if (cmpAddr < patches.flacBlAddr && (patches.flacBlAddr - cmpAddr) < 500) {
				return [cmpAddr, patches.flacBlAddr];
			}
		}
		// Fallback: use findFunctionStart to find PUSH instruction
		const funcAddr = ThemeDiscovery.findFunctionStart(data, patches.flacBlAddr, 2000);
		return [funcAddr, patches.flacBlAddr];
	}

	// Fall back to CMP+ITE pattern search (for unpatched or partially patched firmware)
	const cmpAddrResult = ThemeDiscovery.detectFlacFunction(data);
	if (cmpAddrResult) {
		const [funcAddr] = cmpAddrResult;
		// Find the FIRST BL instruction in the function to use as patch address
		const firstBlAddr = ThemeDiscovery.findFirstBlInFunction(data, funcAddr, 2000);
		if (firstBlAddr) {
			return [funcAddr, firstBlAddr];
		}
		// If no BL found, fall back to using the CMP address
		return [funcAddr, funcAddr];
	}

	return null;
}

/**
 * Discover Menu function using default parameters
 *
 * First tries signature-based detection for patched firmware, then falls back to
 * MOV.W pattern search for unpatched firmware.
 */
export function discoverMenuFunction(data: Uint8Array, version?: string): [number, number] | null {
	// Try signature-based detection first (for patched firmware)
	const patches = discoverPatchesBySignature(data);
	if (patches && patches.menuBlAddr > 0) {
		// Menu function is patched
		// Find the MOV.W pattern by searching backwards from the BL instruction
		// The Menu function doesn't necessarily start with PUSH, so we look for the MOV.W pattern
		const movAddrResult = ThemeDiscovery.detectMenuFunction(data);
		if (movAddrResult) {
			const [movAddr] = movAddrResult;
			// Verify the MOV.W is before the BL and within reasonable distance
			if (movAddr < patches.menuBlAddr && (patches.menuBlAddr - movAddr) < 500) {
				return [movAddr, patches.menuBlAddr];
			}
		}
		// Fallback: use findFunctionStart to find PUSH instruction
		const funcAddr = ThemeDiscovery.findFunctionStart(data, patches.menuBlAddr, 2000);
		return [funcAddr, patches.menuBlAddr];
	}

	// Fall back to MOV.W pattern search (for unpatched or partially patched firmware)
	const movAddrResult = ThemeDiscovery.detectMenuFunction(data);
	if (movAddrResult) {
		const [funcAddr] = movAddrResult;
		// Find the FIRST BL instruction in the function to use as patch address
		const firstBlAddr = ThemeDiscovery.findFirstBlInFunction(data, funcAddr, 2000);
		if (firstBlAddr) {
			return [funcAddr, firstBlAddr];
		}
		// If no BL found, fall back to using the MOV.W address
		return [funcAddr, funcAddr];
	}

	return null;
}

/**
 * Find function start using default parameters
 */
export function findFunctionStart(data: Uint8Array, addr: number): number {
	return ThemeDiscovery.findFunctionStart(data, addr);
}

/**
 * Check if code at addr has the signature of our generated patch code.
 *
 * Our patch code has distinctive MOVW/MOVT instruction pairs in sequence.
 * Normal firmware code rarely has this pattern.
 */
function isPatchCodeSignature(data: Uint8Array, addr: number): boolean {
	if (addr + 64 > data.length) return false;

	// Count MOVW/MOVT pairs (MOVW followed by MOVT for same register)
	let pairCount = 0;

	// Iterate by 4 bytes since MOVW/MOVT are 32-bit instructions
	for (let i = addr; i < Math.min(addr + 64, data.length - 7); i += 4) {
		const hw1 = data[i] | (data[i + 1] << 8);
		const hw2 = data[i + 2] | (data[i + 3] << 8);

		// Check if first instruction is MOVW
		if ((hw1 & 0xf800) === 0xf000) {
			const opcode1 = (hw1 >> 4) & 0xf;
			if (opcode1 === 0x4) {  // MOVW
				const rd1 = (hw2 >> 8) & 0xf;

				// Check if next instruction is MOVT for same register
				const hw1Next = data[i + 4] | (data[i + 5] << 8);
				const hw2Next = data[i + 6] | (data[i + 7] << 8);

				if ((hw1Next & 0xf800) === 0xf000) {
					const opcode2 = (hw1Next >> 4) & 0xf;
					if (opcode2 === 0xc) {  // MOVT
						const rd2 = (hw2Next >> 8) & 0xf;
						if (rd1 === rd2) {  // Same register = MOVW/MOVT pair
							pairCount++;
						}
					}
				}
			}
		}
	}

	// Our patch code has 3+ MOVW/MOVT pairs in first 64 bytes
	// FLAC handler has 5 pairs (5 colors), Menu handler has 8+ pairs (15 colors)
	return pairCount >= 3;
}

/**
 * Discover patches by searching for BL instructions that branch to our patch code.
 *
 * Returns both the BL addresses and the NOP slide address if found.
 */
export function discoverPatchesBySignature(data: Uint8Array): {
	flacBlAddr: number;
	menuBlAddr: number;
	nopSlideAddr: number;
} | null {
	const blInstructions: Array<{ blAddr: number; target: number }> = [];

	// Find all BL instructions
	for (let i = 0; i < data.length - 4; i += 2) {
		const hw1 = data[i] | (data[i + 1] << 8);
		const hw2 = data[i + 2] | (data[i + 3] << 8);

		if ((hw1 & 0xf800) === 0xf000 && (hw2 & 0xd000) === 0xd000) {
			const blBytes = data.slice(i, i + 4);
			const target = decodeBlTarget(i, blBytes);
			if (target >= 0 && target < data.length) {
				// Check if target has our patch code signature
				// Try a few offsets in case there's padding before the MOVW instructions
				let found = false;
				for (const offset of [0, 2, 4, 6, 8]) {
					if (isPatchCodeSignature(data, target + offset)) {
						blInstructions.push({ blAddr: i, target: target + offset });
						found = true;
						break;
					}
				}
			}
		}
	}

	// Handle partial patching (FLAC-only or Menu-only) and full patching
	if (blInstructions.length === 0) {
		// No patches found
		return null;
	}

	// Sort by target address (FLAC handler is usually first)
	blInstructions.sort((a, b) => a.target - b.target);

	const nopSlide = blInstructions[0].target;
	let flacBl = 0;
	let menuBl = 0;

	if (blInstructions.length === 1) {
		// Partial patch: determine if it's FLAC or Menu by BL address range
	// FLAC functions are typically in 0x80000-0x90000 range
		// Menu functions are typically in 0x3F000-0x40000 range
		const blAddr = blInstructions[0].blAddr;

		if (blAddr >= 0x80000 && blAddr < 0x90000) {
			flacBl = blAddr;  // FLAC function
		} else if (blAddr >= 0x3F000 && blAddr < 0x41000) {
			menuBl = blAddr;  // Menu function
		} else {
			// Unknown range, fall back to target offset check
			const handlerOffset = blInstructions[0].target - nopSlide;
			if (handlerOffset < 100) {
				flacBl = blAddr;  // Likely FLAC handler at start
			} else {
				menuBl = blAddr;  // Likely Menu handler after FLAC
			}
		}
	} else {
		// Two or more BLs: identify by BL address range
		for (const { blAddr, target } of blInstructions) {
			if (blAddr >= 0x80000 && blAddr < 0x90000) {
				flacBl = blAddr;  // FLAC function
			} else if (blAddr >= 0x3F000 && blAddr < 0x41000) {
				menuBl = blAddr;  // Menu function
			}
		}

		// If not found by address range, fall back to target order
		if (flacBl === 0 && blInstructions.length >= 1) {
			flacBl = blInstructions[0].blAddr;
		}
		if (menuBl === 0 && blInstructions.length >= 2) {
			menuBl = blInstructions[1].blAddr;
		}
	}

	return { flacBlAddr: flacBl, menuBlAddr: menuBl, nopSlideAddr: nopSlide };
}
