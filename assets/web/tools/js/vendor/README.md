# 第三方依赖说明

## mediabunny-tool.min.js

在线视频压缩工具「快速模式」使用的媒体处理库（解封装 + WebCodecs 编解码调度 + MP4 封装）。

- 上游项目：**Mediabunny** — https://mediabunny.dev ｜ https://github.com/Vanilagy/mediabunny
- 版本：**1.56.2**（npm 包 `mediabunny@1.56.2`）
- 许可证：**Mozilla Public License 2.0**，完整文本见同目录 `mediabunny-LICENSE.txt`
- 文件说明：这是官方库的**裁剪打包产物**（未经修改源码，仅通过 esbuild 做 tree-shaking 与压缩）

### 为什么是裁剪版

官方完整包（`mediabunny.min.mjs`）约 657 KB。本工具只需要「读取常见视频容器 → 重新编码为 MP4」这条链路，
因此只引用了 MP4 / MOV / WebM / MKV 四种输入容器与 MP4 输出容器，其余解封装器
（MP3、FLAC、WAV、OGG、ADTS、HLS 等）在打包时被 tree-shaking 移除，体积降到 413 KB（gzip 后约 107 KB）。

### 如何重新打包

```bash
mkdir mb && cd mb && npm init -y
npm install mediabunny@1.56.2 esbuild

# entry.js 的内容见下方「打包入口」
npx esbuild entry.js --bundle --minify --format=iife --target=es2020 \
  --outfile=mediabunny-tool.min.js
```

打包入口 `entry.js`：

```js
import {
    Input, BlobSource, Output, BufferTarget, Mp4OutputFormat,
    Conversion, Quality, canEncodeVideo,
    Mp4InputFormat, QuickTimeInputFormat, WebMInputFormat, MatroskaInputFormat
} from 'mediabunny';

window.Mediabunny = {
    Input, BlobSource, Output, BufferTarget, Mp4OutputFormat,
    Conversion, Quality, canEncodeVideo,
    INPUT_FORMATS: [
        new Mp4InputFormat(), new QuickTimeInputFormat(),
        new WebMInputFormat(), new MatroskaInputFormat()
    ]
};
```

打包成 IIFE 格式（而不是 ESM），这样用普通 `<script>` 标签就能加载，不受模块脚本的跨域限制。

### 加载方式

该文件**不会**在打开页面时加载，只有在用户第一次点击「开始压缩」且选择的是快速模式时，
才由 `video-compress.html` 动态插入 `<script>` 按需加载，因此不会拖慢页面首屏。
