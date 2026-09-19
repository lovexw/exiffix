/* ExifFix app.js — 界面与交互(核心读写逻辑见 core.js) */
'use strict';

const CORE = window.EXIFFIX_CORE;

/* ---------------- 状态 ---------------- */

const state = {
  items: [],        // {id,file,name,kind,checked,patch, parsed, blobUrl, displayUrl, width, height, displayBlob}
  selectedId: null,
  map: null,
  marker: null,
};

const MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const DATE_FIELDS = [
  ['dtOriginal', 'DateTimeOriginal'],
  ['dtDigitized', 'CreateDate'],
  ['dtModify', 'ModifyDate'],
];

const TEXT_FIELDS = [
  ['make', 'Make'], ['model', 'Model'],
  ['lensMake', 'LensMake'], ['lensModel', 'LensModel'],
  ['software', 'Software'],
  ['artist', 'Artist'], ['copyright', 'Copyright'],
  ['description', 'ImageDescription'],
];

const $ = (sel) => document.querySelector(sel);

/* ---------------- 小工具 ---------------- */

function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

function busy(show, text = '处理中…') {
  let el = $('.busy');
  if (show) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'busy';
      el.innerHTML = '<div class="spinner"></div><div class="busy-text"></div>';
      document.body.appendChild(el);
    }
    el.querySelector('.busy-text').textContent = text;
    el.hidden = false;
  } else if (el) {
    el.remove();
  }
}

function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function dateToInputValue(d) {
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function inputValueToDate(v, sec) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], sec || 0);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------------- 文件接入 ---------------- */

function detectKind(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const t = (file.type || '').toLowerCase();
  if (t === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (t === 'image/png' || ext === 'png') return 'png';
  if (t === 'image/webp' || ext === 'webp') return 'webp';
  if (t === 'image/heic' || t === 'image/heif' || ext === 'heic' || ext === 'heif') return 'heic';
  if (t.startsWith('image/')) return t.slice(6);
  return ext || 'unknown';
}

function addFiles(fileList) {
  const files = [...fileList].filter((f) => f && (f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)));
  if (!files.length) { toast('没有识别到支持的图片文件(JPEG / PNG / WebP / HEIC)', 'err'); return; }
  files.forEach((file) => {
    if (state.items.some((it) => it.name === file.name && it.file.size === file.size)) return;
    state.items.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2),
      file, name: file.name, kind: detectKind(file), checked: true, patch: {},
    });
  });
  refreshWorkspace();
  state.items.slice(-files.length).forEach(loadItem);
}

async function ensureHeicDecoder() {
  if (window.heic2any) return;
  if (!ensureHeicDecoder._p) {
    ensureHeicDecoder._p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/heic2any.min.js';
      s.onload = resolve;
      s.onerror = () => { ensureHeicDecoder._p = null; reject(new Error('HEIC 解码器加载失败')); };
      document.head.appendChild(s);
    });
  }
  return ensureHeicDecoder._p;
}

// 借助浏览器解码能力把图像重编码为 JPEG(AVIF/伪装文件兜底)
async function reencodeToJpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  if (!out) throw new Error('无法将图像转存为 JPEG');
  return out;
}

/* ---- HEIC 解码:新版 libheif(WASM)为主,支持 iPhone 10-bit HDR 等新编码;
        heic2any(旧版 libheif 1.10)作为兜底 ---- */

let _libheifPromise = null;
function ensureLibheif() {
  if (ensureLibheif._lib) return Promise.resolve(ensureLibheif._lib);
  if (!_libheifPromise) {
    _libheifPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/libheif-bundle.js?v=5';
      s.onload = async () => {
        try {
          // bundle 导出的是 Emscripten 工厂函数,必须调用并等待初始化,
          // HeifDecoder 等类挂在初始化后的实例上
          const factory = window.libheif;
          let lib;
          if (typeof factory === 'function') lib = await factory();
          else if (factory && typeof factory.HeifDecoder === 'function') lib = factory;
          if (!lib || typeof lib.HeifDecoder !== 'function') throw new Error('libheif 初始化失败');
          ensureLibheif._lib = lib;
          resolve(lib);
        } catch (e) { _libheifPromise = null; reject(e); }
      };
      s.onerror = () => { _libheifPromise = null; reject(new Error('libheif 解码器加载失败')); };
      document.head.appendChild(s);
    });
  }
  return _libheifPromise;
}

