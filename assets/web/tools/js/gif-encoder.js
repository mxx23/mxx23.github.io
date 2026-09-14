/* ==========================================================================
   GIF 编码器 (assets/web/tools/js/gif-encoder.js)

   纯 JavaScript，无任何依赖：把若干帧 RGBA 像素合成为一个 GIF89a 动图。
   全部在浏览器本地完成，不上传任何数据。

   能力：
     - 多帧动画，逐帧延迟，无限循环或指定次数
     - 全局调色板（所有帧共用 256 色）或逐帧局部调色板
     - 中位切分（median cut）色彩量化，可选色深
     - 透明度（GIF 只支持二值透明，按 alpha 阈值判断）
     - 逐帧尺寸不同时自动改用局部调色板

   用法：
     var enc = new GifEncoder({ width: 320, height: 240, loop: 0, delay: 100, colors: 256 })
     enc.addFrame(imageData, { delay: 100 })
     var blob = enc.finish()      // -> Blob('image/gif')

   GIF 格式要点（GIF89a）：
     Header(6) + LogicalScreenDescriptor(7) + [GlobalColorTable] +
     重复 { [Netscape loop 扩展 (第一帧前插入一次)] GraphicControlExtension(8) +
            ImageDescriptor(10) + [LocalColorTable] + LZW 最小码长 + 数据子块 } + Trailer(0x3B)
   ========================================================================== */
