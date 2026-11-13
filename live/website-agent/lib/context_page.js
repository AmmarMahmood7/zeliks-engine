'use strict';
/*
 * The per-business context page: /context/<tenant_id>
 *
 * One plain page per business, served by the service itself. At the top,
 * the business's install snippet (with a copy button), so the owner sees
 * the tag and the context in one place. Below it, after the edit PIN is
 * entered: ONE textarea holding the business's whole context document
 * (its compiled facts plus the auto block read from its own website),
 * a Save button, and a button to re-read the website's facts.
 *
 * The widget key is embedded in the page (it is a public, domain-locked
 * key, printed in the install snippet anyway). Editing always needs the
 * PIN, which is never in the page.
 */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderContextPage({ tenantId, businessName, widgetKey, snippet }) {
  const name = esc(businessName || tenantId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name} — assistant context</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c1e21; background: #fff; }
  main { max-width: 720px; margin: 0 auto; padding: 28px 18px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 30px 0 8px; }
  p { font-size: 14.5px; line-height: 1.55; color: #44484d; margin: 0 0 10px; }
  label { display: block; font-size: 13.5px; font-weight: 600; margin: 16px 0 6px; }
  input[type="password"] { width: 100%; padding: 10px 12px; border: 1px solid #cfd2d6; border-radius: 8px; font-size: 15px; font-family: inherit; }
  textarea { width: 100%; min-height: 380px; padding: 12px; border: 1px solid #cfd2d6; border-radius: 8px; font-size: 13.5px; line-height: 1.55; font-family: ui-monospace, Menlo, Consolas, monospace; }
  code.snippet { display: block; background: #f6f6f5; border: 1px solid #e5e5e3; border-radius: 8px; padding: 12px; font-size: 12.5px; line-height: 1.5; overflow-x: auto; white-space: nowrap; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  button { background: #1c1e21; color: #fff; border: none; border-radius: 8px; padding: 10px 16px; font-size: 14.5px; cursor: pointer; font-family: inherit; }
  button.secondary { background: #fff; color: #1c1e21; border: 1px solid #cfd2d6; }
  button:disabled { opacity: .55; cursor: default; }
  #status { margin-top: 12px; font-size: 14.5px; min-height: 21px; }
  #status.ok { color: #22713a; }
  #status.err { color: #a02c22; }
  .hidden { display: none; }
</style>
</head>
<body>
<main>
  <h1>${name}</h1>
  <p>Your website assistant: the install tag and everything it knows, on one page.</p>

  <h2>Install tag</h2>
  <p>Paste this one tag into your website, just before the closing &lt;/body&gt; tag. That is the whole install.</p>
  <code class="snippet" id="snippet">${esc(snippet)}</code>
  <div class="row">
    <button type="button" class="secondary" id="copyBtn">Copy the tag</button>
  </div>

  <h2>What your assistant knows</h2>
  <p>
    The text below is the assistant's whole knowledge: your business facts,
    plus a section read automatically from your own website (marked AUTO).
    Edit anything, press Save, and the next chat answers from the new text
    straight away.
  </p>

  <label for="pin">Edit PIN</label>
  <input type="password" id="pin" autocomplete="off" placeholder="Your edit PIN">
  <div class="row">
    <button type="button" class="secondary" id="loadBtn">Load my context</button>
  </div>

  <div id="editor" class="hidden">
    <label for="ctx">Context</label>
    <textarea id="ctx" spellcheck="false"></textarea>
    <div class="row">
      <button type="button" id="saveBtn">Save context</button>
      <button type="button" class="secondary" id="autoBtn">Re-read facts from my website</button>
    </div>
  </div>
  <div id="status"></div>
</main>

<script>
  var BASE = location.pathname.split('/context/')[0] || '';
  var KEY = ${JSON.stringify(widgetKey)};
  var pinEl = document.getElementById('pin');
  var ctxEl = document.getElementById('ctx');
  var editorEl = document.getElementById('editor');
  var statusEl = document.getElementById('status');

  function status(msg, ok) {
    statusEl.textContent = msg || '';
    statusEl.className = ok === true ? 'ok' : ok === false ? 'err' : '';
  }
  function headers() {
    return { 'Content-Type': 'application/json', 'X-Widget-Key': KEY, 'X-Edit-Pin': pinEl.value.trim() };
  }
  function call(path, body) {
    return fetch(BASE + path, {
      method: body ? 'POST' : 'GET',
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { ok: r.ok, d: d };
      });
    });
  }
  function loadContext() {
    return call('/api/context').then(function (x) {
      if (!x.ok) { status((x.d && x.d.message) || 'Could not load the context. Check the PIN.', false); return false; }
      ctxEl.value = x.d.context_text || '';
      editorEl.classList.remove('hidden');
      return true;
    });
  }

  document.getElementById('copyBtn').addEventListener('click', function () {
    var text = document.getElementById('snippet').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { status('Tag copied.', true); });
    } else {
      var range = document.createRange();
      range.selectNodeContents(document.getElementById('snippet'));
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      status('Tag selected. Copy it with Ctrl+C (or Cmd+C).', true);
    }
  });

  document.getElementById('loadBtn').addEventListener('click', function () {
    if (!pinEl.value.trim()) { status('Enter the edit PIN first.', false); return; }
    status('Loading...');
    loadContext().then(function (ok) {
      if (ok) status('Loaded. This is exactly what your assistant works from.', true);
    }).catch(function () { status('Could not reach the assistant service.', false); });
  });

  document.getElementById('saveBtn').addEventListener('click', function () {
    if (!ctxEl.value.trim()) { status('The context is empty.', false); return; }
    status('Saving...');
    call('/api/context', { context_text: ctxEl.value }).then(function (x) {
      if (!x.ok) { status((x.d && x.d.message) || 'Save failed.', false); return; }
      status('Saved. Start a fresh chat and the assistant answers from this text now.', true);
    }).catch(function () { status('Could not reach the assistant service.', false); });
  });

  document.getElementById('autoBtn').addEventListener('click', function () {
    status('Reading your website...');
    call('/api/context/auto', {}).then(function (x) {
      if (!x.ok) { status((x.d && x.d.message) || 'Could not read the website.', false); return; }
      var pages = (x.d.pages_read || []).length;
      status('Read ' + pages + ' page(s) from ' + (x.d.site || 'your website') + '. Reloading the context...', true);
      loadContext();
    }).catch(function () { status('Could not reach the assistant service.', false); });
  });
</script>
</body>
</html>
`;
}

function renderNotFound(tenantId) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1c1e21;max-width:720px;margin:0 auto;padding:28px 18px} p{font-size:14.5px;line-height:1.55;color:#44484d}</style>
</head>
<body>
<h1 style="font-size:22px">No business at this address</h1>
<p>There is no assistant configured for &quot;${esc(tenantId)}&quot;. Check the address, or ask Zeliks for your context link.</p>
</body>
</html>
`;
}

module.exports = { renderContextPage, renderNotFound };
