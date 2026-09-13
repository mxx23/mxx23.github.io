/* ==========================================================================
   独立页面跳转脚本 (assets/web/tools/js/tool-redirect.js)
   用途：让博客里的“介绍文章”自动跳到对应的独立页面
        （工具页在 /assets/web/tools/，评论管理页在 /assets/web/comments/）。
   用法：文章正文里放一个指向该独立页面的链接，
         然后在正文末尾引入本脚本即可（取第一个匹配的链接作为跳转目标）。

   说明：
     - 用 location.replace，不留历史记录，避免“后退又跳回来”的死循环；
     - 想在原文章页面停留而不跳转时，在网址后面加 ?noredirect=1 即可。
   ========================================================================== */
(function () {
    'use strict';

    /* 允许用 ?noredirect=1 临时关闭跳转（方便查看/编辑文章本身） */
    if (/[?&]noredirect=1(&|$)/.test(window.location.search)) return;

    /* 独立页面都放在 /assets/web/ 下面：tools/ 是工具，comments/ 是评论管理 */
    var link = document.querySelector('a[href*="/assets/web/"]');
    if (!link) return;

    var target = link.getAttribute('href');
    if (!target) return;

    window.location.replace(target);
})();
