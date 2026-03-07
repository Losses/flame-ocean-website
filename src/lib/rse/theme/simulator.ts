/**
 * Control Flow Simulator
 *
 * Simulates execution of Thumb instructions to trace theme color values.
 */

import type { Instruction } from './thumb/index.js';
import { ThumbDecoder } from './thumb/index.js';
import { InstructionType } from './thumb/instructions.js';
import type { ColorWrite, MovwRecord } from './types.js';

/**
 * Control Flow Simulator Class
 */
export class ControlFlowSimulator {
	constructor(private readonly decoder: ThumbDecoder) {}

	/**
	 * Simulate function execution with a given theme value
	 */
	simulate(
		funcAddr: number,
		endAddr: number,
		themeValue: number,
		themeRegister: number = 0,
		debug = false
	): [Map<number, number>, ColorWrite[], MovwRecord[]] {
		const registers = new Map<number, number>();
		for (let i = 0; i < 16; i++) {
			registers.set(i, 0);
		}
		registers.set(themeRegister, themeValue);

		const registerSources = new Map<number, MovwRecord | null>();
		for (let i = 0; i < 16; i++) {
			registerSources.set(i, null);
		}

		const colorWrites: ColorWrite[] = [];
		const movwRecords: MovwRecord[] = [];
		let lastCmpResult = false;
		let itBlockRemaining = 0;
		const itConditions: boolean[] = [];
		let currentThemeCondition: number | null = null;
		let linkReg = 0; // LR (r14) for return address tracking
		let callDepth = 0; // Track if we're in a handler

		let addr = funcAddr;
		const maxSteps = 500;

		if (debug) console.error(`[SIM] Starting simulation at 0x${funcAddr.toString(16)}, endAddr=0x${endAddr.toString(16)}, theme=${themeValue}`);

		for (let step = 0; step < maxSteps;) {
			// Stop if we've exceeded endAddr AND we're not in a handler
			if (addr >= endAddr && callDepth === 0) {
				if (debug) console.error(`[SIM] Reached endAddr=0x${endAddr.toString(16)} at addr=0x${addr.toString(16)}, stopping`);
				break;
			}

			// Stop if we've gone outside valid firmware range
			const dataLen = this.decoder['getData']().length;
			if (addr >= dataLen || addr < 0) {
				if (debug) console.error(`[SIM] Address 0x${addr.toString(16)} is outside firmware range, stopping`);
				break;
			}

			const instr = this.decoder.decode(addr);
			const instrSize = instr.size;

			if (debug) {
				const handlerInfo = callDepth > 0 ? `[HANDLER d=${callDepth}] ` : '';
				console.error(`[SIM] ${handlerInfo}Step ${step}: addr=0x${addr.toString(16)}, instr=${instr.mnemonic} ${instr.operands}`);
			}
			// Handle IT block instructions
			if (itBlockRemaining > 0) {
				const condIdx = itConditions.length - itBlockRemaining;
				if (condIdx >= 0 && condIdx < itConditions.length && itConditions[condIdx]) {
					this.executeInstructionInItBlock(
						instr,
						addr,
						registers,
						registerSources,
						themeValue,
						currentThemeCondition,
						colorWrites,
						movwRecords
					);
				}

				itBlockRemaining--;
				addr += instrSize;
				step++;
				continue;
			}

			// Handle normal instructions
			const result = this.executeInstruction(
				instr,
				addr,
				registers,
				registerSources,
				themeValue,
				currentThemeCondition,
				colorWrites,
				movwRecords,
				lastCmpResult,
				itConditions,
				endAddr,
				instrSize,
				linkReg,
				callDepth,
				debug
			);

			// Update state from instruction execution
			if (result.newCmpResult !== null) {
				lastCmpResult = result.newCmpResult;
			}
			if (result.newItBlockRemaining !== null) {
				itBlockRemaining = result.newItBlockRemaining;
			}
			linkReg = result.newLinkReg;
			callDepth = result.newCallDepth;

			// Handle branch target
			if (result.branchTo !== null) {
				const oldAddr = addr;
				addr = result.branchTo;
				if (debug && (addr !== oldAddr + instrSize)) {
					console.error(`[SIM]   -> Jumping from 0x${oldAddr.toString(16)} to 0x${addr.toString(16)}`);
				}
			} else {
				addr += instrSize;
			}
			step++;
		}

		return [registers, colorWrites, movwRecords];
	}

