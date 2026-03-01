import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ThumbDecoder, BinaryReader, isMovwInstruction, readMovwImmediate } from '../decoder.ts';
import { InstructionType } from '../instructions.ts';

// ============================================================
// Helper: encode instruction bytes in little-endian and create decoder
// ============================================================

/** Create a decoder from 16-bit halfwords (little-endian) */
function decoderFrom16(...halfwords: number[]): ThumbDecoder {
	const buf = new Uint8Array(halfwords.length * 2);
	for (let i = 0; i < halfwords.length; i++) {
		buf[i * 2] = halfwords[i] & 0xff;
		buf[i * 2 + 1] = (halfwords[i] >> 8) & 0xff;
	}
	return new ThumbDecoder(buf);
}

/** Create a decoder from a 32-bit instruction (two halfwords) */
function decoderFrom32(hw1: number, hw2: number): ThumbDecoder {
	return decoderFrom16(hw1, hw2);
}

/** Create raw Uint8Array from 32-bit instruction (for standalone helpers) */
function rawFrom32(...args: [number, number]): Uint8Array {
	const [hw1, hw2] = args;
	return new Uint8Array([hw1 & 0xff, hw1 >> 8, hw2 & 0xff, hw2 >> 8]);
}

// ============================================================
// Helper: Encode a MOVW instruction from given imm16 and rd
// DDI0403: hw1 = 11110 i 10 0100 imm4
//          hw2 = 0 imm3 rd(4) imm8
// imm16 = imm4:i:imm3:imm8
// ============================================================
function encodeMovw(rd: number, imm16: number): [number, number] {
	const imm4 = (imm16 >> 12) & 0xf;
	const i = (imm16 >> 11) & 0x1;
	const imm3 = (imm16 >> 8) & 0x7;
	const imm8 = imm16 & 0xff;
	const hw1 = 0xf240 | (i << 10) | imm4;
	const hw2 = (imm3 << 12) | (rd << 8) | imm8;
	return [hw1, hw2];
}

function encodeMovt(rd: number, imm16: number): [number, number] {
	const imm4 = (imm16 >> 12) & 0xf;
	const i = (imm16 >> 11) & 0x1;
	const imm3 = (imm16 >> 8) & 0x7;
	const imm8 = imm16 & 0xff;
	const hw1 = 0xf2c0 | (i << 10) | imm4;
	const hw2 = (imm3 << 12) | (rd << 8) | imm8;
	return [hw1, hw2];
}

// ============================================================
// Helper: Encode a CBZ/CBNZ instruction
// DDI0403: 1011 op 0 i 1 imm5 Rn
// imm32 = ZeroExtend(i:imm5:'0', 32)  → offset range [0, 126]
// ============================================================
function encodeCbz(rn: number, offset: number, nonzero: boolean): number {
	const imm5 = (offset >> 1) & 0x1f;
	const i = (offset >> 6) & 0x1;
	const op = nonzero ? 1 : 0;
	return 0xb100 | (op << 11) | (i << 9) | (imm5 << 3) | rn;
}

// ============================================================
// Helper: Encode BL instruction
// ============================================================
function encodeBL(imm32: number): [number, number] {
	const s = (imm32 < 0) ? 1 : 0;
	const u = imm32 & 0x01FFFFFF;
	const i1 = (u >> 23) & 1;
	const i2 = (u >> 22) & 1;
	const imm10 = (u >> 12) & 0x3FF;
	const imm11 = (u >> 1) & 0x7FF;
	const j1 = (~(i1 ^ s)) & 1;
	const j2 = (~(i2 ^ s)) & 1;
	const hw1 = 0xF000 | (s << 10) | imm10;
	const hw2 = 0xD000 | (j1 << 13) | (j2 << 11) | imm11;
	return [hw1, hw2];
}

