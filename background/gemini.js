/* Gemini: pool key (song song riêng từng key, tự điều chỉnh), prompt gọn, parser chịu lỗi. */
(function (root) {
  'use strict';
  const ACT = (root.ACT = root.ACT || {});
  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const abortErr = () => { const e = new Error(ACT.tr('m_stopped')); e.aborted = true; return e; };

  /* ---------------- Prompt ---------------- */
  ACT.buildPrompt = function (S, c) {
    const src = S.src && S.src !== 'Auto Detected' ? S.src : 'any language (auto-detect)';
    const dst = S.dst || 'Vietnamese';
    const kinds = ['b = speech/thought bubble (any outline shape)', 'c = narration/caption box with a flat coloured background'];
    if (S.freeText) kinds.push('f = text drawn directly on the artwork (titles, narration or handwriting without a box)');
    if (S.sfx) kinds.push('x = sound effect / onomatopoeia');
    const L = [];
    L.push('You are the OCR + translation engine of a comic reader. This image is slice ' + (c.idx + 1) + '/' + c.n + ' of one comic page or strip' + (c.crop ? ' (a region the user selected: translate every text block in it)' : '') + '.');
    L.push('Translate all text written in ' + src + ' into ' + dst + '.');
    L.push('Reply with JSON only: {"r":[{"b":[ymin,xmin,ymax,xmax],"t":"...","k":"b"}],"g":[]}');
    L.push('b: box around ALL glyphs of that text block; it must include the first and last glyph of EVERY line (not the bubble outline, not the tail). If unsure, make it slightly larger rather than smaller. Integers 0-1000 relative to this image. Boxes of different entries must not overlap.');
    L.push('t: natural, concise ' + dst + ' translation that keeps tone and the speaker\'s voice. No line breaks, no notes, no romanization.' + (/vietnam/i.test(dst) ? ' Write Vietnamese with FULL diacritics (tone marks and ă â ê ô ơ ư đ) in Unicode; never output unaccented Vietnamese.' : ''));
    L.push('Use only real, correctly spelled ' + dst + ' words. If a glyph is hard to read, infer the most plausible word from the surrounding context instead of inventing a word.');
    L.push('k: ' + kinds.join('; ') + '.');
    L.push('One entry per bubble/box: merge all its lines. Order: reading order (manga: right-to-left, top-to-bottom).');
    L.push('Omit: watermarks, credits, site names/URLs, page numbers, logos, text already in ' + dst + ', text in other languages, ' + (S.sfx ? '' : 'sound effects, ') + (S.freeText ? '' : 'text outside bubbles/boxes, ') + 'and any entry that is only a character/place/organisation name or a title.');
    L.push('Proper names inside sentences: ' + (S.keepNames ? 'keep as written (transliterate only if the target script differs).' : 'translate when a well-known translation exists.'));
    L.push('g: up to 5 NEW proper-noun pairs "Source=Target" that you chose, otherwise [].');
    if (c.glossary) L.push('Glossary (use exactly): ' + c.glossary);
    if (c.recent && c.recent.length) L.push('Previous lines for context only (never output them): ' + c.recent.map((x) => '"' + x + '"').join(' / '));
    if (S.extra && S.extra.trim()) L.push('User notes: ' + S.extra.trim());
    return L.join('\n');
  };

  const SCHEMA = {
    type: 'OBJECT',
    properties: {
      r: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { b: { type: 'ARRAY', items: { type: 'INTEGER' } }, t: { type: 'STRING' }, k: { type: 'STRING' } },
          required: ['b', 't']
        }
      },
      g: { type: 'ARRAY', items: { type: 'STRING' } }
    },
    required: ['r']
  };

  /* ---------------- Khả năng của từng model: dò 1 lần, dùng chung mọi yêu cầu ---------------- */
  const THINK_MODES = [{ thinkingBudget: 0 }, { thinkingLevel: 'minimal' }, null];
  const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT'].map((c) => ({ category: c, threshold: 'BLOCK_NONE' }));
  /* Thứ tự thử: ưu tiên giữ tắt-thinking (nhanh) > giữ safety (khỏi bị chặn truyện người lớn) > giữ schema */
  const VARIANTS = [];
  [true, false].forEach((schema) => [0, 1, 2].forEach((think) => [true, false].forEach((safety) => VARIANTS.push({ think, safety, schema }))));
  const CAPS = {};
  ACT.capsOf = (model) => CAPS[model] || (CAPS[model] = { idx: 0, ver: 0, ok: false });
  ACT.resetCaps = (model) => { delete CAPS[model]; };
  ACT.capsText = (c) => {
    const v = VARIANTS[Math.min(c.idx, VARIANTS.length - 1)], t = THINK_MODES[v.think];
    return 'thinking=' + (t ? Object.keys(t)[0] : ACT.tr('m_default')) + ', schema=' + (v.schema ? ACT.tr('m_yes') : ACT.tr('m_drop')) + ', safety=' + (v.safety ? 'BLOCK_NONE' : ACT.tr('m_default'));
  };
  function adapt(c, ver) {                 // true = nên thử lại (mình hoặc yêu cầu khác vừa đổi cấu hình)
    if (c.ver !== ver) return true;
    if (c.idx >= VARIANTS.length - 1) return false;
    c.idx++; c.ver++; return true;
  }

  ACT.buildBody = function (S, prompt, b64, maxTokens, temp, caps) {
    const v = VARIANTS[caps ? Math.min(caps.idx, VARIANTS.length - 1) : 0];
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
      generationConfig: { temperature: temp == null ? 0.1 : temp, maxOutputTokens: maxTokens || 4096, responseMimeType: 'application/json' }
    };
    if (v.schema) body.generationConfig.responseSchema = SCHEMA;
    if (THINK_MODES[v.think]) body.generationConfig.thinkingConfig = THINK_MODES[v.think];
    if (v.safety) body.safetySettings = SAFETY;
    return body;
  };

  /* ---------------- Parser chịu lỗi ---------------- */
  function tryParse(t) {
    t = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch (e) { return null; }
  }
  function salvage(t) {            // cứu các object hoàn chỉnh khi JSON bị cắt giữa chừng
    const i = String(t).indexOf('[', String(t).indexOf('"r"'));
    if (i < 0) return null;
    const out = []; let depth = 0, st = -1, inStr = false, esc = false;
    for (let p = i + 1; p < t.length; p++) {
      const ch = t[p];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth++ === 0) st = p; }
      else if (ch === '}') { if (--depth === 0 && st >= 0) { const o = tryParse(t.slice(st, p + 1)); if (o) out.push(o); st = -1; } }
      else if (ch === ']' && depth === 0) break;
    }
    return out.length ? { r: out } : null;
  }
  /* tw/th: kích thước ảnh gửi đi (phòng khi model trả pixel thay vì 0-1000) */
  ACT.parseRegions = function (text, tw, th) {
    let o = tryParse(text), salvaged = false;
    if (Array.isArray(o)) o = { r: o };
    if (!o || !Array.isArray(o.r)) { o = salvage(text); salvaged = !!o; }
    if (!o) return null;
    const items = [];
    for (const it of o.r) {
      if (!it || !Array.isArray(it.b) || it.b.length < 4) continue;
      let b = it.b.slice(0, 4).map(Number);
      if (b.some((v) => !isFinite(v))) continue;
      if (Math.max(...b) > 1000) b = [b[0] / th * 1000, b[1] / tw * 1000, b[2] / th * 1000, b[3] / tw * 1000];
      b = b.map((v) => Math.max(0, Math.min(1000, v)));
      if (b[2] - b[0] < 4 || b[3] - b[1] < 4) continue;
      const t = String(it.t == null ? '' : it.t).replace(/\s+/g, ' ').trim();
      if (!t) continue;
      const k = ['b', 'c', 'f', 'x'].includes(it.k) ? it.k : 'b';
      items.push({ b, t, k });
    }
    const g = Array.isArray(o.g) ? o.g.map(String).filter((s) => s.includes('=')).slice(0, 5) : [];
    return { items, g, salvaged };
  };

  /* ---------------- Pool key ---------------- */
  class KeyPool {
    constructor(keys, perKey) {
      // slow start: mỗi key bắt đầu 2 luồng, tăng dần tới perKey khi chạy ổn
      this.keys = keys.map((k, i) => ({ k, i, inflight: 0, limit: Math.min(perKey, 2), max: perKey, until: 0, dead: false, why: '', ok: 0, fail: 0, last429: 0, okStreak: 0 }));
      this.waiters = []; this.recent429 = [];
      this.shared = false; this.sharedCap = 2; this.sharedOk = 0;
    }
    alive() { return this.keys.some((s) => !s.dead); }
    reasons() { return this.keys.map((s) => '#' + (s.i + 1) + ': ' + (s.why || 'ok')).join('; '); }
    capacity() { return this.keys.filter((s) => !s.dead).reduce((a, s) => a + s.max, 0); }
    total() { return this.keys.reduce((a, s) => a + s.inflight, 0); }
    wake() { const w = this.waiters; this.waiters = []; w.forEach((f) => f()); }
    pick() {
      if (this.shared && this.total() >= this.sharedCap) return null;
      const now = Date.now(); let best = null;
      for (const s of this.keys) {
        if (s.dead || s.until > now || s.inflight >= s.limit) continue;
        if (!best || s.inflight / s.limit < best.inflight / best.limit) best = s;
      }
      return best;
    }
    async acquire(signal) {
      for (;;) {
        if (signal && signal.aborted) throw abortErr();
        if (!this.alive()) { const e = new Error(ACT.tr('m_keys_dead', this.reasons())); e.noKeys = true; throw e; }
        const s = this.pick();
        if (s) { s.inflight++; return s; }
        const now = Date.now(), cd = this.keys.filter((x) => !x.dead && x.until > now).map((x) => x.until - now);
        const ms = cd.length ? Math.min.apply(null, cd) + 30 : 30000;
        await new Promise((res) => {
          let done = false;
          const fin = () => { if (done) return; done = true; clearTimeout(t); res(); };
          const t = setTimeout(fin, ms);
          this.waiters.push(fin);
          if (signal) signal.addEventListener('abort', fin, { once: true });
        });
      }
    }
    release(s) { s.inflight = Math.max(0, s.inflight - 1); this.wake(); }
    success(s) {
      s.ok++; s.okStreak++;
      if (s.limit < s.max && Date.now() - s.last429 > 20000 && s.okStreak >= 4) { s.limit++; s.okStreak = 0; }
      if (this.shared && ++this.sharedOk >= 6) { this.sharedOk = 0; this.sharedCap = Math.min(Math.max(1, this.capacity()), this.sharedCap + 1); }
    }
    throttle(s, ms) {
      const now = Date.now();
      this.recent429 = this.recent429.filter((x) => now - x.t < 6000); this.recent429.push({ t: now, i: s.i });
      s.last429 = now; s.okStreak = 0; s.until = Math.max(s.until, now + ms); s.limit = Math.max(1, Math.floor(s.limit / 2));
      // nhiều key cùng bị 429 trong vài giây => nhiều khả năng cùng project, dùng chung hạn mức: cả pool cùng nghỉ và chạy chậm lại
      if (new Set(this.recent429.map((x) => x.i)).size >= 2) {
        this.shared = true; this.sharedCap = Math.max(1, Math.floor(Math.min(this.sharedCap, this.total() || 2) / 2));
        for (const k of this.keys) if (!k.dead) { k.until = Math.max(k.until, now + ms); k.last429 = now; k.okStreak = 0; k.limit = 1; }
      }
    }
    kill(s, why) { s.dead = true; s.why = why; this.wake(); }
  }
  ACT.KeyPool = KeyPool;

  /* ---------------- Gọi API ---------------- */
  function errMsg(txt) { try { const j = JSON.parse(txt); return (j.error && j.error.message) || txt; } catch (e) { return String(txt).slice(0, 200); } }
  function retryDelay(txt) {
    const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(txt) || /retry in ([\d.]+)s/i.exec(txt);
    return m ? Math.min(90, Math.max(1, parseFloat(m[1]))) * 1000 : 15000;
  }
  // 400 mà nguyên nhân KHÔNG phải do cấu hình yêu cầu thì đừng thử lại bằng cách đổi cấu hình
  const NOT_CAPS = /api key|location|billing|precondition|permission|quota|too large|exceeds|unable to process|image/i;
  const httpErr = (status, msg, extra) => { const e = new Error('Gemini ' + status + ': ' + msg + (extra || '')); e.status = status; return e; };

  /* makeBody(caps) -> body. Trả về { text, finish, usage } */
  ACT.callGemini = async function (pool, model, makeBody, opt) {
    opt = opt || {};
    const signal = opt.signal, caps = ACT.capsOf(model);
    let net = 0, n429 = 0, tried = 0;
    for (;;) {
      const ver = caps.ver, body = makeBody(caps);
      const s = await pool.acquire(signal);
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), opt.timeout || 75000);
      let status = 0, txt = '';
      try {
        const res = await fetch(API + '/models/' + encodeURIComponent(model) + ':generateContent', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.k }, body: JSON.stringify(body), signal: ctrl.signal
        });
        status = res.status; txt = await res.text();
      } catch (e) {
        pool.release(s);
        if (signal && signal.aborted) throw abortErr();
        s.fail++;
        if (++net > 3) throw new Error(ACT.tr('m_net', e && e.message || e));
        await sleep(500 * net); continue;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
      if (status === 200) {
        let j; try { j = JSON.parse(txt); } catch (e) { pool.release(s); if (++net > 3) throw new Error(ACT.tr('m_notjson')); continue; }
        caps.ok = true;
        pool.success(s); pool.release(s);
        const cand = j.candidates && j.candidates[0];
        const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '';
        const u = j.usageMetadata || {};
        if (opt.usage) { opt.usage.in += u.promptTokenCount || 0; opt.usage.out += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); opt.usage.req++; }
        if (!text) {
          const why = (j.promptFeedback && j.promptFeedback.blockReason) || (cand && cand.finishReason) || 'empty';
          const e = new Error(ACT.tr('m_empty', why)); e.blocked = true; throw e;
        }
        return { text, finish: cand && cand.finishReason, usage: u };
      }
      const msg = errMsg(txt);
      pool.release(s);
      if (status === 429) {
        if (/limit:\s*0\b/.test(txt)) { pool.kill(s, ACT.tr('m_quota0')); continue; }
        if (/per\s*day|daily|PerDay/i.test(txt)) { pool.kill(s, ACT.tr('m_quota_day')); continue; }
        pool.throttle(s, retryDelay(txt));
        if (++n429 > 8) throw httpErr(429, ACT.tr('m_ratelimit', msg));
        continue;
      }
      if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|API key expired/i.test(msg)) {
        pool.kill(s, status + ' ' + msg.slice(0, 90)); continue;
      }
      if (status >= 500) {
        s.fail++;
        if (++net > 3) throw httpErr(status, msg);
        await sleep(700 * net); continue;
      }
      if (status === 404) throw httpErr(404, msg, ACT.tr('m_404'));
      if (status === 400 && !caps.ok && !NOT_CAPS.test(msg)) {
        // chưa có cấu hình nào từng chạy được: đổi sang cấu hình kế tiếp (dùng chung cho mọi yêu cầu song song)
        tried++;
        if (adapt(caps, ver)) { console.warn('[ACT] 400 "' + msg + '" -> thử cấu hình: ' + ACT.capsText(caps)); continue; }
        throw httpErr(400, msg, ACT.tr('m_400', VARIANTS.length));
      }
      throw httpErr(status, msg);
    }
  };

  /* Dò cấu hình bằng 1 ảnh nhỏ TRƯỚC khi dịch hàng loạt (tuần tự, không gây bão yêu cầu) */
  const TINY = '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';
  ACT.preflight = async function (pool, S, signal) {
    const caps = ACT.capsOf(S.model);
    if (caps.ok) return caps;
    const t0 = Date.now();
    try {
      await ACT.callGemini(pool, S.model, (c) => ACT.buildBody(S, ACT.buildPrompt(S, { idx: 0, n: 1 }), TINY, 256, 0.1, c), { signal, timeout: 30000 });
    } catch (e) { if (!e.blocked) throw e; }
    caps.ms = Date.now() - t0;
    return caps;
  };


  /* ---------------- Sửa tiếng Việt không dấu ---------------- */
  const VI_MARK = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  const stripAcc = (x) => String(x).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  ACT.stripAccents = stripAcc;
  /* Câu tiếng Việt từ 3 từ trở lên mà không có một chữ có dấu nào => gần như chắc chắn model viết thiếu dấu */
  ACT.needsAccents = (text) => {
    const w = String(text || '').split(/\s+/).filter((x) => /[a-z]/i.test(x));
    return w.length >= 3 && !VI_MARK.test(text) && /^[\x00-\x7f…“”‘’—–]*$/.test(String(text));
  };
  /* regs: [{t,...}] — sửa t tại chỗ. Trả về số mục đã sửa. Lỗi mạng/ model => bỏ qua, giữ nguyên bản cũ. */
  ACT.fixAccents = async function (pool, S, regs, opt) {
    if (!/vietnam/i.test(S.dst || '')) return 0;
    const bad = regs.filter((r) => ACT.needsAccents(r.t));
    if (!bad.length) return 0;
    let fixed = 0;
    for (let i = 0; i < bad.length; i += 40) {
      const part = bad.slice(i, i + 40);
      const prompt = 'These Vietnamese comic dialogue lines were written WITHOUT diacritics. Rewrite every line with the correct Vietnamese diacritics (tone marks and ă â ê ô ơ ư đ), using the sentence context to choose the right words. Do NOT change, add or remove any word, and keep the punctuation. Reply with JSON only: {"r":["..."]} containing exactly ' + part.length + ' strings in the same order.\n' + JSON.stringify(part.map((r) => r.t));
      try {
        const r = await ACT.callGemini(pool, S.model, () => ({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' }
        }), { signal: opt && opt.signal, usage: opt && opt.usage, timeout: 45000 });
        const o = tryParse(r.text); const arr = o && (Array.isArray(o) ? o : o.r);
        if (!Array.isArray(arr) || arr.length !== part.length) continue;
        part.forEach((reg, k) => {
          const nt = String(arr[k] == null ? '' : arr[k]).replace(/\s+/g, ' ').trim();
          if (nt && VI_MARK.test(nt) && stripAcc(nt) === stripAcc(reg.t)) { reg.t = nt; fixed++; }
        });
      } catch (e) { if (e && e.aborted) throw e; /* bỏ qua: giữ bản không dấu còn hơn mất cả trang */ }
    }
    return fixed;
  };


  /* ---------------- Rà soát bản dịch (từ vô nghĩa, sai chính tả, sai từ theo ngữ cảnh) ---------------- */
  ACT.proofread = async function (pool, S, regs, opt) {
    const todo = regs.filter((r) => r && r.t && !r.pr);
    if (!todo.length) return 0;
    const dst = S.dst || 'Vietnamese';
    let changed = 0;
    for (let i = 0; i < todo.length; i += 60) {
      const part = todo.slice(i, i + 60);
      const prompt = 'You proofread comic dialogue that was machine-translated into ' + dst + '. The lines are in reading order, so use neighbouring lines as context. ' +
        'Fix ONLY: (1) words that do not exist or are misspelled or garbled, (2) a real word that is clearly the wrong one in context and makes the sentence nonsensical (for example Vietnamese "cho vai" when "cho vay" = to lend is meant), (3) missing diacritics. ' +
        'Keep the meaning, tone, punctuation, line order and proper names. If a line is already fine, return it unchanged. Reply with JSON only: {"r":["..."]} containing exactly ' + part.length + ' strings in the same order.\n' + JSON.stringify(part.map((r) => r.t));
      try {
        const r = await ACT.callGemini(pool, S.model, () => ({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 4096, responseMimeType: 'application/json' }
        }), { signal: opt && opt.signal, usage: opt && opt.usage, timeout: 45000 });
        const o = tryParse(r.text); const arr = o && (Array.isArray(o) ? o : o.r);
        if (!Array.isArray(arr) || arr.length !== part.length) continue;
        part.forEach((reg, k) => {
          const nt = String(arr[k] == null ? '' : arr[k]).replace(/\s+/g, ' ').trim();
          reg.pr = 1;
          if (nt && nt !== reg.t && nt.length >= 0.5 * reg.t.length && nt.length <= 1.6 * reg.t.length + 4) { reg.t = nt; changed++; }
        });
      } catch (e) { if (e && e.aborted) throw e; /* lỗi mạng/model: giữ bản cũ */ }
    }
    return changed;
  };

  /* ---------------- Tiện ích cho trang Cài đặt ---------------- */
  ACT.selfTest = async function (keys, S) {
    ACT.resetCaps(S.model);
    const pool = new KeyPool(keys, 1), t0 = Date.now();
    await ACT.preflight(pool, S);
    return { ms: Date.now() - t0, caps: ACT.capsText(ACT.capsOf(S.model)), alive: pool.keys.filter((k) => !k.dead).length, total: keys.length, reasons: pool.reasons() };
  };
  ACT.testKey = async function (key, model) {
    const t0 = Date.now();
    try {
      const res = await fetch(API + '/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 8 } })
      });
      const txt = await res.text();
      if (res.ok) return { ok: true, ms: Date.now() - t0 };
      return { ok: false, status: res.status, msg: errMsg(txt).slice(0, 160) };
    } catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
  };
  ACT.listModels = async function (key) {
    const res = await fetch(API + '/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    const j = await res.json();
    if (!res.ok) throw new Error(errMsg(JSON.stringify(j)));
    return (j.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, '')).filter((n) => /gemini/i.test(n)).sort();
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ACT;
})(typeof self !== 'undefined' ? self : globalThis);
