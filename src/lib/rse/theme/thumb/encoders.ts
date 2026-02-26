/**
 * ARM Thumb Instruction Encoders
 *
 * Functions to encode ARM Thumb instructions for patching firmware.
 * Ported from theme_patcher.py encode functions.
 */

/**
 * Custom error for Thumb instruction encoding errors
 */
export class ThumbEncodingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ThumbEncodingError';
	}
}

/**
 * Encode a 32-bit BL instruction for ARM Thumb
 *
 * Format:
 * hw1: 11110 S imm10
 * hw2: 11 J1 1 J2 imm11
 *
 * The target is calculated as:
 * target = PC + signExtend(S:I1:I2:imm10:imm11:0)
 *
 * Where I1 = NOT(J1 XOR S), I2 = NOT(J2 XOR S)
 *
 * The bit layout of imm25 is:
 *   [24]    [23]    [22]    [21:12]      [11:0]
 *   S       I1      I2      imm10        imm11
 *
 * Range: ±16MB (±16777216 bytes)
 */
export function encodeBl(fromAddr: number, toAddr: number): Uint8Array {
	const offset = toAddr - (fromAddr + 4);

	// BL range is ±16MB
	if (offset > 16777214 || offset < -16777216) {
		throw new ThumbEncodingError(`BL offset out of range: ${offset}`);
	}

	// Get 25-bit value (offset >> 1 because Thumb is 16-bit aligned)
	// Use unsigned AND to get the lower 25 bits (matches Python implementation)
	const imm25 = (offset >> 1) & 0x1FFFFFF;

	// Sign bit based on original offset (not imm25) - matches Python implementation
	const S = offset < 0 ? 1 : 0;

	// Extract components from 25-bit value
	// imm10 = bits [21:12] (10 bits)
	const imm10 = (imm25 >> 12) & 0x3ff;
	// imm11 = bits [11:1] (11 bits) - note: shift right by 1 to skip bit 0
	const imm11 = (imm25 >> 1) & 0x7ff;
	// I1, I2 = sign extension bits [23:22]
	const I1 = (imm25 >> 23) & 1;
	const I2 = (imm25 >> 22) & 1;

	// J1 = NOT(S XOR I1), J2 = NOT(S XOR I2)
	const J1 = (~(S ^ I1)) & 1;
	const J2 = (~(S ^ I2)) & 1;

	// Encode
	const hw1 = 0xf000 | (S << 10) | imm10;
	const hw2 = 0xd000 | (J1 << 13) | (1 << 12) | (J2 << 11) | imm11;

	const blBytes = new Uint8Array([hw1 & 0xff, (hw1 >> 8) & 0xff, hw2 & 0xff, (hw2 >> 8) & 0xff]);

	// CRITICAL: Verify BL encoding is precise
	// Some firmware versions (e.g., V1.8.0 FLAC) have patch addresses that are not 4-byte aligned,
	// causing BL instruction to lose 2 bytes of precision. This MUST be caught before patching.
	const decodedTarget = decodeBlTarget(fromAddr, blBytes);
	if (decodedTarget !== toAddr) {
		const precisionLoss = Math.abs(decodedTarget - toAddr);
		throw new ThumbEncodingError(
			`BL instruction precision loss detected: ` +
			`Expected target 0x${toAddr.toString(16)}, ` +
			`but decodes to 0x${decodedTarget.toString(16)} ` +
			`(${precisionLoss > 0 ? '+' : ''}${precisionLoss} bytes).\n` +
			`This is caused by patch address 0x${fromAddr.toString(16)} not being 4-byte aligned ` +
			`(mod 4 = ${fromAddr % 4}).\n` +
			`Patching this firmware would result in incorrect execution and CANNOT be allowed.`
		);
	}

	return blBytes;
}

/**
 * Encode a 16-bit B instruction for ARM Thumb
 *
 * Format: 11000 imm11
 *
 * Range: ±2048 bytes
 */
export function encodeB16bit(fromAddr: number, toAddr: number): Uint8Array {
	const offset = toAddr - (fromAddr + 4);

	// B range is ±2048 bytes
	if (offset > 2046 || offset < -2048) {
		throw new ThumbEncodingError(`B offset out of range: ${offset}`);
	}

	const imm11 = (offset >> 1) & 0x7ff;
	const opcode = 0xe000 | imm11;

	return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
}

/**
 * Encode a MOVW instruction for ARM Thumb
 *
 * MOVW Rd, #imm16
 * Format: 11110 i 0100 imm4 | 0 imm3 Rd imm8
 */
export function encodeMovw(reg: number, imm16: number): Uint8Array {
	if (reg < 0 || reg > 15) {
		throw new ThumbEncodingError(`Invalid register: R${reg}`);
	}
	if (imm16 < 0 || imm16 > 0xffff) {
		throw new ThumbEncodingError(`Immediate out of range: ${imm16}`);
	}

	const i = (imm16 >> 11) & 1;
	const imm4 = (imm16 >> 12) & 0xf;
	const imm3 = (imm16 >> 8) & 0x7;
	const imm8 = imm16 & 0xff;

	const hw1 = 0xf240 | (i << 10) | imm4;
	const hw2 = (imm3 << 12) | (reg << 8) | imm8;

	return new Uint8Array([hw1 & 0xff, (hw1 >> 8) & 0xff, hw2 & 0xff, (hw2 >> 8) & 0xff]);
}

