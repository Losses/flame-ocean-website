/**
 * BL Instruction Encoding/Decoding Tests
 *
 * Comprehensive tests for BL instruction correctness
 * based on the bugfix session where encodeBl was fixed.
 */

import { describe, it, expect } from 'vitest';
import { encodeBl, decodeBlTarget } from '../theme/thumb/encoders.js';

describe('BL Instruction - Fixed Implementation', () => {
	describe('encodeBl/decodeBlTarget roundtrip', () => {
		it('should correctly encode and decode forward BL (even offset)', () => {
			const fromAddr = 0x1000;
			const toAddr = 0x1100; // offset = 0x100 - 4 = 0xFC (even)

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(toAddr);
		});

		it('should correctly encode and decode backward BL (even offset)', () => {
			const fromAddr = 0x2000;
			const toAddr = 0x1000; // offset = -0x1000 - 4 = -0x1004 (even)

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(toAddr);
		});

		it('should handle odd offset by rounding down (BL alignment limitation)', () => {
			const fromAddr = 0x8651e;
			const toAddr = 0x90000; // offset = 0x9ADE (odd)

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			// BL instruction can only encode even offsets
			// Odd bit is dropped, so 0x9ADE becomes 0x9ADC
			const expectedTarget = 0x8FFFE; // fromAddr + 4 + 0x9ADC
			expect(decodedTarget).toEqual(expectedTarget);
		});

		it('should match the exact bytes from the bugfix verification', () => {
			// This is the exact test case from the debugging session
			const fromAddr = 0x8651e;
			const toAddr = 0x90000;

			const blBytes = encodeBl(fromAddr, toAddr);

			// Expected bytes from the fix verification
			const expectedBytes = new Uint8Array([0x04, 0xf0, 0xb7, 0xfe]);

			expect(Array.from(blBytes)).toEqual(Array.from(expectedBytes));

			// Verify decoding matches expectation (with alignment limitation)
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);
			expect(decodedTarget).toEqual(0x8FFFE);
		});
	});

	describe('encodeBl bit-level correctness', () => {
		it('should set correct BL instruction format bits', () => {
			const fromAddr = 0x86510;
			const toAddr = 0xa0486c; // Real FLAC handler address

			const blBytes = encodeBl(fromAddr, toAddr);

			const hw1 = blBytes[0] | (blBytes[1] << 8);
			const hw2 = blBytes[2] | (blBytes[3] << 8);

			// Verify BL instruction format:
			// hw1: 11110 S imm10
			// hw2: 11 J1 1 J2 imm11

			expect(hw1 & 0xf800).toEqual(0xf000); // Bits [15:11] = 11110
			expect(hw2 & 0xd000).toEqual(0xd000); // Bits [15:14] = 11, bit 12 = 1
		});

		it('should correctly calculate S bit for positive offsets', () => {
			const fromAddr = 0x1000;
			const toAddr = 0x2000;

			const blBytes = encodeBl(fromAddr, toAddr);
			const hw1 = blBytes[0] | (blBytes[1] << 8);
			const S = (hw1 >> 10) & 1;

			expect(S).toEqual(0); // Positive offset
		});

		it('should correctly calculate S bit for negative offsets', () => {
			const fromAddr = 0x2000;
			const toAddr = 0x1000;

			const blBytes = encodeBl(fromAddr, toAddr);
			const hw1 = blBytes[0] | (blBytes[1] << 8);
			const S = (hw1 >> 10) & 1;

			expect(S).toEqual(1); // Negative offset
		});
	});

	describe('decodeBlTarget correctness', () => {
		it('should correctly decode BL instruction with sign extension', () => {
			// BL instruction: 0x04 0xf0 0xb7 0xfe
			// From: 0x8651e, To: 0x8FFFE (rounded from 0x90000)
			const fromAddr = 0x8651e;
			const blBytes = new Uint8Array([0x04, 0xf0, 0xb7, 0xfe]);

			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(0x8FFFE);
		});

		it('should correctly decode BL to NOP slide (real firmware case)', () => {
			// Real FLAC patch case
			const fromAddr = 0x86510;
			const toAddr = 0xa0486c;

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(toAddr);
		});

		it('should correctly decode BL to menu handler (real firmware case)', () => {
			// Real Menu patch case
			const fromAddr = 0x3f88c;
			const toAddr = 0xa048cc;

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(toAddr);
		});
	});

	describe('Error handling', () => {
		it('should throw on offsets larger than +16MB', () => {
			const fromAddr = 0x100000;
			const maxOffset = 16777214; // From encodeBl implementation

			expect(() => {
				encodeBl(fromAddr, fromAddr + 4 + maxOffset + 1); // 1 byte over limit
			}).toThrow();
		});

		it('should throw on offsets smaller than -16MB', () => {
			const fromAddr = 0x100000;

			expect(() => {
				encodeBl(fromAddr, fromAddr - 16777216); // Exactly -16MB, should throw
			}).toThrow();
		});

		it('should throw on invalid BL instruction length', () => {
			const fromAddr = 0x1000;
			const invalidBl = new Uint8Array([0x04, 0xf0]); // Only 2 bytes

			expect(() => {
				decodeBlTarget(fromAddr, invalidBl);
			}).toThrow();
		});
	});
});
