/* Trang cài đặt: tự lưu khi đổi. Dùng lại ACT.DEFAULTS từ background/settings.js */
(async function () {
  'use strict';
  const ACT = self.ACT, $ = (s) => document.querySelector(s);
  const S = await ACT.loadSettings();
  const I = self.ACT_I18N;
  let lang = S.uiLang || I.detect();
  const tr = function () { return I.t.apply(null, [lang].concat(Array.prototype.slice.call(arguments))); };
  // Gán chuỗi có thẻ <code>…</code> mà không dùng innerHTML: chỉ tạo node text và <code>, mọi thứ khác là text thuần.
  function setRich(el, str) {
    el.textContent = '';
    String(str).split(/(<code>.*?<\/code>)/g).forEach((part) => {
      const m = /^<code>(.*?)<\/code>$/.exec(part);
      if (m) { const c = document.createElement('code'); c.textContent = m[1]; el.appendChild(c); }
      else if (part) el.appendChild(document.createTextNode(part));
    });
  }
  function applyI18n() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = tr(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-html]').forEach((el) => { setRich(el, tr(el.dataset.i18nHtml)); });
    document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = tr(el.dataset.i18nPh); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = tr(el.dataset.i18nTitle); });
    document.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', tr(el.dataset.i18nAria)); });
    const lc = document.getElementById('langCode'); if (lc) lc.textContent = lang.toUpperCase();
    document.title = 'COMIC TRANS — ' + tr('o_title');
  }
  applyI18n();

  // đổ danh sách ngôn ngữ + phông
  const fill = (sel, arr, val) => { sel.replaceChildren(); arr.forEach((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v; sel.appendChild(o); }); sel.value = val; };
  fill($('#src'), ['Auto Detected'].concat(self.ACT_LANGS), S.src);
  fill($('#dst'), self.ACT_LANGS, S.dst);
  fill($('#font'), Object.keys(ACT.FONT_STACKS).concat('Custom'), S.font);
  if (!$('#model').value) $('#model').value = S.model;

  const fields = Array.from(document.querySelectorAll('[data-k]'));
  const show = () => { $('#customWrap').hidden = $('#font').value !== 'Custom'; };
  fields.forEach((el) => {
    const k = el.dataset.k, v = S[k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = (k === 'uiLang' ? lang : v);
  });
  show();

  let timer = 0;
  function save() {
    const next = Object.assign({}, S);
    fields.forEach((el) => {
      const k = el.dataset.k;
      next[k] = el.type === 'checkbox' ? el.checked : ('num' in el.dataset ? Number(el.value) : el.value);
    });
    next.model = next.model.trim() || ACT.DEFAULTS.model;
    if (next.uiLang !== lang) { lang = next.uiLang || I.detect(); applyI18n(); }
    browser.storage.local.set({ settings: next }).then(() => {
      const s = $('#saved'); s.textContent = tr('o_saved'); s.classList.add('on');
      clearTimeout(timer); timer = setTimeout(() => s.classList.remove('on'), 1400);
    });
  }
  let deb = 0;
  document.addEventListener('input', (ev) => { if (ev.target.dataset && ev.target.dataset.k) { show(); clearTimeout(deb); deb = setTimeout(save, 350); } });
  document.addEventListener('change', (ev) => { if (ev.target.dataset && ev.target.dataset.k) { show(); save(); } });

  const msg = (m) => browser.runtime.sendMessage(m);
  const line = (cls, t) => { const d = document.createElement('div'); d.className = cls; d.textContent = t; return d; };

  $('#testKeys').onclick = async () => {
    const out = $('#keyRes'); out.replaceChildren(line('', tr('o_checking')));
    try {
      const rs = await msg({ cmd: 'testKeys', keys: $('#keys').value, model: $('#model').value.trim() || S.model });
      out.replaceChildren(...(rs.length ? rs.map((r) => r.ok ? line('ok', tr('o_key_ok', r.i, r.tail, r.ms)) : line('bad', tr('o_key_bad', r.i, r.tail, r.status || '', r.msg))) : [line('bad', tr('o_no_keys'))]));
    } catch (e) { out.replaceChildren(line('bad', String(e.message || e))); }
  };
  $('#listModels').onclick = async () => {
    const out = $('#modelRes'); out.replaceChildren(line('', tr('o_loading')));
    try {
      const list = await msg({ cmd: 'listModels', keys: $('#keys').value });
      const dl = $('#models'); dl.replaceChildren();
      list.forEach((n) => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });
      out.replaceChildren(line('ok', tr('o_models_n', list.length)));
    } catch (e) { out.replaceChildren(line('bad', String(e.message || e))); }
  };
  $('#selfTest').onclick = async () => {
    const out = $('#selfRes'); out.replaceChildren(line('', tr('o_sending')));
    try {
      const r = await msg({ cmd: 'selfTest', keys: $('#keys').value, model: $('#model').value.trim() || S.model });
      const rows = [line('ok', tr('o_self_ok', r.ms, r.alive, r.total)), line('', tr('o_caps', r.caps))];
      if (r.alive < r.total) rows.push(line('bad', r.reasons));
      out.replaceChildren(...rows);
    } catch (e) { out.replaceChildren(line('bad', String(e.message || e))); }
  };
  $('#clear').onclick = async () => {
    const r = await msg({ cmd: 'clearCache' });
    $('#clearRes').replaceChildren(line('ok', tr('o_cleared', r.removed)));
  };
})();
