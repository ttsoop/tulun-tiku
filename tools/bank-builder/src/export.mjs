/**
 * 导出题库：questions.json + answers.csv + index.html
 *
 * questions.json 与「图论章节题库」结构兼容（stemHtml / optionsHtml / answer 字母），
 * 因此产物可以直接被油猴脚本的「本地题库」再次导入。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { renderViewer } from './viewer.mjs';

/** 稳定的题目 id（按题面哈希，跨多次导出保持一致，便于去重） */
function stableId(title) {
	return crypto.createHash('sha1').update(String(title || '')).digest('hex').slice(0, 10);
}

const TYPE_LABEL = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题',
	line: '连线题',
	fill: '完形填空',
	reader: '阅读理解',
	unknown: '未知题型'
};

function escapeHtml(text) {
	return String(text == null ? '' : text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** 选项字母 → 下标 */
function lettersToIndexes(letters) {
	return Array.from(new Set(String(letters || '').toUpperCase().replace(/[^A-Z]/g, '').split(''))).map(
		(letter) => letter.charCodeAt(0) - 65
	);
}

/** 连线题：把「1-B 2-B 3-B 4-B」拆成每个子题目 → 选项字母 */
export function parseLineAnswer(answer) {
	const text = String(answer || '').trim();
	const pairs = [];
	const re = /(\d{1,2})\s*[-－—:：.]?\s*([A-Za-z])/g;
	let m;
	while ((m = re.exec(text))) {
		pairs.push({ no: parseInt(m[1]), answer: m[2].toUpperCase() });
	}
	return pairs;
}

/** 连线题：答案的可读文本，如「1→B（非欧拉图） 2→B（非欧拉图）」 */
export function lineAnswerText(record) {
	const subs = record.subItems || [];
	if (!subs.length) return '';
	return subs
		.map((s) => `${s.no}→${s.answer}${s.target ? '（' + s.target + '）' : ''}`)
		.join(' ');
}

/** 单选/多选：答案字母 → 选项文本 */
function answerTexts(record) {
	if (record.type === 'line') {
		return (record.subItems || []).map((s) => `${s.no}→${s.answer}`);
	}
	if (record.type === 'judgement' || record.type === 'completion' || record.type === 'unknown') {
		return [record.answer];
	}
	const indexes = lettersToIndexes(record.answer);
	return indexes.map((i) => record.options[i]).filter(Boolean);
}

function toRichQuestion(record, index) {
	// 题型兜底：已完成的试卷读不到 answertype，就从【多选题】这类前缀推断
	const inferType = (t) =>
		/多选题/.test(t) ? 'multiple' : /判断题/.test(t) ? 'judgement' : /单选题/.test(t) ? 'single' : /填空题|简答题|论述题/.test(t) ? 'completion' : 'unknown';
	const type = record.type && TYPE_LABEL[record.type] ? record.type : inferType(record.title || '');
	const title = String(record.title || '').replace(/^【[^】]{1,8}】\s*/, '');
	const optionsHtml =
		record.options && record.options.length
			? '<ul>' +
			  record.options
					.map(
						(text, i) =>
							`<li><i>${String.fromCharCode(65 + i)}、</i><p>${escapeHtml(text)}</p></li>`
					)
					.join('') +
			  '</ul>'
			: '';
	return {
		id: record.id || stableId(record.title),
		chapter: record.chapter || '',
		chapterName: record.chapterName || '',
		type: TYPE_LABEL[type] || type,
		// 纯文本字段：查看器直接用，油猴脚本的本地题库也能读
		title,
		options: record.options || [],
		answer: record.answer,
		answerText: record.type === 'line' ? lineAnswerText(record) : answerTexts(record).join(' / '),
		// 连线题：每组子题目单独列出（对应「每个图当作一道选择题」）
		...(record.type === 'line' && record.subItems
			? { subItems: record.subItems, groups: record.groups || [] }
			: {}),
		score: record.score,
		verified: record.verified,
		flags: record.flags || [],
		stemHtml:
			`<p>${escapeHtml(title)}</p>` +
			(record.images || [])
				.map((src) => `<p><img src="${escapeHtml(src)}" alt="题目图片" loading="lazy"></p>`)
				.join(''),
		optionsHtml,
		explanation: record.explanation || '',
		images: record.images || [],
		searchText: `${index + 1} 【${TYPE_LABEL[type] || type}】 ${title}` +
			(record.options || []).map((t, i) => ` ${String.fromCharCode(65 + i)}、 ${t}`).join('') +
			` 我的答案： ${record.answer}`,
		evidence: {
			rounds: record.rounds || [],
			correctAnswerFromPage: record.correctAnswerFromPage || '',
			verdicts: record.verdicts || []
		}
	};
}

function csvEscape(value) {
	const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
	return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

/** 生成离线查看器 */
/** 导出全部产物 */
export function exportBank(outDir, { title, records, meta }) {
	fs.mkdirSync(outDir, { recursive: true });

	const questions = records.map((record, index) => toRichQuestion(record, index));

	const payload = {
		title,
		date: new Date().toISOString().slice(0, 10),
		meta: meta || {},
		questions
	};
	fs.writeFileSync(path.join(outDir, 'questions.json'), JSON.stringify(payload, null, 2), 'utf8');

	const header = ['题号', '题型', '题目摘要', '正确答案', '答案文本', '图片', '平台是否验证', '疑点', '解析'];
	const lines = [header.join(',')];
	questions.forEach((q, i) => {
		lines.push(
			[
				i + 1,
				q.type,
				String(q.stemHtml).replace(/<[^>]+>/g, ''),
				q.answer,
				q.answerText,
				(q.images || []).join(' '),
				q.verified ? '是' : '否',
				(q.flags || []).join('、'),
				q.explanation
			]
				.map(csvEscape)
				.join(',')
		);
	});
	fs.writeFileSync(path.join(outDir, 'answers.csv'), '\ufeff' + lines.join('\r\n'), 'utf8');

	fs.writeFileSync(path.join(outDir, 'index.html'), renderViewer(title, questions, (meta && meta.chapterTitles) || {}), 'utf8');

	return {
		dir: outDir,
		questions: path.join(outDir, 'questions.json'),
		csv: path.join(outDir, 'answers.csv'),
		viewer: path.join(outDir, 'index.html'),
		count: questions.length,
		doubt: questions.filter((q) => (q.flags || []).length).length,
		verified: questions.filter((q) => q.verified).length
	};
}