// ============================================================
// Helper: Encode B.W T3 (conditional 32-bit branch)
// DDI0403: hw1 = 11110 S cond imm6
//          hw2 = 10 J1 0 J2 imm11
// imm32 = SignExtend(S:J2:J1:imm6:imm11:0, 21)
// ============================================================
function encodeCondB32(cond: number, imm32: number): [number, number] {
	const s = (imm32 < 0) ? 1 : 0;
	const u = imm32 & 0x001FFFFF; // 21-bit mask
	const j2 = (u >> 19) & 1;
	const j1 = (u >> 18) & 1;
	const imm6 = (u >> 12) & 0x3f;
	const imm11 = (u >> 1) & 0x7ff;
	const hw1 = 0xf000 | (s << 10) | (cond << 6) | imm6;
	const hw2 = 0x8000 | (j1 << 13) | (j2 << 11) | imm11;
	return [hw1, hw2];
}

// ============================================================
// Helper: Encode B.W T4 (unconditional 32-bit branch)
// Same offset encoding as BL but hw2 bit[14]=0, bit[12]=1
// hw2 = 10 J1 1 J2 imm11
// ============================================================
function encodeUncondB32(imm32: number): [number, number] {
	const s = (imm32 < 0) ? 1 : 0;
	const u = imm32 & 0x01FFFFFF;
	const i1 = (u >> 23) & 1;
	const i2 = (u >> 22) & 1;
	const imm10 = (u >> 12) & 0x3FF;
	const imm11 = (u >> 1) & 0x7FF;
	const j1 = (~(i1 ^ s)) & 1;
	const j2 = (~(i2 ^ s)) & 1;
	const hw1 = 0xF000 | (s << 10) | imm10;
	const hw2 = 0x9000 | (j1 << 13) | (j2 << 11) | imm11;
	return [hw1, hw2];
}

// ============================================================
// Tests
// ============================================================

describe('BinaryReader', () => {
	it('reads U16 little-endian', () => {
		const r = new BinaryReader(new Uint8Array([0x34, 0x12]));
		assert.equal(r.readU16(0), 0x1234);
	});

	it('reads U32 little-endian', () => {
		const r = new BinaryReader(new Uint8Array([0x78, 0x56, 0x34, 0x12]));
		assert.equal(r.readU32(0), 0x12345678);
	});

	it('returns 0 on out-of-bounds read', () => {
		const r = new BinaryReader(new Uint8Array([0x01]));
		assert.equal(r.readU16(0), 0);
		assert.equal(r.readU32(0), 0);
	});
});

// ============================================================
// BUG FIX #1: MOVW / MOVT encoding
// ============================================================
describe('MOVW (T3 encoding) - Bug Fix #1', () => {
	it('decodes MOVW with i=0 (small imm)', () => {
		const [hw1, hw2] = encodeMovw(0, 0x1234);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVW');
		assert.equal(inst.instrType, InstructionType.MOVW);
		assert.equal(inst.rd, 0);
		assert.equal(inst.imm, 0x1234);
	});

	it('decodes MOVW with i=1 (was broken: i bit masked out)', () => {
		const [hw1, hw2] = encodeMovw(3, 0x0800);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVW', 'must decode as MOVW, not BL');
		assert.equal(inst.instrType, InstructionType.MOVW);
		assert.equal(inst.rd, 3);
		assert.equal(inst.imm, 0x0800);
	});

	it('decodes MOVW with all bits set (imm16=0xFFFF)', () => {
		const [hw1, hw2] = encodeMovw(7, 0xFFFF);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVW');
		assert.equal(inst.imm, 0xFFFF);
		assert.equal(inst.rd, 7);
	});

	it('decodes MOVW with imm16=0 (edge case)', () => {
		const [hw1, hw2] = encodeMovw(0, 0x0000);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVW');
		assert.equal(inst.imm, 0);
	});

	it('decodes MOVW R0, #0x3808 (real-world example)', () => {
		const [hw1, hw2] = encodeMovw(0, 0x3808);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVW');
		assert.equal(inst.imm, 0x3808);
	});
});

