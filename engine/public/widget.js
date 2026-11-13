/*
 * Zeliks chat widget. One tag on any site:
 *   <script src=".../widget.js" data-zeliks-key="wk_..." async></script>
 * Optional: data-variant="studio|classic|soft|noir|editorial", data-theme="auto|light|dark", data-open="true".
 * Styles live in a shadow root, so the host site's CSS never leaks in or out.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__zeliksWidget) return;
  window.__zeliksWidget = true;

  var KEY = script.getAttribute('data-zeliks-key');
  var BASE = script.src.replace(/\/widget\.js.*$/, '');
  var VARIANTS = ['studio', 'classic', 'soft', 'noir', 'editorial'];
  var store = window.localStorage;
  var STORE = 'zeliks:' + KEY;

  // Variant look: references noted per style.
  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0;font:inherit;color:inherit}',
    '.z{--ac:#0f5c63;--bg:#fbfaf7;--fg:#1d1d1f;--mut:#6e6e73;--line:rgba(0,0,0,.08);--ub:var(--ac);--uf:#fff;--ab:transparent;--af:var(--fg);--in:#fff;--sh:0 24px 60px rgba(0,0,0,.18),0 2px 8px rgba(0,0,0,.06);',
    'font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Noto Sans Arabic",sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}',
    '.z.dark{--bg:#161617;--fg:#f5f5f7;--mut:#98989d;--line:rgba(255,255,255,.1);--in:#232325;--sh:0 24px 60px rgba(0,0,0,.5)}',
    // launcher
    '.launch{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:0;background:var(--ac);color:#fff;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.22);display:grid;place-items:center;z-index:2147483646;transition:transform .2s}',
    '.launch:hover{transform:scale(1.05)}.left .launch{right:auto;left:20px}',
    '.launch svg{width:26px;height:26px}',
    // panel
    '.panel{position:fixed;bottom:88px;right:20px;width:384px;height:min(640px,calc(100vh - 112px));background:var(--bg);border-radius:16px;box-shadow:var(--sh);display:flex;flex-direction:column;overflow:hidden;z-index:2147483647;opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .2s,transform .2s}',
    '.left .panel{right:auto;left:20px}.open .panel{opacity:1;transform:none;pointer-events:auto}',
    '.top{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}',
    '.logo{width:32px;height:32px;border-radius:8px;background:var(--ac);color:#fff;display:grid;place-items:center;font-weight:600;overflow:hidden;flex:none}.logo img{width:100%;height:100%;object-fit:cover}',
    '.name{font-weight:600;font-size:15px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.x{width:32px;height:32px;border:0;border-radius:8px;background:transparent;cursor:pointer;display:grid;place-items:center;color:var(--mut)}.x:hover{background:var(--line)}',
    '.grab,.back,.min,.plus,.av{display:none}',
    '.row{display:flex;align-items:flex-end;gap:8px;max-width:100%}.row .m{max-width:100%}',
    '.av{width:28px;height:28px;flex:none;border-radius:50%;background:var(--ac);color:#fff;font-size:12px;font-weight:600;place-items:center;overflow:hidden}.av img{width:100%;height:100%;object-fit:cover}',
    '.v-classic .av,.v-noir .av{display:grid}',
    '.log{flex:1;overflow-y:auto;padding:20px 16px 8px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}',
    '.m{max-width:85%;white-space:pre-wrap;word-wrap:break-word;unicode-bidi:plaintext}',
    '.m.u{align-self:flex-end;background:var(--ub);color:var(--uf);padding:9px 13px;border-radius:14px 14px 4px 14px}',
    '.m.a{align-self:flex-start;background:var(--ab);color:var(--af)}',
    '.m.a b{font-weight:600}',
    '.dots{display:inline-flex;gap:4px;padding:6px 0}.dots i{width:6px;height:6px;border-radius:50%;background:var(--mut);animation:b 1.2s infinite}.dots i:nth-child(2){animation-delay:.15s}.dots i:nth-child(3){animation-delay:.3s}',
    '@keyframes b{0%,60%,100%{opacity:.3;transform:none}30%{opacity:1;transform:translateY(-3px)}}',
    '.foot{padding:10px 12px 12px;display:flex;align-items:flex-end;gap:8px}.foot .box{flex:1}',
    '.box{display:flex;align-items:flex-end;gap:8px;background:var(--in);border:1px solid var(--line);border-radius:14px;padding:6px 6px 6px 14px}',
    '.box textarea{flex:1;border:0;outline:0;background:transparent;resize:none;max-height:120px;padding:7px 0;font-size:15px;line-height:1.4}',
    '.box textarea::placeholder{color:var(--mut)}',
    '.send{width:34px;height:34px;flex:none;border:0;border-radius:10px;background:var(--ac);color:#fff;cursor:pointer;display:grid;place-items:center;transition:opacity .15s}.send:disabled{opacity:.35;cursor:default}',
    '.by{display:block;text-align:center;font-size:11px;color:var(--mut);padding-top:8px;text-decoration:none}',
    // welcome (studio, editorial)
    '.hello{padding:28px 20px 8px}.hello h2{font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-.02em}.hello p{color:var(--mut);margin-top:8px}',
    // studio: after Plain and Claude. Calm, user tinted, assistant as plain text.
    '.v-studio{--ub:color-mix(in srgb,var(--ac) 12%,var(--in));--uf:var(--fg)}',
    '.v-studio .top{border:0}',
    // classic: after Navan and Loops. Brand header, bubbles both sides.
    '.v-classic .top{background:var(--ac);color:#fff;border:0}.v-classic .top .x{color:#fff}.v-classic .top .x:hover{background:rgba(255,255,255,.15)}.v-classic .logo{background:rgba(255,255,255,.18)}',
    '.v-classic{--ab:color-mix(in srgb,var(--fg) 6%,var(--bg))}.v-classic .m.a{padding:9px 13px;border-radius:14px 14px 14px 4px}',
    // soft: after Dot and Bevel. Tinted gradient, white bubbles, frosted composer.
    '.v-soft .panel{background:linear-gradient(180deg,color-mix(in srgb,var(--ac) 18%,var(--bg)),var(--bg) 55%)}',
    '.v-soft{--ab:var(--in)}.v-soft .m.a{padding:10px 14px;border-radius:14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}.v-soft .top{border:0}',
    '.v-soft .box{background:color-mix(in srgb,var(--in) 80%,transparent);backdrop-filter:blur(12px)}',
    // noir: after Chatbase and Copilot. Always dark, light user bubble.
    '.v-noir{--bg:#0e0e10;--fg:#f5f5f7;--mut:#8e8e93;--line:rgba(255,255,255,.09);--in:#1c1c1f;--ub:#f5f5f7;--uf:#0e0e10;--ab:#1c1c1f}',
    '.v-noir .m.a{padding:9px 13px;border-radius:14px 14px 14px 4px}.v-noir .send{background:#f5f5f7;color:#0e0e10}',
    // editorial: after Pi. Serif answers, hairlines, no assistant bubble.
    '.v-editorial{--bg:#f7f3ec;--in:#fffdf9;--ub:transparent;--uf:var(--mut)}.v-editorial.dark{--bg:#1b1916;--in:#24211d}',
    '.v-editorial .m.a{font-family:Newsreader,"Iowan Old Style",Georgia,serif;font-size:17px;line-height:1.55;max-width:100%}',
    '.v-editorial .m.u{padding:0;border-radius:0;text-align:right}.v-editorial .hello h2{font-family:Newsreader,"Iowan Old Style",Georgia,serif;font-weight:500;font-size:30px}',
    // Phones: each style follows an iOS chat screen on Mobbin.
    '@media (max-width:640px){',
    '.z{font-size:17px;line-height:1.4}.open .launch{display:none}',
    '.panel{inset:0;width:auto;height:100%;bottom:0;right:0;border-radius:0;transform:translateY(100%);transition:transform .32s cubic-bezier(.32,.72,0,1)}.open .panel{transform:none}',
    '.top{position:relative;min-height:calc(env(safe-area-inset-top) + 52px);padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;justify-content:center;border-bottom:.5px solid var(--line);background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(180%) blur(20px)}',
    '.top .logo{display:none}.name{flex:none;font-size:17px;font-weight:600;text-align:center}',
    '.top .x{position:absolute;right:10px;width:32px;height:32px;border-radius:50%;background:color-mix(in srgb,var(--fg) 8%,transparent);color:var(--fg)}',
    '.log{padding:16px 16px 8px;gap:8px}.m{max-width:80%}',
    '.m.u{border-radius:14px;padding:8px 14px}',
    '.foot{padding:8px 12px calc(env(safe-area-inset-bottom) + 10px)}',
    '.box{border-radius:14px;padding:4px 4px 4px 14px}.box textarea{font-size:17px;padding:6px 0}',
    '.send{width:32px;height:32px;border-radius:50%}',
    '.plus{display:grid;place-items:center;width:36px;height:36px;flex:none;border:0;border-radius:50%;background:color-mix(in srgb,var(--fg) 7%,transparent);color:var(--fg);margin-bottom:2px}',
    // studio = ChatGPT iOS: no bar line, close at left in a circle, floating composer card.
    '.v-studio .top{border:0;background:var(--bg);backdrop-filter:none}.v-studio .top .x{right:auto;left:12px}',
    '.v-studio .m.a{max-width:100%}.v-studio .m.u{--ub:color-mix(in srgb,var(--fg) 7%,var(--bg))}',
    '.v-studio .foot{padding:8px 12px calc(env(safe-area-inset-bottom) + 12px)}.v-studio .plus{display:none}',
    '.v-studio .box{border-radius:16px;padding:8px 8px 8px 16px;box-shadow:0 6px 24px rgba(0,0,0,.08)}.v-studio .send{background:var(--fg);color:var(--bg)}',
    // classic = Vestiaire / Rivian: back chevron, logo and name on the left, bubbles with logo.
    '.v-classic .top{justify-content:flex-start;gap:10px;background:var(--ac)}.v-classic .back{display:grid;place-items:center;width:28px;height:36px;border:0;background:none;color:#fff}',
    '.v-classic .top .logo{display:grid;width:34px;height:34px;border-radius:50%}.v-classic .name{text-align:left;color:#fff}.v-classic .top .x{display:none}',
    '.v-classic .log{background:color-mix(in srgb,var(--fg) 4%,var(--bg))}.v-classic{--ab:var(--in)}.v-classic .m.a{border-radius:14px;box-shadow:0 1px 1px rgba(0,0,0,.04)}',
    '.v-classic .plus{background:none}',
    // soft = Dot: tinted gradient, no hard bar, frosted composer, separate plus.
    '.v-soft .top{border:0;background:transparent;backdrop-filter:none}.v-soft .top .x{right:auto;left:12px;background:color-mix(in srgb,var(--in) 70%,transparent)}',
    '.v-soft .panel{background:linear-gradient(180deg,color-mix(in srgb,var(--ac) 26%,var(--bg)),color-mix(in srgb,var(--ac) 8%,var(--bg)) 60%,var(--bg))}',
    '.v-soft .m.a{border-radius:14px}.v-soft .foot{background:color-mix(in srgb,var(--bg) 60%,transparent);backdrop-filter:blur(20px)}',
    '.v-soft .plus{background:color-mix(in srgb,var(--in) 80%,transparent)}',
    // noir = One: dark, Minimize in the accent colour, centred title, round avatars.
    '.v-noir .min{display:block;position:absolute;left:14px;border:0;background:none;color:color-mix(in srgb,var(--ac) 55%,#fff);font-size:17px}',
    '.v-noir .top{background:#0e0e10;backdrop-filter:none}.v-noir .top .x{background:none}',
    '.v-noir .m.a{border-radius:14px}.v-noir .box{background:transparent;border:1px solid rgba(255,255,255,.25);border-radius:14px}.v-noir .plus{display:none}',
    // editorial = Agoda: a sheet over the dimmed page, grabber, round close.
    '.v-editorial .panel{top:12px;border-radius:14px 14px 0 0;box-shadow:0 -1px 0 var(--line)}',
    '.v-editorial.open::before{content:"";position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:2147483646}',
    '.v-editorial .grab{display:block;width:36px;height:5px;border-radius:3px;background:color-mix(in srgb,var(--fg) 22%,transparent);margin:6px auto 0}',
    '.v-editorial .top{padding-top:8px;min-height:48px;background:transparent;backdrop-filter:none}.v-editorial .plus{display:none}',
    '}',
  ].join('');

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>';
  var ICON_X = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  var ICON_BACK = '<svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2 2 10l8 8"/></svg>';
  var ICON_PLUS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  var ICON_UP = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  // Just **bold** and links: enough for prices and lists, nothing that can inject markup.
  function format(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  }
  function api(path, body) {
    return fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Widget-Key': KEY },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function load() { try { return JSON.parse(store.getItem(STORE)) || {}; } catch (e) { return {}; } }
  function save(s) { try { store.setItem(STORE, JSON.stringify(s)); } catch (e) {} }

  function start(cfg) {
    var host = el('div');
    host.id = 'zeliks-widget';
    document.body.appendChild(host);
    var root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', null, CSS));

    var variant = script.getAttribute('data-variant') || cfg.variant || 'studio';
    if (VARIANTS.indexOf(variant) < 0) variant = 'studio';
    var theme = script.getAttribute('data-theme') || cfg.theme || 'auto';
    var dark = theme === 'dark' || (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    if (variant === 'editorial' && !document.getElementById('zeliks-font')) {
      var f = el('link'); f.id = 'zeliks-font'; f.rel = 'stylesheet';
      f.href = 'https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&display=swap';
      document.head.appendChild(f);
    }
    var z = el('div', 'z v-' + variant + (dark ? ' dark' : '') + (cfg.position === 'bottom-left' ? ' left' : ''));
    z.style.setProperty('--ac', cfg.primary_color || '#0f5c63');
    root.appendChild(z);

    var state = load();
    var initial = (cfg.business_name || '?').trim().charAt(0).toUpperCase();
    var logo = cfg.logo_url ? '<img alt="" src="' + esc(cfg.logo_url) + '">' : esc(initial);
    var launch = el('button', 'launch', ICON_CHAT);
    launch.setAttribute('aria-label', 'Chat with ' + cfg.business_name);
    var panel = el('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Chat with ' + cfg.business_name);
    panel.innerHTML =
      '<div class="grab"></div>' +
      '<div class="top"><button class="back" aria-label="Close">' + ICON_BACK + '</button><button class="min" aria-label="Close">Minimize</button>' +
      '<div class="logo">' + logo + '</div>' +
      '<div class="name">' + esc(cfg.business_name) + '</div><button class="x" aria-label="Close">' + ICON_X + '</button></div>' +
      '<div class="log" aria-live="polite"></div>' +
      '<div class="foot"><button class="plus" aria-label="More" tabindex="-1">' + ICON_PLUS + '</button><div class="box"><textarea rows="1" placeholder="Write a message" aria-label="Message"></textarea>' +
      '<button class="send" aria-label="Send" disabled>' + ICON_UP + '</button></div></div>';
    z.appendChild(panel);
    z.appendChild(launch);

    var log = panel.querySelector('.log');
    var input = panel.querySelector('textarea');
    var send = panel.querySelector('.send');
    var busy = false;

    function add(role, text) {
      var m = el('div', 'm ' + role, format(text));
      m.dir = 'auto';
      if (role === 'a') {
        var row = el('div', 'row');
        row.appendChild(el('div', 'av', logo));
        row.appendChild(m);
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
        return m;
      }
      log.appendChild(m);
      log.scrollTop = log.scrollHeight;
      return m;
    }
    function render() {
      log.innerHTML = '';
      var msgs = state.messages || [];
      if (!msgs.length && (variant === 'studio' || variant === 'editorial')) {
        var h = el('div', 'hello', '<h2>' + esc(cfg.greeting || 'How can we help?') + '</h2>');
        h.dir = 'auto';
        log.appendChild(h);
      } else if (!msgs.length) {
        add('a', cfg.greeting || 'Hi! How can we help?');
      }
      msgs.forEach(function (m) { add(m.r, m.t); });
    }
    function setOpen(open) {
      z.classList.toggle('open', open);
      if (open) setTimeout(function () { input.focus(); }, 200);
    }
    function grow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      send.disabled = busy || !input.value.trim();
    }
    function session() {
      if (state.token) return Promise.resolve(state.token);
      return api('/api/session', {}).then(function (s) { state.token = s.session_token; save(state); return state.token; });
    }
    function submit() {
      var text = input.value.trim();
      if (!text || busy) return;
      if (!(state.messages || []).length) log.innerHTML = '';
      busy = true;
      input.value = '';
      grow();
      state.messages = (state.messages || []).concat({ r: 'u', t: text });
      save(state);
      add('u', text);
      var typing = add('a', '');
      typing.innerHTML = '<span class="dots"><i></i><i></i><i></i></span>';
      session()
        .then(function (token) {
          return api('/api/chat', { session_token: token, text: text, packet: { page: { url: location.href, title: document.title } } });
        })
        .then(function (r) { return r.reply_text || 'Sorry, something went wrong. Please try again.'; })
        .catch(function () { return 'Sorry, I could not connect. Please try again in a moment.'; })
        .then(function (reply) {
          (typing.parentNode.className === 'row' ? typing.parentNode : typing).remove();
          add('a', reply);
          state.messages = state.messages.concat({ r: 'a', t: reply }).slice(-60);
          save(state);
          busy = false;
          grow();
        });
    }

    launch.addEventListener('click', function () { setOpen(!z.classList.contains('open')); });
    [].forEach.call(panel.querySelectorAll('.x,.back,.min'), function (b) { b.addEventListener('click', function () { setOpen(false); }); });
    input.addEventListener('input', grow);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    });
    send.addEventListener('click', submit);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') setOpen(false); });

    render();
    if (script.getAttribute('data-open') === 'true') setOpen(true);
    window.ZeliksWidget = { open: function () { setOpen(true); }, close: function () { setOpen(false); } };
  }

  function boot() {
    api('/api/widget-config').then(start).catch(function (e) { console.warn('Zeliks widget:', e.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
