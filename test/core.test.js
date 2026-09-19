/*
 * ExifFix 核心逻辑测试:node test/core.test.js
 * 覆盖:JPEG/PNG/WebP 的 EXIF 回写、GPS 写入精度、日期、中文 UTF-8 文本、
 *       修改时保留未触碰标签、清除 EXIF。
 * test-images/photo.webp 若存在则一并测试(sips 不产 WebP,可用浏览器 canvas 生成后放入)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const core = require('../core.js');
const exifr = require('../vendor/exifr.js');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓', name); })
    .catch((e) => { failed++; console.error('  ✗', name, '\n    ', e.message); });
}

const READ_OPTS = {
  tiff: true, ifd0: true, exif: true, gps: true, interop: true,
  translateValues: true, translateKeys: true, reviveValues: true, silentErrors: true
};

function read(u8) {
  return exifr.parse(new Uint8Array(u8), READ_OPTS).then(p => p || {});
}

const PATCH = {
  dtOriginal: new Date(2020, 4, 1, 8, 30, 15),
  dtDigitized: new Date(2020, 4, 1, 8, 30, 15),
  dtModify: new Date(2026, 8, 19, 21, 0, 0),
  gps: { lat: 39.9087, lng: 116.3975, alt: 43.5 },
  make: 'Fujifilm',
  model: 'X100V',
  lensMake: 'Fujifilm',
  lensModel: '23mm F2',
  software: 'ExifFix',
  artist: '张三',
  copyright: '版权所有 © 1998',
  description: '外滩 · 1998 年的夏天'
};

async function verifyCommon(parsed, label) {
  assert.strictEqual(parsed.DateTimeOriginal.getTime(), PATCH.dtOriginal.getTime(), label + ' 拍摄时间');
  assert.strictEqual(parsed.CreateDate.getTime(), PATCH.dtDigitized.getTime(), label + ' 数字化时间');
  assert.strictEqual(parsed.ModifyDate.getTime(), PATCH.dtModify.getTime(), label + ' 修改时间');
  assert.ok(Math.abs(parsed.latitude - PATCH.gps.lat) < 1e-6, label + ' 纬度 ' + parsed.latitude);
  assert.ok(Math.abs(parsed.longitude - PATCH.gps.lng) < 1e-6, label + ' 经度 ' + parsed.longitude);
  assert.ok(Math.abs((parsed.GPSAltitude || 0) - PATCH.gps.alt) < 0.01, label + ' 海拔 ' + parsed.GPSAltitude);
  assert.strictEqual(parsed.Make, PATCH.make, label + ' Make');
  assert.strictEqual(parsed.Model, PATCH.model, label + ' Model');
  assert.strictEqual(parsed.LensModel, PATCH.lensModel, label + ' LensModel');
  assert.strictEqual(parsed.Artist, PATCH.artist, label + ' Artist(中文)');
  assert.strictEqual(parsed.ImageDescription, PATCH.description, label + ' 描述(中文)');
}

(async () => {
  console.log('JPEG');
  const jpg = new Uint8Array(fs.readFileSync(path.join(ROOT, 'test/fixtures/tiny.jpg')));

  await test('写入日期/GPS/中文文本并回读', async () => {
    const out = core.jpegWithExif(jpg, PATCH);
    await verifyCommon(await read(out), 'jpeg');
  });

  await test('修改时保留原有未触碰的标签', async () => {
    const before = await read(jpg);
    const origOrientation = before.Orientation;
    const origMake = before.Make;
    const out = core.jpegWithExif(jpg, { dtOriginal: new Date(1998, 7, 12, 6, 0, 0) });
    const after = await read(out);
    assert.strictEqual(after.DateTimeOriginal.getTime(), new Date(1998, 7, 12, 6, 0, 0).getTime());
    assert.strictEqual(after.Make, origMake, 'Make 应保留');
    assert.strictEqual(after.Orientation, origOrientation, 'Orientation 应保留');
  });

  await test('清除 GPS', async () => {
    const withGps = core.jpegWithExif(jpg, { gps: PATCH.gps });
    const cleared = core.jpegWithExif(withGps, { gps: null });
    const parsed = await read(cleared);
    assert.strictEqual(parsed.latitude, undefined, 'latitude 应已删除');
    const dict = require('../vendor/piexif.js').load(core.u8ToBinStr(cleared));
    assert.strictEqual(Object.keys(dict.GPS).length, 0, 'GPS IFD 应为空');
  });

  await test('清除全部 EXIF', async () => {
    const out = core.jpegWithExif(core.jpegWithExif(jpg, PATCH), { removeExif: true });
    const parsed = await read(out);
    assert.strictEqual(parsed.DateTimeOriginal, undefined);
    assert.strictEqual(parsed.Make, undefined);
  });

  await test('无 EXIF 的 JPEG 也能直接加 GPS + 日期', async () => {
    const stripped = core.jpegWithExif(jpg, { removeExif: true });
    const out = core.jpegWithExif(stripped, { gps: { lat: -31.9523, lng: 115.8613 }, dtOriginal: new Date(2001, 0, 1, 0, 0, 0) });
    const parsed = await read(out);
    assert.ok(Math.abs(parsed.latitude - (-31.9523)) < 1e-6, '南纬 ' + parsed.latitude);
    assert.ok(Math.abs(parsed.longitude - 115.8613) < 1e-6);
    assert.strictEqual(parsed.DateTimeOriginal.getTime(), new Date(2001, 0, 1).getTime());
  });

  console.log('PNG');
  const png = new Uint8Array(fs.readFileSync(path.join(ROOT, 'test/fixtures/tiny.png')));

  await test('PNG 写入 eXIf chunk 并回读', async () => {
    const out = core.pngWithExif(png, PATCH);
    const chunks = core.parsePngChunks(out);
    assert.ok(chunks.some(c => c.type === 'eXIf'), '应存在 eXIf chunk');
    await verifyCommon(await read(out), 'png');
  });

  await test('PNG 二次编辑保留其他标签', async () => {
    const once = core.pngWithExif(png, PATCH);
    const twice = core.pngWithExif(once, { dtOriginal: new Date(1988, 11, 25, 12, 0, 0) });
    const parsed = await read(twice);
    assert.strictEqual(parsed.Make, PATCH.make, 'Make 应保留');
    assert.strictEqual(parsed.ImageDescription, PATCH.description, '中文描述应保留');
    assert.strictEqual(parsed.DateTimeOriginal.getTime(), new Date(1988, 11, 25, 12, 0, 0).getTime());
  });

  await test('PNG 清除 EXIF(eXIf chunk 移除)', async () => {
    const out = core.pngWithExif(core.pngWithExif(png, PATCH), { removeExif: true });
    const chunks = core.parsePngChunks(out);
    assert.ok(!chunks.some(c => c.type === 'eXIf'));
    const parsed = await read(out);
    assert.strictEqual(parsed.Make, undefined);
  });

  await test('PNG 读取兜底:提取 eXIf → 字典 → 展示对象', async () => {
    const out = core.pngWithExif(png, PATCH);
    const tiff = core.extractExifTiffFromPng(out);
    assert.ok(tiff, '应能提取 eXIf chunk');
    const back = core.parsedFromDict(core.dictFromTiffBytes(tiff));
    assert.strictEqual(back.ImageDescription, PATCH.description, '中文描述');
    assert.ok(Math.abs(back.longitude - PATCH.gps.lng) < 1e-6, '经度');
    assert.strictEqual(back.Make, PATCH.make);
  });

  const webpPath = path.join(ROOT, 'test/fixtures/tiny.webp');
  if (fs.existsSync(webpPath)) {
    console.log('WebP');
    const webp = new Uint8Array(fs.readFileSync(webpPath));
    await test('WebP 写入 EXIF chunk 并回读(容器提取)', async () => {
      const out = core.webpWithExif(webp, PATCH, 64, 64);
      const tiff = core.extractExifTiffFromWebp(out);
      assert.ok(tiff, '应能提取 EXIF chunk');
      const back = core.parsedFromDict(core.dictFromTiffBytes(tiff));
      assert.strictEqual(back.DateTimeOriginal.getTime(), PATCH.dtOriginal.getTime(), '拍摄时间');
      assert.ok(Math.abs(back.latitude - PATCH.gps.lat) < 1e-6, '纬度 ' + back.latitude);
      assert.strictEqual(back.Model, PATCH.model);
      assert.strictEqual(back.ImageDescription, PATCH.description, '中文描述');
      assert.strictEqual(back.Make, PATCH.make, '未触碰字段应保留');
      assert.strictEqual(back.ModifyDate.getTime(), PATCH.dtModify.getTime());
    });
    await test('WebP 清除 EXIF', async () => {
      const withExif = core.webpWithExif(webp, PATCH, 64, 64);
      const out = core.webpWithExif(withExif, { removeExif: true }, 64, 64);
      assert.strictEqual(core.extractExifTiffFromWebp(out), null, 'EXIF chunk 应已移除');
      const chunks = core.parseWebpChunks(out);
      assert.ok(chunks.some(c => c.fourcc === 'VP8X'), 'VP8X 应保留');
      assert.strictEqual(chunks.find(c => c.fourcc === 'VP8X').data[0] & 0x08, 0, 'VP8X EXIF 标志位应清除');
    });
    await test('WebP 无 VP8X 时自动新建', async () => {
      // 手工构造一个简单格式(仅 VP8)的 WebP:RIFF 头 + VP8 chunk
      const vp8 = new Uint8Array(32);
      const dv = new DataView(vp8.buffer);
      vp8.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      dv.setUint32(4, 4 + 8 + 32, true);
      vp8.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
      vp8.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
      dv.setUint32(16, 32, true);
      const out = core.webpWithExif(vp8, { gps: { lat: 22.5 } }, 64, 64);
      const chunks = core.parseWebpChunks(out);
      assert.strictEqual(chunks[0].fourcc, 'VP8X', 'VP8X 应在最前');
      assert.strictEqual(chunks[1].fourcc, 'EXIF');
      assert.ok(chunks[0].data[0] & 0x08, 'EXIF 标志位应置上');
      assert.strictEqual(core.extractExifTiffFromWebp(out) !== null, true);
    });
  } else {
    console.log('WebP — 跳过(未找到 test/fixtures/tiny.webp)');
  }

  console.log('工具函数');
  await test('shiftDate 月份/小时进位', () => {
    // JS Date 溢出自动进位:1月31日+1个月=3月3日,23点+1小时=次日0点
    const d = core.shiftDate(new Date(1999, 0, 31, 23, 59, 0), { mo: 1, h: 1 });
    assert.strictEqual(d.getTime(), new Date(1999, 2, 4, 0, 59, 0).getTime());
  });

  await test('TIFF 字节 ↔ 字典 往返', () => {
    const dict = core.emptyDict();
    core.setGps(dict, { lat: 22.5431, lng: 114.0579, alt: 12 });
    const tiff = core.tiffBytesFromDict(dict);
    const back = core.dictFromTiffBytes(tiff);
    const lat = core.dmsRationalToDeg(back.GPS[2], back.GPS[1]);
    assert.ok(Math.abs(lat - 22.5431) < 1e-6);
  });

  await test('binStrToText UTF-8 还原', () => {
    assert.strictEqual(core.binStrToText(core.textToBinStr('照片')), '照片');
    assert.strictEqual(core.binStrToText('plain ascii'), 'plain ascii');
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