describe('MOVT (T1 encoding) - Bug Fix #1', () => {
	it('decodes MOVT with i=0', () => {
		const [hw1, hw2] = encodeMovt(0, 0x4002);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVT');
		assert.equal(inst.instrType, InstructionType.MOVT);
		assert.equal(inst.rd, 0);
		assert.equal(inst.imm, 0x4002 << 16);
	});

	it('decodes MOVT with i=1 (was broken)', () => {
		const [hw1, hw2] = encodeMovt(5, 0x0800);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVT', 'must decode as MOVT, not BL');
		assert.equal(inst.instrType, InstructionType.MOVT);
		assert.equal(inst.rd, 5);
		assert.equal(inst.imm, 0x0800 << 16);
	});

	it('decodes MOVT with imm16=0xFFFF', () => {
		const [hw1, hw2] = encodeMovt(0, 0xFFFF);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVT');
		assert.equal(inst.imm, 0xFFFF << 16);
	});
});

describe('isMovwInstruction / readMovwImmediate standalone helpers', () => {
	it('detects MOVW with i=0', () => {
		const raw = rawFrom32(...encodeMovw(0, 0x1234));
		assert.equal(isMovwInstruction(raw, 0), true);
		assert.equal(readMovwImmediate(raw, 0), 0x1234);
	});

	it('detects MOVW with i=1 (was broken)', () => {
		const raw = rawFrom32(...encodeMovw(0, 0x0800));
		assert.equal(isMovwInstruction(raw, 0), true, 'isMovwInstruction must accept i=1');
		assert.equal(readMovwImmediate(raw, 0), 0x0800);
	});

	it('rejects non-MOVW', () => {
		const raw = rawFrom32(0xf000, 0xd000);
		assert.equal(isMovwInstruction(raw, 0), false);
	});

	it('rejects MOVT (different opcode)', () => {
		const raw = rawFrom32(...encodeMovt(0, 0x1234));
		assert.equal(isMovwInstruction(raw, 0), false);
	});
});

// ============================================================
// BUG FIX #2: CBZ / CBNZ offset calculation (missing i bit)
// ============================================================
describe('CBZ / CBNZ - Bug Fix #2 (i-bit in offset)', () => {
	it('decodes CBZ with small offset (i=0)', () => {
		const hw = encodeCbz(0, 10, false);
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CBZ');
		assert.equal(inst.instrType, InstructionType.CBZ);
		assert.equal(inst.rn, 0);
		assert.equal(inst.branchTarget, 14);
	});

	it('decodes CBNZ with small offset (i=0)', () => {
		const hw = encodeCbz(3, 20, true);
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CBNZ');
		assert.equal(inst.instrType, InstructionType.CBNZ);
		assert.equal(inst.rn, 3);
		assert.equal(inst.branchTarget, 24);
	});

	it('decodes CBZ with large offset requiring i=1 (was broken)', () => {
		const hw = encodeCbz(1, 66, false);
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CBZ');
		assert.equal(inst.branchTarget, 70, 'offset must include i bit');
	});

	it('decodes CBZ with maximum offset=126 (i=1, imm5=0x1f)', () => {
		const hw = encodeCbz(2, 126, false);
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CBZ');
		assert.equal(inst.branchTarget, 130);
	});

	it('decodes CBNZ with i=1 at non-zero address', () => {
		const hw = encodeCbz(0, 80, true);
		const buf = new Uint8Array(0x102);
		buf[0x100] = hw & 0xff;
		buf[0x101] = hw >> 8;
		const dec = new ThumbDecoder(buf);
		const inst = dec.decode(0x100);
		assert.equal(inst.mnemonic, 'CBNZ');
		assert.equal(inst.branchTarget, 0x100 + 4 + 80);
	});

	it('decodes CBZ with offset=0 (edge case)', () => {
		const hw = encodeCbz(0, 0, false);
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CBZ');
		assert.equal(inst.branchTarget, 4);
	});
});

// ============================================================
// BUG FIX #3: MOV.W / CMP.W ThumbExpandImm
// ============================================================
describe('MOV.W (T2) ThumbExpandImm - Bug Fix #3', () => {
	it('decodes MOV.W with simple imm8 (imm3=0, i=0)', () => {
		const hw1 = 0xf04f;
		const hw2 = 0x0042;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOV.W');
		assert.equal(inst.rd, 0);
		assert.equal(inst.imm, 0x42);
	});

	it('decodes MOV.W with imm3 != 0 (was broken: only extracted imm8)', () => {
		const hw1 = 0xf04f;
		const hw2 = 0x11FF;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOV.W');
		assert.equal(inst.rd, 1);
		assert.equal(inst.imm, 0x00FF00FF);
	});

	it('decodes MOV.W with i=1 (rotation encoding)', () => {
		const hw1 = 0xf44f;
		const hw2 = 0x0080;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOV.W');
		assert.equal(inst.imm, 0x00400000);
	});
});

