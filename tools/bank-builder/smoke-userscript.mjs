/**
 * 真实页面加载测试：把 dist/ocs.user.js 注入一个真实的超星测验页
 *
 * 目的：验证「装进油猴后能不能启动、面板能不能出来」，
 * 不依赖 Tampermonkey 扩展（用最小 GM 桩 + document-start 注入）。
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const STUBS = `
(() => {
  const prefix = '__gm__';
  const store = {
    get(k, d) { const v = localStorage.getItem(prefix + k); if (v === null) return d; try { return JSON.parse(v); } catch { return d; } },
    set(k, v) { localStorage.setItem(prefix + k, JSON.stringify(v)); },
    del(k) { localStorage.removeItem(prefix + k); },
    keys() { return Object.keys(localStorage).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); }
  };
  const listeners = {};
  const nativeFetch = window.fetch.bind(window);
  const doFetch = (...args) => nativeFetch(...args);
  window.unsafeWindow = window;
  window.GM_info = { script: { name: 'OCS 网课助手', namespace: 'https://enncy.cn', version: '5.3.1', description: 't' }, scriptHandler: 'Tampermonkey', scriptMetaStr: '', version: '5.3.1' };
  window.GM_getValue = (k, d) => store.get(k, d);
  window.GM_setValue = (k, v) => store.set(k, v);
  window.GM_deleteValue = (k) => store.del(k);
  window.GM_listValues = () => store.keys();
  window.GM_getTab = (cb) => cb && cb({});
  window.GM_saveTab = () => {};
  window.GM_notification = (text, opts) => { (window.__gm_notifications = window.__gm_notifications || []).push({ text }); };
  window.GM_getResourceText = () => '';
  window.GM_addValueChangeListener = (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); return k; };
  window.GM_removeValueChangeListener = (id) => { delete listeners[id]; };
  window.GM_xmlhttpRequest = (opts) => {
    doFetch(opts.url, { method: opts.method || 'GET', headers: opts.headers, body: opts.data })
      .then(async (res) => {
        const text = await res.text();
        if (res.ok) opts.onload && opts.onload({ status: res.status, responseText: text, response: text, finalUrl: opts.url, responseHeaders: '' });
        else opts.onerror && opts.onerror({ status: res.status, statusText: res.statusText });
      })
      .catch((e) => opts.onerror && opts.onerror(e));
  };
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push('onerror: ' + String(e.message).slice(0, 200)));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandled: ' + String(e.reason).slice(0, 200)));
})();
`;

const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = b.contexts()[0];
let baseUrl = '';
for (const p of ctx.pages()) if (/studentstudy/.test(p.url())) baseUrl = p.url();
if (!baseUrl) {
	console.log('没有找到课程页，跳过');
	await b.close();
	process.exit(0);
}
const page = await ctx.newPage();

const script = fs.readFileSync('dist/ocs.user.js', 'utf8');
const body = script.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
await page.addInitScript({ content: STUBS + '\n;(function(){\n' + body + '\n})();' });

await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
	const tags = Array.from(document.querySelectorAll('*')).filter((el) => el.tagName.includes('-')).map((el) => el.tagName.toLowerCase());
	return {
		errors: (window.__errors || []).slice(0, 8),
		hasOCS: typeof window.OCS === 'object',
		customTags: Array.from(new Set(tags)).slice(0, 12),
		panelText: (document.querySelector('script-panel-element') || {}).innerText?.replace(/\s+/g, ' ').slice(0, 160) || '',
		notifications: (window.__gm_notifications || []).map((n) => String(n.text).slice(0, 60)),
		gmKeys: Object.keys(localStorage).filter((k) => k.startsWith('__gm__')).slice(0, 8),
		hasRenderScript: typeof window.OCS?.RenderScript,
		visibleText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120)
	};
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: 'tools/bank-builder/out/userscript-real.png' });
console.log('截图: tools/bank-builder/out/userscript-real.png');
await page.close();
await b.close();

