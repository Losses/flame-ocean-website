/**
 * 对比原始代码和 Handler 的颜色值
 */

import { readFileSync } from 'fs';

const WORKING_FILE = '/home/losses/Downloads/mod/DEBUG_FIRMWARE/ver05 - 调整进度文本和播放暂停图标.bin';
const BROKEN_FILE = '/home/losses/Downloads/mod/DEBUG_FIRMWARE/ver14 - 尝试修复播放界面闪退问题.bin';

const working = new Uint8Array(readFileSync(WORKING_FILE));
const broken = new Uint8Array(readFileSync(BROKEN_FILE));

console.log('='.repeat(80));
console.log('对比原始代码和 Handler 的颜色值');
console.log('='.repeat(80));

// 原始代码 (ver05) 的颜色逻辑：
// 当 R1 == 4 时：R1 = 0x44DE，执行 STRH
// 当 R1 != 4 时：R1 = 0xE162，不执行 STRH

console.log('\n原始代码 (ver05) 的颜色逻辑：');
console.log('  主题 4：R1 = 0x44DE，存储到 [R0]');
console.log('  主题 0-3：R1 = 0xE162，不存储');

// Handler (ver14) 的颜色逻辑：
// 从 0x11B200 开始
const handlerAddr = 0x11B200;

console.log('\nHandler (ver14) 的颜色逻辑：');

// 手动解码 handler
let pos = handlerAddr;
const themes: { id: number; color: number }[] = [];

// 跳过 PUSH 和 CMP/BEQ 块
// 找到 theme sections

// theme_4 在 CMP/BEQ 块之后（fall through）
// 让我直接从 handler 字节码中提取颜色

const handlerBytes = broken.slice(handlerAddr, handlerAddr + 100);
console.log('Handler 字节码:');
for (let i = 0; i < 80; i += 16) {
	const hex = Array.from(handlerBytes.slice(i, i + 16)).map(b => b.toString(16).padStart(2, '0')).join(' ');
	console.log(`  ${(handlerAddr + i).toString(16)}: ${hex}`);
}

// 手动提取 MOVW 指令中的颜色值
console.log('\nHandler 中的 MOVW R1, #color 指令：');
pos = handlerAddr;
while (pos < handlerAddr + 80) {
	const hw1 = broken[pos] | (broken[pos + 1] << 8);

	// 检查 MOVW 指令
	if ((hw1 & 0xFBF0) === 0xF240) {
		const hw2 = broken[pos + 2] | (broken[pos + 3] << 8);
		const i = (hw1 >> 10) & 1;
		const imm4 = hw1 & 0xf;
		const imm3 = (hw2 >> 12) & 0x7;
		const rd = (hw2 >> 8) & 0xf;
		const imm8 = hw2 & 0xff;
		const imm16 = (imm4 << 12) | (i << 11) | (imm3 << 8) | imm8;

		if (rd === 1) {
			console.log(`  ${(pos).toString(16)}: MOVW R1, #0x${imm16.toString(16).toUpperCase().padStart(4, '0')}`);

			// 检查下一条是否是 MOVT
			const hw1t = broken[pos + 4] | (broken[pos + 5] << 8);
			if ((hw1t & 0xFBF0) === 0xF2C0) {
				const hw2t = broken[pos + 6] | (broken[pos + 7] << 8);
				const it = (hw1t >> 10) & 1;
				const imm4t = hw1t & 0xf;
				const imm3t = (hw2t >> 12) & 0x7;
				const rdt = (hw2t >> 8) & 0xf;
				const imm8t = hw2t & 0xff;
				const imm16t = (imm4t << 12) | (it << 11) | (imm3t << 8) | imm8t;

				if (rdt === 1) {
					const fullColor = (imm16t << 16) | imm16;
					console.log(`    完整颜色值: 0x${fullColor.toString(16).toUpperCase().padStart(8, '0')}`);
				}
			}
		}
		pos += 4;
	} else {
		pos += 2;
	}
}

// 关键对比
console.log('\n' + '='.repeat(80));
console.log('关键对比');
console.log('='.repeat(80));

console.log('\n原始代码 (ver05) 的行为：');
console.log('  R1 == 4: 存储 0x44DE');
console.log('  R1 != 4: 设置 R1 = 0xE162，但不存储');

console.log('\nHandler (ver14) 的行为：');
console.log('  根据解码结果，Handler 为每个主题设置不同的颜色');
console.log('  然后返回，执行 STRH');

console.log('\n差异分析：');
console.log('  1. 原始代码只在主题 4 时存储颜色');
console.log('  2. Handler 为所有主题存储颜色');
console.log('  3. 颜色值可能不匹配（Handler 使用 patch 时指定的颜色，不是原始颜色）');

// 检查 patch 元数据
console.log('\n' + '='.repeat(80));
console.log('检查 patch 元数据');
console.log('='.repeat(80));

// 搜索 ECHO 元数据
for (let i = 0; i < broken.length - 51; i++) {
	if (broken[i] === 0x45 && broken[i + 1] === 0x43 && broken[i + 2] === 0x48 && broken[i + 3] === 0x4F) {
		console.log(`\nver14 的 ECHO 元数据位置: 0x${i.toString(16).toUpperCase()}`);
		console.log('元数据内容:');
		for (let j = 0; j < 51; j += 16) {
			const hex = Array.from(broken.slice(i + j, i + Math.min(j + 16, 51))).map(b => b.toString(16).padStart(2, '0')).join(' ');
			console.log(`  ${(i + j).toString(16)}: ${hex}`);
		}

		// 解析元数据中的颜色
		// 根据代码，元数据格式是：ECHO + timestamp(4) + flacColors(5*4) + menuColors(15*4)
		const flacColorsStart = i + 4 + 4; // ECHO(4) + timestamp(4)
		console.log('\nFLAC 颜色 (从元数据):');
		for (let t = 0; t < 5; t++) {
			const colorOffset = flacColorsStart + t * 4;
			const color = broken[colorOffset] | (broken[colorOffset + 1] << 8) | (broken[colorOffset + 2] << 16) | (broken[colorOffset + 3] << 24);
			console.log(`  主题 ${t}: 0x${color.toString(16).toUpperCase().padStart(8, '0')}`);
		}
		break;
	}
}

console.log('\n分析完成。');
