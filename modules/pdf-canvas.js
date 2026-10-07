const CP1252 = { 0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026', 0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160', 0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019', 0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014', 0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153', 0x9E: '\u017E', 0x9F: '\u0178' };

const FONT_TABLE = {
  F1: ['helvetica', ''], F2: ['helvetica', 'bold'], F3: ['helvetica', 'italic'], F4: ['helvetica', 'bold italic'],
  F5: ['courier', ''], F6: ['courier', 'bold'], F7: ['courier', 'italic'], F8: ['courier', 'bold italic'],
  F9: ['times', ''], F10: ['times', 'bold'], F11: ['times', 'italic'], F12: ['times', 'bold italic']
};
const FAMILY = {
  helvetica: 'Helvetica, Arial, "Liberation Sans", "Noto Sans", Roboto, sans-serif',
  courier: '"Courier New", Courier, "Liberation Mono", monospace',
  times: '"Times New Roman", Times, "Liberation Serif", serif'
};

function decodeString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      const n = raw[++i];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b') out += '\b';
      else if (n === 'f') out += '\f';
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (n === '\n') {}
      else out += n;
    } else out += ch;
  }
  if (out.length >= 2 && out.length % 2 === 0 && out.charCodeAt(0) === 0) {
    let ok = true;
    for (let i = 0; i < out.length; i += 2) if (out.charCodeAt(i) > 0x7f) { ok = false; break; }
    if (ok) {
      let u = '';
      for (let i = 0; i < out.length; i += 2) u += String.fromCharCode((out.charCodeAt(i) << 8) | out.charCodeAt(i + 1));
      return u;
    }
  }
  return out.replace(/[\u0080-\u009f]/g, c => CP1252[c.charCodeAt(0)] || c);
}

function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
  const isDelim = (c) => '()<>[]{}/%'.includes(c);
  while (i < n) {
    const c = src[i];
    if (isWs(c)) { i++; continue; }
    if (c === '%') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '(') {
      let depth = 1, j = i + 1, s = '';
      while (j < n && depth > 0) {
        const d = src[j];
        if (d === '\\') { s += d + src[j + 1]; j += 2; continue; }
        if (d === '(') depth++;
        else if (d === ')') { depth--; if (depth === 0) break; }
        s += d; j++;
      }
      toks.push({ t: 's', v: decodeString(s) });
      i = j + 1; continue;
    }
    if (c === '[') { toks.push({ t: '[' }); i++; continue; }
    if (c === ']') { toks.push({ t: ']' }); i++; continue; }
    if (c === '<' || c === '>') { i += (src[i + 1] === c) ? 2 : 1; continue; }
    if (c === '/') {
      let j = i + 1;
      while (j < n && !isWs(src[j]) && !isDelim(src[j])) j++;
      toks.push({ t: 'n', v: src.slice(i + 1, j) });
      i = j; continue;
    }
    let j = i;
    while (j < n && !isWs(src[j]) && !isDelim(src[j])) j++;
    const w = src.slice(i, j);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) toks.push({ t: 'x', v: parseFloat(w) });
    else toks.push({ t: 'o', v: w });
    i = j === i ? i + 1 : j;
  }
  return toks;
}

function mul(m, n) {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
  ];
}

const rgb = (r, g, b) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

function cmyk(c, m, y, k) { return rgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)); }

async function loadImage(src) {
  if (typeof window === 'undefined' || typeof Image === 'undefined') return null;
  return new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
}

