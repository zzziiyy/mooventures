// ─── DB INIT (safe — runs after scripts load) ─
let db;
window.addEventListener('DOMContentLoaded', () => {
  try {
    const _url = SUPABASE_URL.trim().replace(/\/$/, '');
    const _key = SUPABASE_ANON_KEY.trim();
    if (_url === 'YOUR_SUPABASE_URL' || _key === 'YOUR_SUPABASE_ANON_KEY') {
      document.getElementById('auth-error').textContent = 'App not configured yet — please add your Supabase keys to js/config.js and redeploy.';
      document.getElementById('auth-error').style.display = 'block';
      return;
    }
    db = supabase.createClient(_url, _key, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, lock: (_n, _t, fn) => fn() }
    });
    // Also patch directly — the constructor option is ignored in some CDN builds
    // because the UMD bundle checks options keys strictly. Direct assignment always works.
    if (db.auth) db.auth.lock = (_n, _t, fn) => fn();
    db.auth.onAuthStateChange(async (event, session) => {
      if (session?.user) {
        currentUser = session.user;
        document.getElementById('auth-screen').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        await loadUserProfile();
        await loadTrips();
        await loadBuddies();
        await loadRoutes();
        initMap();
        renderStats();
        renderBuddyStats();
      } else {
        document.getElementById('auth-screen').style.display = 'flex';
        document.getElementById('app').style.display = 'none';
      }
    });
  } catch(e) {
    document.getElementById('auth-error').textContent = 'Setup error: ' + e.message;
    document.getElementById('auth-error').style.display = 'block';
  }
});

// ─── STATE ───────────────────────────────────
let currentUser = null;
let trips = [];
let buddies = [];
let messages = [];
let routes = [];
let currentTripId = null;
let currentWPs = [];
let statPeriod = 'month';
let searchTimer = null;
let originSearchTimer = null;
let atOrigin = null;
let atStep = 0;
let atDest = null;
let atFrom = null;
let atTo = null;
let atTransport = 'Flight';
let atSelFrom = true;
let calY = new Date().getFullYear();
let calM = new Date().getMonth();

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS = ['Mo','Tu','We','Th','Fr','Sa','Su'];
const TMAP = {Flight:'✈ Flight',Train:'🚂 Train',Car:'🚗 Car',Bus:'🚌 Bus',Ferry:'🚢 Ferry'};
const COLORS = ['#7c5c2e','#0f766e','#be4a6b','#6d4ab7','#b45309','#2563eb'];

// ─── AUTH ─────────────────────────────────────
function showAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('login-form').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? 'block' : 'none';
  document.getElementById('auth-error').style.display = 'none';
}

async function signIn() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  if (!email || !password) return showAuthError('Please fill in all fields');
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) showAuthError(error.message);
}

async function signUp() {
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  if (!name || !email || !password) return showAuthError('Please fill in all fields');
  if (password.length < 6) return showAuthError('Password must be at least 6 characters');
  if (!db) return showAuthError('App not initialised — check your Supabase keys in config.js');
  try {
    const { data, error } = await db.auth.signUp({ email, password, options: { data: { name } } });
    if (error) return showAuthError(error.message + ' (code: ' + (error.status||'?') + ')');
    if (data.user) {
      await db.from('profiles').upsert({ id: data.user.id, name, email, moo_code: generateMooCode() });
    } else {
      showAuthError('Account created — check your email to confirm, then sign in.');
    }
  } catch(e) {
    showAuthError('Unexpected error: ' + e.message);
  }
}

function showAuthError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.style.display = 'block';
}

async function signOut() {
  await db.auth.signOut();
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = 'flex';
}

function generateMooCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'MOO-' + Array.from({length:4},()=>chars[Math.floor(Math.random()*chars.length)]).join('') +
    '-' + Array.from({length:2},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}

// ─── INIT (handled in DOMContentLoaded above) ─

async function loadUserProfile() {
  let { data } = await db.from('profiles').select('*').eq('id', currentUser.id).single();
  if (!data) {
    // Profile missing — create it now. Happens when email confirmation is required
    // and the signUp() upsert was skipped because data.user was null at that point.
    const name = currentUser.user_metadata?.name || currentUser.email?.split('@')[0] || 'Traveller';
    const { data: created } = await db.from('profiles')
      .upsert({ id: currentUser.id, name, email: currentUser.email, moo_code: generateMooCode() })
      .select().single();
    data = created;
  }
  if (data) {
    const initials = data.name ? data.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2) : '?';
    document.getElementById('user-av').textContent = initials;
    document.getElementById('user-name').textContent = data.name || currentUser.email;
    document.getElementById('moo-code-display').textContent = data.moo_code || '';
    if (!data.moo_code) {
      const code = generateMooCode();
      await db.from('profiles').update({ moo_code: code }).eq('id', currentUser.id);
      document.getElementById('moo-code-display').textContent = code;
    }
    renderMooQR(data.moo_code || '');
  }
}

// ─── PANEL SWITCHING ──────────────────────────
function showPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.ni, .bn-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.querySelectorAll(`[data-panel="${name}"]`).forEach(n => n.classList.add('active'));
  if (name === 'stats') renderStats();
  if (name === 'route') renderCityMap();
  if (name === 'map') { if (!window._mapSvg) initMap(); else refreshMapPins(); }
}

// ─── WORLD MAP ────────────────────────────────
let _worldCache = null;

function initMap() {
  const container = document.getElementById('map-area');
  const W = container.offsetWidth;
  const H = container.offsetHeight || 400;
  const svg = d3.select('#world-svg');
  svg.attr('viewBox', `0 0 ${W} ${H}`).attr('preserveAspectRatio','xMidYMid meet');
  svg.append('rect').attr('width',W).attr('height',H).attr('fill','#d4e8f5');

  const proj = d3.geoNaturalEarth1().scale(W/6.2).translate([W/2, H/2]);
  const path = d3.geoPath(proj);
  const tip = document.getElementById('map-tooltip');

  const renderWorld = (world) => {
    svg.append('path').datum(d3.geoGraticule()()).attr('d',path)
      .attr('fill','none').attr('stroke','rgba(176,200,224,0.35)').attr('stroke-width',0.4);
    svg.append('g').selectAll('path')
      .data(topojson.feature(world, world.objects.countries).features)
      .join('path').attr('d',path).attr('fill','#c8d8b0').attr('stroke','#a0b88a').attr('stroke-width',0.4);
    svg.append('path')
      .datum(topojson.mesh(world, world.objects.countries,(a,b)=>a!==b))
      .attr('d',path).attr('fill','none').attr('stroke','#a0b88a').attr('stroke-width',0.5);
    window._mapProj = proj;
    window._mapPath = path;
    window._mapSvg = svg;
    window._mapTip = tip;
    window._mapContainer = container;
    refreshMapPins();
  };

  if (_worldCache) {
    renderWorld(_worldCache);
    return;
  }

  d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json').then(world => {
    _worldCache = world;
    renderWorld(world);
  }).catch(() => {
    document.getElementById('map-stat').textContent = 'Map needs internet connection';
  });
}