/**
 * Encode a MOVT instruction for ARM Thumb
 *
 * MOVT Rd, #imm16 (move top halfword to register)
 * Format: 11110 i 1100 imm4 | 0 imm3 Rd imm8
 */
export function encodeMovt(reg: number, imm16: number): Uint8Array {
	if (reg < 0 || reg > 15) {
		throw new ThumbEncodingError(`Invalid register: R${reg}`);
	}
	if (imm16 < 0 || imm16 > 0xffff) {
		throw new ThumbEncodingError(`Immediate out of range: ${imm16}`);
	}

	const i = (imm16 >> 11) & 1;
	const imm4 = (imm16 >> 12) & 0xf;
	const imm3 = (imm16 >> 8) & 0x7;
	const imm8 = imm16 & 0xff;

	const hw1 = 0xf2c0 | (i << 10) | imm4;
	const hw2 = (imm3 << 12) | (reg << 8) | imm8;

	return new Uint8Array([hw1 & 0xff, (hw1 >> 8) & 0xff, hw2 & 0xff, (hw2 >> 8) & 0xff]);
}

/**
 * Encode a PUSH instruction for ARM Thumb
 *
 * PUSH {registers}
 * Can include low registers (R0-R7) and optionally LR
 */
export function encodePush(regs: number[]): Uint8Array {
	for (const r of regs) {
		if (r < 0 || r > 14) {
			throw new ThumbEncodingError(`Invalid register for PUSH: R${r}`);
		}
	}

	let regList = 0;
	let hasLr = false;
	for (const r of regs) {
		if (r === 14) {
			hasLr = true;
		} else if (r >= 0 && r <= 7) {
			regList |= 1 << r;
		}
	}

	// ARM Thumb PUSH encoding:
	// PUSH {Rlist}     = 0xB400 | regList  (R0-R7 only)
	// PUSH {Rlist, LR} = 0xB500 | regList  (R0-R7 + LR)
	// 16-bit instruction in little-endian: [low_byte, high_byte]
	const opcode = hasLr ? (0xb500 | regList) : (0xb400 | regList);
	return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
}

/**
 * Encode a POP instruction for ARM Thumb
 *
 * POP {registers}
 * Can include low registers (R0-R7) and optionally PC
 */
export function encodePop(regs: number[]): Uint8Array {
	for (const r of regs) {
		if (r < 0 || r > 15) {
			throw new ThumbEncodingError(`Invalid register for POP: R${r}`);
		}
	}

	let regList = 0;
	let hasPc = false;
	for (const r of regs) {
		if (r === 15) {
			hasPc = true;
		} else if (r >= 0 && r <= 7) {
			regList |= 1 << r;
		}
	}

	// ARM Thumb POP encoding:
	// POP {Rlist}    = 0xBC00 | regList  (R0-R7 only)
	// POP {Rlist, PC} = 0xBD00 | regList  (R0-R7 + PC)
	// 16-bit instruction in little-endian: [low_byte, high_byte]
	const opcode = hasPc ? (0xbd00 | regList) : (0xbc00 | regList);
	return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
}

/**
 * Encode a BX instruction for ARM Thumb
 *
 * BX Rm
 */
export function encodeBx(reg: number): Uint8Array {
	if (reg < 0 || reg > 14) {
		throw new ThumbEncodingError(`Invalid register for BX: R${reg}`);
	}

	const opcode = 0x4700 | (reg << 3);
	return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
}

/**
 * Encode a MOV (register) instruction for ARM Thumb
 *
 * MOV Rd, Rm (with high registers support)
 */
export function encodeMov(rd: number, rm: number): Uint8Array {
	if (rd < 0 || rd > 15 || rm < 0 || rm > 15) {
		throw new ThumbEncodingError(`Invalid registers for MOV: R${rd}, R${rm}`);
	}

	// For low registers, use MOV Rd, Rm
	if (rd <= 7 && rm <= 7) {
		const opcode = 0x1c00 | (rm << 3) | rd;
		return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
	}

	// For high registers, use special encoding
	// MOV Rd, Rm where Rd or Rm is high: 0100 0101 D Rm / 0000 Rd
	const d = (rd >> 3) & 0x1;
	const opcode = 0x4400 | (d << 7) | (rm << 3) | (rd & 0x7);
	return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
}

/**
 * Encode a STRH instruction for ARM Thumb
 *
 * STRH Rt, [Rn, #imm]
 */
