/**
 * ARM Thumb Instruction Type Definitions
 */

/**
 * Instruction type enum - all supported ARM Thumb instruction types
 */
export enum InstructionType {
	// Data processing
	MOVW = 'MOVW',
	MOVT = 'MOVT',
	MOVS = 'MOVS',
	MVN = 'MVN',
	ADD = 'ADD',
	SUB = 'SUB',
	AND = 'AND',
	ORR = 'ORR',
	EOR = 'EOR',
	LSL = 'LSL',
	LSR = 'LSR',
	ASR = 'ASR',
	ROR = 'ROR',
	ADC = 'ADC',
	SBC = 'SBC',
	RSB = 'RSB',
	TST = 'TST',
	TEQ = 'TEQ',
	CMP = 'CMP',
	CMN = 'CMN',
	MUL = 'MUL',

	// Branches
	B = 'B',
	BL = 'BL',
	BX = 'BX',
	BLX = 'BLX',
	BEQ = 'BEQ',
	BNE = 'BNE',
	CBZ = 'CBZ',
	CBNZ = 'CBNZ',
	BIC = 'BIC',

	// Conditional execution
	IT = 'IT',

	// Loads and stores
	LDR = 'LDR',
	LDRB = 'LDRB',
	LDRH = 'LDRH',
	LDRSB = 'LDRSB',
	LDRSH = 'LDRSH',
	LDRD = 'LDRD',
	STR = 'STR',
	STRH = 'STRH',
	STRB = 'STRB',
	STRD = 'STRD',
	STRH_W = 'STRH_W',
	LDRD_W = 'LDRD_W',
	LDR_W = 'LDR_W',
	LDRB_W = 'LDRB_W',
	LDREX = 'LDREX',
	STREX = 'STREX',

	// Stack operations
	PUSH = 'PUSH',
	POP = 'POP',

	// Literal loads
	LDR_LIT = 'LDR_LIT',
	LDRB_LIT = 'LDRB_LIT',
	LDRH_LIT = 'LDRH_LIT',

	// Special
	NOP = 'NOP',
	WFI = 'WFI',
	WFE = 'WFE',
	YIELD = 'YIELD',
	SEV = 'SEV',
	UDF = 'UDF',
	BKPT = 'BKPT',
	SVC = 'SVC',

	// Address loading
	ADR = 'ADR',

	// Unknown
	UNKNOWN = 'UNKNOWN'
}

/**
 * Condition codes for ARM instructions
 */
export const CONDITION_CODES = [
	'EQ', // Equal
	'NE', // Not equal
	'CS', // Carry set (unsigned higher or same)
	'CC', // Carry clear (unsigned lower)
	'MI', // Minus (negative)
	'PL', // Plus (positive or zero)
	'VS', // Overflow
	'VC', // No overflow
	'HI', // Unsigned higher
	'LS', // Unsigned lower or same
	'GE', // Signed greater than or equal
	'LT', // Signed less than
	'GT', // Signed greater than
	'LE', // Signed less than or equal
	'AL'  // Always
] as const;

export type ConditionCode = typeof CONDITION_CODES[number];

/**
 * Register names for ARM
 */
export const REGISTERS = [
	'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7',
	'R8', 'R9', 'R10', 'R11', 'R12', 'SP', 'LR', 'PC'
] as const;

export type Register = typeof REGISTERS[number];
export type RegisterNumber = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/**
 * Decoded instruction interface
 */
export interface Instruction {
	/** Address in firmware */
	readonly addr: number;
	/** Raw instruction bytes */
	readonly rawBytes: Readonly<Uint8Array>;
	/** Instruction mnemonic */
	readonly mnemonic: string;
	/** Operands string */
	readonly operands: string;
	/** Instruction type */
	readonly instrType: InstructionType;
	/** Destination register (-1 if not applicable) */
	readonly rd: number;
	/** Base register (-1 if not applicable) */
	readonly rn: number;
	/** Source register (-1 if not applicable) */
	readonly rm: number;
	/** Immediate value */
	readonly imm: number;
	/** Condition code (-1 if not applicable) */
	readonly cond: number;
	/** IT block mask (for IT instructions) */
	readonly itMask: number;
	/** Branch target address (0 if not a branch) */
	readonly branchTarget: number;
	/** Instruction size in bytes (2 or 4) */
	readonly size: number;
}

/**
 * Create an instruction object with default values
 */
export function createInstruction(
	addr: number,
	rawBytes: Uint8Array,
	mnemonic: string,
	operands: string,
	instrType: InstructionType,
	options: {
		rd?: number;
		rn?: number;
		rm?: number;
		imm?: number;
		cond?: number;
		itMask?: number;
		branchTarget?: number;
		size?: number;
	} = {}
): Instruction {
	const {
		rd = -1,
		rn = -1,
		rm = -1,
		imm = 0,
		cond = -1,
		itMask = 0,
		branchTarget = 0,
		size = rawBytes.length
	} = options;

	return {
		addr,
		rawBytes,
		mnemonic,
		operands,
		instrType,
		rd,
		rn,
		rm,
		imm,
		cond,
		itMask,
		branchTarget,
		size
	};
}

/**
 * Check if two instructions are equal
 */
export function instructionsEqual(a: Instruction, b: Instruction): boolean {
	return (
		a.addr === b.addr &&
		a.mnemonic === b.mnemonic &&
		a.operands === b.operands &&
		a.instrType === b.instrType
	);
}
