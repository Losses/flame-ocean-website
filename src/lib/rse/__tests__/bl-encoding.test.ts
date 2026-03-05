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

		it('should correctly encode and decode even offset (BL alignment)', () => {
			const fromAddr = 0x8651e;
			const toAddr = 0x90000; // offset = 0x9ADE (even)

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			// BL instruction encodes even offsets correctly
			expect(decodedTarget).toEqual(toAddr);
		});

		it('should throw on odd offset (BL alignment limitation)', () => {
			const fromAddr = 0x8651e;
			const toAddr = 0x90001; // offset = 0x9ADF (odd)

			// BL instruction cannot encode odd offsets
			expect(() => encodeBl(fromAddr, toAddr)).toThrow('BL offset must be even');
		});

		it('should produce correct bytes for real-world offset', () => {
			// Test case from the debugging session
			const fromAddr = 0x8651e;
			const toAddr = 0x90000;

			const blBytes = encodeBl(fromAddr, toAddr);

			// Verify the bytes decode back to the correct target
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);
			expect(decodedTarget).toEqual(toAddr);
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
		it('should correctly decode BL instruction with positive offset', () => {
			// Test encoding/decoding roundtrip with positive offset
			const fromAddr = 0x8651e;
			const toAddr = 0x90000;

			const blBytes = encodeBl(fromAddr, toAddr);
			const decodedTarget = decodeBlTarget(fromAddr, blBytes);

			expect(decodedTarget).toEqual(toAddr);
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
