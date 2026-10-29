/* Content script: tìm ảnh truyện, gửi đi dịch, thay ảnh tại chỗ, bảng điều khiển nổi (Shadow DOM). */
(function () {
  'use strict';
  if (window.__ACT_LOADED__) return;
  window.__ACT_LOADED__ = true;

  const LAZY = ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-echo', 'data-cfsrc', 'data-pagespeed-lazy-src'];
  const ents = new Map(), idOf = new WeakMap();
  let idSeq = 0, busy = false, showingOrig = false, auto = false, ui = null, io = null, mo = null, pickEl = null, tapOff = null;
  let cfg = { autoFab: true, mobile: false }, fabShown = false, toastTimer = 0;
  const pending = new Set(); let flushTimer = 0;
  const I18N = self.ACT_I18N;
  let lang = I18N.detect();
  const tr = function () { return I18N.t.apply(null, [lang].concat(Array.prototype.slice.call(arguments))); };
  const errs = new Map();

  /* ---------------- Nhận diện ảnh ---------------- */
  const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return ''; } };
  function urlOf(img) {
    const e = idOf.has(img) && ents.get(idOf.get(img));
    if (e && e.url && e.state === 'done') return e.url;
    let u = img.currentSrc || img.getAttribute('src') || '';
    const lazy = LAZY.map((a) => img.getAttribute(a)).find((v) => v && /^(https?:|\/|\.|blob:)/i.test(v.trim()));
    if (lazy && (!u || /^data:image\/(gif|svg)|placeholder|loading|blank|spacer|lazy/i.test(u))) u = lazy.trim();
    return abs(u);
  }
  function isCandidate(img) {
    if (!img.isConnected || img.closest('#act-host')) return false;
    const r = img.getBoundingClientRect();
    if (r.width < 180 || r.height < 180) return false;
    const u = urlOf(img);
    if (!u || /\.svg(\?|$)|^data:image\/svg/i.test(u)) return false;
    const lazyPending = u !== abs(img.getAttribute('src') || '');   // đang dùng URL thật từ data-src (ảnh giữ chỗ)
    return img.naturalWidth >= 300 || lazyPending;
  }
  function entFor(img) {
    let id = idOf.get(img);
    if (id == null) { id = ++idSeq; idOf.set(img, id); ents.set(id, { id, img, url: '', state: 'idle', blob: null, blobUrl: '', orig: null, canvas: null, dims: null }); }
    const e = ents.get(id);
    if (e.state !== 'done') e.url = urlOf(img);
    return e;
  }
  function collect() {
    return Array.from(document.images).filter(isCandidate).map(entFor).filter((e) => e.url);
  }

  /* ---------------- Gửi đi dịch ---------------- */
  async function toItem(e, order, crop) {
    const it = { id: e.id, url: e.url, order };
    if (crop) it.crop = crop;
    if (/^(blob|data):/i.test(e.url)) it.bytes = await (await fetch(e.url)).arrayBuffer();
    return it;
  }
  async function translateEnts(list, crop) {
    if (!list.length) return say(tr('c_no_images'));
    const all = collect();
    const order = new Map(all.map((e, i) => [e.id, i]));
    list = list.slice().sort((a, b) => a.img.getBoundingClientRect().top + scrollY - (b.img.getBoundingClientRect().top + scrollY));
    const k = list.findIndex((e) => e.img.getBoundingClientRect().bottom > -100);
    if (k > 0 && !crop) list = list.slice(k).concat(list.slice(0, k));      // ảnh đang xem dịch trước
    list.forEach((e) => { e.state = 'busy'; });
    errs.clear();
    setBusy(true);
    try {
      const items = [];
      for (const e of list) items.push(await toItem(e, order.has(e.id) ? order.get(e.id) : e.id, crop));
      await browser.runtime.sendMessage({ cmd: 'start', items, pageUrl: location.href });
    } catch (err) { resetBusy(); setBusy(false); say(tr('c_send_err', err.message || err)); }
  }
  function resetBusy() { ents.forEach((e) => { if (e.state === 'busy') e.state = e.blob ? 'done' : 'idle'; }); }
  const translateAll = () => translateEnts(collect().filter((e) => e.state !== 'busy'));

  /* ---------------- Thay ảnh ---------------- */
  function rememberOrig(e) {
    if (e.orig) return;
    const img = e.img, pic = img.closest('picture');
    e.orig = {
      src: img.getAttribute('src'), srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes'),
      sources: pic ? Array.from(pic.querySelectorAll('source')).map((s) => [s, s.getAttribute('srcset')]) : []
    };
  }
  function applyTranslated(e) {
    if (!e.blob) return;
    rememberOrig(e);
    const img = e.img;
    if (e.canvas) { e.canvas.style.display = ''; img.style.display = 'none'; return; }
    if (e.blobUrl) URL.revokeObjectURL(e.blobUrl);
    e.blobUrl = URL.createObjectURL(e.blob);
    e.orig.sources.forEach(([s]) => s.removeAttribute('srcset'));
    img.removeAttribute('srcset'); img.removeAttribute('sizes');
    img.addEventListener('error', () => canvasFallback(e), { once: true });
    img.src = e.blobUrl;
    e.state = 'done';
  }
  async function canvasFallback(e) {      // trang chặn blob: bằng CSP => vẽ lên canvas
    if (e.canvas || !e.blob) return;
    try {
      const bmp = await createImageBitmap(e.blob);
      const cv = document.createElement('canvas');
      cv.width = bmp.width; cv.height = bmp.height;
      cv.getContext('2d').drawImage(bmp, 0, 0);
      cv.className = e.img.className;
      cv.style.cssText = 'display:block;max-width:100%;height:auto;width:' + (e.img.clientWidth || bmp.width) + 'px';
      e.img.style.display = 'none';
      e.img.after(cv); e.canvas = cv;
    } catch (err) { say(tr('c_show_err', err.message)); }
  }
  function showOriginal(e) {
    if (!e.orig) return;
    if (e.canvas) { e.canvas.style.display = 'none'; e.img.style.display = ''; return; }
    const o = e.orig, img = e.img;
    if (o.srcset != null) img.setAttribute('srcset', o.srcset);
    if (o.sizes != null) img.setAttribute('sizes', o.sizes);
    o.sources.forEach(([s, v]) => { if (v != null) s.setAttribute('srcset', v); });
    if (o.src != null) img.setAttribute('src', o.src);
  }
  function toggleOriginal() {
    showingOrig = !showingOrig;
    ents.forEach((e) => { if (e.blob) (showingOrig ? showOriginal : applyTranslated)(e); });
    refreshUI();
  }

  /* ---------------- Chọn ảnh bằng cách chạm / ảnh đang xem / từ đây trở xuống ---------------- */
  function visibleArea(r) {
    return Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
  }
  function currentEnt() {
    let best = null, area = 0;
    for (const e of collect()) { const a = visibleArea(e.img.getBoundingClientRect()); if (a > area) { area = a; best = e; } }
    return best;
  }
  function translateCurrent() {
    const e = currentEnt();
    if (!e) return say(tr('c_none_visible'));
    closeSheet(); translateEnts([e]);
  }
  function translateFromHere() {
    const e = currentEnt();
    if (!e) return say(tr('c_none_visible'));
    const all = collect(), i = all.findIndex((x) => x.id === e.id);
    closeSheet(); translateEnts(all.slice(Math.max(0, i)));
  }
  function stopTap() { if (tapOff) { tapOff(); tapOff = null; } }
  function tapMode() {
    stopTap(); closeSheet();
    const onClick = (ev) => {
      if (ev.composedPath().includes(ui.host)) return;
      const hit = document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => (el.tagName === 'IMG' && isCandidate(el)) || (el.tagName === 'CANVAS' && el.dataset.actFor));
      if (!hit) return;
      ev.preventDefault(); ev.stopPropagation();
      const img = hit.tagName === 'CANVAS' ? Array.from(ents.values()).find((e) => e.canvas === hit).img : hit;
      stopTap(); translateEnts([entFor(img)]);
    };
    document.addEventListener('click', onClick, true);
    tapOff = () => { document.removeEventListener('click', onClick, true); hideBanner(); };
    banner(tr('c_tap_banner'), stopTap);
  }

  /* ---------------- Khoanh vùng (chuột hoặc ngón tay) ---------------- */
  function pickRegion() {
    if (pickEl) return;
    closeSheet(); stopTap();
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;touch-action:none;background:rgba(20,21,26,.28)';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px dashed #ffd23f;background:rgba(255,210,63,.2);display:none;pointer-events:none';
    ov.appendChild(box); document.documentElement.appendChild(ov); pickEl = ov;
    let sx = 0, sy = 0, drag = false;
    const done = () => { ov.remove(); pickEl = null; hideBanner(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (ev) => { if (ev.key === 'Escape') done(); };
    document.addEventListener('keydown', onKey, true);
    banner(tr('c_pick_banner'), done);
    ov.addEventListener('pointerdown', (ev) => {
      drag = true; sx = ev.clientX; sy = ev.clientY; box.style.display = 'block';
      try { ov.setPointerCapture(ev.pointerId); } catch (e) { /* bỏ qua */ }
      ev.preventDefault();
    });
    ov.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      box.style.left = Math.min(sx, ev.clientX) + 'px'; box.style.top = Math.min(sy, ev.clientY) + 'px';
      box.style.width = Math.abs(ev.clientX - sx) + 'px'; box.style.height = Math.abs(ev.clientY - sy) + 'px';
      ev.preventDefault();
    });
    ov.addEventListener('pointercancel', done);
    ov.addEventListener('pointerup', (ev) => {
      if (!drag) return;
      const x0 = Math.min(sx, ev.clientX), y0 = Math.min(sy, ev.clientY), x1 = Math.max(sx, ev.clientX), y1 = Math.max(sy, ev.clientY);
      done();
      if (x1 - x0 < 24 || y1 - y0 < 24) return say(tr('c_area_small'));
      let best = null, ba = 0;
      for (const img of document.images) {
        const r = img.getBoundingClientRect();
        const a = Math.max(0, Math.min(x1, r.right) - Math.max(x0, r.left)) * Math.max(0, Math.min(y1, r.bottom) - Math.max(y0, r.top));
        if (a > ba && r.width >= 100) { ba = a; best = img; }
      }
      if (!best) return say(tr('c_area_none'));
      const e = entFor(best), r = best.getBoundingClientRect();
      const nw = e.dims ? e.dims.w : best.naturalWidth, nh = e.dims ? e.dims.h : best.naturalHeight;
      const kx = nw / r.width, ky = nh / r.height;
      const crop = {
        x0: Math.max(0, (x0 - r.left) * kx), y0: Math.max(0, (y0 - r.top) * ky),
        x1: Math.min(nw, (x1 - r.left) * kx), y1: Math.min(nh, (y1 - r.top) * ky)
      };
      translateEnts([e], crop);
    });
  }

  /* ---------------- Tự dịch khi cuộn ---------------- */
  function flushAuto() {
    flushTimer = 0;
    const list = Array.from(pending).filter((img) => isCandidate(img)).map(entFor).filter((e) => e.state === 'idle' && e.url);
    pending.clear();
    if (list.length) translateEnts(list);
  }
  function observe(img) { if (io && img.tagName === 'IMG') io.observe(img); }
  function setAuto(on) {
    auto = on;
    if (on) {
      io = new IntersectionObserver((es) => {
        for (const en of es) {
          if (!en.isIntersecting) continue;
          const im = en.target; io.unobserve(im);
          if (im.naturalWidth || isCandidate(im)) pending.add(im);
          else im.addEventListener('load', () => observe(im), { once: true });   // chưa tải xong: chờ rồi xét lại
        }
        if (pending.size && !flushTimer) flushTimer = setTimeout(flushAuto, 350);
      }, { rootMargin: '1800px 0px' });
      document.images && Array.from(document.images).forEach(observe);
      mo = new MutationObserver((ms) => {
        for (const m of ms) m.addedNodes.forEach((n) => { if (n.tagName === 'IMG') { observe(n); n.addEventListener('load', () => observe(n), { once: true }); } else if (n.querySelectorAll) n.querySelectorAll('img').forEach(observe); });
      });
      mo.observe(document.body, { childList: true, subtree: true });
      say(tr('c_auto_on'));
    } else {
      io && io.disconnect(); mo && mo.disconnect(); io = mo = null; pending.clear();
      say(tr('c_auto_off'));
    }
  }

  /* ---------------- Xuất PDF ---------------- */
  function buildPdf(pages) {
    const enc = new TextEncoder(), chunks = [], offs = [];
    let off = 0;
    const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; chunks.push(u); off += u.length; };
    push('%PDF-1.4\n');
    offs[1] = off; push('1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n');
    offs[2] = off; push('2 0 obj\n<</Type/Pages/Count ' + pages.length + '/Kids[' + pages.map((_, i) => (3 + 3 * i) + ' 0 R').join(' ') + ']>>\nendobj\n');
    pages.forEach((p, i) => {
      const po = 3 + 3 * i, co = po + 1, io2 = po + 2, pw = (p.w * 0.75).toFixed(2), ph = (p.h * 0.75).toFixed(2);
      offs[po] = off; push(po + ' 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 ' + pw + ' ' + ph + ']/Resources<</XObject<</Im0 ' + io2 + ' 0 R>>>>/Contents ' + co + ' 0 R>>\nendobj\n');
      const cs = 'q ' + pw + ' 0 0 ' + ph + ' 0 0 cm /Im0 Do Q';
      offs[co] = off; push(co + ' 0 obj\n<</Length ' + cs.length + '>>\nstream\n' + cs + '\nendstream\nendobj\n');
      offs[io2] = off; push(io2 + ' 0 obj\n<</Type/XObject/Subtype/Image/Width ' + p.w + '/Height ' + p.h + '/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ' + p.jpeg.length + '>>\nstream\n');
      push(p.jpeg); push('\nendstream\nendobj\n');
    });
    const xref = off, total = 3 + 3 * pages.length;
    let x = 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (let k = 1; k < total; k++) x += String(offs[k]).padStart(10, '0') + ' 00000 n \n';
    push(x + 'trailer\n<</Size ' + total + '/Root 1 0 R>>\nstartxref\n' + xref + '\n%%EOF');
    return new Blob(chunks, { type: 'application/pdf' });
  }
  function pdfName() {      // tên file ASCII để mọi trình duyệt đều giữ được đuôi .pdf
    const t = (document.title || 'comic').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .replace(/[^A-Za-z0-9 ._()-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return (t || 'comic') + ' - dich.pdf';
  }
  async function exportPdf() {
    const list = collect();
    if (!list.length) return say(tr('c_pdf_none'));
    say(tr('c_pdf_making', list.length));
    const pages = [];
    try {
      for (const e of list) {
        if (e.blob && e.dims) pages.push({ jpeg: new Uint8Array(await e.blob.arrayBuffer()), w: e.dims.w, h: e.dims.h });
        else {
          const it = await toItem(e, 0);
          const r = await browser.runtime.sendMessage({ cmd: 'jpeg', url: e.url, pageUrl: location.href, bytes: it.bytes });
          if (r && r.buf) pages.push({ jpeg: new Uint8Array(r.buf), w: r.w, h: r.h });
        }
        say('PDF: ' + pages.length + '/' + list.length);
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(buildPdf(pages)); a.download = pdfName();
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
      say(tr('c_pdf_done', pages.length));
    } catch (err) { say(tr('c_pdf_err', err.message || err)); }
  }

  /* ---------------- Giao diện (ưu tiên điện thoại: nút nổi + bảng dưới, nút to dễ chạm) ---------------- */
  const CSS = `
:host{all:initial}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
button{font:inherit;color:inherit;touch-action:manipulation}
.fab{all:unset;box-sizing:border-box;position:fixed;right:10px;bottom:calc(92px + env(safe-area-inset-bottom,0px));width:56px;height:56px;border-radius:50%;z-index:2147483647;background:#ffd23f;border:2.5px solid #14151a;box-shadow:3px 3px 0 #14151a;display:grid;place-items:center;cursor:pointer;touch-action:none;font:700 12px/1 system-ui,sans-serif;color:#14151a}
.fab svg{width:30px;height:30px}
.fab .lb{display:none}
.fab.run svg{display:none}.fab.run .lb{display:block}
.ring{position:absolute;inset:-7px;border-radius:50%;pointer-events:none;opacity:0;background:conic-gradient(#14151a var(--p,0%),rgba(20,21,26,.18) 0);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px));mask:radial-gradient(farthest-side,transparent calc(100% - 4px),#000 calc(100% - 3px))}
.fab.run .ring{opacity:1}
.fab .dot{position:absolute;top:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background:#e5484d;border:2px solid #fff;display:none}
.fab.err .dot{display:block}
.sheet{position:fixed;left:10px;right:10px;margin-left:auto;max-width:400px;bottom:calc(160px + env(safe-area-inset-bottom,0px));max-height:calc(100vh - 200px);max-height:calc(100dvh - 200px);overflow:auto;z-index:2147483647;background:#fff;color:#14151a;border:2px solid #14151a;border-radius:14px;box-shadow:4px 4px 0 #14151a;font:15px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:none}
.sheet.open{display:block}
.h{display:flex;align-items:center;gap:6px;padding:6px 6px 6px 14px;border-bottom:2px solid #14151a;background:#ffd23f;border-radius:11px 11px 0 0;position:sticky;top:0}
.h b{flex:1;font-size:15px}
.ib{all:unset;cursor:pointer;min-width:44px;min-height:44px;display:grid;place-items:center;border-radius:8px;font-weight:700;font-size:13px;padding:0 6px;text-align:center}
.ib:active{background:rgba(20,21,26,.15)}
.b{padding:12px;display:grid;gap:10px}
.go{all:unset;box-sizing:border-box;display:block;text-align:center;cursor:pointer;min-height:52px;line-height:48px;font:700 16px system-ui,sans-serif;background:#fff;border:2px solid #14151a;border-radius:18px 18px 18px 4px;box-shadow:3px 3px 0 #14151a}
.go:active{transform:translate(2px,2px);box-shadow:1px 1px 0 #14151a}
.go.run{background:#14151a;color:#fff}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.s{all:unset;box-sizing:border-box;cursor:pointer;text-align:center;min-height:46px;display:grid;place-items:center;padding:4px 6px;font-weight:600;font-size:14px;line-height:1.2;border:2px solid #14151a;border-radius:10px;background:#fff}
.s:active{background:#ffd23f}
.s[aria-pressed=true]{background:#14151a;color:#fff}
label.t{display:flex;gap:12px;align-items:center;cursor:pointer;min-height:44px;font-size:14px}
label.t input{width:22px;height:22px;accent-color:#14151a}
.bar{height:12px;border:2px solid #14151a;border-radius:6px;overflow:hidden;background:#fff}
.bar i{display:block;height:100%;width:0;background:radial-gradient(circle,#14151a 1.1px,transparent 1.5px) 0 0/5px 5px,#ffd23f;transition:width .2s}
.st{font-size:13px;min-height:20px;word-break:break-word}
.k{font-size:12px;color:#4b4f5c;font-variant-numeric:tabular-nums;word-break:break-word}
.e{font-size:12px;color:#b3262d;word-break:break-word}
.toast{position:fixed;left:50%;transform:translateX(-50%);top:calc(10px + env(safe-area-inset-top,0px));max-width:92vw;z-index:2147483647;background:#14151a;color:#fff;border-radius:14px;padding:10px 12px;font:14px/1.35 system-ui,sans-serif;display:none;gap:10px;align-items:center;box-shadow:0 3px 14px rgba(0,0,0,.35)}
.toast.on{display:flex}
.toast span{flex:1;word-break:break-word}
.toast button{all:unset;cursor:pointer;font-weight:700;padding:6px 10px;border:1.5px solid #ffd23f;color:#ffd23f;border-radius:8px;min-height:32px}
@media (prefers-reduced-motion:reduce){.bar i{transition:none}}
button:focus-visible,.fab:focus-visible,input:focus-visible{outline:3px solid #3b5bfd;outline-offset:2px}
`;
  const ICON = '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M22 20h52a10 10 0 0 1 10 10v28a10 10 0 0 1-10 10H50L32 84V68h-10a10 10 0 0 1-10-10V30a10 10 0 0 1 10-10z" fill="#fff" stroke="#14151a" stroke-width="6" stroke-linejoin="round"/><path d="M28 38h40M28 51h26" stroke="#14151a" stroke-width="7" stroke-linecap="round"/></svg>';
  let relabelRoot = null;
  function ensureUI() {
    if (ui) return ui;
    const host = document.createElement('div');
    host.id = 'act-host';
    const root = host.attachShadow({ mode: 'open' });
    const markup =
      '<div class="toast" id="toast" role="status" aria-live="polite"><span id="tt"></span><button id="tx" type="button" data-t="c_close"></button></div>' +
      '<button class="fab" id="fab" type="button" data-ta="c_panel" style="display:none"><span class="ring"></span>' + ICON + '<span class="lb" id="lb"></span><span class="dot"></span></button>' +
      '<div class="sheet" id="sheet" role="dialog" data-ta="c_panel">' +
      '<div class="h"><b data-t="c_panel"></b><button class="ib" id="cfg" type="button" data-t="c_settings"></button><button class="ib" id="cls" type="button" data-ta="c_hide_aria" data-t="c_hide"></button></div>' +
      '<div class="b">' +
      '<button class="go" id="go" type="button" data-t="c_go"></button>' +
      '<div class="grid">' +
      '<button class="s" id="cur" type="button" data-t="c_cur"></button><button class="s" id="down" type="button" data-t="c_down"></button>' +
      '<button class="s" id="tap" type="button" data-t="c_tap"></button><button class="s" id="pick" type="button" data-t="c_pick"></button>' +
      '<button class="s" id="orig" type="button" aria-pressed="false" data-t="c_orig"></button><button class="s" id="pdf" type="button" data-t="c_pdf"></button>' +
      '</div>' +
      '<label class="t"><input type="checkbox" id="auto"> <span data-t="c_auto"></span></label>' +
      '<div class="bar"><i id="fill"></i></div>' +
      '<div class="st" id="st" aria-live="polite" data-t="c_ready"></div>' +
      '<div class="k" id="ks"></div><div class="e" id="er"></div>' +
      '</div></div>';
    // Dựng UI bằng DOMParser + createElement thay vì innerHTML (markup là hằng số của extension, không chứa dữ liệu trang).
    const st = document.createElement('style');
    st.textContent = CSS;
    root.appendChild(st);
    new DOMParser().parseFromString(markup, 'text/html').body.childNodes.forEach((n) => { root.appendChild(document.importNode(n, true)); });
    document.documentElement.appendChild(host);
    const $ = (q) => root.querySelector(q);
    relabelRoot = () => {
      root.querySelectorAll('[data-t]').forEach((el) => { if (el.id === 'st' && el.dataset.touched) return; el.textContent = tr(el.dataset.t); });
      root.querySelectorAll('[data-ta]').forEach((el) => { el.setAttribute('aria-label', tr(el.dataset.ta)); });
    };
    relabelRoot();
    ui = { host, root, $, fab: $('#fab'), sheet: $('#sheet'), go: $('#go'), fill: $('#fill'), st: $('#st'), ks: $('#ks'), er: $('#er'), orig: $('#orig'), lb: $('#lb'), toast: $('#toast'), tt: $('#tt') };
    ui.go.onclick = () => { if (busy) { browser.runtime.sendMessage({ cmd: 'stop' }); say(tr('c_stopping')); } else { closeSheet(); translateAll(); } };
    $('#cur').onclick = translateCurrent;
    $('#down').onclick = translateFromHere;
    $('#tap').onclick = tapMode;
    $('#pick').onclick = pickRegion;
    $('#orig').onclick = toggleOriginal;
    $('#pdf').onclick = exportPdf;
    $('#auto').onchange = (ev) => setAuto(ev.target.checked);
    $('#cfg').onclick = () => browser.runtime.sendMessage({ cmd: 'openOptions' });
    $('#cls').onclick = () => { closeSheet(); ui.fab.style.display = 'none'; fabShown = false; };
    $('#tx').onclick = hideToast;
    // nút nổi: chạm = mở/đóng bảng, kéo = di chuyển
    let sx = 0, sy = 0, ox = 0, oy = 0, moved = false, down = false;
    ui.fab.addEventListener('pointerdown', (ev) => {
      down = true; moved = false; sx = ev.clientX; sy = ev.clientY;
      const r = ui.fab.getBoundingClientRect(); ox = r.left; oy = r.top;
      try { ui.fab.setPointerCapture(ev.pointerId); } catch (e) { /* bỏ qua */ }
    });
    ui.fab.addEventListener('pointermove', (ev) => {
      if (!down) return;
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
      moved = true;
      const f = ui.fab.style;
      f.right = 'auto'; f.bottom = 'auto';
      f.left = Math.max(0, Math.min(innerWidth - 56, ox + ev.clientX - sx)) + 'px'; f.top = Math.max(0, Math.min(innerHeight - 56, oy + ev.clientY - sy)) + 'px';
    });
    const end = () => { if (down && !moved) toggleSheet(); down = false; };
    ui.fab.addEventListener('pointerup', end);
    ui.fab.addEventListener('pointercancel', () => { down = false; });
    ui.fab.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleSheet(); } });
    return ui;
  }
  function showFab() { ensureUI(); ui.fab.style.display = ''; fabShown = true; }
  function openSheet() { showFab(); ui.sheet.classList.add('open'); hideToast(); }
  function closeSheet() { if (ui) ui.sheet.classList.remove('open'); }
  function toggleSheet() { ensureUI(); if (ui.sheet.classList.contains('open')) closeSheet(); else openSheet(); }
  function hideToast() { clearTimeout(toastTimer); if (ui) ui.toast.classList.remove('on'); }
  function toast(text, ms) {
    ensureUI(); clearTimeout(toastTimer);
    ui.tt.textContent = text; ui.toast.classList.add('on');
    ui.$('#tx').textContent = tr('c_close'); ui.$('#tx').onclick = hideToast;
    if (ms) toastTimer = setTimeout(hideToast, ms);
  }
  function banner(text, onCancel) {           // thông báo cố định có nút Huỷ (chế độ chạm / khoanh vùng)
    toast(text, 0);
    const b = ui.$('#tx'); b.textContent = tr('c_cancel');
    b.onclick = () => { onCancel && onCancel(); hideToast(); };
  }
  const hideBanner = () => hideToast();
  function say(t, persist) {
    ensureUI(); ui.st.textContent = t; ui.st.dataset.touched = '1';
    if (!ui.sheet.classList.contains('open')) toast(t, persist ? 0 : 3800);
  }
  function setBusy(b) {
    busy = b; ensureUI(); showFab();
    ui.go.textContent = b ? tr('c_stop') : tr('c_go');
    ui.go.classList.toggle('run', b);
    ui.fab.classList.toggle('run', b);
    if (!b) { ui.fab.style.setProperty('--p', '0%'); ui.lb.textContent = ''; }
  }
  function refreshUI() { ensureUI(); ui.orig.setAttribute('aria-pressed', String(showingOrig)); ui.orig.textContent = showingOrig ? tr('c_trans') : tr('c_orig'); }
  const fmtN = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const fmtT = (ms) => (ms < 60000 ? (ms / 1000).toFixed(1) + 's' : Math.floor(ms / 60000) + 'p' + String(Math.round(ms % 60000 / 1000)).padStart(2, '0') + 's');

  function onProgress(m) {
    ensureUI();
    const pct = m.total ? Math.round(100 * m.done / m.total) : 0;
    ui.fill.style.width = pct + '%';
    ui.fab.style.setProperty('--p', pct + '%'); ui.lb.textContent = m.done + '/' + m.total;
    ui.st.dataset.touched = '1';
    ui.st.textContent = tr('c_stats', m.done, m.total, m.drawn, fmtT(m.ms)) + (m.failed ? tr('c_stats_err', m.failed) : '');
    const waiting = m.keys.filter((k) => !k.dead && k.wait > 800).length, alive = m.keys.filter((k) => !k.dead).length;
    ui.ks.textContent = tr('c_tokens', fmtN(m.tin), fmtN(m.tout), m.req) +
      m.keys.map((k) => 'K' + (k.i + 1) + (k.dead ? ' ✕' : k.wait > 800 ? tr('c_wait', Math.ceil(k.wait / 1000)) : ' ' + k.inflight + '/' + k.limit)).join(' ') +
      (alive && waiting >= Math.ceil(alive / 2) ? tr('c_ratelimit') : '');
  }
  function noteErr(msg) {
    errs.set(msg, (errs.get(msg) || 0) + 1);
    ensureUI(); ui.fab.classList.add('err');
    ui.er.textContent = Array.from(errs).slice(0, 2).map(([m, c]) => (c > 1 ? c + '× ' : '') + m).join(' | ');
  }

  function setLang(l) {
    if (!l || l === lang) return;
    lang = l;
    if (ui) { relabelRoot(); setBusy(busy); refreshUI(); }
  }

  /* hiện nút nổi tự động trên trang có nhiều ảnh lớn (ví dụ trang đọc truyện) */
  function maybeShowFab() {
    if (fabShown || !cfg.autoFab) return;
    const n = collect().filter((e) => { const r = e.img.getBoundingClientRect(); return r.width >= 240 && r.height >= 240; }).length;
    if (n >= 3) showFab();
  }
  let fabT = 0;
  window.addEventListener('scroll', () => { if (!fabShown && cfg.autoFab) { clearTimeout(fabT); fabT = setTimeout(maybeShowFab, 500); } }, { passive: true });
  try {
    browser.runtime.sendMessage({ cmd: 'info' }).then((i) => { if (i) { cfg = i; if (i.uiLang) setLang(i.uiLang); } setTimeout(maybeShowFab, 1200); }).catch(() => {});
    browser.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.settings) setLang((ch.settings.newValue || {}).uiLang || I18N.detect()); });
  } catch (e) { /* bỏ qua */ }

  /* ---------------- Tin nhắn từ background ---------------- */
  browser.runtime.onMessage.addListener((m) => {
    switch (m && m.evt) {
      case 'cmd':
        if (m.name === 'toggle-panel') { ensureUI(); if (!fabShown) openSheet(); else toggleSheet(); }
        if (m.name === 'translate-page') translateAll();
        break;
      case 'ctx': {
        const img = Array.from(document.images).find((i) => i.currentSrc === m.srcUrl || i.src === m.srcUrl);
        if (img) translateEnts([entFor(img)]); else say(tr('c_img_missing'));
        break;
      }
      case 'start': setBusy(true); ui.fab.classList.remove('err'); break;
      case 'note': say(m.text); break;
      case 'progress': onProgress(m); break;
      case 'img': {
        const e = ents.get(m.id); if (!e) break;
        if (m.none) { e.state = 'none'; break; }
        e.blob = new Blob([m.buf], { type: 'image/jpeg' }); e.dims = { w: m.w, h: m.h }; e.state = 'done';
        if (m.warn) noteErr(m.warn);
        if (!showingOrig) applyTranslated(e);
        break;
      }
      case 'imgError': {
        const e = ents.get(m.id); if (e) e.state = 'err';
        noteErr(m.error);
        break;
      }
      case 'fatal':
        resetBusy(); setBusy(false); say(m.msg || tr('c_error'));
        if (m.code === 'nokey') browser.runtime.sendMessage({ cmd: 'openOptions' });
        break;
      case 'finish':
        resetBusy(); setBusy(false); ensureUI();
        if (m.fatal) { say(m.fatal, true); ui.fab.classList.add('err'); }
        else if (m.aborted) say(tr('c_stopped'));
        else {
          const none = Array.from(ents.values()).filter((e) => e.state === 'none').length;
          const hasErr = errs.size > 0;
          ui.st.textContent += tr('c_done_suffix') + (none ? tr('c_none_suffix', none) : '');
          toast(hasErr ? tr('c_done_err') : tr('c_done'), 3500);
        }
        break;
    }
  });
})();
