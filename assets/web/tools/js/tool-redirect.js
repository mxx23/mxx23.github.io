/* ==========================================================================
   工具页跳转脚本 (assets/web/tools/js/tool-redirect.js)
   用途：让博客里的“工具介绍”文章自动跳到对应的工具页面。
   用法：文章正文里放一个指向 /assets/web/tools/xxx.html 的链接，
         然后在正文末尾引入本脚本即可（取第一个匹配的链接作为跳转目标）。

   说明：
     - 用 location.replace，不留历史记录，避免“后退又跳回来”的死循环；
     - 想在原文章页面停留而不跳转时，在网址后面加 ?noredirect=1 即可。
   ========================================================================== */
(function () {
    'use strict';

    /* 允许用 ?noredirect=1 临时关闭跳转（方便查看/编辑文章本身） */
    if (/[?&]noredirect=1(&|$)/.test(window.location.search)) return;

    var link = document.querySelector('a[href*="/assets/web/tools/"]');
    if (!link) return;

    var target = link.getAttribute('href');
    if (!target) return;

    window.location.replace(target);
})();
