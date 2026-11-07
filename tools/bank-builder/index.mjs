#!/usr/bin/env node
/**
 * 题库生成器（接管 Chrome）
 *
 * 用法：
 *   1) 用调试端口启动 Chrome 并登录超星、打开测验页：
 *      chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\ocs-cdp"
 *   2) node tools/bank-builder/index.mjs probe
 *   3) node tools/bank-builder/index.mjs run --submit --rounds 6
 *
 * 命令：
 *   probe            只读：列出页面/iframe，找出含题目的 frame
 *   extract          只读：把题目打印出来（不点不改）
 *   run              作答；加 --submit 才会真正提交
 * 参数：
 *   --port 9222      调试端口
 *   --url 关键字      只在 URL 含该关键字的页面里找题目
 *   --rounds 6       最多提交轮次
 *   --submit         允许提交（不传则只作答不提交）
 *   --mock           不调用 AI，用 config.mockAnswers 作答（离线测试用）
 *   --out 目录        导出目录
 *   --bank 文件       用已有题库（questions.json）里已确认的答案兜底
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep, findQuizFrame, listPages, captureDialogs } from './src/cdp.mjs';
import {
	extractQuestions,
	extractSelection,
	applyAnswers,
	acceptRetake,
	submit,
	waitForJudge,
	isAnswerable,
	TYPE_LABEL
} from './src/cx.mjs';
import { answerQuestions, explainQuestions } from './src/ai.mjs';
import { exportBank } from './src/export.mjs';
import { decryptFrameFonts } from './src/font.mjs';
import { findAnswer, loadBank } from './src/bank.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const item = argv[i];
		if (item.startsWith('--')) {
			const key = item.slice(2);
			const next = argv[i + 1];
			if (next && !next.startsWith('--')) {
				args[key] = next;
				i++;
			} else {
				args[key] = true;
			}
		} else {
			args._.push(item);
		}
	}
	return args;
}

function loadConfig() {
	const file = path.join(__dirname, 'config.json');
	const example = path.join(__dirname, 'config.example.json');
	const target = fs.existsSync(file) ? file : example;
	const config = JSON.parse(fs.readFileSync(target, 'utf8'));
	// 环境变量优先，避免把密钥写进文件
	if (process.env.OCS_AI_BASE_URL) config.ai.baseUrl = process.env.OCS_AI_BASE_URL;
	if (process.env.OCS_AI_API_KEY) config.ai.apiKey = process.env.OCS_AI_API_KEY;
	if (process.env.OCS_AI_MODEL) config.ai.model = process.env.OCS_AI_MODEL;
	return config;
}

/** 题号(1 起) → 字母 */
function indexToLetter(index) {
	return String.fromCharCode(65 + index);
}

/** 把平台给的「正确答案」文本换算成答案（判断题/填空题保留原文，选择题转字母） */
function normalizeCorrectAnswer(text, item) {
	if (!text) return '';
	const trimmed = String(text).trim();
	// 判断题、填空题的答案本身就是文本，不要再转成字母
	if (item && (item.type === 'judgement' || item.type === 'completion' || item.type === 'unknown')) {
		return trimmed;
	}
	const letters = trimmed.toUpperCase().replace(/[^A-Z]/g, '');
	if (letters && !/[\u4e00-\u9fa5]/.test(trimmed)) {
		return letters.split('').join(',');
	}
	if (item && item.options && item.options.length) {
		// 选项原文 → 字母
		const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/[、，。．.（）()]/g, '');
		const target = norm(trimmed);
		const index = item.options.findIndex((option) => norm(option) === target || target.includes(norm(option)));
		if (index >= 0) return indexToLetter(index);
	}
	return trimmed;
}

function createRecord(item) {
	return {
		index: item.index,
		type: item.type,
		title: item.title,
		options: item.options,
		images: item.images,
		answers: [],
		verdicts: [],
		correctAnswerFromPage: '',
		answer: '',
		verified: false,
		score: undefined,
		explanation: '',
		flags: [],
		rounds: []
	};
}

