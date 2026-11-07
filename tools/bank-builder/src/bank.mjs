/**
 * 已有题库种子：把 questions.json（图论章节题库格式）里的已知答案，
 * 按「归一化题面 + 选项文本」匹配到当前页面，直接得到选项字母。
 *
 * 与 packages/scripts/src/utils/local-bank.ts 的算法保持一致（那边已验证过 93 题）。
 */
import fs from 'node:fs';

/** 去掉图片/题号/标点，用于题面比对 */
export function normalizeStem(text) {
	return String(text || '')
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, ' ')
		.replace(/[（(]\s*\d+(?:\.\d+)?\s*分\s*[)）]/g, ' ')
		.replace(/[[【(（]\s*(单选题|多选题|判断题|填空题|简答题|连线题|名词解释|论述题)\s*[\])】）]/g, ' ')
		.replace(/^\s*\d+\s*[、.．)）]\s*/, '')
		.replace(/[\s\u3000]+/g, '')
		.replace(/[，。、；：！？“”‘’（）《》【】\-—…·.,;:!?'"()\[\]{}<>|/\\_=+~`^$#@%&*]/g, '');
}

/** 选项文本归一化 */
export function normalizeOption(text) {
	return String(text || '')
		.replace(/^\s*[A-Za-z]\s*[、.．:：)）]\s*/, '')
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, ' ')
		.replace(/[\s\u3000]+/g, '')
		.replace(/[，。、；：！？“”‘’（）《》【】\-—…·.,;:!?'"()\[\]{}]/g, '')
		.trim();
}

function stripHtml(html) {
	return String(html || '')
		.replace(/<img[^>]*>/gi, ' ')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function parseOptionsHtml(html) {
	const raw = String(html || '');
	const out = [];
	const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
	let m;
	while ((m = re.exec(raw))) {
		const text = stripHtml(m[1]).replace(/^\s*[A-Za-z]\s*[、.．:：)）]\s*/, '').trim();
		if (text) out.push(text);
	}
	return out;
}

function lettersToIndexes(letters) {
	return Array.from(new Set(String(letters || '').toUpperCase().replace(/[^A-Z]/g, '').split(''))).map(
		(letter) => letter.charCodeAt(0) - 65
	);
}

const TYPE_MAP = {
	单选题: 'single',
	多选题: 'multiple',
	判断题: 'judgement',
	填空题: 'completion'
};

/** 读取 questions.json */
export function loadBank(file) {
	const data = JSON.parse(fs.readFileSync(file, 'utf8'));
	const list = Array.isArray(data) ? data : data.questions;
	if (!Array.isArray(list)) throw new Error('题库文件里没有 questions 数组');
	const items = [];
	for (const q of list) {
		const title = stripHtml(q.stemHtml || q.title || '');
		const key = normalizeStem(title);
		if (!key) continue;
		const type = TYPE_MAP[q.type] || 'unknown';
		const options = parseOptionsHtml(q.optionsHtml);
		const raw = String(q.answer || '').trim();
		const answers =
			type === 'single' || type === 'multiple'
				? lettersToIndexes(raw)
						.map((i) => options[i])
						.filter(Boolean)
				: [raw].filter(Boolean);
		items.push({ k: key, q: title, t: type, o: options, a: answers, raw });
	}
	return { title: data.title || '已知题库', items };
}

/** 在题库里找答案，返回当前页面选项字母 */
export function findAnswer(bank, { title, options, type }) {
	if (!bank || !bank.items.length) return undefined;
	const key = normalizeStem(title);
	if (!key) return undefined;
	const live = (options || []).map(normalizeOption);
	const candidates = bank.items.filter((item) => item.k === key);
	const pool = candidates.length ? candidates : [];
	if (!pool.length) return undefined;

	const scored = pool
		.map((item) => ({
			item,
			overlap: live.length
				? item.o.filter((o) => live.includes(normalizeOption(o))).length
				: 0
		}))
		.sort((a, b) => b.overlap - a.overlap);

	const best = scored[0].item;
	// 判断题 / 填空题：直接返回文本
	if (best.t === 'judgement' || best.t === 'completion') return best.a[0] || best.raw || undefined;
	if (!best.a.length) {
		// 图片选项：两边数量一致时才敢用题库原始字母
		if (best.o.length === live.length && /^[A-Za-z]+$/.test(best.raw)) {
			return best.raw.toUpperCase().split('').join(',');
		}
		return undefined;
	}
	// 选项文字重复（例如「是支配集。」出现 3 次）时按文字无法定位，数量一致就用题库原始字母
	const uniqueTexts = new Set(best.o.map(normalizeOption)).size;
	if (uniqueTexts !== best.o.length) {
		if (best.o.length === live.length && /^[A-Za-z]+$/.test(best.raw)) {
			return best.raw.toUpperCase().split('').join(',');
		}
		return undefined;
	}
	const letters = [];
	for (const text of best.a) {
		const idx = live.findIndex((o) => o === normalizeOption(text));
		if (idx < 0) return undefined;
		letters.push(String.fromCharCode(65 + idx));
	}
	return Array.from(new Set(letters)).join(',');
}