	/**
	 * Execute an instruction
	 */
	private executeInstruction(
		instr: Instruction,
		addr: number,
		registers: Map<number, number>,
		registerSources: Map<number, MovwRecord | null>,
		themeValue: number,
		currentThemeCondition: number | null,
		colorWrites: ColorWrite[],
		movwRecords: MovwRecord[],
		lastCmpResult: boolean,
		itConditions: boolean[],
		endAddr: number,
		instrSize: number,
		linkReg: number,
		callDepth: number,
		debug = false
	): { newCmpResult: boolean | null; newItBlockRemaining: number | null; branchTo: number | null; newLinkReg: number; newCallDepth: number } {
		let newCmpResult: boolean | null = null;
		let newItBlockRemaining: number | null = null;
		let branchTo: number | null = null;
		let newLinkReg = linkReg;
		let newCallDepth = callDepth;

		switch (instr.instrType) {
			case InstructionType.PUSH:
				// Ignore
				break;

			case InstructionType.POP:
				// Ignore
				break;

			case InstructionType.BX:
				// Check if we're returning from a handler (BL call) or exiting main function
				if (callDepth > 0 && linkReg > 0) {
					// Return from handler - jump back to caller
					branchTo = linkReg;
					newCallDepth = callDepth - 1;
					newLinkReg = 0; // LR is consumed on return
				} else {
					// Exiting main function - stop simulation
					branchTo = endAddr + 1;
				}
				break;

			case InstructionType.MOVW:
				this.handleMovw(instr, addr, registers, registerSources, movwRecords, currentThemeCondition);
				break;

			case InstructionType.MOVT:
				// MOVT sets the upper 16 bits of the register
				// Combine with existing lower 16 bits from MOVW
				const currentVal = registers.get(instr.rd) ?? 0;
				const newVal = (currentVal & 0xffff) | (instr.imm & 0xffff0000);
				registers.set(instr.rd, newVal);
				break;

			case InstructionType.MOVS:
				registers.set(instr.rd, instr.imm);
				break;

			case InstructionType.CMP:
				if (instr.rn >= 0 && instr.rn < 16) {
					newCmpResult = (registers.get(instr.rn) ?? 0) === instr.imm;
				}
				break;

			case InstructionType.BEQ:
				// Branch if equal
				if (lastCmpResult) {
					branchTo = this.getBranchTarget(instr);
				}
				break;

			case InstructionType.BNE:
				// Branch if not equal
				if (!lastCmpResult) {
					branchTo = this.getBranchTarget(instr);
				}
				break;

			case InstructionType.B:
				// Unconditional branch
				branchTo = this.getBranchTarget(instr);
				break;

			case InstructionType.BL:
				// Branch with link - set LR to return address and follow the branch
				// Only follow BL if target is within valid firmware range
				const blTarget = this.getBranchTarget(instr);
				const dataLen = this.decoder['getData']().length;
				if (debug) console.error(`[SIM] BL at 0x${addr.toString(16)} -> 0x${blTarget.toString(16)}, LR=0x${(addr + instrSize).toString(16)}`);

				if (blTarget >= 0 && blTarget < dataLen) {
					// Valid target - follow the BL
					if (debug) console.error(`[SIM]   -> Following BL to handler at 0x${blTarget.toString(16)}`);
					newLinkReg = addr + instrSize;
					newCallDepth = callDepth + 1;
					branchTo = blTarget;
				} else {
					// Invalid target (library call) - skip BL and continue
					if (debug) console.error(`[SIM]   -> Skipping BL with invalid target, continuing`);
					branchTo = null; // Don't branch, just continue
				}
				break;

			case InstructionType.CBZ:
				// Compare and branch on zero
				if (instr.rn >= 0 && instr.rn < 16) {
					if ((registers.get(instr.rn) ?? 0) === 0) {
						branchTo = this.getBranchTarget(instr);
					}
				}
				break;

			case InstructionType.CBNZ:
				// Compare and branch on non-zero
				if (instr.rn >= 0 && instr.rn < 16) {
					if ((registers.get(instr.rn) ?? 0) !== 0) {
						branchTo = this.getBranchTarget(instr);
					}
				}
				break;

			case InstructionType.IT:
				newItBlockRemaining = this.setupItBlock(instr, lastCmpResult, itConditions);
				break;

			case InstructionType.LDR:
			case InstructionType.LDR_W:
				// CRITICAL: Simulate LDR alignment check
				// ARM Thumb-2 LDR uses (PC+4 & ~3) + offset. 
				// We must ensure the resulting target is word-aligned.
				const pc = (addr + 4) & ~3;
				const target = pc + instr.imm;
				if (target % 4 !== 0) {
					throw new Error(`[SIM] FATAL: Unaligned LDR access at 0x${addr.toString(16)} targets 0x${target.toString(16)}`);
				}
				// Load value from decoder's data as unsigned 32-bit
				const data = this.decoder['getData']();
				if (target + 4 <= data.length) {
					const val = (data[target] | (data[target+1] << 8) | (data[target+2] << 16) | (data[target+3] << 24)) >>> 0;
					registers.set(instr.rd, val);
				}
				break;

			case InstructionType.STRH:
			case InstructionType.STRH_W:
				this.handleStrh(instr, registers, themeValue, registerSources, colorWrites);
				break;
		}

		return { newCmpResult, newItBlockRemaining, branchTo, newLinkReg, newCallDepth };
	}

