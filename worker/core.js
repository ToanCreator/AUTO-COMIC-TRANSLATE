/*
 * ACT core — thuật toán thuần (không DOM) để:
 *   1) tìm đúng điểm ảnh của chữ (mask) thay vì "tô hình chữ nhật"
 *   2) xoá chữ bằng inpainting (push-pull) chỉ trên mask
 *   3) tính vùng trống trong bong bóng + dàn chữ dịch vừa vặn
 *   4) cắt ảnh dài (webtoon) tại hàng "yên tĩnh" thay vì cắt ngang chữ
 * Chạy được trong Worker lẫn Node (để test).
 */
(function (root) {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
  const median = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };

  /* ---------- màu chủ đạo ---------- */
  function dominantColor(d, W, x0, y0, x1, y1) {
    const cnt = new Uint32Array(4096), sr = new Float64Array(4096), sg = new Float64Array(4096), sb = new Float64Array(4096);
    const area = Math.max(1, (x1 - x0) * (y1 - y0));
    const st = Math.max(1, Math.floor(Math.sqrt(area / 40000)));
    let n = 0;
    for (let y = y0; y < y1; y += st) {
      for (let x = x0; x < x1; x += st) {
        const i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
        const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
        cnt[k]++; sr[k] += r; sg[k] += g; sb[k] += b; n++;
      }
    }
    if (!n) return { r: 255, g: 255, b: 255, share: 0 };
    let best = 0, bk = 0;
    for (let k = 0; k < 4096; k++) if (cnt[k] > best) { best = cnt[k]; bk = k; }
    return { r: Math.round(sr[bk] / best), g: Math.round(sg[bk] / best), b: Math.round(sb[bk] / best), share: best / n };
  }

  /* ---------- thống kê dòng chữ gốc ---------- */
  function segments(arr, thr) {
    const s = []; let st = -1;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] > thr) { if (st < 0) st = i; } else if (st >= 0) { s.push([st, i]); st = -1; }
    }
    if (st >= 0) s.push([st, arr.length]);
    return s;
  }
  function lineStats(mask, W, ink) {
    const iw = ink.x1 - ink.x0, ih = ink.y1 - ink.y0;
    const rows = new Int32Array(ih), cols = new Int32Array(iw);
    for (let y = 0; y < ih; y++) {
      for (let x = 0; x < iw; x++) {
        if (mask[(ink.y0 + y) * W + ink.x0 + x]) { rows[y]++; cols[x]++; }
      }
    }
    const rs = segments(rows, Math.floor(iw * 0.015)), cs = segments(cols, Math.floor(ih * 0.015));
    const vertical = ih > 1.6 * iw && rs.length <= 2 && cs.length >= 1;
    const pick = vertical ? cs : rs;
    if (!pick.length) return { lines: 1, lineH: Math.max(8, ih), pitch: Math.max(10, ih * 1.2), vertical: false };
    const sizes = pick.map((s) => s[1] - s[0]);
    const lineH = Math.max(6, median(sizes));
    let pitch = lineH * 1.25;
    if (pick.length > 1) {
      const gaps = []; for (let i = 1; i < pick.length; i++) gaps.push(pick[i][0] - pick[i - 1][0]);
      pitch = Math.max(lineH, median(gaps));
    }
    return { lines: pick.length, lineH, pitch, vertical };
  }

  /* Vành đai quanh box (chắc chắn là nền, không có chữ): có phẳng không? */
  function ringFlat(d, W, H, box) {
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const pad = Math.max(4, Math.round(0.12 * Math.min(bw, bh)));
    const X0 = Math.max(0, box.x0 - pad), Y0 = Math.max(0, box.y0 - pad), X1 = Math.min(W, box.x1 + pad), Y1 = Math.min(H, box.y1 + pad);
    const px = [];
    const area = (X1 - X0) * (Y1 - Y0) - bw * bh;
    const st = Math.max(1, Math.floor(Math.sqrt(Math.max(1, area) / 3000)));
    for (let y = Y0; y < Y1; y += st) {
      for (let x = X0; x < X1; x += st) {
        if (x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1) continue;
        const i = (y * W + x) * 4; px.push([d[i], d[i + 1], d[i + 2]]);
      }
    }
    if (px.length < 20) return { share: 0, color: null };
    const col = [0, 1, 2].map((k) => median(px.map((c) => c[k])));
    let ok = 0;
    for (const c of px) if (Math.abs(c[0] - col[0]) + Math.abs(c[1] - col[1]) + Math.abs(c[2] - col[2]) <= 30) ok++;
    return { share: ok / px.length, color: col.map(Math.round) };
  }

  /* ---------- Phân tích vùng NỀN PHẲNG (bong bóng, khung chữ) ---------- */
  function analyzeFlat(d, W, H, box, o) {
    o = o || {};
    const n = W * H;
    const dom = o.bgColor ? { r: o.bgColor[0], g: o.bgColor[1], b: o.bgColor[2], share: o.bgShare || 1 } : dominantColor(d, W, box.x0, box.y0, box.x1, box.y1);
    if (dom.share < (o.minShare == null ? 0.28 : o.minShare)) return null;
    const tol = o.tol || 80, bR = dom.r, bG = dom.g, bB = dom.b;

    const isBg = new Uint8Array(n);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      isBg[p] = (Math.abs(d[i] - bR) + Math.abs(d[i + 1] - bG) + Math.abs(d[i + 2] - bB)) <= tol ? 1 : 0;
    }
    // Vá các đường nối MẢNH (1-3px) chạy thẳng dài (vết nối ảnh/khung): coi như nền để chữ chạm vào đường đó
    // không bị dính thành một với đường (mất khả năng xoá) và bong bóng không bị cắt đôi.
    {
      const bwv = box.x1 - box.x0, bhv = box.y1 - box.y0;
      const dl = new Uint8Array(n), dr = new Uint8Array(n), thin = new Uint8Array(n);
      // theo hàng: khoảng cách tới điểm nền gần nhất bên trái/phải
      for (let y = 0; y < H; y++) {
        let last = -1000; const r0 = y * W;
        for (let x = 0; x < W; x++) { const p = r0 + x; if (isBg[p]) last = x; dl[p] = Math.min(255, x - last); }
        last = 1e6;
        for (let x = W - 1; x >= 0; x--) { const p = r0 + x; if (isBg[p]) last = x; dr[p] = Math.min(255, last - x); }
      }
      for (let p = 0; p < n; p++) thin[p] = (!isBg[p] && dl[p] <= 3 && dr[p] <= 3 && dl[p] + dr[p] <= 4) ? 1 : 0;
      const Lv = Math.max(80, bhv);
      for (let x = 0; x < W; x++) {
        let c = 0; for (let y = 0; y < H; y++) c += thin[y * W + x];
        if (c >= Lv) for (let y = 0; y < H; y++) if (thin[y * W + x]) isBg[y * W + x] = 1;
      }
      // theo cột (đường nằm ngang)
      const du = new Uint8Array(n), dd = new Uint8Array(n), thinH = new Uint8Array(n);
      for (let x = 0; x < W; x++) {
        let last = -1000;
        for (let y = 0; y < H; y++) { const p = y * W + x; if (isBg[p]) last = y; du[p] = Math.min(255, y - last); }
        last = 1e6;
        for (let y = H - 1; y >= 0; y--) { const p = y * W + x; if (isBg[p]) last = y; dd[p] = Math.min(255, last - y); }
      }
      for (let p = 0; p < n; p++) thinH[p] = (!isBg[p] && du[p] <= 3 && dd[p] <= 3 && du[p] + dd[p] <= 4) ? 1 : 0;
      const Lh = Math.max(80, Math.round(1.2 * bwv));
      for (let y = 0; y < H; y++) {
        let c = 0; for (let x = 0; x < W; x++) c += thinH[y * W + x];
        if (c >= Lh) for (let x = 0; x < W; x++) if (thinH[y * W + x]) isBg[y * W + x] = 1;
      }
    }
    // flood fill nền từ mọi điểm nền trong box => "ruột" bong bóng
    const I = new Uint8Array(n), stack = new Int32Array(n);
    let sp = 0;
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        const p = y * W + x;
        if (isBg[p] && !I[p]) { I[p] = 1; stack[sp++] = p; }
      }
    }
    while (sp) {
      const p = stack[--sp], x = p % W, y = (p / W) | 0;
      if (x > 0 && isBg[p - 1] && !I[p - 1]) { I[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && isBg[p + 1] && !I[p + 1]) { I[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && isBg[p - W] && !I[p - W]) { I[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && isBg[p + W] && !I[p + W]) { I[p + W] = 1; stack[sp++] = p + W; }
    }
    const pk = new Int32Array(n); let npk = 0;     // túi nền: gán sau khi biết đâu là nét chữ, đâu là viền
    // các thành phần liên thông KHÔNG thuộc nền: chữ là "đảo" nằm trong ruột, viền bong bóng thì dính ra ngoài
    const lab = new Int32Array(n), comps = [null];
    let nc = 0;
    for (let s = 0; s < n; s++) {
      if (I[s] || lab[s]) continue;
      nc++;
      let minx = W, miny = H, maxx = -1, maxy = -1, area = 0, border = false;
      lab[s] = nc; sp = 0; stack[sp++] = s;
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p / W) | 0;
        area++;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= W || (!dx && !dy)) continue;
            const q = yy * W + xx;
            if (!I[q] && !lab[q]) { lab[q] = nc; stack[sp++] = q; }
          }
        }
      }
      comps.push({ minx, miny, maxx, maxy, area, border });
    }
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const bls = o.blockers || [];
    const inBlocker = (c) => { const cx = (c.minx + c.maxx) / 2, cy = (c.miny + c.maxy) / 2; return bls.some((b) => cx >= b.x0 && cx < b.x1 && cy >= b.y0 && cy < b.y1); };
    const cand = [], allH = [];
    for (let k = 1; k <= nc; k++) {
      const c = comps[k];
      if (c.border) continue;
      const cw = c.maxx - c.minx + 1, ch = c.maxy - c.miny + 1;
      if (cw > 2.5 * bw + 16 || ch > 2.5 * bh + 16) continue;                 // quá to => viền/tranh
      c.k = k; c.w = cw; c.h = ch; c.fill = c.area / (cw * ch);
      cand.push(c);
      if (c.area >= 4) allH.push(ch);
    }
    // VIỀN bong bóng (vòng mảnh, rất lớn so với một nét chữ) tuyệt đối không phải chữ, kể cả khi box model to hơn bong bóng
    const hMed = allH.length ? median(allH) : 0;
    for (let i = cand.length - 1; i >= 0; i--) {
      const c = cand[i];
      const ringy = c.fill < 0.2 && ((hMed && (c.w > 5 * hMed + 8 || c.h > 5 * hMed + 8)) || (c.w >= 0.85 * bw && c.h >= 0.85 * bh && c.w > 40));
      if (ringy) cand.splice(i, 1);
    }
    const hits = (c, r) => !(c.maxx < r.x0 || c.minx >= r.x1 || c.maxy < r.y0 || c.miny >= r.y1);
    // "Túi" nền: mỗi bong bóng là một vùng nền liên thông riêng. Viền (mọi thứ không phải nét chữ ứng viên) là RÀO CẢN;
    // viền "lông nhím" có khe hở nên nở rào cản 3px để bịt khe, rồi mới tìm vùng nền liên thông.
    {
      const isGlyph = new Uint8Array(nc + 1); cand.forEach((c) => { isGlyph[c.k] = 1; });
      const bar = new Uint8Array(n);
      for (let p = 0; p < n; p++) { const l = lab[p]; if (l && !isGlyph[l]) bar[p] = 1; }
      const dil1 = (src, w, h, R, horiz) => {
        const out = new Uint8Array(src.length);
        const L1 = horiz ? h : w, L2 = horiz ? w : h, st1 = horiz ? w : 1, st2 = horiz ? 1 : w;
        for (let i = 0; i < L1; i++) {
          let last = -1e6;
          for (let j = 0; j < L2; j++) { const p = i * st1 + j * st2; if (src[p]) last = j; if (j - last <= R) out[p] = 1; }
          last = 1e6;
          for (let j = L2 - 1; j >= 0; j--) { const p = i * st1 + j * st2; if (src[p]) last = j; if (last - j <= R) out[p] = 1; }
        }
        return out;
      };
      const areas = cand.filter((c) => c.area >= 4).map((c) => c.area).sort((a, b) => a - b);
      const medArea = areas.length ? areas[Math.floor(areas.length / 2)] : 0;
      // nét "lông nhím" rời ra sát viền cũng là ứng viên nhưng KHÔNG phải chữ: gắn cờ edge nếu có viền ngay sát bbox (<=2px)
      cand.forEach((c) => {
        const x0 = Math.max(0, c.minx - 2), x1 = Math.min(W - 1, c.maxx + 2), y0 = Math.max(0, c.miny - 2), y1 = Math.min(H - 1, c.maxy + 2);
        let hit = false;
        for (let x = x0; x <= x1 && !hit; x++) if (bar[y0 * W + x] || bar[y1 * W + x]) hit = true;
        for (let y = y0; y <= y1 && !hit; y++) if (bar[y * W + x0] || bar[y * W + x1]) hit = true;
        // chỉ loại mảnh nhỏ hoặc mảnh dài/mỏng (nét lông nhím); chữ cỡ bình thường sát viền vẫn là chữ
        c.edge = hit && (c.area < 0.35 * medArea || (c.fill < 0.3 && Math.max(c.w, c.h) >= 2.5 * Math.min(c.w, c.h)));
      });
      const barD = dil1(dil1(bar, W, H, 3, true), W, H, 3, false);
      for (let s0 = 0; s0 < n; s0++) {
        if (!I[s0] || barD[s0] || pk[s0]) continue;
        npk++; pk[s0] = npk; sp = 0; stack[sp++] = s0;
        while (sp) {
          const p = stack[--sp], x = p % W, y = (p / W) | 0;
          if (x > 0 && I[p - 1] && !barD[p - 1] && !pk[p - 1]) { pk[p - 1] = npk; stack[sp++] = p - 1; }
          if (x < W - 1 && I[p + 1] && !barD[p + 1] && !pk[p + 1]) { pk[p + 1] = npk; stack[sp++] = p + 1; }
          if (y > 0 && I[p - W] && !barD[p - W] && !pk[p - W]) { pk[p - W] = npk; stack[sp++] = p - W; }
          if (y < H - 1 && I[p + W] && !barD[p + W] && !pk[p + W]) { pk[p + W] = npk; stack[sp++] = p + W; }
        }
      }
    }
    // túi nền + màu nền cục bộ của từng thành phần (lấy mẫu vòng quanh bbox)
    const ringInfo = (c) => {
      for (const off of [4, 8, 14]) {
        const m = new Map(); let r = 0, g = 0, b = 0, k = 0;
        const x0 = Math.max(0, c.minx - off), x1 = Math.min(W - 1, c.maxx + off), y0 = Math.max(0, c.miny - off), y1 = Math.min(H - 1, c.maxy + off);
        const add = (x, y) => { const p = y * W + x, v = pk[p]; if (v) { m.set(v, (m.get(v) || 0) + 1); const i = p * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; } };
        for (let x = x0; x <= x1; x++) { add(x, y0); add(x, y1); }
        for (let y = y0 + 1; y < y1; y++) { add(x0, y); add(x1, y); }
        let best = 0, bc = 0; m.forEach((cnt, v) => { if (cnt > bc) { bc = cnt; best = v; } });
        if (best) { c.pk = best; c.bg = [r / k, g / k, b / k]; return; }
      }
      c.pk = 0; c.bg = [bR, bG, bB];
    };
    cand.forEach(ringInfo);
    const pocketAt = (x, y) => {
      const m = new Map();
      for (let yy = Math.max(0, y - 10); yy <= Math.min(H - 1, y + 10); yy += 2) for (let xx = Math.max(0, x - 10); xx <= Math.min(W - 1, x + 10); xx += 2) { const v = pk[yy * W + xx]; if (v) m.set(v, (m.get(v) || 0) + 1); }
      let best = 0, bc = 0; m.forEach((cnt, v) => { if (cnt > bc) { bc = cnt; best = v; } });
      return best;
    };
    const ownP = pocketAt(Math.round((box.x0 + box.x1) / 2), Math.round((box.y0 + box.y1) / 2));
    cand.forEach((c) => { if (!c.pk && ownP) c.pk = ownP; });
    const owned = new Set();      // túi đã có mục khác (bong bóng/khung) đứng tên => không lấy chữ ở đó
    for (const b of bls) if (b.ref && (b.ref.k === 'b' || b.ref.k === 'c')) { const P = pocketAt(Math.round((b.x0 + b.x1) / 2), Math.round((b.y0 + b.y1) / 2)); if (P) owned.add(P); }
    const allowedP = (P) => P === ownP || !owned.has(P);
    // Box của model hay NHỎ hơn hoặc LỆCH so với chữ thật => không tin box tuyệt đối:
    // lấy nét chữ chạm box làm "hạt giống" (nếu trống thì mở rộng box dần), rồi lan sang các nét chữ sát nhau
    // trong CÙNG túi nền và cùng màu nền (không lan sang bong bóng bên cạnh hay thanh phụ khác màu).
    let seeds = [];
    for (const f of [0, 0.6, 1.4]) {
      const r = f ? { x0: box.x0 - f * bw, y0: box.y0 - f * bh - 4, x1: box.x1 + f * bw, y1: box.y1 + f * bh + 4 } : box;
      seeds = cand.filter((c) => hits(c, r) && !c.edge && allowedP(c.pk) && !(o.respectBlockers && inBlocker(c)));
      if (seeds.reduce((a, c) => a + c.area, 0) >= 3) break;
      seeds = [];
    }
    if (!seeds.length) return null;
    const hs = seeds.filter((c) => c.area >= 6).map((c) => c.h).sort((a, b) => a - b);
    const hRef = hs.length ? hs[Math.min(hs.length - 1, Math.floor(hs.length * 0.75))] : Math.max.apply(null, seeds.map((c) => c.h));
    const gap = clamp(Math.round(1.3 * hRef), 5, 70), maxH = 4 * hRef + 6;
    const bgNear = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) <= 36;
    const keep = new Uint8Array(nc + 1), pocketList = [], byP = new Map();
    seeds.forEach((c) => { if (!byP.has(c.pk)) byP.set(c.pk, []); byP.get(c.pk).push(c); });
    byP.forEach((ss, P) => {
      let ux0 = W, uy0 = H, ux1 = -1, uy1 = -1, area = 0;
      const list = [];
      const take = (c) => {
        keep[c.k] = 1; list.push(c); area += c.area;
        if (c.minx < ux0) ux0 = c.minx; if (c.miny < uy0) uy0 = c.miny; if (c.maxx > ux1) ux1 = c.maxx; if (c.maxy > uy1) uy1 = c.maxy;
      };
      ss.forEach(take);
      const sb = [0, 0, 0]; ss.forEach((c) => { sb[0] += c.bg[0] / ss.length; sb[1] += c.bg[1] / ss.length; sb[2] += c.bg[2] / ss.length; });
      const poolP = cand.filter((c) => !keep[c.k] && c.pk === P && !c.edge && c.h <= maxH && bgNear(c.bg, sb) && !(o.respectBlockers && inBlocker(c)));
      for (let grew = true, guard = 0; grew && guard++ < 60;) {
        grew = false;
        for (const c of poolP) {
          if (keep[c.k]) continue;
          const dx = Math.max(0, c.minx - ux1 - 1, ux0 - c.maxx - 1), dy = Math.max(0, c.miny - uy1 - 1, uy0 - c.maxy - 1);
          if (dx <= gap && dy <= gap) { take(c); grew = true; }
        }
      }
      pocketList.push({ pk: P, area, rect: { x0: ux0, y0: uy0, x1: ux1 + 1, y1: uy1 + 1 } });
    });
    const totalA = pocketList.reduce((a, q) => a + q.area, 0) || 1;
    const pockets = pocketList.filter((q) => pocketList.length === 1 || q.pk === ownP || q.area >= 0.06 * totalA)
      .map((q) => ({ rect: q.rect, px: q.area, pk: q.pk }));
    const pocketSet = new Set(pocketList.map((q) => q.pk));
    const ownsPoint = (x, y) => pocketSet.has(pocketAt(x, y));
    const er = new Uint8Array(n);
    let ix0 = W, iy0 = H, ix1 = -1, iy1 = -1, cnt = 0, maxD = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x, l = lab[p];
        if (l && keep[l]) {
          er[p] = 1; cnt++;
          if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
          const i = p * 4, dd = Math.abs(d[i] - bR) + Math.abs(d[i + 1] - bG) + Math.abs(d[i + 2] - bB);
          if (dd > maxD) maxD = dd;
        }
      }
    }
    if (cnt < 3) return null;
    const ink = { x0: ix0, y0: iy0, x1: ix1 + 1, y1: iy1 + 1 };
    // màu chữ: trung bình các điểm xa nền nhất
    let fr = 0, fg = 0, fb = 0, fn = 0;
    for (let y = ink.y0; y < ink.y1; y++) {
      for (let x = ink.x0; x < ink.x1; x++) {
        const p = y * W + x; if (!er[p]) continue;
        const i = p * 4, dd = Math.abs(d[i] - bR) + Math.abs(d[i + 1] - bG) + Math.abs(d[i + 2] - bB);
        if (dd >= 0.7 * maxD) { fr += d[i]; fg += d[i + 1]; fb += d[i + 2]; fn++; }
      }
    }
    const stats = lineStats(er, W, ink);
    // nở mask vài px (viền mờ), chỉ nở vào vùng nền
    let hole = er.slice();
    const dil = o.dil == null ? clamp(Math.round(stats.lineH * 0.07), 1, 3) : o.dil;
    for (let k = 0; k < dil; k++) {
      const nx = hole.slice();
      for (let y = Math.max(0, ink.y0 - dil - 1); y < Math.min(H, ink.y1 + dil + 2); y++) {
        for (let x = Math.max(0, ink.x0 - dil - 1); x < Math.min(W, ink.x1 + dil + 2); x++) {
          const p = y * W + x; if (!hole[p]) continue;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy; if (yy < 0 || yy >= H) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx; if (xx < 0 || xx >= W) continue;
              const q = yy * W + xx; if (I[q] && !hole[q]) nx[q] = 1;
            }
          }
        }
      }
      hole = nx;
    }
    // vệt mờ quanh chữ (JPEG, khử răng cưa) vẫn "gần màu nền" nên không bị nhận là chữ: lan lỗ ra các điểm nền còn lệch màu
    if (dom.share >= 0.6) {
      const hx0 = Math.max(0, ink.x0 - 12), hy0 = Math.max(0, ink.y0 - 12), hx1 = Math.min(W, ink.x1 + 12), hy1 = Math.min(H, ink.y1 + 12);
      const dev = (q) => { const i = q * 4; return Math.abs(d[i] - bR) + Math.abs(d[i + 1] - bG) + Math.abs(d[i + 2] - bB); };
      for (let it = 0; it < 6; it++) {
        const add = [];
        for (let y = hy0; y < hy1; y++) {
          for (let x = hx0; x < hx1; x++) {
            const q = y * W + x;
            if (hole[q] || !I[q]) continue;
            if ((x > 0 && hole[q - 1]) || (x < W - 1 && hole[q + 1]) || (y > 0 && hole[q - W]) || (y < H - 1 && hole[q + W])) { if (dev(q) > 9) add.push(q); }
          }
        }
        if (!add.length) break;
        for (const q of add) hole[q] = 1;
      }
    }
    const inside = new Uint8Array(n);
    for (let p = 0; p < n; p++) inside[p] = (I[p] | er[p]) ? 1 : 0;
    const valid = new Uint8Array(n);
    for (let p = 0; p < n; p++) valid[p] = I[p] && !hole[p] ? 1 : 0;
    return {
      kind: 'flat', hole, valid, inside, ink, stats, er, pockets, ownsPoint,
      bg: [bR, bG, bB], share: dom.share,
      fg: fn ? [Math.round(fr / fn), Math.round(fg / fn), Math.round(fb / fn)] : [0, 0, 0], stroke: null
    };
  }

  /* ---------- Phân tích chữ TRÊN TRANH: tách nét chữ bằng top-hat / black-hat ---------- */
  function morph(src, w, h, r, isMax) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = isMax ? 0 : 255;
        for (let k = -r; k <= r; k++) {
          const v = src[row + clamp(x + k, 0, w - 1)];
          if (isMax ? v > m : v < m) m = v;
        }
        tmp[row + x] = m;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let m = isMax ? 0 : 255;
        for (let k = -r; k <= r; k++) {
          const v = tmp[clamp(y + k, 0, h - 1) * w + x];
          if (isMax ? v > m : v < m) m = v;
        }
        out[y * w + x] = m;
      }
    }
    return out;
  }

  function analyzeFree(d, W, H, box, o) {
    o = o || {};
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const r = clamp(Math.round(Math.sqrt(bw * bh) * 0.035), 2, 9);
    const pad = Math.max(3, Math.round(0.1 * Math.max(bw, bh)));
    const S = { x0: Math.max(0, box.x0 - pad), y0: Math.max(0, box.y0 - pad), x1: Math.min(W, box.x1 + pad), y1: Math.min(H, box.y1 + pad) };
    const E = { x0: Math.max(0, S.x0 - r), y0: Math.max(0, S.y0 - r), x1: Math.min(W, S.x1 + r), y1: Math.min(H, S.y1 + r) };
    const ew = E.x1 - E.x0, eh = E.y1 - E.y0;
    const Y = new Uint8Array(ew * eh);
    for (let y = 0; y < eh; y++) {
      for (let x = 0; x < ew; x++) {
        const i = ((E.y0 + y) * W + E.x0 + x) * 4;
        Y[y * ew + x] = lum(d[i], d[i + 1], d[i + 2]) | 0;
      }
    }
    const opn = morph(morph(Y, ew, eh, r, false), ew, eh, r, true);   // opening
    const cls = morph(morph(Y, ew, eh, r, true), ew, eh, r, false);   // closing
    // ngưỡng theo độ tương phản trong vùng
    const hist = new Uint32Array(256); let tot = 0;
    for (let y = S.y0; y < S.y1; y++) for (let x = S.x0; x < S.x1; x++) { hist[Y[(y - E.y0) * ew + (x - E.x0)]]++; tot++; }
    let acc = 0, p5 = 0, p95 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= tot * 0.05) { p5 = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= tot * 0.05) { p95 = v; break; } }
    const contrast = Math.max(20, p95 - p5);
    let T = Math.max(o.minT || 14, 0.3 * contrast);
    const sw = S.x1 - S.x0, sh = S.y1 - S.y0;
    let m = new Uint8Array(ew * eh);
    const resp = new Uint8Array(ew * eh), pol = new Uint8Array(ew * eh);
    for (let y = S.y0; y < S.y1; y++) {
      for (let x = S.x0; x < S.x1; x++) {
        const q = (y - E.y0) * ew + (x - E.x0), v = Y[q];
        const th = v - opn[q], bhat = cls[q] - v;
        if (th >= bhat) { resp[q] = clamp(th, 0, 255); pol[q] = 1; } else { resp[q] = clamp(bhat, 0, 255); pol[q] = 2; }
      }
    }
    for (let tries = 0; tries < 4; tries++) {
      m.fill(0); let c = 0;
      for (let y = S.y0; y < S.y1; y++) {
        for (let x = S.x0; x < S.x1; x++) {
          const q = (y - E.y0) * ew + (x - E.x0);
          if (resp[q] > T) { m[q] = pol[q]; c++; }
        }
      }
      if (c / (sw * sh) > 0.45) T *= 1.4; else break;
    }
    // bỏ nhiễu nhỏ (thành phần < 2px) và thành phần quá lớn
    const lab = new Int32Array(ew * eh), stack = new Int32Array(ew * eh);
    const core = new Uint8Array(ew * eh);
    for (let s = 0; s < ew * eh; s++) {
      if (!m[s] || lab[s]) continue;
      let sp = 0, area = 0; const idx = [];
      lab[s] = 1; stack[sp++] = s;
      while (sp) {
        const p = stack[--sp]; idx.push(p); area++;
        const x = p % ew, y = (p / ew) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= eh) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= ew || (!dx && !dy)) continue;
            const q = yy * ew + xx;
            if (m[q] && !lab[q]) { lab[q] = 1; stack[sp++] = q; }
          }
        }
      }
      if (area >= 2 && area < 0.6 * sw * sh) for (const p of idx) core[p] = 1;
    }
    // hysteresis: nhận thêm điểm có phản hồi yếu hơn nhưng dính sát nét chữ (viền mờ/khử răng cưa)
    {
      const add = [];
      for (let y = S.y0; y < S.y1; y++) {
        for (let x = S.x0; x < S.x1; x++) {
          const q = (y - E.y0) * ew + (x - E.x0);
          if (core[q] || resp[q] <= 0.4 * T) continue;
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x - E.x0 + dx, yy = y - E.y0 + dy;
            if (xx >= 0 && xx < ew && yy >= 0 && yy < eh && core[yy * ew + xx]) { near = true; break; }
          }
          if (near) add.push(q);
        }
      }
      for (const q of add) { core[q] = 1; if (!m[q]) m[q] = pol[q]; }
    }
    // màu chữ / viền theo hai cực tính
    const br = [], dk = [];
    let nb = 0, nd = 0;
    for (let q = 0; q < ew * eh; q++) {
      if (!core[q]) continue;
      const x = q % ew + E.x0, y = ((q / ew) | 0) + E.y0, i = (y * W + x) * 4;
      if (m[q] === 1) { nb++; if (br.length < 1500 && (nb % 3) === 0) br.push([d[i], d[i + 1], d[i + 2]]); }
      else { nd++; if (dk.length < 1500 && (nd % 3) === 0) dk.push([d[i], d[i + 1], d[i + 2]]); }
    }
    if (nb + nd < Math.max(8, 0.003 * sw * sh)) return null;
    const med3 = (arr) => [0, 1, 2].map((k) => median(arr.map((c) => c[k])));
    let fg, stroke = null;
    const both = Math.min(nb, nd) >= 0.25 * Math.max(nb, nd);
    if (both) { fg = med3(br.length ? br : [[255, 255, 255]]); stroke = med3(dk.length ? dk : [[0, 0, 0]]); }
    else if (nb >= nd) { fg = med3(br); } else { fg = med3(dk); }
    // nở mask rồi đưa về toạ độ cửa sổ
    const dr = clamp(Math.round(r * 0.6), 1, 4);
    let cur = core;
    for (let k = 0; k < dr; k++) {
      const nx = cur.slice();
      for (let q = 0; q < ew * eh; q++) {
        if (!cur[q]) continue;
        const x = q % ew, y = (q / ew) | 0;
        if (x > 0) nx[q - 1] = 1; if (x < ew - 1) nx[q + 1] = 1; if (y > 0) nx[q - ew] = 1; if (y < eh - 1) nx[q + ew] = 1;
      }
      cur = nx;
    }
    const hole = new Uint8Array(W * H), coreW = new Uint8Array(W * H);
    let ix0 = W, iy0 = H, ix1 = -1, iy1 = -1;
    for (let y = S.y0; y < S.y1; y++) {
      for (let x = S.x0; x < S.x1; x++) {
        const q = (y - E.y0) * ew + (x - E.x0);
        if (cur[q]) hole[y * W + x] = 1;
        if (core[q]) {
          coreW[y * W + x] = 1;
          if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
        }
      }
    }
    const ink = { x0: ix0, y0: iy0, x1: ix1 + 1, y1: iy1 + 1 };
    return { kind: 'free', hole, valid: null, inside: null, ink, stats: lineStats(coreW, W, ink), bg: null, fg: fg.map(Math.round), stroke: stroke && stroke.map(Math.round) };
  }

  /* ---------- Inpainting push-pull (nhanh, mượt, chỉ động vào mask) ---------- */
  function fillHoles(d, W, H, hole, valid) {
    const levels = [];
    let w = W, h = H;
    let c = new Float32Array(w * h * 3), wt = new Float32Array(w * h), any = 0;
    for (let p = 0; p < w * h; p++) {
      if (!hole[p] && (!valid || valid[p])) {
        wt[p] = 1; c[3 * p] = d[4 * p]; c[3 * p + 1] = d[4 * p + 1]; c[3 * p + 2] = d[4 * p + 2]; any++;
      }
    }
    if (!any) return false;
    levels.push({ w, h, c, wt });
    while (w > 1 || h > 1) {
      const L = levels[levels.length - 1];
      const nw = (w + 1) >> 1, nh = (h + 1) >> 1;
      const nc = new Float32Array(nw * nh * 3), nwt = new Float32Array(nw * nh);
      for (let y = 0; y < h; y++) {
        const ny = y >> 1;
        for (let x = 0; x < w; x++) {
          const p = y * w + x, q = ny * nw + (x >> 1);
          nwt[q] += L.wt[p] * 0.25;
          nc[3 * q] += L.c[3 * p] * 0.25; nc[3 * q + 1] += L.c[3 * p + 1] * 0.25; nc[3 * q + 2] += L.c[3 * p + 2] * 0.25;
        }
      }
      levels.push({ w: nw, h: nh, c: nc, wt: nwt });
      w = nw; h = nh;
    }
    const top = levels[levels.length - 1];
    let F = new Float32Array(3);
    if (top.wt[0] > 0) for (let k = 0; k < 3; k++) F[k] = top.c[k] / top.wt[0]; else F.fill(128);
    for (let l = levels.length - 2; l >= 0; l--) {
      const L = levels[l], U = levels[l + 1];
      const out = new Float32Array(L.w * L.h * 3);
      for (let y = 0; y < L.h; y++) {
        const fy = (y + 0.5) * 0.5 - 0.5, y0 = Math.floor(fy), ty = fy - y0;
        const ya = clamp(y0, 0, U.h - 1), yb = clamp(y0 + 1, 0, U.h - 1);
        for (let x = 0; x < L.w; x++) {
          const fx = (x + 0.5) * 0.5 - 0.5, x0 = Math.floor(fx), tx = fx - x0;
          const xa = clamp(x0, 0, U.w - 1), xb = clamp(x0 + 1, 0, U.w - 1);
          const p = y * L.w + x, wv = Math.min(1, L.wt[p]);
          for (let k = 0; k < 3; k++) {
            const a = F[(ya * U.w + xa) * 3 + k], b = F[(ya * U.w + xb) * 3 + k];
            const cc = F[(yb * U.w + xa) * 3 + k], dd = F[(yb * U.w + xb) * 3 + k];
            const up = (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + dd * tx) * ty;
            out[p * 3 + k] = L.c[p * 3 + k] + (1 - wv) * up;
          }
        }
      }
      F = out;
    }
    for (let p = 0; p < W * H; p++) {
      if (hole[p]) { d[4 * p] = F[3 * p] + 0.5; d[4 * p + 1] = F[3 * p + 1] + 0.5; d[4 * p + 2] = F[3 * p + 2] + 0.5; }
    }
    return true;
  }

  /* ---------- Hạt nhiễu: vùng xoá trên tranh không bị "nhựa" so với xung quanh ---------- */
  function estimateNoise(d, W, H, hole, bb) {
    const x0 = Math.max(1, bb.x0 - 8), y0 = Math.max(1, bb.y0 - 8), x1 = Math.min(W - 1, bb.x1 + 8), y1 = Math.min(H - 1, bb.y1 + 8);
    const L = (p) => lum(d[p * 4], d[p * 4 + 1], d[p * 4 + 2]);
    let s2 = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = y * W + x;
        if (hole[p] || hole[p - 1] || hole[p + 1] || hole[p - W] || hole[p + W]) continue;
        const r = L(p) - (L(p - 1) + L(p + 1) + L(p - W) + L(p + W)) / 4;
        s2 += r * r; n++;
      }
    }
    return n > 30 ? Math.min(14, Math.sqrt(s2 / n / 1.25)) : 0;
  }
  function addGrain(d, W, H, hole, sigma) {
    if (sigma < 0.8) return;
    let seed = 0x9e3779b9;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let p = 0; p < W * H; p++) {
      if (!hole[p]) continue;
      const g = (rnd() + rnd() + rnd() + rnd() - 2) * 1.732 * sigma;   // ~N(0,sigma)
      d[p * 4] += g; d[p * 4 + 1] += g; d[p * 4 + 2] += g;
    }
  }

  /* ---------- Mở rộng hình chữ nhật trong ruột bong bóng ---------- */
  function growRect(inside, W, H, r, lim, blockers, step) {
    let { x0, y0, x1, y1 } = r;
    const bl = blockers || [];
    const hit = (ax0, ay0, ax1, ay1) => bl.some((b) => ax0 < b.x1 && ax1 > b.x0 && ay0 < b.y1 && ay1 > b.y0);
    const stripOk = (ax0, ay0, ax1, ay1) => {
      if (ax0 < 0 || ay0 < 0 || ax1 > W || ay1 > H) return false;
      if (hit(ax0, ay0, ax1, ay1)) return false;
      let tot = 0, ok = 0;
      for (let y = ay0; y < ay1; y++) for (let x = ax0; x < ax1; x++) { tot++; if (inside[y * W + x]) ok++; }
      return ok >= tot * 0.996;
    };
    let moved = true, guard = 0;
    while (moved && guard++ < 400) {
      moved = false;
      if (x0 - step >= lim.x0 && stripOk(x0 - step, y0, x0, y1)) { x0 -= step; moved = true; }
      if (x1 + step <= lim.x1 && stripOk(x1, y0, x1 + step, y1)) { x1 += step; moved = true; }
      if (y0 - step >= lim.y0 && stripOk(x0, y0 - step, x1, y0)) { y0 -= step; moved = true; }
      if (y1 + step <= lim.y1 && stripOk(x0, y1, x1, y1 + step)) { y1 += step; moved = true; }
    }
    return { x0, y0, x1, y1 };
  }

  /* ---------- Dàn chữ ---------- */
  const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;
  function units(text) {
    const out = [];
    for (const w of String(text).replace(/\s+/g, ' ').trim().split(' ')) {
      if (!w) continue;
      if (CJK.test(w)) { Array.from(w).forEach((ch, i) => out.push({ s: ch, sp: i === 0 && out.length > 0 })); }
      else out.push({ s: w, sp: out.length > 0 });
    }
    return out;
  }
  function wrapUnits(measure, us, maxW, size) {
    const lines = []; let cur = '';
    const sw = measure(' ', size);
    for (const u of us) {
      let s = u.s;
      if (measure(s, size) > maxW && !CJK.test(s)) {            // từ quá dài: bẻ theo ký tự
        if (cur) { lines.push(cur); cur = ''; }
        let part = '';
        for (const ch of Array.from(s)) {
          if (part && measure(part + ch, size) > maxW) { lines.push(part); part = ch; } else part += ch;
        }
        cur = part; continue;
      }
      const cand = cur ? cur + (u.sp ? ' ' : '') + s : s;
      if (cur && measure(cand, size) > maxW) { lines.push(cur); cur = s; } else cur = cand;
    }
    if (cur) lines.push(cur);
    void sw;
    return lines;
  }
  /* measure(str,size) -> px. Trả về {size, lines, lh, w, h, fits} */
  function fitText(measure, text, W, H, o) {
    o = o || {};
    const lhR = o.lh || 1.2, us = units(text);
    if (!us.length) return { size: 0, lines: [], lh: 0, w: 0, h: 0, fits: true };
    const widest = (ls, size) => ls.reduce((m, s) => Math.max(m, measure(s, size)), 0);
    const test = (size, w) => { const ls = wrapUnits(measure, us, w, size); return { ls, ok: ls.length * size * lhR <= H && widest(ls, size) <= w + 0.5 }; };
    let lo = Math.max(5, o.min || 8), hi = Math.max(lo, o.cap || 48);
    if (o.fixed) { lo = hi = o.fixed; }
    let best = null;
    if (!test(lo, W).ok) { best = lo; }               // không vừa kể cả cỡ nhỏ nhất => tràn
    else {
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (test(mid, W).ok) lo = mid; else hi = mid - 1; }
      best = lo;
    }
    const first = test(best, W);
    let lines = first.ls, fits = first.ok;
    // cân đều độ rộng các dòng cho đẹp: tìm bề rộng nhỏ nhất vẫn giữ nguyên số dòng
    if (fits && lines.length > 1) {
      let a = 1, b = Math.ceil(W);
      const n = lines.length;
      while (a < b) {
        const mid = (a + b) >> 1, t = test(best, mid);
        if (t.ok && t.ls.length <= n) b = mid; else a = mid + 1;
      }
      const t = test(best, b); if (t.ok) lines = t.ls;
    }
    return { size: best, lines, lh: best * lhR, w: widest(lines, best), h: lines.length * best * lhR, fits };
  }

  /* ---------- Cắt ảnh dài tại hàng yên tĩnh ---------- */
  function rowScores(gray, w, h) {
    const sc = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let s = 0, s2 = 0;
      for (let x = 0; x < w; x++) { const v = gray[y * w + x]; s += v; s2 += v * v; }
      const m = s / w, vr = Math.max(0, s2 / w - m * m);
      sc[y] = Math.min(1, Math.sqrt(vr) / 64);
    }
    return sc;
  }
  /* score[j] ứng với hàng nguồn [j*f,(j+1)*f). Trả về danh sách lát {y0,y1,c0,c1}: c = vùng "sở hữu" */
  function planSlices(H, sliceH, ov, score, f) {
    if (H <= sliceH * 1.25) return [{ y0: 0, y1: H, c0: 0, c1: H }];
    const cuts = [0];
    let y = 0;
    while (H - y > sliceH * 1.25) {
      const target = y + sliceH, span = Math.round(sliceH * 0.22);
      const lo = Math.max(y + Math.round(sliceH * 0.5), target - span), hi = Math.min(H - Math.round(sliceH * 0.15), target + Math.round(sliceH * 0.04));
      // lấy mọi hàng "yên tĩnh" ngang nhau nhất trong cửa sổ, rồi chọn hàng gần mốc nhất
      const at = (yy) => score[Math.min(score.length - 1, Math.floor(yy / f))];
      let minS = Infinity;
      for (let yy = lo; yy <= hi; yy++) minS = Math.min(minS, at(yy));
      let best = target, bd = Infinity;
      for (let yy = lo; yy <= hi; yy++) {
        if (at(yy) <= minS + 0.02 && Math.abs(yy - target) < bd) { bd = Math.abs(yy - target); best = yy; }
      }
      cuts.push(best); y = best;
    }
    cuts.push(H);
    const out = [];
    for (let i = 0; i + 1 < cuts.length; i++) out.push({ y0: Math.max(0, cuts[i] - ov), y1: Math.min(H, cuts[i + 1] + ov), c0: cuts[i], c1: cuts[i + 1] });
    return out;
  }

  /* ---------- tiện ích vùng ---------- */
  function iou(a, b) {
    const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const i = ix * iy, u = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - i;
    return u > 0 ? i / u : 0;
  }
  function dedupe(regs, thr) {
    const out = [];
    for (const r of regs) if (!out.some((o) => iou(o, r) > (thr || 0.55))) out.push(r);
    return out;
  }
  function luminance(c) { return lum(c[0], c[1], c[2]); }


  /* ---------- Điều phối một vùng chữ trên cửa sổ ảnh ---------- */
  function windowFor(reg, W, H) {
    const bw = reg.x1 - reg.x0, bh = reg.y1 - reg.y0;
    const mx = Math.max(24, Math.round(1.0 * bw)), my = Math.max(32, Math.round(1.2 * bh), Math.round(0.4 * bw));
    return {
      x0: Math.max(0, Math.floor(reg.x0) - mx), y0: Math.max(0, Math.floor(reg.y0) - my),
      x1: Math.min(W, Math.ceil(reg.x1) + mx), y1: Math.min(H, Math.ceil(reg.y1) + my)
    };
  }

  /*
   * win: {data (RGBA, sẽ bị sửa tại chỗ), W, H, ox, oy}  — cửa sổ cắt từ ảnh gốc
   * reg: {x0,y0,x1,y1 (px ảnh gốc), t, k}   o: tuỳ chọn   measure(str,size)->px
   * blockers: các box vùng khác (px ảnh gốc) mà chữ không được lấn vào
   * Trả về null nếu bỏ qua (không tìm thấy chữ => KHÔNG đụng vào ảnh), hoặc spec để vẽ.
   */
  /* Tách ink thành các nhóm dòng cách xa nhau bởi "eo" bong bóng (bong bóng nối nhau mà model coi là một mục) */
  function splitGroups(an, W, lineH) {
    const ink = an.ink, er = an.er, ih = ink.y1 - ink.y0, iw = ink.x1 - ink.x0;
    if (!er || ih < 4 || iw < 4) return null;
    const rows = new Int32Array(ih);
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) if (er[(ink.y0 + y) * W + ink.x0 + x]) rows[y]++;
    // bỏ qua các hàng chỉ có vài điểm (nét lông nhím/dấu gạch bị xoá lẫn) để chúng không nối hai khối chữ với nhau
    let rmax = 0; for (let y = 0; y < ih; y++) if (rows[y] > rmax) rmax = rows[y];
    const segs = segments(rows, Math.max(2, Math.floor(0.06 * rmax)));
    if (segs.length < 2) return null;
    const gapMax = Math.max(12, Math.round(2.2 * lineH));
    const gs = [];
    for (const sg of segs) { const l = gs[gs.length - 1]; if (l && sg[0] - l.y1 <= gapMax) l.y1 = sg[1]; else gs.push({ y0: sg[0], y1: sg[1] }); }
    if (gs.length < 2) return null;
    const mk = (g) => {
      let x0 = iw, x1 = 0, px = 0;
      for (let y = g.y0; y < g.y1; y++) for (let x = 0; x < iw; x++) if (er[(ink.y0 + y) * W + ink.x0 + x]) { px++; if (x < x0) x0 = x; if (x >= x1) x1 = x + 1; }
      return { rect: { x0: ink.x0 + x0, y0: ink.y0 + g.y0, x1: ink.x0 + x1, y1: ink.y0 + g.y1 }, px };
    };
    let groups = gs.map(mk);
    // chỉ tách khi giữa hai nhóm có vật cản thật (viền bong bóng thắt lại); không thì vẫn là một khối chữ
    const merged = [groups[0]];
    for (let k = 1; k < groups.length; k++) {
      const a = merged[merged.length - 1], b = groups[k];
      const x0 = Math.min(a.rect.x0, b.rect.x0), x1 = Math.max(a.rect.x1, b.rect.x1);
      let minFrac = 1;
      for (let y = a.rect.y1; y < b.rect.y0; y++) {
        let c = 0; for (let x = x0; x < x1; x++) if (an.inside[y * W + x]) c++;
        minFrac = Math.min(minFrac, c / Math.max(1, x1 - x0));
      }
      if (minFrac < 0.9) merged.push(b);
      else { a.rect = { x0, y0: a.rect.y0, x1, y1: b.rect.y1 }; a.px += b.px; }
    }
    const tot = merged.reduce((a, g) => a + g.px, 0) || 1;
    if (merged.some((g) => g.px < 0.2 * tot)) return null;      // nhóm quá ít nét = nhiễu, không tách
    return merged.length > 1 ? merged : null;
  }
  /* Chia bản dịch cho các nhóm theo tỉ lệ lượng chữ gốc, ưu tiên cắt sau dấu câu */
  function splitText(text, weights) {
    const us = units(text);
    if (!us.length) return weights.map(() => '');
    const pre = [0]; let tot = 0;
    us.forEach((u) => { tot += u.s.length + (u.sp ? 1 : 0); pre.push(tot); });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const cuts = []; let acc = 0, prev = 0;
    for (let g = 0; g < weights.length - 1; g++) {
      acc += weights[g];
      const ideal = tot * acc / sum;
      let best = -1, bs = Infinity;
      for (let i = prev + 1; i <= us.length - (weights.length - 1 - g); i++) {
        const pun = /[,.;:!?…、。！？，]$/.test(us[i - 1].s) ? 0.15 * tot : 0;
        const sc = Math.abs(pre[i] - ideal) - pun;
        if (sc < bs) { bs = sc; best = i; }
      }
      if (best < 0) best = Math.min(us.length, prev + 1);
      cuts.push(best); prev = best;
    }
    const parts = []; let a = 0;
    for (const c of cuts.concat([us.length])) {
      parts.push(us.slice(a, c).map((u, k) => (k && u.sp ? ' ' : '') + u.s).join('')); a = c;
    }
    return parts;
  }

  /* Mục trùng: model hay trả cùng một dòng chữ hai lần (bản dịch khác nhau). taken: [{box, ink}] của các mục đã xử lý */
  function boxArea(a) { return Math.max(0, a.x1 - a.x0) * Math.max(0, a.y1 - a.y0); }
  function boxInter(a, b) { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)); }
  function isDup(r, taken) {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    return taken.some((t) => boxInter(r, t.box) / Math.max(1, Math.min(boxArea(r), boxArea(t.box))) >= 0.5 ||
      (t.inks || [t.ink]).some((k) => cx >= k.x0 && cx <= k.x1 && cy >= k.y0 && cy <= k.y1));
  }

  function processWindow(win, reg, o, measure, blockers) {
    o = o || {};
    const { data: d, W, H, ox, oy } = win;
    const box = {
      x0: clamp(Math.round(reg.x0 - ox), 0, W - 1), y0: clamp(Math.round(reg.y0 - oy), 0, H - 1),
      x1: clamp(Math.round(reg.x1 - ox), 1, W), y1: clamp(Math.round(reg.y1 - oy), 1, H)
    };
    if (box.x1 - box.x0 < 3 || box.y1 - box.y0 < 3) return null;
    const flatKind = reg.k === 'b' || reg.k === 'c';
    // chữ "tự do" nhưng nền thực ra phẳng (khung màu, trời đồng màu...) => dùng đường chính xác của nền phẳng
    const ring = ringFlat(d, W, H, box);
    const ringOk = ring.share >= 0.8;
    const flatBg = flatKind || ringOk;
    const blAll = (blockers || []).map((b) => ({ x0: b.x0 - ox, y0: b.y0 - oy, x1: b.x1 - ox, y1: b.y1 - oy, ref: b }))
      .filter((b) => !(Math.abs(b.x0 - box.x0) < 2 && Math.abs(b.y0 - box.y0) < 2 && Math.abs(b.x1 - box.x1) < 2 && Math.abs(b.y1 - box.y1) < 2));
    let an = null;
    if (flatBg) an = analyzeFlat(d, W, H, box, { dil: o.dil, tol: o.tol, bgColor: ringOk ? ring.color : null, bgShare: ring.share, blockers: blAll, respectBlockers: !flatKind });
    if (!an && (!flatKind || o.freeFallback)) an = analyzeFree(d, W, H, box, {});
    if (!an) return null;
    fillHoles(d, W, H, an.hole, an.valid);
    if (an.kind === 'free') addGrain(d, W, H, an.hole, estimateNoise(d, W, H, an.hole, an.ink));

    const ink = an.ink, bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const absorbed = [], bl = [];
    if (an.kind === 'flat') {
      // vùng khác có tâm nằm trong chữ vừa xoá = cùng một bong bóng bị model tách đôi => gộp bản dịch, không coi là vật cản
      const ex = Math.round(0.08 * (ink.x1 - ink.x0)) + 4, ey = Math.round(0.08 * (ink.y1 - ink.y0)) + 4;
      for (const b of blAll) {
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
        if (flatKind && (b.ref.k === 'b' || b.ref.k === 'c') && cx >= ink.x0 - ex && cx <= ink.x1 + ex && cy >= ink.y0 - ey && cy <= ink.y1 + ey && (!an.ownsPoint || an.ownsPoint(Math.round(cx), Math.round(cy)))) absorbed.push(b.ref);
        else bl.push(b);
      }
    }
    const text = absorbed.length ? [reg.t].concat(absorbed.slice().sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0)).map((b) => b.t)).join(' ') : reg.t;

    let fg = an.fg, stroke = an.stroke;
    if (an.kind === 'flat') {
      if (Math.abs(luminance(fg) - luminance(an.bg)) < 90) fg = luminance(an.bg) > 140 ? [0, 0, 0] : [255, 255, 255];
    } else if (!stroke) {
      stroke = luminance(fg) > 128 ? [0, 0, 0] : [255, 255, 255];
    }

    let groups = [{ rect: ink, st: an.stats, px: 1 }];
    if (an.kind === 'flat') {
      if (an.pockets && an.pockets.length > 1) {
        // nhiều bong bóng nối/chồng nhau mà model gộp thành một mục: mỗi túi nền là một nhóm riêng
        groups = an.pockets.slice().sort((a, b) => (a.rect.y0 - b.rect.y0) || (a.rect.x0 - b.rect.x0))
          .map((g) => ({ rect: g.rect, st: lineStats(an.er, W, g.rect), px: g.px }));
      } else if (!an.stats.vertical) {
        const gs = splitGroups(an, W, an.stats.lineH);
        if (gs) groups = gs.map((g) => ({ rect: g.rect, st: lineStats(an.er, W, g.rect), px: g.px }));
      }
    }
    const texts = groups.length > 1 ? splitText(text, groups.map((g) => g.px)) : [text];

    const parts = [];
    groups.forEach((g, gi) => {
      if (!texts[gi]) return;
      const gink = g.rect, st = g.st;
      let avail;
      if (an.kind === 'flat') {
        const others = groups.filter((_, k) => k !== gi).map((x) => x.rect);
        const gr = growRect(an.inside, W, H, gink, { x0: 0, y0: 0, x1: W, y1: H }, bl.concat(others), Math.max(1, Math.round(Math.min(bw, bh) / 40)));
        const m = Math.max(2, Math.round(0.05 * Math.min(gr.x1 - gr.x0, gr.y1 - gr.y0)));
        avail = { x0: gr.x0 + m, y0: gr.y0 + m, x1: gr.x1 - m, y1: gr.y1 - m };
        if (avail.x1 - avail.x0 < 6 || avail.y1 - avail.y0 < 6) avail = { x0: gink.x0, y0: gink.y0, x1: gink.x1, y1: gink.y1 };
      } else {
        const u = { x0: Math.min(box.x0, gink.x0), y0: Math.min(box.y0, gink.y0), x1: Math.max(box.x1, gink.x1), y1: Math.max(box.y1, gink.y1) };
        const ex = Math.round(0.04 * (u.x1 - u.x0)), ey = Math.round(0.04 * (u.y1 - u.y0));
        avail = { x0: Math.max(0, u.x0 - ex), y0: Math.max(0, u.y0 - ey), x1: Math.min(W, u.x1 + ex), y1: Math.min(H, u.y1 + ey) };
      }
      const cap0 = st.vertical ? st.lineH * 1.1 : Math.max(st.lineH * 1.15, st.pitch * 0.95);
      const cap = Math.max(o.minSize || 9, Math.round(cap0 * (o.sizeScale || 1)));
      const fo = { cap: o.fixed || cap, min: o.minSize || 9, fixed: o.fixed || 0, lh: o.lh || 1.2 };
      let fit = fitText(measure, texts[gi], avail.x1 - avail.x0, avail.y1 - avail.y0, fo);
      if (!fit.fits) {
        const ex = Math.round(0.12 * (avail.x1 - avail.x0)), ey = Math.round(0.12 * (avail.y1 - avail.y0));
        avail = { x0: Math.max(0, avail.x0 - ex), y0: Math.max(0, avail.y0 - ey), x1: Math.min(W, avail.x1 + ex), y1: Math.min(H, avail.y1 + ey) };
        fit = fitText(measure, texts[gi], avail.x1 - avail.x0, avail.y1 - avail.y0, fo);
      }
      parts.push({
        kind: an.kind, lines: fit.lines, size: fit.size, lh: fit.lh, w: fit.w, h: fit.h, fits: fit.fits,
        cx: ox + (avail.x0 + avail.x1) / 2, cy: oy + (avail.y0 + avail.y1) / 2,
        availW: avail.x1 - avail.x0, availH: avail.y1 - avail.y0, fg, stroke, bg: an.bg, share: an.share || 0
      });
    });
    if (!parts.length) return null;
    const first = parts[0];
    return Object.assign({}, first, {
      extra: parts.slice(1), absorbed,
      ink: { x0: ox + ink.x0, y0: oy + ink.y0, x1: ox + ink.x1, y1: oy + ink.y1 },
      inks: groups.map((g) => ({ x0: ox + g.rect.x0, y0: oy + g.rect.y0, x1: ox + g.rect.x1, y1: oy + g.rect.y1 }))
    });
  }

  const api = { ringFlat, windowFor, processWindow, isDup, splitGroups, splitText, clamp, dominantColor, analyzeFlat, analyzeFree, fillHoles, growRect, fitText, units, rowScores, planSlices, iou, dedupe, lineStats, luminance, median };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ACT_CORE = api;
})(typeof self !== 'undefined' ? self : globalThis);