describe('CMP.W (T2) ThumbExpandImm - Bug Fix #3', () => {
	it('decodes CMP.W with simple imm8', () => {
		const hw1 = 0xf1b0;
		const hw2 = 0x0f05;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CMP.W');
		assert.equal(inst.rn, 0);
		assert.equal(inst.imm, 5);
	});

	it('decodes CMP.W with expanded immediate (pattern 11)', () => {
		const hw1 = 0xf1b2;
		const hw2 = 0x3fab;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CMP.W');
		assert.equal(inst.rn, 2);
		assert.equal(inst.imm >>> 0, 0xABABABAB >>> 0);
	});
});

// ============================================================
// BUG FIX #4: MUL in data processing
// ============================================================
describe('MUL (data processing opcode 13) - Bug Fix #4', () => {
	it('decodes MULS R2, R3, R2', () => {
		const hw = 0b0100001101011010;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MULS');
		assert.equal(inst.instrType, InstructionType.MUL);
		assert.equal(inst.rd, 2);
		assert.equal(inst.rm, 3);
	});
});

// ============================================================
// BUG FIX #5: BICS → InstructionType.BIC (was AND)
// ============================================================
describe('BICS (data processing opcode 14) - Bug Fix #5', () => {
	it('decodes BICS R1, R2 with correct type', () => {
		// Data proc: 010000 opcode(1110) rm(010) rdn(001)
		// = 0100_0011_1001_0001 = 0x4391
		const hw = 0b0100001110010001;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BICS');
		assert.equal(inst.instrType, InstructionType.BIC);
		assert.equal(inst.rd, 1);
		assert.equal(inst.rm, 2);
	});
});

// ============================================================
// BUG FIX #6: ADR vs ADD SP
// ============================================================
describe('ADR vs ADD Rd, SP - Bug Fix #6', () => {
	it('decodes ADR (PC-relative) when bit[11]=0', () => {
		// ADR R0, PC+#16: 1010 0 000 00000100 = 0xA004
		const dec = decoderFrom16(0xA004);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'ADR');
		assert.equal(inst.rd, 0);
		// pcAligned = (0+4) & ~3 = 4, target = 4 + 16 = 20
		assert.equal(inst.imm, 20);
	});

	it('decodes ADD Rd, SP, #imm when bit[11]=1', () => {
		// ADD R1, SP, #16: 1010 1 001 00000100 = 0xA904
		const dec = decoderFrom16(0xA904);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'ADD');
		assert.ok(inst.operands.includes('SP'));
		assert.equal(inst.rd, 1);
		assert.equal(inst.imm, 16);
	});

	it('ADR vs ADD are distinct instructions', () => {
		// ADR R2, PC+0
		const adr = decoderFrom16(0xA200).decode(0);
		// ADD R2, SP, #0
		const add = decoderFrom16(0xAA00).decode(0);
		assert.equal(adr.mnemonic, 'ADR');
		assert.equal(add.mnemonic, 'ADD');
	});
});

