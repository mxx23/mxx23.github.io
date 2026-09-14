/* ==========================================================================
   访问打点（工具页专用） (assets/web/tools/js/pv.js)

   为什么单独一个文件：
     工具页是独立的静态 HTML，不经过 Hexo 主题渲染，主题的 custom_js 注入不到它们里面，
     所以工具页的访问量需要靠这个自包含的小脚本来统计。

   实现注意：
     - 用 fetch + keepalive，不用 sendBeacon。beacon 发 blob 时会被跨域策略拦掉，
       而且失败是静默的（不产生可捕获的错误），排查起来很费劲（这里踩过一次）。
     - 失败不影响页面功能：统计丢了可以接受，页面不能因此报错。
   ========================================================================== */
(function (global) {
    'use strict';

    var ENDPOINT = 'https://mxx23-blog.mxx23.workers.dev';

    function normPath (u) {
        var s = String(u == null ? '' : u).trim();
        if (!s) return '';
        s = s.split('#')[0].split('?')[0];
        if (s.charAt(0) !== '/') s = '/' + s;
        try { s = decodeURIComponent(s); } catch (e) { /* 保持原样 */ }
        while (s.length > 1 && s.charAt(s.length - 1) === '/') s = s.slice(0, -1);
        return s;
    }

    function hit (path) {
        var p = normPath(path);
        if (!p) return;
        var key = 'pv-hit:' + p;
        try {
            if (sessionStorage.getItem(key)) return;   /* 同一会话同一页只记一次 */
            sessionStorage.setItem(key, '1');
        } catch (e) { /* 隐私模式下可能不可用，仍然记一次 */ }

        try {
            return fetch(ENDPOINT + '/api/stats/hit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: p,
                    referrer: String(global.document.referrer || '').slice(0, 300)
                }),
                keepalive: true
            }).catch(function () { /* 统计失败无所谓 */ });
        } catch (e) {
            return null;
        }
    }

    hit(global.location.pathname);
})(window);
