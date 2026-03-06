/**
 * Thumb instruction decoding and encoding module
 *
 * Provides ARM Thumb instruction decoder and encoder utilities
 * for firmware analysis and patching.
 */

// Instruction types
export * from './instructions.js';

// Decoder
export { ThumbDecoder, isMovwInstruction, readMovwImmediate } from './decoder.js';

// Encoders
export {
	encodeBl,
	encodeB16bit,
	encodeB32bit,
	encodeMovw,
	encodeMovt,
	encodePush,
	encodePop,
	encodeBx,
	encodeMov,
	encodeStrh,
	encodeStrhWide,
	encodeNop,
	encodeBranch,
	createRelativeBl,
	decodeBlTarget,
	verifyBlEncoding,
	ThumbEncodingError
} from './encoders.js';