// ============================================================
// BUG FIX #7: Load/Store register offset correct types
// ============================================================
describe('Load/Store register offset - correct InstructionType - Bug Fix #7', () => {
	it('STR uses InstructionType.STR', () => {
		// STR R0, [R1, R2]: opA=000 → 0101 000 rm(010) rn(001) rt(000) = 0x5088
		const hw = 0b0101000010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STR');
		assert.equal(inst.instrType, InstructionType.STR);
	});

	it('STRH uses InstructionType.STRH', () => {
		// STRH R0, [R1, R2]: opA=001
		const hw = 0b0101001010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STRH');
		assert.equal(inst.instrType, InstructionType.STRH);
	});

	it('STRB uses InstructionType.STRB', () => {
		// STRB R0, [R1, R2]: opA=010
		const hw = 0b0101010010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STRB');
		assert.equal(inst.instrType, InstructionType.STRB);
	});

	it('LDR uses InstructionType.LDR', () => {
		// LDR R0, [R1, R2]: opA=100
		const hw = 0b0101100010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDR');
		assert.equal(inst.instrType, InstructionType.LDR);
	});

	it('LDRB uses InstructionType.LDRB', () => {
		// LDRB R0, [R1, R2]: opA=110
		const hw = 0b0101110010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRB');
		assert.equal(inst.instrType, InstructionType.LDRB);
	});

	it('LDRSB uses InstructionType.LDRSB', () => {
		// LDRSB R0, [R1, R2]: opA=011
		const hw = 0b0101011010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRSB');
		assert.equal(inst.instrType, InstructionType.LDRSB);
	});

	it('LDRH uses InstructionType.LDRH', () => {
		// LDRH R0, [R1, R2]: opA=101
		const hw = 0b0101101010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRH');
		assert.equal(inst.instrType, InstructionType.LDRH);
	});

	it('LDRSH uses InstructionType.LDRSH', () => {
		// LDRSH R0, [R1, R2]: opA=111
		const hw = 0b0101111010001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRSH');
		assert.equal(inst.instrType, InstructionType.LDRSH);
	});
});

// ============================================================
// BUG FIX #8: Load/Store word/byte immediate correct types
// ============================================================
describe('Load/Store word/byte immediate - correct InstructionType - Bug Fix #8', () => {
	it('STR Rt, [Rn, #imm] uses InstructionType.STR', () => {
		// STR R0, [R1, #4]: 0110 0 00001 001 000 = 0x6048
		const hw = 0b0110000001001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STR');
		assert.equal(inst.instrType, InstructionType.STR);
		assert.equal(inst.imm, 4);
	});

	it('LDR Rt, [Rn, #imm] uses InstructionType.LDR', () => {
		// LDR R0, [R1, #4]: 0110 1 00001 001 000 = 0x6848
		const hw = 0b0110100001001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDR');
		assert.equal(inst.instrType, InstructionType.LDR);
	});

	it('STRB Rt, [Rn, #imm] uses InstructionType.STRB', () => {
		// STRB R0, [R1, #1]: 0111 0 00001 001 000 = 0x7048
		const hw = 0b0111000001001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STRB');
		assert.equal(inst.instrType, InstructionType.STRB);
	});

	it('LDRB Rt, [Rn, #imm] uses InstructionType.LDRB', () => {
		// LDRB R0, [R1, #1]: 0111 1 00001 001 000 = 0x7848
		const hw = 0b0111100001001000;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRB');
		assert.equal(inst.instrType, InstructionType.LDRB);
	});
});

// ============================================================
// BUG FIX #9: SP-relative store uses STR type
// ============================================================
describe('SP-relative Load/Store - correct InstructionType - Bug Fix #9', () => {
	it('STR Rt, [SP, #imm] uses InstructionType.STR', () => {
		// STR R0, [SP, #16]: 10010 000 00000100 = 0x9004
		const dec = decoderFrom16(0x9004);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STR');
		assert.equal(inst.instrType, InstructionType.STR);
		assert.equal(inst.imm, 16);
	});

	it('LDR Rt, [SP, #imm] uses InstructionType.LDR', () => {
		// LDR R0, [SP, #16]: 10011 000 00000100 = 0x9804
		const dec = decoderFrom16(0x9804);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDR');
		assert.equal(inst.instrType, InstructionType.LDR);
	});
});