	/**
	 * Execute instruction inside IT block
	 */
	private executeInstructionInItBlock(
		instr: Instruction,
		addr: number,
		registers: Map<number, number>,
		registerSources: Map<number, MovwRecord | null>,
		themeValue: number,
		currentThemeCondition: number | null,
		colorWrites: ColorWrite[],
		movwRecords: MovwRecord[]
	): void {
		switch (instr.instrType) {
			case InstructionType.STRH:
			case InstructionType.STRH_W:
				this.handleStrh(instr, registers, themeValue, registerSources, colorWrites);
				break;

			case InstructionType.MOVW:
				this.handleMovw(instr, addr, registers, registerSources, movwRecords, currentThemeCondition);
				break;

			case InstructionType.MOVT:
				// MOVT sets the upper 16 bits of the register
				const currentVal = registers.get(instr.rd) ?? 0;
				const newVal = (currentVal & 0xffff) | (instr.imm & 0xffff0000);
				registers.set(instr.rd, newVal);
				break;

			case InstructionType.POP:
				// Check for POP {..., PC} which would return
				const hw = this.decoder['readU16'](addr);
				if (hw & 0x100) {
					// Would return - stop simulation for this function
				}
				break;

			case InstructionType.BX:
				// Would return - stop simulation
				break;
		}
	}

	/**
	 * Handle MOVW instruction
	 */
	private handleMovw(
		instr: Instruction,
		addr: number,
		registers: Map<number, number>,
		registerSources: Map<number, MovwRecord | null>,
		movwRecords: MovwRecord[],
		themeCondition: number | null
	): void {
		const record: MovwRecord = {
			addr,
			instr,
			colorValue: instr.imm,
			targetReg: instr.rd,
			themeCondition
		};

		movwRecords.push(record);
		registerSources.set(instr.rd, record);
		registers.set(instr.rd, instr.imm);
	}

	/**
	 * Handle STRH instruction
	 */
	private handleStrh(
		instr: Instruction,
		registers: Map<number, number>,
		themeValue: number,
		registerSources: Map<number, MovwRecord | null>,
		colorWrites: ColorWrite[]
	): void {
		const rt = instr.rd >= 0 ? instr.rd : 0;
		const rn = instr.rn >= 0 ? instr.rn : 0;
		const color = registers.get(rt) ?? 0;
		const movwInstr = registerSources.get(rt) ?? null;

		const write: ColorWrite = {
			addr: instr.addr,
			instr,
			colorValue: color & 0xFFFF,
			targetReg: rn,
			sourceReg: rt,
			themeCondition: themeValue,
			movwInstr
		};

		colorWrites.push(write);
	}

	/**
	 * Setup IT block
	 */
	private setupItBlock(
		instr: Instruction,
		cmpResult: boolean,
		itConditions: boolean[]
	): number {
		const mask = instr.itMask;
		const firstcond = instr.cond;

		const size = this.getItBlockSize(mask);
		itConditions.length = 0;

		const fcLsb = firstcond & 1;
		const condTrue = (firstcond === 0 && cmpResult) || (firstcond === 1 && !cmpResult);
		itConditions.push(condTrue);

		for (let i = 1; i < size; i++) {
			const bitPos = 4 - i;
			const maskBit = (mask >> bitPos) & 1;

			if (maskBit === fcLsb) {
				itConditions.push(condTrue);
			} else {
				itConditions.push(!condTrue);
			}
		}

		return size;
	}

	/**
	 * Get IT block size from mask
	 */
	private getItBlockSize(mask: number): number {
		if (mask === 0) return 0;
		if (mask & 0x1) return 4;
		if (mask & 0x2) return 3;
		if (mask & 0x4) return 2;
		return 1;
	}

	/**
	 * Calculate branch target address for branch instructions
	 */
	private getBranchTarget(instr: Instruction): number {
		// The decoder already calculates the absolute branch target
		return instr.branchTarget;
	}
}
