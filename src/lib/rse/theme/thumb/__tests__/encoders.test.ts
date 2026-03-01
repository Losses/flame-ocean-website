/**
 * Unit tests for ARM Thumb instruction encoders
 *
 * These tests verify that encoder output matches DDI0403 specification
 * and is correctly decoded by the decoder.
 */

import { describe, it, expect } from 'vitest';
import {
	encodeMovw, encodeMovt, encodeBl, encodePush, encodePop,
	encodeStrh, encodeStrhWide, encodeBx, encodeMov
} from '../encoders.js';
import { ThumbDecoder, isMovwInstruction, readMovwImmediate } from '../decoder.js';

describe('MOVW/MOVT Encoders', () => {
	it('should encode MOVW R4, #0x1111 correctly', () => {
		const encoded = encodeMovw(4, 0x1111);
		const bytes = Array.from(encoded);

		// imm16 = 0x1111
		//   i    = bit[11] = 0
		//   imm4 = bits[15:12] = 1
		//   imm3 = bits[10:8] = 1
		//   imm8 = bits[7:0] = 0x11
		// hw1 = 0xF240 | (0<<10) | 1 = 0xF241
		// hw2 = (1<<12) | (4<<8) | 0x11 = 0x1411
		// Bytes (little-endian): 0x41 0xF2 0x11 0x14
		expect(bytes[0]).toBe(0x41);
		expect(bytes[1]).toBe(0xF2);
		expect(bytes[2]).toBe(0x11);
		expect(bytes[3]).toBe(0x14);
	});

	it('should encode MOVW R8, #0xFFFF correctly', () => {
		const encoded = encodeMovw(8, 0xFFFF);
		const bytes = Array.from(encoded);

		// imm16 = 0xFFFF
		//   i    = bit[11] = 1
		//   imm4 = bits[15:12] = 0xF
		//   imm3 = bits[10:8] = 0x7
		//   imm8 = bits[7:0] = 0xFF
		// hw1 = 0xF240 | (1<<10) | 0xF = 0xF64F
		// hw2 = (7<<12) | (8<<8) | 0xFF = 0x78FF
		// Bytes: 0x4F 0xF6 0xFF 0x78
		expect(bytes[0]).toBe(0x4F);
		expect(bytes[1]).toBe(0xF6);
		expect(bytes[2]).toBe(0xFF);
		expect(bytes[3]).toBe(0x78);
	});

	it('should encode MOVT R4, #0x0000 correctly', () => {
		const encoded = encodeMovt(4, 0x0000);
		const bytes = Array.from(encoded);

		// hw1 = 0xF2C0 | (0<<10) | 0 = 0xF2C0
		// hw2 = (0<<12) | (4<<8) | 0x00 = 0x0400
		expect(bytes[0]).toBe(0xC0);
		expect(bytes[1]).toBe(0xF2);
		expect(bytes[2]).toBe(0x00);
		expect(bytes[3]).toBe(0x04);
	});

	it('should encode MOVT R8, #0xABCD correctly', () => {
		const encoded = encodeMovt(8, 0xABCD);
		const bytes = Array.from(encoded);

		// imm16 = 0xABCD
		//   i    = bit[11] = 1
		//   imm4 = bits[15:12] = 0xA
		//   imm3 = bits[10:8] = 0x3  (0xBCD >> 8 = 0xB, 0xB & 7 = 3)
		//   imm8 = bits[7:0] = 0xCD
		// hw1 = 0xF2C0 | (1<<10) | 0xA = 0xF6CA
		// hw2 = (3<<12) | (8<<8) | 0xCD = 0x38CD
		// Bytes: 0xCA 0xF6 0xCD 0x38
		expect(bytes[0]).toBe(0xCA);
		expect(bytes[1]).toBe(0xF6);
		expect(bytes[2]).toBe(0xCD);
		expect(bytes[3]).toBe(0x38);
	});

	it('MOVW and MOVT should be decodable', () => {
		const movw = encodeMovw(4, 0x1234);
		const movt = encodeMovt(4, 0xABCD);

		// Test MOVW detection and decoding
		expect(isMovwInstruction(movw, 0)).toBe(true);

		const movwImm = readMovwImmediate(movw, 0);
		expect(movwImm).toBe(0x1234);

		// Test with decoder
		const decoder = new ThumbDecoder(movw);
		const movwInsn = decoder.decode(0);
		expect(movwInsn.mnemonic).toBe('MOVW');
		expect(movwInsn.imm).toBe(0x1234);
		expect(movwInsn.rd).toBe(4);

		const decoder2 = new ThumbDecoder(movt);
		const movtInsn = decoder2.decode(0);
		expect(movtInsn.mnemonic).toBe('MOVT');
		expect(movtInsn.imm).toBe(0xABCD << 16); // MOVT imm is shifted
		expect(movtInsn.rd).toBe(4);
	});
});

