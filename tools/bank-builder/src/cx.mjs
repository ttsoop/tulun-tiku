/**
 * 超星（学习通）章节测验适配层
 *
 * 选择器与油猴脚本 packages/scripts/src/projects/cx.ts 的 chapter() 保持一致：
 *   题目块 .TiMu，题面 .Zy_TItle .clearfix，题型 input[id^=answertype]，选项 ul li
 * 这样脚本能答的页面，这里也能读。
 */
import { sleep } from './cdp.mjs';

const TYPE_MAP = {
	0: 'single',
	1: 'multiple',
	2: 'completion',
	3: 'judgement',
	4: 'completion',
	5: 'completion',
	6: 'completion',
	7: 'completion',
	8: 'completion',
	9: 'completion',
	10: 'completion',
	11: 'line',
	14: 'fill',
	15: 'reader'
};

/** 读取页面上的全部题目 */
export async function extractQuestions(frame) {
	return await frame.evaluate((typeMap) => {
		const blocks = Array.from(document.querySelectorAll('.TiMu'));
		return blocks.map((el, index) => {
			const typeInput = el.querySelector('input[id^="answertype"]');
			const code = typeInput ? parseInt(typeInput.value) : -1;
			const titleEl = el.querySelector('.Zy_TItle .clearfix') || el.querySelector('.Zy_TItle');
			// 去掉「1、」这类题号前缀，题库里只保留题面
			const title = (titleEl ? titleEl.innerText : '')
				.replace(/\s+/g, ' ')
				.trim()
				.replace(/^\s*\d+\s*[、.．)）]\s*/, '');

			// 选项：优先取 .after 里的正文（超星把选项正文放在 a.after 里，字母在 label.before 中）
			const lis = Array.from(el.querySelectorAll('ul > li'));
			const options = [];
			const checked = [];
			lis.forEach((li, i) => {
				const after = li.querySelector('.after');
				let text = (after ? after.innerText : li.innerText || '').replace(/\s+/g, ' ').trim();
				// 没有 .after 时（判断题等）去掉开头的字母
				if (!after) text = text.replace(/^\s*[A-Za-z]\s*[、.．:：)）]?\s*/, '');
				if (text) options.push(text);
				if (li.getAttribute('aria-checked') === 'true') checked.push(i);
			});
			if (!checked.length) {
				Array.from(el.querySelectorAll('input[type="radio"], input[type="checkbox"]')).forEach((input, i) => {
					if (input.checked) checked.push(i);
				});
			}
			const textareas = Array.from(el.querySelectorAll('textarea')).map((t) => t.value || '');
			const images = Array.from(el.querySelectorAll('img'))
				.map((img) => img.getAttribute('src') || '')
				.filter((src) => /^https?:/i.test(src));
			return {
				index: index + 1,
				typeCode: code,
				type: typeMap[code] || 'unknown',
				title,
				options,
				checked,
				textareas,
				images,
				optionCount: options.length
			};
		});
	}, TYPE_MAP);
}

/** 题型文字 */
export const TYPE_LABEL = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题',
	line: '连线题',
	fill: '完形填空',
	reader: '阅读理解',
	unknown: '未知题型'
};

/**
 * 在当前页面作答（不提交）。
 * @param {*} frame
 * @param {Record<number,string>} answers 题号(1 起) → 答案（字母/文本）
 * @returns {{applied:number, skipped:Array<{index:number,reason:string}>}}
 */
