/**
 * The TV player: one self-contained page for the TV's browser at <PUBLIC_URL>/tv. Without a
 * screen link it shows a code to enter in the back office; with one it plays the screen's
 * slides, asks for changes every minute and keeps playing what it has when the internet drops.
 * Plain ES2015 and DOM calls so older smart TV and stick browsers run it.
 */
export function playerPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Screen</title>
<style>${CSS}</style></head>
<body><div id="stage"></div><script>${JS}</script></body></html>`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:#000;color:#fff;cursor:none}
body{font-family:"Segoe UI",system-ui,-apple-system,"Noto Sans","Noto Sans Arabic",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
#stage{position:fixed;left:0;top:0;width:100vw;height:100vh;overflow:hidden}
#stage.rot{width:100vh;height:100vw;transform-origin:0 0;transform:rotate(90deg) translateY(-100%)}
.slide{position:absolute;inset:0;left:0;top:0;width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;opacity:0;transition:opacity .6s ease;padding:6vmin;text-align:center}
.slide.on{opacity:1}
.brand{background:#0b6158;color:#fff}.dark{background:#0e1514;color:#e8efed}.light{background:#f6f8f7;color:#111a19}.offer{background:#b8401a;color:#fff}
.media{background:#000;padding:0}.media img,.media video{width:100%;height:100%;object-fit:contain;display:block}
h1{font-size:9vmin;line-height:1.1;font-weight:800;letter-spacing:-.01em}
h2{font-size:5vmin;line-height:1.2;font-weight:700;opacity:.92}
p{font-size:4.2vmin;line-height:1.35;margin-top:2.5vmin;max-width:80%;white-space:pre-line}
.ar{font-family:"Noto Sans Arabic","Segoe UI",Tahoma,sans-serif}
.gap{margin-top:3vmin}
.deal{font-size:11vmin;font-weight:900;line-height:1.05;margin-top:3vmin}
.dealsub{font-size:4.4vmin;font-weight:600;margin-top:2vmin;opacity:.95}
.until{position:absolute;bottom:4vmin;font-size:3.2vmin;opacity:.85}
.board{justify-content:flex-start;align-items:stretch;text-align:start;padding:5vmin 6vmin}
.board header{display:flex;justify-content:space-between;align-items:baseline;gap:4vmin;border-bottom:.4vmin solid currentColor;padding-bottom:2vmin;margin-bottom:2.5vmin}
.board header h1{font-size:6.5vmin}
.board header .pg{font-size:3vmin;opacity:.8}
.rows{display:grid;grid-template-columns:1fr 1fr;column-gap:6vmin;row-gap:.6vmin;flex:1;align-content:start}
.rows.one{grid-template-columns:1fr}
.rows.few{row-gap:1.5vmin}.rows.few .row .n{font-size:5vmin}.rows.few .row .n small{font-size:3.6vmin}.rows.few .row .v{font-size:5.6vmin}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:3vmin;padding:1.1vmin 0;border-bottom:.15vmin solid rgba(255,255,255,.22)}
.light .row{border-bottom-color:rgba(0,0,0,.14)}
.row .n{font-size:3.6vmin;font-weight:600;line-height:1.2;min-width:0}
.row .n small{display:block;font-size:2.8vmin;font-weight:500;opacity:.85}
.row .v{font-size:4vmin;font-weight:800;white-space:nowrap;font-variant-numeric:tabular-nums}
.row .v small{font-size:2.4vmin;font-weight:600;opacity:.8}
.pair{background:#0e1514;color:#e8efed}
.code{font-size:20vmin;font-weight:800;letter-spacing:.12em;font-variant-numeric:tabular-nums;margin:4vmin 0;color:#5fcabb}
.pair p{font-size:3.6vmin;opacity:.9}
.muted{opacity:.7}
.clock{font-size:14vmin;font-weight:700;font-variant-numeric:tabular-nums}
`;

