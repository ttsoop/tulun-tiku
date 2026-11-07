/**
 * 打包：把采集结果整理成可入库的题库目录
 *
 * 输出：题库/图论全章节题库/{questions.json, answers.csv, index.html, images/, README.md}
 *
 * 处理内容：
 * 1. 题干/选项里的图片：下载到 images/ 并把地址改成本地相对路径（URL 会失效、且需要登录）
 * 2. 连线题（「请给下列各图归类」）：平台按一道题呈现，实际是「图1→第一组…」的映射，
 *    还原成 line 类型 + subItems，查看器按「每张图一道选择题」展示。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exportBank, parseLineAnswer } from './src/export.mjs';

const src = 'tools/bank-builder/out/all/questions.json';
const originalFile = '图论章节题库/questions.json';
const outDir = '题库/图论全章节题库';
const imgDir = path.join(outDir, 'images');

const data = JSON.parse(fs.readFileSync(src, 'utf8'));
const TYPE = { 单选题: 'single', 多选题: 'multiple', 判断题: 'judgement', 填空题: 'completion' };

/** 章节标题（课程目录里的大章名，用于查看器左侧树） */
const CHAPTER_TITLES = {
	1: '图论预备知识',
	2: '图',
	3: '树与最短路径',
	4: '网络优化与 Petri 网',
	5: '独立集、支配集与匹配',
	6: '平面图与着色'
};

/** 题目 → 所属小节（采集中记录在 state.json 的 section 字段） */
const sectionOf = new Map();
try {
	const stateFile = 'tools/bank-builder/out/all/state.json';
	if (fs.existsSync(stateFile)) {
		for (const r of JSON.parse(fs.readFileSync(stateFile, 'utf8'))) {
			if (r && r.id && r.section) sectionOf.set(r.id, r.section);
		}
	}
} catch (e) {
	console.warn('[打包] state.json 读取失败，章节信息将缺失：' + e.message);
}

const strip = (html) =>
	String(html || '')
		.replace(/<img[^>]*>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

/** 原始题库（用于补全连线题的完整映射） */
let original = [];
try {
	if (fs.existsSync(originalFile)) {
		original = JSON.parse(fs.readFileSync(originalFile, 'utf8')).questions || [];
	}
} catch (e) {
	console.warn('[打包] 原始题库读取失败，连线题将只保留现有答案：' + e.message);
}

/** 与原始题库里同类连线题做匹配：按组名（欧拉图 / 哈密尔顿图 …） */
function findOriginalMapping(groups) {
	const sameTitle = original.filter((o) => strip(o.stemHtml).includes('归类'));
	const withOptions = sameTitle.filter((o) => {
		const text = strip(o.optionsHtml);
		return groups.every((g) => text.includes(g));
	});
	return withOptions[0];
}

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/**
 * 下载一道题的图片到本地，返回相对路径数组。
 * 失败时保留原始 URL（至少不会丢信息）。
 */
async function downloadImages(recordId, urls) {
	const out = [];
	fs.mkdirSync(imgDir, { recursive: true });
	for (let i = 0; i < urls.length; i++) {
		const url = urls[i];
		if (!/^https?:/i.test(url)) {
			out.push(url);
			continue;
		}
		try {
			const res = await fetch(url, {
				headers: {
					Referer: 'https://mooc1.chaoxing.com/',
					'User-Agent':
						'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
				}
			});
			if (!res.ok) throw new Error('HTTP ' + res.status);
			const buffer = Buffer.from(await res.arrayBuffer());
			if (buffer.length < 100) throw new Error('内容过小');
			const type = (res.headers.get('content-type') || 'image/png').toLowerCase();
			const ext = type.includes('jpeg')
				? '.jpg'
				: type.includes('gif')
				? '.gif'
				: type.includes('webp')
				? '.webp'
				: type.includes('svg')
				? '.svg'
				: '.png';
			const file = `${recordId}-${i + 1}-${sha1(url).slice(0, 6)}${ext}`;
			fs.writeFileSync(path.join(imgDir, file), buffer);
			out.push('images/' + file);
		} catch (e) {
			console.warn(`  [图片] ${recordId} 第 ${i + 1} 张下载失败（${e.message}），保留原链接`);
			out.push(url);
		}
	}
	return out;
}

const records = [];
let imgOk = 0;
let imgFail = 0;

for (let i = 0; i < data.questions.length; i++) {
	const q = data.questions[i];
	const title = String(q.title || '').replace(/^【[^】]{1,8}】\s*/, '');
	const section = sectionOf.get(q.id) || '';
	const chapter = (section.match(/^(\d+)/) || [])[1] || '';
	const rawAnswer = String(q.answer || '');
	const type = TYPE[q.type] || 'unknown';

	// 图片：下载到本地
	const remote = (q.images || []).filter(Boolean);
	let images = remote;
	if (remote.length) {
		images = await downloadImages(q.id, remote);
		for (const p of images) {
			if (p.startsWith('images/')) imgOk++;
			else imgFail++;
		}
	}

	// —— 连线题 ——
	if (type === 'unknown' && (/^\d+-[A-Z]$/.test(rawAnswer.trim()) || /归类|连线/.test(title))) {
		const groups = (q.options || []).slice(-2).map((s) => String(s).replace(/\s+/g, ' ').trim());
		const match = findOriginalMapping(groups);
		const fullAnswer = match ? String(match.answer || '').trim() : rawAnswer;
		const pairs = parseLineAnswer(fullAnswer);
		records.push({
			id: q.id,
			index: i + 1,
			type: 'line',
			title,
			options: q.options || [],
			groups,
			subItems: pairs.map((p) => ({
				no: p.no,
				answer: p.answer,
				target: groups[p.answer.charCodeAt(0) - 65] || ''
			})),
			answer: fullAnswer,
			chapter,
			chapterName: section,
			verified: !!q.verified,
			flags: [],
			explanation: q.explanation || '',
			images
		});
		continue;
	}

	records.push({
		id: q.id,
		index: i + 1,
		type,
		title,
		options: q.options || [],
		answer: rawAnswer,
		chapter,
		chapterName: section,
		verified: !!q.verified,
		flags: [...(q.flags || [])],
		explanation: q.explanation || '',
		images
	});
}

const res = exportBank(outDir, {
	title: '图论及其应用 · 章节测验题库（全章节）',
	records,
	meta: {
		...(data.meta || {}),
		chapterTitles: CHAPTER_TITLES,
		generatedBy: 'tools/bank-builder（接管 Chrome 自动作答采集）'
	}
});

// —— README ——
const chapterCount = records.reduce((acc, r) => {
	const key = r.chapterName || r.chapter || '未标注';
	acc[key] = (acc[key] || 0) + 1;
	return acc;
}, {});
const typeCount = records.reduce((acc, r) => {
	acc[r.type] = (acc[r.type] || 0) + 1;
	return acc;
}, {});
const TYPE_NAME = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题',
	line: '连线题',
	unknown: '未知'
};
const imgQuestions = records.filter((r) => r.images && r.images.length).length;
const imgTotal = records.reduce((n, r) => n + (r.images || []).length, 0);

