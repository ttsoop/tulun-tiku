/**
 * 离线查看器（单文件 HTML）
 *
 * 左侧：章节树（第N章 → 小节，带题数），点击筛选
 * 右侧：搜索 / 题型 / 状态过滤 + 题目卡片（含题干图片）
 */

function escapeHtml(text) {
	return String(text == null ? '' : text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * @param {string} title 题库标题
 * @param {any[]} questions 题目数组（已含 chapter / chapterName / images / subItems 等）
 * @param {Record<string, string>} chapterTitles 「第N章」标题映射，如 { '5': '独立集、支配集与匹配' }
 */
export function renderViewer(title, questions, chapterTitles = {}) {
	const data = JSON.stringify(questions);
	const titles = JSON.stringify(chapterTitles || {});

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; display: flex; height: 100vh; overflow: hidden; }

  /* ---------- 左侧章节树 ---------- */
  #side { width: 264px; flex: none; border-right: 1px solid #e5e7eb; overflow: auto; padding: 14px 10px; background: Canvas; }
  #side h1 { font-size: 15px; margin: 0 4px 10px; line-height: 1.4; }
  #side .summary { font-size: 12px; color: #94a3b8; margin: 0 4px 12px; }
  .all { display: flex; justify-content: space-between; align-items: center; padding: 7px 10px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .all:hover, .sec:hover, .gt:hover { background: #f1f5f9; }
  .all.active, .sec.active { background: #e8f0fe; color: #1a56db; }
  .grp { margin-top: 2px; }
  .gt { display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px; color: #334155; user-select: none; }
  .gt .arrow { font-size: 10px; color: #94a3b8; margin-right: 4px; transition: transform .15s; display: inline-block; width: 10px; }
  .grp.collapsed .arrow { transform: rotate(-90deg); }
  .grp.collapsed .secs { display: none; }
  .secs { margin: 2px 0 4px 14px; border-left: 1px dashed #e2e8f0; padding-left: 6px; }
  .sec { display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; cursor: pointer; font-size: 13px; color: #475569; }
  .sec .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n { color: #94a3b8; font-size: 12px; flex: none; }

  /* ---------- 右侧内容 ---------- */
  #main { flex: 1; overflow: auto; padding: 16px 22px 40px; }
  .bar { position: sticky; top: 0; z-index: 2; background: Canvas; padding: 8px 0 10px; display: flex; gap: 8px; flex-wrap: wrap; }
  input[type=search], select { padding: 6px 10px; font-size: 13px; border: 1px solid #cbd5e1; border-radius: 8px; background: Field; }
  input[type=search] { flex: 1; min-width: 200px; }
  .stat { color: #94a3b8; font-size: 12px; margin-bottom: 10px; }
  .crumb { font-size: 13px; color: #475569; margin-bottom: 8px; font-weight: 600; }

  .q { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
  .q h3 { font-size: 14px; margin: 0 0 8px; font-weight: 600; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 20px; background: #eef2f7; color: #475569; margin-right: 6px; }
  .tag.warn { background: #fff1e6; color: #b45309; }
  .tag.ok { background: #e8f7ee; color: #15803d; }
  .tag.chap { background: #eef2ff; color: #4338ca; }
  .q ol { margin: 6px 0 10px; padding-left: 22px; }
  .q ol li.hit { color: #15803d; font-weight: 600; }
  .imgs { margin: 6px 0 10px; }
  .imgs .qimg { max-width: 100%; max-height: 280px; border: 1px solid #e5e7eb; border-radius: 8px; margin: 0 8px 8px 0; background: #fff; }
  .subs { list-style: none; padding-left: 0; margin: 6px 0 10px; }
  .subs .sub { padding: 3px 10px; margin: 3px 0; background: #f6f8fa; border-radius: 6px; }
  .ans { background: #f6f8fa; border-radius: 8px; padding: 8px 10px; }
  .ans b { color: #15803d; }
  .exp { color: #555; margin-top: 6px; }

  @media (max-width: 860px) {
    body { display: block; height: auto; }
    #side { width: auto; border-right: none; border-bottom: 1px solid #e5e7eb; max-height: 40vh; }
    #main { height: auto; }
  }
</style>
</head>
<body>
<aside id="side">
  <h1>${escapeHtml(title)}</h1>
  <div class="summary" id="sideStat"></div>
  <div class="all active" id="allBtn"><span>全部题目</span><span class="n" id="allCount"></span></div>
  <div id="tree"></div>
</aside>

<main id="main">
  <div class="bar">
    <input type="search" id="kw" placeholder="搜索题面 / 答案 / 解析">
    <select id="type"><option value="">全部题型</option></select>
    <select id="flag">
      <option value="">全部状态</option>
      <option value="doubt">仅疑点</option>
      <option value="verified">仅已验证</option>
      <option value="img">仅有图</option>
    </select>
  </div>
  <div class="crumb" id="crumb"></div>
  <div class="stat" id="stat"></div>
  <div id="list"></div>
</main>

<script>
const QUESTIONS = ${data};
const CHAPTER_TITLES = ${titles};
const TYPE_LABEL_ORDER = ['单选题', '多选题', '判断题', '填空题', '连线题'];

/** 章节树：第N章 → 小节 → 题 */
function buildTree(items) {
  const groups = new Map();
  for (const q of items) {
    const sec = q.chapterName || '未分章';
    const num = (sec.match(/^(\\d+)/) || [])[1] || '0';
    const groupKey = num;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, { num, title: '第' + num + '章 ' + (CHAPTER_TITLES[num] || ''), sections: new Map() });
    }
    const g = groups.get(groupKey);
    if (!g.sections.has(sec)) g.sections.set(sec, []);
    g.sections.get(sec).push(q);
  }
  return Array.from(groups.values())
    .sort((a, b) => Number(a.num) - Number(b.num))
    .map((g) => ({
      ...g,
      count: Array.from(g.sections.values()).reduce((n, arr) => n + arr.length, 0),
      sections: Array.from(g.sections.entries())
        .sort((a, b) => a[0].localeCompare(b[0], 'zh', { numeric: true }))
        .map(([name, arr]) => ({ name, count: arr.length }))
    }));
}

const TREE = buildTree(QUESTIONS);
let active = { kind: 'all', key: '' };
const collapsed = new Set();

const el = (id) => document.getElementById(id);

function renderTree() {
  el('allCount').textContent = QUESTIONS.length;
  el('sideStat').textContent = '共 ' + QUESTIONS.length + ' 题 · ' + TREE.length + ' 章 · ' +
    TREE.reduce((n, g) => n + g.sections.length, 0) + ' 个小节';

  const tree = el('tree');
  tree.innerHTML = TREE.map((g) => {
    const isCollapsed = collapsed.has(g.num);
    const sections = g.sections.map((s) =>
      '<div class="sec' + (active.kind === 'section' && active.key === s.name ? ' active' : '') +
      '" data-sec="' + encodeURIComponent(s.name) + '"><span class="name">' + s.name + '</span><span class="n">' + s.count + '</span></div>'
    ).join('');
    return '<div class="grp' + (isCollapsed ? ' collapsed' : '') + '" data-group="' + g.num + '">' +
      '<div class="gt" data-gt="' + g.num + '"><span><span class="arrow">▼</span>' + g.title + '</span><span class="n">' + g.count + '</span></div>' +
      '<div class="secs">' + sections + '</div></div>';
  }).join('');

  // 事件：折叠 / 选小节
  tree.querySelectorAll('[data-gt]').forEach((node) => {
    node.onclick = () => {
      const num = node.getAttribute('data-gt');
      if (collapsed.has(num)) collapsed.delete(num); else collapsed.add(num);
      renderTree();
    };
  });
  tree.querySelectorAll('[data-sec]').forEach((node) => {
    node.onclick = () => {
      active = { kind: 'section', key: decodeURIComponent(node.getAttribute('data-sec')) };
      renderTree();
      render();
      el('main').scrollTo({ top: 0 });
    };
  });

  el('allBtn').classList.toggle('active', active.kind === 'all');
  el('allBtn').onclick = () => {
    active = { kind: 'all', key: '' };
    renderTree();
    render();
  };
}

function matchActive(q) {
  if (active.kind === 'all') return true;
  return (q.chapterName || '未分章') === active.key;
}

function render() {
  const kw = el('kw').value.trim().toLowerCase();
  const type = el('type').value;
  const flag = el('flag').value;
  const html = [];
  let shown = 0;

  QUESTIONS.forEach((q, i) => {
    if (!matchActive(q)) return;
    const doubt = (q.flags || []).length > 0;
    if (type && q.type !== type) return;
    if (flag === 'doubt' && !doubt) return;
    if (flag === 'verified' && !q.verified) return;
    if (flag === 'img' && !(q.images || []).length) return;
    const hay = ((q.searchText || '') + ' ' + (q.explanation || '')).toLowerCase();
    if (kw && !hay.includes(kw)) return;

    shown++;
    const hit = (q.answer || '').toUpperCase().replace(/[^A-Z]/g, '').split('');
    const opts = (q.options || []).map((t, idx) => {
      const letter = String.fromCharCode(65 + idx);
      const isHit = hit.includes(letter);
      return '<li class="' + (isHit ? 'hit' : '') + '">' + letter + '、 ' + String(t).replace(/</g, '&lt;') + '</li>';
    }).join('');
    const subs = (q.subItems || []).map((s) => {
      const groupText = (q.groups || [])[String(s.answer).charCodeAt(0) - 65] || '';
      return '<li class="sub">图' + s.no + ' → <b>' + s.answer + '</b>' + (groupText ? '（' + groupText + '）' : '') + '</li>';
    }).join('');
    const body = subs ? '<ul class="subs">' + subs + '</ul>' : (opts ? '<ol>' + opts + '</ol>' : '');
    const imgs = (q.images || [])
      .map((src) => '<img class="qimg" src="' + src + '" alt="题目图片" loading="lazy">')
      .join('');

    html.push(
      '<div class="q"><h3>' + (i + 1) + '. ' + String(q.title || '').replace(/</g, '&lt;') + '</h3>' +
      '<div>' +
        '<span class="tag">' + q.type + '</span>' +
        (q.chapterName ? '<span class="tag chap">' + q.chapterName + '</span>' : '') +
        (q.verified ? '<span class="tag ok">平台已验证</span>' : '<span class="tag">未验证</span>') +
        (doubt ? '<span class="tag warn">疑点：' + q.flags.join('、') + '</span>' : '') +
      '</div>' +
      (imgs ? '<div class="imgs">' + imgs + '</div>' : '') +
      body +
      '<div class="ans">答案：<b>' + q.answer + '</b>' + (q.answerText ? '（' + q.answerText + '）' : '') + '</div>' +
      (q.explanation ? '<div class="exp">解析：' + q.explanation + '</div>' : '') +
      '</div>'
    );
  });

  el('list').innerHTML = html.join('') || '<p>没有匹配的题目</p>';
  el('crumb').textContent = active.kind === 'all' ? '全部题目' : active.key;
  el('stat').textContent = '当前显示 ' + shown + ' 题 · 疑点 ' + QUESTIONS.filter((q) => (q.flags || []).length).length +
    ' 题 · 带图 ' + QUESTIONS.filter((q) => (q.images || []).length).length + ' 题';
}

// 题型下拉
const typeSel = el('type');
Array.from(new Set(QUESTIONS.map((q) => q.type)))
  .sort((a, b) => (TYPE_LABEL_ORDER.indexOf(a) + 1 || 99) - (TYPE_LABEL_ORDER.indexOf(b) + 1 || 99))
  .forEach((t) => {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    typeSel.appendChild(o);
  });

['input', 'change'].forEach((ev) => document.addEventListener(ev, render));
renderTree();
render();
</script>
</body>
</html>`;
}

