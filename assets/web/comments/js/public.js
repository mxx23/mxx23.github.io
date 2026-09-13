/* ==========================================================================
   评论区（公开页）逻辑 (assets/web/comments/js/public.js)
   给访问博客的人用：看全站评论、自己发评论、回复别人。

   数据与文章页面下的评论区完全一致 —— 都读写同一份评论数据，
   所以这里发的评论，在对应文章页面下也会出现。

   不需要注册、不需要登录；具体请求由 js/api.js 统一发出，
   页面里不持有任何可写的密钥。
   ========================================================================== */
(function (global) {
    'use strict';

    /* 后端接口层（自建 Cloudflare Worker，取代 LeanCloud）。 */
    var Back = global.CmtApi;
    var SITE = Back.SITE;

    /* 站点作者在评论区的常用昵称，用来打“站长”标记 */
    var OWNER_NICK = '墨晓晓';

    /* 与文章页评论区一致的节奏：两次发布至少隔 20 秒 */
    var COOLDOWN_MS = 20000;
    /* 发出去之后可以自己撤回的时间窗 */
    var RETRACT_MS = 60000;
    /* 公共讨论区（不挂在某篇文章下）用的路径 */
    var GENERAL_PATH = '/comments/';
    var GENERAL_LABEL = '公共讨论区';

    var MAX_FETCH = 3000;
    var PAGE_SIZE = 1000;

    var LS = {
        me: 'cmt-visitor',          // 昵称 / 邮箱 / 网站
        mine: 'cmt-visitor-ids',    // 本机发过的评论 id
        ui: 'cmt-public-ui',        // 排序、折叠
        draft: 'cmt-draft'          // 未发出去的内容草稿
    };

    var $ = function (id) { return document.getElementById(id); };
    var esc = function (s) { return Tool.escapeHtml(s == null ? '' : String(s)); };

    var state = {
        comments: [],
        byId: {},
        postMap: {},
        me: { nick: '', mail: '', link: '' },
        mine: {},                   // { id: { t: 发帖时间 } }
        replyTo: null,              // 正在回复的评论对象
        q: '',
        sort: 'new',
        onlyMine: false,
        collapsed: {},
        lastPostAt: 0,
        lastBody: '',
        loading: false
    };

    /* ------------------------------------------------------------ 本地存储 */
    function lsGet(k, d) {
        try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; }
    }
    function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }
    function jsonGet(k, d) { try { return JSON.parse(lsGet(k, '')) || d; } catch (e) { return d; } }

    /* ------------------------------------------------------------ 接口 */
    function errText(body, status) {
        var msg = (body && (body.error || body.message)) || '';
        return msg || ('HTTP ' + status);
    }

    /* ------------------------------------------------------------ 路径与标题 */
    function normUrl(u) {
        var s = String(u || '').trim();
        s = s.replace(/^https?:\/\/[^/]+/i, '');
        s = s.replace(/^\/mxx23(?=\/)/i, '');
        if (s.indexOf('?') >= 0) s = s.slice(0, s.indexOf('?'));
        if (s && s.charAt(0) !== '/') s = '/' + s;
        return s || '/';
    }

    /* 映射键带结尾斜杠（/a/b/），计数路径不带（/a/b）：两种写法都要能查到 */
    function postEntry (n) {
        var bases = [n];
        if (n && n.charAt(n.length - 1) !== '/') bases.push(n + '/');
        else if (n && n.length > 1) bases.push(n.replace(/\/+$/, ''));
        for (var i = 0; i < bases.length; i++) {
            var k = bases[i];
            var plain = k, encoded = k;
            try { plain = decodeURIComponent(k); } catch (e) { /* 忽略 */ }
            try { encoded = plain.split('/').map(encodeURIComponent).join('/'); } catch (e) { /* 忽略 */ }
            if (state.postMap[k]) return state.postMap[k];
            if (state.postMap[plain]) return state.postMap[plain];
            if (state.postMap[encoded]) return state.postMap[encoded];
        }
        return null;
    }

    function postInfo(url) {
        var n = normUrl(url);
        if (n === GENERAL_PATH) return { title: GENERAL_LABEL, path: n, general: true };
        var hit = postEntry(n);
        var plain = n;
        try { plain = decodeURIComponent(n); } catch (e) { /* 保持原样 */ }
        return hit ? { title: hit.title, path: n } : { title: plain, path: n, unknown: true };
    }

    function postHref(url) {
        var n = normUrl(url);
        if (n === GENERAL_PATH) return null;
        if (postEntry(n)) return SITE + n.split('/').map(encodeURIComponent).join('/') + '/';
        return null;
    }

    /* ------------------------------------------------------------ 文本渲染 */
    function inlineHtml(text) {
        var out = '', last = 0, m;
        var re = /(`[^`\n]+`|https?:\/\/[^\s<>"']+|@[A-Za-z0-9_\u4e00-\u9fa5-]{1,20})/g;
        while ((m = re.exec(text))) {
            out += esc(text.slice(last, m.index));
            var tok = m[0];
            if (tok.charAt(0) === '`') out += '<code>' + esc(tok.slice(1, -1)) + '</code>';
            else if (tok.charAt(0) === '@') out += '<span class="mention">' + esc(tok) + '</span>';
            else out += '<a href="' + esc(tok) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(tok) + '</a>';
            last = m.index + tok.length;
        }
        return out + esc(text.slice(last));
    }

    function bodyHtml(text) {
        if (!text) return '<p class="cmt-text"><span class="cmt-empty">（空内容）</span></p>';
        var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
        return '<p class="cmt-text">' + lines.map(inlineHtml).join('\n') + '</p>';
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

    /* 头像与文章页评论区一致：邮箱 MD5，没有邮箱就用昵称 */
    function avatarUrl(c) {
        var key = String((c.mail && c.mail.indexOf('@') > 0 ? c.mail : (c.nick || c.id || ''))).trim().toLowerCase();
        return 'https://gravatar.loli.net/avatar/' + md5hex(key) + '?d=retro&s=76';
    }

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
            a = hh(a, b, c, d, x[i + 13], 4, 681279174); d = hh(d, a, b, c, x[i + 12], 11, -358537222);
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

    /* ------------------------------------------------------------ 组装树 */
    function normComment(c) {
        return {
            id: c.objectId || c.id,
            nick: c.nick || '匿名',
            mail: c.mail || '',
            link: c.link || '',
            qq: c.QQAvatar || '',
            comment: c.comment == null ? '' : String(c.comment),
            url: c.url || '',
            pid: c.parent || c.pid || '',
            rid: c.rid || '',
            /* 后端给的是 epoch 毫秒数字；归一成 ISO 字符串，排序逻辑不必改 */
            at: typeof c.createdAt === 'number'
                ? new Date(c.createdAt).toISOString()
                : (c.createdAt || c.insertedAt || ''),
            raw: c
        };
    }

    function buildTree() {
        var roots = [], kids = {};
        state.comments.forEach(function (c) {
            if (c.pid && state.byId[c.pid]) (kids[c.pid] || (kids[c.pid] = [])).push(c);
            else roots.push(c);
        });
        Object.keys(kids).forEach(function (k) {
            kids[k].sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        });
        roots.sort(function (a, b) {
            var r = String(a.at).localeCompare(String(b.at));
            return state.sort === 'new' ? -r : r;
        });
        return { roots: roots, kids: kids };
    }

    function isOwner(c) { return c.nick === OWNER_NICK; }
    function isMine(c) { return !!state.mine[c.id]; }
    function canRetract(c) {
        var rec = state.mine[c.id];
        return !!rec && (Date.now() - rec.t) < RETRACT_MS;
    }

    function match(c) {
        if (state.onlyMine && !isMine(c)) return false;
        var q = state.q.trim().toLowerCase();
        if (!q) return true;
        var info = postInfo(c.url);
        return (c.nick + ' ' + c.comment + ' ' + info.title + ' ' + c.url).toLowerCase().indexOf(q) >= 0;
    }

    /* ------------------------------------------------------------ 渲染 */
    function renderList() {
        var tree = buildTree();
        var kids = tree.kids;
        var groups = {};
        tree.roots.forEach(function (r) {
            var u = normUrl(r.url);
            (groups[u] || (groups[u] = [])).push(r);
        });

        var keys = Object.keys(groups).sort(function (a, b) {
            var ta = groups[a][0] ? groups[a][0].at : '', tb = groups[b][0] ? groups[b][0].at : '';
            var r = String(ta).localeCompare(String(tb));
            return state.sort === 'new' ? -r : r;
        });

        var shown = 0, total = 0;
        var html = keys.map(function (url) {
            var roots = groups[url].filter(function (r) {
                return match(r) || (kids[r.id] || []).some(match);
            });
            if (!roots.length) return '';
            shown++;
            var info = postInfo(url);
            var count = roots.reduce(function (n, r) { return n + 1 + (kids[r.id] || []).length; }, 0);
            total += count;
            var newest = groups[url].reduce(function (acc, r) {
                var all = [r].concat(kids[r.id] || []);
                return all.reduce(function (a, c) { return String(c.at) > String(a) ? c.at : a; }, acc);
            }, '');
            var href = postHref(url);

            return '<div class="page-group' + (state.collapsed[url] ? ' collapsed' : '') + '" data-url="' + esc(url) + '">' +
                '<div class="pg-head">' +
                '<span class="pg-caret">▼</span>' +
                '<span class="pg-title">' + esc(info.title) + '</span>' +
                (info.general ? '<span class="badge gray">公共</span>' : '') +
                (info.unknown ? '<span class="badge gray" title="当前站点文章列表里没有这条路径">旧链接</span>' : '') +
                '<span class="pg-path">' + esc(info.general ? '' : url) + '</span>' +
                '<span class="pg-meta">' +
                '<span class="badge">' + count + ' 条</span>' +
                '<span>' + esc(timeText(newest)) + '</span>' +
                (href ? '<a class="link-btn" href="' + esc(href) + '">去文章页 ↗</a>' : '') +
                '<button class="link-btn" data-act="post-here" data-url="' + esc(url) + '">在这里留言</button>' +
                '</span></div>' +
                '<div class="pg-body">' + roots.map(function (r) { return commentHtml(r, 0, kids); }).join('') + '</div>' +
                '</div>';
        }).join('');

        $('list').innerHTML = html || '<div class="empty">' +
            (state.comments.length ? '没有符合当前条件的评论' : '还没有评论，来坐个沙发？') + '</div>';
        $('listMeta').textContent = shown + ' 个讨论串 / 显示 ' + total + ' 条';
    }

    function commentHtml(c, depth, kids) {
        var mine = isMine(c), owner = isOwner(c);
        var children = kids[c.id] || [];
        var cls = ['cmt'];
        if (depth > 0) cls.push('is-reply');
        if (mine) cls.push('is-me');

        var badges = '';
        if (owner) badges += ' <span class="badge ok">站长</span>';
        if (mine) badges += ' <span class="badge">我</span>';
        if (children.length) badges += ' <span class="badge gray">' + children.length + ' 条回复</span>';

        var actions = '<button class="link-btn" data-act="reply" data-id="' + esc(c.id) + '">回复</button>';
        if (canRetract(c)) actions += '<button class="link-btn danger" data-act="retract" data-id="' + esc(c.id) + '">撤回</button>';

        var site = c.link && /^https?:\/\//i.test(c.link)
            ? ' <a href="' + esc(c.link) + '" target="_blank" rel="noopener noreferrer nofollow" style="color:var(--primary)">主页</a>'
            : '';

        var kidsHtml = children.length
            ? '<div class="cmt-kids">' + children.map(function (k) { return commentHtml(k, depth + 1, kids); }).join('') + '</div>'
            : '';

        return '<div class="' + cls.join(' ') + '" data-id="' + esc(c.id) + '" id="c-' + esc(c.id) + '">' +
            '<img class="cmt-avatar" alt="" loading="lazy" src="' + esc(avatarUrl(c)) + '" onerror="this.style.visibility=\'hidden\'">' +
            '<div class="cmt-main">' +
            '<div class="cmt-head">' +
            '<span class="cmt-nick' + (owner ? ' admin' : '') + '">' + esc(c.nick) + '</span>' + site +
            '<span title="' + esc(c.at) + '">' + esc(timeText(c.at)) + '</span>' + badges +
            '</div>' +
            bodyHtml(c.comment) +
            '<div class="cmt-foot">' +
            '<span class="spacer"></span><span class="cmt-actions">' + actions + '</span>' +
            '</div></div>' + kidsHtml + '</div>';
    }

    function render() {
        renderList();
        updateRateHint();
    }

    /* ------------------------------------------------------------ 读取 */
    function fetchAll() {
        return Back.Comments.fetchAll({ max: MAX_FETCH }).then(function (rows) {
            var list = rows.map(normComment);
            state.comments = list;
            state.byId = {};
            list.forEach(function (c) {
                state.byId[c.id] = c;
                /* 服务端认得这台设备发过的评论，据此重建「我的评论」 */
                if (c.raw && c.raw.isMine) state.mine[c.id] = { t: Date.parse(c.at) || 0 };
            });
            lsSet(LS.mine, JSON.stringify(state.mine));
        });
    }

    function load(silent) {
        if (state.loading) return Promise.resolve();
        state.loading = true;
        if (!silent) Tool.setStatus($('loadStatus'), 'info', '正在读取评论…');
        return fetchAll().then(function () {
            Tool.setStatus($('loadStatus'), 'ok', '已读取 ' + state.comments.length + ' 条评论');
            render();
            if (!silent) presetPostField();
        }).catch(function (e) {
            Tool.setStatus($('loadStatus'), 'err', '读取失败：' + e.message +
                '\n如果提示网络错误，先确认当前网络能不能访问评论服务。');
        }).then(function () {
            state.loading = false;
        });
    }

    /* ------------------------------------------------------------ 访问统计 */
    function fmt (n) {
        n = Number(n) || 0;
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** 只保留有对应文章的路径：
     *  排除公共讨论区、本页、工具页、分页列表等非文章页面 */
    function isPostPath (p) {
        var n = normUrl(p);
        var base = n.replace(/\/$/, "");
        if (!base || base === "/" || base === "/comments" || base === GENERAL_PATH) return false;
        if (base.indexOf("/assets/") === 0 || base.indexOf("/tools") === 0) return false;
        if (base.indexOf("/page/") === 0) return false;
        return !!postEntry(n);
    }

    function renderStats (s) {
        $('stTotal').textContent = fmt(s.totalPv);
        $('stToday').textContent = fmt(s.todayPv);
        $('stUv').textContent = fmt(s.todayUv);
        $('stPages').textContent = fmt(s.totalPages);
        var hot = (s.hot || []).filter(function (h) { return isPostPath(h.path); }).slice(0, 5);
        var box = $('hotList');
        if (!hot.length) {
            box.innerHTML = '<li class="hint">还没有访问记录（访问计数从这次部署开始累积，旧数据不在里面）。</li>';
            return;
        }
        box.innerHTML = hot.map(function (h) {
            var info = postInfo(h.path);
            var href = postHref(h.path);
            var title = info && info.title ? info.title : decodeURIComponent(h.path);
            var label = href ? '<a href="' + esc(href) + '">' + esc(title) + '</a>' : '<span>' + esc(title) + '</span>';
            return '<li>' + label +
                ' <span class="hint">' + fmt(h.views) + ' 次访问' +
                (h.comments ? ' · ' + h.comments + ' 条评论' : '') + '</span></li>';
        }).join('');
    }

    function loadStats () {
        /* 记一次本页访问（同一会话只记一次，失败不影响阅读） */
        Back.Stats.hit(GENERAL_PATH).catch(function () { });
        Back.Stats.site(8).then(renderStats).catch(function () {
            $('stTotal').textContent = '—';
            $('stToday').textContent = '—';
            $('stUv').textContent = '—';
            $('stPages').textContent = '—';
            $('hotList').innerHTML = '<li class="hint">读不到统计数据，可能是网络问题。</li>';
        });
    }

    /* ------------------------------------------------------------ 发表 */
    function updateRateHint() {
        var left = COOLDOWN_MS - (Date.now() - state.lastPostAt);
        var el = $('rateHint');
        var btn = $('btnPublish');
        if (left > 0) {
            el.textContent = '刚发过一条，' + Math.ceil(left / 1000) + ' 秒后可再发';
            btn.disabled = true;
        } else {
            el.textContent = '';
            btn.disabled = false;
        }
        return Math.max(0, left);
    }

    function validMail(s) { return /^[\w.\-+]+@([\w-]+\.)+[a-z]{2,}$/i.test(s); }
    function validLink(s) { return /^https?:\/\/\S+$/i.test(s); }

    function resolvePath() {
        var raw = ($('cPost').value || '').trim();
        if (!raw) return { path: GENERAL_PATH, info: postInfo(GENERAL_PATH) };
        if (raw === GENERAL_LABEL || raw === GENERAL_PATH) return { path: GENERAL_PATH, info: postInfo(GENERAL_PATH) };
        var key = normUrl(raw);
        var plain = key, encoded = key;
        try { plain = decodeURIComponent(key); } catch (e) { /* ignore */ }
        try { encoded = plain.split('/').map(encodeURIComponent).join('/'); } catch (e) { /* ignore */ }
        if (state.postMap[key]) return { path: key, info: postInfo(key) };
        if (state.postMap[plain]) return { path: plain, info: postInfo(plain) };
        if (state.postMap[encoded]) return { path: encoded, info: postInfo(encoded) };
        return null;
    }

    function fillPostList() {
        var keys = Object.keys(state.postMap);
        var opts = ['<option value="' + esc(GENERAL_LABEL) + '">与具体文章无关的闲聊</option>'];
        keys.sort().forEach(function (k) {
            opts.push('<option value="' + esc(decodeURIComponent(k)) + '">' + esc(state.postMap[k].title) + '</option>');
        });
        $('postList').innerHTML = opts.join('');
    }

    function presetPostField() {
        // 1) 网址带 ?post= 或 ?p= 时优先
        var q = global.location.search;
        var m = q.match(/[?&](?:post|p)=([^&]+)/);
        if (m) {
            var wanted = normUrl(decodeURIComponent(m[1]));
            var found = state.postMap[wanted] ? wanted
                : state.postMap[decodeURIComponent(wanted)] ? decodeURIComponent(wanted) : null;
            if (found) { $('cPost').value = decodeURIComponent(found); updatePostHint(); return; }
        }
        // 2) 最近有人评论的文章
        var newest = state.comments.reduce(function (acc, c) {
            if (normUrl(c.url) === GENERAL_PATH) return acc;
            return (!acc || String(c.at) > String(acc.at)) ? c : acc;
        }, null);
        if (newest) { $('cPost').value = decodeURIComponent(normUrl(newest.url)); }
        else { $('cPost').value = GENERAL_LABEL; }
        updatePostHint();
    }

    function updatePostHint() {
        var r = resolvePath();
        var el = $('postHint');
        if (!r) {
            el.innerHTML = '没有找到这篇文章（可以点上面的“用最新评论的那篇”，或从下拉里挑一个）。填 ' +
                '<b>' + esc(GENERAL_LABEL) + '</b> 就发到公共讨论区。';
            return;
        }
        if (r.info.general) {
            el.innerHTML = '会发到 <b>' + esc(GENERAL_LABEL) + '</b>：适合与某篇文章无关的闲聊，只在本页可见。';
        } else {
            el.innerHTML = '会发到《' + esc(r.info.title) + '》，文章页面下的评论区里也会出现。' +
                (r.info.unknown ? ' <span class="badge gray">这条路径当前站点里没有对应文章</span>' : '');
        }
    }

    function publish() {
        var body = ($('cBody').value || '').trim();
        var nick = ($('cNick').value || '').trim();
        var mail = ($('cMail').value || '').trim();
        var link = ($('cLink').value || '').trim();
        var trap = ($('cTrap').value || '').trim();

        if (trap) { Tool.setStatus($('postStatus'), 'err', '发布失败，请刷新页面后重试。'); return; }
        if (!body) { Tool.setStatus($('postStatus'), 'err', '内容不能为空。'); $('cBody').focus(); return; }
        if (body.length > 4000) { Tool.setStatus($('postStatus'), 'err', '内容太长了（超过 4000 字），精简一下再发。'); return; }
        if (mail && !validMail(mail)) { Tool.setStatus($('postStatus'), 'err', '邮箱格式看起来不对，或者留空。'); return; }
        if (link && !validLink(link)) { Tool.setStatus($('postStatus'), 'err', '网站要写成 https:// 开头，或者留空。'); return; }

        var left = COOLDOWN_MS - (Date.now() - state.lastPostAt);
        if (left > 0) { Tool.setStatus($('postStatus'), 'warn', '刚发过一条，再等 ' + Math.ceil(left / 1000) + ' 秒。'); return; }
        if (state.lastPostAt && body === state.lastBody && Date.now() - state.lastPostAt < 120000) {
            Tool.setStatus($('postStatus'), 'warn', '这条内容刚刚发过了，就没有重复发。');
            return;
        }

        var target = state.replyTo || null;
        var r = target ? { path: normUrl(target.url), info: postInfo(target.url) } : resolvePath();
        if (!r) { Tool.setStatus($('postStatus'), 'err', '请先选择一个要发到哪篇文章下。'); $('cPost').focus(); return; }

        var payload = {
            path: r.path,
            comment: body,                         // 内容原样提交，昵称单独存
            nick: nick || 'Anonymous',
            mail: mail,
            link: link,
            trap: trap
        };
        if (target) {
            payload.parent = target.id;
            if (!/^@/.test(body) && target.nick) payload.comment = '@' + target.nick + ' ' + body;
        }

        var btn = $('btnPublish');
        btn.disabled = true;
        Tool.setStatus($('postStatus'), 'info', '正在发布…');

        Back.Comments.post(payload).then(function (res) {
            var local = normComment(res);
            state.comments.push(local);
            state.byId[local.id] = local;
            state.mine[local.id] = { t: Date.now() };
            lsSet(LS.mine, JSON.stringify(state.mine));
            state.lastPostAt = Date.now();
            state.lastBody = body;

            saveMe(nick, mail, link);
            state.replyTo = null;
            $('cBody').value = '';
            lsSet(LS.draft, '');
            updateReplyBanner();
            updateBodyHint();
            updatePostHint();
            render();

            Tool.setStatus($('postStatus'), 'ok',
                '已发布到' + (r.info.general ? '「' + GENERAL_LABEL + '」' : '《' + r.info.title + '》') +
                '，一分钟内可以点自己那条评论下的「撤回」。');
            Tool.toast('评论已发布', 'ok');
            updateRateHint();
        }).catch(function (e) {
            Tool.setStatus($('postStatus'), 'err', '发布失败：' + e.message +
                '\n内容已经留在输入框里，可以直接重试。');
            btn.disabled = false;
        });
    }

    function saveMe(nick, mail, link) {
        state.me = { nick: nick, mail: mail, link: link };
        lsSet(LS.me, JSON.stringify(state.me));
    }

    function updateBodyHint() {
        var n = ($('cBody').value || '').length;
        $('bodyHint').textContent = n ? (n + ' 字') : '留个脚印吧。';
    }

    function updateReplyBanner() {
        var box = $('replyBanner');
        if (!state.replyTo) { box.classList.add('hidden'); $('composerHint').textContent = '不用注册，填好就能发'; return; }
        var info = postInfo(state.replyTo.url);
        $('replyBannerText').innerHTML = '正在回复 <b>' + esc(state.replyTo.nick) + '</b>：' +
            esc(state.replyTo.comment.slice(0, 60)) +
            ' <span class="hint">（会挂在《' + esc(info.title) + '》这条评论下面）</span>';
        box.classList.remove('hidden');
        $('composerHint').textContent = '回复模式';
    }

    /* ------------------------------------------------------------ 撤回 */
    function retract(c) {
        return confirmBox('撤回这条评论吗？\n\n' + c.comment.slice(0, 80) + '\n\n撤回后服务端也会删掉它。').then(function (ok) {
            if (!ok) return;
            return Back.Comments.retract(c.id).then(function () {
                delete state.byId[c.id];
                delete state.mine[c.id];
                lsSet(LS.mine, JSON.stringify(state.mine));
                state.comments = state.comments.filter(function (x) { return x.id !== c.id && x.pid !== c.id; });
                render();
                Tool.toast('已撤回', 'ok');
            }).catch(function (e) {
                Tool.toast('撤回失败：' + e.message, 'err', 4600);
            });
        });
    }

    /* ------------------------------------------------------------ 确认框 */
    function confirmBox(msg) {
        var modal = $('modal');
        $('modalText').textContent = msg;
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

    /* ------------------------------------------------------------ 交互 */
    function setReplyTarget(c) {
        state.replyTo = c;
        updateReplyBanner();
        var card = $('composerCard');
        if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('cBody').focus();
    }

    function onListClick(e) {
        var head = e.target.closest ? e.target.closest('.pg-head') : null;
        var act = e.target.closest ? e.target.closest('[data-act]') : null;

        if (act) {
            var what = act.getAttribute('data-act');
            if (what === 'post-here') {
                var url = act.getAttribute('data-url');
                $('cPost').value = url === GENERAL_PATH ? GENERAL_LABEL : decodeURIComponent(url);
                updatePostHint();
                setReplyTarget(null);
                var card = $('composerCard');
                if (card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
                $('cBody').focus();
                return;
            }
            var box = act.closest('.cmt');
            var c = box ? state.byId[box.getAttribute('data-id')] : null;
            if (!c) return;
            if (what === 'reply') { setReplyTarget(c); }
            else if (what === 'retract') { retract(c); }
            return;
        }

        if (head && !e.target.closest('a')) {
            var g = head.parentNode, u = g.getAttribute('data-url');
            if (g.classList.contains('collapsed')) { delete state.collapsed[u]; g.classList.remove('collapsed'); }
            else { state.collapsed[u] = 1; g.classList.add('collapsed'); }
            persistUi();
        }
    }

    function persistUi() {
        lsSet(LS.ui, JSON.stringify({ collapsed: state.collapsed, sort: state.sort }));
    }

    function bind() {
        $('list').addEventListener('click', onListClick);

        $('btnPublish').addEventListener('click', publish);
        $('btnCancelReply').addEventListener('click', function () {
            setReplyTarget(null);
            Tool.setStatus($('postStatus'), '');
        });
        $('btnPickLatest').addEventListener('click', function () {
            presetPostField();
            updatePostHint();
        });

        $('cBody').addEventListener('input', function () {
            updateBodyHint();
            lsSet(LS.draft, $('cBody').value || '');
        });
        $('cBody').addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); publish(); }
        });
        $('cPost').addEventListener('input', updatePostHint);
        ['cNick', 'cMail', 'cLink'].forEach(function (id) {
            $(id).addEventListener('change', function () {
                saveMe(($('cNick').value || '').trim(), ($('cMail').value || '').trim(), ($('cLink').value || '').trim());
            });
        });

        $('search').addEventListener('input', Tool.debounce(function () {
            state.q = $('search').value || '';
            renderList();
        }, 160));
        $('sortBy').addEventListener('change', function () {
            state.sort = $('sortBy').value;
            persistUi();
            renderList();
        });
        $('btnOnlyMine').addEventListener('click', function () {
            state.onlyMine = !state.onlyMine;
            $('btnOnlyMine').className = 'btn btn-sm' + (state.onlyMine ? ' btn-primary' : '');
            renderList();
        });
        $('btnExpand').addEventListener('click', function () { state.collapsed = {}; persistUi(); renderList(); });
        $('btnCollapse').addEventListener('click', function () {
            buildTree().roots.forEach(function (r) { state.collapsed[normUrl(r.url)] = 1; });
            persistUi(); renderList();
        });
    }

    /* ------------------------------------------------------------ 启动 */
    function init() {
        state.postMap = global.__POST_MAP__ || {};
        state.me = jsonGet(LS.me, { nick: '', mail: '', link: '' });
        state.mine = jsonGet(LS.mine, {});
        var ui = jsonGet(LS.ui, {});
        state.collapsed = ui.collapsed || {};
        state.sort = ui.sort === 'old' ? 'old' : 'new';

        // 清掉过期的“我的评论”记录（超过一天的没必要一直留着）
        var cutoff = Date.now() - 24 * 3600 * 1000, kept = {};
        Object.keys(state.mine).forEach(function (id) {
            if (state.mine[id] && state.mine[id].t > cutoff) kept[id] = state.mine[id];
        });
        state.mine = kept;
        lsSet(LS.mine, JSON.stringify(state.mine));

        $('cNick').value = state.me.nick || '';
        $('cMail').value = state.me.mail || '';
        $('cLink').value = state.me.link || '';
        $('cBody').value = lsGet(LS.draft, '');
        $('sortBy').value = state.sort;

        // 站长在这台设备上登录过才显示管理入口
        if (lsGet('cmt-auth-mode', '') || lsGet('cmt-master', '')) {
            $('adminEntry').classList.remove('hidden');
        }

        fillPostList();
        bind();
        updateBodyHint();
        updateReplyBanner();
        load(false);
        loadStats();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    global.PublicComments = {
        state: state,
        load: load,
        loadStats: loadStats,
        render: render,
        publish: publish,
        retract: retract,
        buildTree: buildTree,
        normUrl: normUrl,
        postInfo: postInfo,
        postHref: postHref,
        resolvePath: resolvePath,
        fillPostList: fillPostList,
        presetPostField: presetPostField,
        updatePostHint: updatePostHint,
        avatarUrl: avatarUrl,
        md5hex: md5hex,
        inlineHtml: inlineHtml,
        bodyHtml: bodyHtml,
        timeText: timeText,
        isMine: isMine,
        canRetract: canRetract,
        confirmBox: confirmBox,
        setReplyTarget: setReplyTarget,
        GENERAL_PATH: GENERAL_PATH,
        GENERAL_LABEL: GENERAL_LABEL,
        COOLDOWN_MS: COOLDOWN_MS,
        RETRACT_MS: RETRACT_MS
    };
})(window);