// 按_EXIF Orientation(1-8)旋转画布,使像素"摆正"
function applyOrientation(src, o) {
  o = Number(o);
  if (!o || o < 2 || o > 8) return src;
  const swap = o >= 5;
  const dst = document.createElement('canvas');
  dst.width = swap ? src.height : src.width;
  dst.height = swap ? src.width : src.height;
  const ctx = dst.getContext('2d');
  ctx.translate(dst.width / 2, dst.height / 2);
  switch (o) {
    case 2: ctx.scale(-1, 1); break;
    case 3: ctx.rotate(Math.PI); break;
    case 4: ctx.scale(1, -1); break;
    case 5: ctx.rotate(Math.PI / 2); ctx.scale(1, -1); break;
    case 6: ctx.rotate(Math.PI / 2); break;
    case 7: ctx.rotate(-Math.PI / 2); ctx.scale(1, -1); break;
    case 8: ctx.rotate(-Math.PI / 2); break;
  }
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return dst;
}

// 按 HEIF 容器属性摆正:irot(90° 逆时针 ×角度)+ imir(先镜像后旋转)
function applyHeifTransform(src, rotation, mirror) {
  if (!rotation && mirror === null) return src;
  const swap = rotation === 1 || rotation === 3;
  const dst = document.createElement('canvas');
  dst.width = swap ? src.height : src.width;
  dst.height = swap ? src.width : src.height;
  const ctx = dst.getContext('2d');
  ctx.translate(dst.width / 2, dst.height / 2);
  if (rotation) ctx.rotate(-rotation * Math.PI / 2);
  if (mirror !== null) {
    if (mirror === 0) ctx.scale(-1, 1);
    else ctx.scale(1, -1);
  }
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return dst;
}

function canvasToJpegBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('JPEG 编码失败'))), 'image/jpeg', 0.92));
}

async function decodeHeicWithLibheif(blob, orient) {
  const libheif = await ensureLibheif();
  const buf = await blob.arrayBuffer();
  const data = new libheif.HeifDecoder().decode(buf);
  const images = data && data.images ? data.images : (Array.isArray(data) ? data : null);
  if (!images || !images.length) throw new Error('HEIC 中没有图像');
  const image = images[0];
  const w = image.get_width();
  const h = image.get_height();
  if (!w || !h) throw new Error('HEIC 图像尺寸无效');
  const frame = await new Promise((resolve, reject) => {
    try {
      image.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (imageData) => {
        if (imageData && imageData.data && imageData.data.length) resolve(imageData);
        else reject(new Error('HEIC 解码返回空数据'));
      });
    } catch (e) { reject(e); }
  });
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frame.data), w, h), 0, 0);
  let out = canvas;
  if (orient.rotation || orient.mirror !== null && orient.mirror !== undefined) {
    out = applyHeifTransform(out, orient.rotation, orient.mirror === undefined ? null : orient.mirror);
  } else if (orient.orientation) {
    out = applyOrientation(out, orient.orientation);
  }
  window.EXIFFIX._lastHeicDecoder = 'libheif';
  return canvasToJpegBlob(out);
}

async function decodeHeicToJpeg(blob, orient) {
  orient = orient || {};
  let cause = '';
  try {
    return await decodeHeicWithLibheif(blob, orient);
  } catch (e) { cause = e.message; console.warn('libheif 解码失败,尝试备用解码器:', e); }
  try {
    await ensureHeicDecoder();
    const out = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
    window.EXIFFIX._lastHeicDecoder = 'heic2any';
    return Array.isArray(out) ? out[0] : out;
  } catch (e) { cause = e.message; }
  throw new Error(`HEIC 解码失败,该照片的编码暂不受支持(如 10-bit HDR)。可在手机上改用「兼容性最佳」导出 JPEG 后重试(${cause})`);
}

const READ_OPTS = {
  tiff: true, ifd0: true, exif: true, gps: true, interop: true,
  translateValues: true, translateKeys: true, reviveValues: true, silentErrors: true,
};

