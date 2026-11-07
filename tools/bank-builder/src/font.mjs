/**
 * 超星加密字体解密（font-cxsecret）
 *
 * 直接把仓库里的 packages/scripts/src/utils/font-decrypt 打包件注入页面执行：
 *   1. 从页面 @font-face 里取出 font-cxsecret 字体
 *   2. 用 canvas 渲染每个密文字符，与特征表（cdn.ocsjs.com 的 font_ref_cx.bin）比对
 *   3. 把映射应用到 .font-cxsecret 元素上，之后 innerText 就是明文
 *
 * 依赖：lib/font-decrypt.bundle.js（esbuild 产物）、lib/font_ref_cx.bin（特征表）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, 'font-decrypt.bundle.js');
const REF_TABLE_PATH = path.join(__dirname, 'font_ref_cx.bin');

function readBundle() {
	return fs.readFileSync(BUNDLE_PATH, 'utf8');
}

function readRefTable() {
	const buffer = fs.readFileSync(REF_TABLE_PATH);
	return 'data:application/octet-stream;base64,' + buffer.toString('base64');
}

/**
 * 页面是否还有未解密的密文元素
 */
export async function hasEncryptedText(frame) {
	try {
		return await frame.evaluate(() => document.querySelectorAll('.font-cxsecret').length > 0);
	} catch {
		return false;
	}
}

/**
 * 解密页面上的密文（幂等：解密后移除 .font-cxsecret 标记）。
 * @returns {Promise<{decrypted:boolean, chars?:number, error?:string}>}
 */
export async function decryptFrameFonts(frame, { log } = {}) {
	if (!(await hasEncryptedText(frame))) return { decrypted: false };
	const bundle = readBundle();
	const refTable = readRefTable();
	try {
		const result = await frame.evaluate(
			async ({ bundle, refTable }) => {
				// 注入解密模块（Runtime.evaluate 不受页面 CSP 限制）
				if (!window.OCSFONT) {
					// 打包件是 IIFE + var OCSFONT，需要显式挂到 window
					new Function(bundle + '\n;window.OCSFONT = OCSFONT;')();
				}
				const api = window.OCSFONT;
				if (!api || typeof api.crackFont !== 'function') {
					return { decrypted: false, error: '解密模块注入失败' };
				}
				const elements = Array.from(document.querySelectorAll('.font-cxsecret'));
				if (!elements.length) return { decrypted: false };
				const buffer = api.extractFontFromStyle(document, 'font-cxsecret');
				if (!buffer) return { decrypted: false, error: '页面里没有 font-cxsecret 字体' };
				const chars = api.collectChars(elements);
				const { map } = await api.crackFont(buffer, chars, { refTableUrl: refTable, useWorker: false });
				api.decryptElements(elements, map);
				elements.forEach((el) => el.classList.remove('font-cxsecret'));
				return { decrypted: true, chars: Object.keys(map).length };
			},
			{ bundle, refTable }
		);
		if (log && result && result.decrypted) log(`[字体] 解密完成，${result.chars} 个字符`);
		if (log && result && result.error) log(`[字体] ${result.error}`);
		return result || { decrypted: false };
	} catch (e) {
		return { decrypted: false, error: String(e && e.message ? e.message : e) };
	}
}