// ============================================================
// BUG FIX #10: LDRB.W literal should check Rn=0xF (PC)
// ============================================================
describe('LDRB.W literal - Bug Fix #10', () => {
	it('decodes LDRB.W Rt, [PC, #imm] with U=1 (add)', () => {
		// hw1 = 0xf89f (1111 1000 1 001 1111, Rn=15, U=1)
		// hw2 = Rt=0, imm12=0x10
		const hw1 = 0xf89f;
		const hw2 = 0x0010;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRB.W');
		assert.equal(inst.instrType, InstructionType.LDRB);
		assert.equal(inst.rd, 0);
		// pcAligned = (0+4) & ~3 = 4, target = 4 + 0x10 = 0x14
		assert.equal(inst.imm, 0x14);
	});

	it('decodes LDRB.W Rt, [PC, #-imm] with U=0 (subtract)', () => {
		// hw1 = 0xf81f (1111 1000 0 001 1111, Rn=15, U=0)
		// hw2 = Rt=1, imm12=0x08
		const hw1 = 0xf81f;
		const hw2 = 0x1008;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDRB.W');
		assert.equal(inst.instrType, InstructionType.LDRB);
		assert.equal(inst.rd, 1);
		// pcAligned = 4, target = 4 - 8 = -4
		assert.equal(inst.imm, -4);
	});
});

// ============================================================
// BUG FIX #11: B.W T3 (conditional) vs T4 (unconditional)
// ============================================================
describe('B.W T3 conditional 32-bit branch - Bug Fix #11', () => {
	it('decodes BEQ.W forward +0x100', () => {
		const [hw1, hw2] = encodeCondB32(0, 0x100); // cond=0 (EQ)
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BEQ.W');
		assert.equal(inst.instrType, InstructionType.BEQ);
		assert.equal(inst.branchTarget, 4 + 0x100);
		assert.equal(inst.cond, 0);
	});

	it('decodes BNE.W backward -0x100', () => {
		const [hw1, hw2] = encodeCondB32(1, -0x100); // cond=1 (NE)
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BNE.W');
		assert.equal(inst.instrType, InstructionType.BNE);
		assert.equal(inst.branchTarget, 4 - 0x100);
	});

	it('decodes BGT.W forward +0x200', () => {
		const [hw1, hw2] = encodeCondB32(0xC, 0x200); // cond=12 (GT)
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BGT.W');
		assert.equal(inst.branchTarget, 4 + 0x200);
		assert.equal(inst.cond, 0xC);
	});

	it('B.W T3 conditional is distinct from T4 unconditional', () => {
		// T3 conditional: BEQ.W +0x100
		const [hw1c, hw2c] = encodeCondB32(0, 0x100);
		const instC = decoderFrom32(hw1c, hw2c).decode(0);

		// T4 unconditional: B.W +0x100
		const [hw1u, hw2u] = encodeUncondB32(0x100);
		const instU = decoderFrom32(hw1u, hw2u).decode(0);

		assert.equal(instC.mnemonic, 'BEQ.W');
		assert.equal(instU.mnemonic, 'B.W');
	});
});

describe('B.W T4 unconditional 32-bit branch', () => {
	it('decodes B.W forward +0x100', () => {
		const [hw1, hw2] = encodeUncondB32(0x100);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'B.W');
		assert.equal(inst.instrType, InstructionType.B);
		assert.equal(inst.branchTarget, 4 + 0x100);
	});

	it('decodes B.W backward -0x100', () => {
		const [hw1, hw2] = encodeUncondB32(-0x100);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'B.W');
		assert.equal(inst.branchTarget, 4 - 0x100);
	});
});

// ============================================================
// BUG FIX #12: STMDB/PUSH.W register list
// ============================================================
describe('STMDB / PUSH.W register list - Bug Fix #12', () => {
	it('PUSH.W {R4, LR} uses hw2 register bitmap only', () => {
		// PUSH.W: hw1 = 0xE92D (STMDB SP!, ...)
		// hw2: bit 4 (R4) + bit 14 (LR) = 0x4010
		const hw1 = 0xe92d;
		const hw2 = 0x4010;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'PUSH.W');
		assert.ok(inst.operands.includes('R4'));
		assert.ok(inst.operands.includes('LR'));
		// LR should appear exactly once
		const lrCount = inst.operands.split('LR').length - 1;
		assert.equal(lrCount, 1, 'LR must appear exactly once');
	});

	it('PUSH.W {R4-R7, LR} from hw2 bitmap', () => {
		// hw2: bits 4-7 (R4-R7) + bit 14 (LR) = 0x40F0
		const hw1 = 0xe92d;
		const hw2 = 0x40F0;
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'PUSH.W');
		assert.ok(inst.operands.includes('R4'));
		assert.ok(inst.operands.includes('R7'));
		assert.ok(inst.operands.includes('LR'));
	});
});