describe('BL Encoder/Decoder', () => {
	it('should encode BL with positive offset', () => {
		const fromAddr = 0x1000;
		const toAddr = 0x1008; // offset = 4
		const encoded = encodeBl(fromAddr, toAddr);

		// Verify it's a valid BL instruction
		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);
		expect(insn.mnemonic).toBe('BL');
		// branchTarget is the raw signed offset (imm32)
		// from=0x1000 to=0x1008, offset = toAddr - (fromAddr+4) = 4
		expect(insn.branchTarget).toBe(4);
	});

	it('should encode BL with large offset', () => {
		const fromAddr = 0x1000;
		const toAddr = 0x2000; // offset = 0xFFC
		const encoded = encodeBl(fromAddr, toAddr);

		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);
		expect(insn.mnemonic).toBe('BL');
		expect(insn.branchTarget).toBe(0xFFC);
	});

	it('should encode BL with negative offset', () => {
		const fromAddr = 0x2000;
		const toAddr = 0x1000; // offset = -0x1004
		const encoded = encodeBl(fromAddr, toAddr);

		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);
		expect(insn.mnemonic).toBe('BL');
		expect(insn.branchTarget).toBe(-0x1004);
	});

	it('encoder and decoder should be symmetric for BL', () => {
		const testCases = [
			{ from: 0x1000, to: 0x1008 },
			{ from: 0x1000, to: 0x2000 },
			{ from: 0x2000, to: 0x1000 },
			{ from: 0x86510, to: 0x6D8A28 }, // Real firmware example
		];

		for (const { from, to } of testCases) {
			const encoded = encodeBl(from, to);
			const decoder = new ThumbDecoder(encoded);
			const insn = decoder.decode(0);

			// Calculate expected relative offset
			const expectedOffset = to - (from + 4);
			expect(insn.branchTarget).toBe(expectedOffset);
		}
	});
});

describe('STRH.W Encoder', () => {
	it('should encode STRH.W correctly', () => {
		const encoded = encodeStrhWide(0, 1, 0x10);
		const bytes = Array.from(encoded);

		// hw1 = 0xF8A0 | 1 = 0xF8A1
		// hw2 = (0<<12) | 0x10 = 0x0010
		// Bytes: 0xA1 0xF8 0x10 0x00
		expect(bytes[0]).toBe(0xA1);
		expect(bytes[1]).toBe(0xF8);
		expect(bytes[2]).toBe(0x10);
		expect(bytes[3]).toBe(0x00);
	});

	it('STRH.W should be decodable', () => {
		const encoded = encodeStrhWide(5, 3, 0x123);
		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);

		expect(insn.mnemonic).toBe('STRH.W');
		expect(insn.rd).toBe(5);
		expect(insn.rn).toBe(3);
		expect(insn.imm).toBe(0x123);
	});
});