function refreshMapPins() {
  if (!window._mapSvg) return;
  const svg = window._mapSvg;
  const proj = window._mapProj;
  const tip = window._mapTip;
  const container = window._mapContainer;

  svg.selectAll('.trip-pin').remove();
  svg.selectAll('.trip-arc').remove();

  const pinned = trips.filter(t => t.lat && t.lon);
  pinned.forEach((t, i) => {
    const [px, py] = proj([t.lon, t.lat]);
    const color = COLORS[i % COLORS.length];
    const g = svg.append('g').attr('class','trip-pin').attr('transform',`translate(${px},${py})`).style('cursor','pointer');
    g.append('circle').attr('r',9).attr('fill',color).attr('opacity',.15);
    g.append('circle').attr('r',6).attr('fill',color).attr('opacity',.9);
    g.append('circle').attr('r',2.8).attr('fill','#fff');
    g.on('mousemove', ev => {
      const r = container.getBoundingClientRect();
      tip.style.left = (ev.clientX-r.left+10)+'px';
      tip.style.top = (ev.clientY-r.top-30)+'px';
      tip.style.opacity = 1;
      tip.textContent = `${t.city}, ${t.country}`;
    }).on('mouseleave', () => { tip.style.opacity = 0; });
  });

  const stat = pinned.length > 0
    ? `${pinned.length} place${pinned.length>1?'s':''} · ${[...new Set(pinned.map(t=>t.country))].length} countries`
    : 'No trips yet — add your first one!';
  document.getElementById('map-stat').textContent = stat;

  renderPlacesList();
}

// ─── TRIPS ────────────────────────────────────
async function loadTrips() {
  const { data } = await db.from('trips').select('*').eq('user_id', currentUser.id).order('date_from', { ascending: false });
  trips = data || [];
  renderLog();
  renderPlacesList();
  renderChatGroups();
  renderBuddyChipsInModal();
  populateYearFilter();
  refreshMapPins();
}

function renderPlacesList() {
  const el = document.getElementById('places-list');
  if (!trips.length) { el.innerHTML = '<div class="empty-state">No trips yet.<br>Add your first one!</div>'; return; }
  el.innerHTML = trips.slice(0,8).map(t => `
    <div class="place-card">
      <div class="place-card-t">${t.flag||'🌍'} ${t.city}, ${t.country}</div>
      <div class="place-card-s">${formatDate(t.date_from)} · ${dayCount(t.date_from,t.date_to)} days</div>
      <div class="place-card-tags">
        <span class="tag tg-b">${t.distance_km||0} km</span>
        <span class="tag tg-g">${TMAP[t.transport]||t.transport||'✈'}</span>
      </div>
    </div>`).join('');
}

function populateYearFilter() {
  const years = [...new Set(trips.map(t => new Date(t.date_from).getFullYear()))].sort((a,b)=>b-a);
  const sel = document.getElementById('log-year-filter');
  sel.innerHTML = '<option value="">All years</option>' + years.map(y=>`<option value="${y}">${y}</option>`).join('');
}

function renderLog() {
  const el = document.getElementById('log-list');
  const yearF = document.getElementById('log-year-filter')?.value;
  const transF = document.getElementById('log-transport-filter')?.value;
  let filtered = trips;
  if (yearF) filtered = filtered.filter(t => new Date(t.date_from).getFullYear() == yearF);
  if (transF) filtered = filtered.filter(t => t.transport === transF);
  if (!filtered.length) { el.innerHTML = '<div class="empty-state" style="margin-top:40px">No trips match your filter</div>'; return; }
  el.innerHTML = filtered.map(t => {
    const d = new Date(t.date_from);
    return `<div class="log-entry">
      <div><div class="le-day">${d.getDate()}</div><div class="le-mon">${MONTHS[d.getMonth()].slice(0,3)}</div></div>
      <div>
        <div style="font-size:13px;font-weight:500">${t.from_city?`<span style="color:var(--muted);font-weight:400;font-size:11px">${t.from_city} → </span>`:''}${t.flag||'🌍'} ${t.city}, ${t.country}</div>
        <div class="le-meta">
          <span><i class="ti ti-calendar" style="font-size:11px"></i>${dayCount(t.date_from,t.date_to)} days</span>
          ${t.buddies?.length ? `<span><i class="ti ti-users" style="font-size:11px"></i>${t.buddies.join(', ')}</span>` : '<span><i class="ti ti-user" style="font-size:11px"></i>Solo</span>'}
          <span><i class="ti ti-map" style="font-size:11px"></i>${t.transport||'—'}</span>
        </div>
        <div class="le-badges">
          <span class="tag tg-br">${new Date(t.date_from).getFullYear()}</span>
          ${t.notes ? `<span class="tag tg-g">Has notes</span>` : ''}
        </div>
        <div class="le-actions">
          <button class="btn-sm del" onclick="deleteTrip('${t.id}')"><i class="ti ti-trash" style="font-size:11px"></i> Delete</button>
        </div>
      </div>
      <div class="le-km">+${t.distance_km||0} km</div>
    </div>`;
  }).join('');
}

function deleteTrip(id) {
  if (!confirm('Delete this trip?')) return;
  let settled = false;
  const done = (err) => {
    if (settled) return; settled = true;
    if (err) { alert('Delete failed: ' + err); return; }
    trips = trips.filter(t => t.id !== id);
    renderLog(); renderPlacesList(); renderStats(); refreshMapPins(); renderChatGroups();
  };
  const tid = setTimeout(() => done('Request timed out — please reload the page and try again.'), 10000);
  db.from('trips').delete().eq('id', id)
    .then(({ error }) => { clearTimeout(tid); done(error?.message || null); })
    .catch(e => { clearTimeout(tid); done(e.message); });
}

