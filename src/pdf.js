'use strict';
// Petit générateur de PDF sans dépendance : texte (Helvetica), rectangles, traits, images PNG et JPEG.
// Les coordonnées partent du coin haut gauche, en points (A4 = 595 x 842).
const zlib = require('node:zlib');

const A4 = { w: 595.28, h: 841.89 };

// Largeurs Helvetica / Helvetica-Bold pour les caractères 32 à 126 (unités de 1/1000)
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const SPECIAL_W = { '€': 556, '«': 556, '»': 556, '’': 222, '‘': 222, '“': 333, '”': 333, '…': 1000, '–': 556, '—': 1000, '·': 278, '°': 400, 'œ': 944, 'Œ': 1000, '•': 350, ' ': 278, '©': 737, '®': 737, '×': 584 };
const WINANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, 'œ': 0x9c, 'Œ': 0x8c, 'Ÿ': 0x9f };

function normalizeText(s) {
  return String(s ?? '').replace(/[   ]/g, ' ').replace(/[‐‑]/g, '-').replace(/\r/g, '');
}

function charWidth(ch, bold) {
  const code = ch.charCodeAt(0);
  const table = bold ? W_BOLD : W_REG;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (SPECIAL_W[ch]) return SPECIAL_W[ch];
  const base = ch.normalize('NFD')[0];
  const bc = base.charCodeAt(0);
  if (bc >= 32 && bc <= 126) return table[bc - 32];
  return 556;
}

function textWidth(s, size, bold = false) {
  let w = 0;
  for (const ch of normalizeText(s)) w += charWidth(ch, bold);
  return (w * size) / 1000;
}

function encode(s) {
  const bytes = [];
  for (const ch of normalizeText(s)) {
    const c = ch.charCodeAt(0);
    let b;
    if (WINANSI[ch]) b = WINANSI[ch];
    else if (c >= 32 && c <= 126) b = c;
    else if (c >= 0xa0 && c <= 0xff) b = c;
    else b = 63; // ?
    if (b === 40 || b === 41 || b === 92) bytes.push(92);
    bytes.push(b);
  }
  return Buffer.from(bytes).toString('latin1');
}

// Découpe un texte en lignes qui tiennent dans `width`
function wrap(text, width, size, bold = false) {
  const out = [];
  for (const para of normalizeText(text).split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const tryLine = line ? line + ' ' + word : word;
      if (textWidth(tryLine, size, bold) <= width || !line) {
        line = tryLine;
        // Mot trop long : coupe dure
        while (textWidth(line, size, bold) > width && line.length > 1) {
          let i = line.length - 1;
          while (i > 1 && textWidth(line.slice(0, i), size, bold) > width) i--;
          out.push(line.slice(0, i));
          line = line.slice(i);
        }
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

function hexColor(hex) {
  const m = String(hex || '#000000').match(/^#?([0-9a-f]{6})$/i);
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map((v) => +v.toFixed(3));
}

// --- Images ---
function parseJpeg(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
      const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7), comps = buf[i + 9];
      return { type: 'jpeg', w, h, comps, data: buf };
    }
    i += 2 + len;
  }
  return null;
}

function parsePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let i = 8, ihdr, palette, trns;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8), data = buf.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!ihdr || ihdr.interlace) return null;
  const { w, h, depth, color } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPP = channels * depth;
  const stride = Math.ceil((w * bitsPP) / 8);
  const bpp = Math.max(1, bitsPP >> 3);
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
  }
  // Conversion en RVB 8 bits + alpha
  const rgb = Buffer.alloc(w * h * 3);
  const alpha = Buffer.alloc(w * h, 255);
  let hasAlpha = false;
  const sample = (row, idx) => {
    if (depth === 8) return row[idx];
    if (depth === 16) return row[idx * 2];
    const perByte = 8 / depth, byte = row[Math.floor(idx / perByte)], shift = 8 - depth * ((idx % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 && color !== 3 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < h; y++) {
    const row = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      let r, g, b, a = 255;
      if (color === 3) {
        const idx = sample(row, x);
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
        if (trns && idx < trns.length) a = trns[idx];
      } else if (color === 0 || color === 4) {
        r = g = b = Math.round(sample(row, x * channels) * scale);
        if (color === 4) a = sample(row, x * channels + 1);
      } else {
        r = sample(row, x * channels); g = sample(row, x * channels + 1); b = sample(row, x * channels + 2);
        if (color === 6) a = sample(row, x * channels + 3);
      }
      rgb[o * 3] = r; rgb[o * 3 + 1] = g; rgb[o * 3 + 2] = b; alpha[o] = a;
      if (a !== 255) hasAlpha = true;
    }
  }
  return { type: 'png', w, h, rgb, alpha: hasAlpha ? alpha : null };
}

