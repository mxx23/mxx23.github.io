/* ==========================================================================
   在线工具通用脚本 (assets/web/tools/js/tool.js)
   提供：主题切换 / Toast / 复制 / 下载 / 文件大小格式化 等公共能力
   使用方式：
     Tool.toast('已复制', 'ok');
     Tool.copy('文本').then(ok => ...);
     Tool.download(blob, 'a.txt');
   ========================================================================== */
(function (global) {
    'use strict';

    var THEME_KEY = 'tool-theme';

    /* ------------------------------------------------------------ 主题 */
    function currentTheme() {
        var t = document.documentElement.getAttribute('data-theme');
        if (t === 'dark' || t === 'light') return t;
        return (global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* 忽略隐私模式报错 */ }
        var btn = document.getElementById('themeToggle');
        if (btn) {
            btn.textContent = theme === 'dark' ? '☀' : '☾';
            btn.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';
        }
    }

    function initTheme() {
        var saved = null;
        try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 忽略 */ }
        if (saved === 'dark' || saved === 'light') {
            document.documentElement.setAttribute('data-theme', saved);
        }
        var btn = document.getElementById('themeToggle');
        if (btn) {
            var t = currentTheme();
            btn.textContent = t === 'dark' ? '☀' : '☾';
            btn.title = t === 'dark' ? '切换到浅色主题' : '切换到深色主题';
            btn.addEventListener('click', function () {
                applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
            });
        }
    }

    /* ------------------------------------------------------------ Toast */
    function toast(msg, type, duration) {
        var box = document.getElementById('tool-toast');
        if (!box) {
            box = document.createElement('div');
            box.id = 'tool-toast';
            document.body.appendChild(box);
        }
        var item = document.createElement('div');
        item.className = 'toast-item' + (type ? ' ' + type : '');
        item.textContent = msg;
        box.appendChild(item);
        requestAnimationFrame(function () { item.classList.add('show'); });
        setTimeout(function () {
            item.classList.remove('show');
            setTimeout(function () {
                if (item.parentNode) item.parentNode.removeChild(item);
            }, 260);
        }, duration || 1900);
    }

    /* ------------------------------------------------------------ 复制 */
    function legacyCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        document.body.removeChild(ta);
        return ok;
    }

    function copy(text, tip) {
        text = text == null ? '' : String(text);
        if (!text) {
            toast('没有可复制的内容', 'err');
            return Promise.resolve(false);
        }
        var done = function (ok) {
            toast(ok ? (tip || '已复制到剪贴板') : '复制失败，请手动选择复制', ok ? 'ok' : 'err');
            return ok;
        };
        if (global.navigator && navigator.clipboard && global.isSecureContext !== false) {
            return navigator.clipboard.writeText(text).then(function () {
                return done(true);
            }).catch(function () {
                return done(legacyCopy(text));
            });
        }
        return Promise.resolve(done(legacyCopy(text)));
    }

    /* ------------------------------------------------------------ 下载 */
    function download(data, filename, mime) {
        var blob = (data instanceof Blob) ? data : new Blob([data], { type: mime || 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || 'download';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1200);
    }

    /* ------------------------------------------------------------ 工具函数 */
    function formatBytes(bytes, digits) {
        if (bytes === 0 || bytes == null) return '0 B';
        if (!isFinite(bytes)) return '-';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = Math.floor(Math.log(bytes) / Math.log(1024));
        i = Math.min(i, units.length - 1);
        var v = bytes / Math.pow(1024, i);
        return v.toFixed(i === 0 ? 0 : (digits == null ? 2 : digits)) + ' ' + units[i];
    }

    function formatDuration(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '--:--';
        var s = Math.floor(seconds % 60);
        var m = Math.floor(seconds / 60) % 60;
        var h = Math.floor(seconds / 3600);
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
    }

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function debounce(fn, wait) {
        var timer = null;
        return function () {
            var args = arguments, self = this;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(self, args); }, wait || 200);
        };
    }

    /* 显示 / 隐藏状态条 */
    function setStatus(el, type, msg) {
        if (!el) return;
        if (!msg) {
            el.className = 'status';
            el.textContent = '';
            return;
        }
        el.className = 'status show ' + (type || 'info');
        el.textContent = msg;
    }

    /* ------------------------------------------------------------ 拖拽 / 选择文件 */
    function bindDropZone(zone, input, onFile) {
        if (!zone) return;
        var pick = function () { if (input) input.click(); };
        zone.addEventListener('click', pick);
        if (input) {
            input.addEventListener('change', function () {
                if (input.files && input.files[0]) onFile(input.files[0]);
            });
        }
        ['dragenter', 'dragover'].forEach(function (ev) {
            zone.addEventListener(ev, function (e) {
                e.preventDefault();
                e.stopPropagation();
                zone.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(function (ev) {
            zone.addEventListener(ev, function (e) {
                e.preventDefault();
                e.stopPropagation();
                if (ev === 'dragleave' && zone.contains(e.relatedTarget)) return;
                zone.classList.remove('dragover');
            });
        });
        zone.addEventListener('drop', function (e) {
            var dt = e.dataTransfer;
            if (dt && dt.files && dt.files[0]) onFile(dt.files[0]);
        });
    }

    /* ------------------------------------------------------------ 返回按钮 */
    function initBackLinks() {
        var links = document.querySelectorAll('[data-back]');
        Array.prototype.forEach.call(links, function (a) {
            a.addEventListener('click', function (e) {
                if (global.history.length > 1 && document.referrer && document.referrer.indexOf(location.origin) === 0) {
                    e.preventDefault();
                    history.back();
                }
            });
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        initTheme();
        initBackLinks();
    });

    global.Tool = {
        toast: toast,
        copy: copy,
        download: download,
        formatBytes: formatBytes,
        formatDuration: formatDuration,
        escapeHtml: escapeHtml,
        debounce: debounce,
        setStatus: setStatus,
        bindDropZone: bindDropZone,
        applyTheme: applyTheme,
        currentTheme: currentTheme
    };
})(window);
