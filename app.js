/* HvH client - talks to the platform backend. Shared by the menu and the owner dashboard.
   The backend address is configurable because the game can be served from a static host
   (GitHub Pages) while the backend runs somewhere that can run Node. */
(function () {
  'use strict';
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  const qp = new URLSearchParams(location.search);
  if (qp.get('api')) LS.set('hvh_api', qp.get('api').replace(/\/+$/, ''));

  const API = {
    base: LS.get('hvh_api', '') || location.origin,
    token: LS.get('hvh_token', '') || '',
    user: null,
    setBase(u) { API.base = String(u || '').replace(/\/+$/, '') || location.origin; LS.set('hvh_api', API.base); },
    setToken(t) { API.token = t || ''; if (t) LS.set('hvh_token', t); else LS.del('hvh_token'); },

    async call(method, path, body) {
      const headers = {};
      if (body) headers['content-type'] = 'application/json';
      if (API.token) headers.authorization = 'Bearer ' + API.token;
      let r;
      try {
        r = await fetch(API.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        throw Object.assign(new Error('Cannot reach the game server'), { offline: true });
      }
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (!j) throw Object.assign(new Error('The server sent back something unreadable'), { status: r.status });
      if (!j.ok) throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status, field: j.field, body: j });
      return j;
    },
    get(p) { return API.call('GET', p); },
    post(p, b) { return API.call('POST', p, b || {}); },

    async refresh() {
      if (!API.token) { API.user = null; return null; }
      try { const me = await API.get('/api/me'); API.user = me.user; return me; }
      catch (e) { if (e.status === 401 || e.status === 403) { API.setToken(''); API.user = null; } throw e; }
    },
    logout() { const t = API.token; API.setToken(''); API.user = null; if (t) API.post('/api/logout').catch(() => {}); }
  };

  /* tiny DOM helpers */
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ago(ts) {
    if (!ts) return 'never';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const dt = ts => ts ? new Date(ts).toLocaleString() : '—';

  window.HvhApp = { API, LS, el, esc, ago, dt };
})();
