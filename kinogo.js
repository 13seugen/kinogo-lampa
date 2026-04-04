(function () {
    'use strict';

    var PLUGIN_VERSION = '20260404-cookie-1';
    if (window.__KINOGO_COOKIE_PLUGIN_VERSION__ === PLUGIN_VERSION) return;
    window.__KINOGO_COOKIE_PLUGIN_VERSION__ = PLUGIN_VERSION;

    if (window.__KINOGO_PLUGIN__) return;
    window.__KINOGO_PLUGIN__ = true;

    var BASE_URL = 'https://kinogo.ec';
    var BRIDGE_INTERVAL = 1500;
    var REQUEST_TIMEOUT = 10000;
    var USER_AGENT = 'Mozilla/5.0 (SmartTV; Tizen 6.0) AppleWebKit/537.36';

    // === ОБНОВЛЯТЬ РАЗ В 1-2 ДНЯ ===
    var KINOGO_COOKIES = {
        cf_clearance: 'fHG.iGZ5.Q0egK3VnirUujXnVxd7EOcKoZOdQmyOa2E-1775312978-1.2.1.1-qthil4Qd6NdXlXZMJrK09oumOaWiWiHc75pgPEMxsiVUEXD69nQfz38eE881QKdkR5qLrTWsOXY9dqDxkWMT30t_Dp3BG0WlptKW.4Dy29WP5xR7MdDajEJN640lzEF8IO8D8E2X7S19DH9Ch4Kp0U0NZdyxTtPp.8zFcai0qpa5ppqfzo3crzcv_2jiihGr7Hhbsib0Ir2kqdg0Mj8g_SoCpgWrPJgk2NCEnkwx4z8gaNiPHQT4mEA_sXDU0a.OK6rR_RpMUK4FcCw5gEinSvnlKhd_zCOfNMKb22qSg9COmPvrcTN5JpWtTo20OkpsshoUmtHD4GcM8ZUSfaRRiw',
        PHPSESSID: '73369b5fd8e2a7ecfa4ed2847aa45c40',
        dle_password: 'ea8acca3e0f12b90b3210059f8a4b676',
        dle_user_id: '336574',
        dle_newpm: '0'
    };
    // ================================

    function notify(msg) {
        if (window.Lampa && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
            Lampa.Noty.show(msg);
        }
    }

    function log() {
        var args = ['[KinoGO]'];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        if (window.console && console.log) console.log.apply(console, args);
    }

    function trim(s) {
        return (s || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function absUrl(url) {
        if (!url) return '';

        var value = trim(url);
        if (!value) return '';

        if (value.indexOf('//') === 0) return 'https:' + value;
        if (/^https?:\/\//i.test(value)) return value;
        if (value.charAt(0) !== '/') value = '/' + value;

        return BASE_URL + value;
    }

    function hasValidCookieValue(value) {
        var v = trim(value);
        return !!v && v !== 'ВСТАВИТЬ' && v !== 'СЮДА_ВСТАВИТЬ';
    }

    function hasRequiredCookies() {
        return hasValidCookieValue(KINOGO_COOKIES.cf_clearance) &&
            hasValidCookieValue(KINOGO_COOKIES.PHPSESSID) &&
            hasValidCookieValue(KINOGO_COOKIES.dle_password) &&
            hasValidCookieValue(KINOGO_COOKIES.dle_user_id);
    }

    function buildCookieHeader() {
        var parts = [];

        for (var key in KINOGO_COOKIES) {
            if (!Object.prototype.hasOwnProperty.call(KINOGO_COOKIES, key)) continue;
            parts.push(key + '=' + KINOGO_COOKIES[key]);
        }

        return parts.join('; ');
    }

    function headersForKinogo(referer, extra) {
        var headers = {
            'Cookie': buildCookieHeader(),
            'Referer': referer || (BASE_URL + '/'),
            'User-Agent': USER_AGENT
        };

        if (extra && typeof extra === 'object') {
            for (var k in extra) {
                if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
                headers[k] = extra[k];
            }
        }

        return headers;
    }

    function requestText(url, onSuccess, onError, postData, options) {
        if (!window.Lampa || !Lampa.Reguest) {
            if (onError) onError({ message: 'Lampa.Reguest not ready' });
            return;
        }

        var req = new Lampa.Reguest();
        req.timeout(REQUEST_TIMEOUT);

        var opts = options || {};

        req.silent(url, function (data) {
            var html = typeof data === 'string' ? data : ((data || '') + '');
            onSuccess(html);
        }, function (a, b) {
            var msg = 'network error';

            try {
                if (req.errorDecode) msg = req.errorDecode(a, b) || msg;
            } catch (e) {}

            if (onError) onError({ rawA: a, rawB: b, message: msg });
        }, postData || false, {
            dataType: 'text',
            headers: opts.headers || {}
        });
    }

    function encodeCP1251(str) {
        var out = '';

        for (var i = 0; i < str.length; i++) {
            var ch = str.charAt(i);
            var code = ch.charCodeAt(0);

            if (code < 128) {
                out += encodeURIComponent(ch);
                continue;
            }

            if (code === 1025) {
                out += '%A8'; // Ё
                continue;
            }

            if (code === 1105) {
                out += '%B8'; // ё
                continue;
            }

            if (code >= 1040 && code <= 1103) {
                var byte = code - 848;
                var hex = byte.toString(16).toUpperCase();
                if (hex.length < 2) hex = '0' + hex;
                out += '%' + hex;
                continue;
            }

            out += encodeURIComponent(ch);
        }

        return out;
    }

    function dedupeResults(results) {
        var map = {};
        var out = [];

        for (var i = 0; i < results.length; i++) {
            var item = results[i] || {};
            var key = item.url || '';

            if (!key || map[key]) continue;
            map[key] = true;
            out.push(item);
        }

        return out;
    }

    function extractSearchResults(doc) {
        var collected = [];
        var i;

        var blocks = doc.querySelectorAll('.shortstory, .short-story, #dle-content .sres-wrap');

        if (blocks.length) {
            for (i = 0; i < blocks.length; i++) {
                var a = blocks[i].querySelector('a[href]');
                if (!a) continue;

                var url = trim(a.getAttribute('href') || '');
                var title = trim(a.getAttribute('title') || a.textContent || '');

                if (!url || !title) continue;
                if (!((url.indexOf('kinogo') >= 0) || url.charAt(0) === '/')) continue;

                collected.push({
                    title: title,
                    url: absUrl(url)
                });
            }
        }

        if (!collected.length) {
            var anchors = doc.querySelectorAll('a[href*=".html"]');
            for (i = 0; i < anchors.length; i++) {
                var link = anchors[i];
                var href = trim(link.getAttribute('href') || '');
                var textTitle = trim(link.getAttribute('title') || link.textContent || '');

                if (!href || !textTitle) continue;
                if (!((href.indexOf('kinogo') >= 0) || href.charAt(0) === '/')) continue;

                collected.push({
                    title: textTitle,
                    url: absUrl(href)
                });
            }
        }

        return dedupeResults(collected);
    }

    function pickEmbedUrl(doc) {
        var embedUrl = '';

        var tab = doc.querySelector('.tabs li[data-iframe], .tabs [data-iframe]');
        if (tab) embedUrl = trim(tab.getAttribute('data-iframe') || '');

        if (!embedUrl) {
            var meta = doc.querySelector('[itemprop="embedUrl"]');
            if (meta) embedUrl = trim(meta.getAttribute('href') || meta.getAttribute('content') || '');
        }

        if (!embedUrl) {
            var iframe = doc.querySelector('iframe[src*="://"], iframe[src^="//"]');
            if (iframe) embedUrl = trim(iframe.getAttribute('src') || '');
        }

        if (!embedUrl) {
            var scripts = doc.querySelectorAll('script');
            for (var i = 0; i < scripts.length; i++) {
                var body = scripts[i].textContent || '';
                var m = body.match(/(?:data-iframe|embedUrl|iframe\s*[:=]|src\s*[:=])\s*["']([^"']+)["']/i);
                if (m && m[1]) {
                    embedUrl = trim(m[1]);
                    break;
                }
            }
        }

        return absUrl(embedUrl);
    }

    function decodeEscapedUrl(candidate) {
        var s = (candidate || '') + '';
        s = s.replace(/\\\//g, '/');
        s = s.replace(/\\u0026/g, '&');
        s = s.replace(/\\u003d/g, '=');
        return s;
    }

    function extractStreamsFromHtml(html) {
        var content = html || '';
        var all = [];

        var directRegex = /https?:\/\/[^"'\s<>]+\.(?:m3u8|mp4)(?:\?[^"'\s<>]*)?/gi;
        var direct = content.match(directRegex) || [];
        for (var i = 0; i < direct.length; i++) all.push(trim(direct[i]));

        var escapedRegex = /https?:\\\/\\\/[^"'\s<>]+\.(?:m3u8|mp4)(?:\\u0026[^"'\s<>]*)?/gi;
        var escaped = content.match(escapedRegex) || [];
        for (i = 0; i < escaped.length; i++) all.push(trim(decodeEscapedUrl(escaped[i])));

        var out = [];
        var seen = {};

        for (i = 0; i < all.length; i++) {
            var url = trim(all[i]);
            if (!url || seen[url]) continue;
            seen[url] = true;
            out.push(url);
        }

        return out;
    }

    function qualityTitle(url) {
        var q = (url || '').match(/(2160p|1440p|1080p|720p|480p|360p)/i);
        if (q && q[1]) return q[1];

        var tail = (url || '').split('/').pop() || url;
        tail = tail.split('?')[0];
        return trim(tail).slice(0, 50) || 'Поток';
    }

    function playStream(url) {
        if (!url) {
            notify('KinoGO: пустой поток');
            return;
        }

        if (!window.Lampa || !Lampa.Player || typeof Lampa.Player.play !== 'function') {
            notify('KinoGO: плеер Lampa недоступен');
            return;
        }

        try {
            Lampa.Player.play({ url: url, title: 'KinoGO' });
            if (typeof Lampa.Player.callback === 'function') Lampa.Player.callback(function () {});
        } catch (e) {
            log('player error', e && e.message ? e.message : e);
            notify('KinoGO: ошибка запуска плеера');
        }
    }

    function loadEmbed(embedUrl) {
        if (!embedUrl) {
            notify('KinoGO: embed URL пустой');
            return;
        }

        var headers = {
            Referer: embedUrl,
            'User-Agent': USER_AGENT
        };

        // Для kinogo.ec обязателен Cookie на каждом запросе.
        if (embedUrl.indexOf('kinogo.ec') >= 0) {
            headers.Cookie = buildCookieHeader();
        }

        requestText(embedUrl, function (html) {
            var streams = extractStreamsFromHtml(html);

            if (!streams.length) {
                notify('KinoGO: поток не найден');
                return;
            }

            var best = streams[0];
            for (var j = 0; j < streams.length; j++) {
                if (/\.m3u8(\?|$)/i.test(streams[j])) {
                    best = streams[j];
                    break;
                }
            }

            if (streams.length > 1 && window.Lampa && Lampa.Select && typeof Lampa.Select.show === 'function') {
                Lampa.Select.show({
                    title: 'KinoGO - качество',
                    items: streams.map(function (s) {
                        return { title: qualityTitle(s), url: s };
                    }),
                    onSelect: function (item) {
                        var selected = item && (item.url || (item.object && item.object.url));
                        playStream(selected || best);
                    },
                    onselect: function (item) {
                        var selected = item && (item.url || (item.object && item.object.url));
                        playStream(selected || best);
                    },
                    onBack: function () {},
                    onback: function () {}
                });
                return;
            }

            playStream(best);
        }, function (err) {
            log('embed error', err && err.message ? err.message : err);
            notify('KinoGO: ошибка загрузки плеера');
        }, false, {
            headers: headers
        });
    }

    function openFilmPage(url) {
        if (!url) {
            notify('KinoGO: ссылка фильма пустая');
            return;
        }

        requestText(url, function (html) {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var embedUrl = pickEmbedUrl(doc);

            if (!embedUrl) {
                notify('KinoGO: плеер не найден');
                return;
            }

            loadEmbed(embedUrl);
        }, function (err) {
            log('film page error', err && err.message ? err.message : err);
            notify('KinoGO: ошибка загрузки страницы');
        }, false, {
            headers: headersForKinogo(BASE_URL + '/')
        });
    }

    function parseSearchResults(html, card) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var results = extractSearchResults(doc);

        if (!results.length) {
            notify('KinoGO: фильм не найден');
            return;
        }

        if (results.length === 1) {
            openFilmPage(results[0].url);
            return;
        }

        if (window.Lampa && Lampa.Select && typeof Lampa.Select.show === 'function') {
            Lampa.Select.show({
                title: 'KinoGO - выберите фильм',
                items: results.map(function (r) {
                    return { title: r.title, url: r.url };
                }),
                onSelect: function (item) {
                    var selected = item && (item.url || (item.object && item.object.url));
                    if (selected) openFilmPage(selected);
                },
                onselect: function (item) {
                    var selected = item && (item.url || (item.object && item.object.url));
                    if (selected) openFilmPage(selected);
                },
                onBack: function () {},
                onback: function () {}
            });
            return;
        }

        openFilmPage(results[0].url);
    }

    function startSearch(card) {
        if (!hasRequiredCookies()) {
            notify('KinoGO: заполните cookie в KINOGO_COOKIES');
            return;
        }

        var title = trim((card && (card.title || card.name || card.original_title || card.original_name)) || '');

        if (!title) {
            notify('KinoGO: нет названия в карточке');
            return;
        }

        var postData = 'subaction=search&story=' + encodeCP1251(title);

        requestText(BASE_URL + '/index.php?do=search', function (html) {
            parseSearchResults(html, card);
        }, function (err) {
            log('search error', err && err.message ? err.message : err);
            notify('KinoGO: ошибка поиска');
        }, postData, {
            headers: headersForKinogo(BASE_URL + '/', {
                'Content-Type': 'application/x-www-form-urlencoded'
            })
        });
    }

    function insertButton(container, card) {
        if (!container || !container.querySelectorAll) return;

        var btn = document.createElement('div');
        btn.className = 'full-start__button selector kinogo-btn';
        btn.textContent = 'KinoGO';
        btn.addEventListener('click', function (e) {
            if (e && e.preventDefault) e.preventDefault();
            if (e && e.stopPropagation) e.stopPropagation();
            startSearch(card || {});
        });

        var buttons = container.querySelectorAll('.full-start__button');
        if (buttons.length) {
            buttons[buttons.length - 1].parentNode.insertBefore(btn, buttons[buttons.length - 1].nextSibling);
        } else {
            container.appendChild(btn);
        }
    }

    function ensureButtonInCard() {
        try {
            if (!window.Lampa || !Lampa.Activity || !Lampa.Activity.active) return;

            var active = Lampa.Activity.active();
            if (!active || active.component !== 'full') return;
            if (!active.activity || !active.activity.render) return;

            var root = active.activity.render();
            if (!root || !root.length) return;

            if (root.find('.kinogo-btn').length) return;

            var place = root.find('.view--torrent');
            if (!place.length) place = root.find('.full-start-new');
            if (!place.length) place = root.find('.full-start');
            if (!place.length) return;

            var container = place[0];
            if (!container) return;

            insertButton(container, active.card || {});
        } catch (e) {
            log('bridge tick error', e && e.message ? e.message : e);
        }
    }

    function startBridge() {
        setInterval(function () {
            ensureButtonInCard();
        }, BRIDGE_INTERVAL);
    }

    var initTimer = setInterval(function () {
        if (!window.Lampa || !Lampa.Activity) return;
        clearInterval(initTimer);
        startBridge();
        log('plugin started, version', PLUGIN_VERSION);
    }, 500);
})();