// ─── ADD TRIP MODAL ───────────────────────────
const MSTEP_TITLES = ['Where did you go?','When did you go?','How did you travel?','All set!'];
const MSTEP_SUBS = ['Set your departure and destination','Tap departure then return date','Transport & travel buddies','Review and save your trip'];

function openAddTrip() {
  atStep=0; atOrigin=null; atDest=null; atFrom=null; atTo=null; atTransport='Flight'; atSelFrom=true; atBuddies=[];
  clearCitySearch();
  clearOriginSearch();
  for(let i=0;i<4;i++) document.getElementById('msd'+i).className='msd'+(i===0?' active':'');
  document.querySelectorAll('.step-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('mstep0').classList.add('active');
  document.getElementById('at-title').textContent=MSTEP_TITLES[0];
  document.getElementById('at-sub').textContent=MSTEP_SUBS[0];
  document.getElementById('at-hint').textContent='Step 1 of 4';
  document.getElementById('at-back').style.visibility='hidden';
  const nn = document.getElementById('at-next');
  nn.disabled=true;
  nn.innerHTML='Next <i class="ti ti-arrow-right" style="font-size:13px"></i>';
  nn.onclick = () => atNav(1);
  document.querySelectorAll('.tb').forEach(b=>b.classList.remove('sel'));
  document.querySelector('.tb').classList.add('sel');
  document.getElementById('trip-notes').value='';
  document.getElementById('add-trip-modal').classList.add('open');
  initCitySearch();
  initOriginSearch();
}

function closeAddTrip() { document.getElementById('add-trip-modal').classList.remove('open'); }

function getFlag(cc) {
  if (!cc) return '🌍';
  return cc.toUpperCase().replace(/./g, c => String.fromCodePoint(c.charCodeAt(0)+127397));
}

const cityInpEl = () => document.getElementById('city-inp');
const sugWrapEl = () => document.getElementById('sug-wrap');
const selWrapEl = () => document.getElementById('sel-wrap');

function initCitySearch() {
  const inp = document.getElementById('city-inp');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const v = inp.value.trim();
    document.getElementById('city-clear').style.display = v ? 'block' : 'none';
    if (v.length < 2) { sugWrapEl().innerHTML = ''; return; }
    sugWrapEl().innerHTML = `<div class="suggest-list"><div class="status-row"><div class="spinner"></div>Searching…</div></div>`;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchCities(v), 350);
  });
}

async function searchCities(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6&featuretype=city&accept-language=en`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (!data.length) { sugWrapEl().innerHTML = `<div class="suggest-list"><div class="status-row">No cities found for "${q}"</div></div>`; return; }
    const seen = new Set();
    const items = data.filter(d => {
      const k = (d.address.city||d.address.town||d.address.village||d.name)+','+(d.address.country||'');
      if (seen.has(k)) return false; seen.add(k); return true;
    }).slice(0,5);
    sugWrapEl().innerHTML = `<div class="suggest-list">${items.map((d,i) => {
      const city = d.address.city||d.address.town||d.address.village||d.name;
      const country = d.address.country||'';
      const flag = getFlag(d.address.country_code||'');
      const type = d.type||d.class||'city';
      return `<div class="sug-item" onclick="pickCity(${i})"><span class="sug-flag">${flag}</span><div><div class="sug-city">${city}</div><div class="sug-country">${country}</div></div><span class="sug-type">${type}</span></div>`;
    }).join('')}</div>`;
    sugWrapEl()._data = items;
  } catch(e) {
    sugWrapEl().innerHTML = `<div class="suggest-list"><div class="status-row"><i class="ti ti-wifi-off" style="font-size:15px"></i> Search needs internet</div></div>`;
  }
}

function pickCity(i) {
  const d = (sugWrapEl()._data||[])[i]; if (!d) return;
  const city = d.address.city||d.address.town||d.address.village||d.name;
  const country = d.address.country||'';
  const cc = d.address.country_code||'';
  const flag = getFlag(cc);
  const lat = parseFloat(d.lat);
  const lon = parseFloat(d.lon);
  atDest = { city, country, flag, lat, lon };
  cityInpEl().style.display = 'none';
  document.getElementById('city-clear').style.display = 'none';
  sugWrapEl().innerHTML = '';
  selWrapEl().innerHTML = `<div class="sel-place"><span class="sp-flag">${flag}</span><div><div class="sp-name">${city}, ${country}</div><div class="sp-ctry">Destination</div></div><span class="sp-chg" onclick="clearCitySearch()">Change</span></div>`;
  document.getElementById('at-next').disabled = !atOrigin;
}

function clearCitySearch() {
  atDest = null;
  cityInpEl().style.display = '';
  cityInpEl().value = '';
  document.getElementById('city-clear').style.display = 'none';
  sugWrapEl().innerHTML = '';
  selWrapEl().innerHTML = '';
  document.getElementById('at-next').disabled = true;
  setTimeout(() => cityInpEl().focus(), 50);
}

const originInpEl = () => document.getElementById('origin-inp');
const originSugEl = () => document.getElementById('origin-sug-wrap');
const originSelEl = () => document.getElementById('origin-sel-wrap');

function initOriginSearch() {
  const inp = document.getElementById('origin-inp');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const v = inp.value.trim();
    document.getElementById('origin-clear').style.display = v ? 'block' : 'none';
    if (v.length < 2) { originSugEl().innerHTML = ''; return; }
    originSugEl().innerHTML = `<div class="suggest-list"><div class="status-row"><div class="spinner"></div>Searching…</div></div>`;
    clearTimeout(originSearchTimer);
    originSearchTimer = setTimeout(() => searchOriginCities(v), 350);
  });
}

async function searchOriginCities(q) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=6&featuretype=city&accept-language=en`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (!data.length) { originSugEl().innerHTML = `<div class="suggest-list"><div class="status-row">No cities found for "${q}"</div></div>`; return; }
    const seen = new Set();
    const items = data.filter(d => {
      const k = (d.address.city||d.address.town||d.address.village||d.name)+','+(d.address.country||'');
      if (seen.has(k)) return false; seen.add(k); return true;
    }).slice(0,5);
    originSugEl().innerHTML = `<div class="suggest-list">${items.map((d,i) => {
      const city = d.address.city||d.address.town||d.address.village||d.name;
      const country = d.address.country||'';
      const flag = getFlag(d.address.country_code||'');
      const type = d.type||d.class||'city';
      return `<div class="sug-item" onclick="pickOrigin(${i})"><span class="sug-flag">${flag}</span><div><div class="sug-city">${city}</div><div class="sug-country">${country}</div></div><span class="sug-type">${type}</span></div>`;
    }).join('')}</div>`;
    originSugEl()._data = items;
  } catch(e) {
    originSugEl().innerHTML = `<div class="suggest-list"><div class="status-row"><i class="ti ti-wifi-off" style="font-size:15px"></i> Search needs internet</div></div>`;
  }
}