async function loadItem(item) {
  try {
    // 按文件头识别真实格式:扩展名可能是伪装的(如 .jpg 实为 HEIC/WebP)
    try {
      const head = new Uint8Array(await item.file.slice(0, 32).arrayBuffer());
      const magic = CORE.sniffImageKind(head);
      if (magic && magic !== item.kind) {
        item.kind = magic;
        toast(`「${item.name}」实际是 ${magic.toUpperCase()} 格式,已按真实格式处理`, 'ok');
      }
    } catch (e) { /* 保留扩展名判断 */ }

    let displayBlob = item.file;
    if (item.kind === 'heic') {
      busy(true, `正在解码 HEIC:${item.name}`);
      // 方向:优先容器 irot/imir(iOS 照片的 EXIF 常无 Orientation),EXIF 兜底
      let orient = {};
      try {
        const head = new Uint8Array(await item.file.slice(0, 524288).arrayBuffer());
        const info = CORE.parseHeifContainer(head);
        if (info) { orient.rotation = info.rotation; orient.mirror = info.mirror; }
      } catch (e) { /* 解析失败则不旋转 */ }
      try {
        const p = await exifr.parse(item.file, { tiff: true, ifd0: true, reviveValues: true, silentErrors: true });
        if (orient.rotation == null && orient.mirror == null && p) orient.orientation = p.Orientation;
      } catch (e) { /* 无 EXIF 时默认不旋转 */ }
      displayBlob = await decodeHeicToJpeg(item.file, orient);
      item.displayBlob = displayBlob;
      busy(false);
    } else if (item.kind === 'avif') {
      // 浏览器可解码显示;保存时需转为 JPEG
      displayBlob = await reencodeToJpeg(item.file);
      item.displayBlob = displayBlob;
    }
    item.blobUrl = URL.createObjectURL(item.file);
    item.displayUrl = URL.createObjectURL(displayBlob);

    // 尺寸
    const dims = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = item.displayUrl;
    });
    item.width = dims.w; item.height = dims.h;

    // 元数据:exifr 优先;它的 UMD 构建不支持 WebP 容器,失败时用 core 兜底提取
    try {
      item.parsed = (await exifr.parse(item.file, READ_OPTS)) || {};
    } catch (e) {
      console.warn('exifr 读取失败,尝试容器提取:', item.name, e.message);
      item.parsed = {};
    }
    if (Object.keys(item.parsed).length === 0 && (item.kind === 'webp' || item.kind === 'png')) {
      try {
        const buf = new Uint8Array(await item.file.arrayBuffer());
        const tiff = item.kind === 'webp' ? CORE.extractExifTiffFromWebp(buf) : CORE.extractExifTiffFromPng(buf);
        if (tiff) item.parsed = CORE.parsedFromDict(CORE.dictFromTiffBytes(tiff)) || {};
      } catch (e) {
        console.warn('容器 EXIF 提取失败:', item.name, e);
      }
    }
  } catch (e) {
    busy(false);
    console.error(e);
    toast(`${item.name}:读取失败(${e.message})`, 'err');
    state.items = state.items.filter((it) => it !== item);
  }
  refreshWorkspace();
  if (state.selectedId === item.id || !state.selectedId) selectItem(item.id);
}

/* ---------------- 文件列表 ---------------- */

function hasPatch(item) {
  return item.patch && (Object.keys(item.patch).length > 0);
}

function gpsOf(item) {
  const p = item.parsed || {};
  let lat = p.latitude, lng = p.longitude;
  if (!Number.isFinite(lat) && Array.isArray(p.GPSLatitude)) {
    lat = CORE.dmsRationalToDeg(p.GPSLatitude, p.GPSLatitudeRef);
    lng = CORE.dmsRationalToDeg(p.GPSLongitude, p.GPSLongitudeRef);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

function renderList() {
  const list = $('#fileList');
  list.innerHTML = '';
  state.items.forEach((item) => {
    const g = gpsOf(item);
    const div = document.createElement('div');
    div.className = 'file-item' + (item.id === state.selectedId ? ' active' : '');
    div.dataset.id = item.id;
    div.innerHTML = `
      <input type="checkbox" class="f-check" ${item.checked ? 'checked' : ''} title="参与批量操作">
      <img class="f-thumb" ${item.displayUrl ? `src="${item.displayUrl}"` : ''} alt="">
      <div class="f-info">
        <div class="f-name" title="${esc(item.name)}">${esc(item.name)}</div>
        <div class="f-meta">
          ${item.width ? `${item.width}×${item.height} ·` : ''}
          ${g ? '<span class="badge gps">GPS</span>' : ''}
          ${hasPatch(item) ? '<span class="badge mod">已修改</span>' : ''}
          ${item.kind === 'heic' ? '<span class="badge">HEIC</span>' : ''}
        </div>
      </div>`;
    div.querySelector('.f-check').addEventListener('change', (e) => {
      item.checked = e.target.checked;
      updateCounts();
    });
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('f-check')) return;
      selectItem(item.id);
    });
    list.appendChild(div);
  });
  updateCounts();
  $('#fileCount').textContent = `${state.items.length} 张`;
}

function updateCounts() {
  const n = state.items.filter((i) => i.checked).length;
  $('#batchCount').textContent = n ? String(n) : '';
  $('#batchTarget').textContent = n ? `(已勾选 ${n} 张)` : '(请先在左侧勾选照片)';
}

function refreshWorkspace() {
  $('#dropzone').hidden = state.items.length > 0;
  $('#workspace').hidden = !(state.items.length > 0);
  $('#actionBar').hidden = !(state.items.length > 0);
  renderList();
  renderActionBar();
}

