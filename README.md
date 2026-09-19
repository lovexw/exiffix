# ExifFix · 在线照片 EXIF 编辑器

在浏览器里修正照片的 EXIF 信息:**拍摄日期、GPS 位置、相机型号、描述版权**等。专为老照片数据纠正设计——扫描仪写错的时间、缺失的拍摄地点、相机时区偏差,都可以在这里修好。

**🔒 100% 本地处理**:照片只在浏览器内存中读写,不上传到任何服务器。地图瓦片与地名搜索由 OpenStreetMap 提供(需联网),除此之外无任何网络请求。

在线地址:`https://exiffix.pages.dev`(部署后可用)

## 功能

- **日期时间**:拍摄时间(DateTimeOriginal)、数字化时间、修改时间,精确到秒;一键把拍摄时间同步到其他时间字段
- **GPS 位置**:地图点击选点(Leaflet + OpenStreetMap)、按地名搜索(Nominatim)、经纬度/海拔直接输入、DMS 度分秒显示、一键清除 GPS(保护隐私)
- **相机与文本**:厂商、机型、镜头、软件、描述、作者、版权;中文自动按 UTF-8 写入
- **批量操作**:整体平移时间(修正相机时区/扫描偏差)、统一设置时间、统一/复制/清除 GPS、统一相机信息、批量清除 EXIF
- **格式支持**:
  - JPEG — 完整读写(APP1 EXIF)
  - PNG — 读写标准 `eXIf` chunk
  - WebP — 读写标准 `EXIF` chunk(自动创建/更新 VP8X 标志位)
  - HEIC — 读取元数据,保存时转存为 JPEG(浏览器无法直接编码 HEIC)
- 写入时**只改动你修改过的字段**,其余原始标签与内嵌缩略图原样保留
- 拖放 / 多选 / Ctrl+V 粘贴,批量打包下载(.zip),可切换"仅已修改 / 全部"

## 使用

1. 打开网页,把照片拖进去(可多选)
2. 左侧选择照片,在右侧修改日期、在地图上选点、填写相机信息
3. 多张照片用「批量操作」:勾选 → 整体平移时间或统一 GPS → 应用
4. 点「下载 (.zip)」,修改在下载时写入文件

## 本地开发

```bash
npm run dev     # http://127.0.0.1:8080(禁用缓存的静态服务器)
npm test        # 核心读写逻辑单元测试(15 项)
```

无需任何构建步骤,改完刷新即生效。

## 部署到 Cloudflare Pages

纯静态站点,三种方式任选:

**方式一:GitHub Actions 自动部署(推荐,已配置好工作流)**

1. 在 Cloudflare 控制台创建 API Token(权限:`Cloudflare Pages: Edit`),记下 Account ID
2. 仓库 Settings → Secrets and variables → Actions 添加两个 Secret:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. 推送到 `main` 分支即自动部署到 Pages 项目 `exiffix`

**方式二:连接 Git 仓库**

Cloudflare 控制台 → Workers & Pages → Create → Pages → Connect to Git → 选择本仓库:
- 构建命令:留空
- 输出目录:`/`

**方式三:本地直接上传**

```bash
npx wrangler login
npx wrangler pages deploy .
```

## 目录结构

```
index.html          页面结构
styles.css          深色主题样式
app.js              界面与交互(状态、地图、批量、下载)
core.js             核心读写逻辑(JPEG/PNG/WebP 容器 + EXIF 字典,浏览器/Node 通用)
vendor/             本地化的第三方库(piexifjs、exifr、JSZip、Leaflet、heic2any 懒加载)
dev-server.mjs      本地开发服务器
test/               单元测试与固定样本
_headers            Cloudflare Pages 安全响应头
wrangler.toml       Cloudflare Pages 配置
.github/workflows/  GitHub Actions 自动部署
```

## 技术说明

- 读取:exifr(JPEG/PNG/HEIC)+ 自研 WebP 容器解析(exifr 的 UMD 构建不含 WebP)
- 写入:piexifjs(TIFF/EXIF 序列化)+ 自研 PNG `eXIf` / WebP `EXIF` chunk 读写(含 CRC32、RIFF 尺寸、VP8X 标志位)
- 文本标签按 UTF-8 字节写入(中文可正常被系统与相册软件读取),未修改标签按原字节保留
- HEIC 解码使用 heic2any,首次遇到 HEIC 文件时才加载

## 已知限制

- JPEG 的 EXIF 段有 64KB 上限(格式规范),缩略图过大的罕见文件会提示
- TIFF / RAW(CR2、NEF 等)暂不支持
- HEIC 保存时转存为 JPEG(重新编码,画质 92%)

## License

MIT