function pickOrigin(i) {
  const d = (originSugEl()._data||[])[i]; if (!d) return;
  const city = d.address.city||d.address.town||d.address.village||d.name;
  const country = d.address.country||'';
  const flag = getFlag(d.address.country_code||'');
  atOrigin = { city, country, flag, lat: parseFloat(d.lat), lon: parseFloat(d.lon) };
  originInpEl().style.display = 'none';
  document.getElementById('origin-clear').style.display = 'none';
  originSugEl().innerHTML = '';
  originSelEl().innerHTML = `<div class="sel-place"><span class="sp-flag">${flag}</span><div><div class="sp-name">${city}, ${country}</div><div class="sp-ctry">Departure</div></div><span class="sp-chg" onclick="clearOriginSearch()">Change</span></div>`;
  document.getElementById('at-next').disabled = !atDest;
  setTimeout(() => cityInpEl().focus(), 50);
}

function clearOriginSearch() {
  atOrigin = null;
  const inp = document.getElementById('origin-inp');
  if (inp) {
    inp.style.display = '';
    inp.value = '';
    document.getElementById('origin-clear').style.display = 'none';
    document.getElementById('origin-sug-wrap').innerHTML = '';
    document.getElementById('origin-sel-wrap').innerHTML = '';
  }
  document.getElementById('at-next').disabled = true;
}

function setSelFrom(v) {
  atSelFrom = v;
  document.getElementById('cal-lbl').textContent = v ? 'Select departure date' : 'Select return date';
  document.getElementById('dc-from').className = 'date-chip' + (v?' active':'');
  document.getElementById('dc-to').className = 'date-chip' + (!v?' active':'');
}

function renderCal() {
  document.getElementById('cal-hdr').textContent = MONTHS[calM] + ' ' + calY;
  const today = new Date(); today.setHours(0,0,0,0);
  const first = new Date(calY,calM,1);
  let dow = first.getDay(); if(dow===0) dow=7;
  const dim = new Date(calY,calM+1,0).getDate();
  const dipm = new Date(calY,calM,0).getDate();
  let h = DAYS.map(d=>`<div class="cdn">${d}</div>`).join('');
  for(let i=1;i<dow;i++) h+=`<div class="cd other">${dipm-dow+1+i}</div>`;
  for(let d=1;d<=dim;d++){
    const dt=new Date(calY,calM,d); dt.setHours(0,0,0,0);
    let cls='cd';
    const isF=atFrom&&dt.getTime()===atFrom.getTime();
    const isT=atTo&&dt.getTime()===atTo.getTime();
    if(dt.getTime()===today.getTime()) cls+=' td';
    if(isF&&isT) cls+=' rs re';
    else if(isF) cls+=' rs';
    else if(isT) cls+=' re';
    else if(atFrom&&atTo&&dt>atFrom&&dt<atTo) cls+=' ir';
    h+=`<div class="${cls}" onclick="pickDay(${d})">${d}</div>`;
  }
  for(let i=1;i<=7;i++) h+=`<div class="cd other">${i}</div>`;
  document.getElementById('cal-grid').innerHTML = h;
  const fmt = dt => dt ? dt.toLocaleDateString('en',{month:'short',day:'numeric'}) : null;
  const fv=document.getElementById('dcfv'), tv=document.getElementById('dctv');
  fv.className='dc-val'+(atFrom?'':' ph'); fv.textContent=fmt(atFrom)||'Choose';
  tv.className='dc-val'+(atTo?'':' ph'); tv.textContent=fmt(atTo)||'Choose';
  document.getElementById('at-next').disabled=!(atFrom&&atTo);
}

function pickDay(d) {
  const dt=new Date(calY,calM,d); dt.setHours(0,0,0,0);
  if(atSelFrom){atFrom=dt;atTo=null;setSelFrom(false);}
  else{if(atFrom&&dt<atFrom){atFrom=dt;setSelFrom(false);}else{atTo=dt;}}
  renderCal();
}

function chMon(dir){calM+=dir;if(calM<0){calM=11;calY--;}if(calM>11){calM=0;calY++;}renderCal();}

function pickT(el, val) {
  document.querySelectorAll('.tb').forEach(b=>b.classList.remove('sel'));
  el.classList.add('sel');
  atTransport = val;
}

// trip buddies added inline — reset on open
let atBuddies = [];

function addBuddyToTrip() {
  const inp = document.getElementById('buddy-name-input');
  const name = inp.value.trim();
  if (!name) return;
  if (!atBuddies.includes(name)) {
    atBuddies.push(name);
    renderTripBuddyChips();
  }
  inp.value = '';
  inp.focus();
}

function removeTripBuddy(name) {
  atBuddies = atBuddies.filter(b => b !== name);
  renderTripBuddyChips();
}

