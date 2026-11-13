/*
 * Zeliks website widget (v2).
 *
 * Installed with ONE tag:
 *   <script src="https://n8n.moodtech.cloud/zeliks-chat/widget.js"
 *           data-zeliks-key="wk_..." async></script>
 *
 * The look is deliberately plain: a round launcher with the business's
 * initial (or its logo), a tidy panel with the business name and an
 * "Online" line, the business's greeting, clean bubbles, a typing
 * indicator, and one input row. The business's colour comes from its
 * pack (widget.primary_color). Nothing else is decorated.
 *
 * The page may set window.ZELIKS_PACKET (an object, or a function
 * returning one) to tell the assistant what the visitor is looking at:
 *   { page: {url, title}, item: {kind, name, price, ...},
 *     cart: [items], visitor: {name} }
 * The packet is read fresh before every message, so cart / shortlist
 * changes are seen straight away. window.ZeliksWidget.open(), .close()
 * and .setPacket(obj) are also available to the page.
 *
 * Messages typed before the session is ready are QUEUED and sent, in
 * order, as soon as the session opens (v1 silently dropped them).
 */
(function () {
  'use strict';
  var script =
    document.currentScript ||
    document.querySelector('script[data-zeliks-key]');
  if (!script) return;
  var key = script.getAttribute('data-zeliks-key');
  if (!key) return;
  var base = script.src.replace(/\/widget\.js(\?.*)?$/, '');

  var state = {
    config: null,
    sessionToken: null,
    sessionPromise: null,
    sessionFailed: false,
    opened: false,
    handedOver: false,
    sending: false,
    queue: [],
    packetOverride: null,
  };

  function collectPacket() {
    var p = {};
    try {
      var src =
        typeof window.ZELIKS_PACKET === 'function'
          ? window.ZELIKS_PACKET()
          : window.ZELIKS_PACKET;
      if (src && typeof src === 'object') p = JSON.parse(JSON.stringify(src));
    } catch (e) {
      /* a broken page packet must never break the widget */
    }
    if (state.packetOverride) {
      for (var k in state.packetOverride) p[k] = state.packetOverride[k];
    }
    p.page = p.page || {};
    if (!p.page.url) p.page.url = window.location.href;
    if (!p.page.title) p.page.title = document.title;
    return p;
  }

  function api(path, body) {
    return fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Widget-Key': key,
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || 'request_failed');
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
    });
  }

  // ------------------------------------------------------------ UI shell
  var host = document.createElement('div');
  host.id = 'zeliks-widget-host';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '.zw-launcher{position:fixed;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.22);color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:0;overflow:hidden}' +
    '.zw-launcher .zw-initial{font-size:23px;font-weight:600;line-height:1}' +
    '.zw-launcher img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.zw-panel{position:fixed;bottom:88px;z-index:2147483000;width:370px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 116px);background:#fff;border:1px solid rgba(0,0,0,.09);border-radius:16px;box-shadow:0 16px 48px rgba(0,0,0,.20);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1e21}' +
    '.zw-panel.open{display:flex}' +
    '.zw-head{display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid #ececec;background:#fff}' +
    '.zw-avatar{width:38px;height:38px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:600;overflow:hidden}' +
    '.zw-avatar img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.zw-who{flex:1;min-width:0}' +
    '.zw-name{font-size:15px;font-weight:600;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.zw-status{font-size:12.5px;color:#71767c;line-height:1.3;display:flex;align-items:center;gap:5px}' +
    '.zw-dot{width:7px;height:7px;border-radius:50%;background:#2faf5e;flex:none}' +
    '.zw-close{border:none;background:none;color:#71767c;font-size:22px;line-height:1;cursor:pointer;padding:4px 6px;font-family:inherit}' +
    '.zw-msgs{flex:1;overflow-y:auto;padding:16px 14px;background:#fafafa;display:flex;flex-direction:column;gap:8px}' +
    '.zw-msg{max-width:82%;padding:9px 12px;border-radius:12px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word}' +
    '.zw-msg.them{background:#fff;border:1px solid #e8e8e8;align-self:flex-start;border-bottom-left-radius:4px}' +
    '.zw-msg.me{color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.zw-note{font-size:12.5px;color:#71767c;text-align:center;padding:2px 10px;line-height:1.45}' +
    '.zw-typing{display:flex;gap:4px;align-items:center;padding:12px}' +
    '.zw-typing i{width:7px;height:7px;border-radius:50%;background:#b9bdc2;display:block;animation:zwb 1.2s infinite}' +
    '.zw-typing i:nth-child(2){animation-delay:.15s}' +
    '.zw-typing i:nth-child(3){animation-delay:.3s}' +
    '@keyframes zwb{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-3px);opacity:1}}' +
    '.zw-form{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #ececec;background:#fff}' +
    '.zw-form input{flex:1;border:none;padding:9px 2px;font-size:14.5px;outline:none;font-family:inherit;color:inherit;background:none;min-width:0}' +
    '.zw-form input::placeholder{color:#9aa0a6}' +
    '.zw-send{width:36px;height:36px;border-radius:50%;border:none;color:#fff;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center;padding:0}' +
    '.zw-send svg{width:17px;height:17px;fill:#fff}' +
    '.zw-send:disabled,.zw-form input:disabled{opacity:.55;cursor:default}' +
    '@media (max-width:480px){.zw-panel{bottom:86px;height:68vh}}' +
    '</style>' +
    '<button class="zw-launcher" part="launcher" aria-label="Chat with us">' +
    '<span class="zw-initial"></span>' +
    '</button>' +
    '<div class="zw-panel" role="dialog" aria-label="Chat">' +
    '<div class="zw-head">' +
    '<div class="zw-avatar"><span class="zw-initial"></span></div>' +
    '<div class="zw-who"><div class="zw-name"></div>' +
    '<div class="zw-status"><span class="zw-dot"></span>Online</div></div>' +
    '<button class="zw-close" aria-label="Close chat">&times;</button>' +
    '</div>' +
    '<div class="zw-msgs"></div>' +
    '<form class="zw-form"><input type="text" autocomplete="off" placeholder="Type a message" aria-label="Your message">' +
    '<button class="zw-send" type="submit" aria-label="Send message">' +
    '<svg viewBox="0 0 24 24"><path d="M3.4 20.4l17.8-7.5c.8-.35.8-1.45 0-1.8L3.4 3.6c-.66-.29-1.39.2-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .72.73 1.2 1.39.91z"/></svg>' +
    '</button></form>' +
    '</div>';

  var launcher = root.querySelector('.zw-launcher');
  var panel = root.querySelector('.zw-panel');
  var avatar = root.querySelector('.zw-avatar');
  var nameEl = root.querySelector('.zw-name');
  var msgs = root.querySelector('.zw-msgs');
  var form = root.querySelector('.zw-form');
  var input = root.querySelector('.zw-form input');
  var sendBtn = root.querySelector('.zw-send');

  function setFace(el, cfg) {
    // Business face: its logo if it has one, else its initial letter.
    el.innerHTML = '';
    if (cfg.logo_url) {
      var img = document.createElement('img');
      img.src = cfg.logo_url;
      img.alt = '';
      img.addEventListener('error', function () {
        el.innerHTML = '';
        var s = document.createElement('span');
        s.className = 'zw-initial';
        s.textContent = initialOf(cfg);
        el.appendChild(s);
      });
      el.appendChild(img);
    } else {
      var s = document.createElement('span');
      s.className = 'zw-initial';
      s.textContent = initialOf(cfg);
      el.appendChild(s);
    }
  }
  function initialOf(cfg) {
    var n = (cfg.business_name || 'C').trim();
    return n ? n.charAt(0).toUpperCase() : 'C';
  }

  function applyConfig(cfg) {
    var color = cfg.primary_color || '#333333';
    var side = cfg.position === 'bottom-left' ? 'left' : 'right';
    launcher.style.background = color;
    launcher.style[side] = '20px';
    panel.style[side] = '12px';
    avatar.style.background = color;
    nameEl.textContent = cfg.business_name || 'Chat with us';
    sendBtn.style.background = color;
    setFace(launcher, cfg);
    setFace(avatar, cfg);
    root.querySelectorAll('.zw-msg.me').forEach(function (el) {
      el.style.background = color;
    });
  }

  function addMsg(text, who) {
    var el = document.createElement('div');
    el.className = 'zw-msg ' + who;
    el.textContent = text;
    if (who === 'me' && state.config) {
      el.style.background = state.config.primary_color || '#333';
    }
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }
  function addNote(text) {
    var el = document.createElement('div');
    el.className = 'zw-note';
    el.textContent = text;
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function showTyping() {
    var el = document.createElement('div');
    el.className = 'zw-msg them zw-typing';
    el.innerHTML = '<i></i><i></i><i></i>';
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
    return el;
  }

  // ------------------------------------------------------------ session

  function ensureSession() {
    if (state.sessionToken) return Promise.resolve();
    if (state.sessionPromise) return state.sessionPromise;
    state.sessionFailed = false;
    state.sessionPromise = api('/api/session', { packet: collectPacket() })
      .then(function (s) {
        state.sessionToken = s.session_token;
        state.sessionPromise = null;
        if (s.greeting) addMsg(s.greeting, 'them');
        if (s.handed_over) lockHandover();
      })
      .catch(function (err) {
        state.sessionPromise = null;
        state.sessionFailed = true;
        throw err;
      });
    return state.sessionPromise;
  }

  function lockHandover() {
    state.handedOver = true;
    state.queue.length = 0;
    input.disabled = true;
    sendBtn.disabled = true;
    input.placeholder = 'The owner will pick this up from here.';
  }

  // One message at a time, in the order they were typed. A message sent
  // before the session exists waits in the queue instead of vanishing.
  function pump() {
    if (state.sending || state.handedOver) return;
    var text = state.queue[0];
    if (text === undefined) return;
    if (!state.sessionToken) {
      ensureSession()
        .then(pump)
        .catch(function () {
          state.queue.length = 0;
          addNote('Sorry, the chat could not start. Please try again later.');
        });
      return;
    }
    state.queue.shift();
    state.sending = true;
    var typing = showTyping();
    api('/api/chat', {
      session_token: state.sessionToken,
      text: text,
      packet: collectPacket(),
    })
      .then(function (r) {
        typing.remove();
        if (r.reply_text) addMsg(r.reply_text, 'them');
        if (r.handed_over) {
          addNote('This conversation has been passed to the owner.');
          lockHandover();
        }
      })
      .catch(function () {
        typing.remove();
        addNote('Sorry, that message did not go through. Please try again.');
      })
      .then(function () {
        state.sending = false;
        pump();
      });
  }

  function openPanel() {
    panel.classList.add('open');
    if (!state.opened) {
      state.opened = true;
      ensureSession().catch(function () {
        addNote('Sorry, the chat could not start. Please try again later.');
      });
    }
    setTimeout(function () {
      input.focus();
    }, 60);
  }
  function closePanel() {
    panel.classList.remove('open');
  }

  launcher.addEventListener('click', function () {
    if (panel.classList.contains('open')) closePanel();
    else openPanel();
  });
  root
    .querySelector('.zw-close')
    .addEventListener('click', closePanel);
  panel.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closePanel();
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var text = input.value.trim();
    if (!text || state.handedOver) return;
    input.value = '';
    addMsg(text, 'me');
    state.queue.push(text);
    pump();
  });

  window.ZeliksWidget = {
    open: openPanel,
    close: closePanel,
    setPacket: function (obj) {
      state.packetOverride = obj || null;
    },
  };

  function mount() {
    document.body.appendChild(host);
    api('/api/widget-config')
      .then(function (cfg) {
        state.config = cfg;
        applyConfig(cfg);
      })
      .catch(function () {
        /* Not allowed on this domain, or the service is down:
           stay invisible rather than showing a broken widget. */
        host.remove();
        delete window.ZeliksWidget;
      });
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
