/* Worker xử lý ảnh: giải mã → cắt lát gửi model → xoá chữ + vẽ bản dịch → mã hoá JPEG. */
importScripts('core.js');
const C = self.ACT_CORE;

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
async function decode(buf) { return createImageBitmap(new Blob([buf])); }
async function encodeJpeg(cv, q) {
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: q });
  return blob.arrayBuffer();
}

/* ---------- 1) chuẩn bị lát ảnh cho model ---------- */
async function prep({ buf, modelW, jpegQ, crop }) {
  const bmp = await decode(buf);
  const w = bmp.width, h = bmp.height;
  const cx0 = crop ? C.clamp(Math.round(crop.x0), 0, w - 2) : 0;
  const cy0 = crop ? C.clamp(Math.round(crop.y0), 0, h - 2) : 0;
  const cw = crop ? C.clamp(Math.round(crop.x1), cx0 + 2, w) - cx0 : w;
  const ch = crop ? C.clamp(Math.round(crop.y1), cy0 + 2, h) - cy0 : h;
  // vùng chọn nhỏ => phóng to để đọc được chữ nhỏ; ảnh to => thu nhỏ
  const s = crop ? C.clamp(900 / Math.max(cw, ch), 1, 3) : Math.min(1, modelW / cw);
  const sliceM = Math.round(1.8 * modelW), sliceSrc = Math.round(sliceM / s);
  // điểm "yên tĩnh" từng hàng để cắt không đứt chữ
  let plan;
  if (ch <= sliceSrc * 1.25) plan = [{ y0: 0, y1: ch, c0: 0, c1: ch }];
  else {
    const sw = 160, sh = Math.max(2, Math.round(ch * sw / cw));
    const small = new OffscreenCanvas(sw, sh), sx = small.getContext('2d', { willReadFrequently: true });
    sx.drawImage(bmp, cx0, cy0, cw, ch, 0, 0, sw, sh);
    const id = sx.getImageData(0, 0, sw, sh).data, gray = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) gray[i] = C.clamp((id[i * 4] * 0.299 + id[i * 4 + 1] * 0.587 + id[i * 4 + 2] * 0.114) | 0, 0, 255);
    plan = C.planSlices(ch, sliceSrc, Math.round(sliceSrc * 0.03), C.rowScores(gray, sw, sh), ch / sh);
  }
  const slices = [];
  for (const p of plan) {
    const sh = p.y1 - p.y0, tw = Math.max(8, Math.round(cw * s)), th = Math.max(8, Math.round(sh * s));
    const cv = new OffscreenCanvas(tw, th), cx = cv.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, cx0, cy0 + p.y0, cw, sh, 0, 0, tw, th);
    const ab = await encodeJpeg(cv, jpegQ || 0.8);
    slices.push({ y0: cy0 + p.y0, y1: cy0 + p.y1, c0: cy0 + p.c0, c1: cy0 + p.c1, x0: cx0, x1: cx0 + cw, tw, th, b64: toB64(new Uint8Array(ab)) });
  }
  bmp.close && bmp.close();
  return { w, h, slices };
}

/* ---------- 2) xoá chữ + vẽ bản dịch ---------- */
async function render({ buf, regions, opts }) {
  const bmp = await decode(buf);
  const W = bmp.width, H = bmp.height;
  const cv = new OffscreenCanvas(W, H), ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  const weight = opts.bold ? 700 : 500, family = opts.fontStack;
  const setFont = (px) => { ctx.font = weight + ' ' + px + 'px ' + family; };
  const measure = (str, size) => { setFont(size); return ctx.measureText(str).width; };
  const minSize = Math.max(9, Math.round(W * 0.011));
  const regs = regions.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
  const specs = []; let skipped = 0;
  const done = new Set();          // vùng đã xử lý hoặc đã bị gộp vào vùng khác (cùng bong bóng)
  const taken = [];                // box + vùng chữ đã xoá của các mục đã vẽ, để bỏ mục trùng (model hay trả cùng một chữ hai lần)
  const isDup = (r) => C.isDup(r, taken);
  for (const r of regs) {
    if (done.has(r)) continue;
    done.add(r);
    if (isDup(r)) { skipped++; continue; }
    const wd = C.windowFor(r, W, H), ww = wd.x1 - wd.x0, wh = wd.y1 - wd.y0;
    if (ww < 4 || wh < 4) { skipped++; continue; }
    const img = ctx.getImageData(wd.x0, wd.y0, ww, wh);
    const others = regs.filter((o) => o !== r && !done.has(o));
    const spec = C.processWindow({ data: img.data, W: ww, H: wh, ox: wd.x0, oy: wd.y0 }, r,
      { freeFallback: opts.freeText, minSize, fixed: opts.fixedSize || 0, sizeScale: opts.sizeScale || 1, lh: 1.2 }, measure, others);
    if (!spec) { skipped++; continue; }
    ctx.putImageData(img, wd.x0, wd.y0);
    (spec.absorbed || []).forEach((b) => done.add(b));
    taken.push({ box: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }, ink: spec.ink, inks: spec.inks });
    specs.push(spec);
    (spec.extra || []).forEach((e) => specs.push(e));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  for (const sp of specs) {
    setFont(sp.size);
    const top = sp.cy - sp.h / 2;
    sp.lines.forEach((ln, i) => {
      const y = top + (i + 0.5) * sp.lh;
      if (sp.stroke) {
        ctx.lineWidth = Math.max(2, sp.size * 0.16);
        ctx.strokeStyle = 'rgb(' + sp.stroke.join(',') + ')';
        ctx.strokeText(ln, sp.cx, y);
      }
      ctx.fillStyle = 'rgb(' + sp.fg.join(',') + ')';
      ctx.fillText(ln, sp.cx, y);
    });
  }
  const out = await encodeJpeg(cv, 0.92);
  return { out, w: W, h: H, drawn: specs.length, skipped };
}

/* ---------- 3) mã hoá lại JPEG (xuất PDF cho ảnh chưa dịch) ---------- */
async function jpeg({ buf }) {
  const bmp = await decode(buf);
  const cv = new OffscreenCanvas(bmp.width, bmp.height), cx = cv.getContext('2d');
  cx.fillStyle = '#fff'; cx.fillRect(0, 0, bmp.width, bmp.height);
  cx.drawImage(bmp, 0, 0);
  const out = await encodeJpeg(cv, 0.92);
  return { out, w: bmp.width, h: bmp.height };
}

const OPS = { prep, render, jpeg };
self.onmessage = async (e) => {
  const { id, op } = e.data;
  try {
    const res = await OPS[op](e.data);
    const tr = res.out instanceof ArrayBuffer ? [res.out] : [];
    self.postMessage({ id, ok: true, res }, tr);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