function renderTripBuddyChips() {
  const el = document.getElementById('buddy-chips-list');
  if (!atBuddies.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = atBuddies.map(name =>
    `<div class="bchip sel">${name} <span onclick="removeTripBuddy('${name}')" style="margin-left:3px;cursor:pointer;opacity:.6">×</span></div>`
  ).join('');
}

function renderBuddyChipsInModal() {
  // now handled by inline entry — just reset
  atBuddies = [];
  renderTripBuddyChips();
}

function atNav(dir) {
  const next = atStep + dir; if(next<0||next>3) return;
  document.getElementById('mstep'+atStep).classList.remove('active');
  const old = document.getElementById('msd'+atStep);
  old.classList.remove('active'); if(dir>0) old.classList.add('done'); else old.classList.remove('done');
  atStep = next;
  document.getElementById('mstep'+atStep).classList.add('active');
  const cur = document.getElementById('msd'+atStep);
  cur.classList.add('active'); cur.classList.remove('done');
  document.getElementById('at-title').textContent = MSTEP_TITLES[atStep];
  document.getElementById('at-sub').textContent = MSTEP_SUBS[atStep];
  document.getElementById('at-hint').textContent = `Step ${atStep+1} of 4`;
  document.getElementById('at-back').style.visibility = atStep>0?'visible':'hidden';
  const nn = document.getElementById('at-next');
  if(atStep===1){ renderCal(); nn.disabled=!(atFrom&&atTo); nn.innerHTML='Next <i class="ti ti-arrow-right" style="font-size:13px"></i>'; nn.onclick=()=>atNav(1); }
  else if(atStep===2){ nn.disabled=false; nn.innerHTML='Next <i class="ti ti-arrow-right" style="font-size:13px"></i>'; nn.onclick=()=>atNav(1); }
  else if(atStep===3){
    const fd=atFrom?atFrom.toLocaleDateString('en',{month:'short',day:'numeric'}):'—';
    const td=atTo?atTo.toLocaleDateString('en',{month:'short',day:'numeric',year:'numeric'}):'—';
    document.getElementById('cf-origin-flag').textContent=atOrigin?atOrigin.flag:'🌍';
    document.getElementById('cf-origin-name').textContent=atOrigin?`${atOrigin.city}, ${atOrigin.country}`:'—';
    document.getElementById('cf-flag').textContent=atDest?atDest.flag:'🌍';
    document.getElementById('cf-dest').textContent=atDest?`${atDest.city}, ${atDest.country}`:'—';
    document.getElementById('cf-dates').textContent=`${fd} – ${td}`;
    document.getElementById('cf-transport').textContent=TMAP[atTransport]||'✈ Flight';
    document.getElementById('cf-buddies').textContent=atBuddies.length ? atBuddies.join(', ') : 'Solo';
    document.getElementById('cf-distance').textContent=estimateDistance(atOrigin?.lat,atOrigin?.lon,atDest?.lat,atDest?.lon).toLocaleString()+' km';
    nn.disabled=false; nn.innerHTML='<i class="ti ti-check" style="font-size:13px"></i> Save trip';
    nn.onclick = saveTrip;
  } else { nn.disabled=!(atOrigin&&atDest); nn.innerHTML='Next <i class="ti ti-arrow-right" style="font-size:13px"></i>'; nn.onclick=()=>atNav(1); }
  if(dir===-1&&atStep===0) nn.disabled=!(atOrigin&&atDest);
}

async function saveTrip() {
  if(!atOrigin) { alert('Missing departure city — please go back to step 1.'); return; }
  if(!atDest) { alert('Missing destination — please go back to step 1.'); return; }
  if(!atFrom||!atTo) { alert('Missing dates — please go back to step 2.'); return; }
  if(!currentUser) { alert('Not signed in — please reload and sign in again.'); return; }
  const nn = document.getElementById('at-next');
  nn.disabled = true;
  nn.innerHTML = 'Saving…';
  const resetBtn = () => {
    nn.disabled = false;
    nn.innerHTML = '<i class="ti ti-check" style="font-size:13px"></i> Save trip';
    nn.onclick = saveTrip;
  };
  const distEst = estimateDistance(atOrigin.lat, atOrigin.lon, atDest.lat, atDest.lon);
  const tripData = {
    user_id: currentUser.id,
    city: atDest.city,
    country: atDest.country,
    flag: atDest.flag,
    lat: atDest.lat,
    lon: atDest.lon,
    from_city: atOrigin.city,
    from_lat: atOrigin.lat,
    from_lon: atOrigin.lon,
    date_from: atFrom.toISOString().split('T')[0],
    date_to: atTo.toISOString().split('T')[0],
    transport: atTransport,
    distance_km: distEst,
    buddies: atBuddies,
    notes: document.getElementById('trip-notes').value.trim()
  };
  console.log('[saveTrip] sending insert', { userId: tripData.user_id, city: tripData.city });

  let settled = false;
  const onSuccess = () => {
    if (settled) return; settled = true;
    console.log('[saveTrip] success');
    closeAddTrip();
    loadTrips().then(() => renderStats());
  };
  const onError = (msg) => {
    if (settled) return; settled = true;
    console.error('[saveTrip] error:', msg);
    alert(msg);
    resetBtn();
  };

  // Independent timeout — fires even if the fetch is permanently hung.
  // Falls back to a SELECT to confirm whether the row landed; gives the SELECT
  // its own 5-second inner timeout in case fetch() is also stalled.
  const timeoutId = setTimeout(async () => {
    if (settled) return;
    console.warn('[saveTrip] 15 s timeout — verifying via SELECT');
    const selectResult = db.from('trips')
      .select('id')
      .eq('user_id', currentUser.id)
      .eq('city', tripData.city)
      .eq('date_from', tripData.date_from)
      .maybeSingle()
      .then(({ data }) => data);
    const selectTimeout = new Promise(r => setTimeout(() => r(null), 5000));
    const data = await Promise.race([selectResult, selectTimeout]);
    console.log('[saveTrip] fallback SELECT:', data ? 'row found' : 'not found / timed out');
    if (data) onSuccess();
    else onError('Supabase is unreachable on this network. Switch to a different network (e.g. mobile data hotspot) and try again.');
  }, 15000);

  // Use .then() instead of await so a hung fetch cannot block this function.
  db.from('trips').insert(tripData)
    .then(async ({ error }) => {
      clearTimeout(timeoutId);
      console.log('[saveTrip] insert response received, error:', error);
      if (!error) { onSuccess(); return; }
      // FK violation: profile row missing — create it then retry once.
      if (error.code === '23503') {
        const name = currentUser.user_metadata?.name || currentUser.email?.split('@')[0] || 'Traveller';
        await db.from('profiles').upsert({
          id: currentUser.id, name, email: currentUser.email, moo_code: generateMooCode()
        });
        const { error: retryErr } = await db.from('trips').insert(tripData);
        if (retryErr) onError('Error saving trip: ' + retryErr.message);
        else onSuccess();
        return;
      }
      onError('Error saving trip: ' + error.message);
    })
    .catch(e => {
      clearTimeout(timeoutId);
      onError('Error saving trip: ' + e.message);
    });
}

function estimateDistance(fromLat, fromLon, toLat, toLon) {
  if (!fromLat || !fromLon || !toLat || !toLon) return 0;
  const R = 6371;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLon = (toLon - fromLon) * Math.PI / 180;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2)+Math.cos(fromLat*Math.PI/180)*Math.cos(toLat*Math.PI/180)*Math.sin(dLon/2)*Math.sin(dLon/2);
  return Math.round(2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)));
}