function loadImage(buf) {
  if (!buf || buf.length < 8) return null;
  try {
    if (buf[0] === 0xff && buf[1] === 0xd8) return parseJpeg(buf);
    return parsePng(buf);
  } catch {
    return null;
  }
}

class PDF {
  constructor() {
    this.pages = [];
    this.images = [];
    this.addPage();
  }
  addPage() {
    this.page = { ops: [], images: new Set() };
    this.pages.push(this.page);
    return this;
  }
  op(s) { this.page.ops.push(s); }
  Y(y) { return +(A4.h - y).toFixed(2); }

  fill(hex) { const [r, g, b] = hexColor(hex); this.op(`${r} ${g} ${b} rg`); }
  stroke(hex) { const [r, g, b] = hexColor(hex); this.op(`${r} ${g} ${b} RG`); }

  text(x, y, str, { size = 10, bold = false, color = '#1d1b29', align = 'left', width } = {}) {
    let tx = x;
    const w = textWidth(str, size, bold);
    if (align === 'right') tx = (width !== undefined ? x + width : x) - w;
    if (align === 'center') tx = x + ((width || 0) - w) / 2;
    this.fill(color);
    this.op(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${tx.toFixed(2)} ${this.Y(y + size * 0.8)} Td (${encode(str)}) Tj ET`);
    return w;
  }

  // Bloc de texte avec retour à la ligne ; renvoie la hauteur utilisée
  paragraph(x, y, str, width, { size = 10, bold = false, color = '#1d1b29', leading = 1.4, align = 'left' } = {}) {
    const lines = wrap(str, width, size, bold);
    lines.forEach((l, i) => this.text(x, y + i * size * leading, l, { size, bold, color, align, width }));
    return lines.length * size * leading;
  }

  rect(x, y, w, h, { fill, stroke, lineWidth = 1, dash, radius = 0 } = {}) {
    if (fill) this.fill(fill);
    if (stroke) { this.stroke(stroke); this.op(`${lineWidth} w`); }
    this.op(dash ? `[${dash.join(' ')}] 0 d` : '[] 0 d');
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2), k = 0.5523 * r;
      const X = x, Yt = this.Y(y), Yb = this.Y(y + h);
      this.op(`${X + r} ${Yt} m ${X + w - r} ${Yt} l ${X + w - r + k} ${Yt} ${X + w} ${Yt - r + k} ${X + w} ${Yt - r} c ${X + w} ${Yb + r} l ${X + w} ${Yb + r - k} ${X + w - r + k} ${Yb} ${X + w - r} ${Yb} c ${X + r} ${Yb} l ${X + r - k} ${Yb} ${X} ${Yb + r - k} ${X} ${Yb + r} c ${X} ${Yt - r} l ${X} ${Yt - r + k} ${X + r - k} ${Yt} ${X + r} ${Yt} c h`);
    } else {
      this.op(`${x.toFixed(2)} ${this.Y(y + h)} ${w.toFixed(2)} ${h.toFixed(2)} re`);
    }
    this.op(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.op('[] 0 d');
  }

  line(x1, y1, x2, y2, { color = '#dddae8', width = 0.8 } = {}) {
    this.stroke(color);
    this.op(`${width} w ${x1.toFixed(2)} ${this.Y(y1)} m ${x2.toFixed(2)} ${this.Y(y2)} l S`);
  }

  // Ajoute une image ; renvoie ses dimensions ou null si le format n'est pas lu
  image(buf, x, y, maxW, maxH) {
    const img = loadImage(buf);
    if (!img) return null;
    const ratio = Math.min(maxW / img.w, maxH / img.h);
    const w = img.w * ratio, h = img.h * ratio;
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, img });
    this.page.images.add(name);
    this.op(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${this.Y(y + h)} cm /${name} Do Q`);
    return { w, h };
  }

  output() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesId = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imgIds = {};
    for (const { name, img } of this.images) {
      if (img.type === 'jpeg') {
        const cs = img.comps === 1 ? '/DeviceGray' : img.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
        imgIds[name] = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, data: img.data });
      } else {
        let smask = '';
        if (img.alpha) {
          const sid = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(img.alpha) });
          smask = ` /SMask ${sid} 0 R`;
        }
        imgIds[name] = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask}`, data: zlib.deflateSync(img.rgb) });
      }
    }
    const pageIds = [];
    for (const p of this.pages) {
      const content = add({ dict: '<< /Filter /FlateDecode', data: zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1')) });
      const xo = [...p.images].map((n) => `/${n} ${imgIds[n]} 0 R`).join(' ');
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xo ? ` /XObject << ${xo} >>` : ''} >> /Contents ${content} 0 R >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

    const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(offset);
      let buf;
      if (typeof o === 'string') buf = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
      else buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict} /Length ${o.data.length} >>\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      chunks.push(buf);
      offset += buf.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

module.exports = { PDF, A4, textWidth, wrap, loadImage };
