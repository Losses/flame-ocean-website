/**
 * ARM Thumb Instruction Decoder
 *
 * Decodes ARM Thumb-1 and Thumb-2 instructions from firmware binary data.
 * Supports both 16-bit and 32-bit instruction formats.
 */

import type { Instruction } from './instructions.js';
import { InstructionType, createInstruction } from './instructions.js';

/**
 * Binary data reader for firmware
 */
export class BinaryReader {
	constructor(private readonly data: Uint8Array) {}

	/**
	 * Read 16-bit value at offset (little-endian)
	 */
	readU16(offset: number): number {
		if (offset + 2 > this.data.length) {
			return 0;
		}
		return this.data[offset] | (this.data[offset + 1] << 8);
	}

	/**
	 * Read 32-bit value at offset (little-endian)
	 */
	readU32(offset: number): number {
		if (offset + 4 > this.data.length) {
			return 0;
		}
		return (
			this.data[offset] |
			(this.data[offset + 1] << 8) |
			(this.data[offset + 2] << 16) |
			(this.data[offset + 3] << 24)
		);
	}

	/**
	 * Get a slice of data
	 */
	slice(offset: number, length: number): Uint8Array {
		return this.data.slice(offset, offset + length);
	}

	/**
	 * Get data length
	 */
	get length(): number {
		return this.data.length;
	}

	/**
	 * Get underlying data
	 */
	getData(): Uint8Array {
		return this.data;
	}
}

/**
 * Thumb Instruction Decoder Class
 */
export class ThumbDecoder {
	private readonly reader: BinaryReader;

	constructor(data: Uint8Array) {
		this.reader = new BinaryReader(data);
	}

	/**
	 * Decode instruction at specified address
	 */
	decode(addr: number): Instruction {
		if (addr + 2 > this.reader.length) {
			return this.createUnknown(addr, new Uint8Array([0, 0]));
		}

		const hw = this.reader.readU16(addr);

		// Check if 32-bit instruction
		if (this.is32Bit(hw)) {
			if (addr + 4 > this.reader.length) {
				return this.createUnknown(addr, new Uint8Array([hw & 0xff, hw >> 8]));
			}
			const hw2 = this.reader.readU16(addr + 2);
			return this.decode32Bit(addr, hw, hw2);
		} else {
			return this.decode16Bit(addr, hw);
		}
	}

	/**
	 * Check if instruction is 32-bit
	 * DDI0403 A5.1: bits[15:11] of 0b11101, 0b11110, or 0b11111
	 */
	private is32Bit(hw: number): boolean {
		return (hw & 0xf800) === 0xe800 || (hw & 0xf800) === 0xf000 || (hw & 0xf800) === 0xf800;
	}

	/**
	 * Create unknown instruction
	 */
	private createUnknown(addr: number, raw: Uint8Array): Instruction {
		return createInstruction(addr, raw, '???', '', InstructionType.UNKNOWN);
	}

	/**
	 * Decode 16-bit Thumb instruction
	 */
	private decode16Bit(addr: number, hw: number): Instruction {
		const raw = new Uint8Array([hw & 0xff, hw >> 8]);

		// Determine opcode group from bits [15:11]
		const op = hw >> 11;

		// Decode based on opcode groups
		if (op === 0b00000) return this.decodeLslImm(addr, hw, raw);
		if (op === 0b00001) return this.decodeLsrImm(addr, hw, raw);
		if (op === 0b00010) return this.decodeAsrImm(addr, hw, raw);
		if (op === 0b00011) return this.decodeAddSub(addr, hw, raw);
		if (op === 0b00100) return this.decodeMovImm(addr, hw, raw);
		if (op === 0b00101) return this.decodeCmpImm(addr, hw, raw);
		if (op === 0b00110) return this.decodeAdd8Imm(addr, hw, raw);
		if (op === 0b00111) return this.decodeSub8Imm(addr, hw, raw);

		if ((hw >> 10) === 0b010000) return this.decodeDataProc(addr, hw, raw);
		if ((hw >> 10) === 0b010001) return this.decodeSpecialProc(addr, hw, raw);
		if (op === 0b01001) return this.decodeLdrLit(addr, hw, raw);
		if ((hw >> 12) === 0b0101) return this.decodeLdstReg(addr, hw, raw);
		if ((hw >> 13) === 0b011) return this.decodeLdstWord(addr, hw, raw);
		if ((hw >> 12) === 0b1000) return this.decodeLdstHalf(addr, hw, raw);
		if ((hw >> 12) === 0b1001) return this.decodeLdstSp(addr, hw, raw);
		if ((hw >> 12) === 0b1010) return this.decodeLoadAddr(addr, hw, raw);
		if ((hw >> 12) === 0b1011) return this.decodeMisc(addr, hw, raw);
		if ((hw >> 12) === 0b1100) return this.decodeLdmStm(addr, hw, raw);
		if ((hw >> 12) === 0b1101) return this.decodeCondBranch(addr, hw, raw);
		if ((hw >> 11) === 0b11100) return this.decodeUncondBranch(addr, hw, raw);

		return this.createUnknown(addr, raw);
	}

