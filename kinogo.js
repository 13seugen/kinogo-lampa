(function () {
    'use strict';

    var PLUGIN_VERSION = '20260404-21';
    if (window.kinogo_source_plugin_version === PLUGIN_VERSION) return;
    window.kinogo_source_plugin_version = PLUGIN_VERSION;

    var SOURCE_KEY = 'kinogo';
    var SOURCE_TITLE = 'KinoGO';
    var BASE_URL = 'https://kinogo.ec';
    var MIRROR_BASES = ['https://kinogo.mu', 'https://kinogo.luxury'];
    var TEST_PROXY_URL = 'https://cors.eu.org/';
    var CACHE_MINUTES = 45;
    var REQUEST_TIMEOUT = 25000;

    var network = null;
    var listenersBound = false;
    var cardBridgeBound = false;
    var cardBridgeTimer = null;

    var memoryCache = {};
    var cardUrlById = {};
    var seasonsByUrl = {};
    var embedMediaByUrl = {};
    var lastNotyAt = 0;
    var bridgeOpenAt = 0;
    var bridgeOpenBusy = false;
    var menuCache = {
        expires: 0,
        items: []
    };

    function log() {
        var args = ['[KinoGO]'];

        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        console.log.apply(console, args);
    }

    function now() {
        return Date.now();
    }

    function hashValue(input) {
        var str = (input || '') + '';

        if (window.Lampa && Lampa.Utils && typeof Lampa.Utils.hash === 'function') {
            return Lampa.Utils.hash(str);
        }

        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash |= 0;
        }

        return String(Math.abs(hash));
    }

    function ensureNetwork() {
        if (network) return network;
        if (!window.Lampa || !Lampa.Reguest) return null;

        network = new Lampa.Reguest();
        network.timeout(REQUEST_TIMEOUT);

        return network;
    }

    function notifyError(message) {
        if (!window.Lampa || !Lampa.Noty) return;
        if (now() - lastNotyAt < 5000) return;
        lastNotyAt = now();
        Lampa.Noty.show(message);
    }

    function toInt(value, fallback) {
        var num = parseInt(value, 10);
        return isNaN(num) ? (fallback || 0) : num;
    }

    function toFloat(value, fallback) {
        var num = parseFloat(value);
        return isNaN(num) ? (fallback || 0) : num;
    }

    function unique(arr) {
        var out = [];
        var map = {};

        for (var i = 0; i < arr.length; i++) {
            var key = arr[i];
            if (!key || map[key]) continue;
            map[key] = true;
            out.push(key);
        }

        return out;
    }

    function text(value) {
        return (value || '').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    }

    function stripTags(value) {
        if (!value) return '';
        return text((value + '').replace(/<[^>]+>/g, ' '));
    }

    function htmlToDoc(html) {
        return new DOMParser().parseFromString(html || '', 'text/html');
    }

    function absUrl(url) {
        if (!url) return '';

        var value = text(url);

        if (!value) return '';
        if (value.indexOf('//') === 0) return 'https:' + value;
        if (/^http:\/\//i.test(value)) value = 'https://' + value.slice(7);
        if (/^https?:\/\//i.test(value)) return value;
        if (value.charAt(0) !== '/') value = '/' + value;

        return BASE_URL + value;
    }

    function knownBases() {
        return [BASE_URL].concat(MIRROR_BASES);
    }

    function detectBase(url) {
        var source = text(url || '');
        if (!source) return '';

        var bases = knownBases();
        for (var i = 0; i < bases.length; i++) {
            if (source.indexOf(bases[i]) === 0) return bases[i];
        }
        return '';
    }

    function fallbackTargets(url) {
        var source = text(url || '');
        var currentBase = detectBase(source);
        if (!source || !currentBase) return [];

        var path = source.slice(currentBase.length);
        var out = [];
        var bases = knownBases();

        for (var i = 0; i < bases.length; i++) {
            var base = bases[i];
            if (base === currentBase) continue;
            out.push(base + path);
        }

        return out;
    }

    function requestHeaders(url) {
        var headers = {
            'Accept-Language': 'ru-RU,ru;q=0.9'
        };
        var base = detectBase(url);
        if (base) {
            headers.Referer = base + '/';
            headers.Origin = base;
        }

        return headers;
    }

    function normalizeQuery(query) {
        var value = text(query);

        if (!value) return '';

        try {
            return text(decodeURIComponent(value));
        } catch (e) {
            return value;
        }
    }

    function encodeCP1251URIComponent(str) {
        var out = '';

        for (var i = 0; i < str.length; i++) {
            var ch = str.charAt(i);
            var code = ch.charCodeAt(0);
            var byte = -1;

            if (code < 128) {
                out += encodeURIComponent(ch);
                continue;
            }

            if (code === 1025) byte = 168;      // Ё
            else if (code === 1105) byte = 184; // ё
            else if (code >= 1040 && code <= 1103) byte = code - 848;

            if (byte >= 0) {
                var hex = byte.toString(16).toUpperCase();
                if (hex.length < 2) hex = '0' + hex;
                out += '%' + hex;
            } else {
                out += encodeURIComponent(ch);
            }
        }

        return out;
    }

    function cacheGet(key) {
        var entry = memoryCache[key];
        if (!entry) return null;
        if (entry.expires < now()) {
            delete memoryCache[key];
            return null;
        }
        return entry.value;
    }

    function cacheSet(key, value, ttlMinutes) {
        memoryCache[key] = {
            value: value,
            expires: now() + (ttlMinutes * 60 * 1000)
        };
    }

    function proxiedUrl(url) {
        var target = absUrl(url);
        var proxy = text(Lampa.Storage.get('kinogo_proxy', ''));
        var hardcodedProxy = text(TEST_PROXY_URL || '');

        if (!proxy && /^https?:\/\//i.test(hardcodedProxy)) proxy = hardcodedProxy;
        if (!proxy) return target;
        if (!/^https?:\/\//i.test(proxy)) return target;

        if (proxy.indexOf('{url}') >= 0) return proxy.replace('{url}', encodeURIComponent(target));

        if (proxy.indexOf('?') >= 0) return proxy + encodeURIComponent(target);

        if (proxy.charAt(proxy.length - 1) !== '/') proxy += '/';
        return proxy + target;
    }

    function requestText(url, onSuccess, onError, postData, ttlMinutes, requestOptions) {
        var req = ensureNetwork();
        if (!req) {
            if (onError) onError({ status: 0, responseText: 'Lampa not ready' }, 'not_ready');
            return;
        }

        var options = {};
        var ttl = CACHE_MINUTES;

        if (typeof ttlMinutes === 'number') ttl = ttlMinutes;
        else if (ttlMinutes && typeof ttlMinutes === 'object') options = ttlMinutes;

        if (requestOptions && typeof requestOptions === 'object') options = requestOptions;

        var directTarget = absUrl(url);
        var target = proxiedUrl(directTarget);
        var usedProxy = target !== directTarget;
        var cacheKey = 'TEXT::' + target + '::' + JSON.stringify(postData || {});
        var cached = cacheGet(cacheKey);

        if (cached !== null) {
            onSuccess(cached);
            return;
        }

        function doneSuccess(data, keyForCache) {
            var html = typeof data === 'string' ? data : (data || '') + '';
            cacheSet(keyForCache || cacheKey, html, ttl);
            onSuccess(html);
        }

        function runRequest(runUrl, runCacheKey, callbackSuccess, callbackError) {
            req.silent(runUrl, function (data) {
                doneSuccess(data, runCacheKey);
                if (callbackSuccess) callbackSuccess();
            }, callbackError, postData || false, {
                dataType: 'text',
                cache: {
                    life: ttl
                },
                headers: requestHeaders(runUrl)
            });
        }

        function handleError(a, b) {
            var decoded = '';
            var status = toInt((a || {}).status, 0);
            var message = '';
            var mirrors = fallbackTargets(directTarget);

            try {
                decoded = req.errorDecode(a, b);
            } catch (e) {
                decoded = '';
            }

            if ((status === 403 || status === 503 || status === 404) && mirrors.length) {
                var mi = 0;

                function tryMirror() {
                    if (mi >= mirrors.length) {
                        if (status === 403 || /forbidden/i.test(decoded || '')) {
                            message = 'Доступ к KinoGO запрещён (403).';
                        } else if (status === 404) {
                            message = 'Страница KinoGO не найдена (404).';
                        } else {
                            message = decoded ? stripTags(decoded).slice(0, 180) : 'Ошибка сети';
                        }

                        if (!options.suppressNoty && !(options.suppress404 && status === 404)) {
                            notifyError('KinoGO: ' + message);
                        }
                        if (onError) onError({ status: status, responseText: message }, b);
                        return;
                    }

                    var mirrorTarget = proxiedUrl(mirrors[mi++]);
                    var mirrorCacheKey = 'TEXT::' + mirrorTarget + '::' + JSON.stringify(postData || {});
                    var mirrorCached = cacheGet(mirrorCacheKey);

                    if (mirrorCached !== null) {
                        onSuccess(mirrorCached);
                        return;
                    }

                    runRequest(mirrorTarget, mirrorCacheKey, null, function () {
                        tryMirror();
                    });
                }

                tryMirror();
                return;
            }

            if (status === 404 && usedProxy) {
                var fallbackKey = 'TEXT::' + directTarget + '::' + JSON.stringify(postData || {});
                var fallbackCached = cacheGet(fallbackKey);

                if (fallbackCached !== null) {
                    onSuccess(fallbackCached);
                    return;
                }

                req.silent(directTarget, function (directData) {
                    doneSuccess(directData, fallbackKey);
                }, function (x, y) {
                    var directStatus = toInt((x || {}).status, 0);
                    var directDecoded = '';

                    try {
                        directDecoded = req.errorDecode(x, y);
                    } catch (e) {
                        directDecoded = '';
                    }

                    if (directStatus === 403 || /forbidden/i.test(directDecoded || '')) {
                        message = 'Доступ к KinoGO запрещён (403). Включите HTTPS.';
                    } else if (directStatus === 404) {
                        message = 'Страница KinoGO не найдена (404).';
                    } else {
                        message = directDecoded ? stripTags(directDecoded).slice(0, 180) : 'Ошибка сети';
                    }

                    if (!options.suppressNoty && !(options.suppress404 && directStatus === 404)) {
                        notifyError('KinoGO: ' + message);
                    }
                    if (onError) onError({ status: directStatus, responseText: message }, y);
                }, postData || false, {
                    dataType: 'text',
                    cache: {
                        life: ttl
                    }
                });

                return;
            }

            if (status === 403 || /forbidden/i.test(decoded || '')) {
                message = 'Доступ к KinoGO запрещён (403). Включите HTTPS.';
            } else if (status === 404) {
                message = 'Страница KinoGO не найдена (404).';
            } else {
                message = decoded ? stripTags(decoded).slice(0, 180) : 'Ошибка сети';
            }

            if (!options.suppressNoty && !(options.suppress404 && status === 404)) {
                notifyError('KinoGO: ' + message);
            }
            if (onError) onError({ status: status, responseText: message }, b);
        }

        runRequest(target, cacheKey, null, handleError);
    }

    function readNodeValueAfterLabel(labelNode) {
        var value = '';
        var node = labelNode ? labelNode.nextSibling : null;

        while (node) {
            if (node.nodeType === 1 && node.tagName === 'BR') break;
            value += node.textContent || '';
            node = node.nextSibling;
        }

        return text(value);
    }

    function parseFacts(root) {
        var facts = {};
        if (!root) return facts;

        var labels = root.querySelectorAll('b');

        for (var i = 0; i < labels.length; i++) {
            var label = text(labels[i].textContent).replace(/\s*:\s*$/, '').toLowerCase();
            var value = readNodeValueAfterLabel(labels[i]);
            if (label && value) facts[label] = value;
        }

        return facts;
    }

    function pickFact(facts, needles) {
        for (var key in facts) {
            if (!Object.prototype.hasOwnProperty.call(facts, key)) continue;

            for (var i = 0; i < needles.length; i++) {
                if (key.indexOf(needles[i]) >= 0) return facts[key];
            }
        }
        return '';
    }

    function splitCSV(value) {
        if (!value) return [];
        return value.split(',').map(function (part) {
            return text(part);
        }).filter(function (part) {
            return !!part;
        });
    }

    function parseRatings(rawText) {
        var raw = rawText || '';
        var kp = 0;
        var imdb = 0;
        var kpMatch = raw.match(/KP\s*([0-9]+(?:[.,][0-9]+)?)/i);
        var imdbMatch = raw.match(/IMDB\s*([0-9]+(?:[.,][0-9]+)?)/i);

        if (kpMatch && kpMatch[1]) kp = toFloat(kpMatch[1].replace(',', '.'), 0);
        if (imdbMatch && imdbMatch[1]) imdb = toFloat(imdbMatch[1].replace(',', '.'), 0);

        return {
            kp: kp,
            imdb: imdb
        };
    }

    function isTvCard(title, genres, url) {
        var t = (title || '').toLowerCase();
        var g = (genres || []).join(' ').toLowerCase();
        var u = (url || '').toLowerCase();

        if (/(сезон|серия|все серии|serial|serials)/i.test(t)) return true;
        if (/(сериалы|дорамы|тв передачи|турецкие сериалы)/i.test(g)) return true;
        if (u.indexOf('/new-serial') >= 0 || u.indexOf('-serial') >= 0) return true;

        return false;
    }

    function extractIdFromUrl(url) {
        var match = (url || '').match(/\/(\d+)-/);
        return match ? toInt(match[1], 0) : 0;
    }

    function parseCardFromShortstory(node) {
        var anchor = node.querySelector('.zagolovki a');
        if (!anchor) return null;

        var url = absUrl(anchor.getAttribute('href') || '');
        var id = extractIdFromUrl(url);
        var title = stripTags(anchor.textContent);
        var posterNode = node.querySelector('img[data-src], img[src]');
        var poster = absUrl((posterNode && (posterNode.getAttribute('data-src') || posterNode.getAttribute('src'))) || '');
        var facts = parseFacts(node.querySelector('.shortimg'));
        var year = toInt(pickFact(facts, ['год']), 0);
        var genres = splitCSV(pickFact(facts, ['жанр']));
        var rating = toFloat(text((node.querySelector('[itemprop="ratingValue"]') || {}).textContent || '').replace(',', '.'), 0);
        var parsedRatings = parseRatings(node.textContent || '');
        var infoNode = node.querySelector('.shortimg');
        var desc = '';

        if (infoNode) {
            var clone = infoNode.cloneNode(true);
            var garbage = clone.querySelectorAll('b, img, .lenta, .edge-left, script, style');
            for (var i = 0; i < garbage.length; i++) garbage[i].remove();
            desc = text(clone.textContent || '').slice(0, 550);
        }

        var tv = isTvCard(title, genres, url);
        var genreObjects = genres.map(function (name, index) {
            return {
                id: index + 1,
                name: name
            };
        });
        var card = {
            id: id || hashValue(url),
            source: SOURCE_KEY,
            url: url,
            kinogo_id: id || 0,
            title: title,
            original_title: title,
            overview: desc,
            description: desc,
            vote_average: rating || 0,
            kp_rating: parsedRatings.kp || 0,
            imdb_rating: parsedRatings.imdb || 0,
            genres: genreObjects,
            genre_ids: genreObjects.map(function (g) { return g.id; }),
            production_companies: [],
            production_countries: [],
            img: poster || './img/img_broken.svg',
            poster: poster || './img/img_broken.svg',
            background_image: poster || './img/img_broken.svg',
            type: tv ? 'tv' : 'movie'
        };

        if (year > 0) {
            card.year = year;
            if (tv) card.first_air_date = year + '-01-01';
            else card.release_date = year + '-01-01';
        }

        if (tv) {
            card.name = title;
            card.original_name = title;
        } else {
            delete card.name;
            delete card.original_name;
        }

        cardUrlById[card.id] = url;
        return card;
    }

    function looksLikeCardUrl(url) {
        return /\/\d+-[^/]+\.html?$/i.test(url || '');
    }

    function buildCardFromParts(url, title, poster, year, genres, description, sourceNodeText) {
        if (!looksLikeCardUrl(url)) return null;
        if (!title) return null;

        var id = extractIdFromUrl(url);
        var cleanTitle = stripTags(title);
        var genreObjects = (genres || []).map(function (name, index) {
            return {
                id: index + 1,
                name: name
            };
        });
        var parsedRatings = parseRatings(sourceNodeText || '');
        var tv = isTvCard(cleanTitle, genres || [], url);
        var card = {
            id: id || hashValue(url),
            source: SOURCE_KEY,
            url: url,
            kinogo_id: id || 0,
            title: cleanTitle,
            original_title: cleanTitle,
            overview: description || '',
            description: description || '',
            vote_average: 0,
            kp_rating: parsedRatings.kp || 0,
            imdb_rating: parsedRatings.imdb || 0,
            genres: genreObjects,
            genre_ids: genreObjects.map(function (g) { return g.id; }),
            production_companies: [],
            production_countries: [],
            img: poster || './img/img_broken.svg',
            poster: poster || './img/img_broken.svg',
            background_image: poster || './img/img_broken.svg',
            type: tv ? 'tv' : 'movie'
        };

        if (year > 0) {
            card.year = year;
            if (tv) card.first_air_date = year + '-01-01';
            else card.release_date = year + '-01-01';
        }

        if (tv) {
            card.name = cleanTitle;
            card.original_name = cleanTitle;
        }

        cardUrlById[card.id] = url;
        return card;
    }

    function parseCardFromAnchor(anchor) {
        if (!anchor) return null;

        var url = absUrl(anchor.getAttribute('href') || '');
        if (!looksLikeCardUrl(url)) return null;

        var node = anchor;
        for (var i = 0; i < 5; i++) {
            if (!node || !node.parentElement) break;
            node = node.parentElement;
        }

        var title = text(anchor.getAttribute('title') || anchor.textContent || '');
        var imgNode = node ? node.querySelector('img[data-src], img[src]') : null;
        var poster = absUrl((imgNode && (imgNode.getAttribute('data-src') || imgNode.getAttribute('src'))) || '');
        var facts = parseFacts(node);
        var year = toInt(pickFact(facts, ['год']), 0);
        var yearFromTitle = (title.match(/\((19|20)\d{2}\)/) || [])[0];
        if (!year && yearFromTitle) year = toInt(yearFromTitle.replace(/[^\d]/g, ''), 0);
        var genres = splitCSV(pickFact(facts, ['жанр']));
        var description = node ? text(node.textContent || '').slice(0, 450) : '';

        if (!poster && !year && !/(сезон|серия|film|movie|serial|сериал)/i.test((title || '').toLowerCase())) {
            return null;
        }

        return buildCardFromParts(url, title, poster, year, genres, description, node ? node.textContent : '');
    }

    function collectCardNodes(doc, searchOnly) {
        var selectors = searchOnly
            ? [
                '#dle-content .shortstory', '.shortstory',
                '#dle-content .short-story', '.short-story',
                '#dle-content .short_story', '.short_story',
                '#dle-content .movie', '.movie',
                '#dle-content .movie-item', '.movie-item',
                '#dle-content article', '#dle-content .item'
            ]
            : [
                '.shortstory',
                '.short-story',
                '.short_story',
                '.movie',
                '.movie-item',
                '#dle-content article',
                '#dle-content .item'
            ];

        var merged = [];
        var seen = {};

        for (var i = 0; i < selectors.length; i++) {
            var nodes = doc.querySelectorAll(selectors[i]);
            for (var j = 0; j < nodes.length; j++) {
                var node = nodes[j];
                if (!node || !node.querySelector) continue;
                var link = node.querySelector('a[href*=".html"]');
                if (!link) continue;
                var key = link.getAttribute('href') || ('idx_' + i + '_' + j);
                if (seen[key]) continue;
                seen[key] = true;
                merged.push(node);
            }
            if (merged.length >= 3) break;
        }

        return merged;
    }

    function parseCardsByNodesOrAnchors(doc, nodes) {
        var cards = [];
        var uniq = {};
        var i;

        function push(card) {
            if (!card || !card.url) return;
            if (uniq[card.url]) return;
            uniq[card.url] = true;
            cards.push(card);
        }

        var list = Array.isArray(nodes) ? nodes : [];
        for (i = 0; i < list.length; i++) {
            push(parseCardFromShortstory(list[i]));
        }

        if (cards.length === 0) {
            var anchors = doc.querySelectorAll('a[href*=".html"], a[href*="/serial"], a[href*="/movie"]');
            for (i = 0; i < anchors.length; i++) {
                push(parseCardFromAnchor(anchors[i]));
            }
        }

        return cards;
    }

    function parseCardsFromDoc(doc) {
        var nodes = collectCardNodes(doc, false);
        return parseCardsByNodesOrAnchors(doc, nodes);
    }

    function parseSearchCardsFromDoc(doc) {
        var nodes = collectCardNodes(doc, true);
        return parseCardsByNodesOrAnchors(doc, nodes);
    }

    function parseSerialUpdatesFromDoc(doc) {
        var rows = doc.querySelectorAll('.msupdate_block_list_link');
        var cards = [];

        for (var i = 0; i < rows.length; i++) {
            var link = rows[i];
            var url = absUrl(link.getAttribute('href') || '');
            var title = text(link.getAttribute('title') || (link.querySelector('.msupdate_block_list_item_title') || {}).textContent || link.textContent || '');
            var imgNode = link.querySelector('img');
            var img = absUrl(((imgNode || {}).getAttribute || function () { return ''; }).call(imgNode || {}, 'data-src') || ((imgNode || {}).getAttribute || function () { return ''; }).call(imgNode || {}, 'src'));
            var yearMatch = title.match(/\((\d{4})\)/);
            var id = extractIdFromUrl(url);

            if (!url || !title) continue;

            var card = {
                id: id || hashValue(url),
                source: SOURCE_KEY,
                url: url,
                kinogo_id: id || 0,
                name: title,
                original_name: title,
                title: title,
                original_title: title,
                first_air_date: yearMatch ? (yearMatch[1] + '-01-01') : '',
                year: yearMatch ? toInt(yearMatch[1], 0) : 0,
                vote_average: 0,
                overview: '',
                description: '',
                genres: [],
                genre_ids: [],
                production_companies: [],
                production_countries: [],
                img: img || './img/img_broken.svg',
                poster: img || './img/img_broken.svg',
                background_image: img || './img/img_broken.svg',
                type: 'tv'
            };

            cardUrlById[card.id] = url;
            cards.push(card);
        }

        return cards;
    }

    function parsePagination(doc, currentPage) {
        var page = Math.max(1, toInt(currentPage, 1));
        var maxPage = page;
        var nav = doc.querySelector('.bot-navigation');
        if (!nav) return maxPage;

        var nodes = nav.querySelectorAll('a, span');

        for (var i = 0; i < nodes.length; i++) {
            var value = toInt(text(nodes[i].textContent), 0);
            if (value > maxPage) maxPage = value;

            var onclick = nodes[i].getAttribute('onclick') || '';
            var submitMatch = onclick.match(/list_submit\((\d+)\)/);
            if (submitMatch) {
                value = toInt(submitMatch[1], 0);
                if (value > maxPage) maxPage = value;
            }

            var href = nodes[i].getAttribute('href') || '';
            var hrefMatch = href.match(/\/page\/(\d+)/);
            if (hrefMatch) {
                value = toInt(hrefMatch[1], 0);
                if (value > maxPage) maxPage = value;
            }
        }

        return maxPage;
    }

    function buildSearchRequest(query, page) {
        var encoded = encodeCP1251URIComponent(query || '');
        var p = Math.max(1, toInt(page, 1));
        var body = 'subaction=search&story=' + encoded;

        if (p > 1) body += '&search_start=' + p;

        return {
            url: BASE_URL + '/index.php?do=search',
            postData: body
        };
    }

    function buildSearchRequestUtf8(query, page) {
        var encoded = encodeURIComponent(query || '');
        var p = Math.max(1, toInt(page, 1));
        var body = 'subaction=search&story=' + encoded;

        if (p > 1) body += '&search_start=' + p;

        return {
            url: BASE_URL + '/index.php?do=search',
            postData: body
        };
    }

    function normalizeSitePath(url) {
        var normalized = absUrl(url);
        var match = normalized.match(/\/xfsearch\/([^/?#]+)\//i);

        if (!match || !match[1]) return normalized;
        if (match[1].indexOf('%') >= 0) return normalized;

        var query = match[1];
        try {
            query = decodeURIComponent(query);
        } catch (e) {}

        return normalized.replace('/xfsearch/' + match[1] + '/', '/xfsearch/' + encodeCP1251URIComponent(query) + '/');
    }

    function appendPage(url, page) {
        var p = Math.max(1, toInt(page, 1));
        var base = normalizeSitePath(url);
        if (p <= 1) return base;

        if (/\/page\/\d+\/?$/i.test(base)) return base.replace(/\/page\/\d+\/?$/i, '/page/' + p + '/');

        if (base.indexOf('?') >= 0) return base + '&page=' + p;
        if (base.charAt(base.length - 1) !== '/') base += '/';
        return base + 'page/' + p + '/';
    }

    function resolveListPath(params) {
        var custom = text((params && (params.genres || params.id)) || '');
        if (custom && custom.indexOf('/') >= 0) return custom;
        if (/^https?:\/\//i.test(custom)) return custom;

        var url = text((params && params.url) || '');
        if (/^https?:\/\//i.test(url)) return url;
        if (url && url.charAt(0) === '/') return url;

        if (url === 'tv') return '/new-serial/';
        if (url === 'anime') return '/anime/';
        if (url === 'movie') return '/filmis/';
        if (url) return '/filmis/';

        return '/';
    }

    function fetchCardsPage(params, onSuccess, onError) {
        var page = Math.max(1, toInt(params.page, 1));
        var query = normalizeQuery(params.query || '');
        var url = appendPage(resolveListPath(params), page);
        var postData = false;

        if (query) {
            var searchRequest = buildSearchRequest(query, page);
            url = searchRequest.url;
            postData = searchRequest.postData;
        }

        requestText(url, function (html) {
            try {
                var doc = htmlToDoc(html);
                var results = query ? parseSearchCardsFromDoc(doc) : parseCardsFromDoc(doc);

                if (query && !results.length) {
                    var fallbackSearch = buildSearchRequestUtf8(query, page);

                    requestText(fallbackSearch.url, function (fallbackHtml) {
                        try {
                            var fallbackDoc = htmlToDoc(fallbackHtml);
                            var fallbackResults = parseSearchCardsFromDoc(fallbackDoc);

                            if (!fallbackResults.length) {
                                if (onError) onError();
                                return;
                            }

                            onSuccess({
                                results: fallbackResults,
                                page: page,
                                total_pages: parsePagination(fallbackDoc, page),
                                source: SOURCE_KEY,
                                url: params.url || '',
                                query: query
                            });
                        } catch (e2) {
                            log('fallback parse cards error', e2.message);
                            if (onError) onError();
                        }
                    }, function () {
                        if (onError) onError();
                    }, fallbackSearch.postData, CACHE_MINUTES, {
                        suppress404: true,
                        suppressNoty: true
                    });

                    return;
                }

                if (!results.length) {
                    if (onError) onError();
                    return;
                }

                onSuccess({
                    results: results,
                    page: page,
                    total_pages: parsePagination(doc, page),
                    source: SOURCE_KEY,
                    url: params.url || '',
                    query: query
                });
            } catch (e) {
                log('parse cards error', e.message);
                if (onError) onError();
            }
        }, function () {
            if (onError) onError();
        }, postData, CACHE_MINUTES, {
            suppress404: true,
            suppressNoty: !!query
        });
    }

    function extractBalanced(textValue, startIndex, openChar, closeChar) {
        var depth = 0;
        var inString = false;
        var escaped = false;
        var result = '';

        for (var i = startIndex; i < textValue.length; i++) {
            var ch = textValue.charAt(i);
            result += ch;

            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }

            if (ch === openChar) depth++;
            else if (ch === closeChar) {
                depth--;
                if (depth === 0) return result;
            }
        }

        return '';
    }

    function parseSeasonsFromEmbed(html) {
        var raw = html || '';
        var marker = 'seasons:[';
        var index = raw.indexOf(marker);

        if (index < 0) {
            marker = '"seasons":[';
            index = raw.indexOf(marker);
        }

        if (index < 0) return [];

        var arrayStart = raw.indexOf('[', index);
        if (arrayStart < 0) return [];

        var arrayText = extractBalanced(raw, arrayStart, '[', ']');
        if (!arrayText) return [];

        try {
            var parsed = JSON.parse(arrayText);
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            log('seasons json parse error', e.message);
            return [];
        }
    }

    function decodeEscapedUrl(url) {
        var value = text(url || '');
        if (!value) return '';

        value = value.replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
        return absUrl(value);
    }

    function uniqueSubtitleList(subtitles) {
        var list = Array.isArray(subtitles) ? subtitles : [];
        var out = [];
        var seen = {};

        for (var i = 0; i < list.length; i++) {
            var item = list[i] || {};
            var url = absUrl(item.url || '');
            var name = text(item.name || item.label || '');
            if (!url || seen[url]) continue;
            seen[url] = true;
            out.push({
                url: url,
                name: name || ('Субтитры ' + (out.length + 1))
            });
        }

        return out;
    }

    function pickBestStream(streams) {
        var list = unique((streams || []).map(function (url) {
            return absUrl(url || '');
        }).filter(function (url) {
            return !!url;
        }));

        if (!list.length) return '';

        for (var i = 0; i < list.length; i++) {
            if (/\.m3u8(?:\?|$)/i.test(list[i])) return list[i];
        }

        for (var j = 0; j < list.length; j++) {
            if (/\.mp4(?:\?|$)/i.test(list[j])) return list[j];
        }

        return list[0];
    }

    function parseEmbedSourceObject(embedHtml) {
        var html = embedHtml || '';
        var out = {
            streams: [],
            subtitles: []
        };

        var sourceMarker = html.indexOf('source:');
        if (sourceMarker < 0) sourceMarker = html.indexOf('"source"');
        if (sourceMarker < 0) return out;

        var objectStart = html.indexOf('{', sourceMarker);
        if (objectStart < 0) return out;

        var sourceObject = extractBalanced(html, objectStart, '{', '}');
        if (!sourceObject) return out;

        var directKeys = ['hls', 'mp4', 'dash', 'dasha'];
        for (var i = 0; i < directKeys.length; i++) {
            var key = directKeys[i];
            var match = sourceObject.match(new RegExp('(?:^|[,{\\s])' + key + '\\s*:\\s*"([^"]+)"', 'i'));
            if (match && match[1]) {
                var value = decodeEscapedUrl(match[1]);
                if (value) out.streams.push(value);
            }
        }

        var ccMarker = sourceObject.search(/(?:^|[,{]\s*)cc\s*:\s*\[/i);
        if (ccMarker >= 0) {
            var ccStart = sourceObject.indexOf('[', ccMarker);
            if (ccStart >= 0) {
                var ccArrayText = extractBalanced(sourceObject, ccStart, '[', ']');
                if (ccArrayText) {
                    try {
                        var parsed = JSON.parse(ccArrayText);
                        out.subtitles = uniqueSubtitleList(parsed.map(function (item) {
                            return {
                                url: decodeEscapedUrl(item.url || ''),
                                name: text(item.name || '')
                            };
                        }));
                    } catch (e) {
                        out.subtitles = [];
                    }
                }
            }
        }

        out.streams = unique(out.streams);
        return out;
    }

    function parseEmbedMedia(embedHtml) {
        var rawSeasons = parseSeasonsFromEmbed(embedHtml || '');
        var mappedSeasons = rawSeasons.length ? mapSeasons(rawSeasons) : [];
        var sourceData = parseEmbedSourceObject(embedHtml || '');
        var directStreams = extractDirectStreams(embedHtml || '');

        return {
            seasons: mappedSeasons,
            streams: unique([].concat(sourceData.streams || [], directStreams || [])),
            subtitles: uniqueSubtitleList(sourceData.subtitles || [])
        };
    }

    function getEmbedMediaByCardUrl(cardUrl, callback) {
        var url = absUrl(cardUrl || '');
        if (!url) {
            callback({
                seasons: [],
                streams: [],
                subtitles: []
            });
            return;
        }

        if (embedMediaByUrl[url]) {
            callback(embedMediaByUrl[url]);
            return;
        }

        requestText(url, function (html) {
            var doc = htmlToDoc(html);
            var embeds = firstEmbedCandidates(doc);

            if (!embeds.length) {
                var empty = {
                    seasons: [],
                    streams: [],
                    subtitles: []
                };
                embedMediaByUrl[url] = empty;
                seasonsByUrl[url] = [];
                callback(empty);
                return;
            }

            var index = 0;
            var merged = {
                seasons: [],
                streams: [],
                subtitles: []
            };

            function mergeSubtitles(current, incoming) {
                return uniqueSubtitleList([].concat(current || [], incoming || []));
            }

            function done() {
                merged.streams = unique((merged.streams || []).map(function (item) {
                    return absUrl(item || '');
                }).filter(function (item) {
                    return !!item;
                }));

                embedMediaByUrl[url] = merged;
                seasonsByUrl[url] = merged.seasons || [];
                callback(merged);
            }

            function tryNext() {
                if (index >= embeds.length) {
                    done();
                    return;
                }

                var embedUrl = embeds[index++];

                requestText(embedUrl, function (embedHtml) {
                    var parsed = parseEmbedMedia(embedHtml || '');

                    if (parsed.seasons.length && !merged.seasons.length) {
                        merged.seasons = parsed.seasons;
                    }

                    if (parsed.streams.length) {
                        merged.streams = unique([].concat(merged.streams || [], parsed.streams));
                    }

                    if (parsed.subtitles.length) {
                        merged.subtitles = mergeSubtitles(merged.subtitles, parsed.subtitles);
                    }

                    if (merged.seasons.length && merged.streams.length) {
                        done();
                        return;
                    }

                    tryNext();
                }, function () {
                    tryNext();
                }, false, 20, {
                    suppress404: true,
                    suppressNoty: true
                });
            }

            tryNext();
        }, function () {
            callback({
                seasons: [],
                streams: [],
                subtitles: []
            });
        }, false, CACHE_MINUTES, {
            suppress404: true,
            suppressNoty: true
        });
    }

    function mapEpisode(ep, seasonNumber, index) {
        var episodeNumber = toInt(ep.episode, index + 1);
        var subtitles = Array.isArray(ep.cc) ? ep.cc : [];
        var subtitleList = subtitles.map(function (sub) {
            return {
                url: absUrl(sub.url || ''),
                name: text(sub.name || '')
            };
        }).filter(function (sub) {
            return !!sub.url;
        });

        var hls = ep.hls || '';
        var dash = ep.dash || ep.dasha || '';
        var mp4 = ep.mp4 || '';

        return {
            id: toInt(ep.id, hashValue([seasonNumber, episodeNumber, ep.title || ''].join('_'))),
            source: SOURCE_KEY,
            season_number: seasonNumber,
            episode_number: episodeNumber,
            name: text(ep.title || ('Серия ' + episodeNumber)),
            runtime: Math.max(0, Math.round(toInt(ep.duration, 0) / 60)),
            hls: hls,
            dash: dash,
            mp4: mp4,
            subtitles: subtitleList,
            url: hls || dash || mp4 || ''
        };
    }

    function mapSeasons(rawSeasons) {
        var seasons = [];

        for (var i = 0; i < rawSeasons.length; i++) {
            var season = rawSeasons[i];
            var seasonNumber = toInt(season.season, i + 1);
            var rawEpisodes = Array.isArray(season.episodes) ? season.episodes : [];
            var episodes = [];

            for (var j = 0; j < rawEpisodes.length; j++) {
                episodes.push(mapEpisode(rawEpisodes[j], seasonNumber, j));
            }

            seasons.push({
                season_number: seasonNumber,
                name: 'Сезон ' + seasonNumber,
                episodes: episodes
            });
        }

        seasons.sort(function (a, b) {
            return a.season_number - b.season_number;
        });

        return seasons;
    }

    function firstEmbedCandidates(doc) {
        var list = [];
        var seen = {};

        function pushRaw(raw) {
            var value = text(raw || '');
            if (!value) return;
            if (/^javascript:/i.test(value)) return;
            if (/\/trailer-cdn\//i.test(value)) return;

            var url = absUrl(value);
            if (!/^https?:\/\//i.test(url)) return;
            if (seen[url]) return;

            seen[url] = true;
            list.push(url);
        }

        function collectBySelector(selector, attrs) {
            var nodes = doc.querySelectorAll(selector);
            for (var i = 0; i < nodes.length; i++) {
                for (var j = 0; j < attrs.length; j++) {
                    pushRaw(nodes[i].getAttribute(attrs[j]));
                }
            }
        }

        collectBySelector('.tabs li[data-iframe], .tabs [data-iframe]', ['data-iframe']);
        collectBySelector('[data-iframe]', ['data-iframe']);
        collectBySelector('[itemprop="embedUrl"]', ['href', 'content']);
        collectBySelector('iframe[src], iframe[data-src]', ['src', 'data-src']);
        collectBySelector('[data-src*="embed"], [data-src*="iframe"]', ['data-src']);
        collectBySelector('[data-player], [data-player-url]', ['data-player', 'data-player-url']);
        collectBySelector('link[itemprop="embedUrl"], meta[itemprop="embedUrl"]', ['href', 'content']);

        var scripts = doc.querySelectorAll('script');
        var embedRegex = /https?:\/\/[^"'\\\s<>]+(?:\/embed\/[^"'\\\s<>]+|\/iframe(?:\?[^"'\\\s<>]*)?)/ig;
        for (var n = 0; n < scripts.length; n++) {
            var scriptText = scripts[n].textContent || '';
            var match;
            while ((match = embedRegex.exec(scriptText)) !== null) {
                pushRaw(match[0]);
            }
        }

        function embedPriority(url) {
            var u = (url || '').toLowerCase();
            if (u.indexOf('api.variyt.ws/embed/') >= 0) return 0;
            if (u.indexOf('/embed/movie/') >= 0 || u.indexOf('/embed/tv/') >= 0) return 1;
            if (u.indexOf('stloadi.live') >= 0) return 2;
            if (u.indexOf('cinemap.cc') >= 0 || u.indexOf('cinemar.cc') >= 0) return 3;
            if (u.indexOf('/iframe') >= 0) return 4;
            return 9;
        }

        list.sort(function (a, b) {
            var pa = embedPriority(a);
            var pb = embedPriority(b);
            if (pa !== pb) return pa - pb;
            return a.localeCompare(b);
        });

        return list;
    }

    function parsePersonNames(doc, selector) {
        var nodes = doc.querySelectorAll(selector);
        var names = [];

        for (var i = 0; i < nodes.length; i++) {
            var name = text(nodes[i].textContent);
            if (name) names.push(name);
        }

        return unique(names);
    }

    function parseFullCard(doc, fallbackCard, pageUrl) {
        var title = text((doc.querySelector('h1[itemprop="name"]') || {}).textContent || fallbackCard.title || fallbackCard.name || '');
        var facts = parseFacts(doc.querySelector('.shortimg'));
        var year = toInt(pickFact(facts, ['год']), toInt(fallbackCard.year, 0));
        var countries = splitCSV(pickFact(facts, ['страна']));
        var genres = splitCSV(pickFact(facts, ['жанр']));
        var poster = absUrl(((doc.querySelector('.poster img') || {}).getAttribute || function () { return ''; }).call(doc.querySelector('.poster img') || {}, 'src')) || absUrl((doc.querySelector('meta[itemprop="image"]') || {}).getAttribute ? (doc.querySelector('meta[itemprop="image"]').getAttribute('content') || '') : '') || fallbackCard.img || '';
        var backdrop = absUrl((doc.querySelector('meta[property="og:image"]') || {}).getAttribute ? (doc.querySelector('meta[property="og:image"]').getAttribute('content') || '') : '') || poster;
        var descNode = doc.querySelector('[itemprop="description"]');
        var description = '';

        if (descNode) {
            var clone = descNode.cloneNode(true);
            var extra = clone.querySelectorAll('h1, h2, h3, script, style');
            for (var i = 0; i < extra.length; i++) extra[i].remove();
            description = text(clone.textContent || '');
        }

        var voteAverage = toFloat(text((doc.querySelector('[itemprop="ratingValue"]') || {}).textContent || '').replace(',', '.'), 0);
        var ratingText = doc.body ? doc.body.textContent : '';
        var parsedRatings = parseRatings(ratingText || '');
        var tv = isTvCard(title, genres, pageUrl || '');
        var genreObjects = genres.map(function (name, index) {
            return {
                id: index + 1,
                name: name
            };
        });
        var id = fallbackCard.id || extractIdFromUrl(pageUrl);
        var card = {
            id: id || hashValue(pageUrl || title),
            kinogo_id: extractIdFromUrl(pageUrl) || id || 0,
            source: SOURCE_KEY,
            url: pageUrl,
            title: title,
            original_title: title,
            overview: description || fallbackCard.overview || '',
            description: description || fallbackCard.description || '',
            vote_average: voteAverage || fallbackCard.vote_average || 0,
            kp_rating: parsedRatings.kp || fallbackCard.kp_rating || 0,
            imdb_rating: parsedRatings.imdb || fallbackCard.imdb_rating || 0,
            genres: genreObjects,
            genre_ids: genreObjects.map(function (g) { return g.id; }),
            production_companies: Array.isArray(fallbackCard.production_companies) ? fallbackCard.production_companies : [],
            production_countries: countries.map(function (name) { return { name: name }; }),
            img: poster || fallbackCard.img || './img/img_broken.svg',
            poster: poster || fallbackCard.poster || fallbackCard.img || './img/img_broken.svg',
            background_image: backdrop || fallbackCard.background_image || poster || './img/img_broken.svg',
            type: tv ? 'tv' : 'movie'
        };

        if (year > 0) {
            card.year = year;
            if (tv) card.first_air_date = year + '-01-01';
            else card.release_date = year + '-01-01';
        }

        if (tv) {
            card.name = title;
            card.original_name = title;
        }

        var directors = parsePersonNames(doc, '.actors');
        var cast = parsePersonNames(doc, '.persone');
        var persons = {
            crew: directors.map(function (name, index) {
                return {
                    id: hashValue('director_' + name + '_' + index),
                    name: name,
                    job: 'Director',
                    known_for_department: 'Directing',
                    source: SOURCE_KEY
                };
            }),
            cast: cast.map(function (name, index) {
                return {
                    id: hashValue('cast_' + name + '_' + index),
                    name: name,
                    known_for_department: 'Acting',
                    source: SOURCE_KEY
                };
            })
        };

        return {
            movie: card,
            persons: persons
        };
    }

    function buildSafeMovieFromCard(card, pageUrl) {
        var base = card || {};
        var title = text(base.title || base.name || 'KinoGO');
        var genres = Array.isArray(base.genres) ? base.genres : [];
        var countries = Array.isArray(base.production_countries) ? base.production_countries : [];
        var safe = {
            id: base.id || hashValue(pageUrl || title),
            kinogo_id: base.kinogo_id || extractIdFromUrl(pageUrl || base.url || ''),
            source: SOURCE_KEY,
            url: absUrl(base.url || pageUrl || ''),
            title: title,
            original_title: text(base.original_title || title),
            overview: text(base.overview || base.description || ''),
            description: text(base.description || base.overview || ''),
            vote_average: toFloat(base.vote_average, 0),
            kp_rating: toFloat(base.kp_rating, 0),
            imdb_rating: toFloat(base.imdb_rating, 0),
            genres: genres,
            genre_ids: Array.isArray(base.genre_ids) ? base.genre_ids : [],
            production_companies: Array.isArray(base.production_companies) ? base.production_companies : [],
            production_countries: countries,
            img: base.img || base.poster || './img/img_broken.svg',
            poster: base.poster || base.img || './img/img_broken.svg',
            background_image: base.background_image || base.poster || base.img || './img/img_broken.svg',
            type: base.type === 'tv' ? 'tv' : 'movie'
        };

        if (base.year) safe.year = toInt(base.year, 0);
        if (base.release_date) safe.release_date = base.release_date;
        if (base.first_air_date) safe.first_air_date = base.first_air_date;
        if (safe.type === 'tv') {
            safe.name = text(base.name || title);
            safe.original_name = text(base.original_name || safe.original_title || title);
        }

        return safe;
    }

    function getSeasonsByCardUrl(cardUrl, callback) {
        getEmbedMediaByCardUrl(cardUrl, function (media) {
            callback((media && media.seasons) ? media.seasons : []);
        });
    }

    function extractDirectStreams(html) {
        var data = html || '';
        var streamRegex = /https?:\/\/[^"'\\\s]+?\.(?:m3u8|mp4)(?:\?[^"'\\\s]*)?/ig;
        var found = [];
        var match;

        while ((match = streamRegex.exec(data)) !== null) {
            found.push(match[0]);
        }

        return unique(found);
    }

    function main(params, oncomplite, onerror) {
        var lines = [];
        var loaded = 0;
        var total = 2;

        function pushLine(title, url, cards, totalPages) {
            if (!cards || !cards.length) return;
            lines.push({
                title: title,
                url: url,
                page: 1,
                total_pages: totalPages || 1,
                results: cards.slice(0, 24),
                source: SOURCE_KEY
            });
        }

        function finish() {
            loaded++;
            if (loaded < total) return;

            if (lines.length) oncomplite(lines);
            else if (onerror) onerror();
        }

        requestText(BASE_URL + '/', function (html) {
            try {
                var doc = htmlToDoc(html);
                pushLine('Обновления сериалов', '/new-serial/', parseSerialUpdatesFromDoc(doc), 1);
                pushLine('Новинки', '/', parseCardsFromDoc(doc), parsePagination(doc, 1));
            } catch (e) {
                log('main parse error', e.message);
            }

            finish();
        }, finish, false, CACHE_MINUTES);

        fetchCardsPage({ url: '/filmis/novinki/', page: 1 }, function (data) {
            pushLine('Фильмы: новинки', '/filmis/novinki/', data.results, data.total_pages || 1);
            finish();
        }, finish);
    }

    function category(params, oncomplite, onerror) {
        var target = resolveListPath(params || {});

        fetchCardsPage({
            url: target,
            page: 1
        }, function (data) {
            oncomplite([{
                title: params.title || SOURCE_TITLE,
                url: target,
                page: data.page,
                total_pages: data.total_pages,
                results: data.results,
                source: SOURCE_KEY
            }]);
        }, onerror);
    }

    function list(params, oncomplite, onerror) {
        fetchCardsPage(params || {}, function (data) {
            oncomplite(data);
        }, onerror);
    }

    function full(params, oncomplite, onerror) {
        var card = params.card || {};
        var pageUrl = absUrl(card.url || params.url || cardUrlById[params.id] || '').replace(/#.*$/, '');

        function finalizeByUrl(activeCard, activeUrl, canRetryBySearch) {
            if (!activeUrl) {
                oncomplite({
                    movie: buildSafeMovieFromCard(activeCard || card, pageUrl || (activeCard || {}).url || '')
                });
                return;
            }

            requestText(activeUrl, function (html) {
                try {
                    var doc = htmlToDoc(html);
                    var keepLampaMeta = !!(activeCard && activeCard.keep_lampa_meta);
                    var parsed = keepLampaMeta
                        ? {
                            movie: buildSafeMovieFromCard(activeCard || card, activeUrl),
                            persons: { cast: [], crew: [] }
                        }
                        : parseFullCard(doc, activeCard || card, activeUrl);
                    var result = {
                        movie: parsed.movie
                    };

                    if (parsed.persons && (parsed.persons.cast.length || parsed.persons.crew.length)) {
                        result.persons = parsed.persons;
                    }

                    var directStreams = extractDirectStreams(html);

                    getEmbedMediaByCardUrl(activeUrl, function (embedMedia) {
                        var seasons = (embedMedia && embedMedia.seasons) ? embedMedia.seasons : [];
                        var embedStreams = (embedMedia && embedMedia.streams) ? embedMedia.streams : [];
                        var embedSubtitles = (embedMedia && embedMedia.subtitles) ? embedMedia.subtitles : [];

                        if (seasons.length) {
                            var isTv = !!parsed.movie.original_name || seasons.length > 1;
                            var last = seasons[seasons.length - 1];
                            var episodesCount = 0;

                            for (var i = 0; i < seasons.length; i++) episodesCount += seasons[i].episodes.length;

                            parsed.movie.number_of_seasons = seasons.length;
                            parsed.movie.number_of_episodes = episodesCount;

                            if (isTv) {
                                parsed.movie.name = parsed.movie.name || parsed.movie.title;
                                parsed.movie.original_name = parsed.movie.original_name || parsed.movie.original_title || parsed.movie.title;

                                result.episodes = {
                                    name: last.name,
                                    season_number: last.season_number,
                                    seasons_count: seasons.length,
                                    episodes: last.episodes
                                };
                            } else if (last.episodes.length) {
                                parsed.movie.kinogo_stream = pickBestStream([last.episodes[0].url || '']);
                                parsed.movie.kinogo_subtitles = uniqueSubtitleList(last.episodes[0].subtitles || []);
                                parsed.movie.url = parsed.movie.kinogo_stream || parsed.movie.url;
                            }
                        } else {
                            var streams = unique([].concat(embedStreams || [], directStreams || []));
                            var bestStream = pickBestStream(streams);

                            if (bestStream) {
                                parsed.movie.kinogo_stream = bestStream;
                                parsed.movie.url = bestStream;
                                parsed.movie.kinogo_subtitles = uniqueSubtitleList(embedSubtitles || []);
                                parsed.movie.kinogo_streams = streams.map(function (url) {
                                    var isHls = /\.m3u8(?:\?|$)/i.test(url);
                                    var isMp4 = /\.mp4(?:\?|$)/i.test(url);
                                    return {
                                        quality: isHls ? 'hls' : (isMp4 ? 'mp4' : 'auto'),
                                        url: url
                                    };
                                });
                            }
                        }

                        if (keepLampaMeta) {
                            parsed.movie.title = text((activeCard || {}).title || (activeCard || {}).name || parsed.movie.title);
                            parsed.movie.original_title = text((activeCard || {}).original_title || (activeCard || {}).original_name || parsed.movie.original_title || parsed.movie.title);
                            parsed.movie.poster = (activeCard || {}).poster || (activeCard || {}).img || parsed.movie.poster;
                            parsed.movie.img = (activeCard || {}).img || (activeCard || {}).poster || parsed.movie.img;
                            parsed.movie.background_image = (activeCard || {}).background_image || (activeCard || {}).poster || (activeCard || {}).img || parsed.movie.background_image;
                            parsed.movie.overview = text((activeCard || {}).overview || parsed.movie.overview || '');
                            parsed.movie.description = text((activeCard || {}).description || parsed.movie.description || '');
                        }

                        oncomplite(result);
                    });
                } catch (e) {
                    log('full parse error', e.message);
                    notifyError('KinoGO: ошибка парсинга карточки');
                    oncomplite({
                        movie: buildSafeMovieFromCard(activeCard || card, activeUrl)
                    });
                }
            }, function (err) {
                var status = toInt((err || {}).status, 0);

                if (status === 404 && canRetryBySearch) {
                    findKinogoCardByMovie(activeCard || card, function (foundCard) {
                        var retryUrl = foundCard && foundCard.url ? absUrl(foundCard.url).replace(/#.*$/, '') : '';

                        if (retryUrl && retryUrl !== activeUrl) {
                            var retryCard = (activeCard && activeCard.keep_lampa_meta) ? buildBridgeCard(activeCard, foundCard) : foundCard;
                            finalizeByUrl(retryCard || foundCard, retryUrl, false);
                            return;
                        }

                        openKinogoSearchFromMovie(activeCard || card || {});
                    });
                    return;
                }

                if (status === 404) {
                    openKinogoSearchFromMovie(activeCard || card || {});
                    oncomplite({
                        movie: buildSafeMovieFromCard(activeCard || card, activeUrl)
                    });
                    return;
                }

                oncomplite({
                    movie: buildSafeMovieFromCard(activeCard || card, activeUrl)
                });
            }, false, CACHE_MINUTES, {
                suppress404: true
            });
        }

        finalizeByUrl(card, pageUrl, true);
    }

    function seasons(tv, from, oncomplite) {
        var card = tv || {};
        var url = absUrl(card.url || cardUrlById[card.id] || '');
        var need = Array.isArray(from) ? from : [];

        if (!url || !need.length) {
            oncomplite({});
            return;
        }

        getSeasonsByCardUrl(url, function (allSeasons) {
            var out = {};

            for (var i = 0; i < need.length; i++) {
                var number = toInt(need[i], 0);
                var selected = null;

                for (var j = 0; j < allSeasons.length; j++) {
                    if (toInt(allSeasons[j].season_number, 0) === number) {
                        selected = allSeasons[j];
                        break;
                    }
                }

                out['' + number] = selected ? {
                    name: selected.name,
                    season_number: selected.season_number,
                    seasons_count: allSeasons.length,
                    episodes: selected.episodes
                } : {
                    name: 'Сезон ' + number,
                    season_number: number,
                    seasons_count: allSeasons.length,
                    episodes: []
                };
            }

            oncomplite(out);
        });
    }

    function menu(params, oncomplite) {
        if (menuCache.expires > now() && menuCache.items.length) {
            oncomplite(menuCache.items);
            return;
        }

        requestText(BASE_URL + '/', function (html) {
            try {
                var doc = htmlToDoc(html);
                var links = doc.querySelectorAll('a[href]');
                var items = [
                    { title: 'Новинки', id: '/' },
                    { title: 'Фильмы', id: '/filmis/' },
                    { title: 'Сериалы', id: '/new-serial/' }
                ];
                var seen = {
                    '/': true,
                    '/filmis/': true,
                    '/new-serial/': true
                };

                for (var i = 0; i < links.length; i++) {
                    var href = links[i].getAttribute('href') || '';
                    var title = text(links[i].textContent || '');

                    if (!title) continue;
                    if (
                        href.indexOf('/filmis/') !== 0 &&
                        href.indexOf('/xfsearch/') !== 0 &&
                        href.indexOf('/new-serial/') !== 0 &&
                        !/^\/film-\d{4}\//.test(href) &&
                        !/^\/filmi-\d{4}\//.test(href)
                    ) continue;
                    if (href.indexOf('/index.php') === 0) continue;
                    if (seen[href]) continue;

                    seen[href] = true;
                    items.push({
                        title: title,
                        id: href
                    });
                }

                menuCache.items = items;
                menuCache.expires = now() + 1000 * 60 * CACHE_MINUTES;

                oncomplite(items);
            } catch (e) {
                log('menu parse error', e.message);
                oncomplite([
                    { title: 'Новинки', id: '/' },
                    { title: 'Фильмы', id: '/filmis/' },
                    { title: 'Сериалы', id: '/new-serial/' }
                ]);
            }
        }, function () {
            oncomplite([
                { title: 'Новинки', id: '/' },
                { title: 'Фильмы', id: '/filmis/' },
                { title: 'Сериалы', id: '/new-serial/' }
            ]);
        }, false, CACHE_MINUTES);
    }

    function menuCategory(params, oncomplite) {
        var action = (params && params.action) || 'movie';
        if (action === 'tv') {
            oncomplite([
                { title: 'Новинки сериалов', url: '/new-serial/' },
                { title: 'Популярные сериалы', url: '/new-serial/' }
            ]);
        } else {
            oncomplite([
                { title: 'Новинки', url: '/' },
                { title: 'Все фильмы', url: '/filmis/' }
            ]);
        }
    }

    function isLikelyMediaResult(card) {
        if (!card || !card.url) return false;
        if (!looksLikeCardUrl(card.url)) return false;

        var title = (card.title || card.name || '').toLowerCase();
        var hasYear = !!card.year || /\((19|20)\d{2}\)/.test(title);
        var mediaHint = /(сезон|серия|сериал|фильм|movie|film|serial|anime)/i.test(title);
        var hasGenres = Array.isArray(card.genres) && card.genres.length > 0;

        if (hasYear || mediaHint || hasGenres) return true;
        if (card.img && card.img.indexOf('img_broken') === -1) return true;

        return false;
    }

    function normalizeForMatch(value) {
        return text((value || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/[^a-zа-я0-9]+/gi, ' '));
    }

    function extractYearFromDate(dateStr) {
        var match = ((dateStr || '') + '').match(/(19|20)\d{2}/);
        return match ? toInt(match[0], 0) : 0;
    }

    function extractMovieYear(movie) {
        if (!movie) return 0;
        var year = toInt(movie.year, 0);
        if (year > 0) return year;

        year = extractYearFromDate(movie.release_date);
        if (year > 0) return year;

        year = extractYearFromDate(movie.first_air_date);
        if (year > 0) return year;

        return 0;
    }

    function extractCardYear(card) {
        if (!card) return 0;
        var year = toInt(card.year, 0);
        if (year > 0) return year;

        year = extractYearFromDate(card.release_date);
        if (year > 0) return year;

        year = extractYearFromDate(card.first_air_date);
        if (year > 0) return year;

        return 0;
    }

    function movieTitleVariants(movie) {
        var raw = [];
        var out = [];
        var uniq = {};

        if (!movie) return out;

        raw.push(movie.title || '');
        raw.push(movie.name || '');
        raw.push(movie.original_title || '');
        raw.push(movie.original_name || '');

        for (var i = 0; i < raw.length; i++) {
            var candidate = text(raw[i] || '');
            if (!candidate) continue;
            var norm = normalizeForMatch(candidate);
            if (!norm || uniq[norm]) continue;
            uniq[norm] = true;
            out.push(candidate);
        }

        return out;
    }

    function dedupeCards(cards) {
        var list = Array.isArray(cards) ? cards : [];
        var out = [];
        var seen = {};

        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var key = (item && item.url) || (item && item.id) || ('idx_' + i);
            if (!item || seen[key]) continue;
            seen[key] = true;
            out.push(item);
        }

        return out;
    }

    function scoreCardMatch(card, titleNorms, year) {
        if (!card) return 0;

        var score = 0;
        var cardTitle = normalizeForMatch(card.title || card.name || '');
        var cardYear = extractCardYear(card);

        for (var i = 0; i < titleNorms.length; i++) {
            var q = titleNorms[i];
            if (!q || !cardTitle) continue;
            if (cardTitle === q) score += 100;
            else if (cardTitle.indexOf(q) >= 0) score += 70;
            else if (q.indexOf(cardTitle) >= 0) score += 40;
        }

        if (year > 0 && cardYear > 0) {
            if (year === cardYear) score += 25;
            else if (Math.abs(year - cardYear) === 1) score += 8;
        }

        return score;
    }

    function openKinogoSearchFromMovie(movie) {
        var query = '';
        if (movie) query = text(movie.title || movie.name || movie.original_title || movie.original_name || '');
        if (!query) {
            notifyError('KinoGO: пустой запрос поиска');
            return;
        }
        notifyError('KinoGO: не удалось найти соответствие для "' + query + '"');
    }

    function findKinogoCardByMovie(movie, onDone) {
        var variants = movieTitleVariants(movie);
        var titleNorms = [];
        var year = extractMovieYear(movie);
        var merged = [];
        var maxQueries = Math.min(2, variants.length);
        var index = 0;

        for (var i = 0; i < variants.length; i++) {
            titleNorms.push(normalizeForMatch(variants[i]));
        }

        if (!maxQueries) {
            onDone(null);
            return;
        }

        function finish() {
            var candidates = dedupeCards(merged);
            var best = null;
            var bestScore = 0;

            for (var n = 0; n < candidates.length; n++) {
                var card = candidates[n];
                var score = scoreCardMatch(card, titleNorms, year);
                if (score > bestScore) {
                    bestScore = score;
                    best = card;
                }
            }

                if (best && bestScore >= 70) onDone(best);
                else if (candidates.length) onDone(candidates[0]);
                else onDone(null);
            }

        function next() {
            if (index >= maxQueries) {
                finish();
                return;
            }

            var query = variants[index++];

            fetchCardsPage({ query: query, page: 1 }, function (data) {
                if (data && Array.isArray(data.results)) {
                    merged = merged.concat(data.results);
                }
                next();
            }, function () {
                next();
            });
        }

        next();
    }

    function buildBridgeCard(movie, kinogoCard) {
        var sourceMovie = movie || {};
        var found = kinogoCard || {};
        var isTv = sourceMovie.type === 'tv' || !!sourceMovie.name || !!sourceMovie.first_air_date;
        var fallbackTitle = text(sourceMovie.title || sourceMovie.name || found.title || found.name || 'KinoGO');
        var bridge = buildSafeMovieFromCard(sourceMovie, found.url || sourceMovie.url || '');

        bridge.source = SOURCE_KEY;
        bridge.keep_lampa_meta = true;
        bridge.url = absUrl(found.url || sourceMovie.url || bridge.url || '');
        bridge.kinogo_id = extractIdFromUrl(bridge.url) || bridge.kinogo_id || 0;
        bridge.type = isTv ? 'tv' : 'movie';
        bridge.title = text(sourceMovie.title || sourceMovie.name || bridge.title || fallbackTitle);
        bridge.original_title = text(sourceMovie.original_title || sourceMovie.original_name || bridge.original_title || bridge.title);
        bridge.poster = sourceMovie.poster || sourceMovie.img || bridge.poster;
        bridge.img = sourceMovie.img || sourceMovie.poster || bridge.img;
        bridge.background_image = sourceMovie.background_image || sourceMovie.poster || sourceMovie.img || bridge.background_image;
        bridge.overview = text(sourceMovie.overview || bridge.overview || '');
        bridge.description = text(sourceMovie.description || bridge.description || '');

        if (isTv) {
            bridge.name = text(sourceMovie.name || bridge.name || bridge.title);
            bridge.original_name = text(sourceMovie.original_name || bridge.original_name || bridge.original_title || bridge.name);
        }

        cardUrlById[bridge.id] = bridge.url;
        return bridge;
    }

    function playMovieDirect(movie, kinogoCard, onFail) {
        var card = kinogoCard || {};
        var pageUrl = absUrl(card.url || '');

        if (!pageUrl) {
            if (typeof onFail === 'function') onFail();
            return;
        }

        getEmbedMediaByCardUrl(pageUrl, function (media) {
            var streams = (media && media.streams) ? media.streams : [];
            var subtitles = (media && media.subtitles) ? media.subtitles : [];
            var seasons = (media && media.seasons) ? media.seasons : [];

            if ((!streams || !streams.length) && seasons.length && seasons[0].episodes && seasons[0].episodes.length) {
                var firstEpisode = seasons[0].episodes[0];
                streams = unique([firstEpisode.url || '', firstEpisode.hls || '', firstEpisode.mp4 || '']);
                subtitles = uniqueSubtitleList(firstEpisode.subtitles || []);
            }

            var stream = pickBestStream(streams || []);

            if (!stream || !window.Lampa || !Lampa.Player || typeof Lampa.Player.play !== 'function') {
                if (typeof onFail === 'function') onFail();
                return;
            }

            var playItem = {
                title: text((movie || {}).title || (movie || {}).name || card.title || card.name || 'KinoGO'),
                url: stream
            };

            if (subtitles && subtitles.length) playItem.subtitles = subtitles;

            try {
                Lampa.Player.play(playItem);
            } catch (e) {
                if (typeof onFail === 'function') onFail();
            }
        });
    }

    function openKinogoFromCardMovie(movie) {
        if (!movie) {
            notifyError('KinoGO: фильм не найден в карточке');
            return;
        }

        findKinogoCardByMovie(movie, function (card) {
            if (!card) {
                notifyError('KinoGO: не удалось найти фильм на источнике');
                return;
            }

            var bridgeCard = buildBridgeCard(movie, card);
            var isTv = bridgeCard.type === 'tv' || !!bridgeCard.name || !!bridgeCard.original_name;

            if (!isTv) {
                playMovieDirect(movie, card, function () {
                    notifyError('KinoGO: поток не найден');
                });
                return;
            }

            Lampa.Activity.push({
                url: '',
                title: (movie && (movie.title || movie.name)) || card.title || card.name || 'KinoGO',
                component: 'full',
                card: bridgeCard,
                source: SOURCE_KEY
            });
        });
    }

    function addCardBridgeButton(render, movie) {
        if (!render || !render.length || !window.$) return;
        var context = render;
        var root = render.closest ? render.closest('.full-start, .full-start-new, .full-start__buttons, .full-start-new__buttons') : $();
        var hasButton = false;

        if (render.find && render.find('.kinogo-bridge-button').length) hasButton = true;
        if (!hasButton && root.length && root.find('.kinogo-bridge-button').length) hasButton = true;
        if (hasButton) return;

        var btn = $('<div class="full-start__button selector kinogo-bridge-button">KinoGO</div>');

        function runBridgeOpen(event) {
            if (event && event.preventDefault) event.preventDefault();
            if (event && event.stopPropagation) event.stopPropagation();

            var ts = now();
            if (bridgeOpenBusy || (ts - bridgeOpenAt < 1200)) return;
            bridgeOpenAt = ts;
            bridgeOpenBusy = true;

            openKinogoFromCardMovie(movie || resolveActiveMovieCard() || {});

            setTimeout(function () {
                bridgeOpenBusy = false;
            }, 1200);
        }

        btn.on('hover:enter', runBridgeOpen);
        btn.on('click', runBridgeOpen);

        if (context.hasClass && (context.hasClass('full-start__button') || context.hasClass('view--torrent') || context.hasClass('view--online') || context.hasClass('view--kinogo-bridge'))) {
            context.after(btn);
            return;
        }

        if (context.children && context.children('.full-start__button').length) {
            context.children('.full-start__button').last().after(btn);
            return;
        }

        context.append(btn);
    }

    function resolveActiveMovieCard() {
        try {
            if (!Lampa.Activity || !Lampa.Activity.active) return null;
            var active = Lampa.Activity.active();
            if (!active || active.component !== 'full') return null;

            return active.card || (active.activity && active.activity.card) || null;
        } catch (e) {
            return null;
        }
    }

    function ensureBridgeInActiveFull() {
        try {
            if (!Lampa.Activity || !Lampa.Activity.active) return;
            var active = Lampa.Activity.active();
            if (!active || active.component !== 'full' || !active.activity || !active.activity.render) return;

            var root = active.activity.render();
            if (!root || !root.length) return;

            var place = root.find('.view--torrent');
            if (!place.length) place = root.find('.full-start');
            if (!place.length) place = root.find('.full-start-new');
            if (!place.length) place = root;

            addCardBridgeButton(place, resolveActiveMovieCard());
        } catch (e) {}
    }

    function bindCardBridge() {
        if (cardBridgeBound) return true;
        if (!window.Lampa || !Lampa.Listener) return false;

        cardBridgeBound = true;

        Lampa.Listener.follow('full', function (e) {
            try {
                if (!e || e.type !== 'complite' || !e.data || !e.data.movie) return;
                var act = e.object && e.object.activity;
                if (!act || !act.render) return;

                var root = act.render();
                var place = root.find('.view--torrent');
                if (!place.length) place = root.find('.full-start');
                if (!place.length) place = root;

                addCardBridgeButton(place, e.data.movie);
            } catch (err) {
                log('card bridge error', err.message);
            }
        });

        try {
            var active = Lampa.Activity && Lampa.Activity.active ? Lampa.Activity.active() : null;
            if (active && active.component === 'full' && active.activity && active.activity.render) {
                var activePlace = active.activity.render().find('.view--torrent');
                if (!activePlace.length) activePlace = active.activity.render().find('.full-start');
                if (!activePlace.length) activePlace = active.activity.render();
                addCardBridgeButton(activePlace, active.card || {});
            }
        } catch (e) {}

        if (!cardBridgeTimer) {
            cardBridgeTimer = setInterval(ensureBridgeInActiveFull, 1500);
        }

        return true;
    }

    function search(params, oncomplite, maybeOncomplite) {
        var input = params;
        var page = 1;
        var callback = oncomplite;

        if (typeof params === 'string') {
            if (typeof oncomplite === 'function') {
                input = { query: params, page: 1 };
                callback = oncomplite;
            } else {
                input = { query: params, page: toInt(oncomplite, 1) };
                callback = maybeOncomplite;
            }
        }

        if (typeof callback !== 'function') callback = function () {};

        var query = normalizeQuery((input || {}).query || '');
        page = Math.max(1, toInt((input || {}).page, 1));

        if (!query || query.length < 2) {
            callback([]);
            return;
        }

        fetchCardsPage({ query: query, page: page }, function (data) {
            var filtered = data.results.filter(isLikelyMediaResult);
            var base = filtered.length ? filtered : data.results;
            var movie = [];
            var tv = [];

            for (var i = 0; i < base.length; i++) {
                if (base[i].name) tv.push(base[i]);
                else movie.push(base[i]);
            }

            var out = [];

            if (movie.length) out.push({ title: 'Фильмы', type: 'movie', results: movie });
            if (tv.length) out.push({ title: 'Сериалы', type: 'tv', results: tv });
            if (!out.length && data.results.length) out.push({ title: 'Результаты', type: 'movie', results: data.results });

            callback(out);
        }, function () {
            callback([]);
        });
    }

    function discovery() {
        return {
            title: SOURCE_TITLE,
            search: search,
            params: {
                save: true
            },
            onMore: function (params, close) {
                if (close) close();

                Lampa.Activity.push({
                    url: '',
                    title: 'Поиск - ' + (params.query || ''),
                    component: 'category_full',
                    page: 1,
                    query: encodeURIComponent(params.query || ''),
                    source: SOURCE_KEY
                });
            },
            onCancel: function () {
                var req = ensureNetwork();
                if (req) req.clear();
            }
        };
    }

    function clear() {
        var req = ensureNetwork();
        if (req) req.clear();
        memoryCache = {};
        seasonsByUrl = {};
        embedMediaByUrl = {};
    }

    var sourceApi = {
        main: main,
        category: category,
        list: list,
        full: full,
        seasons: seasons,
        menu: menu,
        menuCategory: menuCategory,
        search: search,
        discovery: discovery,
        clear: clear
    };

    function ensureMainSourceNotKinogo() {
        try {
            if (!window.Lampa || !Lampa.Storage || typeof Lampa.Storage.get !== 'function') return;
            var selected = Lampa.Storage.get('source', 'tmdb');
            if (selected === SOURCE_KEY && typeof Lampa.Storage.set === 'function') {
                Lampa.Storage.set('source', 'tmdb');
            }
        } catch (e) {}
    }

    function hideKinogoInSourceSettings() {
        try {
            if (!window.Lampa || !Lampa.Params || typeof Lampa.Params.select !== 'function') return;
            if (Lampa.Params.select.__kinogo_hide_wrapped) return;

            var originalSelect = Lampa.Params.select;

            Lampa.Params.select = function (name, values, current) {
                if (name === 'source' && values && typeof values === 'object') {
                    var clean = {};

                    for (var key in values) {
                        if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
                        if (key === SOURCE_KEY) continue;
                        clean[key] = values[key];
                    }

                    values = clean;
                    if (current === SOURCE_KEY) current = 'tmdb';
                }

                return originalSelect.call(this, name, values, current);
            };

            Lampa.Params.select.__kinogo_hide_wrapped = true;
        } catch (e) {}
    }

    function registerProxySettings() {
        try {
            if (!window.Lampa || !Lampa.Params || !Lampa.SettingsApi) return;
            if (window.__kinogo_proxy_settings_registered) return;

            Lampa.Params.select('kinogo_proxy', '', '');

            if (typeof Lampa.SettingsApi.addComponent === 'function') {
                Lampa.SettingsApi.addComponent({
                    component: 'kinogo_proxy',
                    icon: '<svg height="36" viewBox="0 0 42 46" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 2C15.201 2 10.5 6.701 10.5 12.5V20H7a5 5 0 0 0-5 5v14a5 5 0 0 0 5 5h28a5 5 0 0 0 5-5V25a5 5 0 0 0-5-5h-3.5v-7.5C31.5 6.701 26.799 2 21 2Zm-6.5 10.5a6.5 6.5 0 1 1 13 0V20h-13v-7.5Z" stroke="white" stroke-width="3"/></svg>',
                    name: 'KinoGO'
                });
            }

            if (typeof Lampa.SettingsApi.addParam === 'function') {
                Lampa.SettingsApi.addParam({
                    component: 'kinogo_proxy',
                    param: {
                        type: 'title'
                    },
                    field: {
                        name: 'Прокси'
                    }
                });

                Lampa.SettingsApi.addParam({
                    component: 'kinogo_proxy',
                    param: {
                        name: 'kinogo_proxy',
                        type: 'input',
                        default: '',
                        placeholder: 'https://cors.eu.org/{url}'
                    },
                    field: {
                        name: 'CORS proxy URL',
                        description: 'Пример: https://cors.eu.org/{url} или https://api.codetabs.com/v1/proxy?quest={url}'
                    }
                });

                Lampa.SettingsApi.addParam({
                    component: 'kinogo_proxy',
                    param: {
                        type: 'button'
                    },
                    field: {
                        name: 'Сбросить прокси'
                    },
                    onChange: function () {
                        Lampa.Storage.set('kinogo_proxy', '');
                        Lampa.Noty.show('KinoGO: прокси очищен');
                    }
                });
            }

            window.__kinogo_proxy_settings_registered = true;
        } catch (e) {
            log('proxy settings error', e.message);
        }
    }

    function register() {
        if (!Lampa || !Lampa.Api || !Lampa.Api.sources) return;

        try {
            Object.defineProperty(Lampa.Api.sources, SOURCE_KEY, {
                value: sourceApi,
                configurable: true,
                writable: true,
                enumerable: false
            });
        } catch (e) {
            Lampa.Api.sources[SOURCE_KEY] = sourceApi;
        }

        log('source registered');
    }

    function start() {
        try {
            ensureMainSourceNotKinogo();
            hideKinogoInSourceSettings();
            registerProxySettings();
            register();
            bindCardBridge();
        } catch (e) {
            log('start error', e.message);
            notifyError('KinoGO: ошибка инициализации источника');
        }
    }

    function bindListeners() {
        if (listenersBound) return true;
        if (!window.Lampa || !Lampa.Listener || !Lampa.Api) return false;

        listenersBound = true;

        if (window.appready) {
            start();
        } else {
            Lampa.Listener.follow('app', function (e) {
                if (e.type === 'ready') start();
            });
            Lampa.Listener.follow('appready', start);
        }

        return true;
    }

    if (!bindListeners()) {
        var retries = 0;
        var waitTimer = setInterval(function () {
            retries++;
            if (bindListeners() || retries > 120) clearInterval(waitTimer);
        }, 500);
    }
})();
