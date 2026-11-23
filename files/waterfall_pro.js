/*
 * waterfall_pro.js  -  SDR#/Airspy Pegelregler (Contrast Wasserfall, Range/Offset Spektrum)
 *
 * - Contrast wirkt ausschliesslich auf die Farbverteilung des Wasserfalls (Waterfall.colors).
 * - Range & Offset wirken ausschliesslich auf das RF-Spektrum und dessen dBFS-Skala.
 * - Waterfall.levels (Min/Max/Auto von OpenWebRX+) bleibt von Range & Offset unberuehrt.
 *
 * Wird geladen ueber static/plugins/receiver/init.js
 */
(function () {
    "use strict";
    if (window.__dnxWfPro) return;
    window.__dnxWfPro = true;

    var LOG = "[pegel]";
    var LS_KEY = "dnx.wfpro.state.v3";

    var st = { lo: -78.0, hi: -58.0, span: 20.0, range: 20.0, offset: 58.0,
               posO: 58.0, posR: 20.0, con: 50, autoFit: false, auto: false,
               kanteAn: true, loMan: -78.0, hiMan: -58.0,
               initialized: false, collapsed: false, hidden: false,
               w: null, h: null, top: null, left: null };

    function span() { return r1(st.hi - st.lo); }

    // ---------------------------------------------------------------- SDR#/Airspy Kennlinie
    // CONTRAST = steuert ALLEIN die Farbverteilung im Wasserfall (0 = Rauschen dunkel, 50 = neutral 1:1, 100 = Signale hell hervorheben).
    // RANGE    = dB-Spanne des RF-Spektrums (6..160 dB; nur Spektrum, nie Wasserfall!).
    //            hoher Wert = weites Spektrum-Fenster (lo = hi - range), niedriger Wert = engeres Fenster.
    // OFFSET   = vertikale dBFS-Verschiebung des RF-Spektrums (-40..+140 dB; nur Spektrum, nie Wasserfall!):
    //            Regler hoch (+dB)  -> Spektrum-Fenster sinkt im dBFS -> Signale im Spektrum steigen HOCH!
    //            Regler runter (-dB)-> Spektrum-Fenster steigt im dBFS -> Signale im Spektrum sinken RUNTER!
    var RANGE_MIN = 6, RANGE_MAX = 160;
    var OFFSET_MIN = -40, OFFSET_MAX = 140;
    var SPAN_MIN = RANGE_MIN, SPAN_MAX = RANGE_MAX;
    var LO_MAN_MIN = -220, LO_MAN_MAX = 40;
    var HI_MAN_MIN = -140, HI_MAN_MAX = 40;
    var STEP = 0.5;
    var _manualTouchAt = 0;

    function syncEdgesFromRangeOffset() {
        st.range = r1(clamp(isFinite(st.range) ? st.range : 20.0, RANGE_MIN, RANGE_MAX));
        st.offset = r1(clamp(isFinite(st.offset) ? st.offset : 58.0, OFFSET_MIN, OFFSET_MAX));
        var hi = r1(-st.offset);
        var lo = r1(hi - st.range);
        if (lo < LO_MAN_MIN) { lo = LO_MAN_MIN; st.range = r1(clamp(hi - lo, RANGE_MIN, RANGE_MAX)); }
        st.hi = hi;
        st.lo = lo;
        st.hiMan = hi;
        st.loMan = lo;
        st.span = r1(hi - lo);
        st.posR = st.range;
        st.posO = st.offset;
        st.kanteAn = true;
    }

    function posONachziehen() {
        if (!isFinite(st.loMan) || !isFinite(st.hiMan)) return;
        st.offset = r1(clamp(-st.hiMan, OFFSET_MIN, OFFSET_MAX));
        st.range = r1(clamp(st.hiMan - st.loMan, RANGE_MIN, RANGE_MAX));
        syncEdgesFromRangeOffset();
    }

    /* v6.50: BODEN_HALB und FARB_GRUND entfernt.
       Gruende:
       1) bodenHalbLo() verschob Boden still hinter dem Ruecken des Nutzers und
          engte Profile bis zum Weiss-Ueberlauf ein.
       2) FARB_GRUND = [46,13,96] faerbte 45% jeder Palette lila und
          ueberschrieb bei jedem applyLevels() das Kontrast-Ergebnis von applyContrast(). */
    var BODEN_HALB = false;

    function W() {
        if (typeof window.Waterfall !== "undefined" && window.Waterfall) return window.Waterfall;
        try { if (typeof Waterfall !== "undefined" && Waterfall) return Waterfall; } catch (e) { }
        return null;
    }

    // ---------------------------------------------------------------- Neumalen
    // v6.16: Der Empfaenger malt pro Bild nur EINE Zeile - ein volles Bild
    // dauert gut 20 s. Ohne Neumalen sah es deshalb aus, als taten Contrast,
    // Range und Offset nichts. Der Styler malt auf Zuruf das sichtbare Bild mit
    // den neuen Farben neu; hier wird das gebuendelt (Reglerzug = viele Werte).
    var _rpT = 0, _rpQ = null, _rpG = "";
    function neuMalen(grund) {
        _rpG = String(grund || _rpG || "");
        if (typeof window.__dnxWfNeuMalen !== "function") return false;
        var jetzt = Date.now();
        if (jetzt - _rpT > 240) {
            _rpT = jetzt;
            try { window.__dnxWfNeuMalen(_rpG); } catch (e) { }
        }
        if (_rpQ) clearTimeout(_rpQ);
        _rpQ = setTimeout(function () {
            _rpQ = null; _rpT = Date.now();
            try { window.__dnxWfNeuMalen(_rpG); } catch (e2) { }
        }, 340);
        return true;
    }
    try { window.__dnxWfProNeuMalen = neuMalen; } catch (eX) { }

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
    function r1(v) { return Math.round(v * 10) / 10; }

    function saveState() {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify({
                lo: st.lo, hi: st.hi, span: span(), range: st.range, offset: st.offset,
                posO: st.offset, posR: st.range, con: st.con,
                auto: st.auto, autoFit: st.autoFit, collapsed: st.collapsed,
                kanteAn: st.kanteAn, loMan: st.loMan, hiMan: st.hiMan,
                w: st.w, h: st.h, top: st.top, left: st.left
            }));
        } catch (e) { }
    }

    var migPegelFrisch = false;

    function grundeinstellungPegel() {
        /* v6.62: SDR#/Airspy Range + Offset fuer das Spektrum (-78.0..-58.0 dBFS),
           Contrast = 50 (1:1 neutral auf OpenWebRX-Wasserfallfarben). */
        st.range = 20.0;
        st.offset = 58.0;
        st.con = 50;
        st.auto = false; st.autoFit = false;
        syncEdgesFromRangeOffset();
    }

    function loadState() {
        try {
            if (localStorage.getItem("dnx.wfpro.mig.pegel662") !== "1") {
                grundeinstellungPegel();
                saveState();
                try { localStorage.removeItem("dnx.wfpro.profiles"); } catch (ePr) { }
                try { localStorage.setItem("dnx.wfpro.mig.pegel662", "1"); } catch (eS62) { }
                console.info(LOG, "Umstellung v6.62: Spektrum -78.0..-58.0 dBFS (Range 20.0, Offset +58.0), Contrast 50");
                return true;
            }
        } catch (eM62) { }

        try {
            var s = JSON.parse(localStorage.getItem(LS_KEY) || "null");
            if (s) {
                if (typeof s.collapsed === "boolean") st.collapsed = s.collapsed;
                if (isFinite(s.w)) st.w = parseFloat(s.w);
                if (isFinite(s.h)) st.h = parseFloat(s.h);
                if (isFinite(s.top)) st.top = parseFloat(s.top);
                if (isFinite(s.left)) st.left = parseFloat(s.left);
                st.hidden = false;
                st.auto = false;
                if (isFinite(s.con)) st.con = clamp(parseFloat(s.con), 0, 100);
                if (typeof s.autoFit === "boolean") st.autoFit = s.autoFit;

                if (isFinite(s.range) && isFinite(s.offset) && parseFloat(s.range) >= RANGE_MIN) {
                    st.range = parseFloat(s.range);
                    st.offset = parseFloat(s.offset);
                    syncEdgesFromRangeOffset();
                    return true;
                }
                if (isFinite(s.loMan) && isFinite(s.hiMan) && s.hiMan - s.loMan >= RANGE_MIN) {
                    st.hiMan = parseFloat(s.hiMan);
                    st.loMan = parseFloat(s.loMan);
                    posONachziehen();
                    return true;
                }
                if (isFinite(s.lo) && isFinite(s.hi) && s.hi - s.lo >= RANGE_MIN) {
                    st.hiMan = parseFloat(s.hi);
                    st.loMan = parseFloat(s.lo);
                    posONachziehen();
                    return true;
                }
                grundeinstellungPegel();
                saveState();
                return true;
            }
        } catch (e) { }
        grundeinstellungPegel();
        saveState();
        return true;
    }

    function syncFromWaterfall() {
        /* v6.32: Bei aktiver Automatik nichts uebernehmen. Sonst wuerde das
           feste Fenster des Profils (meist 20 dB) die Regler verbiegen und
           die Breite wieder einfrieren - das war der Grund fuer Range 60. */
        if (st.autoFit) return false;
        var w = W();
        if (!w || !w.levels) return false;
        var mn = parseFloat(w.levels.min), mx = parseFloat(w.levels.max);
        if (!isFinite(mn) || !isFinite(mx) || mx <= mn) return false;
        setWindow(mn, mx);
        return true;
    }

    // Rauschgrund aus den echten FFT-Daten (von OpenWebRX gemessen)
    // --- dnx-fix: robuster Rauschfloor -------------------------------------
    // Das absolute Minimum der FFT ist ein statistischer Ausreisser und liegt
    // bei grossen FFTs (16384 Bins) typisch 20-40 dB UNTER dem echten
    // Rauschfloor. Deshalb wird hier ueber ein Histogramm ein Perzentil
    // bestimmt (p10 = Rauschfloor, p99 = Spitzen) und gemaettet.
    var DNX_BUILD = "2026-11-23-v662";   // Versions-Stempel: erscheint in der Konsole
    var DNX_SMOOTH = 0.20;   // Glaettung der Messung (0..1, kleiner = ruhiger)

    function dnxStats(data) {
        try {
            var n = data.length;
            if (!n) return null;
            /* v6.51: Nur sichtbares Passband (innerhalb 10%..90%) messen, damit
               die -71 dB Filterflanken an den Bandraendern nicht p05/p50 verfaelschen. */
            var iStart = Math.floor(n * 0.10), iEnd = Math.ceil(n * 0.90);
            try {
                if (typeof get_visible_freq_range === "function" && typeof center_freq === "number" && typeof bandwidth === "number" && bandwidth > 0) {
                    var vf = get_visible_freq_range();
                    var f0 = center_freq - bandwidth / 2;
                    var rs = Math.max(0.10, (vf.start - f0) / bandwidth);
                    var re = Math.min(0.90, (vf.end - f0) / bandwidth);
                    if (re - rs >= 0.04) {
                        iStart = Math.max(0, Math.floor(n * rs));
                        iEnd = Math.min(n, Math.ceil(n * re));
                    }
                }
            } catch (eVr) { }
            if (iEnd - iStart < 16) { iStart = 0; iEnd = n; }
            var lo = 1e9, hi = -1e9, i, v;
            for (i = iStart; i < iEnd; i++) {
                v = data[i];
                if (!isFinite(v)) continue;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            if (!(lo < hi)) return { min: lo, max: hi, p05: lo, p10: lo, p50: lo, p99: hi, p999: hi, n: iEnd - iStart };
            var NB = 512, bins = new Float64Array(NB), step = (hi - lo) / NB, total = 0;
            for (i = iStart; i < iEnd; i++) {
                v = data[i];
                if (!isFinite(v)) continue;
                bins[Math.min(NB - 1, Math.floor((v - lo) / step))] += 1;
            }
            for (i = 0; i < NB; i++) total += bins[i];
            function q(p) {
                var target = p * total, acc = 0, k;
                for (k = 0; k < NB; k++) {
                    acc += bins[k];
                    if (acc >= target) return lo + (k + 0.5) * step;
                }
                return hi;
            }
            return { min: lo, max: hi, p05: q(0.05), p10: q(0.10), p50: q(0.5), p99: q(0.99), p999: q(0.999), n: n };
        } catch (e) { return null; }
    }

        function pushStats(s) {
        if (!s) return;
        var p = window.__dnxStats, a = DNX_SMOOTH;
        if (p && isFinite(p.p50)) {
            window.__dnxStats = {
                min: s.min, max: s.max, n: s.n,
                p05: p.p05 + a * (s.p05 - p.p05),
                p10: p.p10 + a * (s.p10 - p.p10),
                p50: p.p50 + a * (s.p50 - p.p50),
                p99: p.p99 + a * (s.p99 - p.p99),
                p999: (isFinite(p.p999) ? p.p999 : s.p999) + a * (s.p999 - (isFinite(p.p999) ? p.p999 : s.p999))
            };
        } else {
            window.__dnxStats = s;
        }
        // Erste Messung ueberhaupt: Fenster neu setzen. Beim Start ist noch
        // keine FFT-Zeile da, deshalb greift dort der Fallback (Minimum) und
        // wuerde als Fenster stehen bleiben.
        if (!window.__dnxHadStats) {
            window.__dnxHadStats = true;
            try {
                if (typeof applyLevels === "function") {
                    applyLevels();
                    console.info(LOG, "Fenster nach erster Messung neu gesetzt (Median " +
                        r1(window.__dnxStats.p50) + " dB statt Startwert)");
                }
            } catch (e) { console.error(LOG, "applyLevels", e); }
        }

        if (!window.__dnxLogged) window.__dnxLogged = 0;
        if (window.__dnxLogged < 3) {
            window.__dnxLogged++;
            var d = window.__dnxStats;
            console.info(LOG, "Messung #" + window.__dnxLogged + ": min=" + d.min.toFixed(1) +
                "  p50=" + d.p50.toFixed(1) + "  p99=" + d.p99.toFixed(1) + " dB  (" + d.n + " Bins)");
        }
        /* v6.30: Fenster laufend mitziehen - auch ohne Reglerbewegung. */
        try { fensterNachziehen(false); } catch (eNz2) { }
    }

    function hookMeasureRange(w) {
        if (!w || w.__dnxMeasureHooked || typeof w.measureRange !== "function") return;
        var orig = w.measureRange;
        w.measureRange = function (data) {
            try { pushStats(dnxStats(data)); } catch (e) { }
            return orig.apply(this, arguments);
        };
        w.__dnxMeasureHooked = true;
        console.info(LOG, "Messung: measureRange angezapft");
    }

    // WICHTIG: measureRange steigt aus, wenn gerade nicht gemessen wird
    // (!measure_minmax_now && !measure_minmax_continuous). drawLine laeuft
    // dagegen fuer JEDE Zeile - deshalb hier die eigentliche Messung.
    function hookDrawLine(w) {
        if (!w || w.__dnxDrawHooked || typeof w.drawLine !== "function") return;
        var orig = w.drawLine, z = 0;
        w.drawLine = function (out, data, offset) {
            try {
                if (data && data.length > 64 && (z++ % 3) === 0) pushStats(dnxStats(data));
            } catch (e) { }
            return orig.apply(this, arguments);
        };
        w.__dnxDrawHooked = true;
        console.info(LOG, "Messung: drawLine angezapft (jede 3. Zeile)");
    }

    // --- ende dnx-fix -------------------------------------------------------

        function noiseFloor() {
        var s = window.__dnxStats;
        if (s && isFinite(s.p50)) return s.p50;      // Rauschfloor = Median
        // Kein Perzentil vorhanden => Fehlerzustand (z.B. alte Datei im
        // Browser-Cache). Laut melden statt still das alte Minimum zu nehmen.
        var now = Date.now();
        if (!window.__dnxStart) window.__dnxStart = now;
        // In den ersten Sekunden ist noch keine FFT-Zeile da - das ist normal,
        // deshalb erst nach 8 s warnen.
        if ((!window.__dnxWarnAt || now - window.__dnxWarnAt > 60000) && (now - window.__dnxStart) > 8000) {
            window.__dnxWarnAt = now;
            console.warn(LOG, "ACHTUNG: keine Perzentil-Messung - Fallback auf altes Minimum! " +
                "Bitte mit Strg+Umschalt+R hart neu laden.");
        }
        var d = window.__dnxData;
        if (d && isFinite(d.min)) return d.min;
        return null;
    }


    // Fenster aus Reglerstellungen berechnen
    var SPAN_AUTO_MIN = 18, SPAN_AUTO_MAX = 30;     // Grenzen der Automatik
    var DYN_MIN = 8, DYN_MAX = 45;                  // gemessene Dynamik p999-p50

    /* v6.32: Fensterbreite aus der Messung statt aus dem Profil.
       Fast jedes Profil traegt ein festes waterfall_levels-Fenster von nur
       8-20 dB (734 von 949 sind 20 dB). Echte Baender haben 30-60 dB Dynamik,
       deshalb klippte alles oberhalb in die letzte Palettenfarbe (orange).
       Jetzt: Boden = Median, Decke = p999, Breite so, dass bei der
       eingestellten Range-Lage beidespasst. Der Offset-Regler bleibt als
       Feinjustierung (Faktor, Mittelstellung 28 = neutral). */
    /* ---- Gedaempfte Messung [DNX-RUHE] ---------------------------------
       Der rohe Spitzenwert p999 springt mit jedem starken Signal. Wird die
       Fensterbreite direkt daraus berechnet, wandert die obere Fensterkante
       um bis zu 36 dB und das Bild kippt zwischen blau und gruen.
       Deshalb: Boden und Dynamik tiefpassgefiltert, Breite schrittbegrenzt. */
    var _glBoden = null, _glDyn = null, _glSpan = null;
    var GL_BODEN_TAU = 0.05;      /* ~20 s Zeitkonstante bei 1 Anwendung/s  */
    var GL_DYN_TAU = 0.01;        /* ~33 s                                   */
    var GL_SPAN_SCHRITT = 0.5;    /* hoechstens 1,5 dB je Anwendung          */

    function glaetten(alt, neu, tau) {
        if (!isFinite(neu)) { return alt; }
        if (alt === null || !isFinite(alt)) { return neu; }
        return alt + (neu - alt) * tau;
    }
    function schrittBegrenzen(alt, neu, schritt) {
        if (alt === null || !isFinite(alt)) { return neu; }
        if (neu > alt + schritt) { return alt + schritt; }
        if (neu < alt - schritt) { return alt - schritt; }
        return neu;
    }

    function autoSpan(base) {
        var s = window.__dnxStats;
        if (!s || !isFinite(s.p999) || !isFinite(base)) return null;
        var dyn = clamp(r1(s.p999 - base), DYN_MIN, DYN_MAX);
        dyn = r1(glaetten(_glDyn, dyn, GL_DYN_TAU));
        _glDyn = dyn;
        var ante = 1 - clamp(st.posR, 0, 100) / 100;   // Anteil oberhalb des Bodens
        if (ante < 0.15) ante = 0.15;
        var sp = clamp(dyn / ante + 4, SPAN_AUTO_MIN, SPAN_AUTO_MAX);
        sp = sp * Math.pow(2, (POS_O_MID - st.posO) / 12);
        return clamp(r1(sp), SPAN_MIN, SPAN_MAX);
    }

    function computeWindow() {
        if (st.autoFit) {
            var s = window.__dnxStats;
            if (s && isFinite(s.p50)) {
                var base = r1(glaetten(_glBoden, s.p50, GL_BODEN_TAU));
                _glBoden = base;
                var pk = isFinite(s.p999) ? r1(glaetten(_glDyn, s.p999, 0.04)) : (base + 8);
                _glDyn = pk;
                var autoLo = clamp(r1(base - 3.8), LO_MAN_MIN, LO_MAN_MAX);
                var autoHi = clamp(r1(Math.max(base + 11.2, pk + 4.5)), autoLo + 14.0, Math.min(HI_MAN_MAX, autoLo + 24.0));
                st.lo = autoLo;
                st.hi = autoHi;
                st.loMan = autoLo;
                st.hiMan = autoHi;
                st.span = r1(st.hi - st.lo);
                st.range = r1(clamp(st.span, RANGE_MIN, RANGE_MAX));
                st.offset = r1(clamp(-st.hi, OFFSET_MIN, OFFSET_MAX));
                st.posR = st.range;
                st.posO = st.offset;
                return { lo: st.lo, hi: st.hi, base: base };
            }
        }
        syncEdgesFromRangeOffset();
        return { lo: st.lo, hi: st.hi, base: st.lo };
    }

    // Umgekehrt: aus fertigen Pegeln direkt Range & Offset setzen
    function setWindow(lo, hi) {
        lo = parseFloat(lo); hi = parseFloat(hi);
        if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return false;
        hi = r1(clamp(hi, HI_MAN_MIN, HI_MAN_MAX));
        lo = r1(clamp(lo, LO_MAN_MIN, hi - RANGE_MIN));
        st.range = r1(clamp(hi - lo, RANGE_MIN, RANGE_MAX));
        st.offset = r1(clamp(-hi, OFFSET_MIN, OFFSET_MAX));
        syncEdgesFromRangeOffset();
        return true;
    }

    function rangeAufKanten() { syncEdgesFromRangeOffset(); }
    function offsetAufKanten() { syncEdgesFromRangeOffset(); }

    /* v6.30: Fenster folgt dem Rauschfloor.
       Vorher wurde applyLevels() nur einmal nach der ersten Messung und beim
       Bewegen der Regler gerufen. Beim Bandwechsel blieb das Fenster deshalb
       auf dem Pegel des alten Bandes stehen - auf 40 m zu dunkel, auf 2 m und
       70 cm clippingweiss. Jetzt wird es laufend (hoechstens 1x pro Sekunde)
       aus dem gemessenen Median und den eigenen Reglerstellungen neu gesetzt.
       Fuer ein Profil gemerkte Pegel (Haken-Knopf) bleiben unangetastet. */
    var _fzLetzt = 0, _fzFloor = null, _fzDyn = null;
    function fensterNachziehen(force) {
        if (!st.autoFit) return;
        try {
            var key = null;
            try { key = activeProfileId(); } catch (eK) { }
            if (key && profileStore()[key]) return;
            var s2 = window.__dnxStats;
            if (!s2 || !isFinite(s2.p50)) return;
            var jetzt = Date.now();
            if (!force && jetzt - _fzLetzt < 1000) return;
            _fzLetzt = jetzt;
            applyLevels();
        } catch (eFz) { }
    }

    // ---------------------------------------------------------------- Contrast
    // Aendert NUR die Wasserfall-Farbverteilung (nie Range/Offset oder dBFS-Grenzen):
    // 0 = Rauschen stark unterdruecken (v^4.83), 50 = neutral (1:1 Basisfarben),
    // 100 = SDR#-Kontrastaufhellung (v^0.52 * 1.72 -> schwache Signale ab ~5-12% klar sichtbar).
    function applyContrast() {
        var w = W();
        if (!w || !Array.isArray(w.colors) || !w.colors.length) return;
        if (!w.colors._dnxContrasted || !Array.isArray(w._dnxBase) || w._dnxBase.length !== w.colors.length) {
            w._dnxBase = w.colors.slice();
        }
        var base = w._dnxBase;
        var n = base.length;
        var con = clamp(isFinite(st.con) ? st.con : 50, 0, 100);
        var out = new Array(n);
        if (Math.abs(con - 50) < 1e-6) {
            for (var i0 = 0; i0 < n; i0++) out[i0] = base[i0];
        } else if (con < 50) {
            var gLo = Math.pow(2, (50 - con) / 22);
            for (var i1 = 0; i1 < n; i1++) {
                var v1 = i1 / (n - 1);
                var t1 = Math.pow(v1, gLo);
                out[i1] = base[Math.round(t1 * (n - 1))];
            }
        } else {
            var p = (con - 50) / 50;
            var gamma = 1 - 0.48 * p;
            var gain = 1 + 0.72 * p;
            for (var i2 = 0; i2 < n; i2++) {
                var v2 = i2 / (n - 1);
                var t2 = Math.min(1, Math.pow(v2, gamma) * gain);
                out[i2] = base[Math.round(t2 * (n - 1))];
            }
        }
        out._dnxContrasted = true;
        w.colors = out;
        try { if (typeof Waterfall !== "undefined" && Waterfall) Waterfall.colors = out; } catch (e) { }
        neuMalen("contrast");
    }

    // Farbwechsel (Theme) soll den Contrast nicht verlieren
    function hookTheme() {
        var w = W();
        if (!w || w._dnxThemeHooked || typeof w.setTheme !== "function") return;
        w._dnxThemeHooked = true;
        var orig = w.setTheme;
        w.setTheme = function (t) {
            orig.call(this, t);
            this._dnxBase = Array.isArray(this.colors) ? this.colors.slice() : null;
            applyContrast();
        };
    }

    /* v6.62: Range & Offset wirken AUSSCHLIESSLICH auf das RF-Spektrum und die
       dBFS-Skala (#dnx-spek-raster). Waterfall.levels & Wasserfallfarben werden
       hier niemals veraendert! */
    function applyLevels() {
        computeWindow();
        updateReadout();
        try {
            if (typeof window.__dnxSpekNeuMalen === "function") {
                window.__dnxSpekNeuMalen();
            } else if (window.spectrum && typeof window.spectrum.draw === "function") {
                window.spectrum.min = r1(st.lo);
                window.spectrum.max = r1(st.hi);
                window.spectrum.draw();
            }
        } catch (eSp) { }
        try { if (typeof window.__dnxRasterJetzt === "function") window.__dnxRasterJetzt(true); } catch (eRj) { }
    }

    // ------------------------------------------------------------------ UI
    var elPanel, elRange, elOffset, elCon, elOutRange, elOutOffset, elOutCon, elOutLevels;

    function fmtDb(v) {
        var x = r1(v);
        return (Math.abs(x - Math.round(x)) < 0.05) ? String(Math.round(x)) : x.toFixed(1);
    }

    var _syncingStyler = false;
    function updateReadout() {
        if (!elPanel) return;
        var lo = r1(st.lo);
        var hi = r1(st.hi);
        var rg = r1(st.range);
        var off = r1(st.offset);

        if (elOutCon) {
            elOutCon.textContent = Math.round(st.con).toString();
            elOutCon.title = "Contrast " + Math.round(st.con) + " \u2013 nur Wasserfall-Farbverteilung (0 = dunkel, 50 = neutral, 100 = Signale hervorheben)";
        }
        if (elOutRange) {
            elOutRange.textContent = fmtDb(rg) + " dB";
            elOutRange.title = "Range " + fmtDb(rg) + " dB (nur Spektrum: dB-Spanne auf der linken dBFS-Achse)";
        }
        if (elOutOffset) {
            elOutOffset.textContent = (off > 0 ? "+" : "") + fmtDb(off) + " dB";
            elOutOffset.title = "Offset " + (off > 0 ? "+" : "") + fmtDb(off) + " dB (nur Spektrum: Oberkante " + fmtDb(hi) + " dBFS)";
        }
        try {
            if (elRange) elRange.value = String(rg);
            if (elOffset) elOffset.value = String(off);
            if (elCon) elCon.value = String(Math.round(st.con));
        } catch (eUR) { }
        if (elOutLevels) {
            elOutLevels.textContent = fmtDb(lo) + "\u2026" + fmtDb(hi);
            var dbg = window.__dnxStats;
            elOutLevels.title = "Spektrum dBFS-Fenster " + fmtDb(lo) + " bis " + fmtDb(hi) + " dBFS (Range " + fmtDb(rg) + " dB, Offset " + (off > 0 ? "+" : "") + fmtDb(off) + " dB)" +
                (dbg ? ("  |  Rauschfloor p50=" + r1(dbg.p50) + " dB, p99=" + r1(dbg.p99) + " dB") : "");
        }
        if (!_syncingStyler && typeof window.__dnxPegelSync === "function") {
            try { window.__dnxPegelSync(); } catch (eSy) { }
        }
        var jetzt = Date.now();
        if (!window.__dnxSumAt || jetzt - window.__dnxSumAt > 15000) {
            window.__dnxSumAt = jetzt;
            var dbg2 = window.__dnxStats;
            console.info(LOG, "Zustand: Contrast " + Math.round(st.con) + " | Range " + rg + " dB | Offset " + off +
                " dB (" + lo + ".." + hi + " dBFS)" + (st.autoFit ? " | Auto" : "") +
                " | Floor: " + (dbg2 ? "p50=" + r1(dbg2.p50) : "noch keine FFT"));
        }
    }
    function _unused() {
    }


    // CSS selbst sicherstellen: falls der Plugin-Loader das Stylesheet nicht
    // mitgeladen hat, wird es hier eingefuegt. Damit ist das Panel unabhaengig
    // von der Ladereihenfolge immer korrekt formatiert.
    var STYLE_ID = "dnx-wfpro-style";
    var INLINE_CSS = ".dnx-wfpro{--rail-h:88px;position:fixed;right:0;top:104px;z-index:1400;width:74px;min-width:60px;min-height:210px;padding:5px 0 6px 0;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:0;background:linear-gradient(to bottom, rgba(10, 13, 17, 0.86), rgba(6, 8, 11, 0.92));border-left:1px solid rgba(255, 255, 255, 0.09);box-shadow:-2px 0 8px rgba(0, 0, 0, 0.35);border-radius:4px 0 0 4px;font-family:\"Open Sans\", Arial, sans-serif;font-size:11px;line-height:1.18;color:#ffffff;user-select:none;-webkit-user-select:none;} .dnx-wfpro-head{display:flex;align-items:center;justify-content:center;gap:1px;width:100%;padding-bottom:4px;margin-bottom:2px;border-bottom:1px solid rgba(255, 255, 255, 0.06);} .dnx-wfpro-title{font-size:9.5px;letter-spacing:0.08em;color:#ffffff;text-transform:uppercase;cursor:move;} .dnx-wfpro-toggle{background:none;border:none;padding:0 0 0 1px;color:#ffffff;font-size:10px;line-height:1;cursor:pointer;} .dnx-wfpro-toggle:hover{color:#ffffff;} .dnx-wfpro-node{display:flex;flex-direction:column;align-items:center;width:100%;padding:2px 0 0 0;} .dnx-wfpro-cap{font-size:11px;letter-spacing:0.01em;color:#ffffff;padding-bottom:3px;white-space:nowrap;} .dnx-wfpro-num{font-family:\"Consolas\", \"DejaVu Sans Mono\", monospace;font-size:11px;color:#ffffff;padding-top:3px;white-space:nowrap;} .dnx-wfpro-rail{position:relative;width:100%;height:var(--rail-h);display:flex;align-items:center;justify-content:center;} .dnx-wfpro-rail::before{content:\"\";position:absolute;left:50%;top:4px;bottom:4px;width:2px;margin-left:-1px;border-radius:1px;background:#3c444c;} .dnx-wfpro-slider{-webkit-appearance:none;appearance:none;position:absolute;left:50%;top:50%;width:var(--rail-h);height:18px;margin:0;padding:0;transform:translate(-50%, -50%) rotate(-90deg);touch-action:none;background:transparent;cursor:ns-resize;outline:none;} .dnx-wfpro-slider::-webkit-slider-runnable-track{height:2px;background:#3c444c;border-radius:1px;} .dnx-wfpro-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:11px;height:11px;margin-top:-4.5px;border:none;border-radius:50%;background:#22b8f0;box-shadow:0 0 5px rgba(34, 184, 240, 0.85), 0 0 1px rgba(255, 255, 255, 0.9);cursor:ns-resize;} .dnx-wfpro-slider:hover::-webkit-slider-thumb{background:#4fcaf7;box-shadow:0 0 9px rgba(79, 202, 247, 0.95);} .dnx-wfpro-slider::-moz-range-track{height:2px;background:#3c444c;border-radius:1px;} .dnx-wfpro-slider::-moz-range-thumb{width:11px;height:11px;border:none;border-radius:50%;background:#22b8f0;box-shadow:0 0 5px rgba(34, 184, 240, 0.85);cursor:ns-resize;} .dnx-wfpro-sep{width:60%;height:1px;margin:5px 0 0 0;background:rgba(255, 255, 255, 0.06);} .dnx-wfpro-lvls{font-family:\"Consolas\", \"DejaVu Sans Mono\", monospace;font-size:9px;letter-spacing:-0.02em;color:#ffffff;text-align:center;padding-top:5px;white-space:nowrap;} .dnx-wfpro-btns{display:flex;flex-wrap:wrap;gap:2px;padding-top:5px;width:100%;justify-content:center;} #dnx-wfpro-auto{width:34px;font-variant:small-caps;} #dnx-wfpro-spek{width:68px;height:17px;margin-top:2px;font-size:9px;letter-spacing:-0.02em;} .dnx-wfpro-btns button{width:16px;height:18px;min-width:16px;padding:0;font-size:10px;line-height:1;color:#ffffff;background:rgba(255, 255, 255, 0.08);border:1px solid rgba(255, 255, 255, 0.1);border-radius:2px;cursor:pointer;} .dnx-wfpro-btns button:hover{color:#ffffff;background:rgba(34, 184, 240, 0.25);border-color:rgba(34, 184, 240, 0.55);} .dnx-wfpro-collapsed{width:26px;padding-bottom:4px;} .dnx-wfpro-collapsed .dnx-wfpro-node, .dnx-wfpro-collapsed .dnx-wfpro-sep, .dnx-wfpro-collapsed .dnx-wfpro-lvls, .dnx-wfpro-collapsed .dnx-wfpro-btns{display:none;} .dnx-wfpro-collapsed .dnx-wfpro-title{writing-mode:vertical-rl;padding-top:3px;font-size:9px;} .dnx-wfpro-collapsed .dnx-wfpro-head{flex-direction:column;border-bottom:none;padding-bottom:0;} @media (max-width:900px){.dnx-wfpro{width:68px;}} .dnx-wfpro-rs{position:absolute;z-index:5;background:transparent;touch-action:none;} .dnx-wfpro-rs-n{left:8px;right:8px;top:-3px;height:9px;cursor:ns-resize;} .dnx-wfpro-rs-s{left:8px;right:8px;bottom:-3px;height:9px;cursor:ns-resize;} .dnx-wfpro-rs-w{top:8px;bottom:8px;left:-3px;width:9px;cursor:ew-resize;} .dnx-wfpro-rs-e{top:8px;bottom:8px;right:-3px;width:9px;cursor:ew-resize;} .dnx-wfpro-rs-nw{top:-3px;left:-3px;width:13px;height:13px;cursor:nwse-resize;} .dnx-wfpro-rs-ne{top:-3px;right:-3px;width:13px;height:13px;cursor:nesw-resize;} .dnx-wfpro-rs-sw{bottom:-3px;left:-3px;width:13px;height:13px;cursor:nesw-resize;} .dnx-wfpro-rs-se{bottom:-3px;right:-3px;width:13px;height:13px;cursor:nwse-resize;} .dnx-wfpro-rs-se::after{content:\"\";position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-right:2px solid rgba(255, 255, 255, 0.22);border-bottom:2px solid rgba(255, 255, 255, 0.22);} .dnx-wfpro-rs-se:hover::after{border-color:rgba(34, 184, 240, 0.9);}";

    function ensureStyle() {
        try {
            if (document.getElementById(STYLE_ID)) return;
            var links = document.querySelectorAll('link[rel="stylesheet"]');
            for (var i = 0; i < links.length; i++) {
                var h = links[i].getAttribute("href") || "";
                if (h.indexOf("waterfall_pro.css") !== -1) return; // CSS ist schon da
            }
            var stl = document.createElement("style");
            stl.id = STYLE_ID;
            stl.type = "text/css";
            stl.appendChild(document.createTextNode(INLINE_CSS));
            (document.head || document.body).appendChild(stl);
            console.log(LOG, "CSS inline eingefuegt");
        } catch (e) {
            console.error(LOG, "ensureStyle", e);
        }
    }


    // Panel laesst sich am Titel verschieben (z.B. wenn es etwas verdeckt)
    function makeDraggable(p) {
        var title = p.querySelector(".dnx-wfpro-title");
        if (!title) return;
        title.style.cursor = "move";
        title.title = "Ziehen zum Verschieben, Doppelklick zum Zuruecksetzen";
        var sx, sy, ot, ol, moving = false;

        function down(ev) {
            var e = ev.touches ? ev.touches[0] : ev;
            var r = p.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; ot = r.top; ol = r.left;
            moving = true;
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
            document.addEventListener("touchmove", move, { passive: false });
            document.addEventListener("touchend", up);
            ev.preventDefault();
        }
        function move(ev) {
            if (!moving) return;
            var e = ev.touches ? ev.touches[0] : ev;
            var nt = Math.max(0, Math.min(window.innerHeight - 40, ot + (e.clientY - sy)));
            var nl = Math.max(0, Math.min(window.innerWidth - 40, ol + (e.clientX - sx)));
            p.style.top = nt + "px";
            p.style.left = nl + "px";
            p.style.right = "auto";
            if (ev.cancelable) ev.preventDefault();
        }
        function up() {
            moving = false;
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
            document.removeEventListener("touchmove", move);
            document.removeEventListener("touchend", up);
            try {
                localStorage.setItem("dnx.wfpro.pos", JSON.stringify({
                    top: p.style.top, left: p.style.left
                }));
            } catch (e) {}
        }
        title.addEventListener("mousedown", down);
        title.addEventListener("touchstart", down, { passive: false });
        title.addEventListener("dblclick", function () {
            p.style.top = "";
            p.style.left = "";
            p.style.right = "";
            try { localStorage.removeItem("dnx.wfpro.pos"); } catch (e) {}
        });
    }

    function restorePos(p) {
        try {
            var v = JSON.parse(localStorage.getItem("dnx.wfpro.pos") || "null");
            if (v && v.top && v.left) {
                p.style.top = v.top;
                p.style.left = v.left;
                p.style.right = "auto";
            }
        } catch (e) {}
    }

    function buildPanel() {
        ensureStyle();
        if (document.getElementById("dnx-wfpro-panel")) {
            elPanel = document.getElementById("dnx-wfpro-panel");
            return;
        }

        var p = document.createElement("div");
        p.id = "dnx-wfpro-panel";
        p.className = "dnx-wfpro" + (st.collapsed ? " dnx-wfpro-collapsed" : "");

        p.innerHTML =
            '<div class="dnx-wfpro-head">' +
            '  <span class="dnx-wfpro-title">Pegel</span>' +
            '  <button type="button" class="dnx-wfpro-toggle" id="dnx-wfpro-toggle" title="Ein-/ausklappen">' +
                 (st.collapsed ? "&#9666;" : "&#9662;") + '</button>' +
            '</div>' +
            '<div class="dnx-wfpro-node">' +
            '  <div class="dnx-wfpro-cap" title="Nur f\u00fcr den Wasserfall: Farbverteilung (0 = dunkel, 50 = neutral 1:1, 100 = Signale hell)">Contrast</div>' +
            '  <div class="dnx-wfpro-rail">' +
            '    <input type="range" id="dnx-wfpro-contrast" class="dnx-wfpro-slider" min="0" max="100" step="1">' +
            '  </div>' +
            '  <div class="dnx-wfpro-num" id="dnx-wfpro-contrast-val">&#8211;</div>' +
            '</div>' +
            '<div class="dnx-wfpro-sep"></div>' +
            '<div class="dnx-wfpro-node">' +
            '  <div class="dnx-wfpro-cap" title="Nur f\u00fcr das Spektrum: dB-Spanne auf der linken dBFS-Achse">Range</div>' +
            '  <div class="dnx-wfpro-rail">' +
            '    <input type="range" id="dnx-wfpro-range" class="dnx-wfpro-slider" min="' + RANGE_MIN + '" max="' + RANGE_MAX + '" step="' + STEP + '">' +
            '  </div>' +
            '  <div class="dnx-wfpro-num" id="dnx-wfpro-range-val">&#8211;</div>' +
            '</div>' +
            '<div class="dnx-wfpro-sep"></div>' +
            '<div class="dnx-wfpro-node">' +
            '  <div class="dnx-wfpro-cap" title="Nur f\u00fcr das Spektrum: Signale vertikal hoch- / runterheben">Offset</div>' +
            '  <div class="dnx-wfpro-rail">' +
            '    <input type="range" id="dnx-wfpro-offset" class="dnx-wfpro-slider" min="' + OFFSET_MIN + '" max="' + OFFSET_MAX + '" step="' + STEP + '">' +
            '  </div>' +
            '  <div class="dnx-wfpro-num" id="dnx-wfpro-offset-val">&#8211;</div>' +
            '</div>' +
            '<div class="dnx-wfpro-lvls" id="dnx-wfpro-levels">&#8211;</div>' +
            '<div class="dnx-wfpro-btns">' +
            '  <button type="button" id="dnx-wfpro-auto" title="Automatik (nur Spektrum): Rauschgrund und Spitzen im Spektrum einpegeln">Auto</button>' +
            '  <button type="button" id="dnx-wfpro-reset" title="Spektrum-Regler (Range/Offset) &amp; Contrast auf Standard zuruecksetzen">&#8635;</button>' +
            '  <button type="button" id="dnx-wfpro-pin" title="Spektrum-Pegel &amp; Contrast fuer das aktuelle Profil merken">&#10003;</button>' +
            '  <button type="button" id="dnx-wfpro-spek" title="Spektrum-Skala: Pegel (Range &amp; Offset steuern Spektrum) oder Auto (Rauschboden fest)">Spek: Pegel</button>' +
            '</div>';

        document.body.appendChild(p);
        applyGeometry(p);
        restorePos(p);
        makeDraggable(p);
        makeResizable(p);

        elPanel = p;
        elCon = p.querySelector("#dnx-wfpro-contrast");
        elOutCon = p.querySelector("#dnx-wfpro-contrast-val");
        elRange = p.querySelector("#dnx-wfpro-range");
        elOffset = p.querySelector("#dnx-wfpro-offset");
        elOutRange = p.querySelector("#dnx-wfpro-range-val");
        elOutOffset = p.querySelector("#dnx-wfpro-offset-val");
        elOutLevels = p.querySelector("#dnx-wfpro-levels");

        if (!elCon || !elRange || !elOffset) {
            console.error(LOG, "Regler konnten nicht erzeugt werden");
            return;
        }

        function ensureSpekPegelAktiv() {
            if (spekSkalaLesen() === "auto" && typeof window.__dnxSpecSet === "function") {
                try { window.__dnxSpecSet({ skala: "pegel" }); } catch (eSk) { }
                paintSpekButton();
            }
        }
        function kantenStart() {
            _manualTouchAt = Date.now();
            if (st.autoFit) {
                st.autoFit = false;
                paintAutoButton();
            }
            st.kanteAn = true;
            ensureSpekPegelAktiv();
        }
        function setContrastManuell(rawVal) {
            if (!isFinite(rawVal)) return st.con;
            st.con = clamp(Math.round(rawVal), 0, 100);
            applyContrast(); saveState(); updateReadout();
            return st.con;
        }
        function setRangeManuell(rawVal) {
            if (!isFinite(rawVal)) return st.range;
            kantenStart();
            st.range = r1(clamp(rawVal, RANGE_MIN, RANGE_MAX));
            syncEdgesFromRangeOffset();
            applyLevels(); saveState();
            return st.range;
        }
        function setOffsetManuell(rawVal) {
            if (!isFinite(rawVal)) return st.offset;
            kantenStart();
            st.offset = r1(clamp(rawVal, OFFSET_MIN, OFFSET_MAX));
            syncEdgesFromRangeOffset();
            applyLevels(); saveState();
            return st.offset;
        }
        elCon.addEventListener("input", function () {
            this.value = String(setContrastManuell(parseFloat(this.value)));
        });
        elRange.addEventListener("input", function () {
            this.value = String(setRangeManuell(parseFloat(this.value)));
        });
        elOffset.addEventListener("input", function () {
            this.value = String(setOffsetManuell(parseFloat(this.value)));
        });

        /* Relatives, ruhiges Ziehen auf der gedrehten Schiene (1 dB/px, Shift 0,25 dB/px) */
        function installVerticalDrag(el, mode) {
            if (!el) return;
            var drag = null;
            function applyVal(v) {
                if (mode === "con") return setContrastManuell(v);
                if (mode === "range") return setRangeManuell(v);
                return setOffsetManuell(v);
            }
            function onDown(ev) {
                if (ev.button !== undefined && ev.button !== 0) return;
                ev.preventDefault();
                try { el.focus({ preventScroll: true }); } catch (eF) { }
                var r = el.getBoundingClientRect();
                var min = parseFloat(el.min), max = parseFloat(el.max);
                var step = parseFloat(el.step) || 1;
                var cur = parseFloat(el.value);
                if (!isFinite(cur)) cur = (min + max) / 2;
                var usable = Math.max(12, r.height - 11);
                var frac = (max > min) ? (cur - min) / (max - min) : 0.5;
                var thumbY = r.bottom - 5.5 - frac * usable;
                drag = {
                    id: ev.pointerId,
                    startY: ev.clientY,
                    startVal: cur,
                    min: min,
                    max: max,
                    step: step,
                    thumbY: thumbY,
                    moved: 0
                };
                if (el.setPointerCapture && ev.pointerId !== undefined) {
                    try { el.setPointerCapture(ev.pointerId); } catch (eC) { }
                }
                window.addEventListener("pointermove", onMove, true);
                window.addEventListener("pointerup", onUp, true);
                window.addEventListener("pointercancel", onUp, true);
            }
            function onMove(ev) {
                if (!drag) return;
                if (drag.id !== undefined && ev.pointerId !== undefined && ev.pointerId !== drag.id) return;
                var dy = drag.startY - ev.clientY;
                if (Math.abs(dy) > drag.moved) drag.moved = Math.abs(dy);
                var sens = ev.shiftKey ? 0.25 : 1.0;
                var next = drag.startVal + dy * sens;
                next = Math.round(next / drag.step) * drag.step;
                next = r1(clamp(next, drag.min, drag.max));
                el.value = String(applyVal(next));
            }
            function onUp(ev) {
                if (!drag) return;
                if (drag.id !== undefined && ev.pointerId !== undefined && ev.pointerId !== drag.id) return;
                var d = drag;
                drag = null;
                window.removeEventListener("pointermove", onMove, true);
                window.removeEventListener("pointerup", onUp, true);
                window.removeEventListener("pointercancel", onUp, true);
                if (el.releasePointerCapture && ev.pointerId !== undefined) {
                    try { el.releasePointerCapture(ev.pointerId); } catch (eR) { }
                }
                if (d.moved < 3 && Math.abs(d.startY - d.thumbY) > 10) {
                    var dir = (d.startY < d.thumbY) ? 1 : -1;
                    var nudge = (mode === "con") ? (ev.shiftKey ? 1 : 4) : (ev.shiftKey ? 0.5 : 2);
                    el.value = String(applyVal(d.startVal + dir * nudge));
                }
            }
            el.addEventListener("mousedown", function (ev) {
                if (ev.button === 0) ev.preventDefault();
            });
            el.addEventListener("pointerdown", onDown);
        }
        installVerticalDrag(elCon, "con");
        installVerticalDrag(elRange, "range");
        installVerticalDrag(elOffset, "offset");

        if (elCon.parentNode) {
            elCon.parentNode.addEventListener("wheel", function (ev) {
                ev.preventDefault();
                elCon.value = String(setContrastManuell(st.con + ((ev.deltaY < 0) ? 4 : -4)));
            }, { passive: false });
        }

        if (elRange.parentNode) {
            elRange.parentNode.addEventListener("wheel", function (ev) {
                ev.preventDefault();
                try { ev.stopPropagation(); } catch (eS) { }
                var schritt = ev.shiftKey ? 0.5 : 2;
                var dir = (ev.deltaY < 0) ? 1 : -1; // Rad hoch = breiteres dB-Fenster
                elRange.value = String(setRangeManuell(st.range + dir * schritt));
            }, { passive: false });
        }

        if (elOffset.parentNode) {
            elOffset.parentNode.addEventListener("wheel", function (ev) {
                ev.preventDefault();
                try { ev.stopPropagation(); } catch (eS) { }
                var schritt = ev.shiftKey ? 0.5 : 2;
                var dir = (ev.deltaY < 0) ? 1 : -1; // Rad hoch = Signale im Spektrum hochheben
                elOffset.value = String(setOffsetManuell(st.offset + dir * schritt));
            }, { passive: false });
        }

        var bAuto = p.querySelector("#dnx-wfpro-auto");
        if (bAuto) bAuto.addEventListener("click", function () {
            st.autoFit = !st.autoFit;
            if (st.autoFit) {
                _glBoden = null; _glDyn = null;
                if (spekSkalaLesen() === "auto" && typeof window.__dnxSpecSet === "function") {
                    try { window.__dnxSpecSet({ skala: "pegel" }); } catch (eS) { }
                }
                computeWindow();
            } else {
                st.kanteAn = true;
                st.loMan = r1(st.lo); st.hiMan = r1(st.hi);
            }
            applyLevels();
            paintAutoButton();
            pushToUi();
            saveState();
        });
        paintAutoButton();

        var bReset = p.querySelector("#dnx-wfpro-reset");
        if (bReset) bReset.addEventListener("click", function () {
            st.autoFit = false;
            grundeinstellungPegel();
            applyContrast();
            applyLevels();
            paintAutoButton();
            pushToUi();
            saveState();
        });

        var bPin = p.querySelector("#dnx-wfpro-pin");
        if (bPin) bPin.addEventListener("click", function () {
            if (pinCurrentProfile()) {
                this.textContent = "\u2713";
                this.style.color = "#22d94b";
                var self = this;
                setTimeout(function () { self.style.color = ""; }, 900);
            }
        });

        var bSpek = p.querySelector("#dnx-wfpro-spek");
        if (bSpek) bSpek.addEventListener("click", function () {
            var next = (spekSkalaLesen() === "pegel") ? "auto" : "pegel";
            if (typeof window.__dnxSpecSet === "function") {
                try { window.__dnxSpecSet({ skala: next }); } catch (eS) { }
            } else {
                try {
                    var k = "dnx.spectrum.darstellung.v2";
                    var o = JSON.parse(localStorage.getItem(k) || "{}") || {};
                    o.skala = next;
                    localStorage.setItem(k, JSON.stringify(o));
                } catch (eL) { }
            }
            paintSpekButton();
            try {
                if (typeof window.__dnxSpekNeuMalen === "function") window.__dnxSpekNeuMalen();
            } catch (eN) { }
        });
        paintSpekButton();

        var bTog = p.querySelector("#dnx-wfpro-toggle");
        if (bTog) bTog.addEventListener("click", function () {
            st.collapsed = !st.collapsed;
            elPanel.classList.toggle("dnx-wfpro-collapsed", st.collapsed);
            this.textContent = st.collapsed ? "\u25C2" : "\u25BE";
            saveState();
        });

        pushToUi();
    }


    // ------------------------------------------------ Ein-/Ausschalten
    function panelEl() {
        return document.getElementById("dnx-wfpro-panel");
    }

    function isVisible() {
        var p = panelEl();
        if (!p) return !st.hidden;
        return p.style.display !== "none";
    }

    function applyHidden() {
        var p = panelEl();
        if (p) p.style.display = st.hidden ? "none" : "";
        var fb = document.getElementById("dnx-wfpro-fallback");
        if (fb) fb.style.display = st.hidden ? "none" : "";
        paintToolButton();
    }

    function setHidden(h) {
        st.hidden = !!h;
        if (!st.hidden && !panelEl()) {
            try { buildPanel(); } catch (e) { console.error(LOG, "build", e); }
        }
        applyHidden();
        saveState();
        console.info(LOG, "Panel " + (st.hidden ? "aus" : "an"));
    }

    function togglePanel() {
        setHidden(isVisible());
    }

    // Knopf in der DNX-Werkzeugreihe (sieht aus wie die anderen)
    function paintToolButton() {
        var b = document.getElementById("dnx-master-pegel");
        if (!b) return;

        var on = isVisible();

        b.textContent = "Pegel: " + (on ? "On" : "Off");
        b.style.setProperty("background", on ? "#1f8f52" : "#666666", "important");
        b.style.setProperty("color", on ? "#f2fff8" : "#ffffff", "important");
        b.style.setProperty("animation", "none", "important");
        b.style.setProperty("transition", "none", "important");
        b.style.setProperty("transform", "none", "important");
        b.style.setProperty("filter", "none", "important");
    }

    function mountToolButton() {
        try {
            var row = document.getElementById("dnx-master-tool-row");
            if (!row) return;

            var b = document.getElementById("dnx-master-pegel");

            if (!b) {
                b = document.createElement("button");
                b.id = "dnx-master-pegel";
                b.type = "button";
                b.title = "Pegelregler (Contrast Wasserfall, Range/Offset Spektrum) ein- oder ausschalten";
                b.addEventListener("click", function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    togglePanel();
                });
                row.appendChild(b);
                console.info(LOG, "Werkzeugknopf eingesetzt");
            }

            paintToolButton();
        } catch (e) {
            console.error(LOG, "mountToolButton", e);
        }
    }

    // global erreichbar, z. B. fuer andere Plugins
    window.DNXWaterfallPro = {
        show: function () { setHidden(false); },
        hide: function () { setHidden(true); },
        toggle: togglePanel,
        isVisible: isVisible
    };


    // ------------------------------------------------ Groesse (Resize)
    function applyGeometry(p) {
        if (!p) return;
        if (st.w) p.style.width = st.w + "px";
        if (st.h) p.style.height = st.h + "px";
        if (st.top !== null && isFinite(st.top)) p.style.top = st.top + "px";
        if (st.left !== null && isFinite(st.left)) {
            p.style.left = st.left + "px";
            p.style.right = "auto";
        }
        layoutRails(p);
    }

    // Regler bekommen so viel Hoehe, wie im Panel frei ist
    function layoutRails(p) {
        if (!p) return;
        if (!p.style.height) {                       // automatische Hoehe: Standard
            p.style.removeProperty("--rail-h");
            return;
        }
        var h = p.clientHeight;
        if (!h) return;

        var fixed = 0;
        var sels = [".dnx-wfpro-head", ".dnx-wfpro-sep", ".dnx-wfpro-lvls", ".dnx-wfpro-btns"];
        for (var i = 0; i < sels.length; i++) {
            var e = p.querySelector(sels[i]);
            if (e) fixed += e.offsetHeight;
        }
        var small = p.querySelectorAll(".dnx-wfpro-cap, .dnx-wfpro-num");
        for (var j = 0; j < small.length; j++) fixed += small[j].offsetHeight;

        var nodes = p.querySelectorAll(".dnx-wfpro-node").length || 2;
        var avail = h - fixed - 14;                  // 14 = Innenabstaende
        var rail = Math.max(38, Math.floor(avail / nodes));
        p.style.setProperty("--rail-h", rail + "px");
    }

    function makeResizable(p) {
        // 4 Seiten + 4 Ecken
        var GRIPS = [
            ["n", 0, 1, 0, -1], ["s", 0, 0, 0, 1],
            ["w", 1, 0, -1, 0], ["e", 0, 0, 1, 0],
            ["nw", 1, 1, -1, -1], ["ne", 0, 1, 1, -1],
            ["sw", 1, 0, -1, 1], ["se", 0, 0, 1, 1]
        ];

        var MINW = 44, MINH = 120, MAXW = 260;

        function drag(handle, moveLeft, moveTop, dirX, dirY) {
            function start(ev) {
                ev.preventDefault();
                ev.stopPropagation();

                var e = ev.touches ? ev.touches[0] : ev;
                var r = p.getBoundingClientRect();
                var sx = e.clientX, sy = e.clientY;
                var sw = r.width, sh = r.height;
                var sLeft = r.left, sTop = r.top;

                function move(ev2) {
                    var x = ev2.touches ? ev2.touches[0] : ev2;
                    var dx = x.clientX - sx;
                    var dy = x.clientY - sy;

                    var w = sw, h = sh, left = sLeft, top = sTop;

                    if (dirX === -1) {                       // linke Kante
                        var nw = clamp(sw - dx, MINW, MAXW);
                        left = sLeft + (sw - nw);
                        w = nw;
                    } else if (dirX === 1) {                 // rechte Kante
                        w = clamp(sw + dx, MINW, MAXW);
                    }

                    if (dirY === -1) {                       // obere Kante
                        // bis ganz nach oben (0) und darueber hinaus die Hoehe wachsen lassen
                        top = Math.max(0, sTop + dy);
                        h = sTop + sh - top;
                        if (h < MINH) { h = MINH; top = Math.max(0, sTop + sh - MINH); }
                    } else if (dirY === 1) {                 // untere Kante
                        h = Math.max(MINH, sh + dy);         // kein Deckel: bis zum Bildschirmrand
                    }

                    // nie ueber den Bildschirm hinaus
                    h = Math.min(h, window.innerHeight - top);

                    p.style.width = Math.round(w) + "px";
                    p.style.height = Math.round(h) + "px";
                    p.style.top = Math.round(top) + "px";
                    p.style.left = Math.round(left) + "px";
                    p.style.right = "auto";

                    st.w = Math.round(w);
                    st.h = Math.round(h);
                    st.top = Math.round(top);
                    st.left = Math.round(left);

                    layoutRails(p);
                    if (ev2.cancelable) ev2.preventDefault();
                }

                function up() {
                    document.removeEventListener("mousemove", move);
                    document.removeEventListener("mouseup", up);
                    document.removeEventListener("touchmove", move);
                    document.removeEventListener("touchend", up);
                    saveState();
                }

                document.addEventListener("mousemove", move);
                document.addEventListener("mouseup", up);
                document.addEventListener("touchmove", move, { passive: false });
                document.addEventListener("touchend", up);
            }

            handle.addEventListener("mousedown", start);
            handle.addEventListener("touchstart", start, { passive: false });
        }

        for (var i = 0; i < GRIPS.length; i++) {
            var g = GRIPS[i];
            var el = document.createElement("div");
            el.className = "dnx-wfpro-rs dnx-wfpro-rs-" + g[0];
            el.title = "Groesse ziehen";
            p.appendChild(el);
            drag(el, g[1], g[2], g[3], g[4]);
        }
    }

    // ------------------------------------------------ Pegel pro Profil merken
    var PROFILE_KEY = "dnx.wfpro.profiles";

    function profileStore() {
        try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "{}") || {}; }
        catch (e) { return {}; }
    }

    function profileSave(key, val) {
        try {
            var all = profileStore();
            if (val) all[key] = val; else delete all[key];
            localStorage.setItem(PROFILE_KEY, JSON.stringify(all));
        } catch (e) { }
    }

    function activeProfileId() {
        try {
            var el = document.getElementById("openwebrx-sdr-profiles-listbox");
            if (el && el.value) return el.value;
        } catch (e) { }
        return null;
    }

    function applyProfileLevels(key) {
        var rec = profileStore()[key];
        if (!rec) return false;
        if (isFinite(rec.con)) st.con = clamp(parseFloat(rec.con), 0, 100);
        st.autoFit = (rec.autoFit === 1);
        if (isFinite(rec.range) && isFinite(rec.offset) && parseFloat(rec.range) >= RANGE_MIN) {
            st.range = parseFloat(rec.range);
            st.offset = parseFloat(rec.offset);
            syncEdgesFromRangeOffset();
        } else {
            var b = isFinite(rec.boden) ? parseFloat(rec.boden) : (isFinite(rec.min) ? parseFloat(rec.min) : null);
            var d = isFinite(rec.deckel) ? parseFloat(rec.deckel) : (isFinite(rec.max) ? parseFloat(rec.max) : null);
            if (b !== null && d !== null && d > b) {
                setWindow(b, d);
            }
        }
        try { applyContrast(); } catch (eC) { }
        try { computeWindow(); applyLevels(); paintAutoButton(); pushToUi(); } catch (ePp) { }
        return true;
    }

    function pinCurrentProfile() {
        var key = activeProfileId();
        if (!key) { console.warn(LOG, "Kein Profil erkannt - nichts gemerkt"); return false; }
        profileSave(key, { range: r1(st.range), offset: r1(st.offset),
                         boden: r1(st.lo), deckel: r1(st.hi), min: r1(st.lo), max: r1(st.hi),
                         con: r1(st.con), autoFit: st.autoFit ? 1 : 0 });
        console.info(LOG, "Pegel fuer Profil gemerkt:", key, "Range=" + st.range, "Offset=" + st.offset, "(" + st.lo + ".." + st.hi + ")");
        return true;
    }

    var lastProfile = null;

    function watchProfile() {
        var key = activeProfileId();
        if (!key || key === lastProfile) return;
        lastProfile = key;
        if (applyProfileLevels(key)) { console.info(LOG, "gemerkte Pegel angewendet:", key); return; }
        try { window.__dnxStats = null; } catch (eRs) { }
        try { _glBoden = null; _glDyn = null; _fzFloor = null; _fzLetzt = 0; } catch (eRf) { }
        if (st.autoFit) {
            setTimeout(function () { try { computeWindow(); applyLevels(); pushToUi(); } catch (eNz) { } }, 900);
        }
    }


    // ------------------------------------------------ Auto-Modus
    function spekSkalaLesen() {
        if (typeof window.__dnxSpecSkala === "function") {
            try { return window.__dnxSpecSkala() === "pegel" ? "pegel" : "auto"; } catch (e) { }
        }
        try {
            var raw = localStorage.getItem("dnx.spectrum.darstellung.v2");
            if (raw) {
                var o = JSON.parse(raw);
                if (o && o.skala === "auto") return "auto";
            }
        } catch (e2) { }
        return "pegel";
    }

    function paintSpekButton() {
        var b = document.getElementById("dnx-wfpro-spek");
        if (!b) return;
        var peg = (spekSkalaLesen() === "pegel");
        b.textContent = peg ? "Spek: Pegel" : "Spek: Auto";
        if (peg) {
            b.style.setProperty("background", "rgba(34,184,240,0.75)", "important");
            b.style.setProperty("color", "#04121a", "important");
            b.title = "Spektrum-Skala: Pegel aktiv (Range & Offset heben/senken die Signale). Klick = Auto";
        } else {
            b.style.setProperty("background", "", "important");
            b.style.setProperty("color", "", "important");
            b.title = "Spektrum-Skala: Auto (Rauschboden fest). Klick = an Range & Offset koppeln";
        }
    }
    try { window.__dnxWfProSpekSync = paintSpekButton; } catch (eWs) { }

    function paintAutoButton() {
        var b = document.getElementById("dnx-wfpro-auto");
        if (b) {
            var aktiv = !!st.autoFit;
            if (aktiv) {
                b.style.setProperty("background", "rgba(34,184,240,0.75)", "important");
                b.style.setProperty("color", "#04121a", "important");
                b.title = "Spektrum-Auto an: Range & Offset folgen den gemessenen Spektrum-Pegeln (Klick = aus)";
            } else {
                b.style.setProperty("background", "", "important");
                b.style.setProperty("color", "", "important");
                b.title = "Spektrum-Auto aus (Klick = Spektrum-Automatik einschalten)";
            }
        }
        paintSpekButton();
    }

    function setAuto(on) { st.auto = false; }
    function manualMode() { st.auto = false; }

    function pushToUi() {
        if (!elPanel) return;
        if (elCon) elCon.value = Math.round(st.con);
        if (elRange) elRange.value = String(r1(st.range));
        if (elOffset) elOffset.value = String(r1(st.offset));
        updateReadout();
    }

    // ------------------------------------------------------------------ init
    var tries = 0;

    function tryInit() {
        tries++;
        var w = W();

        if (!w) {
            if (tries === 40) console.warn(LOG, "Waterfall-Objekt nicht gefunden – Panel bleibt passiv (nur Anzeige).");
        }

        /* v6.62: Wasserfall-Pegel (w.levels / w.auto_levels / w.updateAutoColors) werden
           NICHT mehr angefasst. Nur Contrast wirkt auf w.colors, und hookDrawLine liest
           passiv die FFT-Bins fuer das Spektrum-AutoFit aus. */
        if (w && !w._dnxContrastInit) {
            w._dnxContrastInit = true;
            hookTheme();
            applyContrast();
            console.info(LOG, "Contrast " + st.con + " auf Wasserfall gesetzt");
        }

        if (w && !w._dnxStatsHooked) {
            w._dnxStatsHooked = true;
            try { hookDrawLine(w); } catch (e) { console.error(LOG, "hookDraw", e); }
        }

        if (!st.initialized) {
            loadState();
            st.initialized = true;
        }

        buildPanel();
        pushToUi();
        applyHidden();

        if (w) {
            if (!tryInit._applied) {
                applyLevels();
                tryInit._applied = true;
            }
            return true;
        }
        return false;
    }

    function boot() {
        // gespeicherten Zustand zuerst lesen, damit das Panel nicht kurz aufblitzt
        try { loadState(); } catch (e) { }

        var timer = setInterval(function () {
            var ok = false;
            try { ok = tryInit(); } catch (e) { console.error(LOG, e); }
            if (ok || tries > 160) clearInterval(timer);
        }, 250);

        // erstmal sofort bauen, damit das Panel unabhaengig sichtbar ist
        try { buildPanel(); } catch (e) { console.error(LOG, "build", e); }

        // Notfall-Anzeige: falls das Panel nicht gebaut werden konnte
        setTimeout(function () {
            if (!document.getElementById("dnx-wfpro-panel") && !st.hidden) {
                var b = document.createElement("button");
                b.id = "dnx-wfpro-fallback";
                b.type = "button";
                b.title = "Pegelregler";
                b.textContent = "PEGEL";
                b.style.cssText = "position:fixed;right:6px;top:110px;z-index:1500;" +
                    "padding:6px 8px;font-size:11px;background:#243039;color:#dfe6ec;" +
                    "border:1px solid rgba(255,255,255,.2);border-radius:4px;cursor:pointer;";
                b.addEventListener("click", function () { try { buildPanel(); } catch (e) { console.error(LOG, e); } });
                document.body.appendChild(b);
                console.warn(LOG, "Fallback-Button eingeblendet");
            }
        }, 3000);

        // gespeicherten Ein-/Aus-Zustand anwenden
        applyHidden();

        // Werkzeugknopf einsetzen und Zustand nachziehen
        // (die DNX-Reihe wird vom Styler ggf. neu aufgebaut)
        mountToolButton();
        setInterval(mountToolButton, 800);

        // Profilwechsel bemerken und gemerkte Pegel anwenden
        watchProfile();
        setInterval(watchProfile, 1000);

        // Contrast bei Palette-Wechsel erhalten; Spektrum-AutoFit sanft nachziehen (Waterfall.levels bleibt unberuehrt!)
        setInterval(function () {
            try { paintSpekButton(); } catch (ePs) { }
            var wC = W();
            if (wC && wC.colors && wC.colors.length && !wC.colors._dnxContrasted) {
                try { applyContrast(); } catch (eCon) { }
            }
            if (st.autoFit) {
                var vor = st.lo + "|" + st.hi;
                try { computeWindow(); } catch (eCw) { }
                if (st.lo + "|" + st.hi !== vor) {
                    try { applyLevels(); updateReadout(); pushToUi(); } catch (eAp) { }
                }
            }
        }, 600);

        window.addEventListener("resize", function () {
            var p = panelEl();
            if (p) layoutRails(p);
        });
    }

    /* ---- v6.33: Bruecke zum DNX-Styler (Pegel-Block) [DNX-PEGEL-1] ----
       Der Styler sitzt in einem eigenen Plugin und kommt an die inneren Werte
       nicht heran. Ueber diese drei Funktionen liest und setzt er sie. */
    function pegelLesen() {
        return {
            kontrast: r1(st.con),
            range: r1(st.range),
            offset: r1(st.offset),
            boden: r1(st.lo),
            deckel: r1(st.hi),
            autoFit: st.autoFit ? 1 : 0,
            profil: activeProfileId() || ""
        };
    }

    function pegelSetzen(w) {
        if (!w || typeof w !== "object") { return false; }
        var war = [];
        var kontrastNeu = false;
        if (isFinite(w.kontrast)) {
            st.con = clamp(parseFloat(w.kontrast), 0, 100);
            war.push("Contrast");
            kontrastNeu = true;
        }
        if (w.autoFit === 0 || w.autoFit === 1 || typeof w.autoFit === "boolean") {
            st.autoFit = !!w.autoFit;
            if (st.autoFit) { _glBoden = null; _glDyn = null; }
            war.push("Automatik " + (st.autoFit ? "an" : "aus"));
        }
        var hatR = isFinite(w.range);
        var hatO = isFinite(w.offset);
        var hatB = isFinite(w.boden);
        var hatD = isFinite(w.deckel);
        if (hatR || hatO) {
            if (!(w.autoFit === 1 || w.autoFit === true)) st.autoFit = false;
            if (hatR) { st.range = r1(clamp(parseFloat(w.range), RANGE_MIN, RANGE_MAX)); war.push("Range"); }
            if (hatO) { st.offset = r1(clamp(parseFloat(w.offset), OFFSET_MIN, OFFSET_MAX)); war.push("Offset"); }
            syncEdgesFromRangeOffset();
        } else if (hatB || hatD) {
            if (!(w.autoFit === 1 || w.autoFit === true)) st.autoFit = false;
            var curLo = isFinite(st.lo) ? st.lo : -41.5;
            var curHi = isFinite(st.hi) ? st.hi : -23.0;
            var nb = hatB ? parseFloat(w.boden) : curLo;
            var nd = hatD ? parseFloat(w.deckel) : curHi;
            if (nd - nb < RANGE_MIN) nd = nb + RANGE_MIN;
            setWindow(nb, nd);
            war.push("Pegel");
        }
        if (!war.length) { return false; }
        _syncingStyler = true;
        try {
            if (elCon) { elCon.value = st.con; }
            computeWindow();
            applyLevels();
            if (kontrastNeu) { applyContrast(); }
            paintAutoButton();
            pushToUi();
            saveState();
        } catch (eSet) { }
        _syncingStyler = false;
        console.info(LOG, "Pegel uebernommen: " + war.join(", "));
        return true;
    }

    function pegelMerken() {
        return pinCurrentProfile();
    }

    try { window.__dnxPegelLesen = pegelLesen; } catch (eA) { }
    try { window.__dnxPegelSet = pegelSetzen; } catch (eB) { }
    try { window.__dnxPegelMerken = pegelMerken; } catch (eC) { }

    /* ---- DNX_WF_GAIN_AUTO_START ----------------------------------------
       Weiss-Schutz: Wenn der RF-Gain am Funkgeraet gedreht wird, springt der
       Rauschboden um 20-25 dB. Liegt er dann ueber der oberen Fensterkante,
       laeuft das Bild oben aus der Skala - alles weiss. Deshalb passt der
       Wasserfall das Fenster von selbst nach, sobald die Messung oben oder
       unten anstoesst. Das gilt unabhaengig davon, wodurch der Pegel springt
       (RF-Gain, Antenne, Bandwechsel).
       ------------------------------------------------------------------- */
    var _weissLetzt = 0;
    function weissSchutz(kraft) {
        /* v6.62: Wasserfall-Weiss-Schutz greift nicht mehr in manuelle Spektrum-Pegel ein. */
        return false;
        if (st.autoFit) { return false; }          /* Automatik rechnet selbst */
        if (st.auto) { return false; }             /* Auto-Knopf regelt schon */
        if (Date.now() - _manualTouchAt < 3000) { return false; }
        var s = window.__dnxStats;
        if (!s || !isFinite(s.p05) || !isFinite(s.p999)) { return false; }
        var jetzt = Date.now();
        if (!kraft && jetzt - _weissLetzt < 500) { return false; }
        var sp = r1(st.hi - st.lo);
        if (!isFinite(sp) || sp < SPAN_MIN) { sp = SPAN_MIN; }
        var d = 0, grund = "";
        if (s.p999 > st.hi - 1.5) {                  /* Spitzen ueber der Decke -> weiss */
            d = r1(Math.min(6, s.p999 - st.hi + 3));
            grund = "oben";
        } else if (s.p05 < st.lo - 1.5) {
            /* Passband-Grund deutlich unter dem Boden (z.B. Gain reduziert) -> sanft nachziehen */
            d = r1(Math.max(-6, s.p05 - st.lo - 2));
            grund = "unten";
        }
        if (d === 0) { return false; }
        _weissLetzt = jetzt;
        st.lo = r1(st.lo + d);
        st.hi = r1(st.lo + sp);
        st.span = sp;
        if (st.kanteAn && isFinite(st.loMan) && isFinite(st.hiMan)) {
            /* von Hand gesetzte Kanten mitziehen */
            st.loMan = r1(st.loMan + d);
            st.hiMan = r1(st.hiMan + d);
        }
        try { posONachziehen(); applyLevels(); updateReadout(); } catch (eA) { }
        try { if (typeof pushToUi === "function") { pushToUi(); } } catch (eP) { }
        try { saveState(); } catch (eS) { }
        console.info(LOG, "Weiss-Schutz: Messung stoesst " + grund +
            " an, Fenster um " + d + " dB verschoben -> " + st.lo + " bis " + st.hi + " dB");
        return true;
    }
    try { window.__dnxWeissSchutz = weissSchutz; } catch (eW0) { }

    var _gainTimer = [];
    function gainNachziehen() {
        for (var i = 0; i < _gainTimer.length; i++) { clearTimeout(_gainTimer[i]); }
        _gainTimer = [];
        var zeiten = [300, 1200, 2500, 4500, 7000, 10000];
        for (var z = 0; z < zeiten.length; z++) {
            _gainTimer.push(setTimeout(function () { weissSchutz(true); }, zeiten[z]));
        }
    }
    try {
        window.addEventListener("dnx-rf-gain", function (ev) {
            var w = (ev && ev.detail && typeof ev.detail.wert === "number") ? ev.detail.wert : null;
            gainNachziehen();
            console.info(LOG, "RF-Gain am Funkgeraet gedreht" + (w === null ? "" : " (" + w + " dB)") + " - Weiss-Schutz laeuft");
        });
    } catch (eG1) { }
    /* im 600-ms-Takt mitlaufen (der Takt steht weiter unten in initPanel) */
    try { window.__dnxWeissSchutzTakt = function () { weissSchutz(false); }; } catch (eG2) { }
    /* ---- DNX_WF_GAIN_AUTO_ENDE ---------------------------------------- */

    /* ---- v6.33b: Vorrat je Profil [DNX-PEGEL-2] ----
       Aussen heissen die Felder offset/range/kontrast (wie im Styler),
       innen posO/posR/con/autoFit (wie im Wasserfall-Pro). */
    function pegelProfilLesen() {
        var aus = {}, store = profileStore(), k, s, ein;
        var n = 0;
        for (k in store) {
            if (!Object.prototype.hasOwnProperty.call(store, k)) { continue; }
            s = store[k];
            if (!s || typeof s !== "object") { continue; }
            ein = {};
            if (isFinite(s.range)) { ein.range = r1(s.range); }
            if (isFinite(s.offset)) { ein.offset = r1(s.offset); }
            if (isFinite(s.boden)) { ein.boden = r1(s.boden); }
            else if (isFinite(s.min)) { ein.boden = r1(s.min); }
            if (isFinite(s.deckel)) { ein.deckel = r1(s.deckel); }
            else if (isFinite(s.max)) { ein.deckel = r1(s.max); }
            if (isFinite(s.con)) { ein.kontrast = r1(s.con); }
            if (s.autoFit === 0 || s.autoFit === 1) { ein.autoFit = s.autoFit; }
            if (!Object.keys(ein).length) { continue; }
            aus[k] = ein;
            if (++n >= 200) { break; }          // Anfrage klein halten
        }
        return aus;
    }

    function pegelProfilSetzen(karte) {
        if (!karte || typeof karte !== "object") { return false; }
        var store = profileStore(), n = 0, k, s, ein;
        for (k in karte) {
            if (!Object.prototype.hasOwnProperty.call(karte, k)) { continue; }
            s = karte[k];
            if (!s || typeof s !== "object" || typeof k !== "string" || !k || k.length > 60) { continue; }
            ein = {};
            if (isFinite(s.range)) { ein.range = r1(clamp(parseFloat(s.range), RANGE_MIN, RANGE_MAX)); }
            if (isFinite(s.offset)) { ein.offset = r1(clamp(parseFloat(s.offset), OFFSET_MIN, OFFSET_MAX)); }
            if (isFinite(s.boden)) { ein.boden = r1(clamp(parseFloat(s.boden), LO_MAN_MIN, LO_MAN_MAX)); }
            if (isFinite(s.deckel)) { ein.deckel = r1(clamp(parseFloat(s.deckel), HI_MAN_MIN, HI_MAN_MAX)); }
            if (isFinite(s.kontrast)) { ein.con = clamp(parseFloat(s.kontrast), 0, 100); }
            if (s.autoFit === 0 || s.autoFit === 1) { ein.autoFit = s.autoFit; }
            if (!Object.keys(ein).length) { continue; }
            store[k] = ein;
            if (++n >= 300) { break; }
        }
        if (!n) { return false; }
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(store)); } catch (eSp) { return false; }
        /* Laeuft genau dieses Profil gerade? Dann sofort anwenden. */
        var aktiv = activeProfileId();
        if (aktiv && store[aktiv]) {
            try { applyProfileLevels(aktiv); } catch (eAp) { }
        }
        console.info(LOG, "Pegel-Vorrat vom Styler: " + n + " Profile");
        return true;
    }

    try { window.__dnxPegelProfile = pegelProfilLesen; } catch (eD) { }
    try { window.__dnxPegelProfileSet = pegelProfilSetzen; } catch (eE) { }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }

    console.info(LOG, "geladen | Build " + DNX_BUILD + " | Contrast=Wasserfall, Range/Offset=Spektrum");
})();