// ============================================================
// Regression: BL must still work correctly after MOVW fix
// ============================================================
describe('BL (32-bit) - Regression after MOVW fix', () => {
	it('decodes BL with zero offset', () => {
		const [hw1, hw2] = encodeBL(0);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BL');
		assert.equal(inst.instrType, InstructionType.BL);
		assert.equal(inst.branchTarget, 4);
	});

	it('decodes BL forward +0x100', () => {
		const [hw1, hw2] = encodeBL(0x100);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BL');
		assert.equal(inst.branchTarget, 0x104);
	});

	it('decodes BL backward -0x100', () => {
		const [hw1, hw2] = encodeBL(-0x100);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BL');
		assert.equal(inst.branchTarget, 4 - 0x100);
	});

	it('decodes BL with large forward offset', () => {
		const offset = 0x10000;
		const [hw1, hw2] = encodeBL(offset);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BL');
		assert.equal(inst.branchTarget, 4 + offset);
	});

	it('BL is not confused with MOVW', () => {
		const [hw1, hw2] = encodeBL(0);
		const dec = decoderFrom32(hw1, hw2);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BL');
	});
});

// ============================================================
// Standard 16-bit instructions (regression / coverage)
// ============================================================
describe('16-bit instruction decoding', () => {
	it('decodes MOVS Rd, #imm8', () => {
		const dec = decoderFrom16(0x23FF);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'MOVS');
		assert.equal(inst.rd, 3);
		assert.equal(inst.imm, 0xFF);
	});

	it('decodes CMP Rn, #imm8', () => {
		const dec = decoderFrom16(0x2D0A);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'CMP');
		assert.equal(inst.rn, 5);
		assert.equal(inst.imm, 0x0A);
	});

	it('decodes ADDS Rd, Rn, #imm3', () => {
		const hw = 0b0001110011010001;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'ADDS');
		assert.equal(inst.rd, 1);
		assert.equal(inst.rn, 2);
		assert.equal(inst.imm, 3);
	});

	it('decodes PUSH {R4, LR}', () => {
		const dec = decoderFrom16(0xB510);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'PUSH');
		assert.ok(inst.operands.includes('R4'));
		assert.ok(inst.operands.includes('LR'));
	});

	it('decodes POP {R4, PC}', () => {
		const dec = decoderFrom16(0xBD10);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'POP');
		assert.ok(inst.operands.includes('R4'));
		assert.ok(inst.operands.includes('PC'));
	});

	it('decodes BX LR', () => {
		const dec = decoderFrom16(0x4770);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BX');
		assert.equal(inst.operands, 'LR');
		assert.equal(inst.instrType, InstructionType.BX);
	});

	it('decodes BEQ (conditional branch)', () => {
		const dec = decoderFrom16(0xD003);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BEQ');
		assert.equal(inst.instrType, InstructionType.BEQ);
		assert.equal(inst.branchTarget, 0 + 3 * 2 + 4);
	});

	it('decodes BNE backward', () => {
		const dec = decoderFrom16(0xD1FC);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BNE');
		assert.equal(inst.instrType, InstructionType.BNE);
		assert.equal(inst.branchTarget, -4);
	});

	it('decodes B (unconditional)', () => {
		const dec = decoderFrom16(0xE07E);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'B');
		assert.equal(inst.instrType, InstructionType.B);
		assert.equal(inst.branchTarget, 0 + 0x7E * 2 + 4);
	});

	it('decodes NOP', () => {
		const dec = decoderFrom16(0xBF00);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'NOP');
	});

	it('decodes WFI', () => {
		const dec = decoderFrom16(0xBF30);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'WFI');
	});

	it('decodes IT EQ', () => {
		const dec = decoderFrom16(0xBF08);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'IT');
		assert.equal(inst.operands, 'EQ');
		assert.equal(inst.instrType, InstructionType.IT);
	});

	it('decodes LSLS R0, R1, #5', () => {
		const hw = (0b00000 << 11) | (5 << 6) | (1 << 3) | 0;
		const dec = decoderFrom16(hw);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LSLS');
		assert.equal(inst.rd, 0);
		assert.equal(inst.rm, 1);
		assert.equal(inst.imm, 5);
	});

	it('decodes LDR Rt, [PC, #imm]', () => {
		const dec = decoderFrom16(0x4802);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'LDR');
		assert.equal(inst.rd, 0);
		assert.equal(inst.imm, 12);
	});

	it('decodes STR Rt, [SP, #imm]', () => {
		const dec = decoderFrom16(0x9004);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'STR');
		assert.ok(inst.operands.includes('SP'));
		assert.equal(inst.imm, 16);
	});

	it('decodes ADD SP, #imm', () => {
		const dec = decoderFrom16(0xB004);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'ADD');
		assert.ok(inst.operands.includes('SP'));
		assert.equal(inst.imm, 16);
	});

	it('decodes SUB SP, #imm', () => {
		const dec = decoderFrom16(0xB082);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'SUB');
		assert.ok(inst.operands.includes('SP'));
		assert.equal(inst.imm, 8);
	});

	it('decodes SVC', () => {
		const dec = decoderFrom16(0xDF00);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'SVC');
	});

	it('decodes BKPT', () => {
		const dec = decoderFrom16(0xBE00);
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, 'BKPT');
	});
});

