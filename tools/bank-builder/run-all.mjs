#!/usr/bin/env node
/**
 * 逐小节自动化：遍历课程目录 → 每节找章节测验 → 作答/采集 → 合并导出
 *
 * 用法：
 *   node tools/bank-builder/run-all.mjs --bank "图论章节题库\questions.json" --submit --rounds 3
 *
 * 行为：
 *   - 未完成 / 不及格的测验：从题库取答案（没有就问 AI）→ 作答 → 提交 → 读判分 → 迭代
 *   - 已完成（满分）的测验：只读取题目与我的答案，不再提交
 *   - 没有测验的小节：跳过
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connect, sleep, captureDialogs } from './src/cdp.mjs';
import {
	extractQuestions,
	extractSelection,
	collectResultAnswers,
	applyAnswers,
	acceptRetake,
	submit,
	waitForJudge,
	isAnswerable,
	TYPE_LABEL
} from './src/cx.mjs';
import { decryptFrameFonts } from './src/font.mjs';
import { findAnswer, loadBank } from './src/bank.mjs';
import { answerQuestions, explainQuestions } from './src/ai.mjs';
import { exportBank } from './src/export.mjs';

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
			} else args[key] = true;
		} else args._.push(item);
	}
	return args;
}

function loadConfig() {
	const file = path.join(__dirname, 'config.json');
	const example = path.join(__dirname, 'config.example.json');
	const config = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : example, 'utf8'));
	if (process.env.OCS_AI_BASE_URL) config.ai.baseUrl = process.env.OCS_AI_BASE_URL;
	if (process.env.OCS_AI_API_KEY) config.ai.apiKey = process.env.OCS_AI_API_KEY;
	if (process.env.OCS_AI_MODEL) config.ai.model = process.env.OCS_AI_MODEL;
	return config;
}

const stableId = (title) => crypto.createHash('sha1').update(String(title || '')).digest('hex').slice(0, 10);
const log = (...a) => console.log(...a);

/** 给任意 Promise 加超时（playwright 的 evaluate 默认永不超时，页面卡住会拖死整个遍历） */
function withTimeout(promise, ms, label = '') {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((resolve) => {
			timer = setTimeout(() => {
				log(`[超时] ${label} 超过 ${ms}ms，跳过`);
				resolve(undefined);
			}, ms);
		})
	]);
}

/** 目录里所有真实小节（带 chapterId 的） */
async function listSections(page) {
	const list = await withTimeout(
		page.evaluate(() => {
			const out = [];
			for (const div of document.querySelectorAll('.posCatalog_select[id^="cur"]')) {
				const nameEl = div.querySelector('.posCatalog_name');
				const text = (nameEl ? nameEl.innerText : div.innerText || '').replace(/\s+/g, ' ').trim();
				const onclick = nameEl ? nameEl.getAttribute('onclick') || '' : '';
				const m = onclick.match(/getTeacherAjax\('([^']+)','([^']+)','([^']+)'\)/);
				if (!m) continue;
				out.push({
					name: text,
					courseId: m[1],
					classId: m[2],
					chapterId: m[3],
					done: /已完成/.test(div.innerText || '')
				});
			}
			return out;
		}),
		15000,
		'listSections'
	);
	return list || [];
}

/** 切到某一节 */
async function openSection(page, section) {
	await withTimeout(
		page.evaluate((chapterId) => {
			const div = document.querySelector('.posCatalog_select[id="cur' + chapterId + '"]');
			const span = div && div.querySelector('.posCatalog_name');
			if (span) span.click();
		}, section.chapterId),
		15000,
		'openSection'
	);
}

/** 当前所有含题目的 frame（优先匹配当前小节的 knowledgeid，避免拿到上一节残留的 iframe） */
async function findQuiz(page, chapterId) {
	const candidates = [];
	for (const f of page.frames()) {
		try {
			const n = await withTimeout(f.evaluate(() => document.querySelectorAll('.TiMu').length), 5000, 'findQuiz');
			if (n > 0) candidates.push({ frame: f, count: n, url: f.url() });
		} catch {}
	}
	if (!candidates.length) return undefined;
	if (chapterId) {
		const hit = candidates.find((c) => c.url.includes(chapterId));
		if (hit) return hit;
	}
	return candidates[candidates.length - 1];
}

/** 在页面里点章节测验任务点（有些小节不会自动展开） */
async function openQuizTaskPoint(page) {
	const clicked = await page.evaluate(() => {
		const visible = (el) => {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		};
		const cands = Array.from(document.querySelectorAll('a,span,div,p,li'))
			.filter((el) => visible(el) && /章节测验|测验/.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 30)
			.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
		const el = cands[0];
		if (!el) return false;
		el.click();
		return true;
	});
	return clicked;
}