const JS = String.raw`
(function () {
  "use strict";
  var stage = document.getElementById("stage");
  var TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;
  var feed = null, idx = -1, timer = null, feedTimer = null, current = null, fails = 0;

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function put(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  function readToken() {
    var h = location.hash.replace(/^#/, "");
    if (TOKEN_RE.test(h)) { put("tv-token", h); return h; }
    var saved = get("tv-token");
    return saved && TOKEN_RE.test(saved) ? saved : null;
  }
  var token = readToken();

  function el(tag, cls, text, attrs) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function add(parent, child) { if (child) parent.appendChild(child); return child; }

  function show(slide) {
    var old = current;
    stage.appendChild(slide);
    current = slide;
    // Two frames so the fade starts from the slide's first paint.
    requestAnimationFrame(function () { requestAnimationFrame(function () { slide.className += " on"; }); });
    if (old) setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 700);
  }

  function json(method, path, cb) {
    var x = new XMLHttpRequest();
    x.open(method, path);
    x.timeout = 15000;
    x.onload = function () { var d = null; try { d = JSON.parse(x.responseText); } catch (e) {} cb(x.status, d); };
    x.onerror = x.ontimeout = function () { cb(0, null); };
    x.send(null);
  }
  function post(path, cb) {
    var x = new XMLHttpRequest();
    x.open("POST", path);
    x.setRequestHeader("content-type", "application/json");
    x.timeout = 15000;
    x.onload = function () { var d = null; try { d = JSON.parse(x.responseText); } catch (e) {} cb(x.status, d); };
    x.onerror = x.ontimeout = function () { cb(0, null); };
    x.send("{}");
  }

  /* ---------- Connecting by code ---------- */

  var pairTimer = null;
  function pair() {
    clearTimeout(timer); clearTimeout(feedTimer); clearTimeout(pairTimer);
    feed = null;
    post("/tv/pair", function (status, d) {
      if (status !== 200 || !d) {
        showPair(null, d && d.message ? d.message : "No connection. Trying again…");
        pairTimer = setTimeout(pair, 20000);
        return;
      }
      showPair(d.code);
      var until = Date.now() + d.expiresIn * 1000;
      (function wait() {
        json("GET", "/tv/pair/" + d.claim, function (s, r) {
          if (r && r.status === "connected" && r.token) { token = r.token; put("tv-token", token); location.hash = ""; load(); return; }
          if ((r && r.status === "expired") || Date.now() > until || s === 404) return pair();
          pairTimer = setTimeout(wait, 3000);
        });
      })();
    });
  }
  function showPair(code, problem) {
    var s = el("div", "slide pair");
    add(s, el("h2", null, "Connect this screen"));
    add(s, el("h2", "ar", "ربط هذه الشاشة", { dir: "rtl", lang: "ar" }));
    if (code) add(s, el("div", "code", code.slice(0, 3) + " " + code.slice(3)));
    else add(s, el("p", null, problem));
    add(s, el("p", null, "In the back office, open Screens, choose Connect a TV and enter this code."));
    add(s, el("p", "ar", "في المكتب الخلفي، افتح الشاشات واختر ربط شاشة وأدخل هذا الرمز.", { dir: "rtl", lang: "ar" }));
    show(s);
  }

  /* ---------- Playing ---------- */

  function load() {
    clearTimeout(feedTimer);
    if (!token) return pair();
    json("GET", "/tv/s/" + token + "/feed", function (status, d) {
      if (status === 404) { put("tv-token", null); put("tv-feed", null); token = null; location.hash = ""; return pair(); }
      if (status === 200 && d && d.slides) {
        fails = 0;
        put("tv-feed", JSON.stringify(d));
        use(d);
      } else {
        fails++;
        if (!feed) { var saved = get("tv-feed"); if (saved) { try { use(JSON.parse(saved)); } catch (e) {} } }
        if (!feed) showEmpty("Waiting for the connection…");
      }
      feedTimer = setTimeout(load, (d && d.refresh ? d.refresh : 60) * 1000 * (fails > 3 ? 2 : 1));
    });
  }

  function use(d) {
    var changed = !feed || feed.version !== d.version;
    var wasEmpty = !feed || !feed.slides.length;
    feed = d;
    stage.className = d.screen.orientation === "portrait" && window.innerWidth > window.innerHeight ? "rot" : "";
    document.title = d.screen.name;
    if (!changed) return;
    for (var i = 0; i < d.slides.length; i++) if (d.slides[i].kind === "image") new Image().src = media(d.slides[i].mediaId);
    if (idx >= d.slides.length) idx = -1;
    if (wasEmpty || !timer) next();
  }

  function media(id) { return "/tv/s/" + token + "/media/" + id; }
  function lang() { return feed ? feed.screen.lang : "both"; }
  function pick(en, ar) { var l = lang(); return l === "ar" ? ar || en : en || ar; }

  function next() {
    clearTimeout(timer);
    timer = null;
    if (!feed || !feed.slides.length) { showEmpty(); timer = setTimeout(next, 30000); return; }
    idx = (idx + 1) % feed.slides.length;
    var s = feed.slides[idx];
    try { render(s); } catch (e) { timer = setTimeout(next, 1000); }
  }
  function after(seconds) { clearTimeout(timer); timer = setTimeout(next, seconds * 1000); }

  function titles(box, en, ar, tag) {
    var l = lang();
    if (l !== "ar" && en) add(box, el(tag || "h1", null, en));
    if (l !== "en" && ar) add(box, el(tag || "h1", "ar" + (l === "both" && en ? " gap" : ""), ar, { dir: "rtl", lang: "ar" }));
    if (l === "ar" && !ar && en) add(box, el(tag || "h1", null, en));
  }

  function render(s) {
    var box;
    if (s.kind === "image") {
      box = el("div", "slide media");
      var img = add(box, el("img", null, null, { alt: "" }));
      img.onerror = function () { after(0.5); };
      img.src = media(s.mediaId);
      show(box); return after(s.duration);
    }
    if (s.kind === "video") {
      box = el("div", "slide media");
      var v = add(box, el("video", null, null, { muted: "", autoplay: "", playsinline: "", loop: "" }));
      v.muted = true;
      v.onerror = function () { after(0.5); };
      v.src = s.url;
      show(box);
      try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
      return after(s.duration);
    }
    if (s.kind === "message") {
      box = el("div", "slide " + s.theme);
      titles(box, s.title, s.titleAr);
      var l = lang();
      if (l !== "ar" && s.body) add(box, el("p", null, s.body));
      if (l !== "en" && s.bodyAr) add(box, el("p", "ar", s.bodyAr, { dir: "rtl", lang: "ar" }));
      if (l === "ar" && !s.bodyAr && s.body) add(box, el("p", null, s.body));
      show(box); return after(s.duration);
    }
    if (s.kind === "promo") {
      box = el("div", "slide " + s.theme);
      titles(box, s.title, s.titleAr, "h2");
      var l2 = lang();
      var main = l2 === "ar" ? s.dealAr : s.deal;
      if (main[0]) add(box, el("div", "deal" + (l2 === "ar" ? " ar" : ""), main[0], l2 === "ar" ? { dir: "rtl", lang: "ar" } : null));
      for (var i = 1; i < main.length; i++) add(box, el("div", "dealsub" + (l2 === "ar" ? " ar" : ""), main[i], l2 === "ar" ? { dir: "rtl" } : null));
      if (l2 === "both" && s.dealAr[0]) add(box, el("div", "dealsub ar gap", s.dealAr.join(" · "), { dir: "rtl", lang: "ar" }));
      if (s.until) add(box, el("div", "until", (l2 === "ar" ? "حتى " : "Until ") + niceDate(s.until)));
      show(box); return after(s.duration);
    }
    if (s.kind === "prices") return board(s, 0);
    after(0.5);
  }

  function niceDate(iso) {
    var m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var p = iso.split("-");
    return Number(p[2]) + " " + m[Number(p[1]) - 1] + " " + p[0];
  }

  function board(s, page) {
    var portrait = feed.screen.orientation === "portrait";
    var per = portrait ? 12 : 14;
    var pages = Math.ceil(s.products.length / per);
    var l = lang();
    var box = el("div", "slide board " + s.theme, null, l === "ar" ? { dir: "rtl", lang: "ar" } : null);
    var head = add(box, el("header"));
    var t = add(head, el("h1", l === "ar" ? "ar" : null, l === "ar" ? s.titleAr || s.title || "الأسعار" : s.title || "Prices"));
    if (l === "both" && s.titleAr) { t.appendChild(document.createTextNode(" · ")); add(t, el("span", "ar", s.titleAr, { dir: "rtl" })); }
    if (pages > 1) add(head, el("span", "pg", (page + 1) + " / " + pages));
    var rows = add(box, el("div", "rows" + (portrait ? " one" : "") + (s.products.length <= (portrait ? 6 : 8) ? " few" : "")));
    var list = s.products.slice(page * per, page * per + per);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var r = add(rows, el("div", "row"));
      var n = add(r, el("div", "n", pick(p.name, p.nameAr)));
      if (l === "both" && p.nameAr) add(n, el("small", "ar", p.nameAr, { dir: "rtl" }));
      var v = add(r, el("div", "v", p.price));
      add(v, el("small", null, p.uom === "kg" ? (l === "ar" ? " درهم/كغ" : " AED/kg") : (l === "ar" ? " درهم" : " AED")));
    }
    show(box);
    clearTimeout(timer);
    timer = setTimeout(function () { if (page + 1 < pages) board(s, page + 1); else next(); }, s.duration * 1000);
  }

  function showEmpty(note) {
    var box = el("div", "slide dark");
    if (feed) titles(box, feed.screen.store, feed.screen.storeAr, "h2");
    var c = add(box, el("div", "clock gap"));
    function tick() { var d = new Date(); c.textContent = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
    tick();
    var iv = setInterval(function () { if (!c.parentNode || !c.parentNode.parentNode) return clearInterval(iv); tick(); }, 10000);
    add(box, el("p", "muted", note || "Nothing to show yet. Add slides to this screen's playlist in the back office."));
    show(box);
  }

  // Keep the TV awake where the browser allows it, and start fresh once a day.
  function awake() { try { if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(function () {}); } catch (e) {} }
  awake();
  document.addEventListener("visibilitychange", function () { if (!document.hidden) awake(); });
  setTimeout(function () { if (navigator.onLine !== false) location.reload(); }, 24 * 3600 * 1000);
  window.addEventListener("resize", function () { if (feed) stage.className = feed.screen.orientation === "portrait" && window.innerWidth > window.innerHeight ? "rot" : ""; });
  window.addEventListener("hashchange", function () { var t = readToken(); if (t && t !== token) { token = t; feed = null; idx = -1; load(); } });

  if (token) load(); else pair();
})();
`;
