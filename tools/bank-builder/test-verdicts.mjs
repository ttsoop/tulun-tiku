/**
 * 判卷对错采集器测试
 *
 * 不复制逻辑：直接把 packages/scripts/src/projects/cx.ts 里的 collectCxVerdicts
 * 用 esbuild 转成 JS，丢进浏览器，对几种假判卷 DOM 断言结果。
 *
 * 用法：node tools/bank-builder/mock/test-verdicts.mjs
 */
import fs from 'node:fs';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright-core';

const SOURCE = 'packages/scripts/src/projects/cx.ts';
const src = fs.readFileSync(SOURCE, 'utf8');

// 截取常量 + 函数（到下一个函数注释为止）
const start = src.indexOf('/** 判卷页的对错标记文字');
const end = src.indexOf('/** 「AC / A,C / A」这类字母答案');
if (start < 0 || end < 0) {
	console.error('没找到 collectCxVerdicts 源码区间，测试跳过');
	process.exit(1);
}
const snippet = src.slice(start, end) + '\nexport { collectCxVerdicts };\n';
const { code } = esbuild.transformSync(snippet, { loader: 'ts', format: 'esm' });

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await b.contexts()[0].newPage();
await page.goto('about:blank');

const cases = await page.evaluate(async (moduleCode) => {
	// 用 blob 执行转译后的模块
	const mod = await import('data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(moduleCode))));
	const collect = mod.collectCxVerdicts;

	const html = `
	<div class="TiMu" id="c1"><div class="Zy_TItle">题1</div>
		<ul><li class="cuo"><span>A</span></li><li><span>B</span></li></ul>
		<div class="rightAnswer">正确答案：B</div></div>
	<div class="TiMu" id="c2"><div class="Zy_TItle">题2</div>
		<ul><li class="dui"><span>A</span></li></ul></div>
	<div class="TiMu" id="c3"><div class="Zy_TItle">题3</div>
		<ul><li><span>A</span></li></ul><span class="mark">正确</span></div>
	<div class="TiMu" id="c4"><div class="Zy_TItle">题4</div>
		<ul><li><span>A</span></li></ul><img src="/star3/cuo.png"></div>
	<div class="TiMu" id="c5"><div class="Zy_TItle">题5</div>
		<span>本题得分：0 分</span><span>满分：10 分</span></div>
	<div class="TiMu" id="c6"><div class="Zy_TItle">题6</div>
		<ul><li><span>A</span></li></ul></div>
	<div class="TiMu" id="c7"><div class="Zy_TItle">题7</div>
		<span>得分：6 分</span><span>满分：10 分</span></div>
	<div class="TiMu" id="c8"><div class="Zy_TItle">题8</div>
		<ul><li class="half"><span>A</span></li></ul><span>半对</span></div>
	`;
	const host = document.createElement('div');
	host.innerHTML = html;
	document.body.appendChild(host);

	const result = collect(host);
	return Array.from(host.querySelectorAll('.TiMu')).map((el, i) => ({
		id: el.id,
		verdict: result[i]?.verdict,
		correctAnswer: result[i]?.correctAnswer
	}));
}, code);

const expect = {
	c1: 'wrong', // class="cuo" + 正确答案：B
	c2: 'right', // class="dui"
	c3: 'right', // 文本「正确」
	c4: 'wrong', // img src 含 cuo
	c5: 'wrong', // 本题得分 0 分
	c6: 'unknown', // 什么都没
	c7: 'partial', // 0 < 6 < 10
	c8: 'partial' // 半对
};

let failed = 0;
for (const row of cases) {
	const want = expect[row.id];
	const ok = row.verdict === want && (row.id !== 'c1' || (row.correctAnswer || '').includes('B'));
	console.log(`${ok ? 'PASS' : 'FAIL'} ${row.id}: 期望 ${want}，实际 ${row.verdict}` + (row.correctAnswer ? `（正确答案：${row.correctAnswer}）` : ''));
	if (!ok) failed++;
}
console.log(failed ? `\n❌ ${failed} 项失败` : `\n✅ ${cases.length} 项全部通过`);

await page.close();
await b.close();
process.exit(failed ? 1 : 0);