export async function applyAnswers(frame, answers) {
	return await frame.evaluate(
		({ answers, typeMap, correctWords, wrongWords }) => {
			const blocks = Array.from(document.querySelectorAll('.TiMu'));
			const skipped = [];
			let applied = 0;

			const clickOption = (input) => {
				const after = input.closest('li') && input.closest('li').querySelector('.after');
				if (after) return after.click();
				const label = input.closest('label');
				if (label) return label.click();
				return input.click();
			};

			for (const key of Object.keys(answers)) {
				const index = parseInt(key);
				const value = String(answers[key] || '').trim();
				const block = blocks[index - 1];
				if (!block || !value) {
					skipped.push({ index, reason: '题目不存在或答案为空' });
					continue;
				}
				const typeInput = block.querySelector('input[id^="answertype"]');
				const type = typeMap[parseInt(typeInput && typeInput.value)] || 'unknown';

				if (type === 'completion') {
					const areas = Array.from(block.querySelectorAll('textarea'));
					if (!areas.length) {
						skipped.push({ index, reason: '没有找到填空输入框' });
						continue;
					}
					const parts = value.split(/[#＃]/);
					areas.forEach((area, i) => {
						area.value = parts[i] !== undefined ? parts[i] : '';
						area.dispatchEvent(new Event('input', { bubbles: true }));
						area.dispatchEvent(new Event('change', { bubbles: true }));
					});
					applied++;
					continue;
				}

				// 超星的选项是 li（onclick=addMultipleChoice/addSingleChoice），不一定有 input
				const lis = Array.from(block.querySelectorAll('ul > li'));
				if (!lis.length) {
					skipped.push({ index, reason: '没有找到选项元素' });
					continue;
				}
				const isChecked = (li) =>
					li.getAttribute('aria-checked') === 'true' ||
					(li.querySelector('input') ? li.querySelector('input').checked : false);

				// 字母答案 → 选项下标
				let targets = [];
				const upper = value.toUpperCase();
				const letters = upper.replace(/[^A-Z]/g, '');
				const hasCjk = /[\u4e00-\u9fa5]/.test(value);
				if (letters.length && !hasCjk) {
					targets = Array.from(new Set(letters.split(''))).map((l) => l.charCodeAt(0) - 65);
				} else {
					// 文字答案（判断题）：按选项文本匹配
					const texts = lis.map((li) => {
						const after = li.querySelector('.after');
						return ((after ? after.innerText : li.innerText) || '').trim();
					});
					const wantCorrect = correctWords.some((w) => value.includes(w));
					const wantWrong = wrongWords.some((w) => value.includes(w));
					if (wantCorrect && !wantWrong) {
						targets = texts.map((t, i) => (correctWords.some((w) => t.includes(w)) ? i : -1)).filter((i) => i >= 0);
					} else if (wantWrong && !wantCorrect) {
						targets = texts.map((t, i) => (wrongWords.some((w) => t.includes(w)) ? i : -1)).filter((i) => i >= 0);
					}
				}
				targets = targets.filter((i) => i >= 0 && i < lis.length);
				if (!targets.length) {
					skipped.push({ index, reason: '答案无法映射到选项：' + value.slice(0, 20) });
					continue;
				}

				if (type === 'multiple') {
					lis.forEach((li, i) => {
						const want = targets.includes(i);
						if (want !== isChecked(li)) li.click();
					});
				} else {
					// 单选/判断：点目标项（超星会自动取消其他项）
					const target = lis[targets[0]];
					if (!isChecked(target)) target.click();
				}

				// 关键：提交时读的是隐藏域 #answer<qid>，必须与点击结果同步
				const qid = lis[0] && lis[0].getAttribute('qid');
				const hidden = qid ? document.querySelector('#answer' + qid) : null;
				if (hidden) {
					if (type === 'judgement') {
						hidden.value = correctWords.some((w) => value.includes(w)) ? 'true' : 'false';
					} else {
						hidden.value = targets.map((i) => String.fromCharCode(65 + i)).join('');
					}
				}
				applied++;
			}
			return { applied, skipped };
		},
		{
			answers,
			typeMap: TYPE_MAP,
			correctWords: ['对', '正确', '√', '是', '对的', '正确的'],
			wrongWords: ['错', '错误', '×', '否', '不对', '不正确的']
		}
	);
}

/** 在父页面里点超星提示弹窗上的按钮（超星的确认框都在父页面，不在 iframe 内） */
async function clickPopupButton(page, { popupText, buttonText }) {
	return await page
		.evaluate(
			({ popupText, buttonText }) => {
				const visible = (el) => {
					const r = el.getBoundingClientRect();
					return r.width > 0 && r.height > 0;
				};
				const containers = Array.from(
					document.querySelectorAll('.popDiv, .con03, .AlertCon02, .popBottom, .layui-layer, .Marking')
				)
					.filter((el) => visible(el) && el.innerText && el.innerText.includes(popupText))
					.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
				const container = containers[0];
				if (!container) return 'no-popup';
				const btn = Array.from(container.querySelectorAll('a,button,input,span')).find(
					(el) => visible(el) && ((el.innerText || el.value || '').trim() === buttonText)
				);
				if (!btn) return 'no-button';
				btn.click();
				return 'clicked';
			},
			{ popupText, buttonText }
		)
		.catch(() => 'error');
}

/**
 * 处理「未达到及格线，请重做」提示：确认后进入新一次作答。
 * @returns {Promise<'clicked'|'none'|string>}
 */
export async function acceptRetake(page, times = 2) {
	let last = 'none';
	for (let i = 0; i < times; i++) {
		const r = await clickPopupButton(page, { popupText: '未达到及格线', buttonText: '确定' });
		last = r;
		if (r !== 'clicked') break;
		await sleep(1200);
	}
	return last;
}

/** 点提交：先触发超星提交，再点父页面「确认提交？」弹窗里的「提交」 */
export async function submit(frame, page) {
	const triggered = await frame.evaluate(() => {
		try {
			if (typeof btnBlueSubmit === 'function') {
				btnBlueSubmit();
				return true;
			}
			const button = Array.from(document.querySelectorAll('a,button')).find((el) =>
				/提交|交卷/.test((el.innerText || '').trim())
			);
			if (button) {
				button.click();
				return true;
			}
			return '找不到提交按钮';
		} catch (e) {
			return String((e && e.message) || e);
		}
	});

	// 等待「确认提交？」弹窗（在父页面）
	for (let i = 0; i < 20; i++) {
		await sleep(700);
		const clicked = await clickPopupButton(page, { popupText: '确认提交', buttonText: '提交' });
		if (clicked === 'clicked') {
			await sleep(1800);
			return { submit: true, confirm: true, error: '' };
		}
	}
	// 兜底：部分版本没有确认框，直接走验证码检查/表单提交
	await frame
		.evaluate(() => {
			try {
				if (typeof submitCheckTimes === 'function') submitCheckTimes();
			} catch {}
		})
		.catch(() => {});
	await sleep(1500);
	return { submit: triggered === true, confirm: false, error: triggered === true ? '' : String(triggered) };
}

/**
 * 读取判分信息。
 * 兼容三种页面：给分数、只给对错、只给一句「未及格」。
 */
export async function readJudge(frame, page) {
	const readDoc = () =>
		frame.evaluate(() => {
			const blocks = Array.from(document.querySelectorAll('.TiMu'));
			const correctWords = ['正确', '回答正确', '√', '✓', '答对'];
			const wrongWords = ['错误', '回答错误', '×', '✗', '答错', '不正确'];
			const partialWords = ['半对', '部分正确', '半对半错', '部分答对', '少选'];
			const details = blocks.map((block) => {
				const texts = new Set(
					Array.from(block.querySelectorAll('span,i,em,b,strong,label,td'))
						.map((el) => (el.innerText || '').trim())
						.filter((t) => t && t.length <= 10)
				);
				let verdict = 'unknown';
				if (partialWords.some((w) => texts.has(w))) verdict = 'partial';
				else if (wrongWords.some((w) => texts.has(w))) verdict = 'wrong';
				else if (correctWords.some((w) => texts.has(w))) verdict = 'right';
				const full = block.innerText || '';
				const match = full.match(/正确答案\s*[:：]?\s*([^\n]{1,120})/);
				return { verdict, correctAnswer: match ? match[1].replace(/\s+/g, ' ').trim() : '' };
			});
			const text = (document.body && document.body.innerText) || '';
			const scoreMatch = text.match(/(?:本次成绩|本次得分|成绩|得分)\s*[:：]?\s*(\d{1,3}(?:\.\d+)?)/) || text.match(/(\d{1,3}(?:\.\d+)?)\s*分(?!钟)/);
			return {
				text,
				score: scoreMatch ? parseFloat(scoreMatch[1]) : undefined,
				failedHint: /未及格|不及格|未通过|不合格/.test(text),
				details
			};
		})
		.catch(() => ({ text: '', details: [] }));

	const fromFrame = await readDoc();
	let fromPage = { text: '' };
	try {
		fromPage = await page.evaluate(() => ({ text: (document.body && document.body.innerText) || '' }));
	} catch {}

	const signal = `${fromFrame.text || ''}\n${fromPage.text || ''}`;
	return {
		score: fromFrame.score,
		failedHint: fromFrame.failedHint || /未及格|不及格|未通过|不合格/.test(signal),
		details: fromFrame.details || [],
		signal: signal.slice(-2000)
	};
}

/** 等判分页出现（成绩/对错/弹窗任一出现即返回） */
export async function waitForJudge(frame, page, timeoutSeconds = 20) {
	const deadline = Date.now() + timeoutSeconds * 1000;
	while (Date.now() < deadline) {
		await sleep(1500);
		const judge = await readJudge(frame, page);
		const hasDetail = (judge.details || []).some((d) => d.verdict !== 'unknown' || d.correctAnswer);
		if (judge.score !== undefined || judge.failedHint || hasDetail) return judge;
	}
	return await readJudge(frame, page);
}

/** 读取当前页面已选的答案（以超星隐藏域 #answer<qid> 为准） */
export async function extractSelection(frame) {
	return await frame.evaluate(() => {
		return Array.from(document.querySelectorAll('.TiMu')).map((el, index) => {
			const lis = Array.from(el.querySelectorAll('ul > li'));
			const qid = lis[0] && lis[0].getAttribute('qid');
			const hidden = qid ? document.querySelector('#answer' + qid) : null;
			const letters = lis
				.map((li, i) => {
					const checked =
						li.getAttribute('aria-checked') === 'true' ||
						(li.querySelector('input') ? li.querySelector('input').checked : false);
					return checked ? String.fromCharCode(65 + i) : '';
				})
				.join('');
			const textareas = Array.from(el.querySelectorAll('textarea')).map((t) => t.value || '');
			return { index: index + 1, letters, textareas, hidden: hidden ? hidden.value : '', qid: qid || '' };
		});
	});
}

/**
 * 已完成/已批阅试卷的答案采集。
 * 结果页每题通常带「我的答案：X」「正确答案：Y」「得分：Z 分」，直接解析文本。
 */
export async function collectResultAnswers(frame) {
	return await frame.evaluate(() => {
		return Array.from(document.querySelectorAll('.TiMu')).map((el, index) => {
			const text = (el.innerText || '').replace(/\s+/g, ' ');
			const my = text.match(/我的答案\s*[:：]\s*([^\s，。]{1,30})/);
			const right = text.match(/正确答案\s*[:：]\s*([^\s，。]{1,60})/);
			const score = text.match(/(?:得分|本题得分)\s*[:：]?\s*(\d+(?:\.\d+)?)/) || text.match(/(\d+(?:\.\d+)?)\s*分(?!钟)/);
			return {
				index: index + 1,
				myAnswer: my ? my[1].trim() : '',
				correctAnswer: right ? right[1].trim() : '',
				score: score ? parseFloat(score[1]) : undefined
			};
		});
	});
}

/** 页面是否还能作答（提交后可重做时仍有可点的输入框） */
export async function isAnswerable(frame) {
	try {
		return await frame.evaluate(() => {
			const inputs = Array.from(document.querySelectorAll('.TiMu input, .TiMu textarea'));
			return inputs.some((el) => !el.disabled && !el.readOnly);
		});
	} catch {
		return false;
	}
}
