/* ==========================================================================
   差异比较核心算法 (assets/web/tools/js/diff-core.js)

   纯计算模块：不依赖 DOM，也不碰文件系统，因此可以在 Node 里直接跑测试。
   对外提供：
     DiffCore.splitLines(text)              文本 → 行对象数组（保留行尾，可无损还原）
     DiffCore.joinLines(lines)              行对象数组 → 文本
     DiffCore.dominantEOL(lines)            占多数的行尾符
     DiffCore.normalizeKeys(lines, opts)    行 → 比较键（应用忽略规则）
     DiffCore.diffKeys(aKeys, bKeys, opts)  比较键序列 → 差异块
     DiffCore.blocksToRows(blocks, opts)    差异块 → 渲染行（含折叠的上下文间隙）
     DiffCore.diffTokens(a, b)              行内词级差异
     DiffCore.blockStats(blocks)            统计
     DiffCore.buildTree(left, right)        目录条目 → 比较树
     DiffCore.diff2/3 用的都是 Myers 线性空间算法

   设计要点：
     - 行尾符单独保存，复制差异时能做到逐字节还原；
     - 比较前先把每行"内化"成整数 id，Myers 内层循环只比较数字，
       几十万行也不会退化成字符串比较；
     - 内层步数有预算上限，超预算的极端文件会退化成"整块替换"，
       并把这个事实报告给调用方（workOver），不假装结果是最小差异。
   ========================================================================== */