describe('PUSH/POP Encoders', () => {
	it('should encode PUSH {R4-R7, LR}', () => {
		const encoded = encodePush([4, 5, 6, 7, 14]);
		const bytes = Array.from(encoded);

		// Base 0xB400 | regList (bits 4-7 = 0xF0) | LR (bit 8 = 0x100)
		// = 0xB400 | 0xF0 | 0x100 = 0xB5F0
		// Bytes: 0xF0 0xB5
		expect(bytes[0]).toBe(0xF0);
		expect(bytes[1]).toBe(0xB5);
	});

	it('should encode POP {R3}', () => {
		const encoded = encodePop([3]);
		const bytes = Array.from(encoded);

		// Base 0xBC00 | regList (bit 3 = 0x08)
		// = 0xBC00 | 0x08 = 0xBC08
		// Bytes: 0x08 0xBC
		expect(bytes[0]).toBe(0x08);
		expect(bytes[1]).toBe(0xBC);
	});

	it('PUSH/POP should be decodable', () => {
		const pushEncoded = encodePush([4, 5, 6, 7, 14]);
		const popEncoded = encodePop([4, 5, 6, 7, 15]); // POP {R4-R7, PC}

		const decoder1 = new ThumbDecoder(pushEncoded);
		const pushInsn = decoder1.decode(0);
		expect(pushInsn.mnemonic).toBe('PUSH');

		const decoder2 = new ThumbDecoder(popEncoded);
		const popInsn = decoder2.decode(0);
		expect(popInsn.mnemonic).toBe('POP');
	});

	it('should reject unsupported high registers in PUSH', () => {
		expect(() => encodePush([8])).toThrow();
		expect(() => encodePush([12])).toThrow();
	});

	it('should reject unsupported high registers in POP', () => {
		expect(() => encodePop([8])).toThrow();
		expect(() => encodePop([14])).toThrow();
	});
});

describe('High Register MOV', () => {
	it('should encode MOV R3, R8', () => {
		const encoded = encodeMov(3, 8);
		const bytes = Array.from(encoded);

		// MOV (register) T1: 0100 0110 D Rm[3:0] Rd[2:0]
		// Rd=3 -> D=0, Rd[2:0]=3
		// Rm=8 -> Rm[3:0]=0b1000
		// opcode = 0100 0110 0 1000 011 = 0x4643
		// Bytes: 0x43 0x46
		expect(bytes[0]).toBe(0x43);
		expect(bytes[1]).toBe(0x46);
	});

	it('should encode MOV R12, R3', () => {
		const encoded = encodeMov(12, 3);
		const bytes = Array.from(encoded);

		// Rd=12 -> D=1, Rd[2:0]=4
		// Rm=3 -> Rm[3:0]=0b0011
		// opcode = 0100 0110 1 0011 100 = 0x469C
		// Bytes: 0x9C 0x46
		expect(bytes[0]).toBe(0x9C);
		expect(bytes[1]).toBe(0x46);
	});

	it('MOV R3, R8 should be decodable', () => {
		const encoded = encodeMov(3, 8);
		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);

		expect(insn.mnemonic).toBe('MOV');
		expect(insn.rd).toBe(3);
		expect(insn.rm).toBe(8);
	});

	it('MOV R12, R3 should be decodable', () => {
		const encoded = encodeMov(12, 3);
		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);

		expect(insn.mnemonic).toBe('MOV');
		expect(insn.rd).toBe(12);
		expect(insn.rm).toBe(3);
	});
});

describe('BX Encoder', () => {
	it('should encode BX LR', () => {
		const encoded = encodeBx(14);
		const bytes = Array.from(encoded);

		// Base 0x4700 | (14 << 3) = 0x4700 | 0x70 = 0x4770
		// Bytes: 0x70 0x47
		expect(bytes[0]).toBe(0x70);
		expect(bytes[1]).toBe(0x47);
	});

	it('BX LR should be decodable', () => {
		const encoded = encodeBx(14);
		const decoder = new ThumbDecoder(encoded);
		const insn = decoder.decode(0);

		expect(insn.mnemonic).toBe('BX');
		expect(insn.rm).toBe(14);
	});
});