/**
 * AI 调用：整卷作答 + 生成解析
 *
 * 走 OpenAI 兼容接口（DeepSeek / 豆包方舟 / 通义 / 本地 Ollama 均可）。
 */
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

function normalizeUrl(baseUrl) {
	const url = String(baseUrl || '').trim().replace(/\/+$/, '');
	if (!url) return '';
	return /\/chat\/completions$/i.test(url) ? url : url + '/chat/completions';
}

/** 单次 chat completions 调用 */
export async function chat(config, messages, { timeoutMs = 180000, temperature = 0 } = {}) {
	const url = normalizeUrl(config.baseUrl);
	if (!url) throw new Error('未配置 AI 接口地址（config.baseUrl）');
	if (!config.model) throw new Error('未配置模型名（config.model）');
	const headers = { 'Content-Type': 'application/json' };
	if (config.apiKey) headers.Authorization = 'Bearer ' + config.apiKey;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ model: config.model, stream: false, temperature, messages }),
			signal: controller.signal
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`AI 接口 ${response.status}：${text.slice(0, 300)}`);
		}
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error('AI 返回的不是 JSON：' + text.slice(0, 200));
		}
		const choice = json.choices && json.choices[0];
		let content = '';
		if (choice) {
			const message = choice.message || {};
			if (typeof message.content === 'string') content = message.content;
			else if (Array.isArray(message.content)) {
				content = message.content.map((part) => (part && part.text) || '').join('');
			}
			if (!content && typeof choice.text === 'string') content = choice.text;
		}
		if (!content) throw new Error('AI 没有返回内容');
		return content;
	} finally {
		clearTimeout(timer);
	}
}

function stripFence(text) {
	return String(text || '')
		.replace(/^```[a-zA-Z]*/, '')
		.replace(/```$/, '')
		.trim();
}

function parseJsonLoose(text) {
	const raw = stripFence(text);
	try {
		return JSON.parse(raw);
	} catch {}
	const start = raw.indexOf('{');
	const end = raw.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(raw.slice(start, end + 1));
		} catch {}
	}
	return undefined;
}

/** 题库里已有的答案换算成当前页面的答案（可选，作为 AI 的参考） */
function describeQuestion(item) {
	const lines = [];
	lines.push(`【第 ${item.index} 题】${TYPE_LABEL[item.type] || item.type}`);
	lines.push('题目：' + item.title);
	if (item.options && item.options.length) {
		if (item.type === 'judgement') {
			lines.push('选项：' + item.options.join(' / '));
		} else {
			lines.push('选项：');
			item.options.forEach((text, i) => lines.push(String.fromCharCode(65 + i) + '. ' + text));
		}
	}
	if (item.lastAnswer) lines.push('上一次答案：' + item.lastAnswer);
	if (item.verdict && item.verdict !== 'unknown') {
		lines.push('平台判定：' + (item.verdict === 'partial' ? '半对半错（漏选/选错）' : item.verdict === 'wrong' ? '错误' : '正确'));
	}
	if (item.correctAnswer) lines.push('平台给出的正确答案：' + item.correctAnswer);
	if (item.note) lines.push('备注：' + item.note);
	return lines.join('\n');
}

const ANSWER_SYSTEM = [
	'你是一名严谨的答题助手。',
	'严格按照要求作答：',
	'1. 只输出 JSON，不要解释、不要 Markdown 代码块。',
	'2. 单选：{"index":1,"answer":"A"}；多选：{"index":2,"answer":"AC"}（字母按顺序拼接，不要空格）。',
	'3. 判断：answer 填选项原文（如「对」「错」「正确」「错误」）。',
	'4. 填空：answer 填要填的文本，多个空用 # 分隔。',
	'5. 每题都必须给答案，不要留空；不确定时给最可能的答案。',
	'输出格式：{"answers":[{"index":1,"answer":"A"}]}'
].join('\n');

/**
 * 整卷作答（分批）。
 * @returns {Promise<Map<number,string>>}
 */
export async function answerQuestions(config, items, { batchSize = 10, onProgress } = {}) {
	const answers = new Map();
	const list = items.slice();
	let done = 0;
	for (let i = 0; i < list.length; i += batchSize) {
		const batch = list.slice(i, i + batchSize);
		const user = [
			'请回答下面这些题目，逐题给出最可能正确的答案。',
			'',
			batch.map(describeQuestion).join('\n\n')
		].join('\n');
		const content = await chat(config, [
			{ role: 'system', content: ANSWER_SYSTEM },
			{ role: 'user', content: user }
		]);
		const parsed = parseJsonLoose(content);
		let got = 0;
		if (parsed) {
			const arr = Array.isArray(parsed) ? parsed : parsed.answers || parsed.items || [];
			for (const entry of arr) {
				const index = parseInt(entry.index ?? entry.i ?? entry.no);
				const answer = entry.answer ?? entry.a;
				if (index && answer !== undefined && answer !== null) {
					answers.set(index, String(answer).trim());
					got++;
				}
			}
		}
		if (!got) {
			// 退化为文本解析：第1题：A
			const re = /(?:第\s*)?(\d{1,3})\s*(?:题)?\s*[:：、.．)）]?\s*([^\n]{1,80})/g;
			let match;
			while ((match = re.exec(stripFence(content)))) {
				answers.set(parseInt(match[1]), match[2].replace(/^答案\s*[:：]?\s*/, '').trim());
			}
		}
		done += batch.length;
		onProgress && onProgress(done, list.length);
	}
	return answers;
}

const EXPLAIN_SYSTEM = [
	'你是一名严谨的老师。为下面每道题写一句简短的解析（不超过 40 字），说明为什么这个答案对。',
	'只输出 JSON：{"items":[{"index":1,"explanation":"..."}]}'
].join('\n');

/** 为最终答案批量生成解析 */
export async function explainQuestions(config, items, { batchSize = 8, onProgress } = {}) {
	const explanations = new Map();
	for (let i = 0; i < items.length; i += batchSize) {
		const batch = items.slice(i, i + batchSize);
		const user = batch
			.map((item) => {
				const lines = [`【第 ${item.index} 题】（${TYPE_LABEL[item.type] || item.type}）${item.title}`];
				if (item.options && item.options.length) {
					item.options.forEach((text, idx) => lines.push(String.fromCharCode(65 + idx) + '. ' + text));
				}
				lines.push('正确答案：' + (item.answer || item.correctAnswer || ''));
				return lines.join('\n');
			})
			.join('\n\n');
		try {
			const content = await chat(config, [
				{ role: 'system', content: EXPLAIN_SYSTEM },
				{ role: 'user', content: user }
			]);
			const parsed = parseJsonLoose(content);
			const arr = parsed && (parsed.items || parsed.answers || parsed);
			if (Array.isArray(arr)) {
				for (const entry of arr) {
					const index = parseInt(entry.index ?? entry.i ?? entry.no);
					const text = entry.explanation ?? entry.text ?? entry.reason;
					if (index && text) explanations.set(index, String(text).trim());
				}
			}
		} catch (e) {
			// 解析失败不影响主流程
			console.warn('[explain] 生成解析失败：' + (e && e.message ? e.message : e));
		}
		onProgress && onProgress(Math.min(i + batch.length, items.length), items.length);
	}
	return explanations;
}