(function (global) {
    'use strict';

    var WORK_LIMIT = 60e6;      // 单次比较的内层步数预算
    var MAX_DEPTH = 400;        // 递归深度保险丝

    /* ------------------------------------------------------------ 行切分 */
    /* 返回 [{ text, eol }]，text 不含行尾符，eol 为 '' / '\n' / '\r\n' / '\r'
       不变式：joinLines(splitLines(s)) === s  （空文本、无结尾换行、混合行尾都成立） */
    function splitLines(text) {
        var lines = [];
        var n = text.length;
        var start = 0;
        var i = 0;
        while (i < n) {
            var c = text.charCodeAt(i);
            if (c === 10 || c === 13) {
                var eol = '\n';
                if (c === 13) eol = (i + 1 < n && text.charCodeAt(i + 1) === 10) ? '\r\n' : '\r';
                lines.push({ text: text.slice(start, i), eol: eol });
                i += eol.length;
                start = i;
            } else {
                i++;
            }
        }
        if (start < n) lines.push({ text: text.slice(start), eol: '' });
        return lines;
    }

    function joinLines(lines) {
        var out = '';
        for (var i = 0; i < lines.length; i++) out += lines[i].text + lines[i].eol;
        return out;
    }

    /* 只取行文本，丢掉行尾（导出"规范化副本"时用） */
    function plainText(lines, eol) {
        var e = eol == null ? '\n' : eol;
        var out = [];
        for (var i = 0; i < lines.length; i++) out.push(lines[i].text);
        return out.length ? out.join(e) + e : '';
    }

    /* 统计占多数的行尾符；全都没有行尾时返回 '\n' */
    function dominantEOL(lines) {
        var cnt = { '\n': 0, '\r\n': 0, '\r': 0 };
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].eol) cnt[lines[i].eol] = (cnt[lines[i].eol] || 0) + 1;
        }
        var best = '\n', bestN = -1;
        for (var k in cnt) if (cnt[k] > bestN) { bestN = cnt[k]; best = k; }
        return best;
    }

    /* ------------------------------------------------------------ 忽略规则 */
    /* opts: { ignoreCase, ignoreEOL, ignoreTrailingWS, ignoreAllWS }
       返回与 lines 等长的字符串数组，作为 Myers 的比较键 */
    function normalizeKeys(lines, opts) {
        opts = opts || {};
        var keys = new Array(lines.length);
        var trailing = /[ \t\u3000]+$/;
        for (var i = 0; i < lines.length; i++) {
            var t = lines[i].text;
            if (opts.ignoreTrailingWS) t = t.replace(trailing, '');
            if (opts.ignoreAllWS) t = t.replace(/\s+/g, '');
            if (opts.ignoreCase) t = t.toLowerCase();
            if (!opts.ignoreEOL) t = t + '\u0000' + lines[i].eol;
            keys[i] = t;
        }
        return keys;
    }

    /* ------------------------------------------------------------ Myers 差分 */
    /* 把字符串数组内化成共用一张表的整数 id */
    function internIds(keys, map) {
        var out = new Int32Array(keys.length);
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var v = map.get(k);
            if (v === undefined) { v = map.size; map.set(k, v); }
            out[i] = v;
        }
        return out;
    }

    function pushOp(ops, t, n) {
        if (n <= 0) return;
        var last = ops.length ? ops[ops.length - 1] : null;
        if (last && last.t === t) last.n += n;
        else ops.push({ t: t, n: n });
    }

    /* 预算用尽 / 太深时的退路：左边全删、右边全增 */
    function pushCoarse(ops, na, nb) {
        pushOp(ops, -1, na);
        pushOp(ops, 1, nb);
    }

    /* 中间蛇：把问题切成两半，保证线性空间 */
    function bisect(a, a0, a1, b, b0, b1, wk) {
        var N = a1 - a0, M = b1 - b0;
        var maxD = (N + M + 1) >> 1;
        var delta = N - M;
        var odd = (delta & 1) !== 0;
        var off = maxD + 1;
        var size = 2 * maxD + 2;
        var vf = new Int32Array(size);
        var vb = new Int32Array(size);
        vf[off + 1] = 0;
        vb[off + 1] = 0;
        for (var d = 0; d <= maxD; d++) {
            wk.steps += 2 * d + 2;
            if (wk.steps > wk.limit) { wk.over = true; return null; }
            var k, x, y;
            for (k = -d; k <= d; k += 2) {
                if (k === -d || (k !== d && vf[off + k - 1] < vf[off + k + 1])) x = vf[off + k + 1];
                else x = vf[off + k - 1] + 1;
                y = x - k;
                while (x < N && y < M && a[a0 + x] === b[b0 + y]) { x++; y++; }
                vf[off + k] = x;
                if (odd && (k - delta) >= -(d - 1) && (k - delta) <= (d - 1)) {
                    if (x + vb[off + delta - k] >= N) return { x: a0 + x, y: b0 + y };
                }
            }
            for (k = -d; k <= d; k += 2) {
                if (k === -d || (k !== d && vb[off + k - 1] < vb[off + k + 1])) x = vb[off + k + 1];
                else x = vb[off + k - 1] + 1;
                y = x - k;
                while (x < N && y < M && a[a1 - 1 - x] === b[b1 - 1 - y]) { x++; y++; }
                vb[off + k] = x;
                if (!odd && (k - delta) >= -d && (k - delta) <= d) {
                    if (x + vf[off + delta - k] >= N) return { x: a1 - x, y: b1 - y };
                }
            }
        }
        return null;
    }

    function rec(a, a0, a1, b, b0, b1, ops, depth, wk) {
        if (wk.over) { pushCoarse(ops, a1 - a0, b1 - b0); return; }
        var pre = 0;
        while (a0 + pre < a1 && b0 + pre < b1 && a[a0 + pre] === b[b0 + pre]) pre++;
        var suf = 0;
        while (a1 - suf - 1 >= a0 + pre && b1 - suf - 1 >= b0 + pre &&
            a[a1 - suf - 1] === b[b1 - suf - 1]) suf++;
        if (pre) pushOp(ops, 0, pre);
        var la = a0 + pre, ra = a1 - suf, lb = b0 + pre, rb = b1 - suf;
        var na = ra - la, nb = rb - lb;
        if (na === 0) {
            pushOp(ops, 1, nb);
        } else if (nb === 0) {
            pushOp(ops, -1, na);
        } else if (depth > MAX_DEPTH) {
            pushCoarse(ops, na, nb);
        } else {
            var m = bisect(a, la, ra, b, lb, rb, wk);
            if (!m || (m.x <= la && m.y <= lb) || (m.x >= ra && m.y >= rb)) {
                pushCoarse(ops, na, nb);
            } else {
                rec(a, la, m.x, b, lb, m.y, ops, depth + 1, wk);
                rec(a, m.x, ra, b, m.y, rb, ops, depth + 1, wk);
            }
        }
        if (suf) pushOp(ops, 0, suf);
    }

    /* 操作序列 → 差异块
       块类型：eq（相同）/ rep（两边都有改动）/ del（仅左侧）/ ins（仅右侧）
       不变式：块按行号单调递增，把所有块的 l1-l0 相加 == 左侧行数 */
    function blocksFromOps(ops) {
        var blocks = [];
        var l = 0, r = 0, i, op;
        for (i = 0; i < ops.length; i++) {
            op = ops[i];
            if (op.t === 0) {
                blocks.push({ type: 'eq', l0: l, l1: l + op.n, r0: r, r1: r + op.n, lc: op.n, rc: op.n });
                l += op.n; r += op.n;
            } else {
                var dl = 0, dr = 0;
                while (i < ops.length && ops[i].t !== 0) {
                    if (ops[i].t === -1) dl += ops[i].n; else dr += ops[i].n;
                    i++;
                }
                i--;
                blocks.push({
                    type: dl && dr ? 'rep' : (dl ? 'del' : 'ins'),
                    l0: l, l1: l + dl, r0: r, r1: r + dr, lc: dl, rc: dr
                });
                l += dl; r += dr;
            }
        }
        return blocks;
    }

    /* 主入口：比较两组"键"
       返回 { blocks, stats, workOver, steps } */
    function diffKeys(aKeys, bKeys, opts) {
        opts = opts || {};
        var map = new Map();
        var a = internIds(aKeys, map);
        var b = internIds(bKeys, map);
        var wk = { steps: 0, limit: opts.workLimit || WORK_LIMIT, over: false };
        var ops = [];
        rec(a, 0, a.length, b, 0, b.length, ops, 0, wk);
        var blocks = blocksFromOps(ops);
        return { blocks: blocks, stats: blockStats(blocks, aKeys.length, bKeys.length), workOver: wk.over, steps: wk.steps };
    }

    /* 便捷入口：直接比较两段文本 */
    function diffText(aText, bText, opts) {
        opts = opts || {};
        var al = splitLines(aText), bl = splitLines(bText);
        return diffLines(al, bl, opts);
    }

    /* 比较两组行对象（applies 忽略规则） */
    function diffLines(aLines, bLines, opts) {
        opts = opts || {};
        var ak = normalizeKeys(aLines, opts);
        var bk = normalizeKeys(bLines, opts);
        var r = diffKeys(ak, bk, opts);
        r.aLines = aLines;
        r.bLines = bLines;
        return r;
    }

    function blockStats(blocks, totalL, totalR) {
        var s = { sameLines: 0, changed: 0, added: 0, removed: 0, hunks: 0, blocks: blocks.length };
        var prevChg = false;
        for (var i = 0; i < blocks.length; i++) {
            var b = blocks[i];
            if (b.type === 'eq') {
                s.sameLines += b.lc;
                prevChg = false;
            } else {
                s.changed++;
                s.removed += b.lc;
                s.added += b.rc;
                if (!prevChg) s.hunks++;
                prevChg = true;
            }
        }
        s.totalL = totalL == null ? -1 : totalL;
        s.totalR = totalR == null ? -1 : totalR;
        return s;
    }

    /* ------------------------------------------------------------ 渲染行 */
    /* opts: { ctx, showAll, expand: Map<gapKey, number|Infinity>, minKeep } */
    function blocksToRows(blocks, opts) {
        opts = opts || {};
        var ctx = opts.ctx == null ? 3 : opts.ctx;
        var expand = opts.expand || null;
        var showAll = !!opts.showAll;
        var minKeep = opts.minKeep == null ? 40 : opts.minKeep;
        var rows = [];
        var n = blocks.length;
        for (var i = 0; i < n; i++) {
            var b = blocks[i];
            if (b.type === 'eq') {
                var prevChg = i > 0 && blocks[i - 1].type !== 'eq';
                var nextChg = i + 1 < n && blocks[i + 1].type !== 'eq';
                var lone = (n === 1);   // 整个文件完全相同：首尾各留一点，中间折叠
                if (showAll || b.lc <= 2 * ctx + minKeep) {
                    for (var j = 0; j < b.lc; j++) rows.push({ k: 'eq', li: b.l0 + j, ri: b.r0 + j });
                    continue;
                }
                var head = (prevChg || lone) ? ctx : 0;
                var tail = (nextChg || lone) ? ctx : 0;
                if (head + tail >= b.lc) {
                    for (var j2 = 0; j2 < b.lc; j2++) rows.push({ k: 'eq', li: b.l0 + j2, ri: b.r0 + j2 });
                    continue;
                }
                var take = expand ? expand.get(b.l0) : 0;
                var addHead = take ? Math.min(take, b.lc - head - tail) : 0;
                for (var h = 0; h < head + addHead; h++) rows.push({ k: 'eq', li: b.l0 + h, ri: b.r0 + h });
                var gapCount = b.lc - head - tail - addHead;
                if (gapCount > 0) {
                    rows.push({
                        k: 'gap', count: gapCount, l0: b.l0 + head + addHead,
                        r0: b.r0 + head + addHead, block: i,
                        /* 展开时用的键：必须和 blocksToRows 查 expand 表用的键一致，
                           否则 head > 0 的间隙点了没反应 */
                        key: b.l0
                    });
                }
                for (var t = b.lc - tail; t < b.lc; t++) rows.push({ k: 'eq', li: b.l0 + t, ri: b.r0 + t });
                continue;
            }
            /* 改动块：左右逐行配对，多出来的部分单独成行 */
            var lc = b.lc, rc = b.rc, m = Math.max(lc, rc);
            for (var q = 0; q < m; q++) {
                var hasL = q < lc, hasR = q < rc;
                rows.push({
                    k: hasL && hasR ? 'chg' : (hasL ? 'del' : 'ins'),
                    li: hasL ? b.l0 + q : -1,
                    ri: hasR ? b.r0 + q : -1,
                    block: i
                });
            }
        }
        return rows;
    }

    /* 差异块的"第一条渲染行"下标，用于差异之间跳转 */
    function hunkAnchors(blocks) {
        var out = [];
        var prevChg = false;
        for (var i = 0; i < blocks.length; i++) {
            var chg = blocks[i].type !== 'eq';
            if (chg && !prevChg) out.push(i);
            prevChg = chg;
        }
        return out;
    }

    /* ------------------------------------------------------------ 词级差异 */
    function isWordCode(c) {
        return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
            c === 95 || c === 36 || (c >= 0xC0 && c <= 0x24F) || (c >= 0x370 && c <= 0x4FF) ||
            (c >= 0x3040 && c <= 0x30FF);
    }

    function isCJK(c) {
        return (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF) ||
            (c >= 0xFE30 && c <= 0xFE4F) || (c >= 0xFF00 && c <= 0xFFEF) ||
            (c >= 0xD800 && c <= 0xDFFF);
    }

    /* 分词：CJK 逐字、西文单词成块、空白成块、标点各自成块 */
    function tokenize(s) {
        var out = [];
        var i = 0, n = s.length;
        while (i < n) {
            var c = s.charCodeAt(i);
            if (isCJK(c)) {
                if (c >= 0xD800 && c <= 0xDBFF && i + 1 < n) { out.push(s.substr(i, 2)); i += 2; }
                else { out.push(s.charAt(i)); i++; }
            } else if (isWordCode(c)) {
                var j = i;
                while (j < n && isWordCode(s.charCodeAt(j))) j++;
                out.push(s.slice(i, j));
                i = j;
            } else if (c === 32 || c === 9) {
                var k = i;
                while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
                out.push(s.slice(i, k));
                i = k;
            } else {
                out.push(s.charAt(i));
                i++;
            }
        }
        return out;
    }

    var TOKEN_LIMIT = 3000;     // 单行超过这么多 token 就不做词级细化了

    /* 返回 { left:[{text,chg}], right:[{text,chg}] }，相邻同状态已合并 */
    function diffTokens(a, b) {
        if (a === b) {
            return { left: a ? [{ text: a, chg: false }] : [], right: b ? [{ text: b, chg: false }] : [] };
        }
        if (a.length > 20000 || b.length > 20000) {
            return { left: a ? [{ text: a, chg: true }] : [], right: b ? [{ text: b, chg: true }] : [] };
        }
        var ta = tokenize(a), tb = tokenize(b);
        if (ta.length > TOKEN_LIMIT || tb.length > TOKEN_LIMIT) {
            return { left: a ? [{ text: a, chg: true }] : [], right: b ? [{ text: b, chg: true }] : [] };
        }
        var r = diffKeys(ta, tb, { workLimit: 4e6 });
        var left = [], right = [];
        var la = 0, rb = 0;
        function addLeft(txt, chg) {
            if (!txt) return;
            var last = left.length ? left[left.length - 1] : null;
            if (last && last.chg === chg) last.text += txt; else left.push({ text: txt, chg: chg });
        }
        function addRight(txt, chg) {
            if (!txt) return;
            var last = right.length ? right[right.length - 1] : null;
            if (last && last.chg === chg) last.text += txt; else right.push({ text: txt, chg: chg });
        }
        for (var i = 0; i < r.blocks.length; i++) {
            var blk = r.blocks[i];
            var x;
            if (blk.type === 'eq') {
                for (x = 0; x < blk.lc; x++) addLeft(ta[blk.l0 + x], false);
                for (x = 0; x < blk.rc; x++) addRight(tb[blk.r0 + x], false);
            } else {
                for (x = 0; x < blk.lc; x++) addLeft(ta[blk.l0 + x], true);
                for (x = 0; x < blk.rc; x++) addRight(tb[blk.r0 + x], true);
            }
        }
        return { left: left, right: right };
    }

    /* ------------------------------------------------------------ 目录树 */
    /* 把路径拆成规范形式：统一 '/'，去掉首尾多余斜杠与 './' */
    function normPath(p) {
        p = String(p == null ? '' : p).replace(/\\/g, '/');
        p = p.replace(/^[a-zA-Z]:/, '');
        p = p.replace(/\/{2,}/g, '/');
        while (p.charAt(0) === '/') p = p.slice(1);
        while (p.length > 1 && p.charAt(p.length - 1) === '/') p = p.slice(0, p.length - 1);
        if (p === '.' || p === './') p = '';
        if (p.slice(0, 2) === './') p = p.slice(2);
        return p;
    }

    function baseName(p) {
        var i = p.lastIndexOf('/');
        return i < 0 ? p : p.slice(i + 1);
    }

    function dirName(p) {
        var i = p.lastIndexOf('/');
        return i < 0 ? '' : p.slice(0, i);
    }

    /* 相对路径安全校验：不允许上跳、绝对路径、盘符、空段 */
    function isSafeRelPath(p) {
        if (!p || p.charAt(0) === '/') return false;
        if (/^[a-zA-Z]:/.test(p)) return false;
        var segs = p.split('/');
        for (var i = 0; i < segs.length; i++) {
            if (!segs[i] || segs[i] === '.' || segs[i] === '..') return false;
        }
        return true;
    }

    /* left / right: [{ path, kind ('file'|'dir'), size }]
       返回 { root, map }
       node: { path, name, kind, parent, children, L, R, status, sizeL, sizeR, agg } */
    function buildTree(left, right) {
        var map = Object.create(null);
        function ensure(path, kind) {
            var node = map[path];
            if (node) {
                if (kind === 'dir') node.kind = 'dir';
                return node;
            }
            var parent = null;
            var dir = dirName(path);
            if (dir) parent = ensure(dir, 'dir');
            node = {
                path: path, name: baseName(path), kind: kind || 'file', parent: parent,
                children: [], L: null, R: null, status: '?', sizeL: -1, sizeR: -1,
                hasL: false, hasR: false,
                agg: { same: 0, diff: 0, left: 0, right: 0, type: 0, pending: 0 }
            };
            if (parent) parent.children.push(node);
            map[path] = node;
            return node;
        }
        var i, e;
        for (i = 0; i < left.length; i++) {
            e = left[i];
            var lp = normPath(e.path);
            if (!lp) continue;
            var ln = ensure(lp, e.kind);
            ln.L = e;
            ln.sizeL = e.kind === 'file' ? (e.size == null ? -1 : e.size) : -1;
        }
        for (i = 0; i < right.length; i++) {
            e = right[i];
            var rp = normPath(e.path);
            if (!rp) continue;
            var rn = ensure(rp, e.kind);
            rn.R = e;
            rn.sizeR = e.kind === 'file' ? (e.size == null ? -1 : e.size) : -1;
        }
        var root = { path: '', name: '', kind: 'dir', parent: null, children: [], L: null, R: null, status: '?', isRoot: true };
        var all = [];
        for (var k in map) all.push(map[k]);
        /* 顶层节点挂到虚拟根上（父节点已存在时不会重复挂） */
        for (i = 0; i < all.length; i++) {
            if (!all[i].parent) root.children.push(all[i]);
        }
        computePresence(root);
        sortTree(root);
        return { root: root, map: map, nodes: all };
    }

    /* 自底向上汇总"这个路径在哪一侧存在"。
       由文件路径补出来的中间目录自己没有 L/R 条目，靠这个判断它是"两侧都有"还是"仅一侧"。 */
    function computePresence(root) {
        (function walk(node) {
            var hasL = !!node.L, hasR = !!node.R;
            for (var i = 0; i < node.children.length; i++) {
                var sub = walk(node.children[i]);
                if (sub.hasL) hasL = true;
                if (sub.hasR) hasR = true;
            }
            node.hasL = hasL; node.hasR = hasR;
            return node;
        })(root);
        return root;
    }

    function sortTree(node) {
        node.children.sort(function (a, b) {
            if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
            return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
        });
        for (var i = 0; i < node.children.length; i++) sortTree(node.children[i]);
    }

    /* 设置节点自身的比较状态（只对"两侧都是文件"有意义） */
    function setFileStatus(node, status) {
        node.status = status;
    }

    /* 自底向上汇总：目录状态由后代文件决定
       status 取值：'=' 相同 / '≠' 不同 / 'L' 仅左侧 / 'R' 仅右侧 / 'T' 类型不同 / '?' 未比较 / 'M' 混合 */
    function computeStatus(root) {
        function walk(node) {
            if (node.isRoot) {
                for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
                return node.agg;
            }
            var agg = { same: 0, diff: 0, left: 0, right: 0, type: 0, pending: 0 };
            if (node.kind === 'dir') {
                for (var i = 0; i < node.children.length; i++) {
                    var sub = walk(node.children[i]);
                    agg.same += sub.same; agg.diff += sub.diff; agg.left += sub.left;
                    agg.right += sub.right; agg.type += sub.type; agg.pending += sub.pending;
                }
                node.agg = agg;
                var chg = agg.diff + agg.left + agg.right + agg.type;
                if (!node.hasL && !node.hasR) node.status = '?';
                else if (node.hasL && !node.hasR) node.status = 'L';
                else if (!node.hasL && node.hasR) node.status = 'R';
                else if (agg.pending && !chg) node.status = '?';
                else if (chg) node.status = '≠';
                else node.status = '=';
                return agg;
            }
            /* 文件 */
            var myAgg = { same: 0, diff: 0, left: 0, right: 0, type: 0, pending: 0 };
            if (node.L && node.R) {
                if (node.status === '=') myAgg.same = 1;
                else if (node.status === '?') myAgg.pending = 1;
                else myAgg.diff = 1;
            } else if (node.L) { node.status = node.status === '?' ? 'L' : node.status; myAgg.left = 1; }
            else if (node.R) { node.status = node.status === '?' ? 'R' : node.status; myAgg.right = 1; }
            node.agg = myAgg;
            return myAgg;
        }
        walk(root);
        return root.agg;
    }

    /* 收集节点下所有文件的"聚合计数"，供过滤器与统计条使用 */
    function countByStatus(root) {
        var c = { same: 0, diff: 0, left: 0, right: 0, type: 0, pending: 0, files: 0, dirs: 0 };
        (function walk(node) {
            for (var i = 0; i < node.children.length; i++) {
                var n = node.children[i];
                if (n.kind === 'dir') { c.dirs++; walk(n); }
                else {
                    c.files++;
                    if (n.status === '=') c.same++;
                    else if (n.status === 'L') c.left++;
                    else if (n.status === 'R') c.right++;
                    else if (n.status === 'T') c.type++;
                    else if (n.status === '?') c.pending++;
                    else c.diff++;
                }
            }
        })(root);
        return c;
    }

    /* 某节点是否需要出现在"仅显示差异"里 */
    function hasChange(node) {
        if (node.kind === 'file') return node.status !== '=';
        for (var i = 0; i < node.children.length; i++) if (hasChange(node.children[i])) return true;
        return false;
    }

    /* 某节点自己或后代是否满足状态条件 */
    function matchesStatusDeep(node, fn) {
        if (node.kind === 'file') return !!fn(node);
        for (var i = 0; i < node.children.length; i++) {
            if (matchesStatusDeep(node.children[i], fn)) return true;
        }
        return false;
    }

    /* 展平成可见行
       opts: { isExpanded(path)->bool, onlyDiff, filter(text)->bool }
       返回 [{ node, depth }] */
    function visibleRows(root, opts) {
        opts = opts || {};
        var out = [];
        /* 一旦启用了筛选（只看差异 / 状态徽章 / 搜索），目录一律自动展开，
           否则命中的文件被折叠在目录里，等于没筛 */
        var expandAll = !!(opts.onlyDiff || opts.statusFilter || opts.filter);
        (function walk(node, depth) {
            for (var i = 0; i < node.children.length; i++) {
                var n = node.children[i];
                if (opts.onlyDiff && !hasChange(n)) continue;
                if (opts.statusFilter && !matchesStatusDeep(n, opts.statusFilter)) continue;
                if (opts.filter && !nodeMatchesFilter(n, opts.filter)) continue;
                out.push({ node: n, depth: depth });
                var open = n.kind === 'dir' && (expandAll || (opts.isExpanded ? opts.isExpanded(n.path) : false));
                if (open) walk(n, depth + 1);
            }
        })(root, 0);
        return out;
    }

    /* 过滤：命中自身，或后代命中（目录要留着当路径） */
    function nodeMatchesFilter(node, filter) {
        if (filter(node.path)) return true;
        for (var i = 0; i < node.children.length; i++) {
            if (nodeMatchesFilter(node.children[i], filter)) return true;
        }
        return false;
    }

    /* 收集某节点下所有文件节点（含自身是文件的情况） */
    function collectFiles(node, out) {
        out = out || [];
        if (node.kind === 'file') { out.push(node); return out; }
        for (var i = 0; i < node.children.length; i++) collectFiles(node.children[i], out);
        return out;
    }

    var api = {
        WORK_LIMIT: WORK_LIMIT,
        splitLines: splitLines,
        joinLines: joinLines,
        plainText: plainText,
        dominantEOL: dominantEOL,
        normalizeKeys: normalizeKeys,
        diffKeys: diffKeys,
        diffText: diffText,
        diffLines: diffLines,
        blocksFromOps: blocksFromOps,
        blocksToRows: blocksToRows,
        hunkAnchors: hunkAnchors,
        blockStats: blockStats,
        tokenize: tokenize,
        diffTokens: diffTokens,
        normPath: normPath,
        baseName: baseName,
        dirName: dirName,
        isSafeRelPath: isSafeRelPath,
        buildTree: buildTree,
        computePresence: computePresence,
        sortTree: sortTree,
        computeStatus: computeStatus,
        setFileStatus: setFileStatus,
        countByStatus: countByStatus,
        hasChange: hasChange,
        visibleRows: visibleRows,
        collectFiles: collectFiles
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.DiffCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