/* ---------------- 单张编辑 ---------------- */

function selectedItem() { return state.items.find((i) => i.id === state.selectedId) || null; }

// 有修改的字段加蓝色圆点高亮
function updateFieldHighlights(item) {
  document.querySelectorAll('[data-patch]').forEach((el) => {
    el.classList.toggle('is-modified', !!item.patch && el.dataset.patch in item.patch);
  });
}

function effValue(item, key) {
  return key in item.patch ? item.patch[key] : (item.parsed ? item.parsed[key] : undefined);
}

function selectItem(id) {
  state.selectedId = id;
  $('#emptyHint').hidden = !!id;
  $('#editPanel').hidden = !id;
  renderList();
  if (!id) return;
  const item = selectedItem();
  $('#preview').src = item.displayUrl || '';
  $('#previewLink').href = item.displayUrl || '#';
  $('#edFileName').textContent = item.name;
  $('#edKind').textContent = item.kind.toUpperCase() + (item.kind === 'heic' ? ' → JPEG' : '');
  $('#edDims').textContent =
    (item.width ? `${item.width}×${item.height} · ` : '') + fmtBytes(item.file.size) +
    (item.kind === 'heic' ? ' · 保存时将转为 JPEG(保留元数据)' : '');

  // 日期字段
  DATE_FIELDS.forEach(([key]) => {
    const v = effValue(item, key);
    const d = v == null ? null : CORE.parseExifDate(v);
    $(`#f-${key}`).value = dateToInputValue(d);
    $(`#f-${key}Sec`).value = d ? d.getSeconds() : '';
    const exifKey = DATE_FIELDS.find((f) => f[0] === key)[1];
    const origD = item.parsed ? CORE.parseExifDate(item.parsed[exifKey]) : null;
    const oh = $(`#orig-${key}`);
    if (oh) oh.textContent = '原值:' + (origD ? CORE.exifDateToStr(origD) : '无');
  });

  // GPS
  const patchGps = 'gps' in item.patch ? item.patch.gps : undefined;
  if (patchGps === null) {
    $('#f-lat').value = $('#f-lng').value = $('#f-alt').value = '';
    $('#gpsHint').textContent = '已标记为:清除 GPS';
  } else {
    const g = gpsOf(item);
    const altRaw = item.parsed && item.parsed.GPSAltitude;
    const alt = Number.isFinite(altRaw) ? (item.parsed.GPSAltitudeRef === 1 ? -altRaw : altRaw) : '';
    $('#f-lat').value = patchGps ? patchGps.lat : (g ? g.lat.toFixed(6) : '');
    $('#f-lng').value = patchGps ? patchGps.lng : (g ? g.lng.toFixed(6) : '');
    $('#f-alt').value = patchGps && Number.isFinite(patchGps.alt) ? patchGps.alt : (alt === '' ? '' : alt);
    $('#gpsHint').textContent = g ? `原值:${CORE.degToDmsStr(g.lat, true)} ${CORE.degToDmsStr(g.lng, false)}` : '原照片没有 GPS 信息';
  }

  // 文本字段
  TEXT_FIELDS.forEach(([key, exifKey]) => {
    const v = effValue(item, key);
    const el = $(`#f-${key}`);
    el.value = v == null ? '' : v;
    const orig = item.parsed ? item.parsed[exifKey] : undefined;
    el.placeholder = orig == null || orig === '' ? '(空)' : String(orig);
  });

  $('#f-removeExif').checked = !!item.patch.removeExif;
  $('#btnRevert').disabled = !hasPatch(item);
  $('#btnRevert').textContent = hasPatch(item) ? '↩️ 撤销本张修改' : '↩️ 无修改';

  updateMapForItem(item);
  renderAllExifTable(item);
  updateFieldHighlights(item);
}

/* --- 日期 --- */

function setPatchFromComparison(item, key, newValue, originalValue) {
  // 新值与原值一致时撤销该字段的修改,保持"已修改"徽章真实
  const same = (key.startsWith('dt'))
    ? (newValue == null && originalValue == null) ||
      (newValue instanceof Date && originalValue instanceof Date && newValue.getTime() === originalValue.getTime())
    : newValue === originalValue;
  if (same) delete item.patch[key];
  else item.patch[key] = newValue;
}