function pickFinalAnswer(record) {
	// 1) 平台直接给出的正确答案最可靠
	if (record.correctAnswerFromPage) {
		record.answer = record.correctAnswerFromPage;
		record.verified = true;
		return;
	}
	// 2) 最近一次提交的答案
	record.answer = record.answers[record.answers.length - 1] || '';
	// 3) 被判对过 → 已验证
	if (record.verdicts.includes('right')) {
		record.verified = true;
	}
}

function computeFlags(record) {
	const flags = [];
	if (!record.answer) flags.push('未作答');
	if (record.type === 'line' || record.type === 'fill' || record.type === 'reader') flags.push('不支持题型');
	if (!record.verified) flags.push('未验证');
	if (new Set(record.answers.filter(Boolean)).size > 1 && !record.verified) flags.push('答案冲突');
	if (record.verdicts.includes('partial')) flags.push('半对半错');
	record.flags = Array.from(new Set(flags));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const command = args._[0] || 'probe';
	const config = loadConfig();
	const port = args.port ? parseInt(args.port) : config.port || 9222;

	console.log(`[连接] CDP http://127.0.0.1:${port}`);
	const browser = await connect(port);
	try {
		const found = await findQuizFrame(browser, args.url);
		if (!found) {
			console.log('[!] 没找到含题目的页面（.TiMu）。当前打开的页面：');
			console.table(await listPages(browser));
			console.log('    请确认：Chrome 用调试端口启动、已登录并打开了测验页。');
			process.exitCode = 2;
			return;
		}
		const { page, frame } = found;
		console.log(`[定位] 页面 ${page.url()}`);
		console.log(`[定位] 题目数 ${found.count}`);

		// 超星题目可能是加密字体，先解密再读
		const decrypted = await decryptFrameFonts(frame, { log: (m) => console.log(m) });
		if (decrypted && decrypted.error) console.log('[字体] 解密失败：' + decrypted.error);

		if (command === 'probe') {
			const questions = await extractQuestions(frame);
			console.log(`[题库] 抽出 ${questions.length} 题`);
			questions.slice(0, 3).forEach((q) => {
				console.log(`  #${q.index} [${TYPE_LABEL[q.type] || q.type}] ${q.title.slice(0, 60)}`);
				(q.options || []).forEach((text, i) => console.log(`      ${indexToLetter(i)}. ${text.slice(0, 60)}`));
			});
			console.log('[提示] 只读探测，未做任何修改。下一步：node index.mjs run --submit --rounds 6');
			return;
		}

		if (command === 'extract') {
			const questions = await extractQuestions(frame);
			const file = path.join(args.out || config.outDir || path.join(__dirname, 'out'), 'extract.json');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, JSON.stringify(questions, null, 2), 'utf8');
			console.log(`[提取] ${questions.length} 题 → ${file}`);
			return;
		}

		if (command !== 'run') {
			console.log('未知命令：' + command);
			process.exitCode = 2;
			return;
		}

		// ---------- run ----------
		const submitAllowed = !!args.submit;
		const maxRounds = args.rounds ? parseInt(args.rounds) : config.maxRounds || 6;
		const outDir = args.out || config.outDir || path.join(__dirname, 'out');
		const useMock = !!args.mock;

		console.log(`[模式] ${submitAllowed ? '作答 + 提交' : '仅作答（不提交）'}，最多 ${maxRounds} 轮`);
		if (!submitAllowed) {
			console.log('[提示] 不提交就无法拿到判分反馈，只会导出"未验证"的题库。加 --submit 才会迭代。');
		}
		if (!useMock && !config.ai.apiKey && !/localhost|127\.0\.0\.1/.test(config.ai.baseUrl || '')) {
			throw new Error('未配置 AI 密钥：请填 tools/bank-builder/config.json 的 ai.apiKey，或设置环境变量 OCS_AI_API_KEY');
		}

		const dialogs = captureDialogs(page);
		const records = new Map();
		let lastJudge = undefined;

		// 已知题库（可复用历史答案，减少 AI 调用）
		let knownBank;
		if (args.bank) {
			knownBank = loadBank(args.bank);
			console.log(`[题库] 已加载 ${knownBank.items.length} 题 → ${args.bank}`);
		}

		for (let round = 1; round <= maxRounds; round++) {
			console.log(`\n===== 第 ${round} 轮 =====`);
			await decryptFrameFonts(frame);
			// 超星打开测验时可能弹出「未达到及格线，请重做」，先确认进入可作答状态
			const retake = await acceptRetake(page);
			if (retake === 'clicked') console.log('[提示] 已确认「未达到及格线，请重做」');
			const questions = await extractQuestions(frame);
			if (!questions.length) {
				console.log('[!] 页面上没有题目了（可能已跳转），停止');
				break;
			}
			// 同步记录
			const items = questions.map((question) => {
				let record = records.get(question.index);
				if (!record) {
					record = createRecord(question);
					records.set(question.index, record);
				} else {
					record.type = question.type;
					record.title = question.title;
					record.options = question.options;
					record.images = question.images;
				}
				return record;
			});

			// 组织本轮要提交的答案：优先平台给出的正确答案，其次已知题库，其次已确认答案，最后问 AI
			const answers = {};
			const toAsk = [];
			let bankHits = 0;
			for (const record of items) {
				if (record.correctAnswerFromPage) {
					answers[record.index] = record.correctAnswerFromPage;
				} else if (record.verified && record.answer) {
					answers[record.index] = record.answer;
				} else if (
					knownBank &&
					(record.bankAnswer || (record.bankAnswer = findAnswer(knownBank, record)))
				) {
					answers[record.index] = record.bankAnswer;
					bankHits++;
				} else {
					toAsk.push({
						index: record.index,
						type: record.type,
						title: record.title,
						options: record.options,
						lastAnswer: record.answers[record.answers.length - 1] || '',
						verdict: record.verdicts[record.verdicts.length - 1] || '',
						correctAnswer: record.correctAnswerFromPage,
						note: record.images && record.images.length ? `含 ${record.images.length} 张图片` : ''
					});
				}
			}
			if (bankHits) console.log(`[题库] 命中 ${bankHits} 题（不消耗 AI）`);

			if (toAsk.length) {
				if (useMock) {
					const mock = config.mockAnswers || {};
					for (const item of toAsk) {
						const value = mock[item.index] || mock[String(item.index)];
						if (value) answers[item.index] = value;
					}
					console.log(`[mock] 直接使用 config.mockAnswers，命中 ${Object.keys(answers).length} 题`);
				} else {
					console.log(`[AI] 重新评估 ${toAsk.length} 题…`);
					const result = await answerQuestions(config.ai, toAsk, {
						batchSize: config.batchSize || 10,
						onProgress: (done, total) => console.log(`      ${done}/${total}`)
					});
					for (const [index, answer] of result) answers[index] = answer;
				}
			}
			console.log(`[作答] ${Object.keys(answers).length} 题有答案`);

			const applied = await applyAnswers(frame, answers);
			console.log(`[作答] 已填 ${applied.applied} 题，跳过 ${applied.skipped.length} 题`);
			applied.skipped.slice(0, 5).forEach((s) => console.log(`      跳过 #${s.index}：${s.reason}`));

			// 回读校验：以超星隐藏域为准（提交时读的就是它）
			const selection = await extractSelection(frame);
			const mismatch = [];
			for (const record of items) {
				const expected = String(answers[record.index] || '').toUpperCase().replace(/[^A-Z]/g, '');
				const current = selection[record.index - 1];
				if (!expected || !current) continue;
				if (record.type === 'completion') continue;
				if (record.type === 'judgement') continue;
				const hidden = String(current.hidden || '').toUpperCase().replace(/[^A-Z]/g, '');
				const actual = hidden || String(current.letters || '').split('').sort().join('');
				if (actual !== expected.split('').sort().join('')) {
					mismatch.push(`#${record.index} 期望 ${expected} 实际 ${actual || '空'}`);
				}
			}
			if (mismatch.length) {
				console.log(`[校验] ⚠️ ${mismatch.length} 题答案未同步：` + mismatch.slice(0, 4).join('；'));
			} else {
				console.log('[校验] 隐藏域答案与意图一致');
			}

			for (const record of items) {
				const value = answers[record.index];
				if (value) record.answers.push(value);
				record.rounds.push({ round, answer: value || '', submitted: submitAllowed });
			}

			if (!submitAllowed) {
				console.log('[!] 未加 --submit，结束作答，直接导出（题目状态均为未验证）');
				break;
			}

			console.log('[提交] …');
			const submitResult = await submit(frame, page);
			if (submitResult.error) console.log('[提交] 警告：' + submitResult.error);

			const judge = await waitForJudge(frame, page, config.judgeTimeoutSeconds || 20);
			lastJudge = judge;
			const dialogText = dialogs.messages.map((m) => m.message).join(' | ');
			console.log(`[判分] 弹窗=${dialogText ? dialogText.slice(0, 80) : '无'} 未及格=${judge.failedHint} 分数=${judge.score === undefined ? '未知' : judge.score}`);
			const marked = (judge.details || []).filter((d) => d.verdict !== 'unknown').length;
			const withCorrect = (judge.details || []).filter((d) => d.correctAnswer).length;
			console.log(`[判分] 逐题标记 ${marked}/${items.length}，给出正确答案 ${withCorrect} 题`);

			items.forEach((record, i) => {
				const detail = (judge.details || [])[i];
				if (!detail) return;
				if (detail.verdict && detail.verdict !== 'unknown') record.verdicts.push(detail.verdict);
				if (detail.correctAnswer) {
					record.correctAnswerFromPage = normalizeCorrectAnswer(detail.correctAnswer, record);
				}
				// 平台说这道对了 → 当前答案已验证
				if (detail.verdict === 'right' && record.answers.length) {
					record.answer = record.answers[record.answers.length - 1];
					record.verified = true;
				}
				if (args.verbose) {
					console.log(
						`      #${record.index} ${record.type} 答=${record.answers[record.answers.length - 1] || '-'} 判=${detail.verdict}${
							detail.correctAnswer ? ' 正解=' + detail.correctAnswer : ''
						}`
					);
				}
			});

			const allRight = items.length > 0 && items.every((record) => record.verdicts.includes('right'));
			if (allRight) {
				console.log('✅ 全部题目都被判为正确，停止迭代');
				break;
			}
			if (judge.score !== undefined && judge.score >= (config.passLine || 60) && marked === 0) {
				console.log(`✅ 分数 ${judge.score} 达线（页面未给逐题信息）`);
				break;
			}
			if (!judge.failedHint && marked === 0 && judge.score === undefined) {
				console.log('ℹ️ 未检测到"未及格"提示，也没有逐题信息，无法判断是否正确；按已答导出');
				break;
			}
			// 还能继续作答吗？
			if (!(await isAnswerable(frame))) {
				console.log('⚠️ 题目已不可编辑（提交后锁定），无法继续迭代，按当前结果导出');
				break;
			}
		}
		dialogs.dispose();

		// ---------- 收尾：确定最终答案、补解析、导出 ----------
		const list = Array.from(records.values()).sort((a, b) => a.index - b.index);
		list.forEach((record) => {
			pickFinalAnswer(record);
			if (lastJudge && lastJudge.score !== undefined && lastJudge.score >= 100) {
				record.verified = true;
			}
			computeFlags(record);
		});

		const needExplain = list.filter((record) => record.answer && !record.explanation);
		if (needExplain.length && !useMock) {
			console.log(`\n[解析] 生成 ${needExplain.length} 题的解析…`);
			const explanations = await explainQuestions(config.ai, needExplain, {
				onProgress: (done, total) => console.log(`      ${done}/${total}`)
			});
			for (const record of needExplain) {
				record.explanation = explanations.get(record.index) || '';
			}
		}

		const title = config.title || `题库 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
		const result = exportBank(outDir, {
			title,
			records: list,
			meta: {
				source: page.url(),
				exportedAt: new Date().toISOString(),
				libreRounds: maxRounds,
				submitted: submitAllowed
			}
		});
		console.log(`\n[导出] ${result.count} 题（已验证 ${result.verified}，疑点 ${result.doubt}）`);
		console.log('  ' + result.questions);
		console.log('  ' + result.csv);
		console.log('  ' + result.viewer);
	} finally {
		// 只断开连接，不关闭用户的浏览器
		await browser.close().catch(() => {});
	}
}

main().catch((error) => {
	console.error('\n[失败] ' + (error && error.stack ? error.stack : error));
	process.exitCode = 1;
});

