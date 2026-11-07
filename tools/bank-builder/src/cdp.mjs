/**
 * CDP 连接与页面定位
 *
 * 用法前提：用户用调试端口启动 Chrome（专用 profile，已登录超星）：
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\ocs-cdp"
 */
import { chromium } from 'playwright-core';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 连接已启动调试端口的 Chrome */
export async function connect(port = 9222) {
	const endpoint = `http://127.0.0.1:${port}`;
	const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
	return browser;
}

/** 所有页面（含 iframe 内部的 frame） */
export function allFrames(browser) {
	const result = [];
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			for (const frame of page.frames()) {
				result.push({ page, frame });
			}
		}
	}
	return result;
}

/**
 * 找到含题目的 frame（超星章节测验在 iframe 里）。
 * @param {import('playwright-core').Browser} browser
 * @param {string} [urlMatch] 可选：只在该 URL 含关键字的页面里找
 */
export async function findQuizFrame(browser, urlMatch) {
	for (const { page, frame } of allFrames(browser)) {
		if (urlMatch && !page.url().includes(urlMatch)) continue;
		try {
			const count = await frame.evaluate(() => document.querySelectorAll('.TiMu').length);
			if (count > 0) return { page, frame, count };
		} catch {
			// 跨域 frame 或已销毁，跳过
		}
	}
	return undefined;
}

/** 当前所有页面的 URL（probe 用） */
export async function listPages(browser) {
	const out = [];
	for (const context of browser.contexts()) {
		for (const page of context.pages()) {
			let frames = [];
			try {
				frames = page.frames().map((f) => f.url());
			} catch {}
			out.push({ url: page.url(), title: await page.title().catch(() => ''), frames });
		}
	}
	return out;
}

/**
 * 接管原生弹窗（alert/confirm），把文字记录下来并自动确认。
 * 返回 { messages, dispose }：messages 会持续累积。
 */
export function captureDialogs(page) {
	const messages = [];
	const handler = async (dialog) => {
		try {
			messages.push({ type: dialog.type(), message: dialog.message() });
		} catch {}
		try {
			await dialog.accept();
		} catch {}
	};
	page.on('dialog', handler);
	return {
		messages,
		dispose: () => page.off('dialog', handler)
	};
}

/** 在 frame 内安全执行（frame 可能被销毁/跨域） */
export async function safeEvaluate(frame, fn, arg) {
	try {
		return await frame.evaluate(fn, arg);
	} catch (e) {
		return { __error: String(e && e.message ? e.message : e) };
	}
}