function bindDateField(key) {
  const input = $(`#f-${key}`), sec = $(`#f-${key}Sec`);
  const commit = () => {
    const item = selectedItem(); if (!item) return;
    const exifKey = DATE_FIELDS.find((f) => f[0] === key)[1];
    const orig = item.parsed ? CORE.parseExifDate(item.parsed[exifKey]) : null;
    const s = sec.value === '' ? 0 : Math.min(59, Math.max(0, parseInt(sec.value, 10) || 0));
    let newVal;
    if (input.value) newVal = inputValueToDate(input.value, s);
    else newVal = orig ? null : undefined; // 清空输入 = 删除标签;原本就没有 = 不改动
    if (newVal === undefined) delete item.patch[key];
    else if (orig && newVal && newVal.getTime() === orig.getTime()) delete item.patch[key];
    else item.patch[key] = newVal;
    afterEditChange(item);
  };
  input.addEventListener('change', commit);
  sec.addEventListener('change', commit);
}

/* --- 文本 --- */

function bindTextField(key, exifKey) {
  $(`#f-${key}`).addEventListener('input', (e) => {
    const item = selectedItem(); if (!item) return;
    const val = e.target.value;
    const orig = item.parsed ? item.parsed[exifKey] : undefined;
    const origStr = orig == null ? '' : String(orig);
    setPatchFromComparison(item, key, val, origStr);
    afterEditChange(item);
  });
}

function afterEditChange(item) {
  renderList();
  renderActionBar();
  updateFieldHighlights(item);
  $('#btnRevert').disabled = !hasPatch(item);
  $('#btnRevert').textContent = hasPatch(item) ? '↩️ 撤销本张修改' : '↩️ 无修改';
  if (item.id === state.selectedId) $('#f-removeExif').checked = !!item.patch.removeExif;
}

/* --- GPS 与地图 --- */

function patchGpsFromInputs(item) {
  const lat = parseFloat($('#f-lat').value), lng = parseFloat($('#f-lng').value);
  const altRaw = $('#f-alt').value;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    // 输入被清空:视为删除 GPS
    const had = 'gps' in item.patch || gpsOf(item);
    if (had) item.patch.gps = null; else delete item.patch.gps;
    return null;
  }
  const gps = { lat, lng };
  if (altRaw !== '') gps.alt = parseFloat(altRaw);
  setPatchFromComparison(item, 'gps', gps, (function () {
    const g = gpsOf(item);
    if (!g) return null;
    const a = item.parsed && item.parsed.GPSAltitude;
    const alt = Number.isFinite(a) ? (item.parsed.GPSAltitudeRef === 1 ? -a : a) : undefined;
    return { lat: g.lat, lng: g.lng, alt };
  })());
  return gps;
}

function initMap() {
  if (state.map) return;
  state.map = L.map('map', { zoomControl: true }).setView([32, 110], 3);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> 贡献者',
  }).addTo(state.map);
  state.map.on('click', (e) => {
    const item = selectedItem(); if (!item) return;
    $('#f-lat').value = e.latlng.lat.toFixed(6);
    $('#f-lng').value = e.latlng.lng.toFixed(6);
    patchGpsFromInputs(item);
    placeMarker(e.latlng.lat, e.latlng.lng);
    $('#gpsHint').textContent = `${CORE.degToDmsStr(e.latlng.lat, true)} ${CORE.degToDmsStr(e.latlng.lng, false)}`;
    afterEditChange(item);
  });
}

function placeMarker(lat, lng) {
  if (!state.map) return;
  if (!state.marker) {
    state.marker = L.marker([lat, lng], { draggable: true }).addTo(state.map);
    state.marker.on('dragend', () => {
      const pos = state.marker.getLatLng();
      const item = selectedItem(); if (!item) return;
      $('#f-lat').value = pos.lat.toFixed(6);
      $('#f-lng').value = pos.lng.toFixed(6);
      patchGpsFromInputs(item);
      afterEditChange(item);
    });
  } else {
    state.marker.setLatLng([lat, lng]);
  }
}

function updateMapForItem(item) {
  initMap();
  const patchGps = 'gps' in item.patch ? item.patch.gps : undefined;
  let lat = null, lng = null, zoom = 3;
  if (patchGps) { lat = patchGps.lat; lng = patchGps.lng; zoom = 13; }
  else if (patchGps !== null) {
    const g = gpsOf(item);
    if (g) { lat = g.lat; lng = g.lng; zoom = 13; }
  }
  if (lat != null) {
    placeMarker(lat, lng);
    state.map.setView([lat, lng], Math.max(state.map.getZoom(), zoom));
  } else if (state.marker) {
    state.map.removeLayer(state.marker);
    state.marker = null;
  }
  setTimeout(() => state.map.invalidateSize(), 60);
}

/* --- 地名搜索(Nominatim) --- */