/** 页面整体文字（父页面 + 所有 frame） */
async function pageText(page) {
	let text = '';
	try {
		text += await page.evaluate(() => document.body.innerText || '');
	} catch {}
	for (const f of page.frames()) {
		try {
			text += '\n' + (await f.evaluate(() => document.body.innerText || ''));
		} catch {}
	}
	return text;
}

/**
 * 判断测验状态：已完成（可只采集）还是待作答（需要提交）。
 * 依据：状态栏文字 / 是否还有提交按钮 / 父页面任务点状态。
 */
async function quizState(frame, page) {
	const info =
		(await withTimeout(
			frame
				.evaluate(() => {
					const st = document.querySelector('.testTit_status');
					return {
						status: ((st && st.innerText) || '').replace(/\s+/g, ' ').trim(),
						statusCls: ((st && st.className) || '').toString(),
						hasSubmit: !!document.querySelector('.btnSubmit'),
						head: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160)
					};
				})
				.catch(() => ({ status: '', statusCls: '', hasSubmit: true, head: '' })),
			10000,
			'quizState'
		)) || { status: '', statusCls: '', hasSubmit: true, head: '' };
	let parentText = '';
	try {
		parentText = await page.evaluate(() => document.body.innerText || '');
	} catch {}
	const completed =
		/已完成/.test(info.status) ||
		/testTit_status_complete/.test(info.statusCls) ||
		/任务点已完成/.test(parentText) ||
		(!info.hasSubmit && /成绩|已完成|重做/.test(info.head));
	return { ...info, completed };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = loadConfig();
	const port = args.port ? parseInt(args.port) : config.port || 9222;
	const submitAllowed = !!args.submit;
	const maxRounds = args.rounds ? parseInt(args.rounds) : config.maxRounds || 3;
	const outDir = args.out || config.outDir || path.join(__dirname, 'out', 'all');
	const knownBank = args.bank ? loadBank(args.bank) : undefined;
	if (knownBank) log(`[题库] 已加载 ${knownBank.items.length} 题作为种子`);

	log(`[连接] http://127.0.0.1:${port}`);
	const browser = await connect(port);
	const all = new Map(); // stableId -> record
	// 断点续跑：已采集的题目落盘，避免中途卡住丢进度
	const stateFile = path.join(outDir, 'state.json');
	try {
		if (fs.existsSync(stateFile)) {
			for (const r of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) all.set(r.id, r);
			log('[断点] 已载入 ' + all.size + ' 题历史进度');
		}
	} catch (e) {
		log('[断点] 读取失败，忽略：' + (e && e.message));
	}
	const saveState = () => {
		try {
			fs.mkdirSync(outDir, { recursive: true });
			fs.writeFileSync(stateFile, JSON.stringify(Array.from(all.values()), null, 1), 'utf8');
		} catch (e) {}
	};
	try {
		let page;
		for (const ctx of browser.contexts()) {
			for (const p of ctx.pages()) {
				if (/studentstudy|mycourse/.test(p.url())) page = p;
			}
		}
		const exportOnly = !!args['export-only'];
		if (!page && !exportOnly) throw new Error('没找到课程学习页，请在浏览器里打开课程');
		const dialogs = exportOnly ? { messages: [], dispose: () => {} } : captureDialogs(page);

		const sections = exportOnly ? [] : await listSections(page);
		const courseUrl = page ? page.url() : '';
		log(`[目录] 共 ${sections.length} 个小节`);
		if (!sections.length && !exportOnly) throw new Error('目录为空，请确认页面在课程学习页');

		const only = args.only ? new RegExp(args.only) : undefined;
		const targets = only ? sections.filter((s) => only.test(s.name)) : sections;
		log(`[计划] 本次处理 ${targets.length} 个小节\n`);

		if (!exportOnly) for (let idx = 0; idx < targets.length; idx++) {
			const section = targets[idx];
			log(`\n########## [${idx + 1}/${targets.length}] ${section.name} ##########`);
			try {
				// 守卫：超星偶尔会把页面重定向到个人空间，先拉回课程页
				if (!/studentstudy/.test(page.url())) {
					log('[导航] 页面被重定向，重新打开课程页…');
					await page.goto(courseUrl, { waitUntil: 'domcontentloaded' });
					await sleep(4000);
				}
				await openSection(page, section);
				await sleep(2500);

				// 等测验出现（最多 20s），必要时点任务点
				let quiz;
				for (let i = 0; i < 10; i++) {
					await sleep(2000);
					quiz = await findQuiz(page, section.chapterId);
					if (quiz) break;
					if (i === 2) await openQuizTaskPoint(page);
				}
				if (!quiz) {
					log('⏭️ 该小节没有测验，跳过');
					continue;
				}
				const { frame } = quiz;
				await decryptFrameFonts(frame, { log });
				const state = await quizState(frame, page);
				const completed = state.completed;

				const questions = await extractQuestions(frame);
				if (!questions.length) {
					log('⏭️ 测验里没有题目，跳过');
					continue;
				}
				log(`[题目] ${questions.length} 题，状态：${completed ? '已完成' : '待作答'}`);

				// 采集题目（先去重）
				const items = questions.map((q) => {
					// 去重键要带上选项：题库里存在题面相同但选项不同的题（如「关于极大平面图」两条）
					const id = stableId(q.title + '|' + (q.options || []).join('|'));
					let record = all.get(id);
					const typeFromTitle = (t) =>
						/多选题/.test(t) ? 'multiple' : /判断题/.test(t) ? 'judgement' : /单选题/.test(t) ? 'single' : /填空题|简答题/.test(t) ? 'completion' : 'unknown';
					const cleanTitle = q.title.replace(/^【[^】]{1,8}】\s*/, '');
					if (q.type === 'unknown' || !q.type) q.type = typeFromTitle(q.title);
					q.title = cleanTitle;
					if (!record) {
						record = {
							id,
							index: all.size + 1,
							type: q.type,
							title: q.title,
							options: q.options,
							images: q.images,
							answers: [],
							verdicts: [],
							correctAnswerFromPage: '',
							answer: '',
							verified: false,
							flags: [],
							rounds: [],
							section: section.name
						};
						all.set(id, record);
					}
					record.section = section.name;
					record.type = q.type;
					record.options = q.options;
					record.images = q.images;
					return record;
				});

				if (completed) {
					// 已完成：从「我的答案 / 正确答案」文本采集；采不到再退回隐藏域
					const result = await collectResultAnswers(frame);
					const sel = await extractSelection(frame);
					let got = 0;
					items.forEach((record, i) => {
						const r = result[i] || {};
						const s = sel[i] || {};
						const fromHidden =
							record.type === 'judgement'
								? String(s.hidden) === 'true'
									? '对'
									: String(s.hidden) === 'false'
									? '错'
									: ''
								: String(s.hidden || s.letters || '');
						let ans = fromHidden || r.myAnswer || '';
						if (ans && (record.type === 'single' || record.type === 'multiple')) {
							ans = ans.toUpperCase().replace(/[^A-Z]/g, '').split('').join(',');
						}
						if (ans) {
							record.answer = ans;
							record.verified = true;
							record.note = record.note || '平台已完成';
							got++;
						}
						if (r.correctAnswer) {
							record.correctAnswerFromPage =
								record.type === 'judgement' || record.type === 'completion'
									? r.correctAnswer
									: r.correctAnswer.toUpperCase().replace(/[^A-Z]/g, '').split('').join(',');
						}
					});
					log(`[采集] 已有答案 ${got}/${items.length} 题`);
					continue;
				}

				if (!submitAllowed) {
					log('ℹ️ 未加 --submit，仅采集，不提交');
					continue;
				}

				// 未完成：作答 → 提交 → 判分 → 迭代
				await acceptRetake(page);
				for (let round = 1; round <= maxRounds; round++) {
					await decryptFrameFonts(frame);
					// 本节局部题号（1 起），页面定位必须用它；record.index 是全局导出序号
					const localOf = new Map(items.map((r, i) => [r, i + 1]));
					const answers = {};
					const toAsk = [];
					let bankHits = 0;
					for (const record of items) {
						const li = localOf.get(record);
						if (record.correctAnswerFromPage) answers[li] = record.correctAnswerFromPage;
						else if (record.verified && record.answer) answers[li] = record.answer;
						else if (knownBank && (record.bankAnswer || (record.bankAnswer = findAnswer(knownBank, record)))) {
							answers[li] = record.bankAnswer;
							bankHits++;
						} else {
							toAsk.push({
								index: li,
								type: record.type,
								title: record.title,
								options: record.options,
								lastAnswer: record.answers[record.answers.length - 1] || '',
								verdict: record.verdicts[record.verdicts.length - 1] || '',
								note: record.images && record.images.length ? `含 ${record.images.length} 张图片` : ''
							});
						}
					}
					if (bankHits) log(`[题库] 命中 ${bankHits} 题`);
					if (toAsk.length) {
						log(`[AI] 评估 ${toAsk.length} 题…`);
						const result = await answerQuestions(config.ai, toAsk, { batchSize: config.batchSize || 10 });
						for (const [i, a] of result) answers[i] = a;
					}

					const applied = await applyAnswers(frame, answers);
					log(`[作答] 第 ${round} 轮：填 ${applied.applied} 题`);
					for (const record of items) {
						const li = localOf.get(record);
						if (answers[li]) record.answers.push(answers[li]);
					}

					const sub = await submit(frame, page);
					const judge = await waitForJudge(frame, page, config.judgeTimeoutSeconds || 20);
					const marked = (judge.details || []).filter((d) => d.verdict !== 'unknown').length;
					const withCorrect = (judge.details || []).filter((d) => d.correctAnswer).length;
					log(`[判分] 分数=${judge.score === undefined ? '未知' : judge.score} 未及格=${judge.failedHint} 逐题=${marked} 正解=${withCorrect}`);

					items.forEach((record, i) => {
						const d = (judge.details || [])[i];
						if (!d) return;
						if (d.verdict && d.verdict !== 'unknown') record.verdicts.push(d.verdict);
						if (d.correctAnswer) {
							const t = String(d.correctAnswer).trim();
							record.correctAnswerFromPage =
								record.type === 'judgement' || record.type === 'completion'
									? t
									: t.toUpperCase().replace(/[^A-Z]/g, '').split('').join(',');
						}
						if (d.verdict === 'right' && record.answers.length) {
							record.answer = record.answers[record.answers.length - 1];
							record.verified = true;
						}
					});

					if (items.every((r) => r.verdicts.includes('right'))) {
						log('✅ 全部判对');
						break;
					}
					if (judge.score !== undefined && judge.score >= 100) {
						items.forEach((r) => (r.verified = true));
						log('✅ 满分');
						break;
					}
					if (judge.score !== undefined && judge.score >= (config.passLine || 60) && marked === 0 && !judge.failedHint) {
						items.forEach((r) => (r.verified = true));
						log(`✅ 分数 ${judge.score} 达线`);
						break;
					}
					if (!(await isAnswerable(frame))) {
						log('⚠️ 已不可作答，停止本小节');
						break;
					}
					await acceptRetake(page);
				}
				// 收尾答案
				for (const record of items) {
					if (!record.answer) record.answer = record.correctAnswerFromPage || record.answers[record.answers.length - 1] || '';
				}
			} catch (e) {
				log('❌ 本节失败：' + (e && e.message ? e.message : e));
			}
			saveState();
		}
		dialogs.dispose();

		// 汇总导出
		const records = Array.from(all.values()).sort((a, b) => a.index - b.index);
		records.forEach((r, i) => {
			r.index = i + 1;
			const flags = [];
			if (!r.answer) flags.push('未作答');
			if (!r.verified) flags.push('未验证');
			if (r.type === 'line' || r.type === 'fill' || r.type === 'reader') flags.push('不支持题型');
			if (new Set(r.answers.filter(Boolean)).size > 1 && !r.verified) flags.push('答案冲突');
			if (r.verdicts.includes('partial')) flags.push('半对半错');
			r.flags = flags;
		});

		const needExplain = records.filter((r) => r.answer && !r.explanation);
		if (needExplain.length) {
			log(`\n[解析] 生成 ${needExplain.length} 题解析…`);
			const ex = await explainQuestions(config.ai, needExplain, {
				onProgress: (d, t) => log(`      ${d}/${t}`)
			});
			for (const r of needExplain) r.explanation = ex.get(r.index) || '';
		}

		const title = config.title ? config.title + '（全章节）' : '图论全章节题库';
		const res = exportBank(outDir, {
			title,
			records,
			meta: { source: page ? page.url() : '', exportedAt: new Date().toISOString(), sections: targets.length }
		});
		log(`\n[导出] ${res.count} 题（已验证 ${res.verified}，疑点 ${res.doubt}）`);
		log('  ' + res.questions);
		log('  ' + res.csv);
		log('  ' + res.viewer);

		// 每节小结
		const bySection = {};
		for (const r of records) {
			bySection[r.section] = bySection[r.section] || { n: 0, ok: 0 };
			bySection[r.section].n++;
			if (r.verified) bySection[r.section].ok++;
		}
		log('\n[分节统计]');
		for (const [name, s] of Object.entries(bySection)) log(`  ${name}: ${s.n} 题，已验证 ${s.ok}`);
	} finally {
		await browser.close().catch(() => {});
	}
}

main().catch((e) => {
	console.error('\n[失败] ' + (e && e.stack ? e.stack : e));
	process.exitCode = 1;
});









