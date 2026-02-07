/**
 * Tests for binary data utilities
 * These tests verify that the TypeScript implementation matches Python's struct module behavior
 */

import { describe, it, expect } from 'vitest';
import {
	readU8,
	readU16LE,
	readU16BE,
	readU32LE,
	readU32BE,
	readI32LE,
	readI32BE,
	unpack,
	writeU16LE,
	writeU32LE,
	writeU32BE,
	findBytes,
	concat,
	BinaryReader
} from '../utils/struct.js';

describe('BinaryReader', () => {
	describe('readU8', () => {
		it('should read unsigned 8-bit integer', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			expect(readU8(data, 0)).toBe(0x12);
			expect(readU8(data, 1)).toBe(0x34);
			expect(readU8(data, 3)).toBe(0x78);
		});

		it('should throw for out of bounds', () => {
			const data = new Uint8Array([0x12, 0x34]);
			expect(() => readU8(data, 2)).toThrow();
		});
	});

	describe('readU16LE', () => {
		it('should read unsigned 16-bit little-endian integer', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			expect(readU16LE(data, 0)).toBe(0x3412);
			expect(readU16LE(data, 2)).toBe(0x7856);
		});

		it('should handle boundary values', () => {
			const data = new Uint8Array([0xff, 0xff]);
			expect(readU16LE(data, 0)).toBe(0xffff);
		});
	});

	describe('readU16BE', () => {
		it('should read unsigned 16-bit big-endian integer', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			expect(readU16BE(data, 0)).toBe(0x1234);
			expect(readU16BE(data, 2)).toBe(0x5678);
		});
	});

	describe('readU32LE', () => {
		it('should read unsigned 32-bit little-endian integer', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef]);
			expect(readU32LE(data, 0)).toBe(0x78563412);
			expect(readU32LE(data, 4)).toBe(0xefcdab90);
		});

		it('should handle boundary values', () => {
			const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
			expect(readU32LE(data, 0)).toBe(0xffffffff);
		});
	});

	describe('readU32BE', () => {
		it('should read unsigned 32-bit big-endian integer', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef]);
			expect(readU32BE(data, 0)).toBe(0x12345678);
			expect(readU32BE(data, 4)).toBe(0x90abcdef);
		});
	});

	describe('readI32LE', () => {
		it('should read signed 32-bit little-endian integer', () => {
			const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
			expect(readI32LE(data, 0)).toBe(-1);

			const data2 = new Uint8Array([0x00, 0x00, 0x00, 0x80]);
			expect(readI32LE(data2, 0)).toBe(-2147483648);
		});

		it('should read positive values', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			expect(readI32LE(data, 0)).toBe(0x78563412);
		});
	});

	describe('readI32BE', () => {
		it('should read signed 32-bit big-endian integer', () => {
			const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
			expect(readI32BE(data, 0)).toBe(-1);

			const data2 = new Uint8Array([0x80, 0x00, 0x00, 0x00]);
			expect(readI32BE(data2, 0)).toBe(-2147483648);
		});
	});

	describe('unpack', () => {
		it('should unpack multiple values', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef]);
			const result = unpack(data, 0, ['I', 'I']);
			expect(result).toEqual([0x78563412, 0xefcdab90]);
		});

		it('should handle mixed formats', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90, 0xab]);
			const result = unpack(data, 0, ['H', 'I', 'H']);
			expect(result).toEqual([0x3412, 0x78563490, 0xab]);
		});
	});

	describe('write functions', () => {
		it('should write U16LE correctly', () => {
			const result = writeU16LE(0x1234);
			expect(result[0]).toBe(0x34);
			expect(result[1]).toBe(0x12);
		});

		it('should write U32LE correctly', () => {
			const result = writeU32LE(0x12345678);
			expect(result[0]).toBe(0x78);
			expect(result[1]).toBe(0x56);
			expect(result[2]).toBe(0x34);
			expect(result[3]).toBe(0x12);
		});

		it('should write U32BE correctly', () => {
			const result = writeU32BE(0x12345678);
			expect(result[0]).toBe(0x12);
			expect(result[1]).toBe(0x34);
			expect(result[2]).toBe(0x56);
			expect(result[3]).toBe(0x78);
		});
	});

	describe('findBytes', () => {
		it('should find byte pattern', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90, 0x56, 0x78]);
			const pattern = new Uint8Array([0x56, 0x78]);
			expect(findBytes(data, pattern)).toBe(2);
		});

		it('should return -1 if not found', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56]);
			const pattern = new Uint8Array([0x78, 0x9a]);
			expect(findBytes(data, pattern)).toBe(-1);
		});

		it('should support start offset', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90]);
			const pattern = new Uint8Array([0x12]);
			expect(findBytes(data, pattern, 2)).toBe(-1);
		});
	});

	describe('concat', () => {
		it('should concatenate arrays', () => {
			const a = new Uint8Array([0x12, 0x34]);
			const b = new Uint8Array([0x56, 0x78]);
			const result = concat(a, b);
			expect(result).toEqual(new Uint8Array([0x12, 0x34, 0x56, 0x78]));
		});

		it('should handle empty arrays', () => {
			const a = new Uint8Array([0x12, 0x34]);
			const result = concat(a, new Uint8Array(0));
			expect(result).toEqual(new Uint8Array([0x12, 0x34]));
		});
	});

	describe('BinaryReader class', () => {
		it('should read values correctly', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			const reader = new BinaryReader(data);

			expect(reader.readU8(0)).toBe(0x12);
			expect(reader.readU16LE(0)).toBe(0x3412);
			expect(reader.readU32LE(0)).toBe(0x78563412);
		});

		it('should slice correctly', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90]);
			const reader = new BinaryReader(data);
			const sliced = reader.slice(1, 4);

			expect(sliced.length).toBe(3);
			expect(sliced.readU8(0)).toBe(0x34);
		});

		it('should find patterns', () => {
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90]);
			const reader = new BinaryReader(data);
			const pattern = new Uint8Array([0x56, 0x78]);

			expect(reader.find(pattern)).toBe(2);
		});
	});
});

// Tests comparing to Python struct behavior
describe('Python struct compatibility', () => {
	describe('<I format (unsigned 32-bit LE)', () => {
		it('should match Python struct.unpack("<I", data)', () => {
			// Python: struct.unpack("<I", b"\x12\x34\x56\x78")[0] == 0x78563412
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			expect(readU32LE(data, 0)).toBe(0x78563412);
		});
	});

	describe('<H format (unsigned 16-bit LE)', () => {
		it('should match Python struct.unpack("<H", data)', () => {
			// Python: struct.unpack("<H", b"\x12\x34")[0] == 0x3412
			const data = new Uint8Array([0x12, 0x34]);
			expect(readU16LE(data, 0)).toBe(0x3412);
		});
	});

	describe('<i format (signed 32-bit LE)', () => {
		it('should match Python struct.unpack("<i", data)', () => {
			// Python: struct.unpack("<i", b"\xff\xff\xff\xff")[0] == -1
			const data = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
			expect(readI32LE(data, 0)).toBe(-1);
		});
	});

	describe('>I format (unsigned 32-bit BE)', () => {
		it('should match Python struct.unpack(">I", data)', () => {
			// Python: struct.unpack(">I", b"\x12\x34\x56\x78")[0] == 0x12345678
			const data = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
			expect(readU32BE(data, 0)).toBe(0x12345678);
		});
	});
});
