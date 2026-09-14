/* ==========================================================================
   访问计数接口层 (assets/web/stats/js/api.js)

   只负责访问计数：打点、读单页、读全站排行。
   后端是自建的 Cloudflare Worker（见仓库 cf/ 目录）。
   ========================================================================== */
(function (global) {
    'use strict';

    var ENDPOINT = 'https://mxx23-blog.mxx23.workers.dev';

    function qs (params) {
        var parts = [];
        Object.keys(params || {}).forEach(function (k) {
            var v = params[k];
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    function request (method, path, body) {
        var opt = { method: method };
        if (body != null) {
            opt.headers = { 'Content-Type': 'application/json' };
            opt.body = JSON.stringify(body);
        }
        return fetch(ENDPOINT + path, opt).then(function (r) {
            return r.text().then(function (t) {
                var b = null;
                try { b = t ? JSON.parse(t) : null; } catch (e) { b = null; }
                if (!r.ok) {
                    var msg = (b && (b.error || b.message)) || ('HTTP ' + r.status);
                    var err = new Error(msg);
                    err.status = r.status;
                    throw err;
                }
                return b;
            });
        });
    }

    /** 归一化路径：去掉结尾斜杠、去掉前缀 /mxx23，并做百分号解码 */
    function normPath (u) {
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

    var StatsApi = {
        ENDPOINT: ENDPOINT,
        normPath: normPath,

        /** 记一次访问（同一会话同一路径只记一次；失败静默） */
        hit: function (path) {
            var p = normPath(path) || '/';
            var seenKey = 'pv-hit:' + p;
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

        /** 全站概览 + 热门（带类型） */
        site: function (hot) {
            return request('GET', '/api/stats' + qs({ hot: hot || 10 }));
        },

        /** 排行榜：博文与工具分开，含今日 / 近 N 天 / 总计 */
        rank: function (opts) {
            opts = opts || {};
            return request('GET', '/api/stats/rank' + qs({ days: opts.days || 30, limit: opts.limit || 200 }));
        }
    };

    global.StatsApi = StatsApi;
})(window);
