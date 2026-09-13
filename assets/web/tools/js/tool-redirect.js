/* ==========================================================================
   独立页面跳转脚本 (assets/web/tools/js/tool-redirect.js)

   用途：让博客里介绍工具/评论区的「跳转文章」自动跳到对应的独立页面。

   用法：文章正文里放一个指向该独立页面的链接，然后在正文末尾引入本脚本。

   为什么不能简单地抓「页面里第一个 /assets/web/ 链接」：
     文章页的导航栏和页脚里就有「评论区」入口，而它在 DOM 里排在正文之前，
     那样抓会把所有文章都跳去评论区。所以这里只在正文容器里找，
     并且跳过指向当前页面的链接。
   ========================================================================== */
(function () {
    'use strict';

    /* 允许用 ?noredirect=1 临时关闭跳转（方便查看/编辑文章本身） */
    if (/[?&]noredirect=1(&|$)/.test(window.location.search)) return;

    /* 只看正文，不看导航栏 / 页脚 / 侧栏 */
    var containers = ['.markdown-body', '.post-content', '#post-content', 'article.post-content'];
    var root = null;
    for (var i = 0; i < containers.length; i++) {
        root = document.querySelector(containers[i]);
        if (root) break;
    }
    if (!root) return;

    var links = root.querySelectorAll('a[href*="/assets/web/"]');
    var here = window.location.pathname.replace(/\/+$/, '');

    for (var j = 0; j < links.length; j++) {
        var target = links[j].getAttribute('href');
        if (!target) continue;
        /* 指向当前页面的链接不跳（否则会自己跳自己） */
        if (target.replace(/\/+$/, '') === here) continue;
        window.location.replace(target);
        return;
    }
})();
