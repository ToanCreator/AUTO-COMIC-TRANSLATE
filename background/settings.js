/* Cấu hình dùng chung cho background. Lưu ở browser.storage.local (khoá "settings"). */
(function () {
  'use strict';
  const ACT = (self.ACT = self.ACT || {});

  ACT.FONT_STACKS = {
    'Auto': '"Noto Sans","Segoe UI",Roboto,Arial,"Helvetica Neue",sans-serif',
    'Times New Roman': '"Times New Roman",Times,serif',
    'Arial': 'Arial,"Helvetica Neue",Helvetica,sans-serif',
    'Roboto': 'Roboto,Arial,sans-serif',
    'Aptos': 'Aptos,"Segoe UI",Arial,sans-serif',
    'Oswald': 'Oswald,"Arial Narrow",Arial,sans-serif',
    'Helvetica': 'Helvetica,"Helvetica Neue",Arial,sans-serif',
    'Segoe UI': '"Segoe UI",Roboto,Arial,sans-serif',
    'Georgia': 'Georgia,"Times New Roman",serif',
    'Noto Sans': '"Noto Sans","Segoe UI",Arial,sans-serif',
    'Noto Serif': '"Noto Serif",Georgia,"Times New Roman",serif',
    'Comic Sans MS': '"Comic Sans MS","Comic Neue",Chalkboard,"Noto Sans",sans-serif'
  };

  /* modelW = bề rộng ảnh gửi cho model; q = chất lượng JPEG gửi đi */
  ACT.QUALITY = {
    fast: { modelW: 800, q: 0.75 },
    balanced: { modelW: 1000, q: 0.8 },
    accurate: { modelW: 1280, q: 0.86 }
  };

  ACT.DEFAULTS = {
    keys: '',
    model: 'gemini-3.5-flash-lite',
    src: 'Auto Detected',
    dst: 'Vietnamese',
    quality: 'balanced',
    perKey: 4,
    font: 'Auto',
    fontCustom: '',
    sizeScale: 1,
    bold: true,
    freeText: true,
    sfx: false,
    keepNames: true,
    extra: '',
    glossary: '',
    autoFab: true,
    proofread: true,    // thêm một yêu cầu chữ nhỏ để rà soát bản dịch (từ vô nghĩa, sai chính tả)
    uiLang: ''          // '' = theo ngôn ngữ trình duyệt; en | vi | ja | zh
  };

  ACT.S = Object.assign({}, ACT.DEFAULTS);

  /* Ngôn ngữ giao diện + hàm dịch chuỗi (shared/i18n.js phải được nạp trước) */
  const I18N = () => self.ACT_I18N || (typeof require === 'function' ? require('../shared/i18n.js') : null);
  ACT.lang = () => ACT.S.uiLang || (I18N() ? I18N().detect() : 'en');
  ACT.tr = function () { const a = Array.prototype.slice.call(arguments); return I18N().t.apply(null, [ACT.lang()].concat(a)); };

  ACT.loadSettings = async function () {
    const r = await browser.storage.local.get('settings');
    ACT.S = Object.assign({}, ACT.DEFAULTS, r.settings || {});
    return ACT.S;
  };
  browser.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) ACT.S = Object.assign({}, ACT.DEFAULTS, ch.settings.newValue || {});
  });

  ACT.parseKeys = (txt) => [...new Set(String(txt || '').split(/[\s,;]+/).map((s) => s.trim()).filter((s) => s.length >= 10))];

  ACT.fontStack = (S) => {
    if (S.font === 'Custom' && S.fontCustom) return '"' + String(S.fontCustom).replace(/["\\]/g, '') + '",' + ACT.FONT_STACKS.Auto;
    return ACT.FONT_STACKS[S.font] || ACT.FONT_STACKS.Auto;
  };

  /* glossary người dùng: mỗi dòng "gốc=đích" hoặc "gốc => đích" */
  ACT.parseGlossary = (txt) => {
    const m = new Map();
    for (const ln of String(txt || '').split(/\r?\n/)) {
      const x = ln.split(/=>|=|→/);
      if (x.length >= 2 && x[0].trim() && x[1].trim()) m.set(x[0].trim(), x.slice(1).join('=').trim());
    }
    return m;
  };
})();
