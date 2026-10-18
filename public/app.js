/* Weather Center — the console. Vanilla JS, one file. Talks only to this
   server's /api (bearer token kept in localStorage); the map library
   (Leaflet) and tiles come from their CDNs when the MAP views open. */
(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────
  const S = {
    token: localStorage.getItem('wc_token') || '',
    units: localStorage.getItem('wc_units') || 'us',       // us | metric
    view: location.hash.replace('#', '') || 'now',
    loc: JSON.parse(localStorage.getItem('wc_loc') || 'null'),   // {lat, lon, label}
    summary: null, timers: {}, map: null, mini: null, leaflet: null,
  };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
  const fmt = {
    t: (f) => f == null ? '—' : S.units === 'us' ? `${Math.round(f)}°F` : `${Math.round((f - 32) * 5 / 9)}°C`,
    tc: (c) => c == null ? '—' : S.units === 'us' ? `${Math.round(c * 9 / 5 + 32)}°F` : `${Math.round(c)}°C`,
    w: (mph) => mph == null ? '—' : S.units === 'us' ? `${Math.round(mph)} mph` : `${Math.round(mph * 1.609)} km/h`,
    wk: (kmh) => kmh == null ? '—' : S.units === 'us' ? `${Math.round(kmh * 0.621)} mph` : `${Math.round(kmh)} km/h`,
    in: (i) => i == null ? '—' : S.units === 'us' ? `${(+i).toFixed(2)} in` : `${(i * 25.4).toFixed(1)} mm`,
    km: (k) => k == null ? '—' : S.units === 'us' ? `${Math.round(k * 0.621)} mi` : `${Math.round(k)} km`,
    time: iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); },
    clock: iso => { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); },
    day: iso => { const d = new Date(iso + (iso.length === 10 ? 'T12:00:00' : '')); return isNaN(d) ? iso : d.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' }); },
    ago: iso => { if (!iso) return '—'; const s = (Date.now() - Date.parse(iso)) / 1000; if (s < 90) return `${Math.round(s)}s ago`; if (s < 5400) return `${Math.round(s / 60)}m ago`; if (s < 172800) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`; },
    until: iso => { if (!iso) return ''; const s = (Date.parse(iso) - Date.now()) / 1000; if (s < 0) return 'expired'; if (s < 3600) return `${Math.round(s / 60)}m left`; if (s < 86400) return `${(s / 3600).toFixed(1)}h left`; return `${Math.round(s / 86400)}d left`; },
    n: v => v == null ? '—' : v,
    pct: v => v == null ? '—' : `${Math.round(v)}%`,
  };
  const toast = msg => { const t = el(`<div class="toast">${esc(msg)}</div>`); document.body.appendChild(t); setTimeout(() => t.remove(), 2600); };
  const copy = async text => { try { await navigator.clipboard.writeText(text); toast('copied'); } catch { toast('copy failed — select the text'); } };

  // ─── API ───────────────────────────────────────────────────────────
  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { Authorization: `Bearer ${S.token}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
    if (r.status === 401 || r.status === 503) { if (r.status === 401) { showAuth(r.status === 401 ? 'token rejected' : ''); } }
    let body; try { body = await r.json(); } catch { body = { error: await r.text() }; }
    dot('api', r.status < 500 ? 'ok' : 'bad');
    if (!r.ok) { const e = new Error(body.error || `HTTP ${r.status}`); e.status = r.status; e.body = body; throw e; }
    return body;
  }
  const dot = (id, state) => { const d = $(`#dot-${id}`); if (d) d.className = `dot ${state}`; };

  // ─── Auth wall ─────────────────────────────────────────────────────
  function showAuth(msg) {
    $('#auth-wall').classList.remove('hidden'); $('#main').classList.add('hidden');
    $('#token-msg').textContent = msg || '';
  }
  $('#token-save').onclick = async () => {
    const t = $('#token-input').value.trim(); if (!t) return;
    S.token = t; localStorage.setItem('wc_token', t);
    try { await api('/api/status'); $('#auth-wall').classList.add('hidden'); $('#main').classList.remove('hidden'); boot(); }
    catch (e) { $('#token-msg').textContent = e.status === 401 ? 'token rejected' : e.message; }
  };
  $('#token-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#token-save').click(); });

  // ─── Frame: clock, tabs, units, theme, quick search ─────────────────
  setInterval(() => { $('#clock').textContent = `${new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ${new Date().toISOString().slice(11, 16)}Z`; }, 1000);
  $$('#tabs button').forEach(b => { b.onclick = () => show(b.dataset.view); });
  function show(view) {
    S.view = view; location.hash = view;
    $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    $$('.view').forEach(v => v.classList.toggle('on', v.id === `view-${view}`));
    render(view);
  }
  const unitsLabel = () => { $('#units-btn').textContent = S.units === 'us' ? '°F · mph' : '°C · km/h'; };
  $('#units-btn').onclick = () => { S.units = S.units === 'us' ? 'metric' : 'us'; localStorage.setItem('wc_units', S.units); unitsLabel(); render(S.view); };
  $('#theme-btn').onclick = () => { const cur = document.documentElement.getAttribute('data-theme'); const next = cur === 'light' ? 'dark' : 'light'; document.documentElement.setAttribute('data-theme', next); localStorage.setItem('wc_theme', next); };
  $('#quick-go').onclick = () => goForecast($('#quick').value.trim());
  $('#quick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#quick-go').click(); });
  async function goForecast(q) {
    if (!q) return;
    try {
      const g = await api(`/api/geocode?q=${encodeURIComponent(q)}&count=1`);
      if (!g.results.length) return toast(`no place found for "${q}"`);
      setLoc(g.results[0]); show('forecast');
    } catch (e) { toast(e.message); }
  }
  function setLoc(p) { S.loc = { lat: p.lat, lon: p.lon, label: p.label || p.name || `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}` }; localStorage.setItem('wc_loc', JSON.stringify(S.loc)); }

  // ─── Drawer ────────────────────────────────────────────────────────
  const drawer = $('#drawer');
  $('#drawer-close').onclick = () => drawer.classList.remove('open');
  document.addEventListener('keydown', e => { if (e.key === 'Escape') drawer.classList.remove('open'); });
  function openDrawer(html) { $('#drawer-body').innerHTML = html; drawer.classList.add('open'); drawer.scrollTop = 0; }
  async function openAlert(id) {
    openDrawer('<p class="dim">loading…</p>');
    try {
      const a = await api(`/api/alerts/one?id=${encodeURIComponent(id)}`);
      openDrawer(`
        <h3><span class="badge fill" style="background:${esc(a.color)}">${esc(a.event)}</span></h3>
        <div class="dim small">${esc(a.headline || '')}</div>
        <div class="kv">
          <span class="k">area</span><span>${esc(a.area)}</span>
          <span class="k">severity</span><span><span class="badge sev-${esc(a.severity)}">${esc(a.severity)}</span> ${esc(a.urgency)} · ${esc(a.certainty)}</span>
          <span class="k">issued</span><span>${fmt.time(a.sent)} by ${esc(a.sender || '')}</span>
          <span class="k">expires</span><span>${fmt.time(a.expires)} <span class="dim">(${fmt.until(a.expires)})</span>${a.ends && a.ends !== a.expires ? ` · ends ${fmt.time(a.ends)}` : ''}</span>
          ${a.tornado_detection ? `<span class="k">tornado</span><span><b style="color:var(--tornado)">${esc(a.tornado_detection)}</b>${a.tornado_damage_threat ? ` · ${esc(a.tornado_damage_threat)} damage threat` : ''}</span>` : ''}
          ${a.max_wind_gust || a.max_hail_size ? `<span class="k">hazards</span><span>${a.max_wind_gust ? `wind ${esc(a.max_wind_gust)} ` : ''}${a.max_hail_size ? `hail ${esc(a.max_hail_size)} in` : ''}</span>` : ''}
          ${a.vtec ? `<span class="k">VTEC</span><span class="small">${esc(a.vtec)}</span>` : ''}
          <span class="k">states</span><span>${esc(a.states.join(', '))}</span>
        </div>
        <div class="toolbar"><button class="small" id="dr-copy">copy for article</button>${a.centroid ? `<button class="small" id="dr-map">show on map</button><button class="small" id="dr-fc">forecast there</button>` : ''}</div>
        <pre>${esc(a.description)}</pre>
        ${a.instruction ? `<div class="tiny">instructions</div><pre>${esc(a.instruction)}</pre>` : ''}`);
      $('#dr-copy').onclick = () => copy(`${a.event} — ${a.area}\n${a.headline || ''}\nIssued ${a.sent} by ${a.sender}; expires ${a.expires}.\n\n${a.description}\n\n${a.instruction || ''}`.trim());
      if (a.centroid) {
        $('#dr-map').onclick = () => { show('map'); mapReady().then(() => S.map.map.setView([a.centroid.lat, a.centroid.lon], 8)); drawer.classList.remove('open'); };
        $('#dr-fc').onclick = () => { setLoc({ lat: a.centroid.lat, lon: a.centroid.lon, label: a.area.split(';')[0] }); show('forecast'); drawer.classList.remove('open'); };
      }
    } catch (e) { openDrawer(`<p class="err">${esc(e.message)}</p>`); }
  }

  // ─── Shared fragments ──────────────────────────────────────────────
  const alertRow = a => `<div class="row" data-alert="${esc(a.id)}"><span class="sw" style="background:${esc(a.color)}"></span><div class="body"><div class="t">${esc(a.event)}${a.tornado_detection ? ` <span class="badge bad">${esc(a.tornado_detection)}</span>` : ''}${a.event_key && /Emergency/.test(a.event_key) ? ' <span class="badge sev-Extreme">EMERGENCY</span>' : ''}</div><div class="m">${esc(a.area)}</div><div class="m"><span class="badge sev-${esc(a.severity)}">${esc(a.severity)}</span>${esc(a.office || a.sender || '')} · ${fmt.until(a.expires)}</div></div></div>`;
  const bindAlertRows = root => $$('[data-alert]', root).forEach(r => { r.onclick = () => openAlert(r.dataset.alert); });
  const stamp = (d) => `<span class="stamp ${d && d.stale ? 'stale' : 'dim'}">${d && d.stale ? '⚠ stale · ' : ''}${d && d.fetched_at ? fmt.ago(d.fetched_at) : ''}</span>`;
  const errCard = (title, e) => `<div class="card"><h2>${esc(title)}</h2><div class="err">${esc(e.message || e)}</div>${e && e.stack ? `<pre class="dim small" style="white-space:pre-wrap">${esc(String(e.stack).split('\n').slice(0, 4).join('\n'))}</pre>` : ''}<button class="small" onclick="location.reload()">reload</button></div>`;

  // ─── Boot + header refresh ─────────────────────────────────────────
  async function boot() {
    unitsLabel();
    await refreshHeader();
    show(S.view);
    clearInterval(S.timers.header); S.timers.header = setInterval(refreshHeader, 60 * 1000);
    clearInterval(S.timers.view); S.timers.view = setInterval(() => render(S.view, true), 120 * 1000);
  }
  async function refreshHeader() {
    try {
      const [sum, trop, status] = await Promise.all([api('/api/alerts/summary'), api('/api/tropical').catch(() => null), api('/api/status').catch(() => null)]);
      S.summary = sum;
      dot('nws', sum.stale ? 'warn' : 'ok');
      if (status) dot('newsroom', !status.newsroom.configured ? '' : status.newsroom.health && status.newsroom.health.ok ? 'ok' : 'bad');
      $('#n-alerts').textContent = sum.total;
      $('#tab-alerts').classList.toggle('alert', sum.tornado_warnings > 0 || sum.tornado_emergencies > 0 || sum.flash_flood_emergencies > 0);
      $('#n-severe').textContent = (sum.by_event.find(e => e.event === 'Tornado Warning') || {}).count || 0;
      $('#n-tropical').textContent = trop ? trop.count : '–';
      const items = [];
      if (sum.tornado_warnings) items.push(`<b style="color:var(--tornado)">${sum.tornado_warnings} TORNADO WARNING${sum.tornado_warnings > 1 ? 'S' : ''}</b>`);
      for (const u of sum.urgent.slice(0, 14)) items.push(`<b>${esc(u.event)}</b> ${esc(u.area.split(';')[0])} <span class="dim">${fmt.until(u.expires)}</span>`);
      if (trop && trop.storms.length) for (const s of trop.storms) items.push(`<b>${esc(s.classification || '')} ${esc(s.name)}</b> ${s.category ? esc(s.category.label) : ''} ${fmt.n(s.wind_mph)} mph → ${esc(s.movement.compass || '')}`);
      for (const e of sum.by_event.slice(0, 12)) items.push(`${esc(e.event)} <span class="dim">×${e.count}</span>`);
      $('#ticker').innerHTML = items.map(i => `<span class="item">${i}</span>`).join('') || '<span class="item dim">no active alerts</span>';
    } catch (e) { dot('nws', 'bad'); }
  }

  // ─── Views ─────────────────────────────────────────────────────────
  const views = {};
  function render(view, quiet) {
    const fn = views[view]; if (!fn) return;
    const root = $(`#view-${view}`);
    if (root && !root.children.length && view !== 'map') root.innerHTML = '<div class="card"><div class="empty">loading ' + esc(view) + '…</div></div>';
    fn(quiet).catch(e => { if (!quiet) root.innerHTML = errCard(view, e); });
  }

  // NOW
  views.now = async () => {
    const root = $('#view-now');
    if (!root.children.length) root.innerHTML = '<p class="dim">loading…</p>';
    const [sum, board, trop, spc1, space, events] = await Promise.all([
      S.summary || api('/api/alerts/summary'), api('/api/watch/board'), api('/api/tropical').catch(() => null), api('/api/spc/outlook?day=1').catch(() => null), api('/api/space').catch(() => null), api('/api/events').catch(() => ({ events: [] })),
    ]);
    const count = ev => (sum.by_event.find(e => e.event === ev) || {}).count || 0;
    root.innerHTML = `
      <div class="tiles">
        <div class="tile ${sum.tornado_warnings ? 'hot' : ''}"><div class="k">Tornado warnings</div><div class="v">${sum.tornado_warnings}</div><div class="s">${sum.tornado_emergencies ? `<b style="color:var(--tornado)">${sum.tornado_emergencies} EMERGENCY</b>` : (count('Tornado Watch') ? `${count('Tornado Watch')} watch` : 'none')}</div></div>
        <div class="tile ${count('Severe Thunderstorm Warning') ? 'warm' : ''}"><div class="k">Severe t-storm warnings</div><div class="v">${count('Severe Thunderstorm Warning')}</div><div class="s">${count('Severe Thunderstorm Watch')} watch</div></div>
        <div class="tile ${count('Flash Flood Warning') + sum.flash_flood_emergencies ? 'warm' : ''}"><div class="k">Flash flood warnings</div><div class="v">${count('Flash Flood Warning') + sum.flash_flood_emergencies}</div><div class="s">${sum.flash_flood_emergencies ? `<b style="color:var(--tornado)">${sum.flash_flood_emergencies} EMERGENCY</b>` : `${count('Flood Warning')} river flood`}</div></div>
        <div class="tile cool"><div class="k">All active alerts</div><div class="v">${sum.total}</div><div class="s">${sum.warnings} warnings · ${sum.watches} watches · ${sum.advisories} advisories</div></div>
        <div class="tile ${trop && trop.storms.some(s => s.category && s.category.n >= 1) ? 'hot' : trop && trop.count ? 'warm' : ''}"><div class="k">Tropical systems</div><div class="v">${trop ? trop.count : '—'}</div><div class="s">${trop && trop.storms.length ? trop.storms.map(s => esc(s.name)).join(', ') : 'basins quiet'}</div></div>
        <div class="tile" style="${spc1 && spc1.max_category ? `border-color:${spcColor(spc1.max_category)}` : ''}"><div class="k">SPC Day 1</div><div class="v" style="font-size:18px;margin-top:8px">${spc1 ? esc(spc1.max_label) : '—'}</div><div class="s">${spc1 && spc1.valid ? `valid ${spcTime(spc1.valid)} → ${spcTime(spc1.expire)}` : ''}</div></div>
        <div class="tile" style="${space && space.kp.latest ? `border-color:${space.kp.color}` : ''}"><div class="k">Geomagnetic Kp</div><div class="v">${space && space.kp.latest && space.kp.latest.kp != null ? space.kp.latest.kp.toFixed(1) : '—'}</div><div class="s">${space && space.kp.scale ? esc(space.kp.scale) : ''}</div></div>
        <div class="tile"><div class="k">Winter alerts</div><div class="v">${sum.by_event.filter(e => /winter|blizzard|ice|snow|freez|cold|chill/i.test(e.event)).reduce((n, e) => n + e.count, 0)}</div><div class="s">storm · ice · blizzard · freeze</div></div>
      </div>
      <div class="grid g2" style="margin-top:12px">
        <div class="card ${sum.tornado_warnings ? 'alert-tornado' : ''}"><h2>Life-threatening now <span class="spacer"></span>${stamp(sum)}</h2><div class="list scroll" id="now-urgent">${sum.urgent.length ? sum.urgent.slice(0, 30).map(alertRow).join('') : '<div class="empty">nothing life-threatening in effect</div>'}</div></div>
        <div class="card"><h2>Radar · alerts · systems <span class="spacer"></span><button class="small" id="now-fullmap">open full map →</button></h2><div id="minimap" class="minimap"></div></div>
        <div class="card span2"><h2>Watched locations <span class="spacer"></span><span class="stamp dim">${fmt.ago(board.generated_at)}</span> <button class="small" id="now-addwatch">+ add</button></h2>
          <div class="grid g4" id="board">${board.locations.map(l => `
            <div class="tile" data-loc='${esc(JSON.stringify({ lat: l.lat, lon: l.lon, label: l.label }))}' style="cursor:pointer;${l.alerts && l.alerts.length ? `border-color:${esc(l.alerts[0].color)}` : ''}">
              <div class="k">${esc(l.label)}</div>
              ${l.ok ? `<div class="v" style="font-size:30px">${esc(l.glyph)} ${fmt.t(l.temp_f)}</div><div class="s">${esc(l.text)} · feels ${fmt.t(l.feels_f)} · ${fmt.t(l.high_f)}/${fmt.t(l.low_f)} · ${fmt.pct(l.precip_chance)} · ${esc(l.wind_compass || '')} ${fmt.w(l.wind_mph)}</div>
                <div class="s">${(l.alerts || []).slice(0, 3).map(a => `<span class="badge fill" style="background:${esc(a.color)}">${esc(a.event)}</span>`).join('') || '<span class="dim">no alerts</span>'}</div>` : `<div class="s err">${esc(l.error)}</div>`}
            </div>`).join('')}</div></div>
        <div class="card"><h2>Alert families</h2><div class="list">${sum.by_event.slice(0, 18).map(e => `<div class="row" data-ev="${esc(e.event)}"><span class="sw" style="background:${esc(e.color)}"></span><div class="body"><div class="t">${esc(e.event)}</div></div><div><b>${e.count}</b></div></div>`).join('')}</div></div>
        <div class="card"><h2>Busiest states</h2><table><tbody>${sum.by_state.slice(0, 15).map(s => `<tr class="clickable" data-st="${esc(s.state)}"><td>${esc(s.state)}</td><td><div class="meter"><i style="width:${Math.min(100, s.count / (sum.by_state[0].count || 1) * 100)}%;background:var(--accent)"></i></div></td><td class="right">${s.count}</td></tr>`).join('')}</tbody></table></div>
        <div class="card span2"><h2>Trending on the weather desk <span class="spacer"></span><button class="small" data-go="news">news →</button></h2>${events.events && events.events.length ? `<div class="grid g3">${events.events.slice(0, 6).map(e => `<div class="tile"><div class="k">${esc(e.desk)} · z ${e.z}</div><div class="v" style="font-size:16px">${esc(e.label || e.subject)}</div><div class="s">${e.count} stories · ${(e.sources || []).slice(0, 4).map(esc).join(', ')}</div>${(e.stories || []).slice(0, 1).map(s => `<div class="s"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.headline)}</a></div>`).join('')}</div>`).join('')}</div>` : `<div class="empty">${events.configured === false ? 'newsroom not configured — set NEWSROOM_URL and NEWSROOM_TOKEN' : 'nothing trending right now'}</div>`}</div>
      </div>`;
    bindAlertRows(root);
    $$('[data-loc]', root).forEach(t => { t.onclick = () => { setLoc(JSON.parse(t.dataset.loc)); show('forecast'); }; });
    $$('[data-ev]', root).forEach(r => { r.onclick = () => { S.alertFilter = { event: r.dataset.ev }; show('alerts'); }; });
    $$('[data-st]', root).forEach(r => { r.onclick = () => { S.alertFilter = { state: r.dataset.st }; show('alerts'); }; });
    $$('[data-go]', root).forEach(b => { b.onclick = () => show(b.dataset.go); });
    $('#now-fullmap').onclick = () => show('map');
    $('#now-addwatch').onclick = async () => { const q = prompt('Place to watch (city, ZIP or lat,lon):'); if (!q) return; try { await api('/api/watch', { method: 'POST', body: JSON.stringify({ q }) }); toast('added'); render('now'); } catch (e) { toast(e.message); } };
    miniMap().catch(() => { $('#minimap').innerHTML = '<div class="empty">map library unavailable</div>'; });
  };

  // ALERTS
  views.alerts = async () => {
    const root = $('#view-alerts');
    const f = S.alertFilter || {};
    const sum = S.summary || await api('/api/alerts/summary');
    if (!$('#al-table')) root.innerHTML = `
      <div class="toolbar">
        <input id="al-q" placeholder="search area / headline" value="${esc(f.q || '')}">
        <input id="al-state" placeholder="state (OK)" style="min-width:90px;width:90px" maxlength="2" value="${esc(f.state || '')}">
        <select id="al-event"><option value="">every event</option>${sum.by_event.map(e => `<option ${f.event === e.event ? 'selected' : ''} value="${esc(e.event.replace(' (Emergency)', ''))}">${esc(e.event)} (${e.count})</option>`).join('')}</select>
        <select id="al-sev"><option value="">any severity</option>${['Extreme', 'Severe', 'Moderate', 'Minor', 'Unknown'].map(s => `<option ${f.severity === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button id="al-go" class="primary">FILTER</button><button id="al-clear" class="small">clear</button>
        <span class="grow"></span><span id="al-count" class="dim small"></span>
      </div>
      <div class="card"><div class="scroll"><table><thead><tr><th>event</th><th>area</th><th>states</th><th>severity</th><th>issued</th><th>expires</th><th>office</th></tr></thead><tbody id="al-table"></tbody></table></div></div>`;
    const run = async () => {
      const qs = new URLSearchParams({ q: $('#al-q').value.trim(), state: $('#al-state').value.trim(), event: $('#al-event').value, severity: $('#al-sev').value, limit: '800' });
      S.alertFilter = Object.fromEntries(qs);
      const d = await api(`/api/alerts?${qs}`);
      $('#al-count').innerHTML = `${d.total} alerts · ${stamp(d)}`;
      $('#al-table').innerHTML = d.alerts.map(a => `<tr class="clickable" data-alert="${esc(a.id)}"><td class="nowrap"><span class="badge fill" style="background:${esc(a.color)}">${esc(a.event)}</span>${a.tornado_detection ? `<br><span class="badge bad">${esc(a.tornado_detection)}</span>` : ''}</td><td>${esc(a.area)}</td><td>${esc(a.states.join(' '))}</td><td><span class="badge sev-${esc(a.severity)}">${esc(a.severity)}</span></td><td class="nowrap">${fmt.time(a.sent)}</td><td class="nowrap">${fmt.time(a.expires)}<br><span class="dim small">${fmt.until(a.expires)}</span></td><td>${esc(a.office || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">no alerts match</td></tr>';
      bindAlertRows(root);
    };
    $('#al-go').onclick = run; $('#al-clear').onclick = () => { S.alertFilter = {}; root.innerHTML = ''; render('alerts'); };
    ['al-q', 'al-state'].forEach(id => $(`#${id}`).addEventListener('keydown', e => { if (e.key === 'Enter') run(); }));
    ['al-event', 'al-sev'].forEach(id => { $(`#${id}`).onchange = run; });
    await run();
  };

  // FORECAST
  views.forecast = async () => {
    const root = $('#view-forecast');
    if (!S.loc) { root.innerHTML = `<div class="card"><h2>Forecast</h2><p class="dim">Type a place, ZIP or <code>lat,lon</code> in the search box above.</p></div>`; return; }
    const { lat, lon, label } = S.loc;
    root.innerHTML = `<div class="toolbar"><h2 style="margin:0;font-size:15px">${esc(label)} <span class="dim small">${lat.toFixed(3)}, ${lon.toFixed(3)}</span></h2><span class="grow"></span><button class="small" id="fc-watch">+ watch</button><button class="small" id="fc-map">map</button><button class="small" id="fc-brief">briefing</button></div><p class="dim">loading conditions…</p>`;
    $('#fc-watch').onclick = async () => { try { await api('/api/watch', { method: 'POST', body: JSON.stringify({ q: `${lat},${lon}` }) }); toast('watching'); } catch (e) { toast(e.message); } };
    $('#fc-map').onclick = () => { show('map'); mapReady().then(() => S.map.map.setView([lat, lon], 9)); };
    $('#fc-brief').onclick = () => show('briefing');
    const qs = `lat=${lat}&lon=${lon}&label=${encodeURIComponent(label)}`;
    const [c, pa, risk, metars, tide] = await Promise.all([
      api(`/api/conditions?${qs}&hours=48&days=7`), api(`/api/point-alerts?${qs}`).catch(() => ({ alerts: [] })), api(`/api/spc/risk?${qs}`).catch(() => null), api(`/api/metar/near?${qs}`).catch(() => null), api(`/api/tides?${qs}`).catch(() => null),
    ]);
    const om = c.open_meteo && !c.open_meteo.error ? c.open_meteo : null;
    const obs = c.nws && c.nws.observation;
    const nowT = obs && obs.temp_c != null ? fmt.tc(obs.temp_c) : om ? fmt.t(om.current.temp_f) : '—';
    const feels = obs && (obs.heat_index_c ?? obs.wind_chill_c) != null ? fmt.tc(obs.heat_index_c ?? obs.wind_chill_c) : om ? fmt.t(om.current.feels_f) : '—';
    const desc = (obs && obs.text) || (om && om.current.weather.text) || '—';
    const glyph = om ? om.current.weather.glyph : '•';
    const windDir = obs && obs.wind_dir != null ? obs.wind_dir : om ? om.current.wind_dir : null;
    const windSpd = obs && obs.wind_kmh != null ? fmt.wk(obs.wind_kmh) : om ? fmt.w(om.current.wind_mph) : '—';
    const gust = obs && obs.gust_kmh != null ? fmt.wk(obs.gust_kmh) : om && om.current.gust_mph != null ? fmt.w(om.current.gust_mph) : null;
    const aq = c.air_quality && !c.air_quality.error ? c.air_quality.current : null;
    const today = om ? om.daily[0] : null;
    const sun = today ? `↑ ${fmt.clock(today.sunrise)} ↓ ${fmt.clock(today.sunset)} · ${today.daylight_h}h` : '—';
    root.querySelector('p').remove();
    root.insertAdjacentHTML('beforeend', `
      ${pa.alerts.length ? `<div class="card ${pa.alerts.some(a => /Tornado Warning/.test(a.event)) ? 'alert-tornado' : ''}"><h2>Alerts in effect here (${pa.alerts.length})</h2><div class="list">${pa.alerts.map(alertRow).join('')}</div></div>` : ''}
      <div class="grid g2">
        <div class="card"><h2>Now <span class="spacer"></span><span class="stamp dim">${obs ? `${esc(obs.station_name || obs.station)} · ${fmt.ago(obs.time)}` : om ? `model · ${fmt.ago(om.current.time)}` : ''}</span></h2>
          <div class="now"><div><div class="big">${nowT}</div><div class="dim">feels ${feels}</div></div><div><div class="glyph">${glyph}</div><div class="desc">${esc(desc)}</div></div></div>
          <div class="facts">
            <div><div class="k">wind</div><span class="compass" style="transform:rotate(${(windDir || 0) + 180}deg)">↑</span> ${esc(compass(windDir))} ${windSpd}${gust ? ` <span class="dim">g ${gust}</span>` : ''}</div>
            <div><div class="k">humidity</div>${obs && obs.humidity != null ? Math.round(obs.humidity) : om ? om.current.humidity : '—'}%</div>
            <div><div class="k">dew point</div>${obs && obs.dewpoint_c != null ? fmt.tc(obs.dewpoint_c) : om && om.hourly[6] ? fmt.t(om.hourly[6].dewpoint_f) : '—'}</div>
            <div><div class="k">pressure</div>${obs && (obs.sea_level_pa ?? obs.pressure_pa) != null ? `${((obs.sea_level_pa ?? obs.pressure_pa) * 0.0002953).toFixed(2)} inHg` : om ? `${(om.current.pressure_hpa * 0.02953).toFixed(2)} inHg` : '—'}</div>
            <div><div class="k">visibility</div>${obs && obs.visibility_m != null ? fmt.km(obs.visibility_m / 1000) : om && om.hourly[6] ? fmt.km(om.hourly[6].visibility_m / 1000) : '—'}</div>
            <div><div class="k">cloud</div>${om ? `${om.current.cloud}%` : obs && obs.cloud_layers.length ? esc(obs.cloud_layers.map(l => l.amount).join(' ')) : '—'}</div>
            <div><div class="k">UV now</div>${om && om.hourly[6] ? om.hourly[6].uv : '—'}${today ? ` <span class="dim">max ${today.uv_max}</span>` : ''}</div>
            <div><div class="k">sun</div>${sun}</div>
            <div><div class="k">air quality</div>${aq && aq.aqi != null ? `<span class="aqi" style="background:${aq.band.color}">${aq.aqi}</span> ${esc(aq.band.label)}` : '—'}</div>
            <div><div class="k">SPC risk today</div>${risk ? `<span class="cat" style="background:${risk.category ? spcColor(risk.category) : 'var(--surface2)'};color:${risk.category ? '#111' : 'var(--dim)'}">${esc(risk.category_label)}</span>${risk.tornado ? ` <span class="dim">tor ${esc(risk.tornado.label)}</span>` : ''}` : '—'}</div>
            ${c.nws && c.nws.point ? `<div><div class="k">NWS</div>${esc(c.nws.point.office || '')} · ${esc(c.nws.point.zone || '')} · radar ${esc(c.nws.point.radar_station || '')}</div>` : ''}
            ${om ? `<div><div class="k">CAPE</div>${om.hourly[6] ? `${Math.round(om.hourly[6].cape)} J/kg` : '—'}</div>` : ''}
          </div></div>
        <div class="card"><h2>Next 48 hours <span class="spacer"></span><span class="dim small">temp · feels · precip chance · wind</span></h2><canvas class="chart" id="fc-chart" height="200"></canvas><div id="fc-chart-legend" class="dim small"></div></div>
      </div>
      <div class="card"><h2>7-day</h2><div class="days">${om ? om.daily.map(d => `<div class="day"><div class="d">${esc(fmt.day(d.date))}</div><div class="g" title="${esc(d.weather.text)}">${esc(d.weather.glyph)}</div><div class="hl"><b>${fmt.t(d.high_f)}</b> <span>${fmt.t(d.low_f)}</span></div><div class="p">${esc(d.weather.text)}</div><div class="p">${fmt.pct(d.precip_chance)} · ${fmt.in(d.precip_in)}${d.snow_in ? ` · ❄ ${fmt.in(d.snow_in)}` : ''}</div><div class="p">gusts ${fmt.w(d.gust_max_mph)}</div></div>`).join('') : '<div class="empty">model unavailable</div>'}</div></div>
      <div class="grid g2">
        <div class="card"><h2>NWS forecast ${c.nws && c.nws.forecast ? `<span class="spacer"></span><span class="stamp dim">issued ${fmt.ago(c.nws.forecast.updated_at)}</span>` : ''}</h2><div class="periods scroll">${c.nws && c.nws.forecast ? c.nws.forecast.periods.map(p => `<div class="p"><b>${esc(p.name)} · ${p.temp}°${esc(p.temp_unit)}${p.precip_chance != null ? ` · ${p.precip_chance}%` : ''} · ${esc(p.wind)} ${esc(p.wind_dir)}</b><span>${esc(p.detailed)}</span></div>`).join('') : `<div class="empty">${c.nws && c.nws.error ? 'outside NWS coverage' : 'unavailable'}</div>`}</div></div>
        <div class="card"><h2>Nearby airports (METAR)</h2>${metars && metars.stations.length ? `<table><thead><tr><th>stn</th><th>cat</th><th>temp</th><th>wind</th><th>vis</th><th>wx</th><th>age</th></tr></thead><tbody>${metars.stations.map(m => `<tr title="${esc(m.raw)}"><td><b>${esc(m.station)}</b><br><span class="dim small">${esc(m.name || '')} · ${m.distance_km} km</span></td><td><span class="badge ${m.flight_category === 'VFR' ? 'good' : m.flight_category === 'MVFR' ? 'acc' : 'bad'}">${esc(m.flight_category || '—')}</span></td><td>${fmt.tc(m.temp_c)}</td><td>${m.wind_dir != null ? `${m.wind_dir}°` : ''} ${fmt.n(m.wind_kt)}${m.gust_kt ? `G${m.gust_kt}` : ''} kt</td><td>${fmt.n(m.visibility_sm)} sm</td><td>${esc(m.wx || '')}</td><td class="dim">${fmt.ago(m.time)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">no reporting airports nearby</div>'}
          ${tide && tide.coastal ? `<h2 style="margin-top:14px">Tides · ${esc(tide.station.name)} <span class="dim small">${tide.station.distance_km} km</span></h2><div class="small">${tide.water_level ? `observed ${tide.water_level.height_ft} ft · ` : ''}${tide.tides.slice(0, 8).map(t => `<span class="badge ${t.type === 'high' ? 'acc' : ''}">${t.type} ${t.height_ft} ft ${esc(t.time.slice(5, 16))}</span>`).join(' ')}</div>` : ''}
          ${aq ? `<h2 style="margin-top:14px">Air quality detail</h2><div class="small">PM2.5 ${fmt.n(aq.pm2_5)} · PM10 ${fmt.n(aq.pm10)} · O₃ ${fmt.n(aq.o3)} · NO₂ ${fmt.n(aq.no2)} · SO₂ ${fmt.n(aq.so2)} · CO ${fmt.n(aq.co)} µg/m³${aq.dust ? ` · dust ${aq.dust}` : ''}</div>` : ''}
        </div>
      </div>`);
    bindAlertRows(root);
    if (om) drawHourly($('#fc-chart'), om.hourly.filter(h => Date.parse(h.time) >= Date.now() - 3600e3).slice(0, 48));
  };

  function compass(deg) { if (deg == null) return ''; return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]; }
  function drawHourly(canvas, hours) {
    if (!canvas || !hours.length) return;
    const dpr = window.devicePixelRatio || 1; const W = canvas.clientWidth || 600, H = 200;
    canvas.width = W * dpr; canvas.height = H * dpr; const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    const padL = 36, padR = 36, padT = 14, padB = 26; const w = W - padL - padR, h = H - padT - padB;
    const T = hours.map(x => S.units === 'us' ? x.temp_f : (x.temp_f - 32) * 5 / 9), F = hours.map(x => S.units === 'us' ? x.feels_f : (x.feels_f - 32) * 5 / 9);
    const lo = Math.min(...T, ...F) - 3, hi = Math.max(...T, ...F) + 3;
    const x = i => padL + i / (hours.length - 1) * w, y = v => padT + (1 - (v - lo) / (hi - lo)) * h;
    ctx.clearRect(0, 0, W, H);
    // precip probability bars
    hours.forEach((hr, i) => { const p = hr.precip_chance || 0; if (!p) return; ctx.fillStyle = 'rgba(94,179,246,.28)'; const bw = w / hours.length; ctx.fillRect(x(i) - bw / 2, padT + h - p / 100 * h, bw - 1, p / 100 * h); });
    // night shading
    hours.forEach((hr, i) => { if (hr.is_day) return; ctx.fillStyle = 'rgba(0,0,0,.18)'; const bw = w / hours.length; ctx.fillRect(x(i) - bw / 2, padT, bw, h); });
    // grid + labels
    ctx.strokeStyle = css('--line'); ctx.fillStyle = css('--dim'); ctx.font = '10px ui-monospace, monospace'; ctx.lineWidth = 1;
    for (let k = 0; k <= 4; k++) { const v = lo + (hi - lo) * k / 4; ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke(); ctx.fillText(`${Math.round(v)}°`, 4, y(v) + 3); }
    hours.forEach((hr, i) => { if (i % 6) return; const d = new Date(hr.time); ctx.fillText(d.toLocaleTimeString([], { hour: 'numeric' }), x(i) - 10, H - 10); if (d.getHours() === 0) ctx.fillText(d.toLocaleDateString([], { weekday: 'short' }), x(i) - 10, H - 1); });
    const line = (vals, color, width, dash) => { ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []); vals.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))); ctx.stroke(); ctx.setLineDash([]); };
    line(F, css('--dim'), 1, [3, 3]); line(T, css('--heat') || '#ff5a7a', 2.2);
    // wind gust ticks along the top
    hours.forEach((hr, i) => { if (i % 3) return; ctx.fillStyle = css('--dim'); ctx.fillText(`${Math.round(S.units === 'us' ? hr.gust_mph : hr.gust_mph * 1.609)}`, x(i) - 6, padT - 3); });
    const legend = $('#fc-chart-legend'); if (legend) legend.textContent = `— temperature  ┈ feels like  ▮ precip chance  top row: gusts ${S.units === 'us' ? 'mph' : 'km/h'}  shaded: night`;
  }

  // SEVERE
  views.severe = async () => {
    const root = $('#view-severe');
    const [d1, d2, d3, reps, disc] = await Promise.all([api('/api/spc/outlook?day=1'), api('/api/spc/outlook?day=2').catch(() => null), api('/api/spc/outlook?day=3').catch(() => null), api('/api/spc/reports').catch(() => null), api('/api/spc/discussions').catch(() => null)]);
    const torn = (S.summary ? S.summary.by_event : []).filter(e => /Tornado|Severe Thunderstorm/.test(e.event));
    root.innerHTML = `
      <div class="tiles">
        ${[d1, d2, d3].map((d, i) => d ? `<div class="tile" style="border-color:${d.max_category ? spcColor(d.max_category) : 'var(--line)'}"><div class="k">SPC Day ${i + 1}</div><div class="v" style="font-size:17px;margin-top:6px">${esc(d.max_label)}</div><div class="s">${d.valid ? `valid ${spcTime(d.valid)} → ${spcTime(d.expire)}` : ''}</div></div>` : '').join('')}
        ${reps ? `<div class="tile ${reps.counts.tornado ? 'hot' : ''}"><div class="k">Tornado reports today</div><div class="v">${reps.counts.tornado}</div><div class="s">preliminary, LSR</div></div><div class="tile warm"><div class="k">Hail reports</div><div class="v">${reps.counts.hail}</div><div class="s">≥ 1 in</div></div><div class="tile warm"><div class="k">Wind reports</div><div class="v">${reps.counts.wind}</div><div class="s">≥ 58 mph or damage</div></div>` : ''}
        ${torn.map(e => `<div class="tile ${/Tornado Warning/.test(e.event) ? 'hot' : ''}"><div class="k">${esc(e.event)}</div><div class="v">${e.count}</div></div>`).join('')}
      </div>
      <div class="grid g2" style="margin-top:12px">
        <div class="card span2"><h2>Day 1 categorical outlook <span class="spacer"></span><button class="small" id="sv-map">on the full map →</button></h2><div id="sv-minimap" class="minimap"></div><div class="small" style="margin-top:6px">${['TSTM', 'MRGL', 'SLGT', 'ENH', 'MDT', 'HIGH'].map(c => `<span class="cat" style="background:${spcColor(c)}">${c}</span> `).join('')}</div></div>
        <div class="card"><h2>Storm reports today <span class="spacer"></span>${reps ? stamp(reps) : ''}</h2><div class="scroll"><table><thead><tr><th>Z</th><th>type</th><th>mag</th><th>location</th><th>comments</th></tr></thead><tbody>${reps && reps.reports.length ? reps.reports.slice().reverse().slice(0, 300).map(r => `<tr><td>${esc(r.time_z)}</td><td><span class="badge ${r.kind === 'tornado' ? 'sev-Extreme' : r.kind === 'hail' ? 'acc' : 'sev-Severe'}">${esc(r.kind)}</span></td><td>${esc(r.magnitude || '')}</td><td>${esc(r.location)}, ${esc(r.county)} ${esc(r.state)}</td><td class="small">${esc(r.comments)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">no reports yet today (reports day runs 12Z–12Z)</td></tr>'}</tbody></table></div></div>
        <div class="card"><h2>Mesoscale discussions</h2><div class="list scroll-sm">${disc && disc.mesoscale.items.length ? disc.mesoscale.items.slice(0, 20).map(i => `<a class="row" href="${esc(i.link)}" target="_blank" rel="noopener"><span class="sw" style="background:var(--warn)"></span><div class="body"><div class="t">${esc(i.title)}</div><div class="m">${esc(i.summary.slice(0, 220))}</div><div class="m">${fmt.ago(i.published_at)}</div></div></a>`).join('') : '<div class="empty">none active</div>'}</div></div>
        <div class="card"><h2>Watches</h2><div class="list scroll-sm">${disc && disc.watches.items.length ? disc.watches.items.slice(0, 20).map(i => `<a class="row" href="${esc(i.link)}" target="_blank" rel="noopener"><span class="sw" style="background:var(--svr)"></span><div class="body"><div class="t">${esc(i.title)}</div><div class="m">${esc(i.summary.slice(0, 220))}</div><div class="m">${fmt.ago(i.published_at)}</div></div></a>`).join('') : '<div class="empty">no watches</div>'}</div></div>
      </div>`;
    $('#sv-map').onclick = () => { show('map'); mapReady().then(() => S.map.setLayer('spc', true)); };
    miniMap('sv-minimap', { spc: true, radar: false, alerts: false, reports: true }).catch(() => {});
  };
  const spcTime = v => { const m = String(v || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/); return m ? `${new Date(Date.UTC(+m[1], m[2] - 1, +m[3])).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${m[4]}:${m[5]}Z` : esc(v || ''); };
  const spcColor = c => ({ TSTM: '#C1E9C1', MRGL: '#66A366', SLGT: '#FFE066', ENH: '#FFA366', MDT: '#E06666', HIGH: '#EE99EE' }[c] || '#888');

  // TROPICAL
  views.tropical = async () => {
    const root = $('#view-tropical');
    const [st, ol] = await Promise.all([api('/api/tropical'), api('/api/tropical/outlook').catch(() => ({}))]);
    root.innerHTML = `
      <div class="grid g3">${st.storms.length ? st.storms.map(s => `
        <div class="card" style="border-color:${s.category ? s.category.color : 'var(--line)'}"><h2>${esc(s.classification || '')} ${esc(s.name)} <span class="spacer"></span><span class="stamp dim">${esc(s.basin.replace('_', ' '))} · ${fmt.ago(s.last_update)}</span></h2>
          <div class="now"><div><div class="big" style="font-size:40px">${fmt.w(s.wind_mph)}</div><div class="dim">sustained · ${fmt.n(s.pressure_mb)} mb</div></div><div><div class="desc"><span class="cat" style="background:${s.category ? s.category.color : '#888'}">${s.category ? esc(s.category.label) : '—'}</span></div><div class="small" style="margin-top:6px">moving ${esc(s.movement.compass || '—')} at ${fmt.w(s.movement.speed_mph)}</div><div class="small dim">${s.lat != null ? `${s.lat.toFixed(1)}°, ${s.lon.toFixed(1)}°` : ''}</div></div></div>
          <div class="toolbar" style="margin-top:10px">${s.products.advisory ? `<a class="badge acc" href="${esc(s.products.advisory)}" target="_blank" rel="noopener">public advisory</a>` : ''}${s.products.discussion ? `<a class="badge acc" href="${esc(s.products.discussion)}" target="_blank" rel="noopener">discussion</a>` : ''}${s.products.graphics ? `<a class="badge acc" href="${esc(s.products.graphics)}" target="_blank" rel="noopener">cone graphic</a>` : ''}${s.products.wind_probs ? `<a class="badge acc" href="${esc(s.products.wind_probs)}" target="_blank" rel="noopener">wind probabilities</a>` : ''}<button class="small" data-storm="${s.lat},${s.lon}">map</button></div>
        </div>`).join('') : `<div class="card"><h2>Active systems</h2><div class="empty">no active tropical cyclones in the Atlantic or Pacific basins ${stamp(st)}</div></div>`}
      </div>
      <div class="grid g3" style="margin-top:12px">${['atlantic', 'eastern_pacific', 'central_pacific'].map(b => `<div class="card"><h2>${esc(b.replace('_', ' '))} · NHC products</h2><div class="list scroll-sm">${ol[b] && ol[b].items && ol[b].items.length ? ol[b].items.slice(0, 12).map(i => `<a class="row" href="${esc(i.link)}" target="_blank" rel="noopener"><span class="sw" style="background:${i.kind === 'outlook' ? 'var(--accent)' : i.kind === 'advisory' ? 'var(--bad)' : 'var(--dim)'}"></span><div class="body"><div class="t">${esc(i.title)}</div><div class="m">${esc(i.summary.slice(0, 260))}</div><div class="m">${fmt.ago(i.published_at)}</div></div></a>`).join('') : `<div class="empty">${ol[b] && ol[b].error ? esc(ol[b].error) : 'nothing posted'}</div>`}</div></div>`).join('')}</div>`;
    $$('[data-storm]', root).forEach(b => { b.onclick = () => { const [la, lo] = b.dataset.storm.split(',').map(Number); show('map'); mapReady().then(() => { S.map.setLayer('tropical', true); S.map.map.setView([la, lo], 5); }); }; });
  };

  // QUAKES
  views.quakes = async () => {
    const root = $('#view-quakes');
    const feed = S.qfeed || '2.5_day';
    const d = await api(`/api/quakes?feed=${feed}&limit=600`);
    root.innerHTML = `
      <div class="toolbar"><div class="chips">${[['all_hour', 'past hour'], ['all_day', 'all · 24h'], ['2.5_day', 'M2.5+ · 24h'], ['2.5_week', 'M2.5+ · 7d'], ['4.5_week', 'M4.5+ · 7d'], ['significant_month', 'significant · 30d']].map(([k, l]) => `<button class="${feed === k ? 'on' : ''}" data-feed="${k}">${l}</button>`).join('')}</div><span class="grow"></span><span class="dim small">${d.count} events · ${stamp(d)}</span></div>
      <div class="tiles"><div class="tile ${d.largest && d.largest.mag >= 6 ? 'hot' : d.largest && d.largest.mag >= 5 ? 'warm' : ''}"><div class="k">Largest</div><div class="v">${d.largest ? `M${d.largest.mag.toFixed(1)}` : '—'}</div><div class="s">${d.largest ? esc(d.largest.place) : ''}</div></div><div class="tile"><div class="k">M4.5+</div><div class="v">${d.quakes.filter(q => q.mag >= 4.5).length}</div></div><div class="tile"><div class="k">Tsunami flag</div><div class="v">${d.quakes.filter(q => q.tsunami).length}</div></div><div class="tile"><div class="k">Felt reports</div><div class="v">${d.quakes.reduce((n, q) => n + (q.felt || 0), 0)}</div></div></div>
      <div class="grid g2" style="margin-top:12px"><div class="card"><h2>Map</h2><div id="qk-minimap" class="minimap"></div></div>
      <div class="card"><h2>Events</h2><div class="scroll"><table><thead><tr><th>mag</th><th>place</th><th>time</th><th>depth</th><th>alert</th></tr></thead><tbody>${d.quakes.map(q => `<tr class="clickable" data-q="${q.lat},${q.lon}"><td><b style="color:${esc(q.color)}">M${(q.mag || 0).toFixed(1)}</b></td><td><a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.place)}</a>${q.tsunami ? ' <span class="badge bad">tsunami</span>' : ''}</td><td class="nowrap">${fmt.time(q.time)}<br><span class="dim small">${fmt.ago(q.time)}</span></td><td>${q.depth_km != null ? `${q.depth_km.toFixed(0)} km` : ''}</td><td>${q.alert ? `<span class="badge" style="color:${esc(q.alert)}">${esc(q.alert)}</span>` : ''}${q.felt ? `<span class="dim small"> ${q.felt} felt</span>` : ''}</td></tr>`).join('')}</tbody></table></div></div></div>`;
    $$('[data-feed]', root).forEach(b => { b.onclick = () => { S.qfeed = b.dataset.feed; render('quakes'); }; });
    $$('[data-q]', root).forEach(r => { r.onclick = () => { const [la, lo] = r.dataset.q.split(',').map(Number); if (S.qmini) S.qmini.map.setView([la, lo], 6); }; });
    miniMap('qk-minimap', { quakes: feed, radar: false, alerts: false, spc: false }).then(m => { S.qmini = m; }).catch(() => {});
  };

  // WATER · FIRE
  views.water = async () => {
    const root = $('#view-water');
    // Rivers can take a while on a cold cache (the national gauge list is a
    // big download), so the page renders with fires + drought first and the
    // river card fills in when its answer lands.
    const riversP = api('/api/rivers?min=action').catch(e => ({ error: e.message, gauges: [], counts: {}, pending: false }));
    const [fires, dr] = await Promise.all([api('/api/fires').catch(e => ({ inciweb: { incidents: [], error: e.message }, firms: { hotspots: [] } })), api('/api/drought').catch(e => ({ error: e.message }))]);
    const riv = { counts: {}, gauges: [], pending: true };
    const c = riv.counts || {};
    const latest = dr.latest;
    root.innerHTML = `
      <div class="tiles"><div class="tile"><div class="k">Major flooding</div><div class="v">…</div><div class="s">gauges</div></div><div class="tile"><div class="k">Moderate</div><div class="v">…</div></div><div class="tile"><div class="k">Minor</div><div class="v">…</div></div><div class="tile"><div class="k">Action stage</div><div class="v">…</div><div class="s">loading gauges</div></div><div class="tile"><div class="k">Wildfire incidents</div><div class="v">${fires.inciweb.incidents.filter(i => i.type === 'wildfire').length}</div><div class="s">InciWeb${fires.firms && fires.firms.count != null ? ` · ${fires.firms.count} FIRMS hotspots` : ''}</div></div>${latest ? `<div class="tile"><div class="k">US in drought (D1+)</div><div class="v">${(latest.d1).toFixed(1)}%</div><div class="s">${dr.previous ? `${(latest.d1 - dr.previous.d1) >= 0 ? '▲' : '▼'} ${Math.abs(latest.d1 - dr.previous.d1).toFixed(1)} vs last week` : ''}</div></div>` : ''}</div>
      <div class="grid g2" style="margin-top:12px">
        <div class="card" id="wt-rivers"><h2>Rivers at or above flood stage</h2><div class="empty">loading the national gauge list…</div></div>
        <div class="card"><h2>Map · gauges in flood · fires</h2><div id="wt-minimap" class="minimap"></div></div>
        <div class="card"><h2>NWS flood products in effect <span class="spacer"></span><span class="dim small">warnings · watches · advisories</span></h2><div class="list scroll-sm" id="wt-floodalerts"><div class="empty">loading…</div></div></div>
        <div class="card"><h2>Wildfire incidents (InciWeb) <span class="spacer"></span>${fires.inciweb.fetched_at ? stamp(fires.inciweb) : ''}</h2><div class="list scroll">${fires.inciweb.incidents.length ? fires.inciweb.incidents.slice(0, 60).map(i => `<a class="row" href="${esc(i.link)}" target="_blank" rel="noopener"><span class="sw" style="background:${i.type === 'wildfire' ? 'var(--fire)' : 'var(--dim)'}"></span><div class="body"><div class="t">${esc(i.title)}</div><div class="m">${i.acres != null ? `${i.acres.toLocaleString()} acres` : ''}${i.contained_pct != null ? ` · ${i.contained_pct}% contained` : ''} · ${fmt.ago(i.published_at)}</div><div class="m">${esc(i.summary.slice(0, 200))}</div></div></a>`).join('') : `<div class="empty">${fires.inciweb.error ? esc(fires.inciweb.error) : 'no incidents listed'}</div>`}</div></div>
        <div class="card"><h2>US Drought Monitor ${latest ? `<span class="spacer"></span><span class="stamp dim">week of ${esc(String(latest.date).slice(0, 10))}</span>` : ''}</h2>${latest ? `<div class="meter" style="height:18px">${[['d4', '#730000'], ['d3', '#E60000'], ['d2', '#FFAA00'], ['d1', '#FCD37F'], ['d0', '#FFFF00']].map(([k, col]) => `<i title="${k.toUpperCase()} ${latest[k].toFixed(1)}%" style="width:${latest[k]}%;background:${col}"></i>`).join('')}</div><table style="margin-top:8px"><tbody>${['d0', 'd1', 'd2', 'd3', 'd4'].map(k => `<tr><td>${k.toUpperCase()} · ${esc(dr.categories[k.toUpperCase()])}</td><td class="right">${latest[k].toFixed(1)}%</td><td class="right dim">${dr.previous ? `${(latest[k] - dr.previous[k]) >= 0 ? '+' : ''}${(latest[k] - dr.previous[k]).toFixed(1)}` : ''}</td></tr>`).join('')}</tbody></table><p class="dim small">cumulative: D1 includes D2–D4, etc. Source: droughtmonitor.unl.edu</p>` : `<div class="empty">${esc(dr.error || 'unavailable')}</div>`}</div>
      </div>`;
    riversP.then(r => {
      const card = $('#wt-rivers'); if (!card) return;
      const cc = r.counts || {};
      card.innerHTML = `<h2>Rivers at or above flood stage <span class="spacer"></span>${stamp(r)}</h2>${r.error ? `<div class="err">${esc(r.error)} — see the NWS flood products panel meanwhile</div>` : ''}<div class="scroll"><table><thead><tr><th>gauge</th><th>state</th><th>stage</th><th>category</th><th>forecast</th></tr></thead><tbody>${(r.gauges || []).slice(0, 400).map(g => `<tr class="clickable" data-g="${g.lat},${g.lon}"><td><a href="${esc(g.url)}" target="_blank" rel="noopener">${esc(g.name)}</a><br><span class="dim small">${esc(g.id)}</span></td><td>${esc(g.state || '')}</td><td>${fmt.n(g.observed.stage)} ${esc(g.observed.unit || 'ft')}${g.flood_stages && g.flood_stages.major ? `<br><span class="dim small">major ${g.flood_stages.major}</span>` : ''}</td><td><span class="badge fill" style="background:${esc(g.observed.color)}">${esc(g.observed.category)}</span></td><td>${g.forecast ? `${fmt.n(g.forecast.stage)} ${g.forecast.category ? `<span class="badge">${esc(g.forecast.category)}</span>` : ''}` : ''}</td></tr>`).join('') || (r.error ? '' : '<tr><td colspan="5" class="empty">no gauges above action stage</td></tr>')}</tbody></table></div>`;
      $$('[data-g]', card).forEach(row => { row.onclick = () => { const [la, lo] = row.dataset.g.split(',').map(Number); if (S.wmini) S.wmini.map.setView([la, lo], 9); }; });
      // Refresh the tiles with the real counts.
      const tiles = $$('#view-water .tiles .tile .v'); if (tiles.length >= 4 && !r.error) { tiles[0].textContent = cc.major ?? '—'; tiles[1].textContent = cc.moderate ?? '—'; tiles[2].textContent = cc.minor ?? '—'; tiles[3].textContent = cc.action ?? '—'; const sub = $$('#view-water .tiles .tile .s')[3]; if (sub) sub.textContent = `of ${r.total_gauges} gauges`; }
    });
    miniMap('wt-minimap', { rivers: true, fires: true, radar: false, alerts: true, spc: false }).then(m => { S.wmini = m; }).catch(() => {});
    api('/api/alerts?event=flood&limit=200').then(d => { const box = $('#wt-floodalerts'); if (!box) return; box.innerHTML = d.alerts.length ? d.alerts.map(alertRow).join('') : '<div class="empty">no flood products in effect</div>'; bindAlertRows(box); }).catch(e => { const box = $('#wt-floodalerts'); if (box) box.innerHTML = `<div class="err">${esc(e.message)}</div>`; });
    $$('[data-g]', root).forEach(r => { r.onclick = () => { const [la, lo] = r.dataset.g.split(',').map(Number); if (S.wmini) S.wmini.map.setView([la, lo], 9); }; });
  };

  // SPACE
  views.space = async () => {
    const root = $('#view-space');
    const d = await api('/api/space');
    const hist = d.kp.history.slice(-48);
    root.innerHTML = `
      <div class="tiles"><div class="tile" style="border-color:${d.kp.color || 'var(--line)'}"><div class="k">Planetary Kp</div><div class="v">${d.kp.latest && d.kp.latest.kp != null ? d.kp.latest.kp.toFixed(1) : '—'}</div><div class="s">${esc(d.kp.scale || '')} · ${d.kp.latest ? fmt.ago(d.kp.latest.time + 'Z') : ''}</div></div>
        ${d.scales_now ? `<div class="tile"><div class="k">Geomagnetic</div><div class="v">G${esc(d.scales_now.geomagnetic.Scale)}</div><div class="s">${esc(d.scales_now.geomagnetic.Text)}</div></div><div class="tile"><div class="k">Solar radiation</div><div class="v">S${esc(d.scales_now.radiation.Scale)}</div><div class="s">${esc(d.scales_now.radiation.Text)}</div></div><div class="tile"><div class="k">Radio blackout</div><div class="v">R${esc(d.scales_now.radio_blackout.Scale)}</div><div class="s">${esc(d.scales_now.radio_blackout.Text)}</div></div>` : ''}
        ${d.solar_wind ? `<div class="tile"><div class="k">Solar wind</div><div class="v">${fmt.n(d.solar_wind.speed_kms)}</div><div class="s">km/s · density ${fmt.n(d.solar_wind.density)} p/cm³</div></div>` : ''}</div>
      <div class="grid g2" style="margin-top:12px">
        <div class="card"><h2>Kp — last ${hist.length} readings (3-hourly)</h2><div class="kp">${hist.map(h => `<i title="${esc(h.time)} Kp ${h.kp}" style="height:${h.kp / 9 * 100}%;background:${h.kp >= 7 ? 'var(--bad)' : h.kp >= 5 ? 'var(--warn)' : h.kp >= 4 ? '#ff0' : 'var(--good)'}"></i>`).join('')}</div><p class="dim small">Kp 5 = G1 minor storm (aurora to the northern tier) · Kp 7 = G3 strong (aurora to the mid-latitudes, GPS degradation) · Kp 9 = G5 extreme</p></div>
        <div class="card"><h2>SWPC alerts, watches, warnings</h2><div class="list scroll">${d.alerts.length ? d.alerts.map(a => `<div class="row"><span class="sw" style="background:${/WARNING|ALERT/.test(a.message) ? 'var(--bad)' : 'var(--accent)'}"></span><div class="body"><div class="m">${esc(a.issued)} · ${esc(a.product)}</div><pre style="white-space:pre-wrap;margin:4px 0 0;font:inherit;font-size:11.5px">${esc(a.message.slice(0, 900))}</pre></div></div>`).join('') : '<div class="empty">none</div>'}</div></div>
        <div class="card span2"><h2>3-day forecast (SWPC)</h2><pre style="white-space:pre-wrap;font:inherit;font-size:12px">${esc(d.forecast_text || 'unavailable')}</pre></div>
      </div>`;
  };

  // NEWS
  views.news = async () => {
    const root = $('#view-news');
    const q = S.newsQ || '';
    const [n, ev] = await Promise.all([api(`/api/news?limit=120&q=${encodeURIComponent(q)}`), api('/api/events').catch(() => ({ events: [] }))]);
    const cred = r => r.credibility == null ? '' : `<span class="badge ${r.credibility >= 70 ? 'good' : r.credibility >= 40 ? '' : 'bad'}">cred ${r.credibility}</span>`;
    root.innerHTML = `
      <div class="toolbar"><input id="nw-q" placeholder="search the weather desk" value="${esc(q)}"><button id="nw-go" class="primary">SEARCH</button><span class="grow"></span><span class="dim small">${n.configured ? `mirror ${n.mirror.rows} rows · ${n.mirror.rows_24h} today · last pull ${fmt.ago(n.mirror.last_poll_at)}${n.mirror.last_error ? ` · <span class="err">${esc(n.mirror.last_error)}</span>` : ''}` : 'newsroom not configured'}</span>${n.configured ? '<button class="small" id="nw-poll">pull now</button>' : ''}</div>
      <div class="grid g2">
        <div class="card"><h2>Trend events · weather desk</h2><div class="list scroll-sm">${ev.events.length ? ev.events.map(e => `<div class="row"><span class="sw" style="background:var(--accent)"></span><div class="body"><div class="t">${esc(e.label || e.subject)} <span class="dim small">z ${e.z} · ${e.count} stories · baseline ${e.baseline}</span></div><div class="m">${(e.sources || []).map(esc).join(' · ')}</div>${(e.stories || []).slice(0, 3).map(s => `<div class="m">· <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.headline)}</a> <span class="dim">${esc(s.source)}</span></div>`).join('')}</div></div>`).join('') : `<div class="empty">${n.configured ? 'nothing trending' : 'set NEWSROOM_URL + NEWSROOM_TOKEN in .env'}</div>`}</div></div>
        <div class="card"><h2>Latest · ${n.rows.length}</h2><div class="list scroll">${n.rows.length ? n.rows.map(r => `<div class="row" style="cursor:default"><span class="sw" style="background:${r.scan_depth === 'filing' ? 'var(--accent)' : 'var(--line)'}"></span><div class="body"><div class="t"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.headline)}</a></div><div class="m">${esc(r.snippet || '').slice(0, 220)}</div><div class="m"><span class="badge">${esc(r.source)}</span>${(r.classes || []).map(c => `<span class="badge acc">${esc(c)}</span>`).join('')}${r.scan_depth === 'filing' ? '<span class="badge acc">primary</span>' : ''}${cred(r)} ${fmt.ago(r.ingested_at)}</div></div></div>`).join('') : '<div class="empty">no rows in the mirror yet</div>'}</div></div>
      </div>`;
    $('#nw-go').onclick = () => { S.newsQ = $('#nw-q').value.trim(); render('news'); };
    $('#nw-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nw-go').click(); });
    if ($('#nw-poll')) $('#nw-poll').onclick = async () => { try { const r = await api('/api/newsroom/poll', { method: 'POST' }); toast(`pulled ${r.added} new rows`); render('news'); } catch (e) { toast(e.message); } };
  };

  // BRIEFING
  views.briefing = async () => {
    const root = $('#view-briefing');
    const loc = S.loc;
    root.innerHTML = `<div class="toolbar"><input id="br-q" placeholder="place, ZIP or lat,lon" value="${esc(loc ? loc.label : '')}"><button id="br-go" class="primary">BUILD BRIEFING</button><span class="grow"></span>${loc ? `<a class="small" href="/briefing.txt?lat=${loc.lat}&lon=${loc.lon}&label=${encodeURIComponent(loc.label)}" target="_blank">briefing.txt (needs token header) →</a>` : ''}</div><div class="card brief"><h2>Briefing <span class="spacer"></span><button class="small" id="br-copy">copy</button></h2><pre id="br-text">${loc ? 'building…' : 'Choose a place. The briefing gathers alerts in effect, current conditions, the next 24 hours and 7 days, SPC risk, tropical systems, rivers in flood, recent earthquakes, air quality, tides, and what the newsroom has published about the place — the block the Newsroom Reporters write from.'}</pre></div>`;
    const build = async q => {
      $('#br-text').textContent = 'building…';
      try {
        let qs;
        if (q && q !== (loc && loc.label)) { const g = await api(`/api/geocode?q=${encodeURIComponent(q)}&count=1`); if (!g.results.length) return ($('#br-text').textContent = `no place found for "${q}"`); setLoc(g.results[0]); }
        qs = `lat=${S.loc.lat}&lon=${S.loc.lon}&label=${encodeURIComponent(S.loc.label)}`;
        const b = await api(`/api/briefing?${qs}`);
        $('#br-text').textContent = b.text; S.briefText = b.text;
      } catch (e) { $('#br-text').textContent = `error: ${e.message}`; }
    };
    $('#br-go').onclick = () => build($('#br-q').value.trim());
    $('#br-q').addEventListener('keydown', e => { if (e.key === 'Enter') $('#br-go').click(); });
    $('#br-copy').onclick = () => copy($('#br-text').textContent);
    if (loc) build(loc.label);
  };

  // STATUS
  views.status = async () => {
    const root = $('#view-status');
    const [st, w] = await Promise.all([api('/api/status'), api('/api/watch')]);
    const nr = st.newsroom;
    root.innerHTML = `
      <div class="grid g2">
        <div class="card"><h2>Service</h2><div class="kv"><span class="k">port</span><span>${st.port}</span><span class="k">uptime</span><span>${Math.round(st.uptime_s / 60)} min</span><span class="k">memory</span><span>${st.rss_mb} MB</span><span class="k">polling</span><span>${st.polling ? 'on' : 'off'}</span><span class="k">tokens</span><span>${st.tokens}</span></div>
          <h2 style="margin-top:12px">Newsroom (weather desk)</h2><div class="kv"><span class="k">configured</span><span>${nr.configured ? esc(nr.url) : '<span class="err">no — set NEWSROOM_URL + NEWSROOM_TOKEN</span>'}</span>${nr.configured ? `<span class="k">reachable</span><span>${nr.health.ok ? `<span class="badge good">ok</span> ${nr.health.tickers || ''} tickers · ${nr.health.adapters || ''} adapters` : `<span class="badge bad">${esc(nr.health.error || 'down')}</span>`}</span><span class="k">mirror</span><span>${nr.mirror.rows} rows · ${nr.mirror.rows_24h} today</span><span class="k">cursor</span><span>${esc(nr.mirror.cursor || '—')}</span><span class="k">last pull</span><span>${fmt.ago(nr.mirror.last_poll_at)} ${nr.mirror.last_error ? `<span class="err">${esc(nr.mirror.last_error)}</span>` : ''}</span>` : ''}</div>
          <h2 style="margin-top:12px">Appearance</h2><div class="toolbar"><button class="small" id="st-theme">toggle theme</button><button class="small" id="st-units">toggle units</button><button class="small danger" id="st-logout">forget token</button></div></div>
        <div class="card"><h2>Watched locations (${w.locations.length})</h2><div class="toolbar"><input id="st-add" placeholder="add a place"><button class="small" id="st-add-go">add</button></div><table><tbody>${w.locations.map(l => `<tr><td>${esc(l.label)}</td><td class="dim small">${l.lat.toFixed(2)}, ${l.lon.toFixed(2)}</td><td class="right"><button class="small danger" data-del="${esc(l.id)}">remove</button></td></tr>`).join('')}</tbody></table></div>
        <div class="card span2"><h2>Data sources</h2><div class="scroll"><table><thead><tr><th>source</th><th>calls</th><th>ok</th><th>errors</th><th>last ok</th><th>last error</th><th>ms</th></tr></thead><tbody>${st.sources.map(s => `<tr><td><i class="dot ${s.errors && (!s.last_ok_at || s.last_error_at > s.last_ok_at) ? 'bad' : s.ok ? 'ok' : ''}"></i>${esc(s.id)}</td><td>${s.calls}</td><td>${s.ok}</td><td>${s.errors}</td><td class="dim">${fmt.ago(s.last_ok_at)}</td><td class="err small">${esc(s.last_error || '')}</td><td>${fmt.n(s.last_ms)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">no calls yet</td></tr>'}</tbody></table></div></div>
        <div class="card span2"><h2>Cache (${st.cache.length} entries)</h2><div class="small dim">${st.cache.map(c => `${esc(c.key)} <b>${c.age_s}s</b>/${c.ttl_s}s`).join(' · ')}</div></div>
      </div>`;
    $('#st-theme').onclick = () => $('#theme-btn').click(); $('#st-units').onclick = () => $('#units-btn').click();
    $('#st-logout').onclick = () => { localStorage.removeItem('wc_token'); location.reload(); };
    $('#st-add-go').onclick = async () => { const q = $('#st-add').value.trim(); if (!q) return; try { await api('/api/watch', { method: 'POST', body: JSON.stringify({ q }) }); render('status'); } catch (e) { toast(e.message); } };
    $$('[data-del]', root).forEach(b => { b.onclick = async () => { await api(`/api/watch?id=${encodeURIComponent(b.dataset.del)}`, { method: 'DELETE' }); render('status'); }; });
  };

  // ─── Map ───────────────────────────────────────────────────────────
  function loadLeaflet() {
    if (S.leaflet) return S.leaflet;
    S.leaflet = new Promise((resolve, reject) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
      const s = document.createElement('script'); s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = () => resolve(window.L); s.onerror = () => { S.leaflet = null; reject(new Error('map library failed to load')); };
      document.head.appendChild(s);
    });
    return S.leaflet;
  }
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const BASEMAPS = {
    dark: { label: 'dark', url: ESRI + 'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: ESRI + 'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', attribution: '© Esri' },
    light: { label: 'light', url: ESRI + 'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}', labels: ESRI + 'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}', attribution: '© Esri' },
    satellite: { label: 'satellite', url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', labels: ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', attribution: '© Esri' },
    terrain: { label: 'terrain', url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '© OpenTopoMap' },
    street: { label: 'street', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap' },
  };

  // A WeatherMap wraps one Leaflet instance with the layer stack. `opts`
  // picks the initial layers; the full MAP view adds the control panel.
  class WeatherMap {
    constructor(L, elId, opts = {}) {
      this.L = L; this.opts = opts;
      this.map = L.map(elId, { zoomControl: !opts.mini, attributionControl: true, worldCopyJump: true }).setView(opts.center || [38.5, -96.5], opts.zoom || (opts.mini ? 3 : 4));
      this.base = null; this.labels = null; this.setBasemap(localStorage.getItem('wc_base') || 'dark');
      this.groups = { radar: L.layerGroup(), satellite: L.layerGroup(), alerts: L.layerGroup(), spc: L.layerGroup(), quakes: L.layerGroup(), tropical: L.layerGroup(), reports: L.layerGroup(), rivers: L.layerGroup(), fires: L.layerGroup(), watch: L.layerGroup() };
      this.on = { radar: opts.radar !== false, satellite: !!opts.satellite, alerts: opts.alerts !== false, spc: !!opts.spc, quakes: !!opts.quakes, tropical: opts.tropical !== false, reports: !!opts.reports, rivers: !!opts.rivers, fires: !!opts.fires, watch: opts.watch !== false };
      this.radar = { frames: [], idx: 0, playing: false, host: '', color: localStorage.getItem('wc_radar_color') || '6', opacity: 0.72, layer: null, timer: null };
      this.alertFilter = 'all'; this.spcDay = 1; this.quakeFeed = typeof opts.quakes === 'string' ? opts.quakes : '2.5_day';
      for (const k of Object.keys(this.groups)) if (this.on[k]) this.groups[k].addTo(this.map);
      this.map.on('click', e => this.pointPopup(e.latlng));
      this.refreshAll();
    }
    setBasemap(key) {
      const L = this.L; const bm = BASEMAPS[key] || BASEMAPS.dark; localStorage.setItem('wc_base', key); this.baseKey = key;
      if (this.base) this.map.removeLayer(this.base); if (this.labels) { this.map.removeLayer(this.labels); this.labels = null; }
      this.base = L.tileLayer(bm.url, { attribution: bm.attribution, maxZoom: 18 }).addTo(this.map);
      if (bm.labels) this.labels = L.tileLayer(bm.labels, { maxZoom: 18, pane: 'shadowPane' }).addTo(this.map);
    }
    setLayer(k, on) { this.on[k] = on; if (on) { this.groups[k].addTo(this.map); this.refresh(k); } else this.map.removeLayer(this.groups[k]); }
    refreshAll() { for (const k of Object.keys(this.groups)) if (this.on[k]) this.refresh(k).catch(() => {}); }
    async refresh(k) {
      const fn = { radar: () => this.loadRadar(), satellite: () => this.loadSatellite(), alerts: () => this.loadAlerts(), spc: () => this.loadSpc(), quakes: () => this.loadQuakes(), tropical: () => this.loadTropical(), reports: () => this.loadReports(), rivers: () => this.loadRivers(), fires: () => this.loadFires(), watch: () => this.loadWatch() }[k];
      if (fn) await fn();
    }
    // radar
    async loadRadar() {
      const d = await api('/api/radar'); const r = this.radar;
      r.host = d.host; r.frames = [...d.radar.past, ...d.radar.nowcast.map(f => ({ ...f, nowcast: true }))]; r.template = d.tile_template; r.satFrames = d.satellite.infrared; r.satTemplate = d.satellite_template;
      if (!r.frames.length) return;
      r.idx = d.radar.past.length - 1; this.showFrame();
      if (this.opts.mini) { r.playing = true; this.play(); }
      this.renderTimebar();
    }
    tileUrl(f) { const r = this.radar; return r.template.replace('{host}', r.host).replace('{path}', f.path).replace('{color}', r.color).replace('{options}', '1_1'); }
    showFrame() {
      const r = this.radar; const f = r.frames[r.idx]; if (!f) return;
      const next = this.L.tileLayer(this.tileUrl(f), { opacity: 0, maxNativeZoom: 10, maxZoom: 18, zIndex: 400 });
      next.addTo(this.groups.radar);
      next.once('load', () => { next.setOpacity(r.opacity); if (r.layer && r.layer !== next) this.groups.radar.removeLayer(r.layer); r.layer = next; });
      setTimeout(() => { next.setOpacity(r.opacity); if (r.layer && r.layer !== next) this.groups.radar.removeLayer(r.layer); r.layer = next; }, 900);
      const tb = $('#map-timebar'); if (tb && !this.opts.mini) { const lab = $('#tb-label'); const rng = $('#tb-range'); if (lab) lab.innerHTML = `${f.nowcast ? '<span class="stale">nowcast</span> ' : ''}${fmt.clock(f.time)}`; if (rng) rng.value = r.idx; }
    }
    play() { const r = this.radar; clearInterval(r.timer); if (!r.playing) return; r.timer = setInterval(() => { r.idx = (r.idx + 1) % r.frames.length; this.showFrame(); }, r.idx === r.frames.length - 1 ? 1600 : 520); }
    renderTimebar() {
      if (this.opts.mini) return; const r = this.radar; const tb = $('#map-timebar'); if (!tb) return;
      tb.innerHTML = `<button class="small" id="tb-play">${r.playing ? '❚❚' : '▶'}</button><input type="range" id="tb-range" min="0" max="${r.frames.length - 1}" value="${r.idx}"><span id="tb-label">${fmt.clock(r.frames[r.idx].time)}</span><span class="dim">· ${r.frames.length} frames · ${fmt.clock(r.frames[0].time)} → ${fmt.clock(r.frames[r.frames.length - 1].time)}${r.frames.some(f => f.nowcast) ? ' (incl. nowcast)' : ''}</span>`;
      $('#tb-play').onclick = () => { r.playing = !r.playing; $('#tb-play').textContent = r.playing ? '❚❚' : '▶'; this.play(); };
      $('#tb-range').oninput = e => { r.playing = false; $('#tb-play').textContent = '▶'; clearInterval(r.timer); r.idx = +e.target.value; this.showFrame(); };
    }
    async loadSatellite() {
      if (!this.radar.satFrames) await api('/api/radar').then(d => { this.radar.host = d.host; this.radar.satFrames = d.satellite.infrared; this.radar.satTemplate = d.satellite_template; });
      const f = this.radar.satFrames[this.radar.satFrames.length - 1]; if (!f) return;
      this.groups.satellite.clearLayers();
      this.L.tileLayer(this.radar.satTemplate.replace('{host}', this.radar.host).replace('{path}', f.path), { opacity: 0.55, maxNativeZoom: 7, maxZoom: 18 }).addTo(this.groups.satellite);
    }
    // alerts
    async loadAlerts() {
      const d = await api('/api/alerts/geojson'); const g = this.groups.alerts; g.clearLayers();
      const fam = this.alertFilter;
      const keep = p => fam === 'all' ? true : fam === 'severe' ? /Tornado|Severe Thunderstorm|Extreme Wind/.test(p.event) : fam === 'flood' ? /Flood/.test(p.event) : fam === 'winter' ? /Winter|Blizzard|Ice|Snow|Freez|Cold|Chill/.test(p.event) : fam === 'tropical' ? /Hurricane|Tropical|Surge/.test(p.event) : fam === 'fire' ? /Red Flag|Fire/.test(p.event) : fam === 'heat' ? /Heat/.test(p.event) : fam === 'warnings' ? /Warning/.test(p.event) : true;
      this.L.geoJSON(d, {
        filter: f => keep(f.properties),
        style: f => ({ color: f.properties.color, weight: /Tornado Warning/.test(f.properties.event) ? 2.5 : 1.2, fillColor: f.properties.color, fillOpacity: /Warning/.test(f.properties.event) ? 0.32 : 0.14 }),
        onEachFeature: (f, l) => { const p = f.properties; l.bindPopup(`<b style="color:${esc(p.color)}">${esc(p.event)}</b><br>${esc(p.area)}<br><span class="dim">${esc(p.headline || '')}</span><br>${p.tornado_detection ? `<b>${esc(p.tornado_detection)}</b> · ` : ''}${fmt.until(p.expires)}<br><a href="#" data-open="${esc(p.id)}">details →</a>`); l.on('popupopen', e => { const a = e.popup.getElement().querySelector('[data-open]'); if (a) a.onclick = ev => { ev.preventDefault(); openAlert(a.dataset.open); }; }); },
      }).addTo(g);
      // pulse markers on tornado warnings
      for (const f of d.features) if (/Tornado Warning/.test(f.properties.event)) { const c = centroid(f.geometry); if (c) this.L.marker(c, { icon: this.L.divIcon({ className: '', html: '<div class="pulse-marker"></div>', iconSize: [14, 14] }), interactive: false }).addTo(g); }
    }
    async loadSpc() {
      const d = await api(`/api/spc/outlook?day=${this.spcDay}`); const g = this.groups.spc; g.clearLayers();
      const cat = d.layers.cat; if (!cat || !cat.features) return;
      this.L.geoJSON(cat, { style: f => ({ color: f.properties.color, weight: 1.5, fillColor: f.properties.color, fillOpacity: 0.18, dashArray: '4 3' }), onEachFeature: (f, l) => l.bindPopup(`<b>SPC Day ${d.day}: ${esc(f.properties.label2 || f.properties.label)}</b><br>valid ${spcTime(f.properties.valid)} → ${spcTime(f.properties.expire)}`), interactive: !this.opts.mini }).addTo(g);
      const torn = d.layers.torn; if (torn && torn.features && torn.features.length) this.L.geoJSON(torn, { style: f => ({ color: '#FF2D2D', weight: 1, fillColor: '#FF2D2D', fillOpacity: 0.08 }), onEachFeature: (f, l) => l.bindPopup(`Tornado probability ${esc(f.properties.label2 || f.properties.label)}`) }).addTo(g);
    }
    async loadQuakes() {
      const d = await api(`/api/quakes?feed=${this.quakeFeed}&limit=800`); const g = this.groups.quakes; g.clearLayers();
      for (const q of d.quakes) this.L.circleMarker([q.lat, q.lon], { radius: Math.max(3, (q.mag || 1) * 2.2), color: q.color, weight: 1, fillColor: q.color, fillOpacity: 0.55 }).bindPopup(`<b>M${(q.mag || 0).toFixed(1)}</b> ${esc(q.place)}<br>${fmt.time(q.time)} · depth ${q.depth_km != null ? q.depth_km.toFixed(0) : '?'} km${q.tsunami ? '<br><b>tsunami flag</b>' : ''}<br><a href="${esc(q.url)}" target="_blank" rel="noopener">USGS →</a>`).addTo(g);
    }
    async loadTropical() {
      const d = await api('/api/tropical'); const g = this.groups.tropical; g.clearLayers();
      for (const s of d.storms) { if (s.lat == null) continue; const col = s.category ? s.category.color : '#5F9EA0'; this.L.circleMarker([s.lat, s.lon], { radius: 9, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: 0.95 }).bindTooltip(`${s.classification || ''} ${s.name}`, { permanent: true, direction: 'right', className: 'storm-label' }).bindPopup(`<b>${esc(s.classification || '')} ${esc(s.name)}</b> — ${s.category ? esc(s.category.label) : ''}<br>${fmt.n(s.wind_mph)} mph · ${fmt.n(s.pressure_mb)} mb<br>moving ${esc(s.movement.compass || '')} ${fmt.n(s.movement.speed_mph)} mph<br>${s.products.advisory ? `<a href="${esc(s.products.advisory)}" target="_blank" rel="noopener">advisory →</a>` : ''}`).addTo(g); }
    }
    async loadReports() {
      const d = await api('/api/spc/reports'); const g = this.groups.reports; g.clearLayers();
      for (const r of d.reports) { const col = r.kind === 'tornado' ? '#FF2D2D' : r.kind === 'hail' ? '#5EB3F6' : '#F2B134'; this.L.circleMarker([r.lat, r.lon], { radius: r.kind === 'tornado' ? 6 : 4, color: col, weight: 1, fillColor: col, fillOpacity: 0.8 }).bindPopup(`<b>${esc(r.kind)}</b> ${esc(r.magnitude || '')} · ${esc(r.time_z)}Z<br>${esc(r.location)}, ${esc(r.county)} ${esc(r.state)}<br><span class="dim">${esc(r.comments)}</span>`).addTo(g); }
    }
    async loadRivers() {
      const d = await api('/api/rivers?min=action'); const g = this.groups.rivers; g.clearLayers();
      for (const r of d.gauges) this.L.circleMarker([r.lat, r.lon], { radius: 4 + r.observed.rank, color: '#fff', weight: 0.5, fillColor: r.observed.color, fillOpacity: 0.9 }).bindPopup(`<b>${esc(r.name)}</b> (${esc(r.id)})<br>${esc(r.observed.category)} · ${fmt.n(r.observed.stage)} ${esc(r.observed.unit || 'ft')}${r.forecast ? `<br>forecast ${fmt.n(r.forecast.stage)} ${esc(r.forecast.category || '')}` : ''}<br><a href="${esc(r.url)}" target="_blank" rel="noopener">NWPS →</a>`).addTo(g);
    }
    async loadFires() {
      const d = await api('/api/fires'); const g = this.groups.fires; g.clearLayers();
      for (const i of d.inciweb.incidents) if (i.lat != null) this.L.circleMarker([i.lat, i.lon], { radius: i.acres ? Math.min(14, 4 + Math.log10(i.acres + 1) * 2) : 5, color: '#FF3B8D', weight: 1, fillColor: '#FF3B8D', fillOpacity: 0.6 }).bindPopup(`<b>${esc(i.title)}</b><br>${i.acres != null ? `${i.acres.toLocaleString()} acres` : ''}${i.contained_pct != null ? ` · ${i.contained_pct}% contained` : ''}<br><a href="${esc(i.link)}" target="_blank" rel="noopener">InciWeb →</a>`).addTo(g);
      for (const h of (d.firms && d.firms.hotspots) || []) this.L.circleMarker([h.lat, h.lon], { radius: 2, color: '#FF6A00', weight: 0, fillColor: '#FF6A00', fillOpacity: 0.7, interactive: false }).addTo(g);
    }
    async loadWatch() {
      const d = await api('/api/watch'); const g = this.groups.watch; g.clearLayers();
      for (const l of d.locations) this.L.circleMarker([l.lat, l.lon], { radius: 4, color: '#9ED8FF', weight: 1.5, fillColor: '#111', fillOpacity: 0.9 }).bindTooltip(l.label, { direction: 'top' }).on('click', () => { setLoc(l); show('forecast'); }).addTo(g);
    }
    pointPopup(ll) {
      if (this.opts.mini) return;
      const lat = +ll.lat.toFixed(4), lon = +ll.lng.toFixed(4);
      const p = this.L.popup().setLatLng(ll).setContent(`<b>${lat}, ${lon}</b><br><a href="#" id="pp-fc">forecast here →</a><br><a href="#" id="pp-br">briefing here →</a><br><span class="dim" id="pp-al">checking alerts…</span>`).openOn(this.map);
      setTimeout(() => { const fc = $('#pp-fc'), br = $('#pp-br'); if (fc) fc.onclick = e => { e.preventDefault(); setLoc({ lat, lon, label: `${lat}, ${lon}` }); show('forecast'); }; if (br) br.onclick = e => { e.preventDefault(); setLoc({ lat, lon, label: `${lat}, ${lon}` }); show('briefing'); }; }, 0);
      api(`/api/alerts?lat=${lat}&lon=${lon}&limit=6`).then(d => { const a = $('#pp-al'); if (a) a.innerHTML = d.alerts.length ? d.alerts.map(x => `<span style="color:${esc(x.color)}">■</span> ${esc(x.event)}`).join('<br>') : 'no polygon alerts here'; }).catch(() => {});
    }
  }
  function centroid(geom) { if (!geom) return null; let n = 0, la = 0, lo = 0; const walk = c => { if (typeof c[0] === 'number') { lo += c[0]; la += c[1]; n++; } else c.forEach(walk); }; walk(geom.coordinates); return n ? [la / n, lo / n] : null; }

  async function mapReady() {
    const L = await loadLeaflet();
    if (!S.map) {
      S.map = new WeatherMap(L, 'mapcanvas', { center: [38.5, -96.5], zoom: 4, spc: false, quakes: false, reports: false, rivers: false, fires: false });
      renderLayerPanel();
      clearInterval(S.timers.map); S.timers.map = setInterval(() => { if (S.view === 'map') S.map.refreshAll(); }, 3 * 60 * 1000);
    }
    setTimeout(() => S.map.map.invalidateSize(), 50);
    return S.map;
  }
  function renderLayerPanel() {
    const m = S.map; const p = $('#map-layers');
    p.innerHTML = `
      <div class="sec">basemap</div><select id="ly-base">${Object.entries(BASEMAPS).map(([k, b]) => `<option value="${k}" ${m.baseKey === k ? 'selected' : ''}>${b.label}</option>`).join('')}</select>
      <div class="sec">imagery</div>
      <label><input type="checkbox" data-layer="radar" ${m.on.radar ? 'checked' : ''}> radar (animated)</label>
      <select id="ly-color"><option value="6" ${m.radar.color === '6' ? 'selected' : ''}>NEXRAD palette</option><option value="4" ${m.radar.color === '4' ? 'selected' : ''}>universal blue</option><option value="2" ${m.radar.color === '2' ? 'selected' : ''}>classic</option><option value="7" ${m.radar.color === '7' ? 'selected' : ''}>rainbow</option></select>
      <label><input type="checkbox" data-layer="satellite" ${m.on.satellite ? 'checked' : ''}> satellite IR</label>
      <div class="sec">hazards</div>
      <label><input type="checkbox" data-layer="alerts" ${m.on.alerts ? 'checked' : ''}> NWS alerts</label>
      <select id="ly-alertfam"><option value="all">every alert</option><option value="warnings">warnings only</option><option value="severe">tornado · severe t-storm</option><option value="flood">flood</option><option value="winter">winter</option><option value="tropical">tropical · surge</option><option value="fire">fire weather</option><option value="heat">heat</option></select>
      <label><input type="checkbox" data-layer="spc" ${m.on.spc ? 'checked' : ''}> SPC outlook</label>
      <select id="ly-spcday"><option value="1">day 1</option><option value="2">day 2</option><option value="3">day 3</option></select>
      <label><input type="checkbox" data-layer="reports" ${m.on.reports ? 'checked' : ''}> storm reports today</label>
      <label><input type="checkbox" data-layer="tropical" ${m.on.tropical ? 'checked' : ''}> tropical systems</label>
      <label><input type="checkbox" data-layer="quakes" ${m.on.quakes ? 'checked' : ''}> earthquakes</label>
      <select id="ly-qfeed"><option value="all_day">all · 24h</option><option value="2.5_day" selected>M2.5+ · 24h</option><option value="2.5_week">M2.5+ · 7d</option><option value="4.5_week">M4.5+ · 7d</option></select>
      <label><input type="checkbox" data-layer="rivers" ${m.on.rivers ? 'checked' : ''}> rivers in flood</label>
      <label><input type="checkbox" data-layer="fires" ${m.on.fires ? 'checked' : ''}> wildfire incidents</label>
      <label><input type="checkbox" data-layer="watch" ${m.on.watch ? 'checked' : ''}> watched locations</label>
      <div class="sec">radar opacity</div><input type="range" id="ly-op" min="0.2" max="1" step="0.05" value="${m.radar.opacity}" style="width:100%">`;
    $('#ly-base').onchange = e => m.setBasemap(e.target.value);
    $$('[data-layer]', p).forEach(cb => { cb.onchange = () => m.setLayer(cb.dataset.layer, cb.checked); });
    $('#ly-color').onchange = e => { m.radar.color = e.target.value; localStorage.setItem('wc_radar_color', e.target.value); m.groups.radar.clearLayers(); m.radar.layer = null; m.showFrame(); };
    $('#ly-alertfam').onchange = e => { m.alertFilter = e.target.value; m.loadAlerts(); };
    $('#ly-spcday').onchange = e => { m.spcDay = +e.target.value; if (m.on.spc) m.loadSpc(); };
    $('#ly-qfeed').onchange = e => { m.quakeFeed = e.target.value; if (m.on.quakes) m.loadQuakes(); };
    $('#ly-op').oninput = e => { m.radar.opacity = +e.target.value; if (m.radar.layer) m.radar.layer.setOpacity(m.radar.opacity); };
    $('#map-legend').innerHTML = [['#FF0000', 'tornado warn'], ['#FFA500', 'severe t-storm'], ['#8B0000', 'flash flood'], ['#FF69B4', 'winter storm'], ['#DC143C', 'hurricane'], ['#FF1493', 'red flag'], ['#C71585', 'extreme heat'], ['#FFFF00', 'tornado watch']].map(([c, l]) => `<span class="i"><span class="c" style="background:${c}"></span>${l}</span>`).join('') + '<br><span class="dim">click the map for a point forecast · polygons open details</span>';
  }
  views.map = async () => { await mapReady(); };

  // Small embedded maps (NOW, SEVERE, QUAKES, WATER).
  async function miniMap(id = 'minimap', opts = {}) {
    const L = await loadLeaflet();
    const node = $(`#${id}`); if (!node) return null;
    const m = new WeatherMap(L, id, { mini: true, zoom: 3, center: [38, -96], radar: true, alerts: true, tropical: true, ...opts });
    node.style.cursor = 'pointer'; node.addEventListener('dblclick', () => show('map'));
    setTimeout(() => m.map.invalidateSize(), 50);
    return m;
  }

  // ─── Go ────────────────────────────────────────────────────────────
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (v && v !== S.view && views[v]) show(v); });
  if (!S.token) showAuth('');
  else api('/api/status').then(() => { $('#main').classList.remove('hidden'); boot(); }).catch(e => showAuth(e.status === 401 ? 'token rejected' : e.message));
})();