(function (global) {
    'use strict';

    /* ------------------------------------------------------------ 字节写入器 */
    function Writer() {
        this.buf = new Uint8Array(1 << 16);
        this.len = 0;
    }
    Writer.prototype.need = function (n) {
        if (this.len + n <= this.buf.length) return;
        var size = this.buf.length;
        while (size < this.len + n) size *= 2;
        var next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.len));
        this.buf = next;
    };
    Writer.prototype.u8 = function (v) { this.need(1); this.buf[this.len++] = v & 0xFF; };
    Writer.prototype.u16 = function (v) {
        this.need(2);
        this.buf[this.len++] = v & 0xFF;
        this.buf[this.len++] = (v >> 8) & 0xFF;
    };
    Writer.prototype.ascii = function (s) {
        this.need(s.length);
        for (var i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xFF;
    };
    Writer.prototype.bytes = function (arr) {
        this.need(arr.length);
        this.buf.set(arr, this.len);
        this.len += arr.length;
    };
    Writer.prototype.result = function () { return this.buf.subarray(0, this.len); };

    /* ------------------------------------------------------------ LZW 压缩 */
    /** 按 GIF 规范压缩索引数据，返回若干 255 字节以内的数据子块 */
    function lzwEncode(indices, minCodeSize) {
        var clearCode = 1 << minCodeSize;
        var endCode = clearCode + 1;

        /* 初始码长至少 2 位（GIF 规定最小码长下限为 2） */
        var codeSize = Math.max(2, minCodeSize + 1);
        var maxCode = 1 << codeSize;

        /* 字典用 Map：键 = (前缀码 << 8) | 当前字节，避免字符串拼接开销 */
        var dict = new Map();
        var dictSize = endCode + 1;      /* 下一个可用的码字 */

        /* 位打包（GIF 位序为低位在前） */
        var out = [];
        var cur = 0, curBits = 0;
        var block = new Uint8Array(255), blockLen = 0;

        function flushBlock() {
            if (blockLen === 0) return;
            out.push(blockLen);
            for (var i = 0; i < blockLen; i++) out.push(block[i]);
            blockLen = 0;
        }
        function emit(code) {
            /* 关键：必须把码值截断到当前码长。
               cur 在高位可能残留上一个字节移下来的脏位，不截断会把它们混进流里。 */
            cur |= (code & ((1 << codeSize) - 1)) << curBits;
            curBits += codeSize;
            while (curBits >= 8) {
                block[blockLen++] = cur & 0xFF;
                cur >>>= 8;
                curBits -= 8;
                if (blockLen === 255) flushBlock();
            }
        }

        emit(clearCode);

        if (indices.length === 0) {
            emit(endCode);
        } else {
            var token = indices[0];
            for (var i = 1; i < indices.length; i++) {
                var k = indices[i];
                var key = (token << 8) | k;
                var found = dict.get(key);
                if (found !== undefined) {
                    token = found;
                    continue;
                }
                emit(token);

                if (dictSize < 4096) {
                    dict.set(key, dictSize);
                    dictSize++;
                    /* 码长增长：只要下一个待分配码字已经放不进当前位宽，就立刻加宽。
                       这样任何时刻发射的码都一定 <= 2^codeSize - 1。
                       解码端用同样的规则（在其字典长度超过 maxCode 时加宽），两边严格同步。 */
                    if (dictSize > maxCode && codeSize < 12) {
                        codeSize++;
                        maxCode = 1 << codeSize;
                    }
                } else {
                    /* 12 位码空间用满：先让解码端重置字典，再继续 */
                    emit(clearCode);
                    dict.clear();
                    dictSize = endCode + 1;
                    codeSize = Math.max(2, minCodeSize + 1);
                    maxCode = 1 << codeSize;
                }
                token = k;
            }
            emit(token);
            emit(endCode);
        }

        /* 收尾：补齐残余位并输出 */
        if (curBits > 0) {
            block[blockLen++] = cur & 0xFF;
            if (blockLen === 255) flushBlock();
        }
        flushBlock();
        return out;
    }

    /* --------------------------------------------------------- 色彩量化 */
    /**
     * 中位切分量化：从所有帧采样，给出全局调色板。
     * 返回 { palette: [[r,g,b],...], transparentIndex: number|-1, hasAlpha: boolean }
     */
    function quantize(frames, colorCount, alphaThreshold) {
        /* 1) 采样并统计：5-5-5 直方图，最多 32768 个格子 */
        var hist = new Uint32Array(32768);
        var sumR = new Float64Array(32768), sumG = new Float64Array(32768), sumB = new Float64Array(32768);
        var hasAlpha = false;
        var totalOpaque = 0;
        var step = 1;

        /* 采样步长：控制在 ~40 万个采样点以内，保证速度 */
        var totalPixels = 0;
        for (var f = 0; f < frames.length; f++) totalPixels += frames[f].data.length >> 2;
        if (totalPixels > 400000) step = Math.ceil(totalPixels / 400000);

        for (f = 0; f < frames.length; f++) {
            var d = frames[f].data;
            var n = d.length >> 2;
            for (var p = 0; p < n; p += step) {
                var o = p << 2;
                var a = d[o + 3];
                if (a < alphaThreshold) { hasAlpha = true; continue; }
                var r = d[o], g = d[o + 1], b = d[o + 2];
                var idx = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                hist[idx]++;
                sumR[idx] += r; sumG[idx] += g; sumB[idx] += b;
                totalOpaque++;
            }
        }

        /* 2) 收集有像素的格子 */
        var boxes = [];
        for (var i = 0; i < 32768; i++) {
            if (hist[i] === 0) continue;
            var c = hist[i];
            boxes.push({
                count: c,
                rMin: 255, rMax: 0, gMin: 255, gMax: 0, bMin: 255, bMax: 0,
                sr: sumR[i], sg: sumG[i], sb: sumB[i],
                r: sumR[i] / c, g: sumG[i] / c, b: sumB[i] / c,
                /* 这个格子在 5-5-5 空间里的坐标，用于精确计算分裂范围 */
                key: i,
                first: true
            });
        }

        /* 桶用「格子索引 + 该格子的颜色范围」表示，这里简化为按格子中心做分裂 */
        var buckets = [];
        if (boxes.length) {
            var all = { count: 0, cells: boxes };
            for (i = 0; i < boxes.length; i++) all.count += boxes[i].count;
            buckets.push(all);
        }

        var maxColors = colorCount - (hasAlpha ? 1 : 0);
        if (maxColors < 1) maxColors = 1;

        /* 3) 反复分裂最大方差的桶 */
        while (buckets.length < maxColors) {
            /* 找出像素最多、且还能分裂的桶 */
            var pick = -1, pickScore = -1;
            for (i = 0; i < buckets.length; i++) {
                if (buckets[i].cells.length < 2) continue;
                var score = buckets[i].count * variance(buckets[i]);
                if (score > pickScore) { pickScore = score; pick = i; }
            }
            if (pick < 0) break;

            var bucket = buckets[pick];
            var ch = widestChannel(bucket);
            bucket.cells.sort(function (a, b) { return a[ch] - b[ch]; });

            /* 按像素数中位切分 */
            var half = bucket.count / 2, acc = 0, cut = 1;
            for (var k = 0; k < bucket.cells.length - 1; k++) {
                acc += bucket.cells[k].count;
                if (acc >= half) { cut = k + 1; break; }
            }
            var left = bucket.cells.slice(0, cut);
            var right = bucket.cells.slice(cut);
            if (!left.length || !right.length) break;

            var lc = 0, rc = 0;
            for (k = 0; k < left.length; k++) lc += left[k].count;
            for (k = 0; k < right.length; k++) rc += right[k].count;
            buckets.splice(pick, 1, { count: lc, cells: left }, { count: rc, cells: right });
        }

        /* 4) 每个桶取加权平均色作为调色板项 */
        var palette = [];
        for (i = 0; i < buckets.length; i++) {
            var b2 = buckets[i], tr = 0, tg = 0, tb = 0, tc = 0;
            for (k = 0; k < b2.cells.length; k++) {
                var cell = b2.cells[k];
                tr += cell.sr; tg += cell.sg; tb += cell.sb; tc += cell.count;
            }
            if (tc === 0) continue;
            palette.push([
                Math.min(255, Math.round(tr / tc)),
                Math.min(255, Math.round(tg / tc)),
                Math.min(255, Math.round(tb / tc))
            ]);
        }
        if (!palette.length) palette.push([0, 0, 0]);

        var transparentIndex = -1;
        if (hasAlpha) {
            transparentIndex = palette.length;
            palette.push([0, 0, 0]);   /* 占位；配合 disposal=2 让透明区域露出背景 */
        }

        /* 5) 调色板大小补齐到 2 的幂 */
        var size = 2;
        while (size < palette.length) size *= 2;
        while (palette.length < size) palette.push([0, 0, 0]);

        return { palette: palette, transparentIndex: transparentIndex, hasAlpha: hasAlpha, backgroundIndex: 0 };
    }

    function variance(bucket) {
        var cells = bucket.cells;
        if (!cells.length) return 0;
        var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            if (c.r < rMin) rMin = c.r;
            if (c.r > rMax) rMax = c.r;
            if (c.g < gMin) gMin = c.g;
            if (c.g > gMax) gMax = c.g;
            if (c.b < bMin) bMin = c.b;
            if (c.b > bMax) bMax = c.b;
        }
        return (rMax - rMin) + (gMax - gMin) + (bMax - bMin);
    }

    function widestChannel(bucket) {
        var cells = bucket.cells;
        var rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
        for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            if (c.r < rMin) rMin = c.r;
            if (c.r > rMax) rMax = c.r;
            if (c.g < gMin) gMin = c.g;
            if (c.g > gMax) gMax = c.g;
            if (c.b < bMin) bMin = c.b;
            if (c.b > bMax) bMax = c.b;
        }
        var dr = rMax - rMin, dg = gMax - gMin, db = bMax - bMin;
        if (dr >= dg && dr >= db) return 'r';
        if (dg >= db) return 'g';
        return 'b';
    }

    /* ------------------------------------------------- 像素 -> 调色板索引 */
    function makeIndexer(palette, transparentIndex, alphaThreshold) {
        /* 缓存：5-5-5 空间 -> 调色板索引，避免重复的最近色搜索 */
        var cache = new Int16Array(32768).fill(-1);
        var n = palette.length;
        var lastOpaque = transparentIndex === 0 ? 1 : 0;
        var pal = palette;

        return function (r, g, b, a) {
            if (a < alphaThreshold && transparentIndex >= 0) return transparentIndex;
            var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            var hit = cache[key];
            if (hit >= 0) return hit;

            var best = -1, bestDist = Infinity;
            for (var i = 0; i < n; i++) {
                if (i === transparentIndex) continue;
                var dr = r - pal[i][0], dg = g - pal[i][1], db = b - pal[i][2];
                var dist = dr * dr + dg * dg + db * db;
                if (dist < bestDist) { bestDist = dist; best = i; if (dist === 0) break; }
            }
            if (best < 0) best = lastOpaque;
            cache[key] = best;
            return best;
        };
    }

    /* ------------------------------------------------------------ 编码器 */
    function GifEncoder(opts) {
        opts = opts || {};
        this.loop = typeof opts.loop === 'number' ? opts.loop : 0;          /* 0 = 无限循环 */
        this.defaultDelay = typeof opts.delay === 'number' ? opts.delay : 100; /* 单位：10ms（GIF 的时间精度） */
        this.colors = opts.colors || 256;
        this.alphaThreshold = typeof opts.alphaThreshold === 'number' ? opts.alphaThreshold : 128;
        this.background = opts.background || null;   /* [r,g,b] 时先铺底色，用于不透明背景 */
        this.sampleStep = opts.sampleStep || 1;      /* 大于 1 时输出像素做抽样（加速预览） */
        this.frames = [];
    }

    /**
     * 添加一帧。data 支持：
     *   - ImageData（{ data, width, height }）
     *   - { data: Uint8ClampedArray, width, height }
     * 所有帧的宽高必须一致（调用方负责缩放）。
     */
    GifEncoder.prototype.addFrame = function (image, options) {
        options = options || {};
        var w = image.width, h = image.height;
        var d = image.data;
        if (!w || !h || !d || d.length < w * h * 4) {
            throw new Error('帧数据不合法：需要 width/height 和 RGBA 数据');
        }
        this.frames.push({
            data: d,
            width: w,
            height: h,
            delay: typeof options.delay === 'number' ? options.delay : this.defaultDelay
        });
        return this;
    };

    /** 编码并返回 Blob。耗时较长，调用方应分片执行以保持界面响应 */
    GifEncoder.prototype.finish = function () {
        if (!this.frames.length) throw new Error('没有可编码的帧');

        var frames = this.frames;
        var w = frames[0].width, h = frames[0].height;
        var sameSize = frames.every(function (f) { return f.width === w && f.height === h; });

        var wtr = new Writer();
        var self = this;

        /* --- 量化：尺寸一致时做全局调色板；否则每帧各做一份局部调色板 --- */
        var global = null;
        var locals = null;
        if (sameSize) {
            global = quantize(frames, this.colors, this.alphaThreshold);
        } else {
            locals = frames.map(function (f) { return quantize([f], self.colors, self.alphaThreshold); });
        }

        /* --- Header + Logical Screen Descriptor --- */
        wtr.ascii('GIF89a');
        wtr.u16(w);
        wtr.u16(h);

        var ref = global || locals[0];
        var tableSizeField = Math.round(Math.log(ref.palette.length) / Math.LN2) - 1;
        var packed = 0x80 | (tableSizeField & 0x07);   /* 有全局调色板 + 色表大小 */
        packed |= 0x70;                                 /* 颜色深度：8 位/通道 */
        wtr.u8(packed);
        wtr.u8(ref.backgroundIndex || 0);
        wtr.u8(0);                                      /* 像素宽高比 */

        if (global) writeColorTable(wtr, global.palette);

        /* --- Netscape 循环扩展（必须在第一帧的图像数据之前） --- */
        wtr.u8(0x21); wtr.u8(0xFF); wtr.u8(0x0B);
        wtr.ascii('NETSCAPE2.0');
        wtr.u8(0x03); wtr.u8(0x01);
        wtr.u16(this.loop);
        wtr.u8(0x00);

        /* --- 逐帧输出 --- */
        for (var i = 0; i < frames.length; i++) {
            var frame = frames[i];
            var q = global || locals[i];
            var indexer = makeIndexer(q.palette, q.transparentIndex, this.alphaThreshold);

            /* 逐像素映射到调色板索引 */
            var count = frame.width * frame.height;
            var indices = new Uint8Array(count);
            var d = frame.data;
            for (var p = 0; p < count; p++) {
                var o = p << 2;
                indices[p] = indexer(d[o], d[o + 1], d[o + 2], d[o + 3]);
            }

            /* Graphic Control Extension */
            wtr.u8(0x21); wtr.u8(0xF9); wtr.u8(0x04);
            var disposal = q.transparentIndex >= 0 ? 2 : 1;   /* 有透明则每帧先恢复背景 */
            var gcePacked = (disposal << 2) | (q.transparentIndex >= 0 ? 1 : 0);
            wtr.u8(gcePacked);
            wtr.u16(Math.max(1, Math.round(frame.delay)));
            wtr.u8(q.transparentIndex >= 0 ? q.transparentIndex : 0);
            wtr.u8(0x00);

            /* Image Descriptor */
            wtr.u8(0x2C);
            wtr.u16(0); wtr.u16(0);
            wtr.u16(frame.width); wtr.u16(frame.height);
            if (global) {
                wtr.u8(0x00);                                  /* 无局部色表、非交错 */
            } else {
                var lsize = Math.round(Math.log(q.palette.length) / Math.LN2) - 1;
                wtr.u8(0x80 | (lsize & 0x07));
                writeColorTable(wtr, q.palette);
            }

            /* LZW 数据 */
            var minCodeSize = Math.max(2, Math.round(Math.log(q.palette.length) / Math.LN2));
            wtr.u8(minCodeSize);
            var blocks = lzwEncode(indices, minCodeSize);
            for (var b = 0; b < blocks.length; b++) wtr.u8(blocks[b]);
            wtr.u8(0x00);                                      /* 子块结束 */
        }

        wtr.u8(0x3B);                                          /* Trailer */
        return new Blob([wtr.result()], { type: 'image/gif' });
    };

    function writeColorTable(wtr, palette) {
        for (var i = 0; i < palette.length; i++) {
            wtr.u8(palette[i][0]);
            wtr.u8(palette[i][1]);
            wtr.u8(palette[i][2]);
        }
    }

    /* 便于测试：暴露内部函数 */
    global.GifEncoder = GifEncoder;
    global.GifEncoderInternals = {
        lzwEncode: lzwEncode,
        quantize: quantize,
        makeIndexer: makeIndexer
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { GifEncoder: GifEncoder, lzwEncode: lzwEncode, quantize: quantize };
    }
})(typeof window !== 'undefined' ? window : globalThis);