async function searchPlace() {
  const q = $('#placeSearch').value.trim();
  if (!q) return;
  const box = $('#searchResults');
  box.innerHTML = '<div>搜索中…</div>';
  box.hidden = false;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=zh-CN&q=${encodeURIComponent(q)}`);
    const arr = await r.json();
    box.innerHTML = '';
    if (!arr.length) { box.innerHTML = '<div>没有找到该地点</div>'; return; }
    arr.forEach((p) => {
      const div = document.createElement('div');
      div.textContent = p.display_name;
      div.addEventListener('click', () => {
        const item = selectedItem(); if (!item) return;
        const lat = parseFloat(p.lat), lng = parseFloat(p.lon);
        $('#f-lat').value = lat.toFixed(6);
        $('#f-lng').value = lng.toFixed(6);
        patchGpsFromInputs(item);
        placeMarker(lat, lng);
        state.map.setView([lat, lng], 14);
        $('#gpsHint').textContent = p.display_name;
        box.hidden = true;
        afterEditChange(item);
      });
      box.appendChild(div);
    });
  } catch (e) {
    box.innerHTML = '<div>搜索失败(需要联网)</div>';
  }
}

/* --- 全部元数据表 --- */

async function renderAllExifTable(item) {
  const box = $('#allExifTable');
  box.innerHTML = '<span class="muted">读取中…</span>';
  try {
    const all = (await exifr.parse(item.file, { ...READ_OPTS, xmp: true, iptc: true, icc: false })) || {};
    const rows = Object.keys(all).filter((k) => k !== 'thumbnail' && all[k] !== undefined && typeof all[k] !== 'object')
      .sort().map((k) => `<tr><td>${esc(k)}</td><td>${esc(String(all[k]))}</td></tr>`);
    box.innerHTML = rows.length
      ? `<table>${rows.join('')}</table>`
      : '<span class="muted">这张照片没有任何 EXIF 元数据</span>';
  } catch (e) {
    box.innerHTML = `<span class="muted">读取失败:${esc(e.message)}</span>`;
  }
}

/* ---------------- 批量操作 ---------------- */

function applyBatch() {
  const targets = state.items.filter((i) => i.checked);
  if (!targets.length) { toast('请先在左侧勾选要批量处理的照片', 'err'); return; }

  const dateMode = $('#b-dateMode').value;
  const gpsMode = $('#b-gpsMode').value;
  const removeExif = $('#b-removeExif').checked;
  const textPatch = {};
  [['make', 'b-make'], ['model', 'b-model'], ['lensMake', 'b-lensMake'], ['lensModel', 'b-lensModel'],
   ['artist', 'b-artist'], ['copyright', 'b-copyright'], ['description', 'b-description']]
    .forEach(([k, id]) => { const el = $('#' + id); if (el && el.value.trim() !== '') textPatch[k] = el.value; });

  let shift = null, setDate = null, gpsValue = undefined;
  if (dateMode === 'shift') {
    shift = { y: +$('#b-shY').value || 0, mo: +$('#b-shMo').value || 0, d: +$('#b-shD').value || 0,
              h: +$('#b-shH').value || 0, mi: +$('#b-shMi').value || 0, s: +$('#b-shS').value || 0 };
    if (!Object.values(shift).some((v) => v)) { toast('平移量全是 0', 'err'); return; }
  } else if (dateMode === 'set') {
    setDate = inputValueToDate($('#b-setDate').value, parseInt($('#b-setSec').value, 10) || 0);
    if (!setDate) { toast('请选择要统一设置的时间', 'err'); return; }
  }
  if (gpsMode === 'set') {
    const lat = parseFloat($('#b-lat').value), lng = parseFloat($('#b-lng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { toast('请填写纬度和经度', 'err'); return; }
    gpsValue = { lat, lng };
    if ($('#b-alt').value !== '') gpsValue.alt = parseFloat($('#b-alt').value);
  } else if (gpsMode === 'copy') {
    const src = state.items.find((i) => i.id === $('#b-copySrc').value);
    const g = src && gpsOf(src);
    if (!g) { toast('所选源照片没有 GPS 信息', 'err'); return; }
    gpsValue = { lat: g.lat, lng: g.lng };
  } else if (gpsMode === 'clear') {
    gpsValue = null;
  }

  targets.forEach((item) => {
    if (removeExif) { item.patch = { removeExif: true }; return; }
    if (dateMode === 'shift') {
      const applyTo = (key) => {
        const cur = effValue(item, key);
        const d = cur == null ? null : CORE.parseExifDate(cur);
        if (d) item.patch[key] = CORE.shiftDate(d, shift);
      };
      applyTo('dtOriginal');
      if ($('#b-shiftAll').checked) { applyTo('dtModify'); applyTo('dtDigitized'); }
    } else if (dateMode === 'set') {
      item.patch.dtOriginal = new Date(setDate);
    }
    if (gpsValue !== undefined) item.patch.gps = gpsValue === null ? null : { ...gpsValue };
    Object.assign(item.patch, textPatch);
  });

  toast(`已应用到 ${targets.length} 张照片,修改保存在内存中,下载时写入`, 'ok');
  renderList();
  if (selectedItem() && targets.includes(selectedItem())) selectItem(selectedItem().id);
  renderActionBar();
}

/* ---------------- 保存与下载 ---------------- */

async function saveItem(item) {
  if (!hasPatch(item)) return { blob: item.file, name: item.name };
  let src = item.file;
  let kind = item.kind;
  if (kind === 'heic' || kind === 'avif') {
    if (!item.displayBlob) throw new Error('图像仍在解码中,请稍候重试');
    src = item.displayBlob;
    kind = 'jpeg';
  }
  let buf = new Uint8Array(await src.arrayBuffer());
  if (kind === 'jpeg' && (buf[0] !== 0xff || buf[1] !== 0xd8)) {
    // 实际不是 JPEG:借助浏览器解码后转存为 JPEG 再写入 EXIF
    try {
      const re = await reencodeToJpeg(new Blob([buf]));
      buf = new Uint8Array(await re.arrayBuffer());
    } catch (e) {
      throw new Error('该文件实际格式不是 JPEG 且无法解码,请确认图片格式');
    }
  }
  let out;
  if (kind === 'jpeg') out = CORE.jpegWithExif(buf, item.patch);
  else if (kind === 'png') out = CORE.pngWithExif(buf, item.patch);
  else if (kind === 'webp') out = CORE.webpWithExif(buf, item.patch, item.width, item.height);
  else throw new Error(`暂不支持写入 ${kind.toUpperCase()} 格式`);
  const name = kind === 'jpeg' && item.kind !== 'jpeg'
    ? item.name.replace(/\.[a-z0-9]+$/i, '') + '.jpg'
    : item.name;
  return { blob: new Blob([out], { type: MIME[kind] || 'application/octet-stream' }), name };
}

function modifiedItems() { return state.items.filter(hasPatch); }

function renderActionBar() {
  const mod = modifiedItems().length;
  $('#barInfo').innerHTML = `共 ${state.items.length} 张 · <b>${mod} 张已修改</b>(修改仅在内存中,下载时写入)`;
  $('#btnDownloadZip').disabled = mod === 0 && $('#dlScope').value === 'modified';
  $('#btnDownloadZip').textContent = $('#dlScope').value === 'modified'
    ? `📦 下载已修改 (${mod})`
    : `📦 下载全部 (${state.items.length})`;
}

async function downloadZip() {
  const scope = $('#dlScope').value;
  const list = scope === 'modified' ? modifiedItems() : state.items;
  if (!list.length) { toast('没有可下载的照片', 'err'); return; }
  busy(true, `正在写出 ${list.length} 张照片…`);
  try {
    if (list.length === 1) {
      const { blob, name } = await saveItem(list[0]);
      downloadBlob(blob, name);
    } else {
      const zip = new JSZip();
      const used = new Set();
      for (const item of list) {
        const { blob, name } = await saveItem(item);
        let n = name, i = 2;
        while (used.has(n)) { n = `(${i++})${name}`; }
        used.add(n);
        zip.file(n, blob);
      }
      const zipped = await zip.generateAsync({ type: 'blob' });
      downloadBlob(zipped, `exiffix-${new Date().toISOString().slice(0, 10)}.zip`);
    }
    toast('已开始下载', 'ok');
  } catch (e) {
    console.error(e);
    toast('写出失败:' + e.message, 'err');
  }
  busy(false);
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  const dz = $('#dropzone');
  const fi = $('#fileInput');
  dz.addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => { addFiles(fi.files); fi.value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
  // 整页拖放也接收
  ['dragover', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
  document.addEventListener('drop', (e) => { if (!e.dataTransfer) return; addFiles(e.dataTransfer.files); });
  document.addEventListener('paste', (e) => {
    if (e.clipboardData && e.clipboardData.files.length) addFiles(e.clipboardData.files);
  });

  $('#checkAll').addEventListener('change', (e) => {
    state.items.forEach((it) => { it.checked = e.target.checked; });
    renderList();
  });

  // 标签页
  $('#tabSingle').addEventListener('click', () => switchTab('single'));
  $('#tabBatch').addEventListener('click', () => switchTab('batch'));

  DATE_FIELDS.forEach(([key]) => bindDateField(key));
  TEXT_FIELDS.forEach(([key, exifKey]) => bindTextField(key, exifKey));

  ['f-lat', 'f-lng', 'f-alt'].forEach((id) => ['change', 'input'].forEach((ev) => $(`#${id}`).addEventListener(ev, () => {
    const item = selectedItem(); if (!item) return;
    const g = patchGpsFromInputs(item);
    if (g) placeMarker(g.lat, g.lng);
    else if (state.marker) { state.map.removeLayer(state.marker); state.marker = null; }
    $('#gpsHint').textContent = g ? '' : '已标记为:清除 GPS';
    afterEditChange(item);
  })));

  $('#btnSearch').addEventListener('click', searchPlace);
  $('#placeSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchPlace(); } });

  $('#btnClearGps').addEventListener('click', () => {
    const item = selectedItem(); if (!item) return;
    item.patch.gps = null;
    $('#f-lat').value = $('#f-lng').value = $('#f-alt').value = '';
    $('#gpsHint').textContent = '已标记为:清除 GPS';
    if (state.marker) { state.map.removeLayer(state.marker); state.marker = null; }
    afterEditChange(item);
  });

  $('#btnCopyShootTime').addEventListener('click', () => {
    const item = selectedItem(); if (!item) return;
    const d = CORE.parseExifDate(effValue(item, 'dtOriginal'));
    if (!d) { toast('这张照片没有拍摄时间,请先填写', 'err'); return; }
    item.patch.dtModify = new Date(d);
    item.patch.dtDigitized = new Date(d);
    selectItem(item.id);
    toast('已同步,修改在下载时写入', 'ok');
  });

  $('#f-removeExif').addEventListener('change', (e) => {
    const item = selectedItem(); if (!item) return;
    if (e.target.checked) {
      item._preRemovePatch = item.patch;
      item.patch = { removeExif: true };
      toast('已标记清除全部 EXIF(下载时生效;再点一次可取消)', 'ok');
    } else if (item.patch.removeExif) {
      item.patch = item._preRemovePatch || {};
      delete item._preRemovePatch;
    }
    selectItem(item.id);
    afterEditChange(item);
  });

  $('#btnRevert').addEventListener('click', () => {
    const item = selectedItem(); if (!item) return;
    item.patch = {};
    selectItem(item.id);
    afterEditChange(item);
    toast('已撤销这张照片的全部修改');
  });

  $('#btnDownloadOne').addEventListener('click', async () => {
    const item = selectedItem(); if (!item) return;
    busy(true, '正在写出…');
    try {
      const { blob, name } = await saveItem(item);
      downloadBlob(blob, name);
      toast('已开始下载', 'ok');
    } catch (e) { toast('写出失败:' + e.message, 'err'); }
    busy(false);
  });

  // 批量
  $('#b-dateMode').addEventListener('change', (e) => {
    $('#b-dateShift').hidden = e.target.value !== 'shift';
    $('#b-dateSet').hidden = e.target.value !== 'set';
  });
  $('#b-gpsMode').addEventListener('change', (e) => {
    $('#b-gpsSet').hidden = e.target.value !== 'set';
    $('#b-gpsCopy').hidden = e.target.value !== 'copy';
    if (e.target.value === 'copy') {
      const sel = $('#b-copySrc');
      sel.innerHTML = state.items.map((i) => {
        const g = gpsOf(i);
        return `<option value="${i.id}" ${g ? '' : 'disabled'}>${esc(i.name)}${g ? '' : '(无GPS)'}</option>`;
      }).join('');
    }
  });
  $('#btnApplyBatch').addEventListener('click', applyBatch);

  // 底部栏
  $('#dlScope').addEventListener('change', renderActionBar);
  $('#btnDownloadZip').addEventListener('click', downloadZip);
  $('#btnClearAll').addEventListener('click', () => {
    if (!confirm('确定清空全部照片?未下载的修改将丢失。')) return;
    state.items.forEach((it) => {
      if (it.blobUrl) URL.revokeObjectURL(it.blobUrl);
      if (it.displayUrl) URL.revokeObjectURL(it.displayUrl);
    });
    state.items = [];
    state.selectedId = null;
    refreshWorkspace();
    $('#emptyHint').hidden = false;
    $('#editPanel').hidden = true;
  });
}

function switchTab(which) {
  $('#tabSingle').classList.toggle('active', which === 'single');
  $('#tabBatch').classList.toggle('active', which === 'batch');
  $('#singlePane').hidden = which !== 'single';
  $('#batchPane').hidden = which !== 'batch';
}

bind();
refreshWorkspace();

/* 测试钩子(E2E 用) */
window.EXIFFIX = { state, addFiles, saveItem, hasPatch, gpsOf, decodeHeicToJpeg, applyOrientation };