// ─── ROUTES ───────────────────────────────────
async function loadRoutes() {
  const { data } = await db.from('routes').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });
  routes = data || [];
  renderSavedRoutes();
}

function addWP() {
  const inp = document.getElementById('wp-input'), v = inp.value.trim(); if(!v) return;
  currentWPs.push(v); inp.value='';
  renderWPList(); renderCityMap();
}

function removeWP(i) {
  currentWPs.splice(i,1); renderWPList(); renderCityMap();
}

function renderWPList() {
  document.getElementById('wp-list').innerHTML = currentWPs.map((w,i) =>
    `<div class="wp-item"><div class="wp-num">${i+1}</div><div style="flex:1;font-size:12px">${w}</div><div class="wp-del" onclick="removeWP(${i})"><i class="ti ti-x" style="font-size:12px"></i></div></div>`
  ).join('');
  document.getElementById('rs-stops').textContent = currentWPs.length;
  document.getElementById('rs-dist').textContent = (currentWPs.length * 2.8).toFixed(1) + ' km';
  const m = Math.round(currentWPs.length * 35);
  document.getElementById('rs-time').textContent = `${Math.floor(m/60)}h ${m%60}m`;
}

function renderCityMap() {
  const svg = document.getElementById('city-svg');
  const w = 600, h = 460;
  let html = `<rect width="${w}" height="${h}" fill="#e8eff7"/>`;
  const gridLines = ['M60,80 L540,80','M60,400 L540,400','M60,80 L60,400','M540,80 L540,400','M60,180 L540,180','M60,280 L540,280','M200,80 L200,400','M350,80 L350,400'];
  gridLines.forEach(l => { html += `<path d="${l}" stroke="#ccc" stroke-width="1" fill="none"/>`; });
  if (currentWPs.length > 0) {
    const pts = currentWPs.map((_,i) => ({
      x: Math.round(100 + (i/(Math.max(currentWPs.length-1,1)))*380),
      y: Math.round(150 + Math.sin(i*1.2)*80)
    }));
    if(pts.length>1){
      let rp=`M${pts[0].x},${pts[0].y}`;
      for(let i=1;i<pts.length;i++) rp+=` L${pts[i].x},${pts[i].y}`;
      html+=`<path d="${rp}" stroke="#7c5c2e" stroke-width="3" fill="none" stroke-dasharray="7 4" opacity=".8"/>`;
    }
    pts.forEach((pt,i)=>{
      html+=`<circle cx="${pt.x}" cy="${pt.y}" r="11" fill="#7c5c2e" opacity=".15"/>`;
      html+=`<circle cx="${pt.x}" cy="${pt.y}" r="8" fill="#7c5c2e"/>`;
      html+=`<text x="${pt.x}" y="${pt.y+4}" text-anchor="middle" font-size="9" fill="#fff" font-family="sans-serif" font-weight="600">${i+1}</text>`;
      const lx=pt.x>300?pt.x-14:pt.x+14, anchor=pt.x>300?'end':'start';
      html+=`<text x="${lx}" y="${pt.y+4}" font-size="10" fill="#444" font-family="sans-serif" text-anchor="${anchor}">${currentWPs[i]}</text>`;
    });
  } else {
    html += `<text x="300" y="230" text-anchor="middle" font-size="13" fill="#9c9a92" font-family="sans-serif">Add waypoints to plot your route</text>`;
  }
  svg.innerHTML = html;
}

async function saveRoute() {
  if(!currentWPs.length) return alert('Add at least one waypoint first');
  const name = prompt('Name this route:', currentWPs[0] + ' route');
  if(!name) return;
  const { data } = await db.from('routes').insert({
    user_id: currentUser.id,
    name,
    waypoints: currentWPs,
    distance_km: (currentWPs.length*2.8).toFixed(1)
  }).select().single();
  if(data) { routes.unshift(data); renderSavedRoutes(); alert('Route saved!'); }
}

function renderSavedRoutes() {
  const el = document.getElementById('saved-routes-list');
  if(!routes.length){ el.innerHTML='<div style="font-size:12px;color:var(--hint);padding:8px 0">No saved routes yet</div>'; return; }
  el.innerHTML = routes.map(r=>`
    <div class="saved-route-item" onclick="loadRoute(${JSON.stringify(r.waypoints).replace(/"/g,'&quot;')})">
      ${r.name}<div class="saved-route-sub">${r.waypoints.length} stops · ${r.distance_km} km</div>
    </div>`).join('');
}

function loadRoute(wps) {
  currentWPs = Array.isArray(wps) ? wps : JSON.parse(wps);
  renderWPList(); renderCityMap();
}

// ─── HERD CHAT ────────────────────────────────
function renderChatGroups() {
  const el = document.getElementById('chat-groups');
  const withBuddies = trips.filter(t=>t.buddies&&t.buddies.length>0);
  if(!withBuddies.length){ el.innerHTML='<div class="empty-state" style="font-size:12px">Add a trip with buddies to start a group chat</div>'; return; }
  el.innerHTML = withBuddies.map(t=>`
    <div class="chat-group-item${currentTripId===t.id?' active':''}" onclick="openTripChat('${t.id}')">
      ${t.flag||'🌍'} ${t.city}<div class="chat-group-sub">${t.buddies.join(', ')} · Herd only</div>
    </div>`).join('');
}

async function openTripChat(tripId) {
  currentTripId = tripId;
  const trip = trips.find(t=>t.id===tripId);
  if(!trip) return;
  document.getElementById('chat-trip-name').textContent = `${trip.flag||'🌍'} ${trip.city} ${new Date(trip.date_from).getFullYear()}`;
  document.getElementById('chat-trip-meta').textContent = `${trip.buddies?.join(', ')||'Solo'} · Herd only · private`;
  // On mobile, switch from groups list to chat view
  document.querySelector('.chat-wrap')?.classList.add('chat-open');
  renderChatGroups();
  const { data } = await db.from('messages').select('*').eq('trip_id', tripId).order('created_at', { ascending: true });
  messages = data || [];
  renderMessages();
  subscribeToMessages(tripId);
}

function closeTripChat() {
  document.querySelector('.chat-wrap')?.classList.remove('chat-open');
}

