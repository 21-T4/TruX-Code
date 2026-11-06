/* TruX-Code CLI page: the sidebar option opens a page where the person downloads the terminal tool, makes a login token
 * and sees how to use it. The token is created on the server (/api/cli/token), shown once, and only its hash is stored. */
(function () {
  'use strict';

  var page = null;
  var token = '';

  function $(id) { return document.getElementById(id); }
  function app() { return window.truxApp || {}; }
  function notify(m) { if (app().notify) app().notify(m); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function origin() { return window.location.origin; }

  function request(method, path) {
    return fetch(path, { method: method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: method === 'GET' ? undefined : '{}' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (!r.ok) throw new Error(d.error || 'The request failed (HTTP ' + r.status + ').');
          return d;
        });
      });
  }

  function copyText(text, btn) {
    var done = function () { btn.textContent = 'Copied'; btn.classList.add('done'); setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('done'); }, 1500); };
    var fallback = function () {
      var ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { notify('Copying was blocked by the browser.'); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }

  function codeBlock(text, extraClass) {
    var pre = el('pre', 'cli-code' + (extraClass ? ' ' + extraClass : ''));
    pre.appendChild(document.createTextNode(text));
    var b = el('button', 'cli-copy', 'Copy'); b.type = 'button';
    b.addEventListener('click', function () { copyText(text, b); });
    pre.appendChild(b);
    return pre;
  }

  function card(n, title, intro) {
    var c = el('section', 'cli-card');
    var h = el('h3'); h.appendChild(el('span', 'cli-n', String(n))); h.appendChild(document.createTextNode(title));
    c.appendChild(h);
    if (intro) c.appendChild(el('p', '', intro));
    return c;
  }

  function isPhoneOrTablet() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (/Mac/i.test(navigator.platform || '') && navigator.maxTouchPoints > 1) return true; // iPadOS
    return Boolean(window.matchMedia && window.matchMedia('(pointer: coarse) and (max-width: 900px)').matches);
  }

  var DL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14"/></svg>';

  function installCommands(os) {
    var url = origin() + '/downloads/trux-code.mjs';
    if (os === 'win') return ['mkdir $HOME\\.trux-code -Force | Out-Null', 'iwr ' + url + ' -OutFile $HOME\\.trux-code\\trux-code.mjs', 'node $HOME\\.trux-code\\trux-code.mjs'];
    return ['mkdir -p ~/.local/bin && curl -fsSL ' + url + ' -o ~/.local/bin/trux-code && chmod +x ~/.local/bin/trux-code', 'trux-code'];
  }

  function build() {
    var backdrop = el('div', 'modal-backdrop plugins-backdrop'); backdrop.id = 'cliModal'; backdrop.hidden = true;
    var sheet = el('section', 'plugins-page'); sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'cliTitle');
    var top = el('header', 'plugins-top');
    var close = el('button', 'icon-button'); close.type = 'button'; close.id = 'closeCli'; close.setAttribute('aria-label', 'Close'); close.title = 'Close';
    close.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>';
    var logo = el('img', 'cli-logo'); logo.alt = ''; logo.hidden = true; logo.decoding = 'async';
    logo.addEventListener('load', function () { logo.hidden = false; });
    logo.src = '/icons/trux-code-512.png';
    var head = el('div'); var h2 = el('h2', '', 'TruX-Code CLI'); h2.id = 'cliTitle';
    head.appendChild(h2);
    head.appendChild(el('p', '', 'An agentic coding tool for your terminal, powered by Vertex AI with Google web grounding. It reads and edits your code, runs commands and searches the web.'));
    top.appendChild(close); top.appendChild(logo); top.appendChild(head);
    var scroll = el('div', 'plugins-body'); var body = el('div', 'cli-body'); scroll.appendChild(body);
    sheet.appendChild(top); sheet.appendChild(scroll); backdrop.appendChild(sheet); document.body.appendChild(backdrop);

    // 1. Download
    var mobile = isPhoneOrTablet();
    var c1 = card(1, 'Download',
      mobile ? 'Tap Download to save the file to this device, then move it to your computer. It runs in a terminal with Node.js 18 or newer (check with node -v). You can also send the install command to your computer.'
        : 'One small file. Needs Node.js 18 or newer (check with node -v).');
    var row = el('div', 'cli-row');
    var dl = el('a', 'cli-primary'); dl.href = '/downloads/trux-code.mjs'; dl.setAttribute('download', 'trux-code.mjs'); dl.innerHTML = DL_ICON; dl.appendChild(document.createTextNode('Download trux-code'));
    row.appendChild(dl);
    if (mobile) {
      var cmdText = installCommands('mac').join('\n');
      var share = el('button', 'cli-secondary'); share.type = 'button';
      share.textContent = navigator.share ? 'Share install command' : 'Copy install command';
      share.addEventListener('click', function () {
        if (navigator.share) {
          navigator.share({ title: 'Install TruX-Code CLI', text: 'Install TruX-Code CLI (macOS/Linux):\n' + cmdText + '\n\nWindows and more: ' + origin() }).catch(function () { /* cancelled */ });
        } else copyText(cmdText, share);
      });
      row.appendChild(share);
    }
    if (window.truxInstall && !window.truxInstall.isInstalled()) {
      var inst = el('button', 'cli-secondary', 'Install TruX Code app'); inst.type = 'button';
      inst.addEventListener('click', function () { window.truxInstall.run(); });
      row.appendChild(inst);
    }
    c1.appendChild(row);
    c1.appendChild(el('p', 'cli-note', 'Or install from your terminal:'));
    var tabs = el('div', 'cli-tabs'); var cmds = el('div');
    function showOs(os) {
      Array.prototype.forEach.call(tabs.children, function (b) { b.classList.toggle('on', b.dataset.os === os); });
      cmds.innerHTML = '';
      installCommands(os).forEach(function (line) { cmds.appendChild(codeBlock(line)); });
    }
    [['mac', 'macOS / Linux'], ['win', 'Windows (PowerShell)']].forEach(function (o) {
      var b = el('button', '', o[1]); b.type = 'button'; b.dataset.os = o[0]; b.addEventListener('click', function () { showOs(o[0]); }); tabs.appendChild(b);
    });
    c1.appendChild(tabs); c1.appendChild(cmds);
    showOs(/Win/i.test(navigator.platform || '') ? 'win' : 'mac');
    body.appendChild(c1);

    // 2. Sign in
    var c2 = card(2, 'Sign in from the terminal', 'Generate a login token, then paste it after typing /login in the CLI. It is shown once and can be revoked any time.');
    var tokenHost = el('div'); var status = el('p', 'cli-note');
    var row2 = el('div', 'cli-row');
    var gen = el('button', 'cli-primary', 'Generate token'); gen.type = 'button'; gen.id = 'cliGenerate';
    var revoke = el('button', 'cli-link', 'Revoke all CLI logins'); revoke.type = 'button'; revoke.hidden = true;
    row2.appendChild(gen); row2.appendChild(revoke); c2.appendChild(row2); c2.appendChild(tokenHost); c2.appendChild(status);
    body.appendChild(c2);

    function refreshCount() {
      if (!app().isSignedIn || !app().isSignedIn()) { status.textContent = 'Sign in to TruX Code first.'; revoke.hidden = true; return; }
      request('GET', '/api/cli/token').then(function (d) {
        status.textContent = d.count ? d.count + ' CLI login' + (d.count === 1 ? ' is' : 's are') + ' active on your account.' : 'No CLI logins yet.';
        revoke.hidden = !d.count;
      }).catch(function () { status.textContent = ''; });
    }
    gen.addEventListener('click', function () {
      if (!app().isSignedIn || !app().isSignedIn()) { if (app().openSignIn) app().openSignIn(); return; }
      gen.disabled = true; tokenHost.innerHTML = '';
      request('POST', '/api/cli/token').then(function (d) {
        token = d.token;
        tokenHost.appendChild(codeBlock(token, 'cli-token'));
        tokenHost.appendChild(el('p', 'cli-note', 'Copy it now: it will not be shown again. Then run trux-code, type /login and paste it, or run:'));
        tokenHost.appendChild(codeBlock('trux-code login ' + token));
        refreshCount();
      }).catch(function (e) {
        var err = el('p', 'cli-error', e.message); tokenHost.appendChild(err);
      }).then(function () { gen.disabled = false; });
    });
    revoke.addEventListener('click', function () {
      if (!window.confirm('Sign out every terminal using a CLI token? They will need a new token.')) return;
      request('DELETE', '/api/cli/token').then(function () { tokenHost.innerHTML = ''; notify('All CLI logins were revoked.'); refreshCount(); }).catch(function (e) { notify(e.message); });
    });

    // 3. Use
    var c3 = card(3, 'Start coding', 'Open a terminal in your project folder and run trux-code. Just describe the task in plain words.');
    var term = el('div', 'cli-term');
    var logo = el('div', 'logo', '████████╗██████╗ ██╗   ██╗██╗  ██╗   ██████╗ ██████╗ ██████╗ ███████╗\n╚══██╔══╝██╔══██╗██║   ██║╚██╗██╔╝  ██╔════╝██╔═══██╗██╔══██╗██╔════╝\n   ██║   ██████╔╝██║   ██║ ╚███╔╝   ██║     ██║   ██║██║  ██║█████╗  \n   ██║   ██╔══██╗██║   ██║ ██╔██╗   ██║     ██║   ██║██║  ██║██╔══╝  \n   ██║   ██║  ██║╚██████╔╝██╔╝ ██╗  ╚██████╗╚██████╔╝██████╔╝███████╗\n   ╚═╝   ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝');
    term.appendChild(logo);
    term.appendChild(el('div', 'c', 'Agentic coding in your terminal · Vertex AI · Google web grounding'));
    var prompt = el('div', 'l'); var pm = el('span', 'p', '❯ '); prompt.appendChild(pm); prompt.appendChild(document.createTextNode('add input validation to the signup form and run the tests'));
    term.appendChild(prompt);
    c3.appendChild(term);
    var grid = el('div', 'cli-cmds');
    [['/help', 'All commands and tips'], ['/tools', 'Every tool the AI can use, and how'], ['/model', 'Switch Gemini model'], ['/plan', 'Research first, approve a plan, then edit'], ['/init', 'Write a TRUX.md for your project'], ['/compact', 'Free up context in long sessions']].forEach(function (x) {
      var d = el('div'); var code = el('code', '', x[0]); d.appendChild(code); d.appendChild(document.createTextNode('  ' + x[1])); grid.appendChild(d);
    });
    c3.appendChild(grid);
    c3.appendChild(el('p', 'cli-note', 'Tools include file read/write/edit, shell commands, glob and grep search, web search with Google grounding, web fetch, task lists, sub-agents and notebook editing. The first time you run it in a folder it asks permission to work there; it can only reach files inside that folder, and files are only changed after you approve them unless you choose auto-approve.'));
    body.appendChild(c3);

    function shut() { backdrop.hidden = true; document.documentElement.classList.remove('tx-cli-open'); token = ''; }
    close.addEventListener('click', shut);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !backdrop.hidden) shut(); });
    return { backdrop: backdrop, refresh: refreshCount, tokenHost: tokenHost };
  }

  function open() {
    if (!page) page = build();
    page.tokenHost.innerHTML = '';
    page.backdrop.hidden = false;
    page.refresh();
  }

  function boot() {
    var btn = $('openTruxCli');
    if (!btn) return;
    btn.addEventListener('click', open);
    var q = $('quickCli'); if (q) q.addEventListener('click', open);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}());
