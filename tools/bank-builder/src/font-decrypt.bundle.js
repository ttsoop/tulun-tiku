"use strict";
var OCSFONT = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // packages/scripts/src/utils/font-decrypt/index.ts
  var index_exports = {};
  __export(index_exports, {
    FontDecryptor: () => FontDecryptor,
    collectChars: () => collectChars,
    crackChar: () => crackChar,
    crackFont: () => crackFont,
    decryptElements: () => decryptElements,
    decryptText: () => decryptText,
    extractFontFromStyle: () => extractFontFromStyle,
    findFontUrls: () => findFontUrls,
    listFontFaces: () => listFontFaces,
    loadRefTable: () => loadRefTable,
    watchElements: () => watchElements
  });

  // packages/scripts/src/utils/font-decrypt/ref-table.ts
  var refTableCache = /* @__PURE__ */ new Map();
  var REVALIDATE_WITH_VALIDATOR_MS = 60 * 60 * 1e3;
  var REVALIDATE_NO_VALIDATOR_MS = 7 * 24 * 60 * 60 * 1e3;
  var CACHE_NAME = "ocs-font-decrypt-ref-table-v1";
  var cachePromise;
  function openCache() {
    if (!cachePromise) {
      cachePromise = typeof caches === "undefined" ? Promise.resolve(void 0) : caches.open(CACHE_NAME).catch(() => void 0);
    }
    return cachePromise;
  }
  async function readPersistedRecord(url) {
    var _a, _b;
    const cache = await openCache();
    if (!cache) return void 0;
    try {
      const res = await cache.match(url);
      if (!res) return void 0;
      const updatedAt = Number(res.headers.get("x-ocs-updated-at") || 0);
      if (!updatedAt) return void 0;
      const data = await res.arrayBuffer();
      return {
        updatedAt,
        etag: (_a = res.headers.get("etag")) != null ? _a : void 0,
        lastModified: (_b = res.headers.get("last-modified")) != null ? _b : void 0,
        data
      };
    } catch (e) {
      return void 0;
    }
  }
  function buildCachedResponse(record) {
    const headers = new Headers({ "x-ocs-updated-at": String(record.updatedAt) });
    if (record.etag) headers.set("etag", record.etag);
    if (record.lastModified) headers.set("last-modified", record.lastModified);
    return new Response(record.data, { headers });
  }
  async function persist(url, buf, etag, lastModified) {
    const cache = await openCache();
    if (!cache) return;
    try {
      await cache.put(url, buildCachedResponse({ updatedAt: Date.now(), etag, lastModified, data: buf }));
    } catch (e) {
    }
  }
  async function touchPersisted(url, record) {
    const cache = await openCache();
    if (!cache) return;
    try {
      await cache.put(url, buildCachedResponse({ ...record, updatedAt: Date.now() }));
    } catch (e) {
    }
  }
  async function deletePersisted(url) {
    const cache = await openCache();
    if (!cache) return;
    try {
      await cache.delete(url);
    } catch (e) {
    }
  }
  function unpackBits(packed, offset, count, dims) {
    const bytesPerGlyph = dims / 8;
    const out = new Uint8Array(count * dims);
    for (let i = 0; i < count; i++) {
      const pBase = offset + i * bytesPerGlyph;
      const oBase = i * dims;
      for (let b = 0; b < bytesPerGlyph; b++) {
        const byte = packed[pBase + b];
        for (let k = 0; k < 8; k++) {
          out[oBase + b * 8 + k] = byte >> 7 - k & 1;
        }
      }
    }
    return out;
  }
  function parseRefTable(buf) {
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== "FRB2") {
      throw new Error("[font-decrypt] \u65E0\u6548\u7684\u7279\u5F81\u8868\u683C\u5F0F: " + magic);
    }
    const count = dv.getUint32(4, true);
    const threshold = dv.getUint32(8, true);
    const gc = dv.getUint32(12, true);
    const gf = dv.getUint32(16, true);
    const cps = new Uint32Array(count);
    let off = 20;
    for (let i = 0; i < count; i++, off += 4) {
      cps[i] = dv.getUint32(off, true);
    }
    const packed = new Uint8Array(buf);
    const coarse = unpackBits(packed, off, count, gc * gc);
    off += count * gc * gc / 8;
    const fine = unpackBits(packed, off, count, gf * gf);
    return { count, cps, coarse, fine, gc, gf, threshold };
  }
  async function fetchAndParseRefTable(url) {
    var _a, _b;
    const record = await readPersistedRecord(url);
    const hasValidator = !!((record == null ? void 0 : record.etag) || (record == null ? void 0 : record.lastModified));
    const interval = hasValidator ? REVALIDATE_WITH_VALIDATOR_MS : REVALIDATE_NO_VALIDATOR_MS;
    const parseRecord = (r) => parseRefTable(r.data);
    if (record && Date.now() - record.updatedAt <= interval) {
      try {
        console.debug("[font-decrypt] \u7279\u5F81\u8868\u547D\u4E2D\u672C\u5730\u7F13\u5B58\uFF1A", url);
        return parseRecord(record);
      } catch (e) {
        await deletePersisted(url);
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3e4);
    try {
      const headers = {};
      if (record == null ? void 0 : record.etag) {
        headers["If-None-Match"] = record.etag;
      } else if (record == null ? void 0 : record.lastModified) {
        headers["If-Modified-Since"] = record.lastModified;
      }
      const res = await fetch(url, { signal: controller.signal, headers });
      if (res.status === 304 && record) {
        console.debug("[font-decrypt] \u7279\u5F81\u8868\u670D\u52A1\u7AEF\u672A\u53D8\u66F4\uFF08304\uFF09\uFF0C\u6CBF\u7528\u672C\u5730\u7F13\u5B58\uFF1A", url);
        await touchPersisted(url, record);
        return parseRecord(record);
      }
      if (!res.ok) {
        throw new Error("[font-decrypt] \u7279\u5F81\u8868\u4E0B\u8F7D\u5931\u8D25: HTTP " + res.status);
      }
      const buf = await res.arrayBuffer();
      const table = parseRefTable(buf);
      await persist(url, buf, (_a = res.headers.get("etag")) != null ? _a : void 0, (_b = res.headers.get("last-modified")) != null ? _b : void 0);
      console.debug("[font-decrypt] \u7279\u5F81\u8868\u5DF2\u4ECE\u7F51\u7EDC\u52A0\u8F7D\u5E76\u7F13\u5B58\uFF1A", url);
      return table;
    } catch (err) {
      if (record) {
        try {
          console.warn("[font-decrypt] \u7279\u5F81\u8868\u7F51\u7EDC\u52A0\u8F7D\u5931\u8D25\uFF0C\u56DE\u9000\u4F7F\u7528\u672C\u5730\u7F13\u5B58\uFF1A", url);
          return parseRecord(record);
        } catch (e) {
          await deletePersisted(url);
        }
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  function loadRefTable(url) {
    let cached = refTableCache.get(url);
    if (!cached) {
      cached = fetchAndParseRefTable(url).catch((err) => {
        refTableCache.delete(url);
        throw err;
      });
      refTableCache.set(url, cached);
    }
    return cached;
  }

  // packages/scripts/src/utils/font-decrypt/worker.ts
  var WORKER_TIMEOUT = 3e4;
  var WORKER_SOURCE = `
'use strict';
var RENDER = 360, SQ = 480, BASELINE = 384, SHORTLIST = 40, INK_THRESHOLD = 40;

var renderCv = null;
function getRenderCtx() {
	if (!renderCv) {
		renderCv = new OffscreenCanvas(SQ, SQ);
		renderCv.ctx = renderCv.getContext('2d', { willReadFrequently: true });
	}
	return renderCv.ctx;
}

var covCv = {};
function isCoveredByFont(fontFamily, ch) {
	var render = function (fallback) {
		var cv = covCv[fallback];
		if (!cv) {
			cv = new OffscreenCanvas(200, 200);
			cv.ctx = cv.getContext('2d', { willReadFrequently: true });
			covCv[fallback] = cv;
		}
		var ctx = cv.ctx;
		ctx.clearRect(0, 0, 200, 200);
		ctx.fillStyle = '#fff';
		ctx.font = '120px "' + fontFamily + '", ' + fallback;
		ctx.textBaseline = 'middle';
		ctx.fillText(ch, 10, 100);
		return ctx.getImageData(0, 0, 200, 200).data;
	};
	var a = render('serif');
	var b = render('sans-serif');
	var diff = 0;
	for (var i = 3; i < a.length; i += 4) {
		diff += Math.abs(a[i] - b[i]);
	}
	return diff < 1000;
}

function renderGlyph(fontFamily, ch, table) {
	var ctx = getRenderCtx();
	ctx.clearRect(0, 0, SQ, SQ);
	ctx.fillStyle = '#fff';
	ctx.font = RENDER + 'px "' + fontFamily + '"';
	ctx.textBaseline = 'alphabetic';
	var advance = ctx.measureText(ch).width;
	ctx.fillText(ch, (SQ - advance) / 2, BASELINE);
	var px = ctx.getImageData(0, 0, SQ, SQ).data;

	var hasInk = false;
	for (var i = 3; i < px.length; i += 4) {
		if (px[i] > INK_THRESHOLD) { hasInk = true; break; }
	}
	if (!hasInk) {
		return null;
	}

	var W = SQ + 1;
	var ii = new Uint32Array(W * W);
	for (var y = 0; y < SQ; y++) {
		var rowSum = 0;
		var srcRow = y * SQ * 4;
		var dstRow = (y + 1) * W;
		var upRow = y * W;
		for (var x = 0; x < SQ; x++) {
			rowSum += px[srcRow + x * 4 + 3];
			ii[dstRow + x + 1] = ii[upRow + x + 1] + rowSum;
		}
	}

	var box = function (n) {
		var b = SQ / n;
		var area = b * b;
		var out = new Uint8Array(n * n);
		for (var gy = 0; gy < n; gy++) {
			for (var gx = 0; gx < n; gx++) {
				var y0 = gy * b;
				var x0 = gx * b;
				var sum = ii[(y0 + b) * W + x0 + b] - ii[y0 * W + x0 + b] - ii[(y0 + b) * W + x0] + ii[y0 * W + x0];
				out[gy * n + gx] = sum / area > table.threshold ? 1 : 0;
			}
		}
		return out;
	};

	return { coarse: box(table.gc), fine: box(table.gf) };
}

function bitDistance(tableArr, idx, dims, q) {
	var s = 0;
	var base = idx * dims;
	for (var i = 0; i < dims; i++) {
		if (tableArr[base + i] !== q[i]) { s++; }
	}
	return s;
}

function crackChar(table, feat) {
	var count = table.count;
	var dists = new Float64Array(count);
	for (var i = 0; i < count; i++) {
		dists[i] = bitDistance(table.coarse, i, table.gc * table.gc, feat.coarse);
	}
	var sorted = Float64Array.from(dists);
	sorted.sort();
	var threshold = sorted[Math.min(SHORTLIST, count) - 1];
	var idx = [];
	for (var j = 0; j < count; j++) {
		if (dists[j] <= threshold) { idx.push(j); }
	}
	var bestI = -1, best = Infinity, second = Infinity;
	for (var k = 0; k < idx.length; k++) {
		var d = bitDistance(table.fine, idx[k], table.gf * table.gf, feat.fine);
		if (d < best) { second = best; best = d; bestI = idx[k]; }
		else if (d < second) { second = d; }
	}
	return {
		ch: String.fromCodePoint(table.cps[bestI]),
		margin: second > 0 ? 1 - best / second : 1
	};
}

self.onmessage = function (e) {
	var msg = e.data;
	(async function () {
		if (typeof FontFace === 'undefined' || typeof OffscreenCanvas === 'undefined' || !self.fonts) {
			throw new Error('worker env unsupported');
		}
		var family = 'font-decrypt-w-' + Math.random().toString(36).slice(2);
		var source = typeof msg.fontSource === 'string' ? 'url("' + msg.fontSource + '")' : msg.fontSource;
		var face = new FontFace(family, source, msg.fontWeight ? { weight: msg.fontWeight } : {});
		await face.load();
		self.fonts.add(face);
		var table = {
			count: msg.count, cps: msg.cps, coarse: msg.coarse, fine: msg.fine,
			gc: msg.gc, gf: msg.gf, threshold: msg.threshold
		};
		var map = {};
		var details = [];
		var uniq = msg.chars;
		for (var i = 0; i < uniq.length; i++) {
			var ch = uniq[i];
			if (!isCoveredByFont(family, ch)) { map[ch] = ch; continue; }
			var feat = renderGlyph(family, ch, table);
			if (!feat) { map[ch] = ch; continue; }
			var r = crackChar(table, feat);
			map[ch] = r.ch;
			details.push({ from: ch, to: r.ch, margin: +r.margin.toFixed(3) });
			self.postMessage({ type: 'progress', done: i + 1, total: uniq.length });
		}
		self.postMessage({ type: 'result', map: map, details: details });
	})().catch(function (err) {
		self.postMessage({ type: 'error', message: String((err && err.message) || err) });
	});
};
`;
  function crackFontInWorker(fontSource, chars, config, table) {
    return new Promise((resolve) => {
      if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") {
        return resolve(null);
      }
      let worker;
      try {
        const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "application/javascript" }));
        worker = new Worker(url);
        URL.revokeObjectURL(url);
      } catch (e) {
        return resolve(null);
      }
      let settled = false;
      const timer = setTimeout(() => done(null), WORKER_TIMEOUT);
      const done = (r) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          worker.terminate();
          resolve(r);
        }
      };
      worker.onerror = () => done(null);
      worker.onmessage = (e) => {
        var _a;
        const msg = e.data;
        if (msg.type === "progress") {
          (_a = config.onProgress) == null ? void 0 : _a.call(config, msg.done, msg.total);
        } else if (msg.type === "result") {
          done({ map: msg.map, details: msg.details });
        } else if (msg.type === "error") {
          done(null);
        }
      };
      worker.postMessage({
        fontSource,
        chars,
        fontWeight: config.fontWeight,
        count: table.count,
        cps: table.cps,
        coarse: table.coarse,
        fine: table.fine,
        gc: table.gc,
        gf: table.gf,
        threshold: table.threshold
      });
    });
  }

  // packages/scripts/src/utils/font-decrypt/bitmap.ts
  var RENDER = 360;
  var SQ = 480;
  var BASELINE = 384;
  var SHORTLIST = 40;
  var INK_THRESHOLD = 40;
  var renderCanvas;
  function getRenderCanvas() {
    if (!renderCanvas) {
      const cv = document.createElement("canvas");
      cv.width = SQ;
      cv.height = SQ;
      renderCanvas = { cv, ctx: cv.getContext("2d", { willReadFrequently: true }) };
    }
    return renderCanvas;
  }
  function renderGlyph(fontFamily, ch, table) {
    const { ctx } = getRenderCanvas();
    ctx.clearRect(0, 0, SQ, SQ);
    ctx.fillStyle = "#fff";
    ctx.font = `${RENDER}px "${fontFamily}"`;
    ctx.textBaseline = "alphabetic";
    const advance = ctx.measureText(ch).width;
    ctx.fillText(ch, (SQ - advance) / 2, BASELINE);
    const px = ctx.getImageData(0, 0, SQ, SQ).data;
    let hasInk = false;
    for (let i = 3; i < px.length; i += 4) {
      if (px[i] > INK_THRESHOLD) {
        hasInk = true;
        break;
      }
    }
    if (!hasInk) {
      return null;
    }
    const W = SQ + 1;
    const ii = new Uint32Array(W * W);
    for (let y = 0; y < SQ; y++) {
      let rowSum = 0;
      const srcRow = y * SQ * 4;
      const dstRow = (y + 1) * W;
      const upRow = y * W;
      for (let x = 0; x < SQ; x++) {
        rowSum += px[srcRow + x * 4 + 3];
        ii[dstRow + x + 1] = ii[upRow + x + 1] + rowSum;
      }
    }
    const box = (n) => {
      const b = SQ / n;
      const area = b * b;
      const out = new Uint8Array(n * n);
      for (let gy = 0; gy < n; gy++) {
        for (let gx = 0; gx < n; gx++) {
          const y0 = gy * b;
          const x0 = gx * b;
          const sum = ii[(y0 + b) * W + x0 + b] - ii[y0 * W + x0 + b] - ii[(y0 + b) * W + x0] + ii[y0 * W + x0];
          out[gy * n + gx] = sum / area > table.threshold ? 1 : 0;
        }
      }
      return out;
    };
    return { coarse: box(table.gc), fine: box(table.gf) };
  }
  var coverageCanvasCache = {};
  function isCoveredByFont(fontFamily, ch) {
    const render = (fallback) => {
      var _a;
      const key = fontFamily + "|" + fallback;
      const cv = (_a = coverageCanvasCache[key]) != null ? _a : coverageCanvasCache[key] = (() => {
        const c = document.createElement("canvas");
        c.width = 200;
        c.height = 200;
        return c;
      })();
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, 200, 200);
      ctx.fillStyle = "#fff";
      ctx.font = `120px "${fontFamily}", ${fallback}`;
      ctx.textBaseline = "middle";
      ctx.fillText(ch, 10, 100);
      return ctx.getImageData(0, 0, 200, 200).data;
    };
    const a = render("serif");
    const b = render("sans-serif");
    let diff = 0;
    for (let i = 3; i < a.length; i += 4) {
      diff += Math.abs(a[i] - b[i]);
    }
    return diff < 1e3;
  }
  function bitDistance(tableArr, idx, dims, q) {
    let s = 0;
    const base = idx * dims;
    for (let i = 0; i < dims; i++) {
      if (tableArr[base + i] !== q[i]) {
        s++;
      }
    }
    return s;
  }
  function crackChar(table, feat) {
    const { count, cps, coarse, fine, gc, gf } = table;
    const dists = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      dists[i] = bitDistance(coarse, i, gc * gc, feat.coarse);
    }
    const sorted = Float64Array.from(dists);
    sorted.sort();
    const threshold = sorted[Math.min(SHORTLIST, count) - 1];
    const idx = [];
    for (let i = 0; i < count; i++) {
      if (dists[i] <= threshold) {
        idx.push(i);
      }
    }
    let bestI = -1;
    let best = Infinity;
    let second = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const d = bitDistance(fine, i, gf * gf, feat.fine);
      if (d < best) {
        second = best;
        best = d;
        bestI = i;
      } else if (d < second) {
        second = d;
      }
    }
    return {
      ch: String.fromCodePoint(cps[bestI]),
      best,
      second,
      margin: second > 0 ? 1 - best / second : 1
    };
  }
  async function crackFont(fontSource, chars, config) {
    var _a;
    const table = await loadRefTable(config.refTableUrl);
    const uniq = [...new Set(chars)].filter((c) => c.trim() !== "");
    if (config.useWorker !== false) {
      const r = await crackFontInWorker(fontSource, uniq, config, table);
      if (r) {
        return r;
      }
    }
    const family = "font-decrypt-" + Math.random().toString(36).slice(2);
    const source = typeof fontSource === "string" ? `url("${fontSource}")` : fontSource;
    const face = new FontFace(family, source, config.fontWeight ? { weight: config.fontWeight } : {});
    await Promise.race([
      face.load(),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("[font-decrypt] \u5B57\u4F53\u52A0\u8F7D\u8D85\u65F6")), 15e3))
    ]);
    document.fonts.add(face);
    const map = {};
    const details = [];
    for (let i = 0; i < uniq.length; i++) {
      const ch = uniq[i];
      if (!isCoveredByFont(family, ch)) {
        map[ch] = ch;
        continue;
      }
      const feat = renderGlyph(family, ch, table);
      if (!feat) {
        map[ch] = ch;
        continue;
      }
      const r = crackChar(table, feat);
      map[ch] = r.ch;
      details.push({ from: ch, to: r.ch, margin: +r.margin.toFixed(3) });
      (_a = config.onProgress) == null ? void 0 : _a.call(config, i + 1, uniq.length);
      if (i % 10 === 9) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return { map, details };
  }
  function decryptText(text, map) {
    return [...text].map((c) => {
      var _a;
      return (_a = map[c]) != null ? _a : c;
    }).join("");
  }
  function decryptElements(roots, map) {
    var _a;
    for (const root of Array.isArray(roots) ? roots : [roots]) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        nodes.push(walker.currentNode);
      }
      for (const node of nodes) {
        node.nodeValue = decryptText((_a = node.nodeValue) != null ? _a : "", map);
      }
    }
  }
  function collectChars(roots) {
    var _a;
    let text = "";
    for (const root of Array.isArray(roots) ? roots : [roots]) {
      text += (_a = root.textContent) != null ? _a : "";
    }
    return text;
  }
  function findFontUrls(doc = document) {
    var _a, _b;
    const urls = /* @__PURE__ */ new Set();
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSFontFaceRule) {
            const m = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"));
            if (m) {
              urls.add(new URL(m[1], location.href).href);
            }
          }
        }
      } catch (e) {
      }
    }
    const perf = (_b = (_a = doc.defaultView) == null ? void 0 : _a.performance) != null ? _b : performance;
    for (const entry of perf.getEntriesByType("resource")) {
      if (/\.(ttf|otf|woff2?)(\?|$)/i.test(entry.name)) {
        urls.add(entry.name);
      }
    }
    return [...urls];
  }
  function extractFontFromStyle(doc, fontFamilyMarker) {
    var _a, _b;
    const styleEl = Array.from(doc.head.querySelectorAll("style")).find((s) => {
      var _a2;
      return (_a2 = s.textContent) == null ? void 0 : _a2.includes(fontFamilyMarker);
    });
    const base64 = (_b = (_a = styleEl == null ? void 0 : styleEl.textContent) == null ? void 0 : _a.match(/base64,([\w\W]+?)['")]/)) == null ? void 0 : _b[1];
    if (!base64) {
      return void 0;
    }
    const raw = window.atob(base64);
    const buffer = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      buffer[i] = raw.charCodeAt(i);
    }
    return buffer.buffer;
  }
  function listFontFaces(doc = document) {
    var _a, _b;
    const faces = [];
    for (const sheet of Array.from(doc.styleSheets)) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule instanceof CSSFontFaceRule) {
            const family = rule.style.getPropertyValue("font-family").replace(/["']/g, "").trim();
            const m = /url\(["']?([^"')]+)["']?\)/.exec(rule.style.getPropertyValue("src"));
            if (family && m) {
              const base = (_b = (_a = doc.location) == null ? void 0 : _a.href) != null ? _b : location.href;
              faces.push({ family, src: m[1].startsWith("data:") ? m[1] : new URL(m[1], base).href });
            }
          }
        }
      } catch (e) {
      }
    }
    return faces;
  }

  // packages/scripts/src/utils/font-decrypt/decryptor.ts
  var FontDecryptor = class _FontDecryptor {
    constructor(fontSource, config) {
      /** 累计映射表（密文字 -> 真实字），同一字体终身复用 */
      this.map = {};
      /** 任务队列：所有解密串行执行，避免并发破解/重复破解 */
      this.queue = Promise.resolve();
      this.fontSource = fontSource;
      this.config = config;
    }
    /**
     * 创建解密器并预热特征表（后台提前下载，避免首次解密卡顿）。
     */
    static async create(fontSource, config) {
      await loadRefTable(config.refTableUrl);
      return new _FontDecryptor(fontSource, config);
    }
    /** 当前映射表已破解的字符数 */
    get size() {
      return Object.keys(this.map).length;
    }
    /**
     * 解密一组元素：自动增量破解新字符后应用映射。
     * 多次调用通过内部队列串行化，重复字符不会重复破解。
     */
    decrypt(els) {
      return this.enqueue(async () => {
        const chars = collectChars(els);
        const newChars = [...new Set(chars)].filter((c) => c.trim() !== "" && !(c in this.map));
        if (newChars.length) {
          const useWorker = newChars.length > 20 ? this.config.useWorker : false;
          const r = await crackFont(this.fontSource, newChars, { ...this.config, useWorker });
          Object.assign(this.map, r.map);
        }
        decryptElements(els, this.map);
      });
    }
    /**
     * 等待所有已排队的解密任务完成（无任务时立即 resolve）。
     * 供自动答题等下游程序在读取页面文本前调用，防止与解密冲突。
     */
    waitForIdle() {
      return this.queue;
    }
    enqueue(task) {
      const run = this.queue.then(task, task);
      this.queue = run.catch(() => void 0);
      return run;
    }
  };
  function watchElements(root, selector, onFound, options) {
    var _a, _b;
    const target = root instanceof Document ? (_a = root.body) != null ? _a : root.documentElement : root;
    const debounceMs = (_b = options == null ? void 0 : options.debounceMs) != null ? _b : 50;
    let stopped = false;
    let timer;
    let running = false;
    let rescan = false;
    const scan = async () => {
      if (stopped || running) {
        rescan = !stopped;
        return;
      }
      running = true;
      try {
        const els = Array.from(target.querySelectorAll(selector));
        if (els.length) {
          await onFound(els);
        }
      } catch (err) {
        console.error("[font-decrypt] watchElements \u56DE\u8C03\u6267\u884C\u5931\u8D25\uFF1A", err);
      } finally {
        running = false;
        if (rescan && !stopped) {
          rescan = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (stopped) {
        return;
      }
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = void 0;
        scan();
      }, debounceMs);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(target, { childList: true, subtree: true, characterData: true });
    scan();
    return {
      stop: () => {
        stopped = true;
        clearTimeout(timer);
        timer = void 0;
        observer.disconnect();
      },
      isBusy: () => timer !== void 0 || running || rescan
    };
  }
  return __toCommonJS(index_exports);
})();
