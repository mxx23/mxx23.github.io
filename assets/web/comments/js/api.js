/* ==========================================================================
   评论与计数 —— 前端统一接口层 (assets/web/comments/js/api.js)

   所有页面（公开评论区 / 站长页 / 文章页嵌入式评论区）都通过这里访问后端。

   后端是自建的 Cloudflare Worker（无服务器，数据存在 D1 里）：
     https://mxx23-blog.mxx23.workers.dev
   它取代了原来依赖 LeanCloud 的 Valine —— LeanCloud 将于 2027-01-12 停服。

   为什么不再把 appKey 放在前端：
     旧的 Valine 方案必须把 appId/appKey 明文写进页面，任何人都能用它
     直接读写删全部评论。现在写操作全部经 Worker 校验（长度、频率、来源、
     蜜罐），前端不持有任何能绕过校验的凭据。

   依赖：无（原生 fetch）。挂到 window.CmtApi。
   ========================================================================== */
(function (global) {
    'use strict';

    /* 后端地址：换部署只改这一行 */
    var ENDPOINT = 'https://mxx23-blog.mxx23.workers.dev';

    /* 驿站地址，用于把归一化后的路径还原成可点击链接 */
    var SITE = 'https://mxx23.github.io';

    /* 站长在评论区的昵称，用于打「站长」标记（与后端 is_owner 双保险） */
    var OWNER_NICK = '墨晓晓';

    var LS_TAG = {
        me: 'cmt-visitor',            // 昵称 / 邮箱 / 网站
        mine: 'cmt-visitor-ids',      // 本机发过的评论（兼容旧版）
        sub: 'cmt-device-key',        // 装置标识：判定「我的评论」用
        owner: 'cmt-master'           // 站长令牌（只在站长页写入）
    };

    /* ------------------------------------------------------------ 本机标识 */
    function lsGet(k, d) {
        try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
    }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
    function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }

    function randomKey() {
        var bytes = new Uint8Array(16);
        if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(bytes);
        else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        var out = '';
        for (var j = 0; j < bytes.length; j++) out += ('0' + bytes[j].toString(16)).slice(-2);
        return out;
    }

    /* 装置标识：一个随机串，不含任何个人信息，只用来认「这条是我发的」 */
    function deviceKey() {
        var k = lsGet(LS_TAG.sub, '');
        if (!k || k.length < 16) {
            k = randomKey() + randomKey();
            lsSet(LS_TAG.sub, k);
        }
        return k;
    }

    /* ------------------------------------------------------------ 请求 */
    function qs(params) {
        var parts = [];
        Object.keys(params || {}).forEach(function (k) {
            var v = params[k];
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    function request(method, path, body, opts) {
        opts = opts || {};
        var headers = {};
        if (body != null) headers['Content-Type'] = 'application/json';
        if (opts.admin) {
            var token = lsGet(LS_TAG.owner, '');
            if (!token) return Promise.reject(new Error('还没设置站长令牌'));
            headers['Authorization'] = 'Bearer ' + token;
        }
        var opt = { method: method, headers: headers };
        if (body != null) opt.body = JSON.stringify(body);

        return fetch(ENDPOINT + path, opt).then(function (r) {
            return r.text().then(function (t) {
                var b = null;
                try { b = t ? JSON.parse(t) : null; } catch (e) { b = null; }
                if (!r.ok) {
                    var msg = (b && (b.error || b.message)) || ('HTTP ' + r.status);
                    if (r.status === 401) msg = '站长令牌无效或没有设置';
                    if (r.status === 429) msg = msg || '操作太频繁，稍等一下';
                    var err = new Error(msg);
                    err.status = r.status;
                    err.body = b;
                    throw err;
                }
                return b;
            });
        }, function () {
            throw new Error('连不上评论服务（' + ENDPOINT.replace(/^https?:\/\//, '') + '），检查一下网络');
        });
    }

    /* ------------------------------------------------------------ 路径工具 */

    /** 把各种写法归一成后端存储的形式：/a/b（无结尾斜杠，去掉 /mxx23 前缀）
     *  注意：浏览器给的 location.pathname 对中文是百分号编码的，而后端存的是中文原文，
     *  所以这里必须解码一次，否则中文标题的文章永远匹配不上。 */
    function normPath(u) {
        var s = String(u == null ? '' : u).trim();
        if (!s) return '';
        if (/^https?:\/\//i.test(s)) { try { s = new URL(s).pathname; } catch (e) { /* 保持原样 */ } }
        s = s.split('#')[0].split('?')[0];
        s = s.replace(/^\/mxx23(?=\/)/i, '');
        if (s.charAt(0) !== '/') s = '/' + s;
        try { s = decodeURIComponent(s); } catch (e) { /* 解码失败就保持原样 */ }
        while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
        return s;
    }

    /** 归一化路径 -> 可点击的完整网址（文章页要带结尾斜杠，GitHub Pages 才有） */
    function pathToHref(p) {
        var n = normPath(p);
        if (!n || n === '/') return SITE + '/';
        return SITE + n.split('/').map(encodeURIComponent).join('/') + '/';
    }

    function isOwnerNick(nick) {
        return String(nick || '').trim() === OWNER_NICK;
    }

    /* ------------------------------------------------------------ 评论接口 */
    var Comments = {
        /** 全站评论（分页拉全）。返回归一化后的数组 */
        fetchAll: function (opts) {
            opts = opts || {};
            var PAGE = 1000;
            var MAX = opts.max || 5000;
            var all = [];
            var key = deviceKey();
            function page(skip) {
                return request('GET', '/api/comments' + qs({ limit: PAGE, skip: skip, viewer: key }))
                    .then(function (b) {
                        var rows = (b && b.results) || [];
                        all = all.concat(rows);
                        if (rows.length === PAGE && all.length < MAX) return page(skip + PAGE);
                        return all;
                    });
            }
            return page(0);
        },

        /** 单篇文章的评论 */
        fetchFor: function (path, opts) {
            opts = opts || {};
            return request('GET', '/api/comments' + qs({
                url: normPath(path),
                limit: opts.limit || 1000,
                skip: opts.skip || 0,
                viewer: deviceKey()
            })).then(function (b) { return (b && b.results) || []; });
        },

        /** 我在这台设备上发过的评论 */
        fetchMine: function () {
            return request('GET', '/api/comments/mine' + qs({ key: deviceKey() }))
                .then(function (b) { return (b && b.results) || []; });
        },

        /** 每篇文章的评论数：{ path: n } */
        counts: function (paths) {
            var list = (paths || []).map(normPath).filter(Boolean);
            if (!list.length) return Promise.resolve({});
            return request('GET', '/api/comments/count' + qs({ paths: list.join(',') }))
                .then(function (b) { return (b && b.counts) || {}; });
        },

        /**
         * 发表评论 / 回复。
         * data: { path, comment, nick, mail, link, parent, trap }
         */
        post: function (data) {
            var payload = {
                path: normPath(data.path),
                comment: data.comment,
                nick: data.nick,
                mail: data.mail || '',
                link: data.link || '',
                parent: data.parent || '',
                clientKey: deviceKey(),
                ua: String((global.navigator && global.navigator.userAgent) || '').slice(0, 200),
                trap: data.trap || ''
            };
            return request('POST', '/api/comments', payload).then(function (b) { return b && b.result; });
        },

        /** 撤回自己刚发的评论（一分钟内） */
        retract: function (id) {
            return request('DELETE', '/api/comments' + qs({ objectId: id, clientKey: deviceKey() }));
        },

        /* ---- 站长专用 ---- */
        admin: {
            session: function () { return request('GET', '/api/admin/session', null, { admin: true }); },
            list: function (opts) {
                opts = opts || {};
                return request('GET', '/api/admin/comments' + qs({
                    limit: opts.limit || 1000, skip: opts.skip || 0, path: opts.path || '', q: opts.q || ''
                }), null, { admin: true }).then(function (b) { return (b && b.results) || []; });
            },
            edit: function (id, comment) {
                return request('PATCH', '/api/admin/comments', { objectId: id, comment: comment }, { admin: true });
            },
            purge: function (id, restore) {
                return request('POST', '/api/admin/comments/purge', { objectId: id, restore: !!restore }, { admin: true });
            },
            stats: function () { return request('GET', '/api/admin/stats', null, { admin: true }); }
        }
    };

    /* ------------------------------------------------------------ 计数接口 */
    var Stats = {
        /** 记一次访问。同一页面同一会话只记一次；失败静默，不影响阅读 */
        hit: function (path) {
            var p = normPath(path) || '/';
            var seenKey = 'cmt-hit:' + p;
            try { if (sessionStorage.getItem(seenKey)) return Promise.resolve(null); } catch (e) { /* 忽略 */ }
            try { sessionStorage.setItem(seenKey, '1'); } catch (e) { /* 忽略 */ }
            return request('POST', '/api/stats/hit', {
                path: p,
                referrer: String((global.document && global.document.referrer) || '').slice(0, 300)
            }).catch(function () { return null; });
        },

        /** 单页计数（不增加） */
        page: function (path) {
            return request('GET', '/api/stats/page' + qs({ path: normPath(path) }));
        },

        /** 全站计数 + 热门文章 */
        site: function (hot) {
            return request('GET', '/api/stats' + qs({ hot: hot || 10 }));
        },

        /** 取一批页面的计数：{ path: n } */
        pages: function (paths) {
            var list = (paths || []).map(normPath).filter(Boolean);
            if (!list.length) return Promise.resolve({});
            return Promise.all(list.map(function (p) {
                return Stats.page(p).then(function (b) { return [p, (b && b.total) || 0]; })
                    .catch(function () { return [p, null]; });
            })).then(function (pairs) {
                var out = {};
                pairs.forEach(function (pr) { out[pr[0]] = pr[1]; });
                return out;
            });
        }
    };

    /* ------------------------------------------------------------ 站长令牌 */
    var Auth = {
        token: function () { return lsGet(LS_TAG.owner, ''); },
        hasToken: function () { return !!lsGet(LS_TAG.owner, ''); },
        setToken: function (t) { lsSet(LS_TAG.owner, String(t || '')); },
        clearToken: function () { lsDel(LS_TAG.owner); },
        verify: function (t) {
            var headers = {};
            var opt = { method: 'GET', headers: { Authorization: 'Bearer ' + t } };
            return fetch(ENDPOINT + '/api/admin/session', opt).then(function (r) {
                if (!r.ok) throw new Error(r.status === 401 ? '令牌不对' : ('HTTP ' + r.status));
                return r.json().then(function () { return true; });
            });
        }
    };

    /* ------------------------------------------------------------ 杂项工具 */
    function avatarUrl(nick, mail) {
        var seed = String(mail || '').trim() || String(nick || '').trim() || 'anonymous';
        return 'https://gravatar.loli.net/avatar/' + md5hex(seed.toLowerCase()) + '?d=retro&s=76';
    }

    /** 时间显示：刚刚 / n 分钟前 / n 小时前 / n 天前 / 具体时间 */
    function timeText(t) {
        var ms = typeof t === 'number' ? t : Date.parse(t);
        if (!ms || isNaN(ms)) return '';
        var d = Date.now() - ms;
        if (d < 0) d = 0;
        var min = 60000, hour = 3600000, day = 86400000;
        if (d < min) return '刚刚';
        if (d < hour) return Math.floor(d / min) + ' 分钟前';
        if (d < day) return Math.floor(d / hour) + ' 小时前';
        if (d < day * 30) return Math.floor(d / day) + ' 天前';
        var dt = new Date(ms);
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) +
            ' ' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    }

    /* ------------------------------------------------------------ MD5（头像用） */
    /* 只为把昵称/邮箱算成 Gravatar 哈希，不用于任何安全用途 */
    function md5hex(s) {
        function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
        function cmn(q, a, b, x, s, t) { return add32(rol(add32(add32(a, q), add32(x, t)), s), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
        function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
        function toBlocks(str) {
            var bytes = [];
            for (var i = 0; i < str.length; i++) {
                var c = str.charCodeAt(i);
                if (c < 128) bytes.push(c);
                else if (c < 2048) { bytes.push(192 | (c >> 6), 128 | (c & 63)); }
                else if (c < 55296 || c >= 57344) { bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63)); }
                else {
                    i++;
                    var cp = 65536 + (((c & 1023) << 10) | (str.charCodeAt(i) & 1023));
                    bytes.push(240 | (cp >> 18), 128 | ((cp >> 12) & 63), 128 | ((cp >> 6) & 63), 128 | (cp & 63));
                }
            }
            return bytes;
        }
        var bytes = toBlocks(s);
        var bitLen = bytes.length * 8;
        bytes.push(0x80);
        while (bytes.length % 64 !== 56) bytes.push(0);
        for (var i = 0; i < 8; i++) bytes.push((bitLen >>> (8 * i)) & 0xFF);
        var a0 = 1732584193, b0 = -271733879, c0 = -1732584194, d0 = 271733878;
        for (var off = 0; off < bytes.length; off += 64) {
            var x = [];
            for (var j = 0; j < 16; j++) {
                x[j] = bytes[off + j * 4] | (bytes[off + j * 4 + 1] << 8) |
                    (bytes[off + j * 4 + 2] << 16) | (bytes[off + j * 4 + 3] << 24);
            }
            var a = a0, b = b0, c = c0, d = d0;
            a = ff(a, b, c, d, x[0], 7, -680876936); d = ff(d, a, b, c, x[1], 12, -389564586);
            c = ff(c, d, a, b, x[2], 17, 606105819); b = ff(b, c, d, a, x[3], 22, -1044525330);
            a = ff(a, b, c, d, x[4], 7, -176418897); d = ff(d, a, b, c, x[5], 12, 1200080426);
            c = ff(c, d, a, b, x[6], 17, -1473231341); b = ff(b, c, d, a, x[7], 22, -45705983);
            a = ff(a, b, c, d, x[8], 7, 1770035416); d = ff(d, a, b, c, x[9], 12, -1958414417);
            c = ff(c, d, a, b, x[10], 17, -42063); b = ff(b, c, d, a, x[11], 22, -1990404162);
            a = ff(a, b, c, d, x[12], 7, 1804603682); d = ff(d, a, b, c, x[13], 12, -40341101);
            c = ff(c, d, a, b, x[14], 17, -1502002290); b = ff(b, c, d, a, x[15], 22, 1236535329);
            a = gg(a, b, c, d, x[1], 5, -165796510); d = gg(d, a, b, c, x[6], 9, -1069501632);
            c = gg(c, d, a, b, x[11], 14, 643717713); b = gg(b, c, d, a, x[0], 20, -373897302);
            a = gg(a, b, c, d, x[5], 5, -701558691); d = gg(d, a, b, c, x[10], 9, 38016083);
            c = gg(c, d, a, b, x[15], 14, -660478335); b = gg(b, c, d, a, x[4], 20, -405537848);
            a = gg(a, b, c, d, x[9], 5, 568446438); d = gg(d, a, b, c, x[14], 9, -1019803690);
            c = gg(c, d, a, b, x[3], 14, -187363961); b = gg(b, c, d, a, x[8], 20, 1163531501);
            a = gg(a, b, c, d, x[13], 5, -1444681467); d = gg(d, a, b, c, x[2], 9, -51403784);
            c = gg(c, d, a, b, x[7], 14, 1735328473); b = gg(b, c, d, a, x[12], 20, -1926607734);
            a = hh(a, b, c, d, x[5], 4, -378558); d = hh(d, a, b, c, x[8], 11, -2022574463);
            c = hh(c, d, a, b, x[11], 16, 1839030562); b = hh(b, c, d, a, x[14], 23, -35309556);
            a = hh(a, b, c, d, x[1], 4, -1530992060); d = hh(d, a, b, c, x[4], 11, 1272893353);
            c = hh(c, d, a, b, x[7], 16, -155497632); b = hh(b, c, d, a, x[10], 23, -1094730640);
            a = hh(a, b, c, d, x[13], 4, 681279174); d = hh(d, a, b, c, x[0], 11, -358537222);
            c = hh(c, d, a, b, x[3], 16, -722521979); b = hh(b, c, d, a, x[6], 23, 76029189);
            a = hh(a, b, c, d, x[9], 4, -640364487); d = hh(d, a, b, c, x[12], 11, -421815835);
            c = hh(c, d, a, b, x[15], 16, 530742520); b = hh(b, c, d, a, x[2], 23, -995338651);
            a = ii(a, b, c, d, x[0], 6, -198630844); d = ii(d, a, b, c, x[7], 10, 1126891415);
            c = ii(c, d, a, b, x[14], 15, -1416354905); b = ii(b, c, d, a, x[5], 21, -57434055);
            a = ii(a, b, c, d, x[12], 6, 1700485571); d = ii(d, a, b, c, x[3], 10, -1894986606);
            c = ii(c, d, a, b, x[10], 15, -1051523); b = ii(b, c, d, a, x[1], 21, -2054922799);
            a = ii(a, b, c, d, x[8], 6, 1873313359); d = ii(d, a, b, c, x[15], 10, -30611744);
            c = ii(c, d, a, b, x[6], 15, -1560198380); b = ii(b, c, d, a, x[13], 21, 1309151649);
            a = ii(a, b, c, d, x[4], 6, -145523070); d = ii(d, a, b, c, x[11], 10, -1120210379);
            c = ii(c, d, a, b, x[2], 15, 718787259); b = ii(b, c, d, a, x[9], 21, -343485551);
            a0 = add32(a0, a); b0 = add32(b0, b); c0 = add32(c0, c); d0 = add32(d0, d);
        }
        function hex(n) {
            var s = '';
            for (var i = 0; i < 4; i++) s += ('0' + ((n >> (i * 8)) & 0xFF).toString(16)).slice(-2);
            return s;
        }
        return hex(a0) + hex(b0) + hex(c0) + hex(d0);
    }

    /* ------------------------------------------------------------ 导出 */
    global.CmtApi = {
        ENDPOINT: ENDPOINT,
        SITE: SITE,
        OWNER_NICK: OWNER_NICK,
        LS_TAG: LS_TAG,
        Comments: Comments,
        Stats: Stats,
        Auth: Auth,
        normPath: normPath,
        pathToHref: pathToHref,
        isOwnerNick: isOwnerNick,
        deviceKey: deviceKey,
        avatarUrl: avatarUrl,
        timeText: timeText,
        md5hex: md5hex,
        lsGet: lsGet,
        lsSet: lsSet
    };
})(window);
