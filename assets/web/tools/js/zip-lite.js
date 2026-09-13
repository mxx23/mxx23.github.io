/* ==========================================================================
   极简 ZIP 打包 (assets/web/tools/js/zip-lite.js)

   为什么不用现成库：本站在线工具都是"零依赖、可离线、能直接双击打开"的静态页面，
   而目录比较后需要把合并结果导出成一个压缩包。ZIP 的格式足够简单，
   自己写一份反而比引入几百 KB 的库更合适。

   支持：
     - DEFLATE（用浏览器内置 CompressionStream('deflate-raw')，压缩后反而变大时自动改存）
     - UTF-8 文件名（通用位标记 bit 11）
     - 空目录占位项
     - CRC-32 校验、中央目录、EOCD
   不支持（会明确报错，而不是悄悄产出坏包）：
     - Zip64（超过 4 GB 或 65535 个条目）
     - 加密、分卷

   对外：ZipLite.create(entries) -> Uint8Array
         entries: [{ path, data: Uint8Array|null, mtime: Date|number|null }]
   ========================================================================== */
(function (global) {
    'use strict';

    var MAX_ENTRIES = 65535;
    var MAX_TOTAL = 0xFFFFFFFF;

    /* ------------------------------------------------------------ CRC-32 */
    var CRC_TABLE = (function () {
        var table = new Int32Array(256);
        for (var i = 0; i < 256; i++) {
            var c = i;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[i] = c;
        }
        return table;
    })();

    function crc32(bytes, seed) {
        var c = (seed == null ? 0 : seed) ^ (-1);
        for (var i = 0; i < bytes.length; i++) {
            c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xFF];
        }
        return (c ^ (-1)) >>> 0;
    }

    /* ------------------------------------------------------------ 小工具 */
    function utf8(str) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
        /* 兜底：手工编码（现代浏览器都有 TextEncoder，这里只是保险） */
        var out = [];
        for (var i = 0; i < str.length; i++) {
            var c = str.charCodeAt(i);
            if (c < 0x80) out.push(c);
            else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
            else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return new Uint8Array(out);
    }

    function dosDateTime(ms) {
        var d = ms == null ? new Date() : new Date(ms);
        if (isNaN(d.getTime())) d = new Date();
        var y = d.getFullYear();
        if (y < 1980) { y = 1980; }
        if (y > 2107) { y = 2107; }
        var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
        var date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
        return { time: time & 0xFFFF, date: date & 0xFFFF };
    }

    function canDeflate() {
        return typeof CompressionStream === 'function' && typeof Blob === 'function' &&
            typeof Response === 'function';
    }

    function deflateRaw(bytes) {
        var cs = new CompressionStream('deflate-raw');
        var stream = new Blob([bytes]).stream().pipeThrough(cs);
        return new Response(stream).arrayBuffer().then(function (buf) {
            return new Uint8Array(buf);
        });
    }

    /* ------------------------------------------------------------ 写字节 */
    function Writer() {
        this.chunks = [];
        this.size = 0;
    }
    Writer.prototype.u16 = function (v) {
        this.chunks.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF]));
        this.size += 2;
    };
    Writer.prototype.u32 = function (v) {
        v = v >>> 0;
        this.chunks.push(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]));
        this.size += 4;
    };
    Writer.prototype.raw = function (bytes) {
        if (bytes && bytes.length) { this.chunks.push(bytes); this.size += bytes.length; }
    };
    Writer.prototype.concat = function () {
        var out = new Uint8Array(this.size);
        var at = 0;
        for (var i = 0; i < this.chunks.length; i++) {
            out.set(this.chunks[i], at);
            at += this.chunks[i].length;
        }
        return out;
    };

    /* ------------------------------------------------------------ 主流程 */
    /* entries: [{ path, data, mtime }]，path 用 '/' 分隔；data 为 null 表示空目录
       约定：任何输入问题都以 reject 的形式报告，绝不同步抛出，
       这样调用方统一用 .catch() 就能兜住 */
    function create(entries) {
        try {
            return createInner(entries);
        } catch (e) {
            return Promise.reject(e);
        }
    }

    function createInner(entries) {
        entries = entries || [];
        if (entries.length > MAX_ENTRIES) {
            return Promise.reject(new Error('条目太多（' + entries.length + ' 个），ZIP 格式上限是 ' + MAX_ENTRIES + ' 个'));
        }
        var prepared = [];
        var totalBytes = 0;
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var path = String(e.path == null ? '' : e.path).replace(/\\/g, '/').replace(/^\/+/, '');
            if (!path) return Promise.reject(new Error('第 ' + (i + 1) + ' 个条目缺少路径'));
            var isDir = e.data == null;
            if (isDir && path.charAt(path.length - 1) !== '/') path += '/';
            var data = isDir ? new Uint8Array(0) : toBytes(e.data);
            totalBytes += data.length;
            if (totalBytes > MAX_TOTAL) {
                return Promise.reject(new Error('总数据超过 4 GB，ZIP 需要 Zip64 格式，本工具暂不支持'));
            }
            prepared.push({ path: path, data: data, isDir: isDir, mtime: e.mtime });
        }
        var deflateOk = canDeflate();
        return Promise.all(prepared.map(function (p) {
            if (p.isDir || !deflateOk || p.data.length < 64) {
                return Promise.resolve({ method: 0, body: p.data, crc: crc32(p.data) });
            }
            return deflateRaw(p.data).then(function (packed) {
                if (packed.length < p.data.length) {
                    return { method: 8, body: packed, crc: crc32(p.data) };
                }
                return { method: 0, body: p.data, crc: crc32(p.data) };
            }, function () {
                /* 压缩失败就退回存储，不让整个导出中断 */
                return { method: 0, body: p.data, crc: crc32(p.data) };
            });
        })).then(function (parts) {
            var w = new Writer();
            var central = [];
            for (var i = 0; i < prepared.length; i++) {
                var p = prepared[i], part = parts[i];
                var nameBytes = utf8(p.path);
                var dt = dosDateTime(p.mtime);
                var offset = w.size;
                /* 本地文件头 */
                w.u32(0x04034B50);
                w.u16(20);                  /* 解压所需版本 2.0 */
                w.u16(0x0800);              /* 通用位标记：文件名为 UTF-8 */
                w.u16(part.method);
                w.u16(dt.time);
                w.u16(dt.date);
                w.u32(part.crc);
                w.u32(part.body.length);
                w.u32(p.data.length);
                w.u16(nameBytes.length);
                w.u16(0);
                w.raw(nameBytes);
                w.raw(part.body);
                central.push({
                    nameBytes: nameBytes, method: part.method, time: dt.time, date: dt.date,
                    crc: part.crc, comp: part.body.length, uncomp: p.data.length,
                    offset: offset, isDir: p.isDir
                });
            }
            var cdStart = w.size;
            for (var j = 0; j < central.length; j++) {
                var c = central[j];
                w.u32(0x02014B50);
                w.u16(20);                  /* 创建版本 */
                w.u16(20);                  /* 解压所需版本 */
                w.u16(0x0800);
                w.u16(c.method);
                w.u16(c.time);
                w.u16(c.date);
                w.u32(c.crc);
                w.u32(c.comp);
                w.u32(c.uncomp);
                w.u16(c.nameBytes.length);
                w.u16(0);                   /* extra */
                w.u16(0);                   /* comment */
                w.u16(0);                   /* 起始磁盘 */
                w.u16(0);                   /* 内部属性 */
                w.u32(c.isDir ? 0x10 : 0);  /* 外部属性：目录位 */
                w.u32(c.offset);
                w.raw(c.nameBytes);
            }
            var cdSize = w.size - cdStart;
            /* 中央目录结束记录 */
            w.u32(0x06054B50);
            w.u16(0);
            w.u16(0);
            w.u16(central.length);
            w.u16(central.length);
            w.u32(cdSize);
            w.u32(cdStart);
            w.u16(0);
            return w.concat();
        });
    }

    function toBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        if (typeof data === 'string') return utf8(data);
        if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        throw new Error('不支持的数据类型');
    }

    var api = { create: create, crc32: crc32, utf8: utf8, deflateRaw: deflateRaw, canDeflate: canDeflate };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof global !== 'undefined') global.ZipLite = api;
})(typeof window !== 'undefined' ? window : globalThis);
