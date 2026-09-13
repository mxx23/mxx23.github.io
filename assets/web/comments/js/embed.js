/* ==========================================================================
   文章页嵌入式评论区 (assets/web/comments/js/embed.js)

   文章页面底部原本是 Valine（依赖 LeanCloud，2027-01-12 停服），
   这里换成自建后端的同一份评论数据 —— 与「评论区」汇总页看到的是同一批。

   只需要一个容器：<article id="comments">（Fluid 主题的文章页自带）。
   通过主题的 custom_js 在这些页面加载。
   ========================================================================== */
(function (global) {
    'use strict';

    var Back = global.CmtApi;
    if (!Back) return;

    var COOLDOWN_MS = 20000;
    var LS_ME = 'cmt-visitor';
    var LS_DRAFT = 'cmt-embed-draft';

    var $ = function (id) { return document.getElementById(id); };
    function esc (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    }); }
    function lsGet (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
    function lsSet (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 忽略 */ } }

    function me () {
        try { return JSON.parse(lsGet(LS_ME, '{}')) || {}; } catch (e) { return {}; }
    }

    /* 正文渲染：转义后高亮网址、`代码`、@提及 —— 与汇总页一致 */
    function bodyHtml (text) {
        var out = '', last = 0, m;
        var re = /(`[^`\n]+`|https?:\/\/[^\s<>"']+|@[A-Za-z0-9_\u4e00-\u9fa5-]{1,20})/g;
        var src = String(text == null ? '' : text);
        while ((m = re.exec(src))) {
            out += esc(src.slice(last, m.index));
            var tok = m[0];
            if (tok.charAt(0) === '`') out += '<code>' + esc(tok.slice(1, -1)) + '</code>';
            else if (tok.charAt(0) === '@') out += '<span class="cmt-embed-mention">' + esc(tok) + '</span>';
            else out += '<a href="' + esc(tok) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(tok) + '</a>';
            last = m.index + tok.length;
        }
        out += esc(src.slice(last));
        return out.split('\n').map(function (line) { return '<p>' + (line || '&nbsp;') + '</p>'; }).join('');
    }

    function tree (rows) {
        var byId = {}, roots = [], kids = {};
        rows.forEach(function (c) { c.id = c.objectId || c.id; byId[c.id] = c; });
        rows.forEach(function (c) {
            var p = c.parent || '';
            if (p && byId[p]) (kids[p] || (kids[p] = [])).push(c);
            else roots.push(c);
        });
        roots.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        Object.keys(kids).forEach(function (k) {
            kids[k].sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        });
        return { roots: roots, kids: kids };
    }

    function itemHtml (c, kids, depth) {
        var isMine = c.isMine === true;
        var owner = c.isOwner === true || Back.isOwnerNick(c.nick);
        var site = c.link && /^https?:\/\//i.test(c.link)
            ? ' <a href="' + esc(c.link) + '" target="_blank" rel="noopener noreferrer nofollow">主页</a>' : '';
        var children = kids[c.id] || [];
        var canRetract = isMine && c.canRetract === true;
        return '<div class="cmt-embed-item' + (depth ? ' is-child' : '') + '" data-id="' + esc(c.id) + '">' +
            '<img class="cmt-embed-avatar" alt="" loading="lazy" src="' + esc(Back.avatarUrl(c.nick, c.mail)) + '"' +
            ' onerror="this.style.visibility=\'hidden\'">' +
            '<div class="cmt-embed-main">' +
            '<div class="cmt-embed-head">' +
            '<b class="' + (owner ? 'is-owner' : '') + '">' + esc(c.nick) + '</b>' + site +
            '<span class="cmt-embed-time">' + esc(Back.timeText(c.createdAt)) + '</span>' +
            (owner ? '<span class="cmt-embed-badge">站长</span>' : '') +
            (isMine ? '<span class="cmt-embed-badge mine">我</span>' : '') +
            '</div>' +
            '<div class="cmt-embed-body">' + bodyHtml(c.comment) + '</div>' +
            '<div class="cmt-embed-foot">' +
            '<button type="button" class="cmt-embed-link" data-act="reply" data-id="' + esc(c.id) + '">回复</button>' +
            (canRetract ? '<button type="button" class="cmt-embed-link warn" data-act="retract" data-id="' + esc(c.id) + '">撤回</button>' : '') +
            '</div></div>' +
            (children.length ? '<div class="cmt-embed-kids">' +
                children.map(function (k) { return itemHtml(k, kids, depth + 1); }).join('') + '</div>' : '') +
            '</div>';
    }

    function render (mount, state) {
        var t = tree(state.comments);
        var list = $('cmtEmbedList');
        if (!state.comments.length) {
            list.innerHTML = '<p class="cmt-embed-empty">还没有人留言，来做第一个吧。</p>';
        } else {
            list.innerHTML = t.roots.map(function (c) { return itemHtml(c, t.kids, 0); }).join('');
        }
        var stat = $('cmtEmbedStat');
        if (stat) {
            stat.textContent = state.comments.length + ' 条评论' +
                (state.views == null ? '' : ' · ' + state.views + ' 次阅读');
        }
        updateRateHint(state);
    }

    function updateRateHint (state) {
        var left = COOLDOWN_MS - (Date.now() - state.lastPostAt);
        var hint = $('cmtEmbedHint');
        var btn = $('cmtEmbedSend');
        if (!hint || !btn) return;
        if (left > 0) {
            hint.textContent = '刚发过一条，' + Math.ceil(left / 1000) + ' 秒后可再发';
            btn.disabled = true;
            setTimeout(function () { updateRateHint(state); }, 1000);
        } else {
            hint.textContent = state.replyTo ? ('正在回复 ' + state.replyTo.nick + '，点这里取消') : '不用注册，填好就能发';
            hint.className = 'cmt-embed-hint' + (state.replyTo ? ' is-reply' : '');
            btn.disabled = false;
        }
    }

    function setStatus (msg, kind) {
        var el = $('cmtEmbedStatus');
        if (!el) return;
        el.textContent = msg || '';
        el.className = 'cmt-embed-status' + (kind ? ' is-' + kind : '');
    }

    /* 找插入点：文章正文之后。
       主题的内置评论组件已关闭（见 _config.fluid.yml 的 post.comments.enable），
       所以这里自己创建容器。 */
    function findMount () {
        var existing = document.getElementById('comments');
        if (existing) {
            existing.removeAttribute('lazyload');
            return existing;
        }
        var content = document.querySelector('.post-content');
        if (!content) return null;
        var box = document.createElement('article');
        box.id = 'comments';
        var markdown = content.querySelector('.markdown-body');
        var anchor = markdown || content.lastElementChild || null;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor.nextSibling);
        else content.appendChild(box);
        return box;
    }

    function init () {
        var mount = findMount();
        if (!mount) return;   // 不是文章页，什么都不做

        var path = Back.normPath(global.location.pathname) || '/';
        var state = { comments: [], views: null, lastPostAt: 0, replyTo: null, path: path };
        var m = me();

        mount.innerHTML = [
            '<div class="cmt-embed" id="cmtEmbed">',
            '  <div class="cmt-embed-head-bar">',
            '    <h2>评论</h2>',
            '    <span class="cmt-embed-stat" id="cmtEmbedStat">正在读取…</span>',
            '  </div>',
            '  <div id="cmtEmbedList" class="cmt-embed-list"><p class="cmt-embed-empty">正在读取评论…</p></div>',
            '  <div class="cmt-embed-form">',
            '    <div class="cmt-embed-row">',
            '      <input type="text" id="cmtEmbedNick" maxlength="24" placeholder="昵称（必填）" value="' + esc(m.nick || '') + '">',
            '      <input type="text" id="cmtEmbedMail" maxlength="64" placeholder="邮箱（选填，用于头像）" value="' + esc(m.mail || '') + '">',
            '      <input type="text" id="cmtEmbedLink" maxlength="120" placeholder="网站（选填）" value="' + esc(m.link || '') + '">',
            '    </div>',
            '    <textarea id="cmtEmbedBody" rows="4" placeholder="说点什么吧～ 支持换行，网址会自动变成链接"></textarea>',
            '    <div class="cmt-embed-actions">',
            '      <span class="cmt-embed-hint" id="cmtEmbedHint">不用注册，填好就能发</span>',
            '      <button type="button" class="cmt-embed-btn" id="cmtEmbedSend">发表评论</button>',
            '    </div>',
            '    <div class="cmt-embed-status" id="cmtEmbedStatus"></div>',
            '  </div>',
            '  <p class="cmt-embed-more">想看全站评论汇总、搜索和排行？去 <a href="/assets/web/comments/">评论区</a>。</p>',
            '</div>'
        ].join('\n');

        $('cmtEmbedBody').value = lsGet(LS_DRAFT, '');

        function load () {
            return Back.Comments.fetchFor(path, { limit: 1000 }).then(function (rows) {
                state.comments = rows;
                return Back.Stats.page(path).then(function (s) {
                    state.views = (s && s.total) || 0;
                }).catch(function () { state.views = null; });
            }).then(function () {
                render(mount, state);
            }).catch(function (e) {
                $('cmtEmbedList').innerHTML = '<p class="cmt-embed-empty">评论读取失败：' + esc(e.message) + '</p>';
                $('cmtEmbedStat').textContent = '';
            });
        }

        function send () {
            var body = ($('cmtEmbedBody').value || '').trim();
            var nick = ($('cmtEmbedNick').value || '').trim();
            var mail = ($('cmtEmbedMail').value || '').trim();
            var link = ($('cmtEmbedLink').value || '').trim();

            if (!nick) { setStatus('请填一个昵称。', 'err'); $('cmtEmbedNick').focus(); return; }
            if (!body) { setStatus('内容不能为空。', 'err'); $('cmtEmbedBody').focus(); return; }
            if (body.length > 4000) { setStatus('内容太长了（超过 4000 字）。', 'err'); return; }
            if (mail && !/^[\w.\-+]+@([\w-]+\.)+[a-z]{2,}$/i.test(mail)) { setStatus('邮箱格式看起来不对，或者留空。', 'err'); return; }
            if (link && !/^https?:\/\/\S+$/i.test(link)) { setStatus('网站要写成 https:// 开头，或者留空。', 'err'); return; }
            var left = COOLDOWN_MS - (Date.now() - state.lastPostAt);
            if (left > 0) { setStatus('刚发过一条，再等 ' + Math.ceil(left / 1000) + ' 秒。', 'warn'); return; }

            var payload = { path: path, comment: body, nick: nick, mail: mail, link: link };
            if (state.replyTo) {
                payload.parent = state.replyTo.id;
                if (!/^@/.test(body)) payload.comment = '@' + state.replyTo.nick + ' ' + body;
            }

            $('cmtEmbedSend').disabled = true;
            setStatus('正在发布…', 'info');
            Back.Comments.post(payload).then(function () {
                lsSet(LS_ME, JSON.stringify({ nick: nick, mail: mail, link: link }));
                lsSet(LS_DRAFT, '');
                state.replyTo = null;
                state.lastPostAt = Date.now();
                $('cmtEmbedBody').value = '';
                setStatus('已发布，一分钟内可以点自己那条下面的「撤回」。', 'ok');
                return load();
            }).catch(function (e) {
                setStatus('发布失败：' + e.message + '（内容还在输入框里）', 'err');
                $('cmtEmbedSend').disabled = false;
            });
        }

        mount.addEventListener('click', function (e) {
            var btn = e.target.closest ? e.target.closest('[data-act]') : null;
            if (!btn) return;
            var act = btn.getAttribute('data-act');
            var id = btn.getAttribute('data-id');
            var c = null;
            state.comments.forEach(function (x) { if ((x.objectId || x.id) === id) c = x; });
            if (!c) return;

            if (act === 'reply') {
                state.replyTo = c;
                updateRateHint(state);
                $('cmtEmbedBody').focus();
                if ($('cmtEmbed').scrollIntoView) $('cmtEmbed').scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
            if (act === 'retract') {
                if (!global.confirm('撤回这条评论吗？\n\n' + String(c.comment).slice(0, 80))) return;
                Back.Comments.retract(id).then(function () {
                    setStatus('已撤回。', 'ok');
                    return load();
                }).catch(function (err) { setStatus('撤回失败：' + err.message, 'err'); });
            }
        });

        $('cmtEmbedHint').addEventListener('click', function () {
            if (!state.replyTo) return;
            state.replyTo = null;
            updateRateHint(state);
        });
        $('cmtEmbedSend').addEventListener('click', send);
        $('cmtEmbedBody').addEventListener('input', function () { lsSet(LS_DRAFT, $('cmtEmbedBody').value); });
        $('cmtEmbedBody').addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
        });

        load();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})(window);
