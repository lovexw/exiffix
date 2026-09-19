/*
 * ExifFix core.js — 纯逻辑层(无 DOM 依赖),浏览器与 Node 通用。
 *
 * 职责:
 *   - 把"用户修改(patch)"应用到 EXIF 字典(piexifjs 结构)上
 *   - 三种容器的 EXIF 写入/删除:JPEG(APP1)、PNG(eXIf chunk)、WebP(EXIF chunk)
 *   - 日期/GPS/文本的工具函数
 *
 * patch 约定(只包含用户实际改动过的字段):
 *   {
 *     dtOriginal?:  Date|null,   // DateTimeOriginal,null = 删除该标签
 *     dtDigitized?: Date|null,   // DateTimeDigitized
 *     dtModify?:    Date|null,   // ModifyDate
 *     gps?:  {lat, lng, alt?}|null,  // null = 删除整个 GPS IFD
 *     make?|model?|lensMake?|lensModel?|software?|artist?|copyright?|description?: string,
 *                                // '' = 删除该标签;非 ASCII 自动按 UTF-8 字节写入
 *     removeExif?: true          // 清除全部 EXIF(其余字段忽略)
 *   }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/piexif.js'));
  } else {
    root.EXIFFIX_CORE = factory(root.piexif);
  }
})(typeof self !== 'undefined' ? self : this, function (piexif) {
  'use strict';

  var IMG = piexif.ImageIFD, EXI = piexif.ExifIFD;

  var TEXT_TAGS = {
    make: ['0th', IMG.Make],
    model: ['0th', IMG.Model],
    software: ['0th', IMG.Software],
    artist: ['0th', IMG.Artist],
    copyright: ['0th', IMG.Copyright],
    description: ['0th', IMG.ImageDescription],
    lensMake: ['Exif', EXI.LensMake],
    lensModel: ['Exif', EXI.LensModel]
  };

  // ---------- 二进制字符串工具(piexifjs 以 JS 字符串承载字节) ----------

  function u8ToBinStr(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return s;
  }

  function binStrToU8(s) {
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u;
  }

  // 文本 → UTF-8 字节的二进制字符串。piexifjs 的 Ascii 打包逐字符取
  // charCodeAt(&0xff) 落盘,先把中文编码成 UTF-8 字节流才能无损写入。
  function textToBinStr(str) {
    var bytes = new TextEncoder().encode(str);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  // piexifjs 读出的 ASCII 标签是"每字符一字节"的串;若恰好是合法 UTF-8 则还原,
  // 否则原样返回(fatal 模式保证不会误判)。
  function binStrToText(s) {
    if (!/[\x80-\xff]/.test(s)) return s;
    try {
      var bytes = new Uint8Array(s.length);
      for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return s;
    }
  }

  function ensureU8(x) {
    return x instanceof Uint8Array ? x : new Uint8Array(x);
  }

  // ---------- 日期 ----------

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function exifDateToStr(d) {
    return d.getFullYear() + ':' + pad2(d.getMonth() + 1) + ':' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function parseExifDate(str) {
    if (str instanceof Date) return isNaN(str) ? null : str;
    if (typeof str !== 'string') return null;
    var m = str.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  }

  // 批量平移:{y,mo,d,h,mi,s} 可为负;JS Date 自动处理进位
  function shiftDate(date, off) {
    return new Date(
      date.getFullYear() + (off.y || 0),
      date.getMonth() + (off.mo || 0),
      date.getDate() + (off.d || 0),
      date.getHours() + (off.h || 0),
      date.getMinutes() + (off.mi || 0),
      date.getSeconds() + (off.s || 0)
    );
  }

  // ---------- EXIF 字典操作 ----------

  function emptyDict() {
    return { '0th': {}, 'Exif': {}, 'GPS': {}, 'Interop': {}, '1st': {}, thumbnail: null };
  }

  function setText(dict, ifdName, tag, value) {
    if (value === '' || value == null) delete dict[ifdName][tag];
    else dict[ifdName][tag] = textToBinStr(String(value));
  }

  function setDate(dict, ifdName, tag, date) {
    if (date) dict[ifdName][tag] = exifDateToStr(date);
    else delete dict[ifdName][tag];
  }

  function setGps(dict, gps) {
    var g = {};
    g[piexif.GPSIFD.GPSVersionID] = [2, 3, 0, 0];
    g[piexif.GPSIFD.GPSLatitudeRef] = gps.lat < 0 ? 'S' : 'N';
    g[piexif.GPSIFD.GPSLatitude] = piexif.GPSHelper.degToDmsRational(gps.lat);
    g[piexif.GPSIFD.GPSLongitudeRef] = gps.lng < 0 ? 'W' : 'E';
    g[piexif.GPSIFD.GPSLongitude] = piexif.GPSHelper.degToDmsRational(gps.lng);
    if (Number.isFinite(gps.alt)) {
      g[piexif.GPSIFD.GPSAltitudeRef] = gps.alt < 0 ? 1 : 0;
      g[piexif.GPSIFD.GPSAltitude] = [Math.round(Math.abs(gps.alt) * 100), 100];
    }
    dict.GPS = g;
  }

  function applyPatch(dict, patch) {
    if ('dtModify' in patch) setDate(dict, '0th', IMG.DateTime, patch.dtModify);
    if ('dtOriginal' in patch) setDate(dict, 'Exif', EXI.DateTimeOriginal, patch.dtOriginal);
    if ('dtDigitized' in patch) setDate(dict, 'Exif', EXI.DateTimeDigitized, patch.dtDigitized);
    if ('gps' in patch) {
      if (patch.gps) setGps(dict, patch.gps);
      else dict.GPS = {}; // 置空,dump 时自动去掉 GPSTag 指针
    }
    for (var k in TEXT_TAGS) {
      if (k in patch) setText(dict, TEXT_TAGS[k][0], TEXT_TAGS[k][1], patch[k]);
    }
    return dict;
  }

  // 裸 TIFF 字节 ↔ 字典。piexif.load 原生支持 "Exif\0\0" 前缀输入。
  // 解析失败(或无 eXIf)返回 null,由调用方决定用空字典。
  function dictFromTiffBytes(u8) {
    try {
      return piexif.load('Exif\x00\x00' + u8ToBinStr(u8));
    } catch (e) {
      return null;
    }
  }

  function tiffBytesFromDict(dict) {
    return binStrToU8(piexif.dump(dict).slice(6)); // 去掉 "Exif\0\0" 头
  }

  // ---------- JPEG ----------

  function jpegWithExif(u8, patch) {
    var bin = u8ToBinStr(u8);
    if (patch.removeExif) return binStrToU8(piexif.remove(bin));
    var dict;
    try {
      dict = piexif.load(bin);
    } catch (e) {
      dict = emptyDict();
    }
    applyPatch(dict, patch);
    var dumped = piexif.dump(dict);
    if (dumped.length + 4 > 0xffff) {
      throw new Error('EXIF 数据超过 64KB(JPEG 格式上限),请尝试清除缩略图后重试');
    }
    return binStrToU8(piexif.insert(dumped, bin));
  }

  // ---------- PNG(eXIf chunk) ----------

  function crc32(u8) {
    if (!crc32.TABLE) {
      var t = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      crc32.TABLE = t;
    }
    var crc = 0xffffffff;
    for (var i = 0; i < u8.length; i++) crc = crc32.TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function parsePngChunks(u8) {
    u8 = ensureU8(u8);
    var sig = [137, 80, 78, 71, 13, 10, 26, 10];
    for (var i = 0; i < 8; i++) if (u8[i] !== sig[i]) throw new Error('不是有效的 PNG 文件');
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var off = 8, chunks = [];
    while (off + 12 <= u8.length) {
      var len = dv.getUint32(off);
      var type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
      chunks.push({ type: type, data: u8.slice(off + 8, off + 8 + len) });
      off += 12 + len;
    }
    return chunks;
  }

  function buildPngBytes(chunks) {
    var total = 8;
    for (var i = 0; i < chunks.length; i++) total += 12 + chunks[i].data.length;
    var out = new Uint8Array(total);
    out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
    var dv = new DataView(out.buffer);
    var off = 8;
    for (var j = 0; j < chunks.length; j++) {
      var c = chunks[j];
      dv.setUint32(off, c.data.length);
      for (var k = 0; k < 4; k++) out[off + 4 + k] = c.type.charCodeAt(k);
      out.set(c.data, off + 8);
      var crcInput = new Uint8Array(4 + c.data.length);
      for (var m = 0; m < 4; m++) crcInput[m] = out[off + 4 + m];
      crcInput.set(c.data, 4);
      dv.setUint32(off + 8 + c.data.length, crc32(crcInput));
      off += 12 + c.data.length;
    }
    return out;
  }

  function pngWithExif(u8, patch) {
    var chunks = parsePngChunks(u8);
    if (patch.removeExif) {
      return buildPngBytes(chunks.filter(function (c) { return c.type !== 'eXIf'; }));
    }
    var existing = null;
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i].type === 'eXIf') { existing = chunks[i].data; break; }
    }
    var dict = (existing && dictFromTiffBytes(existing)) || emptyDict();
    applyPatch(dict, patch);
    var tiff = tiffBytesFromDict(dict);
    var newChunk = { type: 'eXIf', data: tiff };
    for (var n = 0; n < chunks.length; n++) {
      if (chunks[n].type === 'eXIf') { chunks[n] = newChunk; return buildPngBytes(chunks); }
    }
    var ihdr = chunks.findIndex(function (c) { return c.type === 'IHDR'; });
    chunks.splice(ihdr + 1, 0, newChunk);
    return buildPngBytes(chunks);
  }

  // ---------- WebP(EXIF chunk) ----------

  function le24(arr, off, v) {
    arr[off] = v & 0xff; arr[off + 1] = (v >> 8) & 0xff; arr[off + 2] = (v >> 16) & 0xff;
  }

  function parseWebpChunks(u8) {
    u8 = ensureU8(u8);
    if (u8.length < 12 ||
        String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'RIFF' ||
        String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) !== 'WEBP') {
      throw new Error('不是有效的 WebP 文件');
    }
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var off = 12, chunks = [];
    while (off + 8 <= u8.length) {
      var fourcc = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
      var size = dv.getUint32(off + 4, true);
      chunks.push({ fourcc: fourcc, data: u8.slice(off + 8, off + 8 + size) });
      off += 8 + size + (size & 1);
    }
    return chunks;
  }

  function buildWebpBytes(chunks) {
    var payload = 4; // "WEBP"
    for (var i = 0; i < chunks.length; i++) payload += 8 + chunks[i].data.length + (chunks[i].data.length & 1);
    var total = 8 + payload;
    var out = new Uint8Array(total);
    var dv = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    dv.setUint32(4, payload, true);
    out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    var off = 12;
    for (var j = 0; j < chunks.length; j++) {
      var c = chunks[j];
      for (var k = 0; k < 4; k++) out[off + k] = c.fourcc.charCodeAt(k);
      dv.setUint32(off + 4, c.data.length, true);
      out.set(c.data, off + 8);
      off += 8 + c.data.length + (c.data.length & 1);
    }
    return out;
  }

  // width/height:原始画布尺寸,仅在需要新建 VP8X chunk 时使用
  function webpWithExif(u8, patch, width, height) {
    var chunks = parseWebpChunks(u8);
    var vp8x = null;
    for (var i = 0; i < chunks.length; i++) if (chunks[i].fourcc === 'VP8X') { vp8x = chunks[i]; break; }

    if (patch.removeExif) {
      chunks = chunks.filter(function (c) { return c.fourcc !== 'EXIF'; });
      if (vp8x) vp8x.data[0] &= ~0x08; // 清除 EXIF 标志位
      return buildWebpBytes(chunks);
    }

    var existing = null;
    for (var n = 0; n < chunks.length; n++) {
      if (chunks[n].fourcc === 'EXIF') { existing = chunks[n].data; break; }
    }
    // WebP EXIF chunk 有时带 4 字节偏移前缀,探测后跳过
    var tiffOffset = 0;
    if (existing && existing.length > 4) {
      var b = existing;
      var looksTiff = function (o) { return (b[o] === 0x49 && b[o + 1] === 0x49) || (b[o] === 0x4d && b[o + 1] === 0x4d); };
      if (!looksTiff(0) && looksTiff(4)) tiffOffset = 4;
    }
    var dict = (existing && dictFromTiffBytes(existing.subarray(tiffOffset))) || emptyDict();
    applyPatch(dict, patch);
    var tiff = tiffBytesFromDict(dict);
    var exifChunk = { fourcc: 'EXIF', data: tiff };

    var idx = chunks.indexOf(vp8x);
    if (vp8x) {
      vp8x.data[0] |= 0x08; // 置 EXIF 标志位
      for (var m = 0; m < chunks.length; m++) {
        if (chunks[m].fourcc === 'EXIF') { chunks[m] = exifChunk; return buildWebpBytes(chunks); }
      }
      chunks.splice(idx + 1, 0, exifChunk);
    } else {
      // 扩展格式必须有 VP8X:新建并声明画布尺寸与 EXIF 标志
      var flags = 0x08;
      var vx = new Uint8Array(10);
      vx[0] = flags;
      le24(vx, 4, Math.max(1, width || 1) - 1);
      le24(vx, 7, Math.max(1, height || 1) - 1);
      chunks.unshift({ fourcc: 'VP8X', data: vx });
      chunks.splice(1, 0, exifChunk);
    }
    return buildWebpBytes(chunks);
  }

  // ---------- 读取兜底:exifr 的 UMD 构建不支持 WebP 容器 ----------

  function extractExifTiffFromPng(u8) {
    var chunks = parsePngChunks(u8);
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i].type === 'eXIf') return chunks[i].data;
    }
    return null;
  }

  function extractExifTiffFromWebp(u8) {
    var chunks = parseWebpChunks(u8);
    for (var i = 0; i < chunks.length; i++) {
      if (chunks[i].fourcc === 'EXIF') {
        var data = chunks[i].data;
        // 部分写入器在 TIFF 前放了 4 字节偏移量,探测跳过
        if (data.length > 4 && data[4] === 0x49 && data[5] === 0x49) return data.subarray(4);
        if (data.length > 4 && data[4] === 0x4d && data[5] === 0x4d) return data.subarray(4);
        return data;
      }
    }
    return null;
  }

  // piexif 字典 → 与 exifr 输出同名的展示对象(app.js 两边通用)
  function parsedFromDict(dict) {
    var out = {};
    var IMG = piexif.ImageIFD, EXI = piexif.ExifIFD;
    var textMap = {
      Make: ['0th', IMG.Make], Model: ['0th', IMG.Model], Software: ['0th', IMG.Software],
      Artist: ['0th', IMG.Artist], Copyright: ['0th', IMG.Copyright],
      ImageDescription: ['0th', IMG.ImageDescription],
      LensMake: ['Exif', EXI.LensMake], LensModel: ['Exif', EXI.LensModel]
    };
    for (var k in textMap) {
      var v = dict[textMap[k][0]][textMap[k][1]];
      if (typeof v === 'string') out[k] = binStrToText(v);
    }
    var dateMap = {
      ModifyDate: ['0th', IMG.DateTime],
      DateTimeOriginal: ['Exif', EXI.DateTimeOriginal],
      CreateDate: ['Exif', EXI.DateTimeDigitized]
    };
    for (var d in dateMap) {
      var s = dict[dateMap[d][0]][dateMap[d][1]];
      if (typeof s === 'string') {
        var parsed = parseExifDate(s);
        if (parsed) out[d] = parsed;
      }
    }
    if (dict['0th'][IMG.Orientation]) out.Orientation = dict['0th'][IMG.Orientation];
    var g = dict.GPS || {};
    if (g[piexif.GPSIFD.GPSLatitude]) {
      out.latitude = piexif.GPSHelper.dmsRationalToDeg(g[piexif.GPSIFD.GPSLatitude], g[piexif.GPSIFD.GPSLatitudeRef]);
      out.longitude = piexif.GPSHelper.dmsRationalToDeg(g[piexif.GPSIFD.GPSLongitude], g[piexif.GPSIFD.GPSLongitudeRef]);
    }
    if (g[piexif.GPSIFD.GPSAltitude]) {
      var num = g[piexif.GPSIFD.GPSAltitude];
      var alt = Array.isArray(num) ? num[0] / num[1] : num;
      out.GPSAltitude = g[piexif.GPSIFD.GPSAltitudeRef] === 1 ? -alt : alt;
    }
    return out;
  }

  // ---------- 其他 ----------

  function dmsRationalToDeg(arr, ref) {
    if (!Array.isArray(arr)) return null;
    var deg = arr[0] / 1 + arr[1] / 60 + arr[2] / 3600;
    if (Array.isArray(arr[0])) {
      deg = arr[0][0] / arr[0][1] + arr[1][0] / arr[1][1] / 60 + arr[2][0] / arr[2][1] / 3600;
    }
    return (ref === 'S' || ref === 'W') ? -deg : deg;
  }

  // 十进制度 → "25°2'34.5"" 展示格式
  function degToDmsStr(deg, isLat) {
    var ref = isLat ? (deg < 0 ? 'S' : 'N') : (deg < 0 ? 'W' : 'E');
    var abs = Math.abs(deg);
    var d = Math.floor(abs);
    var minFloat = (abs - d) * 60;
    var mi = Math.floor(minFloat);
    var sec = ((minFloat - mi) * 60).toFixed(1);
    return d + '°' + mi + "′" + sec + '″' + ref;
  }

  return {
    u8ToBinStr: u8ToBinStr,
    binStrToU8: binStrToU8,
    textToBinStr: textToBinStr,
    binStrToText: binStrToText,
    exifDateToStr: exifDateToStr,
    parseExifDate: parseExifDate,
    shiftDate: shiftDate,
    emptyDict: emptyDict,
    applyPatch: applyPatch,
    setGps: setGps,
    dictFromTiffBytes: dictFromTiffBytes,
    tiffBytesFromDict: tiffBytesFromDict,
    jpegWithExif: jpegWithExif,
    pngWithExif: pngWithExif,
    webpWithExif: webpWithExif,
    parsePngChunks: parsePngChunks,
    buildPngBytes: buildPngBytes,
    parseWebpChunks: parseWebpChunks,
    buildWebpBytes: buildWebpBytes,
    extractExifTiffFromPng: extractExifTiffFromPng,
    extractExifTiffFromWebp: extractExifTiffFromWebp,
    parsedFromDict: parsedFromDict,
    crc32: crc32,
    dmsRationalToDeg: dmsRationalToDeg,
    degToDmsStr: degToDmsStr,
    TEXT_TAGS: TEXT_TAGS
  };
});