const readme = `# 图论及其应用 · 章节测验题库（全章节）

由 \`tools/bank-builder\` 接管浏览器自动作答、按平台判分回炉采集而成。

![预览](preview.png)

## 内容

| 文件 | 说明 |
|---|---|
| \`questions.json\` | 题库主文件，含题面、选项、答案、图片、解析、验证状态与疑点 |
| \`answers.csv\` | 表格版（Excel 可直接打开） |
| \`index.html\` | 离线查看器：搜索、题型筛选、只看疑点、高亮正确选项、显示题干图片 |
| \`images/\` | 题干/选项里的图片（已本地化，共 ${imgTotal} 张，覆盖 ${imgQuestions} 题） |

统计：**${res.count} 题**，平台已验证 **${res.verified}**，疑点 **${res.doubt}**。

题型：${Object.entries(typeCount)
	.map(([k, v]) => `${TYPE_NAME[k] || k} ${v}`)
	.join(' / ')}

## 覆盖章节

| 章节 | 题数 |
|---|---|
${Object.entries(chapterCount)
	.map(([name, n]) => `| ${name} | ${n} |`)
	.join('\n')}

其余小节（1.1–1.5、2.1、3.4–3.6、5.3、5.4、5.6、6.2–6.4、6.6）没有章节测验，未采集。

## 关于图片

题干/选项里的图（图形题、公式图）已下载到 \`images/\`，题目的 \`images\` 字段存的是相对路径，
\`stemHtml\` 里也内联了 \`<img src="images/…">\`，离线打开查看器即可看到原图。

> 少数下载失败（平台防盗链/图片已删）的条目会保留原始 URL，需联网才能显示。

## 关于连线题

「请给下列各图归类」这类题，平台按一道大题呈现，实际答案是「图1→第一组、图2→第二组…」的映射。
题库里记为 \`type: "连线题"\`，并给出 \`subItems\`，查看器按每张图一道选择题展示：

\`\`\`json
{
  "type": "连线题",
  "groups": ["欧拉图", "非欧拉图"],
  "answer": "1-B 2-B 3-B 4-B",
  "subItems": [
    { "no": 1, "answer": "B", "target": "非欧拉图" }
  ]
}
\`\`\`

## 字段说明

- \`answer\`：选择题为选项字母（多选如 \`A,C\`）；判断题为「对/错」；连线题为 \`1-B 2-B …\`
- \`images\`：题目图片的相对路径数组（如 \`["images/8f3a-1-2b81c9.png"]\`）
- \`verified\`：平台是否确认答对
- \`flags\`：疑点，可能的值：\`未验证\`、\`答案冲突\`、\`不支持题型\`、\`答案不完整\`、\`半对半错\`
- \`explanation\`：AI 生成的解析
- \`subItems\` / \`groups\`：仅连线题有

## 怎么用

1. **离线查看**：双击 \`index.html\`（图片随目录一起拷走即可）。
2. **导入油猴脚本**：「⚙️ 全局设置 → 本地题库 → 导入题库文件」，选 \`questions.json\`。
   脚本会按「题面 + 选项文本」匹配，平台打乱选项也不会答错；连线题会自动跳过。
3. **重新采集**：见 [tools/bank-builder/USAGE.md](../../tools/bank-builder/USAGE.md)。
`;

fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');

console.log(`[打包] ${res.count} 题（已验证 ${res.verified}，疑点 ${res.doubt}）→ ${outDir}`);
console.log(`[图片] 成功 ${imgOk} 张，失败 ${imgFail} 张（失败保留原链接）`);
console.log('  题型：' + Object.entries(typeCount).map(([k, v]) => `${TYPE_NAME[k] || k} ${v}`).join(' / '));
for (const f of ['questions.json', 'answers.csv', 'index.html', 'README.md']) {
	const p = path.join(outDir, f);
	console.log('  ' + p + '  ' + (fs.statSync(p).size / 1024).toFixed(1) + ' KB');
}

