/* RYLI support chat widget — a self-contained help bubble.
 *
 * Loaded on every page (injected by script.js as its own file, so a bug in here
 * can never break the rest of the site's JS). Talks to two same-origin
 * endpoints on the ryli.app Worker:
 *   POST /api/support-chat     { messages:[{role,content}] } -> { reply }
 *   POST /api/support-contact  { name,email,message,page,transcript } -> { ok }
 *
 * No dependencies, no third-party scripts, no tracking. The chat is kept in
 * sessionStorage so it survives page navigation within a visit.
 */
(function () {
  'use strict';
  if (window.__ryliHelpMounted) return;
  window.__ryliHelpMounted = true;

  var GREETING = "Hi! I'm the RYLI assistant. Ask me about setup, OBS, pricing, "
    + "Breaker Tools, the label printer, or anything else — and if I can't help, "
    + "I'll pass you to a human.";

  // ---- state ----------------------------------------------------------------
  var messages = [];       // {role:'user'|'assistant', content}
  var open = false;
  var busy = false;
  var formShown = false;

  try {
    var saved = sessionStorage.getItem('ryliHelpMsgs');
    if (saved) messages = JSON.parse(saved) || [];
  } catch (e) { messages = []; }
  function persist() { try { sessionStorage.setItem('ryliHelpMsgs', JSON.stringify(messages.slice(-30))); } catch (e) {} }

  // ---- styles ---------------------------------------------------------------
  var css = ''
    + '.ryh-btn{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border:none;border-radius:50%;'
    + 'background:linear-gradient(135deg,#6AAEFF,#B388FF);box-shadow:0 12px 30px rgba(0,0,0,.4),0 0 0 1px rgba(106,174,255,.25);'
    + 'cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform .18s cubic-bezier(.22,1,.36,1),box-shadow .18s;}'
    + '.ryh-btn:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 16px 40px rgba(0,0,0,.5),0 0 0 1px rgba(179,136,255,.4);}'
    + '.ryh-btn:focus-visible{outline:3px solid rgba(125,231,255,.7);outline-offset:2px;}'
    + '.ryh-btn svg{width:26px;height:26px;fill:#0d1117;}'
    + '.ryh-btn .ryh-x{display:none;}'
    + '.ryh-open .ryh-chat{display:none;} .ryh-open .ryh-x{display:block;}'
    + '.ryh-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);'
    + 'background:#0d1117;border:1px solid rgba(242,246,255,.12);border-radius:18px;box-shadow:0 30px 70px rgba(0,0,0,.6);'
    + 'display:none;flex-direction:column;overflow:hidden;font-family:"Inter",system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:rgba(242,246,255,.92);'
    + 'opacity:0;transform:translateY(10px);transition:opacity .2s ease,transform .2s cubic-bezier(.22,1,.36,1);}'
    + '.ryh-panel.ryh-show{display:flex;opacity:1;transform:none;}'
    + '.ryh-head{padding:14px 16px;background:linear-gradient(135deg,rgba(106,174,255,.16),rgba(179,136,255,.10));border-bottom:1px solid rgba(242,246,255,.1);display:flex;align-items:center;gap:10px;}'
    + '.ryh-head .ryh-dot{width:9px;height:9px;border-radius:50%;background:#5ee38a;box-shadow:0 0 8px #5ee38a;flex:0 0 auto;}'
    + '.ryh-head h3{margin:0;font-size:15px;font-weight:700;letter-spacing:.01em;}'
    + '.ryh-head p{margin:1px 0 0;font-size:11px;color:rgba(242,246,255,.55);}'
    + '.ryh-head .ryh-close{margin-left:auto;background:none;border:none;color:rgba(242,246,255,.6);font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:8px;}'
    + '.ryh-head .ryh-close:hover{color:#fff;background:rgba(255,255,255,.08);}'
    + '.ryh-body{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;}'
    + '.ryh-msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:13.5px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;}'
    + '.ryh-bot{align-self:flex-start;background:#1a2230;border:1px solid rgba(242,246,255,.08);border-bottom-left-radius:5px;}'
    + '.ryh-user{align-self:flex-end;background:linear-gradient(135deg,#6AAEFF,#B388FF);color:#0d1117;font-weight:500;border-bottom-right-radius:5px;}'
    + '.ryh-typing{align-self:flex-start;color:rgba(242,246,255,.5);font-size:13px;padding:4px 6px;}'
    + '.ryh-typing span{display:inline-block;width:6px;height:6px;margin:0 1px;border-radius:50%;background:rgba(242,246,255,.5);animation:ryhb 1s infinite;}'
    + '.ryh-typing span:nth-child(2){animation-delay:.15s;} .ryh-typing span:nth-child(3){animation-delay:.3s;}'
    + '@keyframes ryhb{0%,60%,100%{opacity:.25;transform:translateY(0);}30%{opacity:1;transform:translateY(-3px);}}'
    + '.ryh-foot{border-top:1px solid rgba(242,246,255,.1);padding:10px;display:flex;gap:8px;align-items:flex-end;}'
    + '.ryh-foot textarea{flex:1;resize:none;background:#131a24;border:1px solid rgba(242,246,255,.12);border-radius:12px;color:#fff;'
    + 'font-family:inherit;font-size:13.5px;padding:9px 11px;max-height:110px;line-height:1.4;}'
    + '.ryh-foot textarea:focus{outline:none;border-color:rgba(106,174,255,.6);}'
    + '.ryh-send{flex:0 0 auto;width:38px;height:38px;border:none;border-radius:10px;background:linear-gradient(135deg,#6AAEFF,#B388FF);cursor:pointer;display:flex;align-items:center;justify-content:center;}'
    + '.ryh-send:disabled{opacity:.5;cursor:default;} .ryh-send svg{width:18px;height:18px;fill:#0d1117;}'
    + '.ryh-human{text-align:center;padding:2px 0 6px;} .ryh-human button{background:none;border:none;color:#7DE7FF;font-size:12px;cursor:pointer;text-decoration:underline;font-family:inherit;}'
    + '.ryh-human button:hover{color:#B388FF;}'
    + '.ryh-form{background:#131a24;border:1px solid rgba(242,246,255,.1);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:8px;}'
    + '.ryh-form h4{margin:0 0 2px;font-size:13.5px;} .ryh-form p{margin:0 0 4px;font-size:12px;color:rgba(242,246,255,.6);}'
    + '.ryh-form input,.ryh-form textarea{background:#0d1117;border:1px solid rgba(242,246,255,.14);border-radius:10px;color:#fff;font-family:inherit;font-size:13px;padding:8px 10px;}'
    + '.ryh-form input:focus,.ryh-form textarea:focus{outline:none;border-color:rgba(106,174,255,.6);} .ryh-form textarea{resize:vertical;min-height:60px;}'
    + '.ryh-form .ryh-submit{background:linear-gradient(135deg,#6AAEFF,#B388FF);color:#0d1117;font-weight:700;border:none;border-radius:10px;padding:9px;cursor:pointer;font-family:inherit;font-size:13.5px;}'
    + '.ryh-form .ryh-submit:disabled{opacity:.5;cursor:default;}'
    + '.ryh-err{color:#ff9aa8;font-size:12px;} .ryh-cancel{background:none;border:none;color:rgba(242,246,255,.5);font-size:12px;cursor:pointer;font-family:inherit;}'
    + '@media (prefers-reduced-motion:reduce){.ryh-btn,.ryh-panel,.ryh-typing span{transition:none!important;animation:none!important;}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---- DOM ------------------------------------------------------------------
  var btn = document.createElement('button');
  btn.className = 'ryh-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Open RYLI help chat');
  btn.innerHTML = '<svg class="ryh-chat" viewBox="0 0 24 24"><path d="M12 3C6.5 3 2 6.7 2 11.3c0 2.2 1 4.2 2.7 5.7-.1 1.2-.6 2.6-1.5 3.7-.2.3 0 .7.4.6 1.9-.4 3.4-1.1 4.4-1.8 1.1.3 2.3.5 3.6.5 5.5 0 10-3.7 10-8.3S17.5 3 12 3z"/></svg>'
    + '<svg class="ryh-x" viewBox="0 0 24 24"><path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 6.3 17.7 4.9 16.3 9.2 12 4.9 7.7 6.3 6.3l4.3 4.3L16.9 4.3z"/></svg>';

  var panel = document.createElement('div');
  panel.className = 'ryh-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'RYLI help chat');
  panel.innerHTML = ''
    + '<div class="ryh-head"><span class="ryh-dot"></span><div><h3>RYLI Help</h3><p>Answers in seconds &middot; usually</p></div>'
    + '<button class="ryh-close" type="button" aria-label="Close help chat">&times;</button></div>'
    + '<div class="ryh-body" id="ryh-body"></div>'
    + '<div class="ryh-human"><button type="button" id="ryh-human">Talk to a human instead &rarr;</button></div>'
    + '<div class="ryh-foot"><textarea id="ryh-input" rows="1" placeholder="Ask a question…" aria-label="Type your question"></textarea>'
    + '<button class="ryh-send" id="ryh-send" type="button" aria-label="Send"><svg viewBox="0 0 24 24"><path d="M3 11l18-8-8 18-2.5-7.5L3 11z"/></svg></button></div>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var bodyEl = panel.querySelector('#ryh-body');
  var inputEl = panel.querySelector('#ryh-input');
  var sendEl = panel.querySelector('#ryh-send');

  // ---- render ---------------------------------------------------------------
  function scrollBottom() { bodyEl.scrollTop = bodyEl.scrollHeight; }

  function addBubble(role, text) {
    var d = document.createElement('div');
    d.className = 'ryh-msg ' + (role === 'user' ? 'ryh-user' : 'ryh-bot');
    d.textContent = text;
    bodyEl.appendChild(d);
    scrollBottom();
    return d;
  }

  function renderAll() {
    bodyEl.innerHTML = '';
    addBubble('assistant', GREETING);
    messages.forEach(function (m) { addBubble(m.role, m.content); });
  }

  var typingEl = null;
  function showTyping() {
    typingEl = document.createElement('div');
    typingEl.className = 'ryh-typing';
    typingEl.innerHTML = '<span></span><span></span><span></span>';
    bodyEl.appendChild(typingEl);
    scrollBottom();
  }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  // ---- send chat ------------------------------------------------------------
  function send() {
    var text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    messages.push({ role: 'user', content: text });
    addBubble('user', text);
    persist();
    ask();
  }

  function ask() {
    busy = true; sendEl.disabled = true;
    showTyping();
    fetch('/api/support-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: messages.slice(-12) }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        hideTyping();
        var reply = (data && data.reply) ? String(data.reply)
          : "I'm not sure about that one — want to leave your email so a human can help?";
        messages.push({ role: 'assistant', content: reply });
        addBubble('assistant', reply);
        persist();
      })
      .catch(function () {
        hideTyping();
        var msg = "I couldn't reach the assistant just now. You can leave your email below and we'll get back to you, or email hello@ryliapp.com.";
        addBubble('assistant', msg);
        showForm();
      })
      .finally(function () { busy = false; sendEl.disabled = false; inputEl.focus(); });
  }

  // ---- human handoff form ---------------------------------------------------
  function transcriptText() {
    return messages.map(function (m) { return (m.role === 'user' ? 'You: ' : 'RYLI: ') + m.content; }).join('\n');
  }

  function showForm() {
    if (formShown) { bodyEl.querySelector('.ryh-form') && scrollBottom(); return; }
    formShown = true;
    var lastQ = '';
    for (var i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'user') { lastQ = messages[i].content; break; } }
    var wrap = document.createElement('div');
    wrap.className = 'ryh-msg ryh-bot';
    wrap.style.maxWidth = '100%';
    wrap.style.background = 'transparent';
    wrap.style.border = 'none';
    wrap.style.padding = '0';
    wrap.innerHTML = ''
      + '<form class="ryh-form">'
      + '<h4>Message the RYLI team</h4>'
      + '<p>Leave your email and a note — it goes straight to hello@ryliapp.com.</p>'
      + '<input type="text" name="name" placeholder="Your name (optional)" autocomplete="name">'
      + '<input type="email" name="email" placeholder="you@email.com" autocomplete="email" required>'
      + '<textarea name="message" placeholder="How can we help?"></textarea>'
      + '<div class="ryh-err" hidden></div>'
      + '<button type="submit" class="ryh-submit">Send to RYLI</button>'
      + '<button type="button" class="ryh-cancel">Never mind, keep chatting</button>'
      + '</form>';
    bodyEl.appendChild(wrap);
    scrollBottom();

    var form = wrap.querySelector('form');
    var errEl = wrap.querySelector('.ryh-err');
    if (lastQ) form.message.value = lastQ;
    form.querySelector('input[name=email]').focus();

    form.querySelector('.ryh-cancel').addEventListener('click', function () {
      wrap.remove(); formShown = false; inputEl.focus();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = form.email.value.trim();
      var message = form.message.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.hidden = false; errEl.textContent = 'Please enter a valid email.'; return; }
      if (message.length < 2) { errEl.hidden = false; errEl.textContent = 'Add a short message so we know how to help.'; return; }
      errEl.hidden = true;
      var submitBtn = form.querySelector('.ryh-submit');
      submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
      fetch('/api/support-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.value.trim(), email: email, message: message,
          page: location.pathname, transcript: transcriptText(),
        }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.ok) {
            wrap.remove(); formShown = false;
            addBubble('assistant', "Got it — thanks! We'll reply to " + email + " as soon as we can.");
          } else {
            throw new Error('failed');
          }
        })
        .catch(function () {
          submitBtn.disabled = false; submitBtn.textContent = 'Send to RYLI';
          errEl.hidden = false; errEl.textContent = "Couldn't send just now — please email hello@ryliapp.com directly.";
        });
    });
  }

  // ---- open/close -----------------------------------------------------------
  function setOpen(v) {
    open = v;
    btn.classList.toggle('ryh-open', v);
    btn.setAttribute('aria-label', v ? 'Close RYLI help chat' : 'Open RYLI help chat');
    if (v) {
      panel.classList.add('ryh-show');
      if (!bodyEl.childElementCount) renderAll();
      setTimeout(function () { inputEl.focus(); }, 60);
    } else {
      panel.classList.remove('ryh-show');
    }
  }

  btn.addEventListener('click', function () { setOpen(!open); });
  panel.querySelector('.ryh-close').addEventListener('click', function () { setOpen(false); btn.focus(); });
  panel.querySelector('#ryh-human').addEventListener('click', function () { showForm(); });
  sendEl.addEventListener('click', send);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 110) + 'px';
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && open) { setOpen(false); btn.focus(); } });
})();
