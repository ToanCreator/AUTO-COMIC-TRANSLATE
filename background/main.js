/* Điều phối dịch: tải ảnh → cắt lát → Gemini (song song) → xoá chữ + vẽ (worker) → trả về trang. */
(function () {
  'use strict';
  const ACT = self.ACT;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = (tabId, msg) => browser.tabs.sendMessage(tabId, msg).catch(() => {});

  /* ---------------- Worker pool ---------------- */
  class WorkerPool {
    constructor(n) {
      this.idle = []; this.q = []; this.seq = 1; this.pending = new Map();
      for (let i = 0; i < n; i++) this.spawn();
    }
    spawn() {
      const w = new Worker(browser.runtime.getURL('worker/worker.js'));
      w.onmessage = (e) => {
        const { id, ok, res, error } = e.data, p = this.pending.get(id);
        this.pending.delete(id); this.idle.push(w); this.next();
        if (p) ok ? p.resolve(res) : p.reject(new Error(error));
      };
      w.onerror = (ev) => {
        if (ev.preventDefault) ev.preventDefault();
        const err = new Error(ACT.tr('m_worker', ev.message || ev.filename || ACT.tr('m_unknown')));
        for (const [id, p] of this.pending) if (p.w === w) { this.pending.delete(id); p.reject(err); }
        this.idle.push(w); this.next();
      };
      this.idle.push(w);
    }
    exec(msg) {
      return new Promise((resolve, reject) => { this.q.push({ msg, resolve, reject }); this.next(); });
    }
    next() {
      while (this.idle.length && this.q.length) {
        const w = this.idle.pop(), job = this.q.shift(), id = this.seq++;
        this.pending.set(id, { resolve: job.resolve, reject: job.reject, w });
        w.postMessage(Object.assign({}, job.msg, { id }));
      }
    }
  }
  const MOBILE = /Android|Mobile/i.test(navigator.userAgent || '');
  let pool = null;      // điện thoại: ít worker hơn để đỡ tốn RAM khi giải mã ảnh lớn
  const getPool = () => pool || (pool = new WorkerPool(MOBILE ? 2 : Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))));

  /* ---------------- Tải ảnh (đặt Referer của trang để qua chống hotlink) ---------------- */
  const refMap = new Map();
  try {
    if (browser.webRequest && browser.webRequest.onBeforeSendHeaders) {
      browser.webRequest.onBeforeSendHeaders.addListener((d) => {
        if (d.tabId !== -1) return {};
        const ref = refMap.get(d.url);
        if (!ref) return {};
        const hs = d.requestHeaders.filter((h) => h.name.toLowerCase() !== 'referer');
        hs.push({ name: 'Referer', value: ref });
        return { requestHeaders: hs };
      }, { urls: ['<all_urls>'], types: ['xmlhttprequest'], tabId: -1 }, ['blocking', 'requestHeaders']);
    }
  } catch (e) { console.warn('[ACT] không đặt được Referer cho tải ảnh:', e && e.message); }

  async function fetchImage(url, pageUrl, signal) {
    if (/^blob:/i.test(url)) throw new Error(ACT.tr('m_blob'));
    refMap.set(url, pageUrl);
    try {
      const r = await fetch(url, { credentials: 'include', cache: 'force-cache', signal });
      if (!r.ok) throw new Error(ACT.tr('m_http', r.status));
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 200) throw new Error(ACT.tr('m_emptyimg'));
      return buf;
    } finally { setTimeout(() => refMap.delete(url), 30000); }
  }

  /* giữ bản gốc trong RAM để vẽ lại / dịch vùng chọn không phải tải lại */
  const orig = new Map();
  function rememberOrig(url, buf) {
    orig.delete(url); orig.set(url, buf);
    let total = 0; for (const b of orig.values()) total += b.byteLength;
    for (const k of orig.keys()) { if (orig.size <= 12 && total <= 160e6) break; total -= orig.get(k).byteLength; orig.delete(k); }
  }

  /* ---------------- Cache vùng chữ (đã dịch) ---------------- */
  const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
  const cacheKey = (url, S) => 'c2:' + fnv(url) + fnv([S.model, S.src, S.dst, S.quality, S.freeText ? 1 : 0, S.sfx ? 1 : 0, S.keepNames ? 1 : 0, S.extra, S.glossary].join('|')) + url.length;
  const CACHE_MAX = 500;
  let chain = Promise.resolve();
  const cacheGet = async (k) => { try { return (await browser.storage.local.get(k))[k] || null; } catch (e) { return null; } };
  function cacheSet(k, v) {
    chain = chain.then(async () => {
      const idx = ((await browser.storage.local.get('cacheIdx')).cacheIdx) || [];
      const i = idx.indexOf(k); if (i >= 0) idx.splice(i, 1);
      idx.push(k);
      const drop = idx.length > CACHE_MAX ? idx.splice(0, idx.length - CACHE_MAX) : [];
      await browser.storage.local.set({ [k]: v, cacheIdx: idx });
      if (drop.length) await browser.storage.local.remove(drop);
    }).catch(() => {});
    return chain;
  }

  /* ---------------- Run ---------------- */
  const runs = new Map(), tabRuns = new Map();
  let runSeq = 1;

  function makeRun(tabId, S, msg) {
    const run = {
      id: runSeq++, tabId, S, pageUrl: msg.pageUrl, ctrl: new AbortController(),
      keys: new ACT.KeyPool(ACT.parseKeys(S.keys), S.perKey),
      usage: { in: 0, out: 0, req: 0 }, total: msg.items.length, done: 0, failed: 0, drawn: 0, t0: Date.now(), fatal: '',
      glossary: ACT.parseGlossary(S.glossary), learned: new Map(), recent: []
    };
    run.glossaryText = () => [...run.learned, ...run.glossary].slice(-60).map(([a, b]) => a + '=' + b).join('; ');
    run.learn = (g) => {
      for (const s of g || []) {
        const i = s.indexOf('='), a = s.slice(0, i).trim(), b = s.slice(i + 1).trim();
        if (a && b && !run.glossary.has(a)) run.learned.set(a, b);
      }
    };
    run.recentFor = (order) => {
      let best = null;
      for (const r of run.recent) if (r.order < order && (!best || r.order > best.order)) best = r;
      return best ? best.lines.slice(-6) : [];
    };
    return run;
  }

  function progress(run, final) {
    const now = Date.now();
    send(run.tabId, {
      evt: 'progress', runId: run.id, done: run.done, total: run.total, failed: run.failed, drawn: run.drawn,
      tin: run.usage.in, tout: run.usage.out, req: run.usage.req, ms: now - run.t0, final: !!final,
      keys: run.keys.keys.map((k) => ({ i: k.i, inflight: k.inflight, limit: k.limit, dead: k.dead, why: k.why, wait: Math.max(0, k.until - now), ok: k.ok }))
    });
  }

  const centerIn = (r, c) => { const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2; return cx >= c.x0 && cx <= c.x1 && cy >= c.y0 && cy <= c.y1; };
  /* độ chồng lấp so với mục NHỎ hơn: model hay trả cùng một chữ hai lần với hai khung khác cỡ (IoU không bắt được) */
  const iou = (a, b) => {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const i = ix * iy, m = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
    return m > 0 ? i / m : 0;
  };

  async function askSlice(run, item, sl, i, n) {
    const S = run.S;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const prompt = ACT.buildPrompt(S, { idx: i, n, crop: !!item.crop, glossary: run.glossaryText(), recent: run.recentFor(item.order) });
        const r = await ACT.callGemini(run.keys, S.model, (caps) => ACT.buildBody(S, prompt, sl.b64, 4096, attempt ? 0.6 : 0.1, caps), { signal: run.ctrl.signal, usage: run.usage });
        const parsed = ACT.parseRegions(r.text, sl.tw, sl.th);
        if (!parsed) throw new Error(ACT.tr('m_badjson'));
        run.learn(parsed.g);
        const hh = sl.y1 - sl.y0, ww = sl.x1 - sl.x0, regs = [];
        for (const it of parsed.items) {
          if (!S.freeText && it.k === 'f') continue;
          if (!S.sfx && it.k === 'x') continue;
          const reg = { x0: sl.x0 + it.b[1] / 1000 * ww, y0: sl.y0 + it.b[0] / 1000 * hh, x1: sl.x0 + it.b[3] / 1000 * ww, y1: sl.y0 + it.b[2] / 1000 * hh, t: it.t, k: it.k };
          const cy = (reg.y0 + reg.y1) / 2;
          if (n > 1 && (cy < sl.c0 || cy >= sl.c1)) continue;       // thuộc lát bên cạnh
          regs.push(reg);
        }
        return { regs };
      } catch (e) {
        if (e.aborted) throw e;
        if (e.blocked || e.noKeys || attempt === 1) return { error: e };
        await sleep(800);
      }
    }
  }

  async function processItem(run, item) {
    const S = run.S, P = getPool(), q = ACT.QUALITY[S.quality] || ACT.QUALITY.balanced;
    const key = cacheKey(item.url, S);
    let regions = null;
    if (!item.crop) {
      const c = await cacheGet(key);
      if (c && !c.partial && Array.isArray(c.regions)) regions = c.regions;
    }
    let bytes = item.bytes || orig.get(item.url);
    if (!bytes) bytes = await fetchImage(item.url, run.pageUrl, run.ctrl.signal);
    rememberOrig(item.url, bytes);

    let warn = '';
    if (!regions) {
      const prep = await P.exec({ op: 'prep', buf: bytes, modelW: q.modelW, jpegQ: q.q, crop: item.crop || null });
      const n = prep.slices.length;
      const out = await Promise.all(prep.slices.map((sl, i) => askSlice(run, item, sl, i, n)));
      const bad = out.filter((o) => o.error);
      if (bad.length === n) throw bad[0].error;
      if (bad.length) warn = ACT.tr('m_slices_failed', bad.length, n);
      let fresh = [];
      for (const o of out) if (o.regs) fresh = fresh.concat(o.regs);
      const uniq = [];
      for (const r of fresh) {
        const k = uniq.findIndex((u) => iou(u, r) > 0.55);
        if (k < 0) uniq.push(r);
        else if (uniq[k].k === 'f' && r.k !== 'f') uniq[k] = r;       // trùng: ưu tiên mục trong bong bóng/khung hơn mục chữ tự do
      }
      let merged = uniq;
      if (item.crop) {
        const prior = ((await cacheGet(key)) || {}).regions || [];
        merged = prior.filter((r) => !centerIn(r, item.crop)).concat(uniq);
      }
      if (!bad.length) await cacheSet(key, { regions: merged, partial: !!item.crop, t: Date.now() });
      regions = merged;
    }
    try {
      const o2 = { signal: run.ctrl.signal, usage: run.usage };
      let fixed = await ACT.fixAccents(run.keys, S, regions, o2);
      if (S.proofread !== false && regions.some((r) => !r.pr)) fixed += (await ACT.proofread(run.keys, S, regions, o2)) + 1;
      if (fixed && !item.crop && !warn) await cacheSet(key, { regions, partial: false, t: Date.now() });
    } catch (e) { if (e.aborted) throw e; }
    regions = regions.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
    run.recent.push({ order: item.order, lines: regions.map((r) => r.t) });
    if (!regions.length) { send(run.tabId, { evt: 'img', id: item.id, none: true }); return; }

    const r = await P.exec({
      op: 'render', buf: bytes, regions,
      opts: { bold: S.bold, fontStack: ACT.fontStack(S), freeText: S.freeText, sizeScale: S.sizeScale }
    });
    run.drawn += r.drawn;
    await send(run.tabId, { evt: 'img', id: item.id, buf: r.out, w: r.w, h: r.h, drawn: r.drawn, skipped: r.skipped, warn });
  }

  async function startRun(tabId, msg) {
    const S = Object.assign({}, ACT.S);
    if (!ACT.parseKeys(S.keys).length) { send(tabId, { evt: 'fatal', code: 'nokey', msg: ACT.tr('m_nokey') }); return; }
    const run = makeRun(tabId, S, msg);
    runs.set(run.id, run);
    if (!tabRuns.has(tabId)) tabRuns.set(tabId, new Set());
    tabRuns.get(tabId).add(run.id);
    send(tabId, { evt: 'start', runId: run.id, total: run.total });
    const caps0 = ACT.capsOf(S.model);
    if (!caps0.ok) {
      send(tabId, { evt: 'note', text: ACT.tr('m_preflight') });
      try { await ACT.preflight(run.keys, S, run.ctrl.signal); }
      catch (e) {
        if (!e.aborted) { run.fatal = String(e.message || e); console.error('[ACT] preflight lỗi:', run.fatal); }
        run.ctrl.abort();
      }
    }
    const slots = Math.max(2, Math.min(MOBILE ? 6 : 24, Math.ceil(run.keys.capacity() * 1.5) + 1));
    const queue = msg.items.slice();
    const tick = setInterval(() => progress(run), 400);
    await Promise.all(Array.from({ length: Math.min(slots, queue.length) }, async () => {
      while (queue.length && !run.ctrl.signal.aborted) {
        const it = queue.shift();
        try { await processItem(run, it); }
        catch (e) {
          if (e.aborted || run.ctrl.signal.aborted) return;
          run.failed++;
          send(tabId, { evt: 'imgError', id: it.id, error: String(e.message || e) });
          if (e.noKeys && !run.fatal) { run.fatal = e.message; run.ctrl.abort(); }
        } finally { run.done++; }
      }
    }));
    clearInterval(tick);
    progress(run, true);
    send(tabId, { evt: 'finish', runId: run.id, aborted: run.ctrl.signal.aborted, fatal: run.fatal });
    runs.delete(run.id);
    const set = tabRuns.get(tabId); if (set) set.delete(run.id);
  }

  function stopTab(tabId) {
    const set = tabRuns.get(tabId);
    if (set) for (const id of set) { const r = runs.get(id); if (r) r.ctrl.abort(); }
  }

  /* ---------------- Tin nhắn từ trang / trang cài đặt ---------------- */
  browser.runtime.onMessage.addListener((msg, sender) => {
    const tabId = sender.tab && sender.tab.id;
    switch (msg && msg.cmd) {
      case 'start':
        startRun(tabId, msg).catch((e) => send(tabId, { evt: 'fatal', msg: String(e.message || e) }));
        return Promise.resolve({ ok: true });
      case 'stop': stopTab(tabId); return Promise.resolve({ ok: true });
      case 'jpeg': return (async () => {
        const bytes = msg.bytes || orig.get(msg.url) || await fetchImage(msg.url, msg.pageUrl, null);
        const r = await getPool().exec({ op: 'jpeg', buf: bytes });
        return { buf: r.out, w: r.w, h: r.h };
      })();
      case 'info': return Promise.resolve({ hasKeys: ACT.parseKeys(ACT.S.keys).length > 0, dst: ACT.S.dst, model: ACT.S.model, autoFab: ACT.S.autoFab !== false, mobile: MOBILE, uiLang: ACT.lang() });
      case 'openOptions': return openOptions().then(() => ({ ok: true }));
      case 'selfTest': return (async () => {
        const S = Object.assign({}, ACT.S, msg.model ? { model: msg.model } : {}), keys = ACT.parseKeys(msg.keys != null ? msg.keys : S.keys);
        if (!keys.length) throw new Error(ACT.tr('m_nokey_short'));
        return ACT.selfTest(keys, S);
      })();
      case 'testKeys': return (async () => {
        const S = ACT.S, keys = ACT.parseKeys(msg.keys != null ? msg.keys : S.keys), model = msg.model || S.model;
        return Promise.all(keys.map(async (k, i) => Object.assign({ i: i + 1, tail: k.slice(-4) }, await ACT.testKey(k, model))));
      })();
      case 'listModels': return (async () => {
        const keys = ACT.parseKeys(msg.keys != null ? msg.keys : ACT.S.keys);
        if (!keys.length) throw new Error(ACT.tr('m_nokey_short'));
        return ACT.listModels(keys[0]);
      })();
      case 'clearCache': return (async () => {
        const idx = ((await browser.storage.local.get('cacheIdx')).cacheIdx) || [];
        await browser.storage.local.remove(idx.concat('cacheIdx'));
        return { removed: idx.length };
      })();
      default: return undefined;
    }
  });

  browser.tabs.onRemoved.addListener((id) => stopTab(id));
  browser.tabs.onUpdated.addListener((id, ch) => { if (ch.status === 'loading' && ch.url) stopTab(id); });

  /* ---------------- Nút thanh công cụ, phím tắt, menu chuột phải (Android không có commands/contextMenus) ---------------- */
  async function openOptions() {
    try { await browser.runtime.openOptionsPage(); }
    catch (e) { await browser.tabs.create({ url: browser.runtime.getURL('options/options.html') }); }
  }
  const toTab = (tab, msg) => tab && tab.id != null && send(tab.id, msg);
  const safe = (label, fn) => { try { fn(); } catch (e) { console.warn('[ACT] bỏ qua ' + label + ':', e && e.message); } };
  safe('browserAction', () => browser.browserAction && browser.browserAction.onClicked.addListener((tab) => toTab(tab, { evt: 'cmd', name: 'toggle-panel' })));
  safe('commands', () => browser.commands && browser.commands.onCommand.addListener(async (name) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    toTab(tab, { evt: 'cmd', name });
  }));
  safe('contextMenus', () => {
    if (!browser.contextMenus) return;
    const mk = () => browser.contextMenus.removeAll().then(() => browser.contextMenus.create({ id: 'act-img', title: ACT.tr('m_ctx'), contexts: ['image'] }));
    mk();
    browser.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) mk(); });
    browser.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'act-img') toTab(tab, { evt: 'ctx', srcUrl: info.srcUrl }); });
  });
  safe('onInstalled', () => browser.runtime.onInstalled.addListener((d) => { if (d.reason === 'install') openOptions(); }));

  ACT.loadSettings();
})();
