(function() {
    'use strict';

    if (typeof window === 'undefined' || !window.Lampa) {
        return;
    }

    if (window.__KINOSEARCH_PLUGIN__) {
        return;
    }
    window.__KINOSEARCH_PLUGIN__ = true;

    var PLUGIN_VERSION = '20260404-1';
    var LOG_PREFIX = '[KinoSearch]';
    var REQUEST_TIMEOUT = 8000;
    var SOURCE_ID = 'kinosearch';
    var SETTINGS_NS = 'kinosearch';

    var QUALITY_ORDER = ['1080p', '720p', '480p', '360p'];
    var QUALITY_SCORE = {
        '1080p': 4,
        '720p': 3,
        '480p': 2,
        '360p': 1
    };

    var BALANCERS = [
        {
            id: 'kodik',
            title: 'Kodik',
            priority: 1,
            buildUrl: function(ctx) {
                return buildUrl('https://kodikapi.com/search', {
                    token: '447d179e875edd2c4a6da5ba42065956836befa4',
                    title: ctx.title || '',
                    kinopoisk_id: ctx.kpId || '',
                    with_material_data: 'true',
                    types: 'movie,foreign-movie,serial,foreign-serial,cartoon,anime'
                });
            },
            parse: function(json, ctx) {
                var out = [];
                var results = toArray(json && json.results);
                var i;

                for (i = 0; i < results.length; i++) {
                    out = out.concat(parseKodikResult(results[i], ctx));
                }

                return out;
            }
        },
        {
            id: 'collaps',
            title: 'Collaps',
            priority: 2,
            buildUrl: function(ctx) {
                return buildUrl('https://api.bhcesh.me/list', {
                    token: 'eedefb541aeba871dcfc756e6b31c02e',
                    kinopoisk_id: ctx.kpId || ''
                });
            },
            parse: function(json) {
                var out = [];
                var results = toArray(json && json.results);
                var i;

                for (i = 0; i < results.length; i++) {
                    out = out.concat(normalizeSourceItem('Collaps', results[i], 'iframe_url'));
                }

                return out;
            }
        },
        {
            id: 'alloha',
            title: 'Alloha',
            priority: 3,
            buildUrl: function(ctx) {
                return buildUrl('https://api.alloha.tv/', {
                    token: '04941a9a3ca3ac16e2b4327347bbc1',
                    kp: ctx.kpId || ''
                });
            },
            parse: function(json) {
                var payload = json && json.data ? json.data : json;
                return normalizeSourceItem('Alloha', payload, 'iframe');
            }
        },
        {
            id: 'hdvb',
            title: 'HDVB',
            priority: 4,
            buildUrl: function(ctx) {
                return buildUrl('https://apivb.info/api/videos.json', {
                    token: 'e50dcbb9f6b83c95dd2aedbeb3cc3a3e3f',
                    kinopoisk_id: ctx.kpId || ''
                });
            },
            parse: function(json) {
                var out = [];
                var list = toArray(json);
                var i;

                for (i = 0; i < list.length; i++) {
                    out = out.concat(normalizeSourceItem('HDVB', list[i], 'iframe_url'));
                }

                return out;
            }
        },
        {
            id: 'videocdn',
            title: 'VideoCDN',
            priority: 5,
            buildUrl: function(ctx) {
                return buildUrl('https://videocdn.tv/api/short', {
                    api_token: '3i40G5TSECmLF77oAqnEgbx61ZWaOYaE',
                    kinopoisk_id: ctx.kpId || '',
                    limit: 1
                });
            },
            parse: function(json) {
                var out = [];
                var list = toArray(json && json.data);
                var i;

                for (i = 0; i < list.length; i++) {
                    out = out.concat(normalizeSourceItem('VideoCDN', list[i], 'iframe_src'));
                }

                return out;
            }
        }
    ];

    var serialCache = {};
    var cardBridgeBound = false;
    var cardBridgeTimer = null;

    function log(msg) {
        try {
            console.log(LOG_PREFIX + ' ' + msg);
        }
        catch (e) {}
    }

    function logError(msg, err) {
        try {
            console.error(LOG_PREFIX + ' ' + msg, err || '');
        }
        catch (e) {}
    }

    function toArray(value) {
        return Array.isArray(value) ? value : [];
    }

    function buildUrl(base, params) {
        var chunks = [];
        var key;

        for (key in params) {
            if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
            if (params[key] === undefined || params[key] === null || params[key] === '') continue;
            chunks.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(params[key])));
        }

        if (!chunks.length) return base;
        return base + (base.indexOf('?') === -1 ? '?' : '&') + chunks.join('&');
    }

    function readStorage(key, fallback) {
        try {
            if (Lampa.Storage && typeof Lampa.Storage.get === 'function') {
                var value = Lampa.Storage.get(SETTINGS_NS + '_' + key, fallback);
                return value === undefined || value === null ? fallback : value;
            }
        }
        catch (e) {
            logError('Storage get failed: ' + key, e);
        }
        return fallback;
    }

    function writeStorage(key, value) {
        try {
            if (Lampa.Storage && typeof Lampa.Storage.set === 'function') {
                Lampa.Storage.set(SETTINGS_NS + '_' + key, value);
            }
        }
        catch (e) {
            logError('Storage set failed: ' + key, e);
        }
    }

    function normalizeQuality(raw) {
        if (!raw) return '';
        var text = String(raw).toLowerCase();
        if (text.indexOf('1080') !== -1 || text.indexOf('fhd') !== -1) return '1080p';
        if (text.indexOf('720') !== -1 || text.indexOf('hd') !== -1) return '720p';
        if (text.indexOf('480') !== -1 || text.indexOf('sd') !== -1) return '480p';
        if (text.indexOf('360') !== -1) return '360p';
        return '';
    }

    function detectQualityFromText() {
        var i;
        for (i = 0; i < arguments.length; i++) {
            var q = normalizeQuality(arguments[i]);
            if (q) return q;
        }
        return '';
    }

    function getMinQuality() {
        var value = readStorage('min_quality', '720p');
        if (!QUALITY_SCORE[value]) return '720p';
        return value;
    }

    function pickBestQuality(available, minQuality) {
        var list = [];
        var i;

        for (i = 0; i < available.length; i++) {
            if (QUALITY_SCORE[available[i]]) list.push(available[i]);
        }

        if (!list.length) return '';

        list.sort(function(a, b) {
            return QUALITY_SCORE[b] - QUALITY_SCORE[a];
        });

        if (!QUALITY_SCORE[minQuality]) return list[0];

        for (i = 0; i < list.length; i++) {
            if (QUALITY_SCORE[list[i]] >= QUALITY_SCORE[minQuality]) {
                return list[i];
            }
        }

        return list[0];
    }

    function getKpId(card, done) {
        var kpId = card && (card.kinopoisk_id || card.kp_id || ((card.externalIds || {}).kinopoiskHdId || (card.external_ids || {}).kinopoiskHdId));

        if (kpId) {
            done(null, String(kpId));
            return;
        }

        var title = card && (card.title || card.name || card.original_title || card.original_name || '');
        if (!title) {
            done(new Error('Нет KP ID и названия для fallback поиска'));
            return;
        }

        var url = buildUrl('https://kodikapi.com/search', {
            token: '447d179e875edd2c4a6da5ba42065956836befa4',
            title: title,
            with_material_data: 'true',
            limit: 1
        });

        requestJson(url, function(err, json) {
            if (err) {
                done(err);
                return;
            }

            var results = toArray(json && json.results);
            if (!results.length) {
                done(new Error('Kodik fallback не вернул результатов'));
                return;
            }

            var result = results[0] || {};
            var found = result.kinopoisk_id || (result.material_data && result.material_data.kinopoisk_id);
            if (!found) {
                done(new Error('Kodik fallback не вернул kinopoisk_id'));
                return;
            }

            done(null, String(found));
        });
    }

    function requestJson(url, done) {
        var finished = false;
        var timer = setTimeout(function() {
            if (!finished) {
                finished = true;
                done(new Error('timeout'));
            }
        }, REQUEST_TIMEOUT + 250);

        function finish(err, data) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);

            if (err) {
                done(err);
                return;
            }

            if (typeof data === 'string') {
                try {
                    data = JSON.parse(data);
                }
                catch (parseErr) {
                    done(parseErr);
                    return;
                }
            }

            done(null, data);
        }

        try {
            var requester = null;
            if (typeof Lampa.Reguest === 'function') requester = new Lampa.Reguest();

            var ok = function(response) {
                finish(null, response);
            };
            var fail = function(error) {
                finish(error || new Error('request failed'));
            };

            if (requester && typeof requester.silent === 'function') {
                requester.silent(url, ok, fail, false, { timeout: REQUEST_TIMEOUT });
                return;
            }

            if (requester && typeof requester.get === 'function') {
                requester.get(url, ok, fail, false, { timeout: REQUEST_TIMEOUT });
                return;
            }

            if (Lampa.Reguest && typeof Lampa.Reguest.get === 'function') {
                Lampa.Reguest.get(url, ok, fail, false, { timeout: REQUEST_TIMEOUT });
                return;
            }

            finish(new Error('Lampa.Reguest API недоступен'));
        }
        catch (e) {
            finish(e);
        }
    }

    function normalizeSourceItem(balancerTitle, payload, directKey) {
        var out = [];
        var url = payload && payload[directKey] ? payload[directKey] : '';

        if (isHttpUrl(url)) {
            out.push({
                id: balancerTitle + '_' + hash(url),
                balancer: balancerTitle,
                quality: detectQualityFromText(payload && payload.quality, payload && payload.quality_label, url) || 'unknown',
                translation: String(payload && (payload.translation || payload.voice || payload.translator || payload.audio || 'Озвучка по умолчанию')),
                url: url,
                type: String(payload && payload.type || 'movie')
            });
        }

        if (!out.length) {
            out = out.concat(extractGenericLinks(payload, balancerTitle));
        }

        return dedupeByUrl(out);
    }

    function parseKodikResult(item, ctx) {
        var out = [];
        var baseUrl = item && (item.link || item.iframe_url || item.player_link || '');
        var material = item && item.material_data ? item.material_data : {};
        var quality = detectQualityFromText(item && item.quality, material && material.quality, baseUrl);
        var translation = item && (item.translation_title || item.translation || item.translator || material && material.translation || 'Озвучка по умолчанию');

        if (isHttpUrl(baseUrl)) {
            out.push({
                id: 'Kodik_' + hash(baseUrl),
                balancer: 'Kodik',
                quality: quality || 'unknown',
                translation: String(translation),
                url: baseUrl,
                type: (ctx && ctx.isTv) || (item && item.type && String(item.type).indexOf('serial') !== -1) ? 'tv' : 'movie'
            });
        }

        var parsedSeasons = extractKodikSeasons(item, translation, quality);
        if (parsedSeasons.length) {
            out.push({
                id: 'Kodik_serial_' + hash(JSON.stringify(parsedSeasons)),
                balancer: 'Kodik',
                quality: quality || 'unknown',
                translation: String(translation),
                url: baseUrl || '',
                type: 'tv',
                seasons: parsedSeasons
            });
        }

        if (!out.length) {
            out = out.concat(extractGenericLinks(item, 'Kodik'));
        }

        return dedupeByUrl(out);
    }

    function extractKodikSeasons(item, translation, defaultQuality) {
        var out = [];
        var seasons = item && item.seasons;
        var seasonKey;

        if (!seasons || typeof seasons !== 'object') return out;

        for (seasonKey in seasons) {
            if (!Object.prototype.hasOwnProperty.call(seasons, seasonKey)) continue;

            var episodesObj = seasons[seasonKey];
            var episodeKey;
            var seasonEntry = {
                season_number: parseInt(seasonKey, 10) || 1,
                episodes: []
            };

            if (!episodesObj || typeof episodesObj !== 'object') continue;

            for (episodeKey in episodesObj) {
                if (!Object.prototype.hasOwnProperty.call(episodesObj, episodeKey)) continue;

                var episodePayload = episodesObj[episodeKey];
                var candidates = extractGenericLinks(episodePayload, 'Kodik');
                var chosen = chooseSourceByQuality(candidates, getMinQuality());

                if (chosen && chosen.url) {
                    seasonEntry.episodes.push({
                        episode_number: parseInt(episodeKey, 10) || 1,
                        title: 'Серия ' + episodeKey + ' (' + String(translation || 'Озвучка') + ')',
                        url: chosen.url,
                        quality: chosen.quality || defaultQuality || 'unknown',
                        translation: String(translation || chosen.translation || 'Озвучка по умолчанию')
                    });
                }
            }

            seasonEntry.episodes.sort(function(a, b) {
                return a.episode_number - b.episode_number;
            });

            if (seasonEntry.episodes.length) {
                out.push(seasonEntry);
            }
        }

        out.sort(function(a, b) {
            return a.season_number - b.season_number;
        });

        return out;
    }

    function extractGenericLinks(payload, balancerTitle) {
        var found = [];

        function walk(node, path, contextTranslation) {
            var key;
            if (node === null || node === undefined) return;

            if (typeof node === 'string') {
                if (isHttpUrl(node)) {
                    found.push({
                        id: balancerTitle + '_' + hash(path + ':' + node),
                        balancer: balancerTitle,
                        quality: detectQualityFromText(path, node) || 'unknown',
                        translation: contextTranslation || 'Озвучка по умолчанию',
                        url: node,
                        type: 'movie'
                    });
                }
                return;
            }

            if (Array.isArray(node)) {
                for (key = 0; key < node.length; key++) {
                    walk(node[key], path + '[' + key + ']', contextTranslation);
                }
                return;
            }

            if (typeof node === 'object') {
                var nextTranslation = contextTranslation;
                if (node.translation || node.translator || node.voice || node.audio || node.translation_title) {
                    nextTranslation = String(node.translation || node.translator || node.voice || node.audio || node.translation_title);
                }

                for (key in node) {
                    if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
                    walk(node[key], path + '.' + key, nextTranslation);
                }
            }
        }

        walk(payload, balancerTitle, 'Озвучка по умолчанию');
        return dedupeByUrl(found);
    }

    function dedupeByUrl(items) {
        var map = {};
        var out = [];
        var i;

        for (i = 0; i < items.length; i++) {
            var item = items[i];
            if (!item || !isHttpUrl(item.url)) continue;
            if (map[item.url]) continue;
            map[item.url] = true;
            out.push(item);
        }

        return out;
    }

    function hash(text) {
        var i;
        var h = 0;
        var str = String(text || '');

        for (i = 0; i < str.length; i++) {
            h = ((h << 5) - h) + str.charCodeAt(i);
            h |= 0;
        }

        return String(Math.abs(h));
    }

    function isHttpUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    function chooseSourceByQuality(items, minQuality) {
        var available = [];
        var i;

        for (i = 0; i < items.length; i++) {
            if (items[i].quality && QUALITY_SCORE[items[i].quality]) {
                available.push(items[i].quality);
            }
        }

        var bestQuality = pickBestQuality(available, minQuality);

        if (bestQuality) {
            for (i = 0; i < items.length; i++) {
                if (items[i].quality === bestQuality) return items[i];
            }
        }

        return items.length ? items[0] : null;
    }

    function balancerEnabled(balancerId) {
        return !!readStorage('enabled_' + balancerId, true);
    }

    function collectSources(ctx, done) {
        var enabled = [];
        var i;

        for (i = 0; i < BALANCERS.length; i++) {
            if (balancerEnabled(BALANCERS[i].id)) {
                enabled.push(BALANCERS[i]);
            }
        }

        if (!enabled.length) {
            done(null, []);
            return;
        }

        var pending = enabled.length;
        var aggregated = [];

        function finishOne() {
            pending -= 1;
            if (pending === 0) {
                aggregated.sort(function(a, b) {
                    var pa = balancerPriority(a.balancer);
                    var pb = balancerPriority(b.balancer);
                    if (pa !== pb) return pa - pb;
                    return (QUALITY_SCORE[b.quality] || 0) - (QUALITY_SCORE[a.quality] || 0);
                });
                done(null, dedupeByUrl(aggregated));
            }
        }

        for (i = 0; i < enabled.length; i++) {
            (function(balancer) {
                var url = balancer.buildUrl(ctx);
                requestJson(url, function(err, json) {
                    if (err) {
                        log(balancer.title + ': no response (' + err.message + ')');
                        finishOne();
                        return;
                    }

                    try {
                        var list = balancer.parse(json, ctx);
                        aggregated = aggregated.concat(list);
                    }
                    catch (parseErr) {
                        logError(balancer.title + ': parse error', parseErr);
                    }
                    finishOne();
                });
            })(enabled[i]);
        }
    }

    function balancerPriority(title) {
        var i;
        for (i = 0; i < BALANCERS.length; i++) {
            if (BALANCERS[i].title === title) return BALANCERS[i].priority;
        }
        return 999;
    }

    function mapForChoice(items) {
        var out = [];
        var i;

        for (i = 0; i < items.length; i++) {
            var item = items[i];
            var title = item.balancer + ' | ' + (item.quality || 'unknown') + ' | ' + (item.translation || 'Озвучка по умолчанию');
            out.push({
                title: title,
                url: item.url,
                quality: item.quality,
                translation: item.translation,
                balancer: item.balancer,
                type: item.type || 'movie',
                seasons: item.seasons || []
            });
        }

        return out;
    }

    function pickWithSelect(title, items, onSelect, onCancel) {
        if (!items.length) {
            onCancel && onCancel();
            return;
        }

        if (items.length === 1 || !Lampa.Select || typeof Lampa.Select.show !== 'function') {
            onSelect(items[0]);
            return;
        }

        try {
            Lampa.Select.show({
                title: title,
                items: items,
                onSelect: function(chosen) {
                    onSelect(chosen);
                },
                onBack: function() {
                    onCancel && onCancel();
                }
            });
        }
        catch (e) {
            onSelect(items[0]);
        }
    }

    function openByChoice(card, oncomplite, onerror, variants) {
        var minQuality = getMinQuality();
        var grouped = {};
        var balancerList = [];
        var i;

        for (i = 0; i < variants.length; i++) {
            var current = variants[i];
            if (!grouped[current.balancer]) {
                grouped[current.balancer] = [];
                balancerList.push(current.balancer);
            }
            grouped[current.balancer].push(current);
        }

        var balancerChoices = [];
        for (i = 0; i < balancerList.length; i++) {
            balancerChoices.push({
                title: balancerList[i],
                value: balancerList[i]
            });
        }

        pickWithSelect('KinoSearch: Quelle', balancerChoices, function(balancerChoice) {
            var selectedBalancer = balancerChoice && (balancerChoice.value || balancerChoice.title || balancerChoice);
            var balancerVariants = grouped[selectedBalancer] || [];
            if (!balancerVariants.length) {
                onerror && onerror({ text: 'KinoSearch: Keine Quellen gefunden' });
                return;
            }

            var qualityMap = {};
            var qualityChoices = [];

            for (i = 0; i < balancerVariants.length; i++) {
                var q = balancerVariants[i].quality || 'unknown';
                if (!qualityMap[q]) {
                    qualityMap[q] = [];
                    qualityChoices.push({ title: q, value: q });
                }
                qualityMap[q].push(balancerVariants[i]);
            }

            qualityChoices.sort(function(a, b) {
                return (QUALITY_SCORE[b.value] || 0) - (QUALITY_SCORE[a.value] || 0);
            });

            var preferredQuality = pickBestQuality((function() {
                var qList = [];
                var qi;
                for (qi = 0; qi < qualityChoices.length; qi++) qList.push(qualityChoices[qi].value);
                return qList;
            })(), minQuality);

            var preselectedQuality = preferredQuality || (qualityChoices[0] ? qualityChoices[0].value : 'unknown');
            if (!qualityChoices.length) {
                var qualityFallback = chooseSourceByQuality(balancerVariants, minQuality) || balancerVariants[0];
                if (!qualityFallback) {
                    onerror && onerror({ text: 'KinoSearch: Kein Stream gefunden' });
                    return;
                }
                oncomplite({
                    movie: card,
                    url: qualityFallback.url,
                    quality: qualityFallback.quality,
                    translation: qualityFallback.translation,
                    source: SOURCE_ID
                });
                return;
            }

            pickWithSelect('KinoSearch: Qualitaet', qualityChoices, function(qualityChoice) {
                var qValue = qualityChoice && qualityChoice.value ? qualityChoice.value : preselectedQuality;
                var qualityVariants = qualityMap[qValue] || balancerVariants;

                var translationMap = {};
                var translationChoices = [];

                for (i = 0; i < qualityVariants.length; i++) {
                    var t = qualityVariants[i].translation || 'Озвучка по умолчанию';
                    if (!translationMap[t]) {
                        translationMap[t] = [];
                        translationChoices.push({ title: t, value: t });
                    }
                    translationMap[t].push(qualityVariants[i]);
                }

                if (!translationChoices.length) {
                    var translationFallback = chooseSourceByQuality(qualityVariants, minQuality) || qualityVariants[0];
                    if (!translationFallback) {
                        onerror && onerror({ text: 'KinoSearch: Kein Stream gefunden' });
                        return;
                    }
                    oncomplite({
                        movie: card,
                        url: translationFallback.url,
                        quality: translationFallback.quality,
                        translation: translationFallback.translation,
                        source: SOURCE_ID
                    });
                    return;
                }

                pickWithSelect('KinoSearch: Uebersetzung', translationChoices, function(translationChoice) {
                    var tValue = translationChoice && (translationChoice.value || translationChoice.title) ? (translationChoice.value || translationChoice.title) : (translationChoices[0] ? translationChoices[0].value : '');
                    var candidates = translationMap[tValue] || qualityVariants;
                    var chosen = chooseSourceByQuality(candidates, minQuality) || candidates[0];

                    if (!chosen) {
                        onerror && onerror({
                            text: 'KinoSearch: Kein Stream gefunden'
                        });
                        return;
                    }

                    if (chosen.type === 'tv' && chosen.seasons && chosen.seasons.length) {
                        serialCache[getCacheKey(card)] = chosen.seasons;
                        oncomplite({
                            movie: card,
                            seasons: chosen.seasons,
                            source: SOURCE_ID
                        });
                        return;
                    }

                    oncomplite({
                        movie: card,
                        url: chosen.url,
                        quality: chosen.quality,
                        translation: chosen.translation,
                        source: SOURCE_ID
                    });
                }, function() {
                    onerror && onerror({ text: 'KinoSearch: Auswahl abgebrochen' });
                });
            }, function() {
                var fallback = chooseSourceByQuality(balancerVariants, minQuality);
                if (!fallback) {
                    onerror && onerror({ text: 'KinoSearch: Kein Stream gefunden' });
                    return;
                }
                oncomplite({
                    movie: card,
                    url: fallback.url,
                    quality: fallback.quality,
                    translation: fallback.translation,
                    source: SOURCE_ID
                });
            });
        }, function() {
            onerror && onerror({ text: 'KinoSearch: Auswahl abgebrochen' });
        });
    }

    function getCacheKey(card) {
        return String((card && (card.kinopoisk_id || card.kp_id || card.id)) || 'unknown');
    }

    function mapSeasonsForLampa(seasons) {
        var out = [];
        var i;

        for (i = 0; i < seasons.length; i++) {
            var season = seasons[i];
            var episodes = [];
            var j;

            for (j = 0; j < season.episodes.length; j++) {
                var episode = season.episodes[j];
                episodes.push({
                    episode_number: episode.episode_number,
                    title: episode.title,
                    url: episode.url,
                    quality: episode.quality,
                    translation: episode.translation
                });
            }

            out.push({
                season_number: season.season_number,
                episodes: episodes
            });
        }

        return out;
    }

    function registerSettings() {
        if (!Lampa.SettingsApi || typeof Lampa.SettingsApi.addParam !== 'function') {
            log('SettingsApi недоступен');
            return;
        }

        function addParamSafe(config) {
            try {
                if (!config.param || !config.param.name) return;
                Lampa.SettingsApi.addParam(config);
            }
            catch (e) {
                logError('Settings add failed: ' + config.param.name, e);
            }
        }

        addParamSafe({
            component: 'interface',
            param: {
                name: 'kinosearch_title',
                type: 'title'
            },
            field: {
                name: 'KinoSearch'
            }
        });

        addParamSafe({
            component: 'interface',
            param: {
                name: 'kinosearch_min_quality',
                type: 'select',
                values: QUALITY_ORDER,
                default: '720p'
            },
            field: {
                name: 'KinoSearch: Mindestqualitaet'
            },
            onChange: function(value) {
                writeStorage('min_quality', value || '720p');
            }
        });

        function addTrigger(id, label) {
            addParamSafe({
                component: 'interface',
                param: {
                    name: 'kinosearch_toggle_' + id,
                    type: 'trigger',
                    default: true
                },
                field: {
                    name: 'KinoSearch: ' + label
                },
                onChange: function(value) {
                    writeStorage('enabled_' + id, !!value);
                }
            });
        }

        addTrigger('kodik', 'Kodik');
        addTrigger('collaps', 'Collaps');
        addTrigger('alloha', 'Alloha');
        addTrigger('hdvb', 'HDVB');
        addTrigger('videocdn', 'VideoCDN');
    }

    function attachDiscoverySource() {
        try {
            if (!Lampa.Api || !Lampa.Api.sources || !Lampa.Api.sources.tmdb || !Lampa.Api.sources.tmdb.discovery) {
                return;
            }

            var tmdb = Lampa.Api.sources.tmdb;
            if (tmdb.__kinosearch_patched) return;

            var originalDiscovery = tmdb.discovery;
            tmdb.discovery = function(params, oncomplite, onerror) {
                return originalDiscovery.call(this, params, function(data) {
                    try {
                        if (data && Array.isArray(data.sources)) {
                            var has = false;
                            var i;
                            for (i = 0; i < data.sources.length; i++) {
                                if (data.sources[i] === SOURCE_ID) {
                                    has = true;
                                    break;
                                }
                            }
                            if (!has) data.sources.push(SOURCE_ID);
                        }
                    }
                    catch (e) {
                        logError('discovery patch error', e);
                    }
                    oncomplite(data);
                }, onerror);
            };

            tmdb.__kinosearch_patched = true;
        }
        catch (e) {
            logError('attach discovery failed', e);
        }
    }

    function registerSource() {
        if (!Lampa.Api || !Lampa.Api.sources) {
            logError('Lampa.Api.sources недоступен');
            return;
        }

        Lampa.Api.sources[SOURCE_ID] = {
            title: 'KinoSearch',
            icon: 'film',

            full: function(params, oncomplite, onerror) {
                try {
                    var card = params && (params.card || params.movie || params);
                    var isTv = !!(card && (card.type === 'tv' || card.media_type === 'tv'));
                    var title = card && (card.title || card.name || card.original_title || card.original_name || '');

                    getKpId(card, function(kpErr, kpId) {
                        if (kpErr) {
                            logError('KP ID resolve failed', kpErr);
                            onerror && onerror({ text: 'KinoSearch: KP ID nicht gefunden' });
                            return;
                        }

                        var context = {
                            kpId: kpId,
                            title: title,
                            isTv: isTv,
                            card: card
                        };

                        collectSources(context, function(err, sources) {
                            if (err) {
                                logError('collectSources failed', err);
                                onerror && onerror({ text: 'KinoSearch: Fehler bei der Suche' });
                                return;
                            }

                            var choices = mapForChoice(sources);
                            log('найдено ' + choices.length + ' источников');

                            if (!choices.length) {
                                onerror && onerror({ text: 'KinoSearch: Keine Quellen gefunden' });
                                return;
                            }

                            openByChoice(card, oncomplite, onerror, choices);
                        });
                    });
                }
                catch (e) {
                    logError('full failed', e);
                    onerror && onerror({ text: 'KinoSearch: Unerwarteter Fehler' });
                }
            },

            seasons: function(tv, from, oncomplite) {
                try {
                    var card = tv && (tv.card || tv.movie || tv);
                    var key = getCacheKey(card);
                    var seasons = serialCache[key] || [];
                    oncomplite(mapSeasonsForLampa(seasons), from || 1);
                }
                catch (e) {
                    logError('seasons failed', e);
                    oncomplite([], from || 1);
                }
            },

            clear: function() {
                serialCache = {};
            }
        };

        attachDiscoverySource();
    }

    function addKinoSearchButton(place, card) {}

    function ensureBridgeInActiveFull() {
        try {
            if (!window.Lampa || !Lampa.Activity || !Lampa.Activity.active) return;
            var active = Lampa.Activity.active();
            if (!active || active.component !== 'full') return;
            if (!active.activity || !active.activity.render) return;

            var root = active.activity.render();
            if (!root || !root.length) return;
            if (root.find('.kinosearch-bridge-btn').length) return;

            var card = active.card || (active.activity && active.activity.card) || {};
            var jq = (window.Lampa && Lampa.$) ? Lampa.$ : window.$;
            if (!jq) return;

            var btn = jq('<div class="full-start__button selector kinosearch-bridge-btn">KinoSearch</div>');

            btn.on('hover:enter click', function() {
                if (!Lampa.Api || !Lampa.Api.sources || !Lampa.Api.sources[SOURCE_ID]) return;
                Lampa.Api.sources[SOURCE_ID].full(
                    { card: card },
                    function() {},
                    function(err) {
                        if (Lampa.Noty) Lampa.Noty.show('KinoSearch: ' + ((err && err.text) || 'Nicht gefunden'));
                    }
                );
            });

            var place = root.find('.view--torrent');
            if (!place.length) place = root.find('.full-start-new');
            if (!place.length) place = root.find('.full-start');
            if (!place.length) return;

            var lastBtn = place.find('.full-start__button').last();
            if (lastBtn.length) lastBtn.after(btn);
            else place.append(btn);

            console.log('[KinoSearch] button injected');
        }
        catch (e) {
            console.log('[KinoSearch] error:', e.message);
        }
    }

    function bindCardBridge() {
        if (cardBridgeBound) return;
        cardBridgeBound = true;

        if (window.Lampa && Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
            Lampa.Listener.follow('full', function(e) {
                try {
                    if (!e || e.type !== 'complite' || !e.data || !e.data.movie) return;
                    var act = e.object && e.object.activity;
                    if (!act || !act.render) return;
                    var root = act.render();
                    var place = root.find('.view--torrent');
                    if (!place.length) place = root.find('.full-start');
                    if (!place.length) place = root;
                    addKinoSearchButton(place, e.data.movie);
                }
                catch (e) {}
            });
        }

        if (!cardBridgeTimer) {
            cardBridgeTimer = setInterval(ensureBridgeInActiveFull, 1500);
        }
    }

    function startPlugin() {
        try {
            registerSettings();
            registerSource();
            bindCardBridge();
            log('init version ' + PLUGIN_VERSION);
        }
        catch (e) {
            logError('init failed', e);
        }
    }

    var _ksInited = false;
    function _ksStart() {
        if (_ksInited) return;
        _ksInited = true;
        startPlugin();
    }

    if (window.appready) {
        _ksStart();
    }
    else {
        if (Lampa.Listener && typeof Lampa.Listener.follow === 'function') {
            Lampa.Listener.follow('app', function(e) {
                if (e && e.type === 'ready') _ksStart();
            });
            Lampa.Listener.follow('appready', _ksStart);
        }
        setTimeout(function() {
            _ksStart();
        }, 3000);
    }
})();
