/* ==========================================================================
   评论管理页 (assets/web/comments/js/comments.js)
   用途：把站点评论插件存在后端的数据全部取出来看，并以站长身份二次回复。
   依赖：/assets/web/tools/css/tool.css 与 /assets/web/tools/js/tool.js（Toast、复制等）

   后端沿用站点现有的评论插件配置（appId / appKey 见 _config.fluid.yml），
   接口域名取插件自己实际使用的那一个，
   所以这里读、写的数据与文章页面下的评论区完全一致。
   ========================================================================== */
(function (global) {
    'use strict';

    /* ---------------------------------------------------------- 常量 */
    /* 后端接口层（自建 Cloudflare Worker，取代 LeanCloud）。 */
    var Back = global.CmtApi;
    var SITE = 'https://mxx23.github.io';

    var LS = {
        secret: 'cmt-master',
        credMode: 'cmt-auth-mode',
        session: 'cmt-session',
        authName: 'cmt-auth-name',
        owner: 'cmt-owner',
        seen: 'cmt-seen-at',
        known: 'cmt-known-ids',
        ui: 'cmt-ui'
    };

    var MAX_FETCH = 3000;       // 一次最多取多少条评论
    var PAGE_SIZE = 1000;       // 每次请求条数（接口上限）
    var KNOWN_KEEP = 3000;
    var AVATAR_STYLE = 'retro'; // 与前台评论插件保持一致

    /* ---------------------------------------------------------- 状态 */
    var state = {
        comments: [],           // 全部评论
        count: null,            // 后端记录总数（可能大于取回条数）
        byId: {},
        postMap: {},            // 文章路径 -> { title, date }
        auth: { mode: '', masterKey: '', sessionToken: '', name: '' },
        owner: { nick: '墨晓晓', mail: '', link: '' },
        seenAt: 0,
        knownIds: {},
        filter: 'all',          // all | todo | new | mine
        q: '',
        collapsed: {},
        editorKey: null,
        kidsCache: {},
        loading: false
    };

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) { return Tool.escapeHtml(s == null ? '' : String(s)); };

    /* ---------------------------------------------------------- 本地存储 */
    function lsGet(k, d) {
        try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
    }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略隐私模式 */ } }
    function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }

    /* ---------------------------------------------------------- 请求 */
    /* 读取是公开的，不需要凭据；写入需要站长令牌（Bearer）。 */
    function readHeaders() {
        return {};
    }

    function writeHeaders() {
        var token = state.auth.masterKey || lsGet(LS.secret, '');
        if (!token) {
            return Promise.reject(new Error('还没有写入凭据：请填写站长令牌'));
        }
        return Promise.resolve({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });
    }

    /* 兼容旧调用：现已不需要签名 */
    function sign() { return Promise.resolve(''); }

    function errText(body, status) {
        var table = {
            401: '站长令牌不正确，或没有设置',
            403: '后端拒绝了这个操作',
            404: '这条评论在后端已经不存在了',
            429: '操作太频繁，稍等一下再试'
        };
        var msg = (body && (body.error || body.message)) || '';
        return msg || table[status] || ('HTTP ' + status);
    }

    function apiGet(path) {
        var http = {};
        if (state.auth.masterKey || state.auth.sessionToken) {
            http.headers = { Authorization: 'Bearer ' + (state.auth.masterKey || state.auth.sessionToken) };
        }
        return fetch(Back.ENDPOINT + path, http).then(function (r) {
            return r.json().catch(function () { return null; }).then(function (b) {
                if (!r.ok) throw new Error(errText(b, r.status));
                return b;
            });
        });
    }

    function apiWrite(method, path, payload) {
        return writeHeaders().then(function (h) {
            return fetch(Back.ENDPOINT + path, {
                method: method,
                headers: h,
                body: payload == null ? undefined : JSON.stringify(payload)
            }).then(function (r) {
                return r.text().then(function (t) {
                    var b = null;
                    try { b = t ? JSON.parse(t) : null; } catch (e) { b = null; }
                    if (!r.ok) {
                        if (r.status === 401) dropCredential();
                        throw new Error(errText(b, r.status));
                    }
                    return b;
                });
            });
        });
    }

    /* 凭据失效时自动降级为只读 */
    function dropCredential() {
        lsDel(LS.secret); lsDel(LS.session); lsDel(LS.authName); lsDel(LS.credMode);
        state.auth = { mode: '', masterKey: '', sessionToken: '', name: '' };
        refreshAuthUi();
        Tool.toast('写入凭据已失效，已切回只读', 'err', 3200);
    }

    /* ---------------------------------------------------------- 数据整理 */
    function iso(v) {
        if (!v) return '';
        return typeof v === 'string' ? v : (v.iso || '');
    }

    function normComment(c) {
        return {
            id: c.objectId,
            nick: c.nick || '匿名',
            mail: c.mail || '',
            link: c.link || '',
            qq: c.QQAvatar || '',
            comment: c.comment == null ? '' : String(c.comment),
            url: c.url || '',
            pid: c.pid || '',
            rid: c.rid || '',
            ua: c.ua || '',
            at: iso(c.insertedAt) || c.createdAt || '',
            created: c.createdAt || ''
        };
    }

    function normUrl(u) {
        var s = String(u || '').trim();
        s = s.replace(/^https?:\/\/[^/]+/i, '');
        s = s.replace(/^\/mxx23(?=\/)/i, '');   // 早期版本的子目录链接
        if (s.indexOf('?') >= 0) s = s.slice(0, s.indexOf('?'));
        if (s && s.charAt(0) !== '/') s = '/' + s;
        return s || '/';
    }

    /* 评论里存的路径可能是编码过的、也可能没编码，两种写法都试一次 */
    function postInfo(url) {
        var n = normUrl(url);
        var plain = n;
        try { plain = decodeURIComponent(n); } catch (e) { /* 保持原样 */ }
        var encoded = plain;
        try { encoded = plain.split('/').map(encodeURIComponent).join('/'); } catch (e) { /* 保持原样 */ }
        var hit = state.postMap[n] || state.postMap[plain] || state.postMap[encoded];
        return hit ? { title: hit.title, path: n, known: true } : { title: plain, path: n, known: false };
    }

    function postHref(url) {
        var n = normUrl(url);
        return SITE + n.split('/').map(encodeURIComponent).join('/');
    }

    function isOwner(c) {
        var n = state.owner.nick;
        return !!(n && c.nick && c.nick === n);
    }

    function buildTree() {
        var roots = [], kids = {}, i, c;
        for (i = 0; i < state.comments.length; i++) {
            c = state.comments[i];
            if (c.pid && state.byId[c.pid]) (kids[c.pid] || (kids[c.pid] = [])).push(c);
            else roots.push(c);
        }
        Object.keys(kids).forEach(function (k) {
            kids[k].sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        });
        roots.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
        state.kidsCache = kids;
        return { roots: roots, kids: kids };
    }

    function isNew(c) {
        return state.seenAt > 0 && !!c.at && String(c.at) > state.seenAt && !state.knownIds[c.id];
    }

    function todoOf(root, kids) {
        return !isOwner(root) && (kids[root.id] || []).length === 0;
    }

    function descendantCount(id) {
        var kids = {}, n = 0, stack = [id];
        state.comments.forEach(function (c) { if (c.pid) (kids[c.pid] || (kids[c.pid] = [])).push(c.id); });
        while (stack.length) {
            var cur = stack.pop();
            (kids[cur] || []).forEach(function (k) { n++; stack.push(k); });
        }
        return n;
    }

    /* ---------------------------------------------------------- 文本渲染 */
    /* @提及 / `代码` / 链接 高亮；:emoji: 短代码原样保留（与前台一致） */
    function inlineHtml(text) {
        var out = '', last = 0, m;
        var re = /(`[^`\n]+`|https?:\/\/[^\s<>"']+|@[A-Za-z0-9_\u4e00-\u9fa5-]{1,20})/g;
        while ((m = re.exec(text))) {
            out += esc(text.slice(last, m.index));
            var tok = m[0];
            if (tok.charAt(0) === '`') out += '<code>' + esc(tok.slice(1, -1)) + '</code>';
            else if (tok.charAt(0) === '@') out += '<span class="mention">' + esc(tok) + '</span>';
            else out += '<a href="' + esc(tok) + '" target="_blank" rel="noopener noreferrer">' + esc(tok) + '</a>';
            last = m.index + tok.length;
        }
        return out + esc(text.slice(last));
    }

    function bodyHtml(text) {
        if (!text) return '<p class="cmt-text"><span class="cmt-empty">（空内容）</span></p>';
        var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        return '<p class="cmt-text">' + lines.map(inlineHtml).join('\n') + '</p>';
    }

    /* 头像地址与前台评论插件一致：邮件（或昵称）的 MD5 */
    function avatarUrl(c) {
        if (c.qq) return c.qq;
        var key = String((c.mail && c.mail.indexOf('@') > 0 ? c.mail : (c.nick || c.id || ''))).trim().toLowerCase();
        return 'https://gravatar.loli.net/avatar/' + md5hex(key) + '?d=' + AVATAR_STYLE + '&s=76';
    }

    /* 一个够用的 MD5 实现，只为算头像 */
    function md5hex(str) {
        function rl(n, c) { return (n << c) | (n >>> (32 - c)); }
        function au(x, y) { var l = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xFFFF); }
        function cmn(q, a, b, x, s, t) { return au(rl(au(au(a, q), au(x, t)), s), b); }
        function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
        function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
        function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
        function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
        function toBlocks(s) {
            var n = ((s.length + 8) >> 6) + 1, bl = new Array(n * 16), i;
            for (i = 0; i < n * 16; i++) bl[i] = 0;
            for (i = 0; i < s.length; i++) bl[i >> 2] |= s.charCodeAt(i) << ((i % 4) * 8);
            bl[i >> 2] |= 0x80 << ((i % 4) * 8);
            bl[n * 16 - 2] = s.length * 8;
            return bl;
        }
        var x = toBlocks(unescape(encodeURIComponent(str)));
        var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878, i;
        for (i = 0; i < x.length; i += 16) {
            var oa = a, ob = b, oc = c, od = d;
            a = ff(a, b, c, d, x[i], 7, -680876936); d = ff(d, a, b, c, x[i + 1], 12, -389564586);
            c = ff(c, d, a, b, x[i + 2], 17, 606105819); b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
            a = ff(a, b, c, d, x[i + 4], 7, -176418897); d = ff(d, a, b, c, x[i + 5], 12, 1200080426);
            c = ff(c, d, a, b, x[i + 6], 17, -1473231341); b = ff(b, c, d, a, x[i + 7], 22, -45705983);
            a = ff(a, b, c, d, x[i + 8], 7, 1770035416); d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
            c = ff(c, d, a, b, x[i + 10], 17, -42063); b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = ff(a, b, c, d, x[i + 12], 7, 1804603682); d = ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = ff(c, d, a, b, x[i + 14], 17, -1502002290); b = ff(b, c, d, a, x[i + 15], 22, 1236535329);
            a = gg(a, b, c, d, x[i + 1], 5, -165796510); d = gg(d, a, b, c, x[i + 6], 9, -1069501632);
            c = gg(c, d, a, b, x[i + 11], 14, 643717713); b = gg(b, c, d, a, x[i], 20, -373897302);
            a = gg(a, b, c, d, x[i + 5], 5, -701558691); d = gg(d, a, b, c, x[i + 10], 9, 38016083);
            c = gg(c, d, a, b, x[i + 15], 14, -660478335); b = gg(b, c, d, a, x[i + 4], 20, -405537848);
            a = gg(a, b, c, d, x[i + 9], 5, 568446438); d = gg(d, a, b, c, x[i + 14], 9, -1019803690);
            c = gg(c, d, a, b, x[i + 3], 14, -187363961); b = gg(b, c, d, a, x[i + 8], 20, 1163531501);
            a = gg(a, b, c, d, x[i + 13], 5, -1444681467); d = gg(d, a, b, c, x[i + 2], 9, -51403784);
            c = gg(c, d, a, b, x[i + 7], 14, 1735328473); b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
            a = hh(a, b, c, d, x[i + 5], 4, -378558); d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
            c = hh(c, d, a, b, x[i + 11], 16, 1839030562); b = hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = hh(a, b, c, d, x[i + 1], 4, -1530992060); d = hh(d, a, b, c, x[i + 4], 11, 1272893353);
            c = hh(c, d, a, b, x[i + 7], 16, -155497632); b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i], 11, -358537222);
            c = hh(c, d, a, b, x[i + 3], 16, -722521979); b = hh(b, c, d, a, x[i + 6], 23, 76029189);
            a = hh(a, b, c, d, x[i + 9], 4, -640364487); d = hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = hh(c, d, a, b, x[i + 15], 16, 530742520); b = hh(b, c, d, a, x[i + 2], 23, -995338651);
            a = ii(a, b, c, d, x[i], 6, -198630844); d = ii(d, a, b, c, x[i + 7], 10, 1126891415);
            c = ii(c, d, a, b, x[i + 14], 15, -1416354905); b = ii(b, c, d, a, x[i + 5], 21, -57434055);
            a = ii(a, b, c, d, x[i + 12], 6, 1700485571); d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
            c = ii(c, d, a, b, x[i + 10], 15, -1051523); b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
            a = ii(a, b, c, d, x[i + 8], 6, 1873313359); d = ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = ii(c, d, a, b, x[i + 6], 15, -1560198380); b = ii(b, c, d, a, x[i + 13], 21, 1309151649);
            a = ii(a, b, c, d, x[i + 4], 6, -145523070); d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = ii(c, d, a, b, x[i + 2], 15, 718787259); b = ii(b, c, d, a, x[i + 9], 21, -343485551);
            a = au(a, oa); b = au(b, ob); c = au(c, oc); d = au(d, od);
        }
        return [a, b, c, d].map(function (n) {
            var s = '';
            for (var k = 0; k < 4; k++) s += ((n >> (k * 8)) & 0xFF).toString(16).padStart(2, '0');
            return s;
        }).join('');
    }

    function timeText(at) {
        if (!at) return '-';
        var d = new Date(at);
        if (isNaN(d.getTime())) return String(at);
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        var diff = Date.now() - d.getTime(), rel = '';
        if (diff >= 0 && diff < 60000) rel = '刚刚';
        else if (diff >= 0 && diff < 3600000) rel = Math.floor(diff / 60000) + ' 分钟前';
        else if (diff >= 0 && diff < 86400000) rel = Math.floor(diff / 3600000) + ' 小时前';
        else if (diff >= 0 && diff < 2592000000) rel = Math.floor(diff / 86400000) + ' 天前';
        var abs = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
        return rel ? rel + '（' + abs + '）' : abs;
    }

    function maskMail(mail) {
        if (!mail) return '';
        var at = mail.indexOf('@');
        if (at <= 0) return mail;
        var name = mail.slice(0, at), dom = mail.slice(at);
        return (name.length <= 2 ? name.charAt(0) : name.slice(0, 2)) + '***' + dom;
    }

    /* ---------------------------------------------------------- 过滤 */
    /* depth=0 才判断“待回复”：只有顶层评论才谈得上有没有被回复过 */
    function matches(c, depth) {
        var q = state.q.trim().toLowerCase();
        if (q) {
            if ((c.nick + ' ' + c.mail + ' ' + c.comment + ' ' + c.url).toLowerCase().indexOf(q) < 0) return false;
        }
        if (state.filter === 'todo') return depth === 0 ? todoOf(c, state.kidsCache) : false;
        if (state.filter === 'new') return isNew(c);
        if (state.filter === 'mine') return isOwner(c);
        return true;
    }

    /* ---------------------------------------------------------- 渲染 */
    function renderStats() {
        var all = state.comments.length, mine = 0, fresh = 0, todo = 0, pages = {};
        state.comments.forEach(function (c) {
            if (isOwner(c)) mine++;
            if (isNew(c)) fresh++;
            if (c.url) pages[normUrl(c.url)] = 1;
        });
        var kids = state.kidsCache;
        buildTree().roots.forEach(function (r) { if (todoOf(r, kids)) todo++; });

        var chips = [
            { k: 'all', label: '全部评论', n: all },
            { k: 'todo', label: '待回复', n: todo, cls: 'todo' },
            { k: 'new', label: '上次之后新增', n: fresh },
            { k: 'mine', label: '我发的', n: mine }
        ];
        var html = chips.map(function (c) {
            return '<span class="stat-chip' + (c.cls ? ' ' + c.cls : '') + (state.filter === c.k ? ' active' : '') +
                '" data-filter="' + c.k + '" title="点击筛选">' + esc(c.label) + ' <b>' + c.n + '</b></span>';
        }).join('');
        html += '<span class="stat-chip" data-filter="__none">有评论的文章 <b>' + Object.keys(pages).length + '</b></span>';
        html += '<span class="stat-chip" data-filter="__none">后端总数 <b>' + (state.count == null ? all : state.count) + '</b></span>';
        $('statsBar').innerHTML = html;
    }

    function editorHtml(c, mode) {
        var isReply = mode === 'reply';
        var quoted = isReply ? '<div class="quote">回复 <b>' + esc(c.nick) + '</b>：' + esc(c.comment.slice(0, 80)) + '</div>' : '';
        return '<div class="editor" data-editor="' + esc(c.id) + '" data-mode="' + mode + '">' + quoted +
            '<textarea data-role="text" placeholder="' + (isReply ? '写下回复，Ctrl+Enter 发送' : '修改这条评论的内容') + '">' +
            esc(isReply ? '' : c.comment) + '</textarea>' +
            '<div class="editor-foot">' +
            '<button class="btn btn-primary btn-sm" data-act="submit">' + (isReply ? '发送回复' : '保存修改') + '</button>' +
            '<button class="btn btn-sm" data-act="cancel">取消</button>' +
            '<span class="hint">' + (isReply ? '会自动带上 @对方昵称，并挂到这条评论下面' : '只改内容，其他字段不动') + '</span>' +
            '</div></div>';
    }

    function commentHtml(c, depth, ctx) {
        var owner = isOwner(c);
        var allKids = ctx.kids[c.id] || [];
        var todo = depth === 0 && todoOf(c, ctx.kids);
        var cls = ['cmt'];
        if (depth > 0) cls.push('is-reply');
        if (isNew(c)) cls.push('is-new');
        if (todo) cls.push('is-todo');
        if (owner) cls.push('is-me');

        var badges = '';
        if (todo) badges += ' <span class="badge warn">待回复</span>';
        if (isNew(c)) badges += ' <span class="badge">新</span>';
        if (owner) badges += ' <span class="badge ok">站长</span>';
        if (allKids.length) badges += ' <span class="badge gray">' + allKids.length + ' 条回复</span>';
        if (!postInfo(c.url).known) badges += ' <span class="badge gray" title="当前站点的文章列表里没有这条路径，多半是旧链接">旧链接</span>';

        var mail = c.mail
            ? '<span class="cmt-mail" data-copy="' + esc(c.mail) + '" title="点击复制邮箱：' + esc(c.mail) + '">' + esc(maskMail(c.mail)) + '</span>'
            : '';
        var site = c.link ? '<a href="' + esc(c.link) + '" target="_blank" rel="noopener noreferrer" style="color:var(--primary)">主页</a>' : '';

        var actions = '<button class="link-btn" data-act="reply" data-id="' + esc(c.id) + '">回复</button>';
        if (state.auth.mode) {
            actions += '<button class="link-btn" data-act="edit" data-id="' + esc(c.id) + '">编辑</button>' +
                '<button class="link-btn danger" data-act="del" data-id="' + esc(c.id) + '">删除</button>';
        }
        var editor = '';
        if (state.editorKey === 'reply:' + c.id) editor = editorHtml(c, 'reply');
        else if (state.editorKey === 'edit:' + c.id) editor = editorHtml(c, 'edit');

        // 开了筛选时，只显示同样符合条件的回复；展开某个括号看全部
        var showAllKids = state.filter === 'all' || !!state.collapsed['kids:' + c.id];
        var kids = showAllKids ? allKids : allKids.filter(function (k) { return matches(k, depth + 1); });
        var hidden = allKids.length - kids.length;
        var kidsHtml = '';
        if (kids.length) {
            kidsHtml = '<div class="cmt-kids">' + kids.map(function (k) { return commentHtml(k, depth + 1, ctx); }).join('') +
                (hidden > 0 ? '<button class="link-btn" data-act="kids" data-id="' + esc(c.id) + '">展开被筛选隐藏的 ' + hidden + ' 条回复</button>' : '') +
                '</div>';
        }

        return '<div class="' + cls.join(' ') + '" data-id="' + esc(c.id) + '" id="c-' + esc(c.id) + '">' +
            '<img class="cmt-avatar" alt="" loading="lazy" src="' + esc(avatarUrl(c)) + '" onerror="this.style.visibility=\'hidden\'">' +
            '<div class="cmt-main">' +
            '<div class="cmt-head">' +
            '<span class="cmt-nick' + (owner ? ' admin' : '') + '">' + esc(c.nick) + '</span>' +
            mail + site +
            '<span title="' + esc(c.at) + '">' + esc(timeText(c.at)) + '</span>' + badges +
            '</div>' +
            bodyHtml(c.comment) + editor +
            '<div class="cmt-foot"><span class="mono-sm" style="color:var(--text-3)">' + esc(c.id) + '</span>' +
            '<span class="spacer"></span><span class="cmt-actions">' + actions + '</span></div>' +
            '</div>' + kidsHtml + '</div>';
    }

    function renderList() {
        var tree = buildTree();
        var ctx = { kids: tree.kids };
        var groups = {};
        tree.roots.forEach(function (r) {
            var u = normUrl(r.url);
            (groups[u] || (groups[u] = [])).push(r);
        });

        var keys = Object.keys(groups).sort(function (a, b) {
            var la = groups[a][0] ? groups[a][0].at : '', lb = groups[b][0] ? groups[b][0].at : '';
            return String(lb).localeCompare(String(la));
        });

        var shown = 0, total = 0;
        var html = keys.map(function (url) {
            var all = groups[url];
            var roots = all.filter(function (r) {
                return matches(r, 0) || (ctx.kids[r.id] || []).some(function (k) { return matches(k, 1); });
            });
            if (!roots.length) return '';
            shown++;
            total += roots.reduce(function (n, r) { return n + 1 + (ctx.kids[r.id] || []).length; }, 0);

            var info = postInfo(url);
            var newest = all[0] ? all[0].at : '';
            var count = all.reduce(function (n, r) { return n + 1 + (ctx.kids[r.id] || []).length; }, 0);
            return '<div class="page-group' + (state.collapsed[url] ? ' collapsed' : '') + '" data-url="' + esc(url) + '">' +
                '<div class="pg-head">' +
                '<span class="pg-caret">▼</span>' +
                '<span class="pg-title">' + esc(info.title) + '</span>' +
                '<span class="pg-path">' + esc(url) + '</span>' +
                '<span class="pg-meta">' +
                (info.known ? '' : '<span class="badge gray">无对应文章</span>') +
                '<span class="badge">' + count + ' 条</span>' +
                '<span>' + esc(timeText(newest)) + '</span>' +
                '<a class="link-btn" href="' + esc(postHref(url)) + '" target="_blank" rel="noopener noreferrer">打开文章 ↗</a>' +
                '</span></div>' +
                '<div class="pg-body">' + roots.map(function (r) { return commentHtml(r, 0, ctx); }).join('') + '</div>' +
                '</div>';
        }).join('');

        $('list').innerHTML = html || '<div class="empty">' +
            (state.comments.length ? '没有符合当前筛选条件的评论' : '还没有读到评论，点右上角“刷新”试试') + '</div>';
        $('listMeta').textContent = shown + ' 篇文章 / 显示 ' + total + ' 条';
    }

    function renderAll() {
        renderStats();
        renderList();
    }

    /* ---------------------------------------------------------- 读取 */
    function fetchAll() {
        var all = [], count = null;
        function page(skip) {
            return apiGet('/api/admin/comments?limit=' + PAGE_SIZE + '&skip=' + skip)
                .then(function (b) {
                    if (count == null) count = typeof b.count === 'number' ? b.count : null;
                    (b.results || []).forEach(function (c) { all.push(normComment(c)); });
                    if (b.results && b.results.length === PAGE_SIZE && all.length < MAX_FETCH) return page(skip + PAGE_SIZE);
                    return all;
                });
        }
        return page(0).then(function (list) {
            state.count = count;
            state.comments = list;
            state.byId = {};
            list.forEach(function (c) { state.byId[c.id] = c; });
        });
    }

    function load(silent) {
        if (state.loading) return Promise.resolve();
        state.loading = true;
        $('btnReload').disabled = true;
        if (!silent) Tool.setStatus($('loadStatus'), 'info', '正在读取评论…');
        return fetchAll().then(function () {
            Tool.setStatus($('loadStatus'), 'ok', '已读取 ' + state.comments.length + ' 条评论' +
                (state.count != null && state.count !== state.comments.length
                    ? '（后端共 ' + state.count + ' 条，本次取回 ' + state.comments.length + ' 条）' : ''));
            renderAll();
            rememberSeen();
        }).catch(function (e) {
            Tool.setStatus($('loadStatus'), 'err', '读取失败：' + e.message +
                '\n若是网络错误，先确认当前网络能访问评论后端。');
        }).then(function () {
            state.loading = false;
            $('btnReload').disabled = false;
        });
    }

    /* ---------------------------------------------------------- 新增标记 */
    function rememberSeen() {
        state.comments.forEach(function (c) { state.knownIds[c.id] = 1; });
        var ids = Object.keys(state.knownIds);
        if (ids.length > KNOWN_KEEP) {
            var keep = {};
            ids.slice(ids.length - KNOWN_KEEP).forEach(function (i) { keep[i] = 1; });
            state.knownIds = keep;
        }
        state.seenAt = Date.now();
        lsSet(LS.known, JSON.stringify(state.knownIds));
        lsSet(LS.seen, String(state.seenAt));
    }

    /* ---------------------------------------------------------- 写入 */
    function ownerFields() {
        var o = state.owner;
        return {
            nick: o.nick || '墨晓晓',
            mail: o.mail || '',
            link: o.link || '',
            ua: String(navigator.userAgent || '').slice(0, 200)
        };
    }

    function postReply(parent, text) {
        var p = ownerFields();
        var body = /^@/.test(text) || !parent.nick ? text : '@' + parent.nick + ' ' + text;
        return apiWrite('POST', '/api/admin/comments', {
            comment: body,
            path: parent.url,
            parent: parent.id,
            nick: p.nick,
            mail: p.mail,
            link: p.link,
            ua: p.ua,
            QQAvatar: ''
        }).then(function (res) {
            // 本地先插进去，界面立刻能看到；随后再静默对齐服务端
            var local = normComment(res.result || {                objectId: 'tmp-' + Date.now(), comment: body, url: parent.url,                parent: parent.id, nick: p.nick, mail: p.mail, link: p.link,                createdAt: Date.now() });
            state.comments.push(local);
            state.byId[local.id] = local;
            state.knownIds[local.id] = 1;
            return res;
        });
    }

    function editComment(c, text) {
        return apiWrite('PATCH', '/api/admin/comments', { objectId: c.id, comment: text })
            .then(function () { c.comment = text; });
    }

    function deleteComment(id) {
        return apiWrite('POST', '/api/admin/comments/purge', { objectId: id });
    }

    function deleteWithKids(c) {
        var n = descendantCount(c.id);
        return confirmBox('确定删除这条评论吗？\n\n' + c.nick + '：' + c.comment.slice(0, 60) +
            (n ? '\n\n它下面还有 ' + n + ' 条回复，会一并删除。' : '') +
            '\n\n删除后无法恢复（除非之前导出过数据备份）。').then(function (ok) {
                if (!ok) return false;
                var ids = [];
                (function collect(id) {
                    ids.push(id);
                    state.comments.forEach(function (x) { if (x.pid === id) collect(x.id); });
                })(c.id);
                var chain = Promise.resolve();
                ids.forEach(function (id) { chain = chain.then(function () { return deleteComment(id); }); });
                return chain.then(function () {
                    var drop = {};
                    ids.forEach(function (i) { drop[i] = 1; delete state.byId[i]; });
                    state.comments = state.comments.filter(function (x) { return !drop[x.id]; });
                    renderAll();
                    Tool.toast('已删除 ' + ids.length + ' 条', 'ok');
                    setTimeout(function () { load(true); }, 350);
                    return true;
                });
            });
    }

    /* ---------------------------------------------------------- 凭据 */
    /* 新后端只有一个站长令牌，不再支持账号 / 密码登录 */
    function login() {
        return Promise.reject(new Error('新后端不再提供账号登录，请在上面填写站长令牌'));
    }

    /* 验证站长令牌是否可用（只读，不改数据） */
    function verifyMasterKey(key) {
        return fetch(Back.ENDPOINT + '/api/admin/session', {
            headers: { Authorization: 'Bearer ' + key }
        }).then(function (r) {
            if (r.ok) return true;
            throw new Error(r.status === 401 ? '站长令牌不正确' : 'HTTP ' + r.status);
        });
    }

    function useMasterKey(key, remember) {
        state.auth = { mode: 'master', masterKey: key, sessionToken: '', name: '站长令牌' };
        lsSet(LS.credMode, 'master');
        if (remember) lsSet(LS.secret, btoa(unescape(encodeURIComponent(key))));
        else lsDel(LS.secret);
        refreshAuthUi();
        renderList();
        Tool.toast('站长令牌已启用', 'ok');
        /* 拿到凭据后要重新拉一次，否则列表还是未授权时的空结果 */
        load(true);
    }

    function signOut() {
        state.auth = { mode: '', masterKey: '', sessionToken: '', name: '' };
        lsDel(LS.secret); lsDel(LS.session); lsDel(LS.authName); lsDel(LS.credMode);
        refreshAuthUi();
        renderList();
        Tool.toast('已退出，恢复为只读');
    }

    function refreshAuthUi() {
        var on = !!state.auth.mode;
        $('authState').className = 'auth-state' + (on ? ' show' : '');
        $('authBox').className = 'auth-box' + (on ? '' : ' recommended');
        $('authWho').textContent = state.auth.name || '';
        $('authMode').textContent = state.auth.mode === 'master' ? '站长令牌' : '只读';
        $('loginBox').style.display = on ? 'none' : '';
        $('secretBox').style.display = on ? 'none' : '';
        $('authHint').textContent = on
            ? '写入权限已就绪，可以回复 / 编辑 / 删除。'
            : '现在只能看，不能写：回复、编辑、删除都需要先给出写入凭据。';
    }

    /* ---------------------------------------------------------- 确认框 */
    function confirmBox(msg, okText) {
        var modal = $('modal');
        $('modalText').textContent = msg;
        $('modalOk').textContent = okText || '确定';
        modal.classList.remove('hidden');
        return new Promise(function (resolve) {
            function done(v) {
                modal.classList.add('hidden');
                $('modalOk').removeEventListener('click', onOk);
                $('modalCancel').removeEventListener('click', onNo);
                document.removeEventListener('keydown', onKey);
                resolve(v);
            }
            function onOk() { done(true); }
            function onNo() { done(false); }
            function onKey(e) { if (e.key === 'Escape') done(false); }
            $('modalOk').addEventListener('click', onOk);
            $('modalCancel').addEventListener('click', onNo);
            document.addEventListener('keydown', onKey);
        });
    }

    /* ---------------------------------------------------------- 交互 */
    function commentOf(el) {
        var box = el.closest ? el.closest('.cmt') : null;
        return box ? state.byId[box.getAttribute('data-id')] : null;
    }

    function focusEditor(id) {
        var box = document.getElementById('c-' + id);
        if (!box) return;
        var ta = box.querySelector('.editor textarea');
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        var ed = box.querySelector('.editor');
        if (ed && ed.scrollIntoView) ed.scrollIntoView({ block: 'nearest' });
    }

    function submitEditor(editor) {
        var id = editor.getAttribute('data-editor');
        var mode = editor.getAttribute('data-mode');
        var c = state.byId[id];
        var ta = editor.querySelector('[data-role="text"]');
        var text = (ta.value || '').trim();
        if (!c) { Tool.toast('这条评论已不在列表里', 'err'); return; }
        if (!text) { Tool.toast('内容不能为空', 'err'); return; }

        var btns = editor.querySelectorAll('button');
        Array.prototype.forEach.call(btns, function (b) { b.disabled = true; });
        var p = mode === 'reply' ? postReply(c, text) : editComment(c, text);
        p.then(function () {
            state.editorKey = null;
            renderAll();
            Tool.toast(mode === 'reply' ? '回复已发出，文章页面刷新后即可看到' : '已保存');
            setTimeout(function () { load(true); }, 400);
        }).catch(function (e) {
            Array.prototype.forEach.call(btns, function (b) { b.disabled = false; });
            Tool.toast('写入失败：' + e.message, 'err', 4600);
        });
    }

    function onListClick(e) {
        var mail = e.target.closest ? e.target.closest('.cmt-mail') : null;
        if (mail) { Tool.copy(mail.getAttribute('data-copy'), '邮箱已复制'); return; }

        var head = e.target.closest ? e.target.closest('.pg-head') : null;
        if (head && !e.target.closest('a')) {
            var g = head.parentNode, url = g.getAttribute('data-url');
            if (g.classList.contains('collapsed')) { delete state.collapsed[url]; g.classList.remove('collapsed'); }
            else { state.collapsed[url] = 1; g.classList.add('collapsed'); }
            persistUi();
            return;
        }

        var act = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!act) return;
        var what = act.getAttribute('data-act');

        if (what === 'cancel') { state.editorKey = null; renderList(); return; }
        if (what === 'submit') { submitEditor(act.closest('.editor')); return; }
        if (what === 'kids') {
            var kidId = act.getAttribute('data-id');
            state.collapsed['kids:' + kidId] = 1;
            renderList();
            return;
        }

        var c = commentOf(act);
        if (!c) return;
        if (what === 'reply' || what === 'edit') {
            var key = what + ':' + c.id;
            state.editorKey = state.editorKey === key ? null : key;
            renderList();
            if (state.editorKey) focusEditor(c.id);
        } else if (what === 'del') {
            deleteWithKids(c).catch(function (err) { Tool.toast('删除失败：' + err.message, 'err', 4600); });
        }
    }

    function persistUi() {
        lsSet(LS.ui, JSON.stringify({ collapsed: state.collapsed, filter: state.filter }));
    }

    function bind() {
        $('list').addEventListener('click', onListClick);
        $('list').addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                var ed = e.target.closest ? e.target.closest('.editor') : null;
                if (ed) { e.preventDefault(); submitEditor(ed); }
            } else if (e.key === 'Escape' && e.target.closest && e.target.closest('.editor')) {
                state.editorKey = null;
                renderList();
            }
        });

        $('statsBar').addEventListener('click', function (e) {
            var chip = e.target.closest ? e.target.closest('.stat-chip') : null;
            if (!chip) return;
            var f = chip.getAttribute('data-filter');
            if (f === '__none') return;
            state.filter = (state.filter === f && f !== 'all') ? 'all' : f;
            persistUi();
            renderAll();
        });

        $('search').addEventListener('input', Tool.debounce(function () {
            state.q = $('search').value || '';
            renderAll();
        }, 160));

        $('btnReload').addEventListener('click', function () { load(true); });
        $('btnExpand').addEventListener('click', function () { state.collapsed = {}; persistUi(); renderList(); });
        $('btnCollapse').addEventListener('click', function () {
            buildTree().roots.forEach(function (r) { state.collapsed[normUrl(r.url)] = 1; });
            persistUi(); renderList();
        });
        $('btnMarkRead').addEventListener('click', function () {
            rememberSeen(); renderAll(); Tool.toast('已把当前评论标记为已读');
        });

        $('btnSettings').addEventListener('click', function () {
            $('ownerBox').classList.toggle('hidden');
        });
        $('btnSaveOwner').addEventListener('click', function () {
            state.owner = {
                nick: $('ownerNick').value.trim() || '墨晓晓',
                mail: $('ownerMail').value.trim(),
                link: $('ownerLink').value.trim()
            };
            lsSet(LS.owner, JSON.stringify(state.owner));
            renderAll();
            Tool.toast('回复身份已保存', 'ok');
        });

        /* 账号登录界面已移除（新后端只有站长令牌） */

        $('btnUseKey').addEventListener('click', function () {
            var k = $('secretInput').value.trim();
            if (!k) { Tool.setStatus($('secretStatus'), 'err', '请填写站长令牌'); return; }
            var btn = $('btnUseKey');
            btn.disabled = true;
            state.auth.masterKey = k;   // 让 writeHeaders 能签名
            Tool.setStatus($('secretStatus'), 'info', '正在校验…');
            verifyMasterKey(k).then(function () {
                state.auth.masterKey = '';
                useMasterKey(k, $('rememberAuth2').checked);
                Tool.setStatus($('secretStatus'), 'ok', '站长令牌可用，写入权限已开启');
                $('secretInput').value = '';
            }).catch(function (e) {
                state.auth.masterKey = '';
                Tool.setStatus($('secretStatus'), 'err', '校验失败：' + e.message);
            }).then(function () { btn.disabled = false; });
        });

        $('btnSignOut').addEventListener('click', signOut);
    }

    /* ---------------------------------------------------------- 启动 */
    function init() {
        state.postMap = global.__POST_MAP__ || {};

        try {
            var ui = JSON.parse(lsGet(LS.ui, '{}'));
            if (ui && typeof ui === 'object') {
                state.collapsed = ui.collapsed || {};
                state.filter = ui.filter || 'all';
            }
        } catch (e) { /* 忽略 */ }
        try { state.owner = JSON.parse(lsGet(LS.owner, '')) || state.owner; } catch (e) { /* 忽略 */ }
        state.owner = { nick: state.owner.nick || '墨晓晓', mail: state.owner.mail || '', link: state.owner.link || '' };
        $('ownerNick').value = state.owner.nick;
        $('ownerMail').value = state.owner.mail;
        $('ownerLink').value = state.owner.link;

        state.seenAt = parseInt(lsGet(LS.seen, '0'), 10) || 0;
        try { state.knownIds = JSON.parse(lsGet(LS.known, '{}')) || {}; } catch (e) { state.knownIds = {}; }

        var mode = lsGet(LS.credMode, ''), secret = lsGet(LS.secret, ''), session = lsGet(LS.session, '');
        if (mode === 'session' && session) {
            state.auth = { mode: 'master', masterKey: session, sessionToken: '', name: '站长令牌' };
        } else if (mode === 'master' && secret) {
            try {
                state.auth = { mode: 'master', masterKey: decodeURIComponent(escape(atob(secret))), sessionToken: '', name: 'masterKey' };
            } catch (e) { lsDel(LS.secret); }
        }
        $('rememberAuth2').checked = !!secret;

        bind();
        refreshAuthUi();
        load(false);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    global.CommentsApp = {
        state: state,
        load: load,
        render: renderAll,
        normUrl: normUrl,
        postInfo: postInfo,
        postHref: postHref,
        md5hex: md5hex,
        avatarUrl: avatarUrl,
        buildTree: buildTree,
        isNew: isNew,
        isOwner: isOwner,
        todoOf: todoOf,
        maskMail: maskMail,
        timeText: timeText,
        inlineHtml: inlineHtml,
        bodyHtml: bodyHtml,
        sign: sign,
        login: login,
        useMasterKey: useMasterKey,
        verifyMasterKey: verifyMasterKey,
        confirmBox: confirmBox,
        deleteWithKids: deleteWithKids,
        postReply: postReply,
        editComment: editComment,
        descendantCount: descendantCount,
        normComment: normComment,
        errText: errText
    };
})(window);
