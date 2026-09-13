/* ==========================================================================
   全站访问计数 + 首页热门文章 (assets/web/comments/js/view.js)

   两件事：
     1) 每个页面记一次访问（同一会话同一页面只记一次）
     2) 在首页插入「热门文章」榜单

   文章标题映射使用 js/post-map.js 生成的 window.__POST_MAP__。
   通过主题的 custom_js 在所有页面加载。
   ========================================================================== */
(function (global) {
    'use strict';

    var Back = global.CmtApi;
    if (!Back) return;

    /* 注意：post-map.js 在本文件之后加载，不能在加载时就固定成常量，
       否则拿到的永远是空表。每次都现取。 */
    function postMap () { return global.__POST_MAP__ || {}; }

    /* 映射表的键带结尾斜杠（/a/b/），而计数接口存的是不带斜杠的（/a/b），
       两种写法都要能查到；顺带兼容百分号编码。 */
    function postEntry (p) {
        var map = postMap();
        var bases = [p];
        if (p && p.charAt(p.length - 1) !== '/') bases.push(p + '/');
        else if (p && p.length > 1) bases.push(p.replace(/\/+$/, ''));
        for (var i = 0; i < bases.length; i++) {
            var k = bases[i];
            if (map[k]) return map[k];
            try { if (map[decodeURIComponent(k)]) return map[decodeURIComponent(k)]; } catch (e) { /* 忽略 */ }
        }
        return null;
    }

    function normPath () {
        return Back.normPath(global.location.pathname) || '/';
    }

    /* 只有能对应到一篇文章的路径才算内容页：
       工具页、评论区、分页列表、首页都不算 */
    function isContentPath (p) {
        if (!p || p === '/') return false;
        if (p.indexOf('/assets/') === 0) return false;
        if (p.indexOf('/tools') === 0) return false;
        if (p.indexOf('/comments') === 0) return false;
        if (p.indexOf('/page/') === 0) return false;
        return !!postEntry(p);
    }

    function titleOf (path) {
        var hit = postEntry(path);
        if (hit && hit.title) return hit.title;
        var seg = path.split('/').filter(Boolean).pop() || path;
        try { return decodeURIComponent(seg); } catch (e) { return seg; }
    }

    function hrefOf (path) {
        return Back.pathToHref(path);
    }

    function fmt (n) {
        n = Number(n) || 0;
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /* ------------------------------------------------- 文章页：阅读次数 */
    function mountPostViews () {
        var anchor = document.querySelector('.post-content, #post-content, article.post, .markdown-body');
        if (!anchor || document.getElementById('postViewCount')) return;
        var p = normPath();
        if (!isContentPath(p)) return;

        var el = document.createElement('p');
        el.id = 'postViewCount';
        el.className = 'post-view-count';
        el.textContent = '';
        anchor.parentNode.insertBefore(el, anchor.nextSibling);

        Back.Stats.page(p).then(function (s) {
            var total = (s && s.total) || 0;
            if (!total) { el.textContent = ''; return; }
            el.textContent = '本文共被阅读 ' + fmt(total) + ' 次';
        }).catch(function () { el.textContent = ''; });
    }

    /* ------------------------------------------------- 首页：热门文章 */
    function mountHomeHot () {
        var p = normPath();
        if (p !== '/') return;
        if (document.getElementById('homeHot')) return;
        var main = document.querySelector('main');
        if (!main) return;

        var box = document.createElement('section');
        box.id = 'homeHot';
        box.className = 'home-hot';
        box.innerHTML = '<h3>🔥 热门文章</h3><ol id="homeHotList"><li class="n">正在读取…</li></ol>';

        var footer = document.querySelector('footer');
        if (footer && footer.parentNode) footer.parentNode.insertBefore(box, footer);
        else main.appendChild(box);

        Back.Stats.site(10).then(function (s) {
            var hot = (s && s.hot ? s.hot : []).filter(function (h) {
                return isContentPath(h.path);
            }).slice(0, 8);
            var list = document.getElementById('homeHotList');
            if (!list) return;
            if (!hot.length) {
                list.innerHTML = '<li class="n">还没有文章访问记录（统计从后端上线后开始累积）。</li>';
                return;
            }
            list.innerHTML = hot.map(function (h) {
                return '<li><a href="' + hrefOf(h.path) + '">' + escapeHtml(titleOf(h.path)) + '</a>' +
                    '<span class="n">' + fmt(h.views) + ' 次' +
                    (h.comments ? ' · ' + h.comments + ' 条评论' : '') + '</span></li>';
            }).join('');
        }).catch(function () {
            var list = document.getElementById('homeHotList');
            if (list) list.innerHTML = '<li class="n">读不到统计数据。</li>';
        });
    }

    function escapeHtml (s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function start () {
        var p = normPath();
        /* 记一次访问（工具页与本地预览也记，方便自己看数据） */
        Back.Stats.hit(p).catch(function () { });
        mountPostViews();
        mountHomeHot();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})(window);