	// ===== Shift Instructions =====

	private decodeLslImm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const imm5 = (hw >> 6) & 0x1f;
		const rm = (hw >> 3) & 0x7;
		const rd = hw & 0x7;
		return createInstruction(
			addr, raw, 'LSLS', `R${rd}, R${rm}, #${imm5}`,
			InstructionType.LSL, { rd, rm, imm: imm5 }
		);
	}

	private decodeLsrImm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const imm5 = (hw >> 6) & 0x1f;
		const rm = (hw >> 3) & 0x7;
		const rd = hw & 0x7;
		return createInstruction(
			addr, raw, 'LSRS', `R${rd}, R${rm}, #${imm5}`,
			InstructionType.LSR, { rd, rm, imm: imm5 }
		);
	}

	private decodeAsrImm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const imm5 = (hw >> 6) & 0x1f;
		const rm = (hw >> 3) & 0x7;
		const rd = hw & 0x7;
		return createInstruction(
			addr, raw, 'ASRS', `R${rd}, R${rm}, #${imm5}`,
			InstructionType.ASR, { rd, rm, imm: imm5 }
		);
	}

	// ===== Add/Subtract Instructions =====

	private decodeAddSub(addr: number, hw: number, raw: Uint8Array): Instruction {
		const op = (hw >> 9) & 0x3;
		const imm3 = (hw >> 6) & 0x7;
		const rn = (hw >> 3) & 0x7;
		const rd = hw & 0x7;

		if (op === 0) {
			// ADD register
			return createInstruction(
				addr, raw, 'ADDS', `R${rd}, R${rn}, R${imm3}`,
				InstructionType.ADD, { rd, rn, rm: imm3 }
			);
		} else if (op === 1) {
			// SUB register
			return createInstruction(
				addr, raw, 'SUBS', `R${rd}, R${rn}, R${imm3}`,
				InstructionType.SUB, { rd, rn, rm: imm3 }
			);
		} else if (op === 2) {
			// ADD 3-bit immediate
			return createInstruction(
				addr, raw, 'ADDS', `R${rd}, R${rn}, #${imm3}`,
				InstructionType.ADD, { rd, rn, imm: imm3 }
			);
		} else {
			// SUB 3-bit immediate
			return createInstruction(
				addr, raw, 'SUBS', `R${rd}, R${rn}, #${imm3}`,
				InstructionType.SUB, { rd, rn, imm: imm3 }
			);
		}
	}

	// ===== Immediate Instructions =====

	private decodeMovImm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const rd = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		return createInstruction(
			addr, raw, 'MOVS', `R${rd}, #0x${imm8.toString(16).padStart(2, '0').toUpperCase()}`,
			InstructionType.MOVS, { rd, imm: imm8 }
		);
	}

	private decodeCmpImm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const rn = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		return createInstruction(
			addr, raw, 'CMP', `R${rn}, #0x${imm8.toString(16).padStart(2, '0').toUpperCase()}`,
			InstructionType.CMP, { rn, imm: imm8 }
		);
	}

	private decodeAdd8Imm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const rdn = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		return createInstruction(
			addr, raw, 'ADDS', `R${rdn}, #${imm8}`,
			InstructionType.ADD, { rd: rdn, imm: imm8 }
		);
	}

	private decodeSub8Imm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const rdn = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		return createInstruction(
			addr, raw, 'SUBS', `R${rdn}, #${imm8}`,
			InstructionType.SUB, { rd: rdn, imm: imm8 }
		);
	}

	// ===== Data Processing Instructions =====

	private decodeDataProc(addr: number, hw: number, raw: Uint8Array): Instruction {
		const op = (hw >> 6) & 0xf;
		const rm = (hw >> 3) & 0x7;
		const rdn = hw & 0x7;

		const ops: Record<number, string> = {
			0: 'ANDS', 1: 'EORS', 2: 'LSLS', 3: 'LSRS', 4: 'ASRS', 5: 'ADCS',
			6: 'SBCS', 7: 'RORS', 8: 'TST', 9: 'RSBS', 10: 'CMP', 11: 'CMN',
			12: 'ORRS', 13: 'MULS', 14: 'BICS', 15: 'MVNS'
		};

		const mnem = ops[op] ?? '???';

		const typeMap: Record<string, InstructionType> = {
			'ANDS': InstructionType.AND, 'EORS': InstructionType.EOR,
			'LSLS': InstructionType.LSL, 'LSRS': InstructionType.LSR,
			'ASRS': InstructionType.ASR, 'ADCS': InstructionType.ADC,
			'SBCS': InstructionType.SBC, 'RORS': InstructionType.ROR,
			'TST': InstructionType.TST, 'RSBS': InstructionType.RSB,
			'CMP': InstructionType.CMP, 'CMN': InstructionType.CMN,
			'ORRS': InstructionType.ORR, 'MULS': InstructionType.MUL,
			'BICS': InstructionType.BIC, 'MVNS': InstructionType.MVN
		};

		const itype = typeMap[mnem] ?? InstructionType.UNKNOWN;

		// TST, CMP, CMN don't write to destination
		if (mnem === 'TST' || mnem === 'CMP' || mnem === 'CMN') {
			return createInstruction(addr, raw, mnem, `R${rdn}, R${rm}`, itype, { rn: rdn, rm });
		} else if (mnem === 'RSBS') {
			// RSBS Rd, Rn, #0
			return createInstruction(addr, raw, mnem, `R${rdn}, R${rm}, #0`, itype, { rd: rdn, rm });
		} else if (mnem === 'MULS') {
			// MULS Rd, Rn, Rd
			return createInstruction(addr, raw, mnem, `R${rdn}, R${rm}, R${rdn}`, itype, { rd: rdn, rm });
		} else {
			return createInstruction(addr, raw, mnem, `R${rdn}, R${rm}`, itype, { rd: rdn, rm });
		}
	}

	// ===== Special Data Processing =====

	private decodeSpecialProc(addr: number, hw: number, raw: Uint8Array): Instruction {
		const op = (hw >> 8) & 0x3;
		const d = (hw >> 7) & 0x1;
		const rm = (hw >> 3) & 0xf;
		const rdn = (d << 3) | (hw & 0x7);

		if (op === 0) {
			// ADD high registers
			return createInstruction(addr, raw, 'ADD', `R${rdn}, R${rm}`, InstructionType.ADD, { rd: rdn, rm });
		} else if (op === 1) {
			// CMP high registers
			return createInstruction(addr, raw, 'CMP', `R${rdn}, R${rm}`, InstructionType.CMP, { rn: rdn, rm });
		} else if (op === 2) {
			// MOV high registers
			return createInstruction(addr, raw, 'MOV', `R${rdn}, R${rm}`, InstructionType.MOVS, { rd: rdn, rm });
		} else if (op === 3) {
			// BX / BLX
			if (d) {
				return createInstruction(addr, raw, 'BLX', `R${rm}`, InstructionType.BLX, { rm, branchTarget: 0 });
			} else {
				if (rm === 14) {
					return createInstruction(addr, raw, 'BX', 'LR', InstructionType.BX, { rm: 14 });
				}
				return createInstruction(addr, raw, 'BX', `R${rm}`, InstructionType.BX, { rm });
			}
		}

		return this.createUnknown(addr, raw);
	}

	// ===== Literal Pool Loads =====

	private decodeLdrLit(addr: number, hw: number, raw: Uint8Array): Instruction {
		const rt = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		const pcAligned = (addr + 4) & ~3;
		const target = pcAligned + imm8 * 4;
		return createInstruction(addr, raw, 'LDR', `R${rt}, [PC, #${imm8 * 4}]`, InstructionType.LDR, { rd: rt, imm: target });
	}

	// ===== Load/Store Register Offset =====

	private decodeLdstReg(addr: number, hw: number, raw: Uint8Array): Instruction {
		const rm = (hw >> 6) & 0x7;
		const rn = (hw >> 3) & 0x7;
		const rt = hw & 0x7;
		const opA = (hw >> 9) & 0x7;

		const ops = ['STR', 'STRH', 'STRB', 'LDRSB', 'LDR', 'LDRH', 'LDRB', 'LDRSH'];
		const types = [
			InstructionType.STR, InstructionType.STRH, InstructionType.STRB, InstructionType.LDRSB,
			InstructionType.LDR, InstructionType.LDRH, InstructionType.LDRB, InstructionType.LDRSH
		];
		const mnem = ops[opA] ?? '???';
		const itype = types[opA] ?? InstructionType.UNKNOWN;

		return createInstruction(addr, raw, mnem, `R${rt}, [R${rn}, R${rm}]`, itype, { rd: rt, rn, rm });
	}

	// ===== Load/Store Word =====

	private decodeLdstWord(addr: number, hw: number, raw: Uint8Array): Instruction {
		const b = (hw >> 12) & 0x1;
		const l = (hw >> 11) & 0x1;
		const imm5 = (hw >> 6) & 0x1f;
		const rn = (hw >> 3) & 0x7;
		const rt = hw & 0x7;
		const offset = b ? imm5 : imm5 * 4;
		const mnem = (l ? 'LDR' : 'STR') + (b ? 'B' : '');

		let itype = l ? InstructionType.LDR : InstructionType.STR;
		if (b) itype = l ? InstructionType.LDRB : InstructionType.STRB;

		return createInstruction(
			addr, raw, mnem, `R${rt}, [R${rn}, #${offset}]`,
			itype, { rd: rt, rn, imm: offset }
		);
	}

	// ===== Load/Store Halfword =====

	private decodeLdstHalf(addr: number, hw: number, raw: Uint8Array): Instruction {
		const l = (hw >> 11) & 0x1;
		const imm5 = (hw >> 6) & 0x1f;
		const rn = (hw >> 3) & 0x7;
		const rt = hw & 0x7;
		const offset = imm5 * 2;
		const mnem = l ? 'LDRH' : 'STRH';
		const itype = l ? InstructionType.LDRH : InstructionType.STRH;

		return createInstruction(
			addr, raw, mnem, `R${rt}, [R${rn}, #${offset}]`,
			itype, { rd: rt, rn, imm: offset }
		);
	}

	// ===== Load/Store SP Relative =====

	private decodeLdstSp(addr: number, hw: number, raw: Uint8Array): Instruction {
		const l = (hw >> 11) & 0x1;
		const rt = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		const offset = imm8 * 4;
		const mnem = l ? 'LDR' : 'STR';
		const itype = l ? InstructionType.LDR : InstructionType.STR;

		return createInstruction(
			addr, raw, mnem, `R${rt}, [SP, #${offset}]`,
			itype, { rd: rt, imm: offset }
		);
	}

	// ===== Load Address =====

	private decodeLoadAddr(addr: number, hw: number, raw: Uint8Array): Instruction {
		const sp = (hw >> 11) & 0x1;
		const rd = (hw >> 8) & 0x7;
		const imm8 = hw & 0xff;
		const offset = imm8 * 4;
		
		if (sp) {
			// ADD Rd, SP, #imm
			return createInstruction(addr, raw, 'ADD', `R${rd}, SP, #${offset}`, InstructionType.ADD, { rd, imm: offset });
		} else {
			// ADR Rd, PC, #imm
			const pcAligned = (addr + 4) & ~3;
			const target = pcAligned + offset;
			return createInstruction(addr, raw, 'ADR', `R${rd}, [PC, #${offset}]`, InstructionType.ADR, { rd, imm: target });
		}
	}

	// ===== Miscellaneous Instructions =====

	private decodeMisc(addr: number, hw: number, raw: Uint8Array): Instruction {
		const op = (hw >> 8) & 0xf;

		// Add/subtract SP
		if (op === 0) {
			const s = (hw >> 7) & 0x1;
			const imm7 = hw & 0x7f;
			const offset = imm7 * 4;
			const mnem = s ? 'SUB' : 'ADD';
			return createInstruction(addr, raw, mnem, `SP, #${offset}`, InstructionType.ADD, { imm: offset });
		}

		// PUSH {registers}
		if ((hw & 0xfe00) === 0xb400) {
			const m = (hw >> 8) & 0x1;
			const regList: string[] = [];
			for (let i = 0; i < 8; i++) {
				if (hw & (1 << i)) regList.push(`R${i}`);
			}
			if (m) regList.push('LR');
			return createInstruction(addr, raw, 'PUSH', `{${regList.join(', ')}}`, InstructionType.PUSH);
		}

		// POP {registers}
		if ((hw & 0xfe00) === 0xbc00) {
			const p = (hw >> 8) & 0x1;
			const regList: string[] = [];
			for (let i = 0; i < 8; i++) {
				if (hw & (1 << i)) regList.push(`R${i}`);
			}
			if (p) regList.push('PC');
			return createInstruction(addr, raw, 'POP', `{${regList.join(', ')}}`, InstructionType.POP);
		}

		// BKPT
		if ((hw & 0xff00) === 0xbe00) {
			return createInstruction(addr, raw, 'BKPT', `#${hw & 0xff}`, InstructionType.BKPT, { imm: hw & 0xff });
		}

		// IT / Hints
		if ((hw & 0xff00) === 0xbf00) {
			const firstcond = (hw >> 4) & 0xf;
			const mask = hw & 0xf;

			if (mask === 0) {
				// Hints
				const hints: Record<number, string> = { 0: 'NOP', 1: 'YIELD', 2: 'WFE', 3: 'WFI', 4: 'SEV' };
				const hint = hints[firstcond] ?? '???';
				let itype = InstructionType.NOP;
				if (hint === 'WFI') itype = InstructionType.WFI;
				else if (hint === 'WFE') itype = InstructionType.WFE;
				else if (hint === 'YIELD') itype = InstructionType.YIELD;
				else if (hint === 'SEV') itype = InstructionType.SEV;
				
				return createInstruction(addr, raw, hint, '', itype);
			} else {
				// IT instruction
				const condName = this.getCondName(firstcond);
				return createInstruction(addr, raw, 'IT', condName, InstructionType.IT, { cond: firstcond, itMask: mask });
			}
		}

		// CBZ / CBNZ
		if ((hw & 0xf500) === 0xb100) {
			const rn = hw & 0x7;
			const i = (hw >> 9) & 0x1;
			const imm5 = (hw >> 3) & 0x1f;
			const imm32 = (i << 6) | (imm5 << 1);
			const isCbz = !(hw & 0x800);
			const mnem = isCbz ? 'CBZ' : 'CBNZ';
			const target = addr + 4 + imm32;
			return createInstruction(
				addr, raw, mnem, `R${rn}, 0x${target.toString(16).toUpperCase().padStart(5, '0')}`,
				isCbz ? InstructionType.CBZ : InstructionType.CBNZ, { rn, branchTarget: target }
			);
		}

		return this.createUnknown(addr, raw);
	}

	// ===== Load/Store Multiple =====

	private decodeLdmStm(addr: number, hw: number, raw: Uint8Array): Instruction {
		const l = (hw >> 11) & 0x1;
		const rn = (hw >> 8) & 0x7;
		const mnem = l ? 'LDM' : 'STM';
		const regList: string[] = [];
		for (let i = 0; i < 8; i++) {
			if (hw & (1 << i)) regList.push(`R${i}`);
		}
		return createInstruction(
			addr, raw, mnem, `R${rn}!, {${regList.join(', ')}}`,
			l ? InstructionType.POP : InstructionType.PUSH, { rn }
		);
	}

	// ===== Conditional Branch =====

	private decodeCondBranch(addr: number, hw: number, raw: Uint8Array): Instruction {
		const cond = (hw >> 8) & 0xf;
		let imm8 = hw & 0xff;

		// UDF
		if (cond === 14) {
			return createInstruction(addr, raw, 'UDF', `#${imm8}`, InstructionType.UDF, { imm: imm8 });
		}

		// SVC
		if (cond === 15) {
			return createInstruction(addr, raw, 'SVC', `#${imm8}`, InstructionType.SVC, { imm: imm8 });
		}

		// Conditional branch
		if (imm8 & 0x80) {
			imm8 = imm8 - 256; // Sign extend
		}
		const target = addr + imm8 * 2 + 4;
		const condName = this.getCondName(cond);
		const mnem = `B${condName}`;

		let itype = InstructionType.B;
		if (cond === 0) itype = InstructionType.BEQ;
		else if (cond === 1) itype = InstructionType.BNE;

		return createInstruction(
			addr, raw, mnem, `0x${target.toString(16).toUpperCase().padStart(5, '0')}`,
			itype, { cond, branchTarget: target }
		);
	}

	// ===== Unconditional Branch =====

	private decodeUncondBranch(addr: number, hw: number, raw: Uint8Array): Instruction {
		let imm11 = hw & 0x7ff;
		if (imm11 & 0x400) {
			imm11 = imm11 - 2048; // Sign extend
		}
		const target = addr + imm11 * 2 + 4;
		return createInstruction(
			addr, raw, 'B', `0x${target.toString(16).toUpperCase().padStart(5, '0')}`,
			InstructionType.B, { branchTarget: target }
		);
	}

	// ===== 32-bit Instructions =====

	private decode32Bit(addr: number, hw1: number, hw2: number): Instruction {
		const raw = new Uint8Array([hw1 & 0xff, hw1 >> 8, hw2 & 0xff, hw2 >> 8]);

		// STMDB / PUSH.W / LDMDB / POP.W
		if ((hw1 & 0xff00) === 0xe900 || (hw1 & 0xff00) === 0xe800) {
			return this.decodeLdmStm32(addr, hw1, hw2, raw);
		}

		// MOVW
		if ((hw1 & 0xfbf0) === 0xf240) {
			return this.decodeMovw(addr, hw1, hw2, raw);
		}

		// MOVT
		if ((hw1 & 0xfbf0) === 0xf2c0) {
			return this.decodeMovt(addr, hw1, hw2, raw);
		}

		// MOV.W immediate (T2 encoding using ThumbExpandImm)
		if ((hw1 & 0xfbef) === 0xf04f) {
			return this.decodeMovW(addr, hw1, hw2, raw);
		}

		// CMP.W immediate (T2 encoding using ThumbExpandImm)
		if ((hw1 & 0xfbf0) === 0xf1b0) {
			return this.decodeCmpW(addr, hw1, hw2, raw);
		}

		// LDRB.W literal (T1: 1111 1000 x 001 1111)
		if ((hw1 & 0xff7f) === 0xf81f || (hw1 & 0xff7f) === 0xf89f) {
			return this.decodeLdrbLit32(addr, hw1, hw2, raw);
		}

		// STRH.W
		if ((hw1 & 0xfff0) === 0xf8a0 || (hw1 & 0xfff0) === 0xf820) {
			return this.decodeStrhW(addr, hw1, hw2, raw);
		}

		// BL / B.W
		if ((hw1 & 0xf800) === 0xf000) {
			if ((hw2 & 0xd000) === 0xd000) {
				return this.decodeBl(addr, hw1, hw2, raw);
			} else if ((hw2 & 0xd000) === 0x8000) {
				return this.decodeB32Cond(addr, hw1, hw2, raw);
			} else if ((hw2 & 0xd000) === 0x9000) {
				return this.decodeB32Uncond(addr, hw1, hw2, raw);
			}
		}

		return createInstruction(
			addr, raw, '32BIT', `0x${hw1.toString(16).padStart(4, '0').toUpperCase()} 0x${hw2.toString(16).padStart(4, '0').toUpperCase()}`,
			InstructionType.UNKNOWN, { size: 4 }
		);
	}

	private decodeLdmStm32(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const l = (hw1 >> 4) & 1; // Bit 20 of 32-bit instruction
		const rn = hw1 & 0xf;
		const regList: string[] = [];

		for (let i = 0; i < 16; i++) {
			if (hw2 & (1 << i)) {
				regList.push(this.getRegName(i));
			}
		}

		if (rn === 13) {
			// PUSH.W / POP.W
			const mnem = l ? 'POP.W' : 'PUSH.W';
			return createInstruction(addr, raw, mnem, `{${regList.join(', ')}}`, l ? InstructionType.POP : InstructionType.PUSH, { size: 4 });
		}

		const mnem = l ? 'LDMDB' : 'STMDB';
		return createInstruction(addr, raw, mnem, `R${rn}!, {${regList.join(', ')}}`, l ? InstructionType.POP : InstructionType.PUSH, { rn, size: 4 });
	}

	private decodeMovw(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const i = (hw1 >> 10) & 1;
		const imm4 = hw1 & 0xf;
		const imm3 = (hw2 >> 12) & 0x7;
		const rd = (hw2 >> 8) & 0xf;
		const imm8 = hw2 & 0xff;
		const imm16 = (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8;

		return createInstruction(
			addr, raw, 'MOVW', `R${rd}, #0x${imm16.toString(16).padStart(4, '0').toUpperCase()}`,
			InstructionType.MOVW, { rd, imm: imm16, size: 4 }
		);
	}

	private decodeMovt(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const i = (hw1 >> 10) & 1;
		const imm4 = hw1 & 0xf;
		const imm3 = (hw2 >> 12) & 0x7;
		const rd = (hw2 >> 8) & 0xf;
		const imm8 = hw2 & 0xff;
		const imm16 = (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8;

		return createInstruction(
			addr, raw, 'MOVT', `R${rd}, #0x${imm16.toString(16).padStart(4, '0').toUpperCase()}`,
			InstructionType.MOVT, { rd, imm: imm16 << 16, size: 4 }
		);
	}

	private decodeMovW(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const rd = (hw2 >> 8) & 0xf;
		const i_bit = (hw1 >> 10) & 1;
		const imm3 = (hw2 >> 12) & 0x7;
		const imm8 = hw2 & 0xff;
		const imm12 = (i_bit << 11) | (imm3 << 8) | imm8;
		const imm = this.thumbExpandImm(imm12);
		return createInstruction(
			addr, raw, 'MOV.W', `R${rd}, #0x${imm.toString(16).padStart(2, '0').toUpperCase()}`,
			InstructionType.MOVS, { rd, imm, size: 4 }
		);
	}

	private decodeCmpW(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const rn = hw1 & 0xf;
		const i_bit = (hw1 >> 10) & 1;
		const imm3 = (hw2 >> 12) & 0x7;
		const imm8 = hw2 & 0xff;
		const imm12 = (i_bit << 11) | (imm3 << 8) | imm8;
		const imm = this.thumbExpandImm(imm12);
		return createInstruction(
			addr, raw, 'CMP.W', `R${rn}, #0x${imm.toString(16).padStart(2, '0').toUpperCase()}`,
			InstructionType.CMP, { rn, imm, size: 4 }
		);
	}

	private decodeLdrbLit32(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const rt = (hw2 >> 12) & 0xf;
		const imm12 = hw2 & 0xfff;
		const u = (hw1 >> 7) & 1;
		const offset = u ? imm12 : -imm12;
		const pcAligned = (addr + 4) & ~3;
		const target = pcAligned + offset;
		return createInstruction(
			addr, raw, 'LDRB.W', `R${rt}, [PC, #${offset}]`,
			InstructionType.LDRB, { rd: rt, imm: target, size: 4 }
		);
	}

	private decodeStrhW(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const rn = hw1 & 0xf;
		const rt = (hw2 >> 12) & 0xf;
		const offset = hw2 & 0xfff;
		return createInstruction(
			addr, raw, 'STRH.W', `R${rt}, [R${rn}, #${offset}]`,
			InstructionType.STRH_W, { rd: rt, rn, imm: offset, size: 4 }
		);
	}

	private decodeBl(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const s = (hw1 >> 10) & 1;
		const imm10 = hw1 & 0x3ff;
		const j1 = (hw2 >> 13) & 1;
		const j2 = (hw2 >> 11) & 1;
		const imm11 = hw2 & 0x7ff;

		const i1 = ~(j1 ^ s) & 1;
		const i2 = ~(j2 ^ s) & 1;

		let imm32 = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1);
		// Sign-extend 25-bit value to 32-bit signed
		imm32 = (imm32 << 7) >> 7;

		const target = addr + 4 + imm32;
		return createInstruction(addr, raw, 'BL', `0x${target.toString(16).toUpperCase().padStart(5, '0')}`, InstructionType.BL, { branchTarget: target, size: 4 });
	}

	private decodeB32Cond(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const s = (hw1 >> 10) & 1;
		const cond = (hw1 >> 6) & 0xf;
		const imm6 = hw1 & 0x3f;
		const j1 = (hw2 >> 13) & 1;
		const j2 = (hw2 >> 11) & 1;
		const imm11 = hw2 & 0x7ff;

		let imm32 = (s << 20) | (j2 << 19) | (j1 << 18) | (imm6 << 12) | (imm11 << 1);
		// Sign-extend 21-bit value to 32-bit signed
		imm32 = (imm32 << 11) >> 11;

		const target = addr + 4 + imm32;
		const condName = this.getCondName(cond);
		
		let itype = InstructionType.B;
		if (cond === 0) itype = InstructionType.BEQ;
		else if (cond === 1) itype = InstructionType.BNE;

		return createInstruction(
			addr, raw, `B${condName}.W`, `0x${target.toString(16).toUpperCase().padStart(5, '0')}`,
			itype, { cond, branchTarget: target, size: 4 }
		);
	}

	private decodeB32Uncond(addr: number, hw1: number, hw2: number, raw: Uint8Array): Instruction {
		const s = (hw1 >> 10) & 1;
		const imm10 = hw1 & 0x3ff;
		const j1 = (hw2 >> 13) & 1;
		const j2 = (hw2 >> 11) & 1;
		const imm11 = hw2 & 0x7ff;

		const i1 = ~(j1 ^ s) & 1;
		const i2 = ~(j2 ^ s) & 1;

		let imm32 = (s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1);
		// Sign-extend 25-bit value to 32-bit signed
		imm32 = (imm32 << 7) >> 7;

		const target = addr + 4 + imm32;
		return createInstruction(
			addr, raw, 'B.W', `0x${target.toString(16).toUpperCase().padStart(5, '0')}`,
			InstructionType.B, { branchTarget: target, size: 4 }
		);
	}

	/**
	 * ThumbExpandImm: Decode a 12-bit modified immediate constant
	 * DDI0403 A5.3.1
	 */
	private thumbExpandImm(imm12: number): number {
		const top2 = (imm12 >> 10) & 0x3;
		if (top2 === 0) {
			const op = (imm12 >> 8) & 0x3;
			const abyte = imm12 & 0xff;
			switch (op) {
				case 0: return abyte;
				case 1: return (abyte << 16) | abyte;
				case 2: return (abyte << 24) | (abyte << 8);
				case 3: return (abyte << 24) | (abyte << 16) | (abyte << 8) | abyte;
			}
		}
		// ROR encoding: 1:xxxxxxx rotated
		const unrotated = 0x80 | (imm12 & 0x7f);
		const rotation = (imm12 >> 7) & 0x1f;
		return (unrotated >>> rotation) | (unrotated << (32 - rotation));
	}

	// ===== Utility Functions =====

	private getCondName(cond: number): string {
		const condNames = ['EQ', 'NE', 'CS', 'CC', 'MI', 'PL', 'VS', 'VC', 'HI', 'LS', 'GE', 'LT', 'GT', 'LE', 'AL', 'AL'];
		return condNames[cond] ?? '?';
	}

	private getRegName(reg: number): string {
		if (reg === 13) return 'SP';
		if (reg === 14) return 'LR';
		if (reg === 15) return 'PC';
		return `R${reg}`;
	}

	/**
	 * Get underlying data
	 */
	getData(): Uint8Array {
		return this.reader.getData();
	}

	/**
	 * Get data length
	 */
	getLength(): number {
		return this.reader.length;
	}

	/**
	 * Read 16-bit value at offset (little-endian)
	 */
	readU16(offset: number): number {
		return this.reader.readU16(offset);
	}

	/**
	 * Read 32-bit value at offset (little-endian)
	 */
	readU32(offset: number): number {
		return this.reader.readU32(offset);
	}
}

/**
 * Check if instruction at address is a MOVW instruction
 * DDI0403 A6.3.2 T3: hw1 = 11110 i 10 0100 imm4
 */
export function isMovwInstruction(data: Uint8Array, addr: number): boolean {
	if (addr + 4 > data.length) return false;
	const hw1 = data[addr] | (data[addr + 1] << 8);
	return (hw1 & 0xfbf0) === 0xf240;
}

/**
 * Read MOVW immediate value at address
 */
export function readMovwImmediate(data: Uint8Array, addr: number): number {
	if (addr + 4 > data.length) return 0;
	const hw1 = data[addr] | (data[addr + 1] << 8);
	const hw2 = data[addr + 2] | (data[addr + 3] << 8);

	const i = (hw1 >> 10) & 1;
	const imm4 = hw1 & 0xf;
	const imm3 = (hw2 >> 12) & 0x7;
	const imm8 = hw2 & 0xff;

	return (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8;
}