function renderMessages() {
  const el = document.getElementById('chat-msgs');
  if(!messages.length){ el.innerHTML='<div class="empty-state" style="margin-top:40px">No messages yet. Say hi to the herd!</div>'; return; }
  el.innerHTML = messages.map(m=>{
    const mine = m.user_id === currentUser.id;
    const initials = m.user_name ? m.user_name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2) : '?';
    const time = new Date(m.created_at).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit'});
    const content = m.image_url
      ? `<img src="${m.image_url}" class="chat-img" onclick="window.open('${m.image_url}','_blank')">`
      : `<div class="bubble">${m.content.replace(/</g,'&lt;')}</div>`;
    return `<div class="msg${mine?' mine':''}">
      <div class="msg-av">${initials}</div>
      <div>${mine?'':'<div class="msg-name">'+m.user_name+'</div>'}${content}<div class="msg-time">${time}</div></div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

let chatSubscription = null;
function subscribeToMessages(tripId) {
  if(chatSubscription) chatSubscription.unsubscribe();
  chatSubscription = db.channel('messages:'+tripId)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:`trip_id=eq.${tripId}`},
      payload => { messages.push(payload.new); renderMessages(); })
    .subscribe();
}

async function sendMsg() {
  const inp = document.getElementById('msg-input');
  const txt = inp.value.trim();
  if(!txt||!currentTripId) return;
  inp.value = '';
  const { data: profile } = await db.from('profiles').select('name').eq('id', currentUser.id).single();
  await db.from('messages').insert({
    trip_id: currentTripId,
    user_id: currentUser.id,
    user_name: profile?.name || currentUser.email.split('@')[0],
    content: txt
  });
}

async function sendPhoto(input) {
  if(!input.files[0]||!currentTripId) return;
  const file = input.files[0];
  const path = `${currentUser.id}/${Date.now()}-${file.name}`;
  const { data: uploadData, error } = await db.storage.from('chat-photos').upload(path, file);
  if(error){ alert('Upload failed: '+error.message); return; }
  const { data: urlData } = db.storage.from('chat-photos').getPublicUrl(path);
  const { data: profile } = await db.from('profiles').select('name').eq('id', currentUser.id).single();
  await db.from('messages').insert({
    trip_id: currentTripId,
    user_id: currentUser.id,
    user_name: profile?.name || currentUser.email.split('@')[0],
    content: '📷 Photo',
    image_url: urlData.publicUrl
  });
  input.value = '';
}

// ─── BUDDIES ─────────────────────────────────
async function loadBuddies() {
  const { data } = await db.from('buddies').select('*, buddy:buddy_id(id,name,email)').eq('user_id', currentUser.id);
  buddies = (data||[]).map(b=>b.buddy).filter(Boolean);
  renderBuddiesPanel();
  renderBuddyChipsInModal();
  renderBuddyStats();
}

function renderBuddiesPanel() {
  const el = document.getElementById('buddy-grid');
  if(!buddies.length){ el.innerHTML='<div class="empty-state">No buddies yet.<br>Add people you travel with!</div>'; return; }
  const colors = ['#be4a6b','#0f766e','#2563eb','#b45309','#6d4ab7'];
  const bgs = ['var(--roses)','var(--teas)','var(--skys)','var(--ambs)','var(--vios)'];
  el.innerHTML = buddies.map((b,i)=>{
    const initials = b.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
    const tripsTogether = trips.filter(t=>t.buddies&&t.buddies.includes(b.name.split(' ')[0])).length;
    const places = [...new Set(trips.filter(t=>t.buddies&&t.buddies.includes(b.name.split(' ')[0])).map(t=>t.city))];
    return `<div class="bcard">
      <div class="bav2" style="background:${bgs[i%5]};color:${colors[i%5]}">${initials}</div>
      <div class="bname2">${b.name}</div>
      <div class="bsub">${tripsTogether} trip${tripsTogether!==1?'s':''} together</div>
      <div class="btags">${places.slice(0,3).map(p=>`<span class="tag tg-b">${p}</span>`).join('')}</div>
    </div>`;
  }).join('')+'<div class="bcard" style="opacity:.6;border-style:dashed;cursor:pointer" onclick="openAddBuddy()"><div class="bav2" style="background:var(--sur2);border:1px dashed var(--bd2)">+</div><div class="bsub" style="margin-top:5px">Add a buddy</div></div>';
}

function renderBuddyStats() {
  const solo = trips.filter(t=>!t.buddies||!t.buddies.length).length;
  document.getElementById('bstat-solo').textContent = solo;
  document.getElementById('bstat-total').textContent = trips.length;
  document.getElementById('bstat-countries').textContent = [...new Set(trips.map(t=>t.country).filter(Boolean))].length;
  if(buddies.length){
    const freq = buddies.map(b=>({name:b.name,count:trips.filter(t=>t.buddies&&t.buddies.includes(b.name.split(' ')[0])).length})).sort((a,b)=>b.count-a.count)[0];
    document.getElementById('bstat-freq').textContent = freq?.count>0 ? freq.name.split(' ')[0] : '—';
  }
}

function openAddBuddy() {
  document.getElementById('buddy-email').value='';
  document.getElementById('buddy-search-result').innerHTML='';
  document.getElementById('buddy-search-error').style.display='none';
  document.getElementById('add-buddy-modal').classList.add('open');
}

function closeAddBuddy() { document.getElementById('add-buddy-modal').classList.remove('open'); }

async function searchBuddy() {
  const email = document.getElementById('buddy-email').value.trim();
  if(!email) return;
  const { data, error } = await db.from('profiles').select('id,name,email').eq('email', email).single();
  if(error||!data){ document.getElementById('buddy-search-error').textContent='No Mooventures user found with that email'; document.getElementById('buddy-search-error').style.display='block'; return; }
  if(data.id===currentUser.id){ document.getElementById('buddy-search-error').textContent="That's you!"; document.getElementById('buddy-search-error').style.display='block'; return; }
  document.getElementById('buddy-search-error').style.display='none';
  const initials = data.name.split(' ').map(n=>n[0]).join('').toUpperCase().slice(0,2);
  document.getElementById('buddy-search-result').innerHTML=`
    <div class="sel-place" style="margin-top:8px">
      <div class="bav2" style="background:var(--brs);color:var(--brown);width:32px;height:32px;font-size:12px;flex-shrink:0">${initials}</div>
      <div><div style="font-size:13px;font-weight:500">${data.name}</div><div style="font-size:11px;color:var(--muted)">${data.email}</div></div>
      <button class="btn pri" style="margin-left:auto;font-size:11px" onclick="addBuddy('${data.id}','${data.name}')">Add</button>
    </div>`;
}

async function addBuddy(buddyId, name) {
  const { error } = await db.from('buddies').insert({ user_id: currentUser.id, buddy_id: buddyId });
  if(error&&error.code!=='23505') { alert('Error: '+error.message); return; }
  await db.from('buddies').insert({ user_id: buddyId, buddy_id: currentUser.id }).select();
  closeAddBuddy();
  await loadBuddies();
  alert(`${name} added to your herd!`);
}

// ─── SERENDIPITY ──────────────────────────────
function serTab(tab, el) {
  document.querySelectorAll('.ser-tab').forEach(t=>t.classList.remove('active')); el.classList.add('active');
  document.getElementById('ser-enc').style.display=tab==='enc'?'block':'none';
  document.getElementById('ser-pending').style.display=tab==='pending'?'block':'none';
  document.getElementById('ser-add').style.display=tab==='add'?'block':'none';
}

function openMooCode() { showPanel('serendipity', document.querySelector('[data-panel="serendipity"]')); serTab('add', document.querySelectorAll('.ser-tab')[2]); }

function renderMooQR(code) {
  const el = document.getElementById('my-qr-code');
  if(!code){ el.innerHTML='<div style="font-size:10px;color:var(--hint);text-align:center;padding:8px">Loading…</div>'; return; }
  el.innerHTML = `<div style="font-size:9px;font-weight:600;color:var(--brown);text-align:center;padding:12px;word-break:break-all;line-height:1.4">${code}</div>`;
}

async function sendMooRequest() {
  const code = document.getElementById('their-moo-code').value.trim();
  if(!code) return;
  const { data } = await db.from('profiles').select('id,name').eq('moo_code', code.toUpperCase()).single();
  if(!data){ alert('Moo code not found. Check the code and try again.'); return; }
  if(data.id===currentUser.id){ alert("That's your own Moo code!"); return; }
  await db.from('serendipity').insert({ from_id: currentUser.id, to_id: data.id, status: 'pending' });
  alert(`Moo sent to ${data.name}! Once they accept, you can choose what to share.`);
  document.getElementById('their-moo-code').value = '';
}

// ─── STATS ────────────────────────────────────
function setStatPeriod(p, el) {
  document.querySelectorAll('.ptab').forEach(t=>t.classList.remove('active')); el.classList.add('active');
  statPeriod = p; renderStats();
}

function renderStats() {
  const now = new Date();
  let filtered = trips;
  if(statPeriod==='month') filtered = trips.filter(t=>{const d=new Date(t.date_from);return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();});
  else if(statPeriod==='year') filtered = trips.filter(t=>new Date(t.date_from).getFullYear()===now.getFullYear());

  const totalKm = filtered.reduce((s,t)=>s+(t.distance_km||0),0);
  const totalHrs = filtered.reduce((s,t)=>s+dayCount(t.date_from,t.date_to)*0.5,0);
  const countries = [...new Set(filtered.map(t=>t.country).filter(Boolean))];

  document.getElementById('stat-dist').textContent = totalKm.toLocaleString();
  document.getElementById('stat-hrs').textContent = Math.round(totalHrs);
  document.getElementById('stat-places').textContent = filtered.length;
  document.getElementById('stat-countries').textContent = countries.length + ' countr' + (countries.length===1?'y':'ies');
  document.getElementById('stat-trips').textContent = filtered.length;

  renderStatChart(filtered);
  renderTopDestinations(filtered);
}

function renderStatChart(filtered) {
  const el = document.getElementById('stat-chart');
  if(!filtered.length){ el.innerHTML='<div style="font-size:12px;color:var(--hint);padding:20px 0">Add trips to see your chart</div>'; return; }
  const byMonth = {};
  filtered.forEach(t=>{ const k=new Date(t.date_from).toLocaleDateString('en',{month:'short',year:'2-digit'}); byMonth[k]=(byMonth[k]||0)+(t.distance_km||0); });
  const entries = Object.entries(byMonth).slice(-12);
  const max = Math.max(...entries.map(e=>e[1]),1);
  el.innerHTML = `<div class="bar-chart">${entries.map(([label,val])=>{
    const h=Math.round((val/max)*66);
    return `<div class="bg"><div class="bar" style="height:${h}px" title="${val.toLocaleString()} km"></div><span class="bl">${label.split(' ')[0]}</span></div>`;
  }).join('')}</div>`;
}

function renderTopDestinations(filtered) {
  const el = document.getElementById('top-destinations');
  if(!filtered.length){ el.innerHTML='<div style="font-size:12px;color:var(--hint)">No trips yet</div>'; return; }
  const sorted = [...filtered].sort((a,b)=>(b.distance_km||0)-(a.distance_km||0)).slice(0,5);
  el.innerHTML = sorted.map(t=>`
    <div class="trip-row">
      <div style="font-size:18px">${t.flag||'🌍'}</div>
      <div style="flex:1"><div style="font-size:13px;font-weight:500">${t.city}, ${t.country}</div><div style="font-size:11px;color:var(--muted)">${formatDate(t.date_from)} · ${t.buddies?.join(', ')||'Solo'}</div></div>
      <div class="tdist">${(t.distance_km||0).toLocaleString()} km</div>
    </div>`).join('');
}

// ─── DATA EXPORT ─────────────────────────────
async function exportData() {
  const exported = { trips, buddies: buddies.map(b=>b.name), exported_at: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'mooventures-data.json'; a.click();
}

async function confirmDeleteAccount() {
  if(!confirm('Are you sure? This will permanently delete all your trips, routes, and account data.')) return;
  if(!confirm('This cannot be undone. Delete everything?')) return;
  await db.from('trips').delete().eq('user_id', currentUser.id);
  await db.from('routes').delete().eq('user_id', currentUser.id);
  await db.from('buddies').delete().eq('user_id', currentUser.id);
  await db.from('profiles').delete().eq('id', currentUser.id);
  await db.auth.admin?.deleteUser(currentUser.id);
  await signOut();
}

// ─── HELPERS ─────────────────────────────────
function dayCount(from, to) {
  if(!from||!to) return 0;
  return Math.max(1, Math.round((new Date(to)-new Date(from))/(1000*60*60*24)));
}

function formatDate(d) {
  if(!d) return '—';
  return new Date(d).toLocaleDateString('en',{month:'short',day:'numeric',year:'numeric'});
}

// ─── INIT RENDER ─────────────────────────────
renderWPList();
renderCityMap();