// ============================================================
// Edge cases
// ============================================================
describe('Edge cases', () => {
	it('handles end-of-data gracefully', () => {
		const dec = new ThumbDecoder(new Uint8Array([0x00]));
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, '???');
	});

	it('handles 32-bit instruction at end of data', () => {
		const dec = new ThumbDecoder(new Uint8Array([0x00, 0xf0]));
		const inst = dec.decode(0);
		assert.equal(inst.mnemonic, '???');
	});

	it('multiple sequential instructions decode independently', () => {
		const dec = decoderFrom16(0x2001, 0x4770);
		const i1 = dec.decode(0);
		const i2 = dec.decode(2);
		assert.equal(i1.mnemonic, 'MOVS');
		assert.equal(i2.mnemonic, 'BX');
	});
});

// ============================================================
// ThumbExpandImm unit tests
// ============================================================
describe('ThumbExpandImm (internal via MOV.W)', () => {
	function encodeMOVW_T2(imm12: number): [number, number] {
		const i_bit = (imm12 >> 11) & 1;
		const imm3 = (imm12 >> 8) & 0x7;
		const imm8 = imm12 & 0xff;
		const hw1 = 0xf04f | (i_bit << 10);
		const hw2 = (imm3 << 12) | (0 << 8) | imm8;
		return [hw1, hw2];
	}

	it('pattern 00: plain byte', () => {
		const [hw1, hw2] = encodeMOVW_T2(0x042);
		const dec = decoderFrom32(hw1, hw2);
		assert.equal(dec.decode(0).imm, 0x42);
	});

	it('pattern 01: 0x00XY00XY', () => {
		const [hw1, hw2] = encodeMOVW_T2(0x1AB);
		const dec = decoderFrom32(hw1, hw2);
		assert.equal(dec.decode(0).imm, 0x00AB00AB);
	});

	it('pattern 10: 0xXY00XY00', () => {
		const [hw1, hw2] = encodeMOVW_T2(0x2AB);
		const dec = decoderFrom32(hw1, hw2);
		assert.equal(dec.decode(0).imm >>> 0, 0xAB00AB00 >>> 0);
	});

	it('pattern 11: 0xXYXYXYXY', () => {
		const [hw1, hw2] = encodeMOVW_T2(0x3AB);
		const dec = decoderFrom32(hw1, hw2);
		assert.equal(dec.decode(0).imm >>> 0, 0xABABABAB >>> 0);
	});

	it('ROR encoding (top2 != 00)', () => {
		const [hw1, hw2] = encodeMOVW_T2(0x408);
		const dec = decoderFrom32(hw1, hw2);
		assert.equal(dec.decode(0).imm >>> 0, 0x88000000 >>> 0);
	});
});