/* ==========================================================================
   访问计数打点 + 文章页阅读数 (assets/web/stats/js/post-views.js)

   每个页面记一次访问（同一会话同一页面只记一次），并在文章页显示阅读次数。
   首页的「热门榜单」和详细的排行都在统计页 /assets/web/stats/ 里。

   通过主题的 custom_js 在所有页面加载。
   ========================================================================== */
(function (global) {
    'use strict';

    var Back = global.StatsApi;
    if (!Back) return;

    var POST_MAP = function () { return global.__POST_MAP__ || {}; };

    function normPath () {
        return Back.normPath(global.location.pathname) || '/';
    }

    /* 只有博文才算「内容页」：工具页、列表页、统计页都不算 */
    function isPost (p) {
        return /^\/\d{4}\/\d{2}\//.test(p);
    }

    function fmt (n) {
        n = Number(n) || 0;
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /* 在文章正文之后显示「本文共被阅读 N 次」 */
    function mountPostViews () {
        var anchor = document.querySelector('.post-content');
        if (!anchor || document.getElementById('postViewCount')) return;
        var p = normPath();
        if (!isPost(p)) return;

        var el = document.createElement('p');
        el.id = 'postViewCount';
        el.className = 'post-view-count';
        el.style.cssText = 'font-size:12.5px;color:#8b949e;margin:10px 0 0';
        el.textContent = '';
        anchor.parentNode.insertBefore(el, anchor.nextSibling);

        Back.page(p).then(function (s) {
            var total = (s && s.total) || 0;
            if (!total) { el.textContent = ''; return; }
            el.textContent = '本文共被阅读 ' + fmt(total) + ' 次';
        }).catch(function () { el.textContent = ''; });
    }

    function start () {
        var p = normPath();
        Back.hit(p).catch(function () { });
        mountPostViews();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(window);