export function encodeStrh(rt: number, rn: number, offset: number): Uint8Array {
	if (rt < 0 || rt > 15 || rn < 0 || rn > 15) {
		throw new ThumbEncodingError(`Invalid registers for STRH: R${rt}, R${rn}`);
	}
	if (offset < 0 || offset > 1020 || offset % 2 !== 0) {
		throw new ThumbEncodingError(`Invalid offset for STRH: ${offset}`);
	}

	// Check if we can use 5-bit immediate encoding (offset / 2)
	if (offset <= 62 && rn <= 7) {
		const opcode = 0x8000 | ((offset / 2) << 6) | (rn << 3) | rt;
		return new Uint8Array([opcode & 0xff, (opcode >> 8) & 0xff]);
	}

	// Otherwise need to use STRH.W (32-bit)
	return encodeStrhWide(rt, rn, offset);
}

/**
 * Encode a STRH.W instruction (32-bit) for ARM Thumb
 *
 * STRH.W Rt, [Rn, #imm]
 */
export function encodeStrhWide(rt: number, rn: number, offset: number): Uint8Array {
	if (rt < 0 || rt > 15 || rn < 0 || rn > 15) {
		throw new ThumbEncodingError(`Invalid registers for STRH.W: R${rt}, R${rn}`);
	}
	if (offset < 0 || offset > 0xfff) {
		throw new ThumbEncodingError(`Invalid offset for STRH.W: ${offset}`);
	}

	const hw1 = 0xf820 | (rn & 0xf);
	const hw2 = (0xc << 12) | (rt << 12) | offset;

	return new Uint8Array([hw1 & 0xff, (hw1 >> 8) & 0xff, hw2 & 0xff, (hw2 >> 8) & 0xff]);
}

/**
 * Encode a NOP instruction for ARM Thumb
 *
 * NOP can be encoded as:
 * - 16-bit: MOV R8, R8 (0x46c0)
 * - 16-bit: NOP hint in IT block (0xbf00)
 */
export function encodeNop(): Uint8Array {
	return new Uint8Array([0x00, 0xbf]);
}

/**
 * Encode an unconditional branch to label
 *
 * B label
 * This creates a B instruction that branches to the specified target
 */
export function encodeBranch(fromAddr: number, toAddr: number): Uint8Array {
	return encodeB16bit(fromAddr, toAddr);
}

/**
 * Create a relative BL instruction
 *
 * Creates a BL instruction that branches to an address relative to the current position
 */
export function createRelativeBl(fromAddr: number, relativeOffset: number): Uint8Array {
	return encodeBl(fromAddr, fromAddr + 4 + relativeOffset);
}

/**
 * Calculate the BL target address from encoded bytes
 *
 * Decodes a BL instruction and returns the target address
 */
export function decodeBlTarget(fromAddr: number, blBytes: Uint8Array): number {
	if (blBytes.length !== 4) {
		throw new ThumbEncodingError(`Invalid BL instruction length: ${blBytes.length}`);
	}

	const hw1 = blBytes[0] | (blBytes[1] << 8);
	const hw2 = blBytes[2] | (blBytes[3] << 8);

	// Verify this is a BL instruction
	if ((hw1 & 0xf800) !== 0xf000 || (hw2 & 0xd000) !== 0xd000) {
		throw new ThumbEncodingError(`Not a BL instruction: hw1=0x${hw1.toString(16)}, hw2=0x${hw2.toString(16)}`);
	}

	const S = (hw1 >> 10) & 1;
	const imm10 = hw1 & 0x3ff;
	const J1 = (hw2 >> 13) & 1;
	const J2 = (hw2 >> 11) & 1;
	const imm11 = hw2 & 0x7ff;

	const I1 = (~(J1 ^ S)) & 1;
	const I2 = (~(J2 ^ S)) & 1;

	// Reconstruct offset
	// BL encoding stores offset as (offset >> 1) where offset is the byte difference
	// The encoding format is: S:I1:I2:imm10:imm11 where imm11 is bits [11:1] of offset >> 1
	// So imm11 needs to be placed at bits [11:1], meaning we shift left by 1
	const imm25 = (S << 24) | (I1 << 23) | (I2 << 22) | (imm10 << 12) | (imm11 << 1);

	// Sign extend imm25 from 25 bits to 32 bits
	let imm32: number;
	if (S) {
		// Negative offset: sign extend by setting upper bits
		imm32 = imm25 | 0xfe000000; // Set bits [31:25] to 1
	} else {
		// Positive offset: upper bits are already 0
		imm32 = imm25;
	}

	// Convert to signed 32-bit
	if (imm32 & 0x80000000) {
		imm32 = imm32 - 0x100000000;
	}

	// Calculate target: from + 4 + (imm32 << 1)
	// imm32 already contains (offset >> 1), so we shift left to get the actual offset
	return fromAddr + 4 + (imm32 << 1);
}

/**
 * Verify that a BL instruction is correctly encoded
 *
 * Returns true if the BL instruction, when decoded, branches to the expected target
 */
export function verifyBlEncoding(fromAddr: number, toAddr: number, blBytes: Uint8Array): boolean {
	try {
		const decodedTarget = decodeBlTarget(fromAddr, blBytes);
		return decodedTarget === toAddr;
	} catch {
		return false;
	}
}