export async function renderJsPdfToCanvases(doc, opts = {}) {
  const scale = opts.scale || 3;
  const createCanvas = opts.createCanvas || ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; });
  const loadImg = opts.loadImage || loadImage;
  const k = doc.internal.scaleFactor;
  const pageW = doc.internal.pageSize.getWidth() * k;
  const pageH = doc.internal.pageSize.getHeight() * k;
  const total = doc.internal.getNumberOfPages();
  const imgLog = Array.isArray(doc.__imgLog) ? doc.__imgLog : [];
  const canvases = [];

  for (let p = 1; p <= total; p++) {
    const canvas = createCanvas(Math.ceil(pageW * scale), Math.ceil(pageH * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const pageImgs = imgLog.filter(e => e.page === p);
    let imgIdx = 0;

    const stream = (doc.internal.pages[p] || []).join('\n');
    const toks = tokenize(stream);
    const st = { fill: '#000', stroke: '#000', lw: 1, dash: [], ctm: [1, 0, 0, 1, 0, 0], fontId: 'F1', size: 12, cs: 0, ws: 0, lead: 0, rm: 0 };
    const stack = [];
    let tm = [1, 0, 0, 1, 0, 0], tlm = [1, 0, 0, 1, 0, 0];
    let path = [];
    let operands = [];

    const P = (x, y) => {
      const X = st.ctm[0] * x + st.ctm[2] * y + st.ctm[4];
      const Y = st.ctm[1] * x + st.ctm[3] * y + st.ctm[5];
      return [X * scale, (pageH - Y) * scale];
    };
    const buildPath = () => {
      ctx.beginPath();
      for (const seg of path) {
        if (seg[0] === 'm') { const [x, y] = P(seg[1], seg[2]); ctx.moveTo(x, y); }
        else if (seg[0] === 'l') { const [x, y] = P(seg[1], seg[2]); ctx.lineTo(x, y); }
        else if (seg[0] === 'c') { const a = P(seg[1], seg[2]), b = P(seg[3], seg[4]), c = P(seg[5], seg[6]); ctx.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]); }
        else if (seg[0] === 'h') ctx.closePath();
      }
    };
    const strokeStyle = () => {
      ctx.strokeStyle = st.stroke;
      ctx.lineWidth = Math.max(0.5, st.lw * scale * Math.sqrt(Math.abs(st.ctm[0] * st.ctm[3] - st.ctm[1] * st.ctm[2])));
      ctx.setLineDash(st.dash.map(d => d * scale));
    };
    const paint = (fill, stroke, evenodd) => {
      if (path.length) {
        buildPath();
        if (fill) { ctx.fillStyle = st.fill; ctx.fill(evenodd ? 'evenodd' : 'nonzero'); }
        if (stroke) { strokeStyle(); ctx.stroke(); }
      }
      path = [];
    };
    const fontCss = () => {
      const f = FONT_TABLE[st.fontId] || FONT_TABLE.F1;
      return `${f[1] ? f[1] + ' ' : ''}${st.size}px ${FAMILY[f[0]]}`;
    };
    const drawText = (s) => {
      if (!s) return;
      const M = mul(tm, st.ctm);
      ctx.save();
      ctx.setTransform(scale * M[0], -scale * M[1], scale * M[2], -scale * M[3], scale * M[4], scale * (pageH - M[5]));
      ctx.scale(1, -1);
      ctx.font = fontCss();
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = st.fill;
      let x = 0;
      if (st.cs || st.ws) {
        for (const ch of s) {
          if (st.rm !== 1) ctx.fillText(ch, x, 0);
          x += ctx.measureText(ch).width + st.cs + (ch === ' ' ? st.ws : 0);
        }
      } else {
        if (st.rm === 1 || st.rm === 2) { ctx.strokeStyle = st.stroke; ctx.lineWidth = st.lw; ctx.strokeText(s, 0, 0); }
        if (st.rm !== 1) ctx.fillText(s, 0, 0);
        x = ctx.measureText(s).width;
      }
      ctx.restore();
      tm = mul([1, 0, 0, 1, x, 0], tm);
    };
    const num = (i) => operands[i] && operands[i].t === 'x' ? operands[i].v : 0;

    for (let ti = 0; ti < toks.length; ti++) {
      const tk = toks[ti];
      if (tk.t === '[') {
        const arr = [];
        ti++;
        while (ti < toks.length && toks[ti].t !== ']') { arr.push(toks[ti]); ti++; }
        operands.push({ t: 'a', v: arr });
        continue;
      }
      if (tk.t !== 'o') { operands.push(tk); continue; }
      const op = tk.v;
      const nOp = operands.length;
      switch (op) {
        case 'q': stack.push({ ...st, dash: st.dash.slice(), ctm: st.ctm.slice() }); break;
        case 'Q': { const s = stack.pop(); if (s) Object.assign(st, s); break; }
        case 'cm': st.ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], st.ctm); break;
        case 'w': st.lw = num(0); break;
        case 'd': st.dash = (operands[0] && operands[0].t === 'a') ? operands[0].v.filter(x => x.t === 'x').map(x => x.v) : []; break;
        case 'rg': st.fill = rgb(num(0), num(1), num(2)); break;
        case 'RG': st.stroke = rgb(num(0), num(1), num(2)); break;
        case 'g': st.fill = rgb(num(0), num(0), num(0)); break;
        case 'G': st.stroke = rgb(num(0), num(0), num(0)); break;
        case 'k': st.fill = cmyk(num(0), num(1), num(2), num(3)); break;
        case 'K': st.stroke = cmyk(num(0), num(1), num(2), num(3)); break;
        case 'm': path.push(['m', num(0), num(1)]); break;
        case 'l': path.push(['l', num(0), num(1)]); break;
        case 'c': path.push(['c', num(0), num(1), num(2), num(3), num(4), num(5)]); break;
        case 'h': path.push(['h']); break;
        case 're': { const x = num(0), y = num(1), w = num(2), h = num(3); path.push(['m', x, y], ['l', x + w, y], ['l', x + w, y + h], ['l', x, y + h], ['h']); break; }
        case 'f': case 'F': paint(true, false, false); break;
        case 'f*': paint(true, false, true); break;
        case 'S': paint(false, true, false); break;
        case 's': path.push(['h']); paint(false, true, false); break;
        case 'B': paint(true, true, false); break;
        case 'B*': paint(true, true, true); break;
        case 'b': path.push(['h']); paint(true, true, false); break;
        case 'n': path = []; break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'ET': break;
        case 'Tf': st.fontId = (operands[0] && operands[0].v) || 'F1'; st.size = num(1); break;
        case 'TL': st.lead = num(0); break;
        case 'Tc': st.cs = num(0); break;
        case 'Tw': st.ws = num(0); break;
        case 'Tr': st.rm = num(0); break;
        case 'Td': tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm.slice(); break;
        case 'TD': st.lead = -num(1); tlm = mul([1, 0, 0, 1, num(0), num(1)], tlm); tm = tlm.slice(); break;
        case 'Tm': tlm = [num(0), num(1), num(2), num(3), num(4), num(5)]; tm = tlm.slice(); break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -st.lead], tlm); tm = tlm.slice(); break;
        case 'Tj': drawText(operands[nOp - 1] && operands[nOp - 1].v); break;
        case "'": tlm = mul([1, 0, 0, 1, 0, -st.lead], tlm); tm = tlm.slice(); drawText(operands[nOp - 1] && operands[nOp - 1].v); break;
        case 'TJ': {
          const arr = operands[nOp - 1] && operands[nOp - 1].t === 'a' ? operands[nOp - 1].v : [];
          for (const e of arr) {
            if (e.t === 's') drawText(e.v);
            else if (e.t === 'x') tm = mul([1, 0, 0, 1, -e.v / 1000 * st.size, 0], tm);
          }
          break;
        }
        case 'Do': {
          const entry = pageImgs[imgIdx++];
          if (entry) {
            const im = await loadImg(entry.src);
            if (im) {
              const [x0, y0] = P(0, 0), [x1, y1] = P(1, 1);
              ctx.save();
              ctx.drawImage(im, Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
              ctx.restore();
            }
          }
          break;
        }
        default: break;
      }
      operands = [];
    }
    canvases.push(canvas);
  }
  return canvases;
}

export function installJsPdfImageLog(jsPDFClass) {
  try {
    const api = jsPDFClass && jsPDFClass.API;
    if (!api || api.__imgLogPatched || typeof api.addImage !== 'function') return;
    const orig = api.addImage;
    api.addImage = function (imageData, ...rest) {
      try {
        const page = this.internal.getCurrentPageInfo().pageNumber;
        let src = null;
        if (typeof imageData === 'string') {
          src = /^data:|^https?:|^blob:/.test(imageData) ? imageData : (/^[A-Za-z0-9+/=\s]{100,}$/.test(imageData) ? 'data:image/jpeg;base64,' + imageData.replace(/\s/g, '') : imageData);
        }
        (this.__imgLog = this.__imgLog || []).push({ page, src });
      } catch (_) {}
      return orig.call(this, imageData, ...rest);
    };
    api.__imgLogPatched = true;
  } catch (_) {}
}
