// COBLAI v5 — app

// ===== safeCopy (Aaron 6 Sep + FIX 7 Sep 2026): salin teks ROBUST 3 lapis =====
// 1) navigator.clipboard.writeText (secure context)  2) textarea DI VIEWPORT + execCommand
// 3) seleksi DOM + instruksi manual. FIX penting: textarea TIDAK boleh di luar viewport
// (-9999px) — di iOS Safari/WebView execCommand('copy') gagal utk elemen di luar layar,
// itulah kenapa tombol copy sering "tidak bisa" di HP.
function safeCopy(txt, okMsg) {
  const done = () => { if (okMsg && typeof toast === 'function') toast(okMsg); };
  const warn = (m) => { if (typeof toast === 'function') toast(m || '⚠️ Salin diblokir browser — pilih teks lalu tekan Salin / Ctrl+C'); };
  const clean = String(txt == null ? '' : txt);
  const viaTextarea = () => {
    let ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = clean;
      ta.setAttribute('readonly', '');
      ta.setAttribute('aria-hidden', 'true');
      // DI VIEWPORT (bukan -9999): iOS/WebView butuh elemen terlihat utk execCommand
      ta.style.cssText = 'position:fixed;left:0;top:0;width:140px;height:40px;opacity:0.01;border:0;padding:0;margin:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { if (ta) { try { ta.remove(); } catch (e2) {} } return false; }
  };
  if (navigator.clipboard && window.isSecureContext && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(clean).then(done).catch(() => { if (viaTextarea()) done(); else warn(); });
  } else if (viaTextarea()) done(); else warn();
}
// Lapisan ke-3 utk tombol copy jawaban: seleksi otomatis seluruh teks bubble kalau
// clipboard & execCommand dua-duanya diblokir — user tinggal tekan Salin/Ctrl+C.
function safeCopyBubble(bubble, okMsg) {
  const warnB = (m) => { if (typeof toast === 'function') toast(m || '⚠️ Tidak ada teks untuk disalin'); };
  try {
    const clone = bubble.cloneNode(true);
    clone.querySelectorAll('.msg-actions, .suggest-row, .msg-time, .msg-cost, button').forEach((n) => n.remove());
    const text = (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
    if (text) { safeCopy(text, okMsg); return; }
  } catch (e) {}
  warnB('⚠️ Tidak ada teks untuk disalin');
}

const $ = (id) => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('message');
const sendBtn = $('send');
const overlay = $('login-overlay');
const listEl = $('artifact-list');

let busy = false;
// F5 Antrian Pesan (9 Sep 2026, PRD F5): pesan yang diketik saat Dinda masih sibuk
// TIDAK ditolak diam-diam — masuk antrean, tampil, bisa dihapus, dieksekusi berurutan.
let __queue = []; // [{q, hasImg, hasFile, ts}]
let __queueSeq = 0;
function queueRender() {
  try {
    let bar = document.getElementById('queue-bar');
    const inputArea = document.getElementById('input-area');
    if (!__queue.length) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.id = 'queue-bar'; bar.className = 'queue-bar'; if (inputArea && inputArea.parentNode) inputArea.parentNode.insertBefore(bar, inputArea); }
    const parts = __queue.map((it, i) => {
      const preview = String(it.q || '(gambar/file)').slice(0, 60);
      return '<span class="queue-chip" title="' + escapeHtml(String(it.q || '')) + '"><span class="queue-idx">' + (i + 1) + '</span> '
        + (it.hasImg ? '🖼️ ' : it.hasFile ? '📎 ' : '💬 ') + escapeHtml(preview)
        + '<button type="button" class="queue-x" data-i="' + i + '" data-a="up" title="Naikkan urutan">↑</button>'
        + '<button type="button" class="queue-x" data-i="' + i + '" data-a="down" title="Turunkan urutan">↓</button>'
        + '<button type="button" class="queue-x" data-i="' + i + '" data-a="del" title="Hapus dari antrean">×</button></span>';
    }).join('');
    bar.innerHTML = '<span class="queue-label">⏳ Antrean pesan (' + __queue.length + ')</span> ' + parts;
    bar.querySelectorAll('.queue-x').forEach((btn) => btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i); const a = btn.dataset.a;
      if (a === 'del') { if (__queue[i]) __queue.splice(i, 1); queueRender(); }
      else if (a === 'up' && i > 0) { const t = __queue[i - 1]; __queue[i - 1] = __queue[i]; __queue[i] = t; queueRender(); }
      else if (a === 'down' && i < __queue.length - 1) { const t = __queue[i + 1]; __queue[i + 1] = __queue[i]; __queue[i] = t; queueRender(); }
    }));
    if (inputArea) inputArea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } catch (e) {}
}
function queuePush(q, hasImg, hasFile) {
  __queue.push({ q, hasImg: !!hasImg, hasFile: !!hasFile, ts: Date.now() });
  queueRender();
}
function queueDrain() {
  if (busy || !__queue.length) return;
  const item = __queue.shift();
  queueRender();
  toast('▶️ Memproses pesan antrean…');
  doSend(item.q);
}
let authed = false;
let me = null;
let primeHasAvatar = false;
let currentArtifact = null;
let filesCache = [];
let sessionsCache = [];
let modelsCache = [];
let pendingImages = [];
let pendingFiles = []; // [{path, name, desc, mime, size}]
let currentSessionId = null;

const langMap = { '.js':'javascript', '.mjs':'javascript', '.jsx':'javascript', '.ts':'typescript', '.tsx':'typescript', '.py':'python', '.html':'html', '.css':'css', '.json':'json', '.md':'markdown', '.sh':'bash', '.yaml':'yaml', '.yml':'yaml', '.sql':'sql', '.xml':'xml' };

marked.setOptions({ breaks: true, gfm: true });
function renderMd(text) {
  const raw = marked.parse(text || '');
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 2200); }
// F7/F9 (9 Sep 2026): catatan sistem kecil di atas input — tidak mengganggu chat,
// auto-hilang 6 dtk. Dipakai untuk compact/retry/recap dari event kaya engine.
function tryAppendSystemNote(html) {
  try {
    let el = document.getElementById('sys-note');
    if (!el) {
      el = document.createElement('div'); el.id = 'sys-note'; el.className = 'sys-note';
      const inputArea = document.getElementById('input-area');
      if (inputArea && inputArea.parentNode) inputArea.parentNode.insertBefore(el, inputArea);
      else document.body.appendChild(el);
    }
    el.innerHTML = html;
    el.style.display = '';
    clearTimeout(el._h);
    el._h = setTimeout(() => { el.style.display = 'none'; }, 6000);
  } catch (e) {}
}
function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n/1024).toFixed(1) + ' KB'; return (n/1048576).toFixed(1) + ' MB'; }
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function initials(name) { return (name||'?').trim().charAt(0).toUpperCase(); }
function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'baru saja';
  if (diff < 3600000) return Math.floor(diff/60000) + ' mnt';
  if (diff < 86400000) return Math.floor(diff/3600000) + ' jam';
  if (diff < 2592000000) return Math.floor(diff/86400000) + ' hari';
  return new Date(ts).toLocaleDateString('id-ID', { day:'numeric', month:'short' });
}

// ---------- Theme ----------
// FIX (Papi 19 Agu 2026): mode terang DIMATIKAN — selalu mode gelap (satu warna).
// Mode terang bikin kacau (banyak elemen tidak konsisten). Tombol tema disembunyikan.
function applyTheme() {
  // Redesign 2026 (Dinda 30 Agu 2026): hormati tema pilihan user (coblai/indigo/sky),
  // bukan memaksa 'dark'. getTheme() didefinisikan di blok Redesign di atas.
  const saved = getTheme();
  if (saved === 'coblai') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', saved);
  localStorage.setItem('pah-theme', saved);
  const lbl = $('theme-label');
  if (lbl) lbl.textContent = 'Gelap';
  $('theme-toggle').querySelector('.f-ico').textContent = '🌙';
  const meta = document.querySelector('meta[name="theme-color"]');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f1117';
  if (meta) meta.content = bg;
}
$('theme-toggle').style.display = 'none'; // tombol ganti tema dihapus (selalu gelap)

// ---------- Sidebar ----------
$('menu-btn').addEventListener('click', () => { $('sidebar').classList.remove('collapsed'); $('sidebar-overlay').classList.add('show'); });
$('sidebar-toggle').addEventListener('click', () => { $('sidebar').classList.add('collapsed'); $('sidebar-overlay').classList.remove('show'); });
$('sidebar-overlay').addEventListener('click', () => { $('sidebar').classList.add('collapsed'); $('sidebar-overlay').classList.remove('show'); });
// ---------- Bantuan (modal panduan singkat) ----------
function openHelp() {
  const m = $('help-modal'), b = $('help-backdrop');
  if (m) m.style.display = 'flex';
  if (b) b.style.display = 'block';
}
function closeHelp() {
  const m = $('help-modal'), b = $('help-backdrop');
  if (m) m.style.display = 'none';
  if (b) b.style.display = 'none';
}
if ($('help-open')) $('help-open').addEventListener('click', openHelp);
if ($('help-close')) $('help-close').addEventListener('click', closeHelp);
if ($('help-backdrop')) $('help-backdrop').addEventListener('click', closeHelp);
if ($('login-help-btn')) $('login-help-btn').addEventListener('click', openHelp);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeHelp(); });
// ---------- Panel Artefak: tampil/sembunyi (desktop & mobile) ----------
function setArtifactsVisible(show) {
  const art = $('artifacts');
  const isMobile = window.innerWidth <= 768;
  if (show) {
    if (isMobile) art.classList.add('open-mobile');
    else art.classList.remove('hidden');
  } else {
    if (isMobile) art.classList.remove('open-mobile');
    else art.classList.add('hidden');
  }
}
$('artifacts-toggle').addEventListener('click', () => {
  const art = $('artifacts');
  const isMobile = window.innerWidth <= 768;
  const visible = isMobile ? art.classList.contains('open-mobile') : !art.classList.contains('hidden');
  setArtifactsVisible(!visible);
});
// Tombol Refresh (Papi 19 Agu 2026): refresh semua data tanpa keluar aplikasi.
$('refresh-btn').addEventListener('click', doRefresh);
async function doRefresh() {
  const btn = $('refresh-btn');
  if (!btn || btn.classList.contains('activity-spin')) return;
  btn.classList.add('activity-spin');
  try {
    await Promise.all([
      refreshSessions().catch(() => {}),
      refreshStatus().catch(() => {}),
      refreshPrime().catch(() => {}),
      refreshModels().catch(() => {}),
    ]);
    const st = $('settings');
    if (st && st.style.display !== 'none') {
      const active = document.querySelector('.set-tab.active');
      if (active && active.dataset.tab) switchTab(active.dataset.tab);
    } else {
      const art = $('artifacts');
      if (art && !art.classList.contains('hidden')) refreshArtifacts().catch(() => {});
    }
    toast('Data diperbarui ✅');
  } finally {
    btn.classList.remove('activity-spin');
  }
}
$('artifacts-close').addEventListener('click', () => setArtifactsVisible(false));
window.addEventListener('resize', () => {
  // JANGAN memaksa panel tampil — hormati pilihan user.
  // Cuma bersihkan state overlay mobile saat beralih ke desktop.
  const art = $('artifacts');
  if (window.innerWidth > 768) art.classList.remove('open-mobile');
});

function updateSidebarUser() {
  if (!me) return;
  $('side-user').style.display = 'flex';
  $('side-name').textContent = me.name || me.username;
  $('side-role').textContent = me.role === 'admin' ? 'Admin' : 'Member';
  const av = $('side-avatar');
  const fallback = () => { av.removeAttribute('src'); av.style.display = 'none'; av.textContent = initials(me.name || me.username); };
  if (me.hasAvatar) { av.onerror = fallback; av.src = '/api/avatar?u=' + me.id + '&t=' + Date.now(); av.style.display = ''; }
  else fallback();
}

function renderSessions() {
  const list = $('session-list');
  if (!sessionsCache.length) {
    list.innerHTML = '<div class="art-empty">Belum ada sesi.<br>Klik "Chat Baru" untuk mulai.</div>';
    $('session-search').style.display = 'none';
    return;
  }
  $('session-search').style.display = '';
  list.innerHTML = '';
  const q = (sessionQuery || '').toLowerCase();
  const filtered = sessionsCache.filter(s => !q || (s.name || '').toLowerCase().includes(q));
  if (!filtered.length) {
    list.innerHTML = '<div class="art-empty">Tidak ada sesi cocok dengan pencarian.</div>';
    return;
  }
  // FIX audit Dinda 29 Agu 2026 (U4): grup sesi — Disematkan / Hari ini / 7 hari terakhir / Lebih lama.
  // Saat pencarian aktif, tampilkan flat (tanpa grup) agar hasil mudah dipindai.
  if (q) {
    filtered.forEach(s => list.appendChild(buildSessionItem(s)));
    return;
  }
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const groups = [
    { label: '📌 Disematkan', items: [] },
    { label: 'Hari ini', items: [] },
    { label: '7 hari terakhir', items: [] },
    { label: 'Lebih lama', items: [] },
  ];
  filtered.forEach((s) => {
    const lu = s.lastUsed || s.createdAt || 0;
    if (s.pinned) groups[0].items.push(s);
    else if (now - lu < DAY) groups[1].items.push(s);
    else if (now - lu < 7 * DAY) groups[2].items.push(s);
    else groups[3].items.push(s);
  });
  groups.forEach((g) => {
    if (!g.items.length) return;
    const h = document.createElement('div');
    h.className = 'sess-group';
    h.textContent = g.label;
    list.appendChild(h);
    g.items.forEach((s) => list.appendChild(buildSessionItem(s)));
  });
}
function buildSessionItem(s) {
  const item = document.createElement('div');
  item.className = 'sess-item' + (s.active ? ' active' : '') + (s.busy ? ' busy' : '');
  const isBranch = !!s.parentId;
  // Branching (Papi 16 Agu 2026): cabang tampil dengan indentasi + ikon ⑂ (pohon percabangan)
  item.style.paddingLeft = isBranch ? '22px' : '';
  item.innerHTML = `
    <span class="s-dot"></span>
    <div class="s-main">
      <div class="s-name">${isBranch ? '⑂ ' : ''}${s.pinned ? '📌 ' : ''}${escapeHtml(s.name)}</div>
      <div class="s-sub">${s.model ? escapeHtml(s.model.name) : 'memuat…'}${s.messageCount != null ? ' · ' + s.messageCount + ' pesan' : ''}${s.busy ? ' · ⏳' : ''}${isBranch ? ' · 🌿 cabang' : ''}${s.project ? ' · 🏷️ ' + escapeHtml(s.project) : ''}${s.activeAgentName ? ' · 🤖 ' + escapeHtml(s.activeAgentName) : ''}</div>
    </div>
    <button class="s-pin" title="${s.pinned ? 'Lepas pin' : 'Pin ke atas'}">${s.pinned ? '📌' : '📍'}</button>
    <button class="s-rename" title="Ubah nama sesi">✏️</button>
    <button class="s-close" title="Tutup sesi">×</button>`;
  item.addEventListener('click', (e) => {
    if (e.target.classList.contains('s-close') || e.target.classList.contains('s-pin') || e.target.classList.contains('s-rename')) return;
    if (!s.active) switchSession(s.id);
  });
  item.querySelector('.s-rename').addEventListener('click', async (e) => {
    e.stopPropagation();
    const cur = (s.name && s.name !== 'sesi-baru' && s.name !== 'sesi baru') ? s.name : '';
    const nn = prompt('Nama baru untuk sesi ini:', cur);
    if (nn === null) return;
    const name = nn.trim().slice(0, 80);
    if (!name) { toast('Nama tidak boleh kosong'); return; }
    try {
      const r = await fetch('/api/sessions/' + s.id + '/rename', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
      if (r.ok) { toast('✏️ Sesi diganti nama'); await refreshSessions(); }
      else { const d = await r.json().catch(()=>({})); toast('Gagal: ' + (d.error || 'coba lagi')); }
    } catch (e) { toast('Gagal mengganti nama'); }
  });
  item.querySelector('.s-close').addEventListener('click', (e) => { e.stopPropagation(); deleteSession(s.id); });
  item.querySelector('.s-pin').addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const r = await fetch('/api/sessions/' + s.id + '/pin', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ pinned: !s.pinned }) });
      if (r.ok) { toast(s.pinned ? 'Pin dilepas' : '📌 Disematkan ke atas'); await refreshSessions(); }
    } catch (e) {}
  });
  return item;
}
$('new-chat-btn').addEventListener('click', () => {
  // F23 (9 Sep 2026): buka dialog kaya — nama + mode + model + thinking sebelum mulai.
  openNewChatDialog();
});
// ===== F23 Dialog "Percakapan Baru" kaya =====
function openNewChatDialog() {
  try {
    $('newchat-modal').style.display = '';
    $('newchat-backdrop').style.display = '';
    const err = $('nc-err'); if (err) err.textContent = '';
    const nm = $('nc-name'); if (nm) nm.value = '';
    const md = $('nc-mode'); if (md) md.value = 'eksekusi';
    // isi pilihan model dari cache (kalau ada)
    const sel = $('nc-model');
    if (sel && modelsCache && modelsCache.length) {
      const cur = (_sel => (_sel && _sel.value) ? _sel.value : '')(document.getElementById('model-select'));
      sel.innerHTML = '<option value="">(pakai model sekarang)</option>' + modelsCache.map((m) => '<option value="' + escapeHtml(m.id) + '">' + escapeHtml((m.name || m.id) + (Array.isArray(m.input) && m.input.includes('image') ? ' 👁️' : '')) + '</option>').join('');
      if (cur && modelsCache.some((m) => m.id === cur)) sel.value = cur;
    }
    // F50: isi daftar profil bot milik user (async, tidak menghalangi dialog terbuka)
    fetch('/api/agents').then((r) => r.json()).then((d) => {
      const ag = $('nc-agent');
      if (!ag || !d || !Array.isArray(d.agents)) return;
      ag.innerHTML = '<option value="">(bawaan — semua profil digabung)</option>'
        + d.agents.map((a) => '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(a.name) + '</option>').join('');
    }).catch(() => {});
  } catch (e) {}
}
function closeNewChatDialog() {
  try { $('newchat-modal').style.display = 'none'; $('newchat-backdrop').style.display = 'none'; } catch (e) {}
}
if ($('newchat-close')) $('newchat-close').addEventListener('click', closeNewChatDialog);
if ($('newchat-backdrop')) $('newchat-backdrop').addEventListener('click', closeNewChatDialog);
if ($('nc-start')) $('nc-start').addEventListener('click', async () => {
  const btn = $('nc-start'); const old = btn.textContent;
  const err = $('nc-err'); if (err) err.textContent = '';
  btn.disabled = true; btn.textContent = '⏳ Menyiapkan…';
  try {
    const name = ($('nc-name').value || 'sesi baru').trim().slice(0, 60) || 'sesi baru';
    const mode = $('nc-mode').value || 'eksekusi';
    const modelId = $('nc-model').value || '';
    const thinking = $('nc-thinking').value || '';
    const project = ($('nc-project') ? $('nc-project').value : '').trim().slice(0, 40);
    const agentId = ($('nc-agent') ? $('nc-agent').value : '');
    await createSession(name);
    // F50: set profil bot sesi ini (kalau dipilih)
    if (agentId) {
      try { await fetch('/api/session-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId }) }); } catch (e) {}
    }
    // F17: simpan label proyek pada sesi baru (kalau diisi)
    if (project) {
      try {
        const sid = currentSessionId;
        if (sid) await fetch('/api/sessions/' + sid, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'project', project }) });
      } catch (e) {}
    }
    // terapkan opsi (best-effort — kegagalan tidak menghalangi sesi terbuat)
    try { await fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) }); } catch (e) {}
    if (modelId) { try { await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ modelId }) }); } catch (e) {} }
    if (thinking) { try { await fetch('/api/thinking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: thinking }) }); } catch (e) {} }
    try { await refreshModels(); } catch (e) {}
    toast('🚀 Percakapan baru siap' + (mode === 'diskusi' ? ' (mode diskusi)' : '') + (modelId ? ' · ' + modelId : ''));
    closeNewChatDialog();
  } catch (e) {
    if (err) err.textContent = 'Gagal: ' + e.message;
  } finally { btn.disabled = false; btn.textContent = old; }
});
// ===== F28 Coalescing Refresh (9 Sep 2026, PRD F28) =====
// Beberapa event (agent_end, changes, selesai kirim) sering memicu refresh BERUNTUN.
// Gabungkan jadi SATU gelombang refresh (debounce) → hemat request ke server, UI tetap segar.
// Aman: kalau gelombang sebelumnya belum jalan, ditunda; error satu panggilan tidak memblokir yang lain.
let __refreshWave = null;
function coalescedRefresh(ms) {
  try {
    clearTimeout(__refreshWave);
    __refreshWave = setTimeout(() => {
      __refreshWave = null;
      try { refreshSessions(); } catch (e) {}
      try { refreshStatus(); } catch (e) {}
      try { refreshArtifacts(); } catch (e) {}
    }, typeof ms === 'number' ? ms : 1200);
  } catch (e) {}
}
async function refreshSessions() {
  if (!authed) return;
  try {
    const r = await fetch('/api/sessions'); if (!r.ok) { toast('Gagal memuat daftar sesi'); return; }
    const d = await r.json();
    sessionsCache = d.sessions || [];
    const active = sessionsCache.find(s => s.active);
    if (active) { currentSessionId = active.id; $('tb-title').textContent = active.name; }
    renderSessions();
    updateStatus();
  } catch(e) { toast('Gagal memuat daftar sesi'); }
}
async function switchSession(id) {
  try {
    const r = await fetch('/api/sessions/' + id + '/switch', { method:'POST' });
    if (!r.ok) { const d = await r.json().catch(()=>({})); toast(d.error || 'Gagal pindah sesi'); return; }
    currentSessionId = id;
    await refreshSessions();
    // FIX optimasi (Papi 15 Agu 2026): JANGAN refreshModels() saat switch — endpoint /api/models
    // me-spawn agent kalau proc belum ada (boros resource saat cuma lihat riwayat). Model picker
    // pakai data dari sessionsCache (publicSession.model) — agent baru di-spawn saat kirim chat.
    // refreshModels(); // background — jangan menahan perpindahan
    await loadSessionMessages(id);
    connectEvents();
    if (window.innerWidth <= 768) { $('sidebar').classList.add('collapsed'); $('sidebar-overlay').classList.remove('show'); }
  } catch(e) { toast('Gagal pindah sesi'); }
}
async function createSession(name) {
  try {
    const r = await fetch('/api/sessions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    if (!r.ok) { const d = await r.json().catch(()=>({})); toast(d.error || 'Gagal buat sesi'); return; }
    const d = await r.json().catch(()=>({}));
    toast('Sesi baru ✅');
    await refreshSessions(); await refreshStatus();
    // Langsung masuk ke chat baru — tidak perlu isi subject (otomatis dari pesan pertama)
    const sid = (d.session && d.session.id) || (sessionsCache.find(s => s.active) || {}).id;
    if (sid) await switchSession(sid);
    else { await refreshModels(); connectEvents(); }
    if (window.innerWidth <= 768) { $('sidebar').classList.add('collapsed'); $('sidebar-overlay').classList.remove('show'); }
  } catch(e) { toast('Gagal buat sesi'); }
}
async function deleteSession(id) {
  const ans = prompt('Tutup percakapan ini? Riwayat chat akan dihapus (file artefak tetap aman).\n\nKetik HAPUS untuk melanjutkan:');
  if (ans === null) return;
  if (String(ans).trim().toUpperCase() !== 'HAPUS') { toast('Dibatalkan — tidak ada yang dihapus'); return; }
  try {
    // Cadangan-6 (9 Sep 2026): server wajib menerima kata konfirmasi, bukan hanya klik.
    const r = await fetch('/api/sessions/' + id, { method:'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'HAPUS' }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      toast(d.error || 'Gagal tutup sesi');
      return;
    }
    toast('Percakapan ditutup');
    await refreshSessions(); await refreshStatus();
  } catch(e) { toast('Gagal tutup sesi'); }
}

// ---------- Branching (Papi 16 Agu 2026 — #7): buat cabang dari titik pesan ----------
async function branchSession(messageSeq) {
  if (!currentSessionId) { toast('Pilih sesi dulu'); return; }
  try {
    toast('🌿 Membuat cabang… (konteks sampai pesan ini disalin)');
    const r = await fetch('/api/sessions/' + currentSessionId + '/branch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageSeq: typeof messageSeq === 'number' && messageSeq >= 0 ? messageSeq : -1 }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.error || 'Gagal buat cabang'); return; }
    toast('🌿 Cabang dibuat! Ketik arahan baru — alur asli tetap aman.');
    msgCache.delete(d.session.id);
    await refreshSessions();
    await switchSession(d.session.id);
  } catch (e) { toast('Gagal buat cabang: ' + e.message); }
}

// ---------- Session messages (riwayat saat buka sesi) ----------
// Cache node pesan per sesi — pindah chat = INSTANT (tanpa fetch & render ulang), refresh di background.
const msgCache = new Map(); // sid -> { nodes: [], count, ts }
function scrollChatBottom() { try { messagesEl.scrollTop = messagesEl.scrollHeight; } catch(e){} }
async function loadSessionMessages(sid) {
  const cached = msgCache.get(sid);
  if (cached && cached.nodes.length) {
    messagesEl.innerHTML = '';
    cached.nodes.forEach(n => messagesEl.appendChild(n));
    scrollChatBottom();
    if (Date.now() - cached.ts > 5000) refreshMessagesInBg(sid, cached); // throttle 5 dtk
    return;
  }
  try {
    const r = await fetch('/api/sessions/' + sid + '/messages', { method:'POST' });
    if (!r.ok) return;
    const d = await r.json();
    const msgs = d.messages || [];
    const nodes = await buildMessageNodes(msgs);
    msgCache.set(sid, { nodes, count: msgs.length, ts: Date.now(), truncated: !!d.truncated });
    renderNodes(nodes, msgs);
    renderLoadOlder(sid, d.truncated, msgs.length, d.total);
  } catch(e) {}
}
async function refreshMessagesInBg(sid, cached) {
  try {
    const r = await fetch('/api/sessions/' + sid + '/messages', { method:'POST' });
    if (!r.ok) return;
    const d = await r.json();
    const msgs = d.messages || [];
    if (msgs.length === cached.count) return; // tidak berubah
    const nodes = await buildMessageNodes(msgs);
    msgCache.set(sid, { nodes, count: msgs.length, ts: Date.now(), truncated: !!d.truncated });
    if (sid === currentSessionId) { renderNodes(nodes, msgs); renderLoadOlder(sid, d.truncated, msgs.length, d.total); }
  } catch(e) {}
}
// Tombol "muat pesan lama" — sesi panjang di-truncate (default 200) supaya render cepat.
// Klik → minta limit lebih besar (1000) & render ulang.
async function loadOlderMessages(sid) {
  try {
    const r = await fetch('/api/sessions/' + sid + '/messages?limit=1000', { method:'POST' });
    if (!r.ok) return;
    const d = await r.json();
    const msgs = d.messages || [];
    const nodes = await buildMessageNodes(msgs);
    msgCache.set(sid, { nodes, count: msgs.length, ts: Date.now(), truncated: false });
    if (sid === currentSessionId) renderNodes(nodes, msgs);
    toast('📚 Riwayat lengkap dimuat (' + msgs.length + ' pesan)');
  } catch(e) {}
}
function renderLoadOlder(sid, truncated, shown, total) {
  let btn = $('load-older-btn');
  if (!truncated) { if (btn) btn.remove(); return; }
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'load-older-btn';
    btn.className = 'btn small';
    btn.style.cssText = 'display:block;margin:10px auto;';
    btn.addEventListener('click', () => loadOlderMessages(sid));
  }
  btn.textContent = '⬆️ Muat riwayat lengkap (' + (total || '?') + ' pesan — ditampilkan ' + shown + ')';
  const first = messagesEl.firstChild;
  if (first) messagesEl.insertBefore(btn, first);
  else messagesEl.appendChild(btn);
}
// Build node pesan ke fragment terpisah (progressive: 25 pesan/frame — sesi panjang tidak freeze)
function buildMessageNodes(messages) {
  return new Promise((resolve) => {
    const frag = document.createDocumentFragment();
    const nodes = [];
    const BATCH = 25;
    let i = 0;
    const step = () => {
      const end = Math.min(i + BATCH, messages.length);
      for (; i < end; i++) {
        const m = messages[i];
        if (m.role === 'user') addMessage('user', m.content, true, frag, m.timestamp);
        else if (m.role === 'assistant') addMessage('assistant', m.content, true, frag, m.timestamp);
        if (frag.lastElementChild) nodes.push(frag.lastElementChild);
      }
      if (i < messages.length) { requestAnimationFrame(step); }
      else resolve(nodes);
    };
    step();
  });
}
// ===== F60 Turn Grouping (9 Sep 2026, PRD F60) =====
// Transkrip dikelompokkan per GILIRAN (pesan user + jawaban + kartu tool) dalam satu blok
// yang bisa DILIPAT — klik header "Giliran N" untuk sembunyikan/tampilkan.
// Aman: hanya MEMBUNGKUS elemen .msg yang sudah ada (isi & logika pesan tidak diubah).
let __turnGroupNo = 0;
function groupAllTurns() {
  try {
    const root = messagesEl || document.getElementById('messages');
    if (!root) return;
    const kids = Array.from(root.children);
    let i = 0;
    while (i < kids.length) {
      const el = kids[i];
      const isUser = el.classList && el.classList.contains('msg') && el.classList.contains('user') && !el.closest('.turn-group');
      if (!isUser) { i++; continue; }
      // kumpulkan: pesan user + semua .msg sesudahnya sampai sebelum user berikutnya
      const move = [el];
      let j = i + 1;
      while (j < kids.length) {
        const n = kids[j];
        if (!(n.classList && n.classList.contains('msg'))) break;
        if (n.classList.contains('user')) break;
        move.push(n); j++;
      }
      const group = document.createElement('div');
      group.className = 'turn-group';
      const head = document.createElement('div');
      head.className = 'turn-head';
      head.title = 'Klik untuk lipat/buka giliran ini';
      const tEl = el.querySelector('.msg-time');
      const waktu = (tEl && tEl.textContent) ? tEl.textContent : '';
      __turnGroupNo++;
      head.innerHTML = '<span class="turn-n">Giliran ' + __turnGroupNo + '</span>'
        + (waktu ? '<span class="turn-t">' + escapeHtml(waktu) + '</span>' : '')
        + '<span class="turn-caret">▾</span>';
      head.addEventListener('click', () => { group.classList.toggle('collapsed'); const c = head.querySelector('.turn-caret'); if (c) c.textContent = group.classList.contains('collapsed') ? '▸' : '▾'; });
      root.insertBefore(group, move[0]);
      group.appendChild(head);
      move.forEach((m) => group.appendChild(m));
      i = j;
    }
  } catch (e) {}
}
function renderNodes(nodes, messages) {
  messagesEl.innerHTML = '';
  nodes.forEach(n => messagesEl.appendChild(n));
  if (!messages || !messages.length) showWelcome();
  __turnGroupNo = 0; groupAllTurns(); // F60: kelompokkan per giliran
  scrollChatBottom();
}
function showWelcome() {
  const nm = (me && (me.name || me.username)) ? escapeHtml(me.name || me.username) : 'Bos';
  const an = escapeHtml(agentName || 'Dinda');
  // FIX audit Dinda 29 Agu 2026 (6.1 #6): contoh prompt siap pakai untuk user awam —
  // satu klik langsung mengirim permintaan (fungsi send() di bawah sudah didefinisikan).
  const examples = [
    { t: 'Analisa file yang saya upload', e: '📎 Analisa file' },
    { t: 'Buatkan laporan eksekutif singkat tentang bisnis saya', e: '📊 Laporan eksekutif' },
    { t: 'Riset kompetitor untuk produk saya', e: '🔍 Riset kompetitor' },
    { t: 'Bantu saya menyusun rencana kerja minggu ini', e: '📝 Rencana kerja' },
  ];
  messagesEl.innerHTML = `<div class="msg assistant"><div class="avatar" id="prime-avatar-msg">🤖</div><div class="bubble">Halo ${nm}! 👋 Aku <b>${an}</b> — siap bantu kamu. Ketik perintahmu di bawah, atau upload file untuk dianalisa. File yang kubuat akan muncul di panel artefak.</div></div>
<div class="welcome-examples">
  <div class="we-title">💡 Belum tahu mau mulai dari mana? Coba salah satu:</div>
  <div class="we-chips">${examples.map((x, i) => `<button type="button" class="we-chip" data-i="${i}"><span>${x.e}</span></button>`).join('')}</div>
</div>`;
  messagesEl.querySelectorAll('.we-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ex = examples[Number(btn.dataset.i)];
      if (!ex) return;
      inputEl.value = ex.t;
      send();
    });
  });
  if (primeHasAvatar) updatePrimeAvatarEls();
}

// ---------- Model picker ----------
let lastAppliedModel = '';

function showModelsUnavailable(sel, message) {
  modelsCache = [];
  sel.innerHTML = '';
  const opt = document.createElement('option');
  opt.value = '';
  opt.textContent = message;
  sel.appendChild(opt);
  sel.disabled = true;
  sel.title = 'Daftar model live belum tersedia';
}

async function refreshModels() {
  if (!authed) return;
  const sel = $('model-select');
  try {
    const r = await fetch('/api/models');
    if (!r.ok) {
      showModelsUnavailable(sel, 'Model belum tersedia — coba refresh');
      return;
    }
    const d = await r.json();
    modelsCache = d.models || [];
    // Jangan membuat fallback model fiktif. Pilihan hanya boleh berasal dari
    // daftar live Prime Agent agar user tidak memilih model yang sebenarnya tidak ada.
    if (!modelsCache.length) {
      showModelsUnavailable(sel, 'Model belum tersedia — agent belum siap');
      return;
    }
    sel.disabled = false;
    sel.style.display = '';
    const previous = lastAppliedModel || sel.value;
    sel.innerHTML = '';
    // F48 (9 Sep 2026): favorit model per user (localStorage) — tampil di atas dengan ⭐.
    let favs = [];
    try { favs = JSON.parse(localStorage.getItem('coblai_fav_models') || '[]') || []; } catch (e) { favs = []; }
    const sorted = [...modelsCache].sort((a, b) => {
      const fa = favs.includes(a.id) ? 0 : 1, fb = favs.includes(b.id) ? 0 : 1;
      return fa - fb;
    });
    // Deskripsi model untuk membantu user awam memilih (FIX audit Dinda 28 Agu 2026)
    const MODEL_DESC = {
      'flash': 'Cepat & hemat token — untuk chat harian',
      'pro': 'Lebih teliti & mendalam — untuk tugas berat',
    };
    sorted.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      const isFav = favs.includes(m.id);
      const idl = (m.id || '').toLowerCase();
      const desc = MODEL_DESC['flash'] && idl.includes('flash') ? MODEL_DESC['flash']
                 : MODEL_DESC['pro'] && idl.includes('pro') ? MODEL_DESC['pro']
                 : (m.provider ? 'Penyedia: ' + m.provider : '');
      opt.textContent = (isFav ? '⭐ ' : '') + (m.name || m.id) + (desc ? ' — ' + desc : '');
      opt.title = desc || (m.name || m.id);
      sel.appendChild(opt);
    });
    if (d.activeModel && modelsCache.some(m => m.id === d.activeModel)) sel.value = d.activeModel;
    else if (previous && modelsCache.some(m => m.id === previous)) sel.value = previous;
    lastAppliedModel = sel.value;
    sel.title = 'Model aktif (sesi ini)';
    // Update tombol favorit (F48)
    const favBtn = $('model-fav');
    if (favBtn) favBtn.textContent = favs.includes(sel.value) ? '★' : '☆';
  } catch(e) {
    showModelsUnavailable(sel, 'Model belum tersedia — coba refresh');
  }
}
// F48 (9 Sep 2026): toggle favorit model aktif.
if ($('model-fav')) $('model-fav').addEventListener('click', () => {
  const sel = $('model-select'); const btn = $('model-fav');
  const id = sel && sel.value;
  if (!id) { toast('Pilih model dulu'); return; }
  let favs = [];
  try { favs = JSON.parse(localStorage.getItem('coblai_fav_models') || '[]') || []; } catch (e) {}
  const i = favs.indexOf(id);
  if (i >= 0) { favs.splice(i, 1); toast('Favorit dihapus'); }
  else { favs.push(id); toast('⭐ Model difavoritkan — tampil di urutan atas'); }
  try { localStorage.setItem('coblai_fav_models', JSON.stringify(favs)); } catch (e) {}
  if (btn) btn.textContent = i >= 0 ? '☆' : '★';
  loadModels(); // render ulang urutan favorit
});
async function applyModel() {
  const sel = $('model-select');
  const modelId = sel.value;
  if (!modelId || sel.disabled) return;
  const previous = lastAppliedModel;
  sel.disabled = true;
  try {
    const r = await fetch('/api/model', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ modelId }) });
    const d = await r.json().catch(()=>({}));
    if (!r.ok || d.model !== modelId) {
      sel.value = previous;
      toast(d.error || 'Model tidak terverifikasi');
      return;
    }
    lastAppliedModel = modelId;
    toast('Model diganti ✅');
    await refreshStatus();
  } catch(e) {
    sel.value = previous;
    toast('Model tidak terverifikasi');
  } finally {
    sel.disabled = false;
  }
}
$('model-select').addEventListener('change', applyModel);

// ---------- Status ----------
function updateStatus() {
  const active = sessionsCache.find(s => s.active) || sessionsCache[0];
  const pill = $('status-pill');
  if (!active) { $('status-text').textContent = 'terhubung'; pill.classList.remove('busy'); return; }
  pill.classList.toggle('busy', !!active.busy);
  $('status-text').textContent = active.busy ? 'bekerja…' : 'terhubung';
}
// ===== F61 Projection States (9 Sep 2026, PRD P0) =====
// JANGAN campur status jadi satu label. Tiga sumbu dipisah:
//   lifecycle (hidup/idle/berhenti) · activity (sedang apa) · attention (butuh perhatian).
// Transport loss TIDAK pernah ditampilkan sebagai "agent gagal" (itu urusan conn-status F8).
let __proj = { life: '', act: '', att: '' };
function projSet(kind, text, tone) {
  try {
    if (!(kind in __proj)) return;
    __proj[kind] = text || '';
    const el = document.getElementById('pstate-' + kind);
    if (!el) return;
    el.textContent = text || '';
    el.className = 'pstate' + (text ? ' on' : '') + (tone ? ' ' + tone : '') + (kind === 'att' && text ? ' att-on' : '');
  } catch (e) {}
}
function projLife(text, tone) { projSet('life', text, tone); }
function projAct(text) { projSet('act', text, 'act'); }
function projAtt(text, tone) { projSet('att', text, tone || 'warn'); setTimeout(() => { if (__proj.att === text) projSet('att', ''); }, 12000); }
async function refreshStatus() {
  if (!authed) return;
  try {
    const r = await fetch('/api/me'); if (!r.ok) return;
    const d = await r.json();
    if (d.sessions && d.sessions.length) {
      sessionsCache = d.sessions;
      const active = sessionsCache.find(s => s.active);
      if (active) { currentSessionId = active.id; $('tb-title').textContent = active.name; }
      renderSessions();
    }
    updateStatus();
    // Kuota harian & tab admin (komersial — Aaron 13 Agu 2026)
    if (d.quota) {
      const qf = $('quota-fill');
      if (qf) {
        qf.style.width = Math.min(100, d.quota.percent) + '%';
        qf.style.background = d.quota.percent >= 100 ? '#ff3b30' : d.quota.percent >= 80 ? '#ff9f0a' : 'linear-gradient(135deg,var(--accent),var(--accent2))';
      }
      const sq = $('st-quota');
      if (sq) sq.textContent = d.quota.tierLabel + ' — ' + fmtNum(d.quota.usedToday) + ' / ' + fmtNum(d.quota.dailyTokens) + ' token (' + d.quota.percent + '%)' + (d.quota.overLimit ? ' ⛔ jatah habis' : '');
      // Alert kuota menipis (sekali per hari)
      if (d.quota.percent >= 80 && !localStorage.getItem('quota-warn-' + new Date().toDateString())) {
        localStorage.setItem('quota-warn-' + new Date().toDateString(), '1');
        setTimeout(() => toast('⚠️ Kuota hari ini hampir habis (' + d.quota.percent + '%) — lihat tab Paket'), 300);
      }
    }
    const adminTab = $('admin-tab');
    if (adminTab) adminTab.style.display = (d.user && d.user.role === 'admin') ? '' : 'none';
    const menuAgent = $('menu-agent');
    if (menuAgent) menuAgent.style.display = (d.user && d.user.role === 'admin') ? '' : 'none';
    const menuBisnis = $('menu-bisnis');
    if (menuBisnis) menuBisnis.style.display = (d.user && d.user.role === 'admin') ? '' : 'none';
    const accTab = $('accounting-tab');
    if (accTab) accTab.style.display = (d.user && d.user.role === 'admin') ? '' : 'none';
    const facTab = $('factor-tab');
    if (facTab) facTab.style.display = (d.user && d.user.role === 'admin') ? '' : 'none';
    const brTab = $('branding-tab');
    if (brTab) brTab.style.display = (d.user && d.user.role === 'admin') ? '' : 'none';
  } catch(e) {}
}

// ---------- Auth ----------
async function checkAuth() {
  // #15 Login Google: tampilkan pesan hasil redirect OAuth (param ?login=)
  try {
    const qs = new URLSearchParams(window.location.search);
    const lg = qs.get('login');
    if (lg) {
      const msgs = {
        google_ok: '✅ Login Google berhasil!',
        google_denied: '⚠️ Login Google dibatalkan.',
        google_invalid_state: '⚠️ Sesi login kedaluwarsa, coba lagi.',
        google_token_fail: '⚠️ Gagal verifikasi Google, coba lagi.',
        google_aud_fail: '⚠️ Verifikasi keamanan gagal (aud mismatch).',
        google_noemail: '⚠️ Akun Google tanpa email tidak bisa masuk.',
        google_error: '⚠️ Terjadi kesalahan login Google.',
        suspended: '⛔ Akun ini dinonaktifkan (suspend).',
      };
      if (msgs[lg]) setTimeout(() => toast(msgs[lg]), 800);
      history.replaceState({}, '', '/admin');
    }
  } catch (e) {}
  try {
    const r = await fetch('/api/me'); const d = await r.json();
    authed = d.authed; me = d.user;
    if (authed) {
      overlay.classList.add('hidden');
      // Branding dinamis juga untuk user yang sudah login (nama agent, placeholder, judul) — FIX audit Dinda 28 Agu 2026
      applyBranding();
      // Push Notification (fitur #1 Dinda 29 Agu 2026): aktifkan setelah login
      initPushNotifications();
      // FIX mobile (Aaron 19 Agu 2026): default sidebar collapsed di HP setelah login
      if (window.innerWidth <= 768) { $('sidebar').classList.add('collapsed'); $('sidebar-overlay').classList.remove('show'); }
      const isAdmin = me.role === 'admin';
      // FIX audit (Aaron 15 Agu 2026): menu admin DI-REMOVE dari DOM untuk member
      // (bukan cuma display:none) — defense-in-depth kalau CSS gagal load.
      if (!isAdmin) {
        ['tab-users','menu-agent','menu-bisnis','admin-tab','accounting-tab','factor-tab','branding-tab'].forEach(id => {
          const el = $(id); if (el) el.remove();
        });
      } else {
        $('tab-users').style.display = '';
      }
      updateSidebarUser();
      loadSettingsProfile();
      refreshPrime();
      refreshArtifacts();
      await refreshSessions();
      await refreshModels();
      loadSlashCache(); // Slash commands untuk autocomplete (Papi 16 Agu 2026)
      const active = sessionsCache.find(s => s.active);
      if (active) { currentSessionId = active.id; await loadSessionMessages(active.id); }
      refreshStatus();
      connectEvents();
      initScrollDown();
      initPayMethodBtns();
    } else {
      overlay.classList.remove('hidden'); applyBranding();
      setTimeout(() => $('login-username').focus(), 100);
    }
  } catch(e) { authed = false; }
}
let mfaTempToken = null;
function setLoginLoading(on) {
  const btn = $('login-btn'); if (!btn) return;
  if (on) { btn.disabled = true; btn.classList.add('loading'); btn.innerHTML = '<span class="spinner"></span><span>Masuk…</span>'; }
  else { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = 'Masuk'; }
}
function setMfaLoading(on) {
  const btn = $('mfa-verify-btn'); if (!btn) return;
  if (on) { btn.disabled = true; btn.textContent = 'Verifikasi…'; }
  else { btn.disabled = false; btn.textContent = 'Verifikasi Kode'; }
}
$('login-btn').addEventListener('click', async () => {
  setLoginLoading(true);
  try {
    const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: $('login-username').value.trim(), password: $('login-password').value }) });
    const d = await r.json().catch(()=>({}));
    if (r.ok && d.mfaRequired) {
      mfaTempToken = d.tempToken;
      $('login-error').textContent = 'Masukkan kode 6 digit dari aplikasi authenticator.';
      setLoginLoading(false);
      $('login-btn').style.display='none'; $('mfa-login-field').style.display=''; $('mfa-verify-btn').style.display='';
      $('mfa-login-code').focus();
      return;
    }
    if (r.ok) { me = d.user; $('login-error').textContent=''; overlay.classList.add('hidden'); $('login-username').value=''; $('login-password').value=''; checkAuth(); }
    else { setLoginLoading(false); $('login-error').textContent = d.error || 'Username atau password salah.'; }
  } catch(e) { setLoginLoading(false); $('login-error').textContent = 'Gagal terhubung.'; }
});
$('mfa-verify-btn').addEventListener('click', async () => {
  setMfaLoading(true);
  try {
    const r = await fetch('/api/mfa/verify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tempToken: mfaTempToken, code: $('mfa-login-code').value.trim() }) });
    const d = await r.json().catch(()=>({}));
    if (r.ok) { me = d.user; $('login-error').textContent=''; overlay.classList.add('hidden'); $('login-username').value=''; $('login-password').value=''; $('mfa-login-code').value=''; mfaTempToken=null; resetLoginMfa(); checkAuth(); }
    else { setMfaLoading(false); $('login-error').textContent = d.error || 'Kode salah.'; }
  } catch(e) { setMfaLoading(false); $('login-error').textContent = 'Gagal terhubung.'; }
});
$('mfa-login-code').addEventListener('keydown', (e) => { if (e.key==='Enter') $('mfa-verify-btn').click(); });
function resetLoginMfa() {
  $('login-btn').style.display=''; $('mfa-login-field').style.display='none'; $('mfa-verify-btn').style.display='none'; $('mfa-login-code').value='';
}
$('login-password').addEventListener('keydown', (e) => { if (e.key==='Enter') $('login-btn').click(); });
// ---------- Registrasi + pilih paket (Farrah 28 Agu 2026) ----------
let regMode = false;
function setRegMode(on) {
  regMode = on;
  $('reg-fields').style.display = on ? '' : 'none';
  $('login-btn').style.display = on ? 'none' : '';
  $('auth-toggle-label').textContent = on ? 'Sudah punya akun?' : 'Belum punya akun?';
  $('auth-toggle-link').textContent = on ? 'Masuk' : 'Daftar';
  $('login-error').textContent = '';
  $('reg-error').style.display = 'none';
}
$('auth-toggle-link').addEventListener('click', () => setRegMode(!regMode));
$('reg-btn').addEventListener('click', async () => {
  const btn = $('reg-btn');
  btn.disabled = true; btn.textContent = 'Mendaftar…';
  $('reg-error').style.display = 'none';
  try {
    const r = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      username: $('login-username').value.trim().toLowerCase(),
      password: $('login-password').value,
      name: $('reg-name').value.trim(),
      email: $('reg-email').value.trim(),
      phone: $('reg-phone').value.trim()
    })});
    const d = await r.json().catch(()=>({}));
    if (!r.ok) {
      $('reg-error').textContent = d.error || 'Gagal daftar.';
      $('reg-error').style.display = '';
      btn.disabled = false; btn.textContent = 'Daftar & Pilih Paket';
      return;
    }
    me = d.user;
    overlay.classList.add('hidden');
    $('login-username').value=''; $('login-password').value=''; $('reg-name').value=''; $('reg-email').value=''; $('reg-phone').value='';
    setRegMode(false);
    checkAuth();
    // langsung buka panel Paket & Billing (pilih paket)
    try { switchTab('paket'); } catch(e) {}
    toast('🎉 Akun dibuat! Pilih paket kamu.');
  } catch(e) {
    $('reg-error').textContent = 'Gagal terhubung.';
    $('reg-error').style.display = '';
    btn.disabled = false; btn.textContent = 'Daftar & Pilih Paket';
  }
});
$('login-password').addEventListener('keydown', (e) => { if (e.key==='Enter' && regMode) $('reg-btn').click(); });
$('logout-btn').addEventListener('click', async () => { await fetch('/api/logout',{method:'POST'}); authed=false; location.reload(); });

// ---------- Prime avatar ----------
async function refreshPrime() {
  try { const r = await fetch('/api/prime'); const d = await r.json(); primeHasAvatar = d.hasAvatar; updatePrimeAvatarEls(); } catch(e) {}
}
function updatePrimeAvatarEls() {
  const src = primeHasAvatar ? '/api/avatar?prime=1&t=' + Date.now() : '';
  const el = $('prime-avatar-msg');
  if (primeHasAvatar) { const img = document.createElement('img'); img.src = src; img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;'; el.innerHTML=''; el.appendChild(img); }
  else el.textContent = '🤖';
  const pv = $('prime-avatar-preview');
  if (primeHasAvatar) { pv.innerHTML = ''; const img = document.createElement('img'); img.src = src; img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;'; pv.appendChild(img); }
  else pv.textContent = '🤖';
}

// ---------- Chat ----------
let lastUserMsg = ''; // untuk regenerate
// FIX (Papi 16 Agu 2026): tampilkan tanggal & jam jawaban di samping tombol aksi.
// Format: DD/MM/YYYY HH:mm (24 jam) — contoh 16/08/2026 11:36. Pakai zona waktu browser user.
function fmtMsgTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}
function addMessage(role, text, withActions, container, ts) {
  const div = document.createElement('div'); div.className='msg '+role;
  const avatar = document.createElement('div'); avatar.className='avatar';
  if (role === 'assistant') {
    if (primeHasAvatar) { const img = document.createElement('img'); img.src='/api/avatar?prime=1&t='+Date.now(); img.style.cssText='width:100%;height:100%;border-radius:50%;object-fit:cover;'; avatar.appendChild(img); }
    else avatar.textContent = '🤖';
  } else {
    if (me && me.hasAvatar) { const img = document.createElement('img'); img.src='/api/avatar?u='+me.id+'&t='+Date.now(); img.style.cssText='width:100%;height:100%;border-radius:50%;object-fit:cover;'; avatar.appendChild(img); }
    else avatar.textContent = '👤';
  }
  const bubble = document.createElement('div'); bubble.className='bubble';
  div.appendChild(avatar); div.appendChild(bubble);
  // ISI TEKS — fix: pesan dari riwayat tidak pernah tampil karena teks tidak di-render
  if (text) {
    if (role === 'assistant') renderRichText(bubble, text);
    else bubble.textContent = text;
  }
  if (withActions !== false) {
    const actions = document.createElement('div'); actions.className='msg-actions';
    if (role === 'assistant') {
      // 3 tombol utama di bawah jawaban (instruksi Papi 15 Agu 2026): Copy, Refresh, Share
      const copyBtn = document.createElement('button'); copyBtn.className='icon-btn'; copyBtn.title='Salin'; copyBtn.textContent='⧉';
      copyBtn.addEventListener('click', () => { safeCopy(text, 'Disalin ✅'); });
      actions.appendChild(copyBtn);
      const regenBtn = document.createElement('button'); regenBtn.className='icon-btn'; regenBtn.title='Ulangi'; regenBtn.textContent='↻';
      regenBtn.addEventListener('click', () => { if (lastUserMsg && !busy) { toast('Mengulang jawaban…'); doSend(lastUserMsg); } else toast('Belum ada pesan untuk diulang'); });
      actions.appendChild(regenBtn);
      // Branching (Papi 16 Agu 2026): 🌿 buat cabang dari jawaban ini — konteks sampai sini disalin, alur baru bebas bereksperimen
      const branchBtn = document.createElement('button'); branchBtn.className='icon-btn'; branchBtn.title='Buat cabang dari jawaban ini (konteks terbawa, alur asli aman)'; branchBtn.textContent='🌿';
      branchBtn.addEventListener('click', async () => {
        // hitung urutan pesan ini (user+assistant) di antara semua pesan di DOM — pakai bubble ini sebagai penanda
        let seq = -1;
        let counter = 0;
        const allMsgEls = document.querySelectorAll('#messages .msg');
        for (const el of allMsgEls) {
          if (el.contains(bubble)) { seq = counter; break; }
          counter++;
        }
        await branchSession(seq);
      });
      actions.appendChild(branchBtn);
      // F55 Voice Readout (9 Sep 2026): dengarkan jawaban pakai TTS browser (gratis, tanpa server).
      const voiceBtn = document.createElement('button'); voiceBtn.className='icon-btn'; voiceBtn.title='Dengarkan jawaban (suara)'; voiceBtn.textContent='🔊';
      let speaking = false;
      voiceBtn.addEventListener('click', () => {
        try {
          if (speaking) { speechSynthesis.cancel(); speaking = false; voiceBtn.textContent='🔊'; return; }
          const plain = (bubble.textContent || text || '').replace(/\s+/g, ' ').trim();
          if (!plain) { toast('Tidak ada teks untuk dibacakan'); return; }
          const u = new SpeechSynthesisUtterance(plain);
          u.lang = 'id-ID'; u.rate = 1.02; u.pitch = 1.0;
          u.onend = u.onerror = () => { speaking = false; voiceBtn.textContent='🔊'; };
          speechSynthesis.cancel();
          speechSynthesis.speak(u);
          speaking = true; voiceBtn.textContent='⏹';
        } catch (e) { toast('Suara tidak didukung browser ini'); }
      });
      actions.appendChild(voiceBtn);
      addShareBtn(actions, text); // Share → Word, PDF, MD, Print
    } else {
      const editBtn = document.createElement('button'); editBtn.className='icon-btn'; editBtn.title='Edit'; editBtn.textContent='✏️ Edit';
      editBtn.addEventListener('click', () => { inputEl.value = text; inputEl.focus(); autoGrow(); toast('Pesan diisi ulang — kirim untuk edit'); });
      actions.appendChild(editBtn);
    }
    // Waktu jawaban/pesan di samping tombol (instruksi Papi 15 Agu 2026)
    const time = document.createElement('span'); time.className = 'msg-time'; time.textContent = fmtMsgTime(ts);
    actions.appendChild(time);
    bubble.appendChild(actions);
  }
  (container || messagesEl).appendChild(div);
  if (!container) messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}
function addTyping() {
  const div = document.createElement('div'); div.className='msg assistant';
  const avatar = document.createElement('div'); avatar.className='avatar thinking';
  if (primeHasAvatar) { const img = document.createElement('img'); img.src='/api/avatar?prime=1&t='+Date.now(); img.style.cssText='width:100%;height:100%;border-radius:50%;object-fit:cover;'; avatar.appendChild(img); }
  else avatar.textContent = '🤖';
  div.innerHTML = `<div class="bubble typing"><span>▍</span><span>▍</span><span>▍</span></div>`;
  div.prepend(avatar);
  messagesEl.appendChild(div); messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}
function addCodeBlock(bubble, code, lang) {
  const wrap = document.createElement('div'); wrap.className='code-block';
  wrap.innerHTML = `<div class="code-head"><span>${escapeHtml(lang||'code')}</span><button class="btn small">⧉ Copy</button></div><pre><code></code></pre>`;
  const codeEl = wrap.querySelector('code'); codeEl.textContent = code;
  if (lang && hljs.getLanguage(lang)) { codeEl.className = 'language-'+lang; try { hljs.highlightElement(codeEl); } catch(e){} }
  wrap.querySelector('.code-head button').addEventListener('click', () => { safeCopy(code, 'Kode disalin ✅'); });
  bubble.appendChild(wrap);
}
// FIX (Papi 15 Agu 2026): rewrite <img> markdown yang menunjuk ke path workspace
// (relatif atau /workspace/...) → endpoint API raw binary, supaya chart/gambar tampil inline.
function rewriteWorkspaceImgs(container) {
  container.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('http') || src.startsWith('data:') || src.startsWith('/api/')) return;
    let p = src.split('#')[0].split('?')[0];
    // Fix gambar (Aaron 6 Sep 2026): agent menulis path ABSOLUT /workspace/<uid>/file.png.
    // Dulu prefix /workspace/ dibuang mentah -> <uid>/file.png, padahal server resolve dari
    // folder user (/workspace/<uid>) -> path dobel .../<uid>/<uid>/file.png -> 404 utk member.
    p = p.replace(/^\/workspace\//, '').replace(/^workspace\//, '').replace(/^\.\//, '').replace(/^\/+/, '');
    if (me && me.id && p.indexOf(me.id + '/') === 0) p = p.slice(me.id.length + 1);
    if (!p) return;
    img.src = '/api/artifact?path=' + encodeURIComponent(p) + '&raw=1';
    img.style.cssText = (img.style.cssText || '') + ';max-width:100%;border-radius:10px;margin:8px 0;';
  });
}
function renderRichText(bubble, text) {
  // markdown penuh via marked + DOMPurify, tapi code block pakai highlight.js
  // F37 (9 Sep 2026): blok ```mermaid dirender diagram; $$...$$ / $...$ math pakai KaTeX (lazy-load).
  const parts = text.split(/```(\w*)\n?/);
  for (let i=0;i<parts.length;i++) {
    if (i%2===1) {
      const lang = parts[i] || ''; const code = parts[i+1] || '';
      if (lang === 'mermaid' && code.trim()) { addMermaidBlock(bubble, code); i++; continue; }
      addCodeBlock(bubble, code.replace(/\n$/,''), lang); i++;
    }
    else if (parts[i]) {
      const div = document.createElement('div');
      div.innerHTML = renderMd(parts[i]);
      rewriteWorkspaceImgs(div);
      bubble.appendChild(div);
      renderMathInDiv(div); // F37: inline/block math
    }
  }
  // buka link di tab baru
  bubble.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
}
// F37 (9 Sep 2026, PRD F37): diagram Mermaid — lazy-load CDN sekali, render semua .mermaid-box.
let __mermaidLoaded = false;
function addMermaidBlock(bubble, code) {
  const box = document.createElement('div'); box.className = 'mermaid-box';
  box.textContent = code; // teks mentah aman; mermaid baca dari sini
  bubble.appendChild(box);
  if (!__mermaidLoaded) {
    __mermaidLoaded = true;
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mermaid/10.9.1/mermaid.min.js';
    s.onload = () => {
      try {
        if (window.mermaid) mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        document.querySelectorAll('.mermaid-box').forEach((el) => {
          try { if (el.dataset.done) return; el.dataset.done = '1'; const src = el.textContent; el.textContent=''; mermaid.render('mmd-' + Math.random().toString(36).slice(2, 8), src).then((r) => { el.innerHTML = r.svg; }).catch(() => { el.textContent = '⚠️ Gagal render diagram.'; }); } catch (e) {}
        });
      } catch (e) {}
    };
    s.onerror = () => { document.querySelectorAll('.mermaid-box').forEach((el) => { el.textContent = '[diagram mermaid — CDN gagal dimuat]'; }); };
    document.head.appendChild(s);
  } else {
    setTimeout(() => {
      try {
        if (window.mermaid) document.querySelectorAll('.mermaid-box').forEach((el) => {
          try { if (el.dataset.done) return; el.dataset.done = '1'; const src = el.textContent; el.textContent=''; mermaid.render('mmd-' + Math.random().toString(36).slice(2, 8), src).then((r) => { el.innerHTML = r.svg; }).catch(() => { el.textContent = '⚠️ Gagal render diagram.'; }); } catch (e) {}
        });
      } catch (e) {}
    }, 300);
  }
}
// F37 (9 Sep 2026): math KaTeX — lazy-load sekali, render elemen yang mengandung $...$.
let __katexLoaded = false;
function renderMathInDiv(div) {
  try {
    if (!div || !div.innerHTML) return;
    if (!/\$\$?[^$]+\$\$?/.test(div.innerHTML)) return;
    if (!__katexLoaded) {
      __katexLoaded = true;
      const l1 = document.createElement('link'); l1.rel='stylesheet'; l1.href='https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.css'; document.head.appendChild(l1);
      const s = document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.9/katex.min.js'; s.onload = () => { try { renderMathInDiv(div); } catch(e){} }; document.head.appendChild(s);
      return;
    }
    if (!window.katex) return;
    // $$...$$ block lalu $...$ inline (hindari yang sudah di-render)
    div.querySelectorAll(':scope > *').forEach((el) => {
      if (el.querySelector('.katex')) return;
      const walk = (node) => {
        if (node.nodeType !== 3) { Array.from(node.childNodes).forEach(walk); return; }
        const t = node.textContent || '';
        if (!/\$\$?[^$]+\$\$?/.test(t)) return;
        const frag = document.createDocumentFragment(); let rest = t;
        const re = /\$\$([^$]+)\$\$|\$([^$\n]+)\$/g; let m, last = 0; let changed = false;
        while ((m = re.exec(rest))) {
          const isBlock = !!m[1]; const expr = (m[1] || m[2] || '').trim();
          if (last < m.index) frag.appendChild(document.createTextNode(rest.slice(last, m.index)));
          try { const span = document.createElement('span'); if (isBlock) span.style.display='block'; span.className='katex-wrap'; katex.render(expr, span, { displayMode: isBlock, throwOnError: false }); frag.appendChild(span); changed = true; } catch (e) { frag.appendChild(document.createTextNode(m[0])); }
          last = m.index + m[0].length;
        }
        if (changed && last < rest.length) frag.appendChild(document.createTextNode(rest.slice(last)));
        if (changed) node.parentNode.replaceChild(frag, node);
      };
      walk(el);
    });
  } catch (e) {}
}
let planMode = false;
$('plan-toggle').addEventListener('click', () => {
  planMode = !planMode;
  $('plan-toggle').classList.toggle('active', planMode);
  $('plan-hint').style.display = planMode ? '' : 'none';
  toast(planMode ? '🧠 Mode Rencana ON — Agent jelaskan dulu' : 'Mode Rencana OFF');
});
async function send() {
  const msg = inputEl.value.trim();
  if (!msg && pendingImages.length === 0) return;
  inputEl.value=''; inputEl.style.height='auto';
  const text = msg;
  doSend(text);
}
// ===== Live process (Aaron 6 Sep 2026): streaming teks + log tool ala Hermes =====
let __proc = null; // { box, tools: {name: element}, t0: {name: ts} }
let __lastCost = null; // usage agent_end terakhir, ditempel ke bubble setelah render final
let __lastSuggest = null; // F4: saran keputusan (mode diskusi) dari agent_end
let __turnFiles = []; // F32: file yang ditulis/diubah turn ini (dari event changes)
let __turnChanges = []; // F13: rincian perubahan giliran ini {path, added, deleted}
let __reqId = null; // F62: id kiriman aktif (anti prompt ganda)
let __eventLog = []; // F39: ring buffer event SSE terakhir (monitor live)
let __monT = 0; // F39: throttle render panel monitor
let __lastTurnFiles = []; // F24: snapshot file turn terakhir utk chip saran dinamis
// F1 Kartu Tool Hidup (9 Sep 2026, PRD F1): ikon kategori + status + durasi, expand/collapse.
// F3 label fase aman (9 Sep 2026): HANYA label Indonesia, JANGAN pernah tampilkan thinking mentah.
let __fase = null; // elemen kecil fase kerja (F3)
function toolFaseLabel(name, kind) {
  const n = String(name || '').toLowerCase();
  if (kind === 'tool') {
    if (/(bash|shell|exec|terminal|command|apt|npm|pip|docker|system)/.test(n)) return 'menjalankan perintah';
    if (/(read|write|file|fs|edit|grep|search_file|patch)/.test(n)) return 'membaca/menulis file';
    if (/(web|http|fetch|curl|browse|search|scrape)/.test(n)) return 'mencari di web';
    if (/git/.test(n)) return 'mengelola git';
    if (/(image|gambar|photo|screenshot|vision)/.test(n)) return 'memeriksa gambar';
    if (/(rlm|subagent|delegate|child)/.test(n)) return 'membagi tugas ke sub-agent';
    if (/(plan|ask|confirm|clarif)/.test(n)) return 'menyusun rencana';
    return 'menjalankan ' + (name || 'tool');
  }
  return 'bekerja…';
}
function procToolPhase(fase) {
  try {
    if (!__proc || !__proc.box) return;
    let el = __proc.box.querySelector('.proc-phase');
    if (!el) { el = document.createElement('div'); el.className = 'proc-phase'; __proc.box.insertBefore(el, __proc.box.firstChild); }
    const labels = { 'menjawab': '✍️ Menyusun jawaban…' };
    el.textContent = labels[fase] || '';
    // F9 (9 Sep 2026): tampilkan label hanya fase yang aktif — kalau '' → sembunyikan elemen
    el.style.display = el.textContent ? '' : 'none';
  } catch (e) {}
}
function toolIconFor(name) {
  const n = String(name || '').toLowerCase();
  if (/(bash|shell|sh$|exec|terminal|command|apt|npm|pip|docker|system)/.test(n)) return '🖥️';
  if (/(python|py$|node|js$|kernel|ipython|repl|notebook)/.test(n)) return '🐍';
  if (/(read|write|file|fs|mkdir|edit|append|grep|search_file|glob|patch|list)/.test(n)) return '📄';
  if (/(web|http|fetch|curl|browse|url|search|scrape|news|rss)/.test(n)) return '🌐';
  if (/git/.test(n)) return '🌿';
  if (/mcp/.test(n)) return '🔌';
  if (/(image|gambar|photo|screenshot|vision|video|audio)/.test(n)) return '🖼️';
  if (/(plan|tanya|ask|approval|confirm|clarif|choice|dialog)/.test(n)) return '📋';
  if (/(rlm|subagent|child|agent|delegate)/.test(n)) return '🤖';
  return '🔧';
}
function procTool(name, state, extra) {
  try {
    if (!__proc) return;
    if (state === 'start') {
      if (__proc.tools[name]) return;
      const d = document.createElement('div');
      d.className = 'tool-card run';
      d.innerHTML = '<span class="tool-ico">' + toolIconFor(name) + '</span>'
        + '<span class="tool-name"><b>' + escapeHtml(name) + '</b><span class="tool-status">menjalankan…</span></span>'
        + '<span class="tool-spin">◌</span>';
      if (!__proc.t0) __proc.t0 = {};
      __proc.t0[name] = Date.now();
      d.addEventListener('click', () => d.classList.toggle('expanded'));
      __proc.box.appendChild(d);
      __proc.tools[name] = d;
      // F9 (9 Sep 2026): tool baru mulai → fase "menyusun jawaban" dari delta sebelumnya tidak relevan.
      const ph = __proc.box.querySelector('.proc-phase');
      if (ph) { ph.textContent = ''; ph.style.display = 'none'; }
      chatScrollBottom();
    } else if (state === 'update') {
      // F12 (9 Sep 2026): output tool LIVE dari tool_execution_update (partialResult).
      const d = __proc.tools[name];
      if (!d || !extra || !extra.text) return;
      let outEl = d.querySelector('.tool-out');
      if (!outEl) {
        outEl = document.createElement('div'); outEl.className = 'tool-out';
        d.appendChild(outEl);
      }
      outEl.textContent = String(extra.text).slice(-1500);
      d.classList.add('has-out');
    } else if (state === 'end' || state === 'error') {
      const d = __proc.tools[name];
      if (d) {
        const isErr = state === 'error' || (extra && extra.ok === false);
        d.classList.remove('run'); d.classList.add(isErr ? 'err' : 'done');
        const ms = (extra && extra.durationMs) || (__proc.t0 && __proc.t0[name] ? (Date.now() - __proc.t0[name]) : 0);
        const dur = ms >= 1000 ? (ms / 1000).toFixed(1) + ' dtk' : ms + ' ms';
        const st = d.querySelector('.tool-status');
        if (st) st.textContent = (isErr ? '❌ gagal' : '✅ selesai') + ' · ' + dur;
        const sp = d.querySelector('.tool-spin'); if (sp) sp.remove();
        // F12: tempel output akhir + error (kalau ada) supaya bisa dibaca tanpa buka log
        if (extra && (extra.output || extra.error)) {
          let outEl = d.querySelector('.tool-out');
          if (!outEl) { outEl = document.createElement('div'); outEl.className = 'tool-out'; d.appendChild(outEl); }
          const shown = (extra.error ? '⚠️ ' + extra.error + '\n' : '') + (extra.output || '');
          outEl.textContent = String(shown).slice(-2500);
          d.classList.add('has-out');
        }
      }
    }
  } catch (e) {}
}
// Cost Transparency #13 (Papi 16 Agu): tampilkan "Token: X · Biaya: RpY" di bawah jawaban.
// Dipisah dari handler agent_end karena render ulang streaming bisa menghapus elemen yang
// ditempel terlalu dini (Papi 7 Sep 2026: "informasi harga token tidak muncul").
function applyCostToBubble(bubble, usage) {
  try {
    if (!bubble || !usage) return;
    let costEl = bubble.querySelector('.msg-cost');
    if (!costEl) { costEl = document.createElement('div'); costEl.className = 'msg-cost'; bubble.appendChild(costEl); }
    const tk = usage.tokens || 0;
    const usd = usage.cost || 0;
    const rp = Math.round(usd * 18000);
    costEl.textContent = tk > 0
      ? 'Token: ' + Number(tk).toLocaleString('id-ID') + ' · Biaya: Rp' + (rp >= 1 ? rp.toLocaleString('id-ID') : '<1')
      : 'Token: 0 · Biaya: Rp0';
  } catch (e) {}
}
function tryAppendPendingCost() {
  if (!__lastCost) return;
  const bubbles = document.querySelectorAll('.msg.assistant .bubble');
  const lastB = bubbles[bubbles.length - 1];
  if (!lastB) return;
  if (lastB.querySelector('.stream-box') || lastB.querySelector('.proc-log')) return; // masih streaming -> nanti doSend yang tempel
  applyCostToBubble(lastB, __lastCost);
  __lastCost = null;
}
// F4 Dialog sintesis (9 Sep 2026): mode diskusi → tampilkan kartu keputusan setelah jawaban.
function applySuggestToBubble(bubble, suggest) {
  try {
    if (!bubble || !suggest || suggest.kind !== 'approve_revise') return;
    if (bubble.querySelector('.suggest-dialog')) return;
    const card = document.createElement('div'); card.className = 'suggest-dialog';
    card.innerHTML = '<div class="sd-title">🤔 Dinda menunggu keputusanmu</div>'
      + '<div class="sd-body">Rencana/ide di atas masih mode diskusi — belum dieksekusi. Setujui untuk lanjut eksekusi, atau minta revisi dulu.</div>'
      + '<div class="sd-actions">'
      + '<button type="button" class="sd-btn primary" id="sd-approve">✅ Setujui & Eksekusi</button>'
      + '<button type="button" class="sd-btn" id="sd-revise">✏️ Minta revisi</button>'
      + '<button type="button" class="sd-btn ghost" id="sd-ignore">Tutup</button>'
      + '</div>';
    bubble.appendChild(card);
    card.querySelector('#sd-approve').addEventListener('click', async () => {
      card.querySelectorAll('button').forEach((b) => b.disabled = true);
      // Aktifkan mode eksekusi via API mode, lalu kirim perintah lanjut.
      try { await fetch('/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'eksekusi' }) }); } catch (e) {}
      toast('✅ Mode eksekusi aktif — Dinda mulai bekerja');
      setTimeout(() => doSend('Lanjutkan — setujui rencana di atas dan eksekusi sekarang.'), 300);
    });
    card.querySelector('#sd-revise').addEventListener('click', () => {
      card.remove();
      toast('✍️ Tulis revisi/arahan di kotak pesan lalu kirim');
      try { inputEl.focus(); } catch (e) {}
    });
    card.querySelector('#sd-ignore').addEventListener('click', () => card.remove());
  } catch (e) {}
}
function tryAppendPendingSuggest() {
  if (!__lastSuggest) return;
  const bubbles = document.querySelectorAll('.msg.assistant .bubble');
  const lastB = bubbles[bubbles.length - 1];
  if (!lastB) return;
  if (lastB.querySelector('.stream-box') || lastB.querySelector('.proc-log')) return;
  applySuggestToBubble(lastB, __lastSuggest);
  __lastSuggest = null;
}
function chatScrollBottom() {
  try { messagesEl.scrollTop = messagesEl.scrollHeight; } catch (e) {}
}
// ===== Suggested replies (Papi 7 Sep 2026 — audit P1) =====
// Setelah jawaban selesai, tampilkan 3 aksi lanjut cepat di bawah bubble.
function addSuggestRow(bubble) {
  try {
    const row = document.createElement('div'); row.className = 'suggest-row';
    const items = [
      { icon: '📌', label: 'Ringkas jawaban', q: 'Ringkas jawaban terakhirmu dalam 3-5 poin singkat.' },
      { icon: '📝', label: 'Buat contoh', q: 'Buatkan contoh konkret dari jawaban terakhirmu.' },
      { icon: '🔍', label: 'Detail & langkah', q: 'Jelaskan jawaban terakhirmu lebih detail langkah demi langkah.' },
    ];
    // F24 Chip Saran Dinamis (9 Sep 2026): kalau turn tadi menulis/mengubah file,
    // tampilkan saran KONTEKSTUAL paling depan (berbasis file itu), tanpa panggil API ekstra.
    let dynamic = [];
    const ctxFile = (__lastTurnFiles && __lastTurnFiles.length) ? String(__lastTurnFiles[__lastTurnFiles.length - 1]).split('/').pop() : null;
    if (ctxFile) {
      dynamic = [
        { icon: '🐛', label: 'Periksa ' + ctxFile, q: 'Periksa file ' + ctxFile + ' — apakah ada bug atau yang perlu diperbaiki? Laporkan lalu perbaiki.' },
        { icon: '🧪', label: 'Tes ' + ctxFile, q: 'Buat & jalankan tes singkat untuk ' + ctxFile + ' supaya yakin hasil kerjamu benar.' },
        { icon: '📖', label: 'Jelaskan ' + ctxFile, q: 'Jelaskan isi file ' + ctxFile + ' dengan bahasa sederhana.' },
      ];
    }
    dynamic.concat(items).forEach((it) => {
      const c = document.createElement('button'); c.className = 'suggest-chip'; c.type = 'button';
      c.innerHTML = '<span>' + it.icon + '</span> ' + escapeHtml(it.label);
      c.title = it.q;
      c.addEventListener('click', () => sendFollowUp(it.q));
      row.appendChild(c);
    });
    bubble.appendChild(row);
  } catch (e) {}
}
function sendFollowUp(q) {
  if (busy) { toast('Tunggu jawaban selesai dulu'); return; }
  doSend(q);
}
async function doSend(rawMsg) {
  const hasImages = pendingImages.length > 0;
  const hasFiles = pendingFiles.length > 0;
  if ((!rawMsg && !hasImages && !hasFiles)) return;
  // F5 Antrian (9 Sep 2026): kalau Dinda masih bekerja, pesan TIDAK ditolak —
  // masuk antrean & tampil di atas input; dieksekusi otomatis setelah selesai.
  if (busy) {
    queuePush(rawMsg || '', hasImages, hasFiles);
    toast('⏳ Dinda masih bekerja — pesan masuk antrean.');
    return;
  }
  const imagesPayload = pendingImages.slice();
  const filesPayload = pendingFiles.slice();
  pendingImages = []; pendingFiles = []; renderImagePreview();
  lastUserMsg = rawMsg;
  const msg = planMode ? 'MODE RENCANA: Jangan eksekusi dulu. Jelaskan rencanamu langkah demi langkah, tunggu konfirmasiku sebelum mulai bekerja. Tugas: ' + rawMsg : rawMsg;
  const label = rawMsg || (hasFiles ? '(file)' : '(gambar)');
  addMessage('user', label, true, null, Date.now());
  maybeAutoTitle(label); // subject otomatis dari pesan pertama (sesi baru)
  busy = true; sendBtn.disabled = false; $('stop-btn').style.display = '';
  setTitleBusy(true); // F47: indikator tab saat agent bekerja
  projLife('🟢 hidup', 'ok'); projAct('mengirim permintaan…'); // F61: lifecycle+activity
  // F5 (9 Sep 2026): tombol Kirim TIDAK di-disable saat busy — user boleh mengetik pesan
  // lanjutan yang akan masuk ANTREAN (queuePush di doSend). Disable hanya saat benar-benar
  // tidak ada teks/gambar (guard doSend). Stop button tetap tersedia untuk hentikan paksa.
  __lastCost = null; // jangan bawa usage prompt sebelumnya
  setActivity(true, 'memulai…');
  const typingEl = addTyping();
  const bubble = typingEl.querySelector('.bubble'); bubble.classList.remove('typing'); bubble.textContent='';
  // Live process: area log tool (atas) + area teks streaming (isi final di-render markdown setelah selesai)
  const procBox = document.createElement('div'); procBox.className = 'proc-log';
  const streamBox = document.createElement('div'); streamBox.className = 'stream-box';
  bubble.appendChild(procBox); bubble.appendChild(streamBox);
  __proc = { box: procBox, tools: {} };
  const streamTextNode = document.createTextNode('');
  streamBox.appendChild(streamTextNode);
  try {
    const body = { message: msg };
    if (imagesPayload.length) body.images = imagesPayload;
    if (filesPayload.length) body.files = filesPayload;
    // F62 (9 Sep 2026): requestId unik per kiriman — server menolak kiriman GANDA dengan id sama
    // (mis. browser retry otomatis / dobel klik). Mencegah prompt diproses dua kali.
    if (!__reqId) __reqId = 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    body.requestId = __reqId;
    const res = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    __reqId = null; // sudah diterima server → kiriman berikutnya dapat id baru
    if (res.status===401) { bubble.textContent='Sesi berakhir, silakan login ulang.'; overlay.classList.remove('hidden'); }
    else if (!res.ok) {
      // F6 Kartu Error Terstruktur (9 Sep 2026, PRD F6): jangan tampil mentah — kartu + tombol remediasi.
      const d = await res.json().catch(()=>({}));
      const errMsg = String(d.error || ('HTTP ' + res.status) || 'Terjadi kesalahan').slice(0, 300);
      let code = 'unknown'; let isTerm = false; let remedy = '';
      if (/koneksi|connect|ECONN|socket|jaringan|network/i.test(errMsg)) { code = 'connection'; remedy = 'coba-ulang'; }
      else if (/timeout|mati|hang/i.test(errMsg)) { code = 'timeout'; remedy = 'coba-ulang'; }
      else if (/rate|limit|429|terlalu cepat/i.test(errMsg)) { code = 'rate_limit'; remedy = 'tunggu'; }
      else if (/quota|budget|saldo|limit harian/i.test(errMsg)) { code = 'quota'; remedy = 'pengaturan'; isTerm = true; }
      else if (/konteks|context|panjang|besar/i.test(errMsg)) { code = 'context_full'; remedy = 'sesi-baru'; isTerm = true; }
      else if (/izin|login|sesi berakhir|401|403/i.test(errMsg)) { code = 'auth'; remedy = 'login'; isTerm = true; }
      else { code = 'unknown'; remedy = 'coba-ulang'; }
      const card = document.createElement('div'); card.className = 'error-card';
      card.innerHTML = '<div class="error-card-head">⚠️ <b>Terjadi kendala</b> <span class="error-code">' + escapeHtml(code) + '</span></div>'
        + '<div class="error-card-body">' + escapeHtml(errMsg) + '</div>'
        + '<div class="error-card-actions"></div>';
      const actBox = card.querySelector('.error-card-actions');
      const mkBtn = (label, fn) => { const b = document.createElement('button'); b.type='button'; b.className='error-card-btn'; b.textContent = label; b.addEventListener('click', fn); actBox.appendChild(b); };
      if (remedy === 'coba-ulang') mkBtn('↻ Coba ulang', () => { if (!busy && lastUserMsg) doSend(lastUserMsg); });
      else if (remedy === 'sesi-baru') mkBtn('🆕 Sesi baru', () => { if (window.newChat) newChat(); });
      else if (remedy === 'pengaturan') mkBtn('⚙️ Pengaturan', () => { try { switchTab('prime'); } catch(e){} });
      else if (remedy === 'login') mkBtn('🔑 Login ulang', () => { try { window.location.reload(); } catch(e){} });
      else mkBtn('↻ Coba ulang', () => { if (!busy && lastUserMsg) doSend(lastUserMsg); });
      if (!isTerm) mkBtn('Kirim ulang pesan', () => { if (!busy) doSend(lastUserMsg); });
      bubble.appendChild(card);
    }
    else {
      const reader = res.body.getReader(); const decoder = new TextDecoder();
      let raw = '';
      // Streaming LIVE: tampilkan teks per chunk (server kirim delta per event, bukan nunggu selesai)
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value,{stream:true});
        if (chunk) { raw += chunk; streamTextNode.data = raw; chatScrollBottom(); }
      }
      // Selesai: bersihkan area proses, render markdown penuh + ringkasan tool yang dipakai
      const toolUsed = __proc ? Object.keys(__proc.tools) : [];
      __proc = null;
      bubble.innerHTML='';
      if (toolUsed.length) {
        const sum = document.createElement('div'); sum.className = 'proc-summary';
        sum.title = toolUsed.join(', ');
        sum.textContent = '🔧 ' + toolUsed.join(', ');
        bubble.appendChild(sum);
      }
      renderRichText(bubble, raw);
      // F32 (9 Sep 2026): pill "file yang ditulis turn ini" — ringkas, sebelum biaya token.
      if (__turnFiles.length) {
        try {
          const tf = document.createElement('div'); tf.className = 'turn-files';
          const names = __turnFiles.slice(-6).map((f) => String(f).split('/').pop()).join(', ');
          tf.innerHTML = '📝 File turn ini: <b>' + escapeHtml(names) + '</b>' + (__turnFiles.length > 6 ? ' +' + (__turnFiles.length - 6) : '');
          bubble.appendChild(tf);
        } catch (e) {}
        __lastTurnFiles = __turnFiles.slice(); // F24: simpan utk saran kontekstual
        __turnFiles = [];
      }
      renderChangeSummary(bubble); // F13: kartu ringkas perubahan file giliran ini
      if (__lastCost) { applyCostToBubble(bubble, __lastCost); __lastCost = null; }
      if (__lastSuggest) { applySuggestToBubble(bubble, __lastSuggest); __lastSuggest = null; } // F4: kartu keputusan mode diskusi
      // 3 tombol utama jawaban streaming (instruksi Papi 15 Agu 2026): Copy, Refresh, Share
      const actions = document.createElement('div'); actions.className='msg-actions';
      const copyBtn = document.createElement('button'); copyBtn.className='icon-btn'; copyBtn.title='Salin'; copyBtn.textContent='⧉';
      copyBtn.addEventListener('click', () => { safeCopy(raw, 'Disalin ✅'); });
      actions.appendChild(copyBtn);
      const regenBtn = document.createElement('button'); regenBtn.className='icon-btn'; regenBtn.title='Ulangi'; regenBtn.textContent='↻';
      regenBtn.addEventListener('click', () => { if (lastUserMsg && !busy) { toast('Mengulang jawaban…'); doSend(lastUserMsg); } else toast('Belum ada pesan untuk diulang'); });
      actions.appendChild(regenBtn);
      const branchBtn = document.createElement('button'); branchBtn.className='icon-btn'; branchBtn.title='Buat cabang dari jawaban ini'; branchBtn.textContent='🌿';
      branchBtn.addEventListener('click', async () => {
        let seq = -1, counter = 0;
        const allMsgEls = document.querySelectorAll('#messages .msg');
        for (const el of allMsgEls) { if (el.contains(bubble)) { seq = counter; break; } counter++; }
        await branchSession(seq);
      });
      actions.appendChild(branchBtn);
      addShareBtn(actions, raw); // Share → Word, PDF, MD, Print
      // Waktu jawaban di samping tombol (instruksi Papi 15 Agu 2026)
      const time = document.createElement('span'); time.className = 'msg-time'; time.textContent = fmtMsgTime(Date.now());
      actions.appendChild(time);
      bubble.appendChild(actions);
      addSuggestRow(bubble); // saran lanjutan (Papi 7 Sep 2026)
      groupAllTurns(); // F60: kelompokkan giliran ini jadi blok yang bisa dilipat
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } catch(e) { bubble.textContent='Gagal terhubung ke server: '+e.message; }
  busy=false; sendBtn.disabled=false; $('stop-btn').style.display = 'none';
  __proc = null;
  setActivity(false);
  setTitleBusy(false); // F47: selesai → judul tab pulih
  inputEl.focus();
  queueDrain(); // F5: proses pesan antrean berikutnya setelah turn selesai
  setTimeout(() => { coalescedRefresh(0); }, 1500); // F28: satu gelombang refresh (bukan 3 request terpisah)
}
// Subject otomatis: sesi baru langsung diberi judul dari pesan pertama user (gaya ChatGPT)
function maybeAutoTitle(raw) {
  const active = sessionsCache.find(s => s.active);
  if (!active || !currentSessionId) return;
  const cur = (active.name || '').toLowerCase().trim();
  if (cur !== 'sesi-baru' && cur !== 'sesi baru') return;
  const title = deriveTitle(raw);
  if (!title) return;
  fetch('/api/sessions/' + currentSessionId + '/rename', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: title })
  }).then(r => { if (r.ok) refreshSessions(); }).catch(() => {});
}
function deriveTitle(t) {
  let s = String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~\[\]()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (s.length < 4) return '';
  if (s.length > 48) s = s.slice(0, 48).trim();
  s = s.replace(/[.,;:!?]+$/, '').trim();
  return s || '';
}
$('stop-btn').addEventListener('click', async () => {
  try { await fetch('/api/abort', { method:'POST' }); toast('⏹ Menghentikan Agent…'); } catch(e) { toast('Gagal stop'); }
});
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => { if (e.key==='Enter' && !e.shiftKey){e.preventDefault();send();} autoGrow(); });
function autoGrow(){ inputEl.style.height='auto'; inputEl.style.height=Math.min(Math.max(inputEl.scrollHeight, 64), 180)+'px'; }

// ---------- Slash Commands autocomplete (Papi 16 Agu 2026) ----------
let slashCache = [];
let slashBox = null;
async function loadSlashCache() {
  try {
    const r = await fetch('/api/slash');
    if (!r.ok) return;
    const d = await r.json();
    slashCache = d.items || [];
  } catch (e) {}
}
function closeSlashBox() { if (slashBox) { slashBox.remove(); slashBox = null; } }
function showSlashBox() {
  closeSlashBox();
  if (!slashCache.length) return;
  slashBox = document.createElement('div');
  slashBox.className = 'slash-box';
  slashBox.style.cssText = 'position:absolute;bottom:100%;left:8px;right:8px;background:var(--panel);border:1px solid var(--border);border-radius:12px;box-shadow:0 -6px 24px rgba(0,0,0,.4);z-index:99;max-height:260px;overflow-y:auto;padding:6px;';
  const title = document.createElement('div');
  title.style.cssText = 'padding:6px 10px;font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.5px;';
  title.textContent = '⚡ Perintah Cepat — ketik argumen setelah nama';
  slashBox.appendChild(title);
  slashCache.forEach((c) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 10px;border:none;background:none;color:var(--text);border-radius:8px;cursor:pointer;font-size:13px;';
    row.innerHTML = '<b style="color:var(--accent);">/' + c.name + '</b> <span style="color:var(--muted);font-size:12px;">— ' + c.description + '</span>';
    row.onmouseenter = () => { row.style.background = 'var(--panel-2)'; };
    row.onmouseleave = () => { row.style.background = 'none'; };
    row.onclick = () => {
      inputEl.value = '/' + c.name + ' ';
      inputEl.focus();
      autoGrow();
      closeSlashBox();
      toast('⚡ /' + c.name + ' — lanjutkan dengan argumen (misal: ' + (c.name === 'sahamindo' ? 'BBCA' : c.name === 'sahamusa' ? 'NVIDIA' : '...') + ')');
    };
    slashBox.appendChild(row);
  });
  inputEl.parentElement.style.position = 'relative';
  inputEl.parentElement.appendChild(slashBox);
}
inputEl.addEventListener('input', () => {
  // F29 (9 Sep 2026): ISOLASI COMPOSER — mengetik HANYA mengubah tinggi kotak + menu slash.
  // JANGAN panggil refresh data / render ulang chat di sini (pernah jadi sumber lag saat mengetik).
  autoGrow();
  const v = inputEl.value;
  // tampilkan box hanya kalau kata pertama mulai dengan "/" dan belum ada spasi (masih mengetik nama)
  const first = v.split(' ')[0];
  if (first.startsWith('/') && first.length > 1 && !v.includes(' ')) showSlashBox();
  else closeSlashBox();
});
document.addEventListener('click', (e) => { if (slashBox && !slashBox.contains(e.target) && e.target !== inputEl) closeSlashBox(); });
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSlashBox();
  if (e.key === 'Tab' && slashBox) { e.preventDefault(); const first = slashCache[0]; if (first) { inputEl.value = '/' + first.name + ' '; autoGrow(); closeSlashBox(); } }
});

// ---------- Upload (satu tombol: foto, dokumen, kode) — Aaron 13 Agu 2026 ----------
$('upload-btn').addEventListener('click', () => $('upload-file').click());
// F49 (9 Sep 2026): proses file dari SEMUA sumber (tombol, paste, drag-drop) — batas 10MB/file.
async function processIncomingFiles(files) {
  const arr = Array.from(files || []);
  // F25 (9 Sep 2026): tampilkan status proses per file (upload berurutan + indikator).
  for (let fi = 0; fi < arr.length; fi++) {
    const file = arr[fi];
    if (file.size > 10 * 1024 * 1024) { toast('⚠️ ' + file.name + ' > 10MB, dilewati'); continue; }
    const isImage = file.type.startsWith('image/');
    if (arr.length > 1) toast('📤 Lampirkan ' + (fi + 1) + '/' + arr.length + ': ' + file.name + '…');
    if (isImage) {
      // Gambar: tampilkan preview & kirim sebagai image ke agent
      const sel = $('model-select');
      const cur = (sel && sel.value) ? sel.value : '';
      if (cur.toLowerCase().includes('deepseek') && !confirm('⚠️ Model DeepSeek aktif TIDAK bisa membaca gambar.\n\nGanti ke model vision dulu (OpenAI GPT-4o / Claude / Gemini) di pemilih model atas, atau lanjut tetap lampirkan (tapi Agent tidak akan bisa melihatnya).\n\nLanjut lampirkan?')) continue;
      try {
        const dataUrl = await fileToDataUrl(file);
        const compressed = await compressImage(dataUrl);
        pendingImages.push(compressed);
      } catch(err) { toast('Gagal baca gambar'); }
    } else {
      // Dokumen/kode: upload ke workspace & lampirkan info file
      try {
        const b64 = await fileToBase64(file);
        const r = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: file.name, data: b64 }) });
        const d = await r.json();
        if (r.ok) { pendingFiles.push({ path: d.path, name: d.name, desc: d.desc, mime: d.mime, size: d.size }); toast('📎 ' + d.name + ' diupload'); }
        else toast(d.error || 'Gagal upload');
      } catch(err) { toast('Gagal upload ' + file.name); }
    }
  }
  renderImagePreview();
}
$('upload-file').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  await processIncomingFiles(files);
});
// F49: paste gambar langsung dari clipboard ke textarea/area chat.
document.addEventListener('paste', (e) => {
  try {
    const items = (e.clipboardData || {}).items || [];
    const imgs = [];
    for (const it of items) {
      if (it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) { e.preventDefault(); processIncomingFiles(imgs); }
  } catch (err) {}
});
// F49: drag & drop file ke area chat (bukan navigasi default browser).
['dragover', 'drop'].forEach((evName) => {
  document.addEventListener(evName, (e) => {
    try {
      if (evName === 'dragover') {
        const hasFiles = Array.from((e.dataTransfer || {}).types || []).includes('Files');
        if (hasFiles) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
        return;
      }
      const dt = e.dataTransfer || {};
      const files = Array.from(dt.files || []);
      if (files.length) { e.preventDefault(); processIncomingFiles(files); }
    } catch (err) {}
  });
});
function renderImagePreview() {
  const box = $('image-preview');
  box.innerHTML = '';
  pendingImages.forEach((img, idx) => {
    const im = document.createElement('img');
    im.src = img;
    im.title = 'Klik untuk hapus';
    im.addEventListener('click', () => { pendingImages.splice(idx,1); renderImagePreview(); });
    box.appendChild(im);
  });
  pendingFiles.forEach((f, idx) => {
    const chip = document.createElement('div'); chip.className = 'file-chip';
    chip.innerHTML = `<span class="fc-ico">📄</span><span class="fc-name">${escapeHtml(f.name)}</span><span class="fc-desc">${escapeHtml(f.desc||'')}</span><span class="fc-x" title="Hapus">×</span>`;
    chip.querySelector('.fc-x').addEventListener('click', () => { pendingFiles.splice(idx,1); renderImagePreview(); });
    box.appendChild(chip);
  });
}
$('upload-btn').addEventListener('click', () => $('upload-file').click());
$('upload-file').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) { toast('⚠️ ' + file.name + ' > 10MB, dilewati'); continue; }
    try {
      const b64 = await fileToBase64(file);
      const r = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: file.name, data: b64 }) });
      const d = await r.json();
      if (r.ok) { pendingFiles.push({ path: d.path, name: d.name, desc: d.desc, mime: d.mime, size: d.size }); toast('📎 ' + d.name + ' diupload'); }
      else toast(d.error || 'Gagal upload');
    } catch(err) { toast('Gagal upload ' + file.name); }
  }
  renderImagePreview();
});
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = r.result; resolve(s.includes(',') ? s.split(',')[1] : s); };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(file); });
}
function compressImage(dataUrl, maxSize = 1024, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      const scale = Math.min(1, maxSize / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => reject(new Error('Gagal membaca gambar'));
    img.src = dataUrl;
  });
}

// ---------- Vendor LAZY (Paket C — Dinda 5 Sep 2026) ----------
// mammoth/xlsx/pptx (±3 MB) TIDAK lagi dimuat di halaman pertama. Library
// diunduh sekali, hanya saat user benar-benar membuka file docx/xlsx/pptx.
const _vendorCache = {};
function ensureVendor(lib) {
  const map = { mammoth: 'mammoth.min.js', XLSX: 'xlsx.full.min.js', PptxPreview: 'pptx-preview.umd.js' };
  const winKey = { mammoth: 'mammoth', XLSX: 'XLSX', PptxPreview: 'pptxPreview' }[lib];
  if (!_vendorCache[lib]) {
    _vendorCache[lib] = new Promise((resolve, reject) => {
      if (window[winKey]) return resolve();
      const s = document.createElement('script');
      s.src = '/vendor/' + map[lib];
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete _vendorCache[lib]; reject(new Error('Gagal memuat ' + map[lib])); };
      document.head.appendChild(s);
    });
  }
  return _vendorCache[lib];
}

// ---------- Artifacts ----------
async function refreshArtifacts() {
  if (!authed) return;
  try {
    const r = await fetch('/api/artifacts'); if (!r.ok) return;
    const d = await r.json();
    filesCache = d.files || [];
    $('art-count').textContent = filesCache.length + ' file';
    const searchEl = $('art-search');
    if (searchEl) searchEl.style.display = filesCache.length ? '' : 'none';
    if (filesCache.length === 0) {
      listEl.innerHTML = '<div class="art-empty">Belum ada artefak.<br>Minta Agent membuat file,<br>misal: <b>"buatkan landing page HTML"</b></div>';
      return;
    }
    renderArtifactTree();
  } catch(e) { toast('Gagal memuat artefak'); }
}
// Build tree & render LAZY (folder ditutup default; isi dibangun saat dibuka) — FIX performa Dinda 28 Agu 2026
function renderArtifactTree() {
  listEl.innerHTML = '';
  const q = (($('art-search') || {}).value || '').toLowerCase();
  const filtered = q ? filesCache.filter(f => f.path.toLowerCase().includes(q)) : filesCache;
  if (!filtered.length) { listEl.innerHTML = '<div class="art-empty">Tidak ada file cocok dengan "' + escapeHtml(q) + '".</div>'; return; }
  const tree = {};
  filtered.forEach(f => {
    const parts = f.path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      if (!node[dir]) node[dir] = {};
      node = node[dir];
    }
    const leaf = parts[parts.length - 1];
    if (!node.__files) node.__files = [];
    node.__files.push(f);
  });
  const ICONS = { js:'📜', ts:'📘', py:'🐍', html:'🌐', css:'🎨', json:'🧾', md:'📝', sh:'⚡', sql:'🗄️', png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', webp:'🖼️', pdf:'📄', svg:'🖼️', xlsx:'📊', csv:'📊', docx:'📘', pptx:'📽️' };
  function renderFiles(files, container) {
    files.forEach(f => {
      const item = document.createElement('div'); item.className='art-item';
      const ext = f.path.split('.').pop().toLowerCase();
      const metaLine = (f.session || f.user) ? `<div style="font-size:9.5px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Sesi: ${escapeHtml(f.session || '—')} · User: ${escapeHtml(f.user || '—')}">${escapeHtml(f.session || '')}${f.session && f.user ? ' · ' : ''}${escapeHtml(f.user || '')}</div>` : '';
      item.innerHTML = `<span>${ICONS[ext] || '📄'}</span><div style="flex:1;min-width:0;"><div class="fname">${escapeHtml(f.path.split('/').pop())}</div>${metaLine}</div><span class="fsize">${fmtSize(f.size)}</span><button class="art-dl" title="Download file">⬇️</button>`;
      item.addEventListener('click', (ev) => { if (ev.target.classList.contains('art-dl')) return; openArtifact(f.path); });
      item.querySelector('.art-dl').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        toast('⬇️ Download ' + f.path.split('/').pop() + '…');
        window.location.href = '/api/artifact/download?path=' + encodeURIComponent(f.path);
      });
      container.appendChild(item);
    });
  }
  function renderTreeLazy(node, container, prefix) {
    const dirs = Object.keys(node).filter(k => k !== '__files').sort();
    dirs.forEach(dir => {
      const group = document.createElement('div'); group.className = 'art-folder';
      const head = document.createElement('div'); head.className = 'art-folder-head';
      head.innerHTML = `<span>📁</span><span class="fname">${escapeHtml(dir)}</span><span class="art-fcount">${countFiles(node[dir])}</span>`;
      const body = document.createElement('div'); body.className = 'art-folder-body';
      let built = false;
      head.addEventListener('click', () => {
        const willOpen = !group.classList.contains('open');
        group.classList.toggle('open');
        if (willOpen && !built) { renderTreeLazy(node[dir], body, prefix + dir + '/'); built = true; }
      });
      group.appendChild(head); group.appendChild(body);
      container.appendChild(group);
    });
    renderFiles(node.__files || [], container);
  }
  function countFiles(node) {
    let n = (node.__files || []).length;
    Object.keys(node).forEach(k => { if (k !== '__files') n += countFiles(node[k]); });
    return n;
  }
  renderTreeLazy(tree, listEl, '');
}
if ($('art-search')) $('art-search').addEventListener('input', () => { renderArtifactTree(); });
async function openArtifact(relPath) {
  const r = await fetch('/api/artifact?path=' + encodeURIComponent(relPath));
  if (!r.ok) { toast('Gagal buka file'); return; }
  const d = await r.json();
  currentArtifact = d;
  $('av-title').textContent = d.path;
  const ext = d.path.split('.').pop().toLowerCase();
  const body = $('av-body'); body.innerHTML='';
  const rawUrl = '/api/artifact?path=' + encodeURIComponent(d.path) + '&raw=1';
  const isImage = ['png','jpg','jpeg','gif','webp','svg'].includes(ext);
  const isHtml = ext==='html';
  const isPdf = ext==='pdf';
  const isDocx = ext==='docx';
  const isXlsx = ['xlsx','xls','csv'].includes(ext);
  const isPptx = ext==='pptx';
  const isMd = ext==='md';
  const isTxt = ['txt','log','text','note'].includes(ext);
  $('av-preview').style.display = (isHtml||isImage) ? 'inline-block' : 'none';
  // FIX (Papi 16 Agu 2026): preview multi-format — PDF native, Word via mammoth, Excel via SheetJS, MD via marked
  if (isHtml) { const iframe = document.createElement('iframe'); iframe.srcdoc = d.content; body.appendChild(iframe); }
  else if (isImage) { const img = document.createElement('img'); img.src = rawUrl; body.appendChild(img); }
  else if (isPdf) {
    const iframe = document.createElement('iframe'); iframe.src = rawUrl; iframe.style.background = '#fff'; body.appendChild(iframe);
  }
  else if (isDocx) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Memuat dokumen Word…</div>';
    try {
      await ensureVendor('mammoth');
      const bin = await (await fetch(rawUrl)).arrayBuffer();
      if (window.mammoth) {
        const res = await mammoth.convertToHtml({ arrayBuffer: bin });
        body.innerHTML = '<div class="docx-preview">' + res.value + '</div>';
      } else { body.innerHTML = '<div style="padding:20px;color:var(--muted)">Preview Word butuh library — silakan unduh file.</div>'; }
    } catch (e) { body.innerHTML = '<div style="padding:20px;color:var(--danger)">Gagal membaca Word: ' + e.message + '</div>'; }
  }
  else if (isXlsx) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Memuat spreadsheet…</div>';
    try {
      await ensureVendor('XLSX');
      const bin = await (await fetch(rawUrl)).arrayBuffer();
      if (window.XLSX) {
        const wb = XLSX.read(bin, { type: 'array' });
        const first = wb.SheetNames[0];
        const html = XLSX.utils.sheet_to_html(wb.Sheets[first]);
        body.innerHTML = '<div class="xlsx-preview">' + html + '</div>';
      } else { body.innerHTML = '<div style="padding:20px;color:var(--muted)">Preview Excel butuh library — silakan unduh file.</div>'; }
    } catch (e) { body.innerHTML = '<div style="padding:20px;color:var(--danger)">Gagal membaca Excel: ' + e.message + '</div>'; }
  }
  else if (isPptx) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Memuat PowerPoint…</div>';
    try {
      await ensureVendor('PptxPreview');
      const bin = await (await fetch(rawUrl)).arrayBuffer();
      if (window.pptxPreview && pptxPreview.init) {
        body.innerHTML = '';
        const wrap = document.createElement('div'); wrap.id = 'pptx-wrapper'; body.appendChild(wrap);
        const viewer = pptxPreview.init(wrap, { width: 900, height: 540 });
        viewer.preview(bin);
      } else { body.innerHTML = '<div style="padding:20px;color:var(--muted)">Preview PowerPoint butuh library — silakan unduh file.</div>'; }
    } catch (e) { body.innerHTML = '<div style="padding:20px;color:var(--danger)">Gagal membaca PowerPoint: ' + e.message + '</div>'; }
  }
  else if (isMd) {
    const div = document.createElement('div'); div.className = 'md-preview';
    div.innerHTML = renderMd(d.content);
    div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    body.appendChild(div);
  }
  else if (isTxt) {
    // FIX (Papi 16 Agu 2026): .txt/.log/.note → tampil ala Notepad/Google Notes (putih, rapi, wrap)
    const div = document.createElement('div'); div.className = 'txt-preview';
    const pre = document.createElement('pre');
    pre.textContent = d.content;
    div.appendChild(pre);
    body.appendChild(div);
  }
  else {
    const pre = document.createElement('pre'); const code = document.createElement('code');
    code.textContent = d.content; code.className = 'language-' + (langMap['.'+ext] || 'plaintext');
    pre.appendChild(code);
    if (langMap['.'+ext] && hljs.getLanguage(langMap['.'+ext])) { try { hljs.highlightElement(code); } catch(e){} }
    body.appendChild(pre);
  }
  $('artifact-viewer').classList.add('open');
  // FIX (Papi 16 Agu 2026): tombol Edit/Gabung hanya untuk file GAMBAR
  $('av-edit').style.display = isImage ? 'inline-block' : 'none';
  $('av-preview').style.display = (isHtml || isImage) ? 'inline-block' : 'none';
  // Canvas: tombol "Edit Kode" untuk file teks yang bisa diedit (HTML/CSS/JS/MD/TXT/JSON/dll)
  const CODE_EXTS = ['html','htm','css','js','mjs','json','md','txt','log','csv','xml','yaml','yml','py','ts','jsx','tsx','sql','sh','php','go','rs','java','c','cpp','svg','ini','conf'];
  $('av-edit-code').style.display = CODE_EXTS.includes(ext) && !isImage ? 'inline-block' : 'none';
}
$('av-close').addEventListener('click', () => $('artifact-viewer').classList.remove('open'));
$('av-copy').addEventListener('click', () => { if (currentArtifact) safeCopy(currentArtifact.content, 'Disalin ✅'); });
$('av-download').addEventListener('click', () => { if (currentArtifact) window.location.href = '/api/artifact/download?path='+encodeURIComponent(currentArtifact.path); });
$('av-preview').addEventListener('click', () => {
  const body = $('av-body'); body.innerHTML='';
  const ext = currentArtifact.path.split('.').pop().toLowerCase();
  if (ext==='html') { const iframe=document.createElement('iframe'); iframe.srcdoc=currentArtifact.content; body.appendChild(iframe); }
  else { const img=document.createElement('img'); img.src='/api/artifact?path='+encodeURIComponent(currentArtifact.path)+'&raw=1'; body.appendChild(img); }
});

// ---------- Edit/Gabung Gambar (Papi 16 Agu 2026 — Nano Banana via fal.ai) ----------
function appendAssistantText(mdText) {
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = '<div class="avatar">🤖</div><div class="bubble"></div>';
  const bubble = el.querySelector('.bubble');
  bubble.innerHTML = renderMd(mdText || '');
  bubble.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  const messagesEl = $('messages');
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  const actions = document.createElement('div'); actions.className = 'msg-actions';
  bubble.appendChild(actions);
  addShareBtn(actions, mdText);
  const time = document.createElement('span'); time.className = 'msg-time';
  time.textContent = fmtMsgTime(Date.now());
  actions.appendChild(time);
}
let imgEditSelected = [];
async function openImgEdit() {
  $('imgedit-err').textContent=''; $('imgedit-ok').textContent=''; $('imgedit-prompt').value='';
  imgEditSelected = [];
  // isi picker dari artifacts (filter gambar)
  const box = $('imgedit-picker'); box.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px;">Memuat gambar…</div>';
  try {
    const r = await fetch('/api/artifacts'); const d = await r.json();
    const files = (d.files || []).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f.path));
    if (!files.length) { box.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:13px;">Belum ada gambar. Buat dulu lewat 🎨 di kolom chat, atau upload file.</div>'; }
    else {
      box.innerHTML = '';
      // kalau currentArtifact gambar → preselect
      files.forEach(f => {
        const thumb = document.createElement('div');
        const sel = (currentArtifact && currentArtifact.path === f.path);
        if (sel) imgEditSelected.push(f.path);
        thumb.style.cssText = 'width:72px;height:72px;border-radius:10px;overflow:hidden;border:2px solid ' + (sel ? 'var(--accent)' : 'var(--border)') + ';cursor:pointer;position:relative;flex-shrink:0;';
        thumb.innerHTML = '<img src="/api/artifact?path=' + encodeURIComponent(f.path) + '&raw=1" style="width:100%;height:100%;object-fit:cover;">' +
          (sel ? '<span style="position:absolute;top:2px;right:2px;background:var(--accent);color:#fff;border-radius:50%;width:16px;height:16px;font-size:10px;display:flex;align-items:center;justify-content:center;">✓</span>' : '');
        thumb.onclick = () => {
          const i = imgEditSelected.indexOf(f.path);
          if (i >= 0) { imgEditSelected.splice(i,1); thumb.style.borderColor='var(--border)'; const c=thumb.querySelector('span'); if(c) c.remove(); }
          else { imgEditSelected.push(f.path); thumb.style.borderColor='var(--accent)'; if(!thumb.querySelector('span')){ const s=document.createElement('span'); s.style.cssText='position:absolute;top:2px;right:2px;background:var(--accent);color:#fff;border-radius:50%;width:16px;height:16px;font-size:10px;display:flex;align-items:center;justify-content:center;'; s.textContent='✓'; thumb.appendChild(s);} }
        };
        box.appendChild(thumb);
      });
    }
  } catch (e) { box.innerHTML = '<div style="padding:12px;color:var(--danger);font-size:13px;">Gagal memuat gambar: ' + e.message + '</div>'; }
  $('img-edit-modal').style.display = 'flex';
}
$('av-edit').addEventListener('click', openImgEdit);
$('imgedit-close').addEventListener('click', () => $('img-edit-modal').style.display = 'none');
$('imgedit-go').addEventListener('click', async () => {
  const err = $('imgedit-err'), ok = $('imgedit-ok'); err.textContent=''; ok.textContent='';
  const prompt = $('imgedit-prompt').value.trim();
  if (!imgEditSelected.length) { err.textContent = 'Pilih minimal 1 gambar dulu (1 = edit, 2+ = gabung).'; return; }
  if (!prompt) { err.textContent = 'Ketik perintahnya dulu (misal: ubah latar, gabungkan keduanya...).'; return; }
  const btn = $('imgedit-go'); btn.disabled = true; btn.textContent = '🪄 Membuat… (bisa 30-60 detik)';
  try {
    // download base64 dari setiap gambar terpilih
    const images = [];
    for (const p of imgEditSelected) {
      const rr = await fetch('/api/artifact?path=' + encodeURIComponent(p) + '&raw=1');
      const blob = await rr.blob();
      images.push(await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); }));
    }
    const r = await fetch('/api/image/edit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, images }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal'; return; }
    ok.textContent = '✅ Berhasil! Gambar baru tersimpan: ' + (d.path||'').split('/').pop() + (d.price ? ' · ' + d.price + ' credit' : '');
    $('img-edit-modal').style.display = 'none';
    refreshArtifacts();
    // tampilkan hasil di chat sebagai pesan assistant + buka preview
    setTimeout(() => {
      const last = d.path;
      appendAssistantText('🪄 Gambar selesai dibuat: **' + (d.path||'').split('/').pop() + '**\n\n![hasil](' + d.url + ')');
      openArtifact(last);
    }, 800);
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = '🪄 Buat'; }
});

// ---------- Canvas Interaktif (Papi 16 Agu 2026 — #10, kualitas nomor 1) ----------
let canvasPath = null;
function renderCanvas() {
  const code = $('canvas-code').value;
  const ext = (canvasPath || '').split('.').pop().toLowerCase();
  const iframe = $('canvas-preview');
  if (ext === 'html' || ext === 'htm') {
    iframe.srcdoc = code;
  } else if (ext === 'md') {
    iframe.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;max-width:800px;margin:24px auto;padding:0 16px;color:#222;line-height:1.7}pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto}code{font-family:monospace}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}</style><body>' + renderMd(code);
  } else if (ext === 'txt' || ext === 'log' || ext === 'csv') {
    iframe.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font-family:monospace;white-space:pre-wrap;padding:16px;color:#222}</style><body>' + code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  } else if (ext === 'css') {
    iframe.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;padding:16px;color:#222}</style><body><h1>Demo CSS</h1><p>File <b>' + canvasPath + '</b> tidak bisa di-render sendiri (CSS butuh HTML). Buka file HTML yang memakainya untuk melihat hasil.</p><pre style="background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto;max-height:70vh;">' + code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</pre>';
  } else {
    // kode lain: tampilkan highlighted (aman) tanpa eksekusi
    iframe.srcdoc = '<!doctype html><meta charset="utf-8"><style>body{font-family:monospace;padding:16px;color:#222;white-space:pre-wrap;background:#fff}</style><body>' + code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
}
function openCanvas(relPath) {
  $('canvas-ok').textContent=''; $('canvas-err').textContent='';
  canvasPath = relPath;
  $('canvas-title').textContent = relPath.split('/').pop();
  // muat konten terbaru dari server (pastikan fresh, bukan dari cache artifact lama)
  fetch('/api/artifact?path=' + encodeURIComponent(relPath)).then(r => r.json()).then(d => {
    $('canvas-code').value = d.content || '';
    renderCanvas();
    $('canvas-modal').style.display = 'flex';
  }).catch(() => { $('canvas-err').textContent = 'Gagal memuat file.'; $('canvas-modal').style.display = 'flex'; });
}
$('av-edit-code').addEventListener('click', () => { if (currentArtifact) openCanvas(currentArtifact.path); });
$('canvas-render').addEventListener('click', renderCanvas);
$('canvas-download').addEventListener('click', () => { if (canvasPath) window.location.href = '/api/artifact/download?path=' + encodeURIComponent(canvasPath); });
$('canvas-close').addEventListener('click', () => $('canvas-modal').style.display = 'none');
$('canvas-save').addEventListener('click', async () => {
  const ok = $('canvas-ok'), err = $('canvas-err'); ok.textContent=''; err.textContent='';
  if (!canvasPath) return;
  const btn = $('canvas-save'); btn.disabled = true; btn.textContent = 'Menyimpan…';
  try {
    const r = await fetch('/api/artifact', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: canvasPath, content: $('canvas-code').value }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal simpan'; return; }
    ok.textContent = '✅ Tersimpan! Perubahan sudah ditulis ke file (backup otomatis dibuat).';
    refreshArtifacts();
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = '💾 Simpan'; }
});
$('canvas-code').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); renderCanvas(); }
});

// ---------- Live Activity (SSE) ----------
let sseSource = null;
// F47 (9 Sep 2026): saat agent bekerja & tab TIDAK aktif → judul tab jadi indikator
// "⏳ Dinda bekerja…" supaya user tahu dari tab lain. Pulih otomatis saat balik.
let __origTitle = document.title;
let __titleBusy = false;
function setTitleBusy(on) {
  try {
    if (on === __titleBusy) return;
    __titleBusy = on;
    if (on) { __origTitle = __origTitle || document.title; if (document.hidden) document.title = '⏳ Dinda bekerja…'; }
    else if (!document.hidden) { document.title = __origTitle || 'COBLAI'; }
  } catch (e) {}
}
document.addEventListener('visibilitychange', () => {
  try {
    if (!document.hidden) { document.title = __origTitle || 'COBLAI'; }
    else if (__titleBusy) { document.title = '⏳ Dinda bekerja…'; }
  } catch (e) {}
});
function setActivity(on, text) {
  const bar = $('activity-bar');
  if (on) { $('activity-text').textContent = text || '…'; bar.style.display = ''; }
  else { bar.style.display = 'none'; }
  // FIX (Papi 15 Agu 2026): JANGAN tampilkan bubble robot 🤖 terpisah di dalam chat.
  // Proses kerja cukup terlihat via activity-bar (bawah) + bubble typing avatar WANITA (addTyping).
  // Sebelumnya ensureChatActivity membuat bubble kedua ber-avatar robot → muncul 2 bubble agent.
  try {
    const ca = $('chat-activity');
    if (ca) ca.style.display = 'none';
  } catch (e) {}
}
function connectEvents() {
  if (sseSource) { try { sseSource.close(); } catch(e) {} }
  if (!authed || !currentSessionId) return;
  // F8 Status koneksi jujur (9 Sep 2026, PRD F8): muncul saat putus, hilang saat pulih.
  // TIDAK ada animasi "terhubung" palsu — hanya menampilkan keadaan sebenarnya.
  function connStatus(text) {
    try {
      let el = document.getElementById('conn-status');
      if (!text) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.id = 'conn-status'; el.className = 'conn-status'; const ab = $('activity-bar'); if (ab && ab.parentNode) ab.parentNode.insertBefore(el, ab); else document.body.appendChild(el); }
      el.textContent = text;
    } catch (e) {}
  }
  try {
    sseSource = new EventSource('/api/events');
    sseSource.onopen = () => connStatus(null); // pulih → hilang (jujur, tanpa toast palsu)
    sseSource.onmessage = (e) => {
      let evt; try { evt = JSON.parse(e.data); } catch(err) { return; }
      // F27 Validasi skema event SSE (9 Sep 2026): hanya proses tipe yang DIKENAL dengan
      // bentuk data yang diharapkan — event tak dikenal / shape salah di-skip, tidak crash UI.
      const SSE_TYPES = new Set(['tool_start','tool_update','tool_end','delta','agent_end','system_note','changes','aborted','message_update','subagent_update','rlm_child_update','response','agent_start','turn_start','turn_end','msg_start','msg_end','compact_start','compact_end','retry_start','retry_end','recap','goal','bash_start','bash_end','refine']);
      if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string' || !SSE_TYPES.has(evt.type)) return;
      // F39 Live monitor (9 Sep 2026): catat ringkas event ke ring buffer (maks 120) utk panel Monitor.
      try {
        __eventLog.push({ t: Date.now(), type: evt.type, tool: evt.tool || '', n: evt.changes ? evt.changes.length : (evt.text ? String(evt.text).length : 0) });
        if (__eventLog.length > 120) __eventLog = __eventLog.slice(-120);
        const im = document.getElementById('inspector-modal');
        if (im && im.style.display !== 'none' && __inspTab === 'monitor') {
          // throttle 800 ms — jangan render ulang tiap delta (bisa ratusan/detik)
          const now = Date.now();
          if (!__monT || now - __monT > 800) { __monT = now; inspLoad(); }
        }
      } catch (e) {}
      notePollActivity(); // ada aktivitas agent -> polling tetap mode cepat
      if (evt.type === 'tool_start') { setActivity(true, '⚙️ ' + toolFaseLabel(evt.tool, 'tool') + ' ' + evt.tool + '…'); procTool(evt.tool, 'start'); projAct('menjalankan ' + evt.tool); }
      else if (evt.type === 'tool_update') { procTool(evt.tool, 'update', { text: evt.text }); } // F12 output live
      else if (evt.type === 'tool_end') { setActivity(true, '✅ selesai ' + evt.tool); procTool(evt.tool, 'end', { ok: evt.ok !== false, durationMs: evt.durationMs, output: evt.output, error: evt.error }); if (evt.ok === false) projAtt('❌ ' + evt.tool + ' gagal', 'err'); }
      else if (evt.type === 'delta') { setActivity(true, '✍️ menyusun jawaban…'); procToolPhase('menjawab'); projAct('menulis jawaban'); }
      else if (evt.type === 'agent_end') { setActivity(false); toast('✅ Agent selesai bekerja'); projLife('⚪ idle'); projAct(''); coalescedRefresh(900); setTimeout(() => { loadDiffCards(); }, 900);
        // Cost Transparency (#13, Papi 16 Agu): simpan usage, tempel SETELAH render final biar tidak terhapus
        __lastCost = evt.usage || null;
        // F4 dialog sintesis (9 Sep 2026): mode diskusi → agent_end bawa saran keputusan.
        __lastSuggest = evt.suggest || null;
        if (!__proc) tryAppendPendingCost();
        if (!__proc) tryAppendPendingSuggest();
      }
      else if (evt.type === 'system_note') { toast(evt.text || '⚠️'); }
      else if (evt.type === 'changes') { (evt.changes || []).forEach(ch => { try { if (ch && ch.path && !__turnFiles.includes(ch.path)) __turnFiles.push(ch.path); if (ch && ch.path && !__turnChanges.some((x) => x.path === ch.path)) __turnChanges.push({ path: ch.path, added: !!ch.added, deleted: !!ch.deleted, size: ch.size || 0 }); } catch (e) {} showDiffCard(ch); }); }
      else if (evt.type === 'aborted') { setActivity(false); toast('⏹ Dihentikan'); }
      // ===== F7/F9 (9 Sep 2026): event kaya engine yang tadinya dibuang server =====
      else if (evt.type === 'agent_start') { setActivity(true, '▶️ Agent mulai bekerja…'); procToolPhase('persiapan'); projLife('🟢 hidup', 'ok'); projAct('bersiap…'); }
      else if (evt.type === 'turn_start') { setActivity(true, '🔄 Giliran baru…'); projAct('mengerjakan turn baru'); }
      else if (evt.type === 'compact_start') { tryAppendSystemNote('🧹 Merapikan konteks (compact: ' + escapeHtml(String(evt.reason || 'tokens')) + ')…'); projAct('merapikan konteks'); projAtt('🧹 compact'); }
      else if (evt.type === 'compact_end') { tryAppendSystemNote(evt.aborted ? '⚠️ Compact dibatalkan' : (evt.willRetry ? '🔄 Compact selesai — lanjut otomatis…' : '✅ Konteks dirapikan')); projAct('melanjutkan'); }
      else if (evt.type === 'retry_start') { tryAppendSystemNote('⚠️ Model kendala — coba ulang ' + (evt.attempt || 1) + '/' + (evt.maxAttempts || '?') + '…'); projAct('mencoba ulang (' + (evt.attempt || 1) + '/' + (evt.maxAttempts || '?') + ')'); projAtt('⚠️ model kendala'); }
      else if (evt.type === 'retry_end') { tryAppendSystemNote(evt.success ? '✅ Lanjut setelah retry' : '❌ Retry gagal'); projAct(evt.success ? 'melanjutkan' : 'berhenti (retry gagal)'); if (!evt.success) projAtt('❌ retry gagal', 'err'); }
      else if (evt.type === 'recap' && evt.recap) { tryAppendSystemNote('📋 Ringkasan: ' + escapeHtml(String(evt.recap))); }
    };
    sseSource.onerror = () => {
      // Jujur: koneksi putus, kami coba sambung lagi — jangan sembunyikan.
      try { connStatus('⟳ Koneksi terputus — menghubungkan ulang…'); } catch (e) {}
      try { sseSource.close(); } catch(e){} sseSource = null; setTimeout(connectEvents, 4000);
    };
  } catch(e) {}
}

// ---------- Diff Cards ----------
function unifiedDiff(oldText, newText) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  const out = [];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    const a = oldLines[i] !== undefined ? oldLines[i] : null;
    const b = newLines[i] !== undefined ? newLines[i] : null;
    if (a === null) { if (b !== '') out.push({ t: 'add', s: '+ ' + b }); else out.push({ t: 'add', s: '+' }); }
    else if (b === null) { if (a !== '') out.push({ t: 'del', s: '- ' + a }); else out.push({ t: 'del', s: '-' }); }
    else if (a === b) out.push({ t: 'ctx', s: '  ' + a });
    else { out.push({ t: 'del', s: '- ' + a }); out.push({ t: 'add', s: '+ ' + b }); }
  }
  return out;
}
async function loadDiffCards() {
  try {
    const r = await fetch('/api/artifacts'); if (!r.ok) return;
    // diffs disimpan di backend per sesi; frontend menampilkan dari /api/diff saat file dibuka.
    // Tampilkan kartu ringkasan di bawah chat jika ada perubahan terakhir (via SSE changes event).
  } catch(e) {}
}
// ===== F13 Kartu ringkas perubahan file (9 Sep 2026, PRD F13) =====
// Sintesis jujur: engine tidak mengirim event `refine_complete` di mode RPC, TAPI data
// perubahan file nyata sudah tersedia dari event `changes` (added/deleted/modified).
// Kartu ini merangkum: berapa file, aksi apa, dan bisa diklik untuk lihat diff (before/after).
function renderChangeSummary(bubble) {
  try {
    if (!__turnChanges || !__turnChanges.length) return;
    const n = __turnChanges.length;
    const nAdd = __turnChanges.filter((c) => c.added).length;
    const nDel = __turnChanges.filter((c) => c.deleted).length;
    const nMod = n - nAdd - nDel;
    const parts = [];
    if (nAdd) parts.push('✚ ' + nAdd + ' baru');
    if (nMod) parts.push('✏️ ' + nMod + ' diubah');
    if (nDel) parts.push('🗑 ' + nDel + ' dihapus');
    const card = document.createElement('div');
    card.className = 'refine-card';
    const head = document.createElement('div');
    head.className = 'refine-head';
    head.innerHTML = '✏️ Perubahan file giliran ini · <b>' + n + ' file</b>' + (parts.length ? ' · ' + parts.join(' · ') : '');
    card.appendChild(head);
    const list = document.createElement('div');
    list.className = 'refine-list';
    __turnChanges.slice(0, 12).forEach((c) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'refine-item';
      const ico = c.added ? '✚' : c.deleted ? '🗑' : '✏️';
      row.innerHTML = '<span class="ri-ico">' + ico + '</span><span class="ri-path">' + escapeHtml(String(c.path)) + '</span>';
      row.title = 'Lihat perubahan file ini (before/after)';
      row.addEventListener('click', () => showDiffCard({ path: c.path, added: c.added, deleted: c.deleted }));
      list.appendChild(row);
    });
    if (__turnChanges.length > 12) {
      const more = document.createElement('div');
      more.className = 'refine-more';
      more.textContent = '… +' + (__turnChanges.length - 12) + ' file lain';
      list.appendChild(more);
    }
    card.appendChild(list);
    bubble.appendChild(card);
  } catch (e) {} finally { __turnChanges = []; }
}
async function showDiffCard(ch) {
  const r = await fetch('/api/diff?path=' + encodeURIComponent(ch.path));
  if (!r.ok) return;
  const d = await r.json();
  const card = document.createElement('div'); card.className = 'diff-card';
  const badge = d.added ? '<span class="badge add">BARU</span>' : d.deleted ? '<span class="badge del">DIHAPUS</span>' : '<span class="badge mod">DIUBAH</span>';
  card.innerHTML = `<div class="diff-head"><span class="fname">🔀 ${escapeHtml(d.path)}</span>${badge}<span style="margin-left:auto;font-size:11px;color:var(--muted)">${fmtSize(d.size||0)}</span></div>`;
  const body = document.createElement('div'); body.className = 'diff-body';
  const lines = unifiedDiff(d.oldContent, d.newContent);
  lines.slice(0, 120).forEach(l => {
    const span = document.createElement('span'); span.className = 'ln ' + l.t; span.textContent = l.s; body.appendChild(span);
  });
  if (lines.length > 120) { const more = document.createElement('span'); more.className='ln ctx'; more.textContent = '… ' + (lines.length - 120) + ' baris lainnya'; body.appendChild(more); }
  card.appendChild(body);
  const acts = document.createElement('div'); acts.className = 'diff-actions';
  const openBtn = document.createElement('button'); openBtn.className='btn small'; openBtn.textContent='📂 Buka file';
  openBtn.addEventListener('click', () => openArtifact(d.path));
  const copyBtn = document.createElement('button'); copyBtn.className='btn small'; copyBtn.textContent='⧉ Copy isi baru';
  copyBtn.addEventListener('click', () => { safeCopy(d.newContent || '', 'Disalin ✅'); });
  acts.appendChild(openBtn); acts.appendChild(copyBtn);
  card.appendChild(acts);
  messagesEl.appendChild(card); messagesEl.scrollTop = messagesEl.scrollHeight;
}
let lastShownDiffPaths = [];
async function refreshDiffCards() {
  try {
    const r = await fetch('/api/artifacts'); if (!r.ok) return;
    const d = await r.json();
    const changes = d.changes || [];
    const fresh = changes.filter(c => !lastShownDiffPaths.includes(c.path));
    for (const ch of fresh) { lastShownDiffPaths.push(ch.path); await showDiffCard(ch); }
    if (fresh.length) lastShownDiffPaths = lastShownDiffPaths.slice(-20);
  } catch(e) {}
}

// ---------- Home ----------
$('home-btn').addEventListener('click', () => {
  $('settings').classList.remove('open');
  $('artifact-viewer').classList.remove('open');
  messagesEl.scrollTop = 0;
  toast('🏠 Kembali ke beranda');
});
$('settings-open').addEventListener('click', () => { $('settings').classList.add('open'); switchTab('profile'); });
$('settings-close').addEventListener('click', () => $('settings').classList.remove('open'));
document.querySelectorAll('.set-tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// Sub-menu settings: Kelola Agent & Kelola Bisnis & MyAgent & Apps (Aaron 14 Agu + Papi 19 Agu)
['menu-agent', 'menu-bisnis', 'menu-myagent', 'menu-apps', 'menu-riwayat'].forEach((mid) => {
  const head = $(mid + '-head');
  if (head) head.addEventListener('click', () => $(mid).classList.toggle('open'));
});
document.querySelectorAll('.set-sub').forEach((sub) => {
  sub.addEventListener('click', () => {
    document.querySelectorAll('.set-sub').forEach((x) => x.classList.remove('active'));
    sub.classList.add('active');
    switchTab(sub.dataset.tab);
  });
});
function switchTab(name) {
  document.querySelectorAll('.set-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  ['profile','theme','apikeys','history','users','prime','branding','botconfig','update','system','token','status','health','modeltest','prompts','slash','playground','schedules','notify','plugins','autonomous','skills','artifacts','notion','memory','agents','paket','credit','admin','accounting','factor','banks','payment','kb'].forEach(p => $('panel-'+p).style.display = p === name ? '' : 'none');
  if (name === 'users' && me && me.role === 'admin') loadUserList();
  if (name === 'prime') refreshPrime();
  if (name === 'branding') loadBranding();
  if (name === 'botconfig') loadBotConfig();
  if (name === 'apikeys') loadApiKeys();
  if (name === 'update') checkVersion();
  if (name === 'system') loadSystemControl();
  if (name === 'token') loadThinkingState();
  if (name === 'status') loadStatus();
  if (name === 'health') runHealthCheck();
  if (name === 'modeltest') refreshModels();
  if (name === 'security') loadMfaStatus();
  if (name === 'history') loadHistoryStats();
  if (name === 'prompts') loadPrompts();
  if (name === 'slash') loadSlashList();
  if (name === 'playground') updatePlayground();
  if (name === 'schedules') loadSchedules();
  if (name === 'notify') loadNotify();
  if (name === 'plugins') loadPluginsList();
  if (name === 'autonomous') loadAutonomousStatus();
  if (name === 'skills') loadSkills();
  if (name === 'artifacts') loadArtMgmt();
  if (name === 'notion') loadNotionStatus();
  if (name === 'memory') loadMemoryList();
  if (name === 'agents') loadAgentsList();
  if (name === 'learnings') loadLearningsList(); // Cadangan-3 (9 Sep 2026)
  if (name === 'guardrails') loadGuardrails(); // Cadangan-2 (9 Sep 2026)
  if (name === 'paket') { loadPaket(); loadPayHistory(); }
  if (name === 'credit') loadCreditPage();
  if (name === 'admin' && me && me.role === 'admin') { loadAdminOverview(); loadAdminPayments(); loadPaymentReport(); loadAdminCoupons(); loadAdminOrders(); }
  if (name === 'accounting' && me && me.role === 'admin') loadTokenAccounting();
  if (name === 'factor' && me && me.role === 'admin') loadSellFactor();
  if (name === 'branding' && me && me.role === 'admin') loadBranding();
  if (name === 'banks' && me && me.role === 'admin') loadBanksAdmin();
  if (name === 'payment' && me && me.role === 'admin') loadPaymentAdmin();
  if (name === 'kb') loadKb();
}

// ---------- Mode Otonom (desain Farrah, integrasi aman Aaron) ----------
async function loadAutonomousStatus() {
  try {
    const r = await fetch('/api/autonomous');
    const d = await r.json();
    const box = $('auto-status');
    const job = d.job;
    if (job && job.status === 'running') {
      box.style.display = '';
      $('auto-status-text').textContent = '🚀 Berjalan: ' + job.goal + ' (turn ' + job.turns + '/' + job.maxTurns + ', token ' + (job.tokenUsed||0).toLocaleString('id-ID') + ')';
      $('auto-start').style.display = 'none';
      $('auto-resume').style.display = 'none';
      $('auto-stop').style.display = '';
      $('auto-goal').disabled = true;
    } else {
      box.style.display = 'none';
      $('auto-start').style.display = '';
      $('auto-stop').style.display = 'none';
      $('auto-goal').disabled = false;
      $('auto-resume').style.display = 'none';
      if (job) {
        const reasons = { max_tokens: '⏸ Berhenti karena BATAS TOKEN tercapai', max_turns: '⏸ Berhenti karena batas turn', timeout: '⏸ Berhenti karena waktu habis', completed: '✅ Selesai', error: '❌ Error' };
        $('auto-status-text').textContent = (reasons[job.status] || '⏸ Berhenti') + ' — turn ' + job.turns + '/' + job.maxTurns + ', token ' + (job.tokenUsed||0).toLocaleString('id-ID');
        box.style.display = '';
        if (job.status !== 'completed') $('auto-resume').style.display = '';
      }
    }
  } catch (e) {}
}
$('auto-start').addEventListener('click', async () => {
  const goal = $('auto-goal').value.trim();
  if (!goal) { $('auto-err').textContent = 'Isi goal/tugas dulu.'; return; }
  $('auto-err').textContent = ''; $('auto-ok').textContent = '';
  try {
    const r = await fetch('/api/autonomous', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ goal, maxTurns: parseInt($('auto-turns').value, 10), maxTokens: parseInt($('auto-tokens').value, 10) }) });
    const d = await r.json();
    if (r.ok) { $('auto-ok').textContent = '🚀 Mode otonom dimulai! Pantau di tab ini.'; loadAutonomousStatus(); }
    else $('auto-err').textContent = d.error || 'Gagal mulai';
  } catch (e) { $('auto-err').textContent = 'Gagal: ' + e.message; }
});
$('auto-stop').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/autonomous/stop', { method:'POST' });
    const d = await r.json();
    if (r.ok) { $('auto-ok').textContent = '⏹ Dihentikan.'; loadAutonomousStatus(); }
    else $('auto-err').textContent = d.error || 'Gagal stop';
  } catch (e) { $('auto-err').textContent = 'Gagal: ' + e.message; }
});
$('auto-resume').addEventListener('click', async () => {
  $('auto-err').textContent = ''; $('auto-ok').textContent = '';
  try {
    const r = await fetch('/api/autonomous/resume', { method:'POST' });
    const d = await r.json();
    if (r.ok) { $('auto-ok').textContent = '▶️ Dilanjutkan! Agent lanjut kerja dari titik terakhir.'; loadAutonomousStatus(); }
    else $('auto-err').textContent = d.error || 'Gagal lanjut';
  } catch (e) { $('auto-err').textContent = 'Gagal: ' + e.message; }
});

// ---------- Skills (desain Farrah, integrasi aman Aaron) ----------
async function loadSkills() {
  try {
    const r = await fetch('/api/skills');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Gagal memuat skill');
    const tplBox = $('skills-templates'); tplBox.innerHTML = '';
    (d.templates || []).forEach(t => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';
      item.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
        <div style="flex:1;"><div style="font-weight:700;font-size:14px;">${escapeHtml(t.name)} <span style="font-size:11px;color:var(--muted);">v${escapeHtml(t.version || '1.0.0')}</span></div>
        <div style="color:var(--muted,#9aa4b2);font-size:12px;">${escapeHtml(t.description)} · ${escapeHtml(t.source || 'unknown')}</div></div>
        <button class="btn small sk-install">⬇️ Install</button>
      </div>`;
      item.querySelector('.sk-install').addEventListener('click', async () => {
        const btn = item.querySelector('.sk-install'); btn.disabled = true;
        const r2 = await fetch('/api/skills', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: t.name }) });
        const d2 = await r2.json().catch(() => ({}));
        if (r2.ok) { $('skill-ok').textContent = '✅ Skill ' + t.name + ' terpasang.'; await loadSkills(); }
        else { btn.disabled = false; $('skill-err').textContent = d2.error || 'Gagal install'; }
      });
      tplBox.appendChild(item);
    });
    const instBox = $('skills-installed');
    const renderSkill = (s, disabled) => `<div style="padding:9px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:7px;"><div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;"><b style="flex:1;">${escapeHtml(s.name)}</b><span style="font-size:11px;color:var(--muted);">v${escapeHtml(s.version || '1.0.0')} · ${fmtSize(s.sizeBytes || 0)} · ~${fmtNum(s.estimatedTokens || 0)} token</span><span style="font-size:11px;">${disabled ? '⏸️ Disabled' : '✅ Enabled'}</span></div><div style="font-size:11px;color:var(--muted);margin:4px 0;">Source: ${escapeHtml(s.source || 'unknown')} · Permission: ${escapeHtml((s.permissions || []).join(', '))} · Backup: ${s.backupCount || 0}</div>${s.specOk === false ? `<div style="font-size:11px;color:#fbbf24;margin-bottom:5px;" title="${escapeHtml((s.specMissing || []).join(', '))}">📐 Belum sesuai spesifikasi — kurang: ${escapeHtml((s.specMissing || []).slice(0, 3).join(', '))}</div>` : (s.specOk ? '<div style="font-size:11px;color:#6ee7b7;margin-bottom:5px;">📐 Sesuai spesifikasi</div>' : '')}<div style="display:flex;gap:6px;flex-wrap:wrap;"><button class="btn small sk-enable">${disabled ? '▶️ Enable' : '⏸️ Disable'}</button><button class="btn small sk-update">🔄 Update</button><button class="btn small sk-rollback" ${s.backupCount ? '' : 'disabled'}>↩️ Rollback</button><button class="btn small danger sk-remove">🗑️ Hapus</button></div></div>`;
    const all = [...(d.installed || []).map(s => ({ ...s, disabled: false })), ...(d.disabled || []).map(s => ({ ...s, disabled: true }))];
    instBox.innerHTML = all.length ? all.map(s => renderSkill(s, s.disabled)).join('') : '<i>Belum ada skill terpasang dari template.</i>';
    instBox.querySelectorAll('div').forEach((row) => {
      const nameEl = row.querySelector('b'); if (!nameEl) return;
      const name = nameEl.textContent;
      const action = async (method, payload, confirmText) => {
        if (confirmText && !confirm(confirmText)) return;
        const r2 = await fetch('/api/skills/' + encodeURIComponent(name), { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const d2 = await r2.json().catch(() => ({}));
        if (!r2.ok) { $('skill-err').textContent = d2.error || 'Operasi skill gagal'; return; }
        $('skill-ok').textContent = '✅ Operasi skill berhasil.'; await loadSkills();
      };
      const enableBtn = row.querySelector('.sk-enable');
      if (enableBtn) enableBtn.addEventListener('click', () => action('PUT', { action: enableBtn.textContent.includes('Enable') ? 'enable' : 'disable' }, 'Ubah status skill ' + name + '?'));
      const updateBtn = row.querySelector('.sk-update');
      if (updateBtn) updateBtn.addEventListener('click', () => action('PUT', { action: 'update' }, 'Update skill ' + name + ' dengan template resmi? Backup dibuat otomatis.'));
      const rollbackBtn = row.querySelector('.sk-rollback');
      if (rollbackBtn) rollbackBtn.addEventListener('click', () => action('PUT', { action: 'rollback' }, 'Rollback skill ' + name + ' ke backup terakhir?'));
      const removeBtn = row.querySelector('.sk-remove');
      if (removeBtn) removeBtn.addEventListener('click', () => action('DELETE', {}, 'Hapus skill ' + name + '?'));
    });
  } catch (e) { $('skill-err').textContent = 'Gagal: ' + e.message; }
}

// ---------- Schedules (Jadwal Agent) ----------
async function loadSchedules() {
  const box = $('schedule-list');
  try {
    const r = await fetch('/api/schedules');
    const d = await r.json();
    const jobs = d.jobs || [];
    if (!jobs.length) { box.innerHTML = '<div class="art-empty">Belum ada jadwal.<br>Buat jadwal di bawah ini.</div>'; return; }
    box.innerHTML = '';
    jobs.forEach(j => {
      // FIX bug render (15 Agu 2026): backend mengembalikan schedule sebagai OBJECT {kind, expression},
      // bukan string — escapeHtml(object) → "s.replace is not a function".
      const schedRaw = j.schedule;
      const schedExpr = (typeof schedRaw === 'string' ? schedRaw : (schedRaw && schedRaw.expression)) || j.id || 'jadwal';
      const item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';
      item.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span style="font-weight:700;flex:1;font-size:14px;">${escapeHtml(schedExpr)}</span>
        <span class="sch-status" style="font-size:11px;color:var(--muted);">${escapeHtml(j.lastStatus || (j.paused ? 'paused' : 'scheduled'))}</span>
        <button class="btn small sch-run">▶️ Run Now</button>
        <button class="btn small sch-toggle">${j.paused ? '▶️ Resume' : '⏸️ Pause'}</button>
        <button class="btn small sch-edit">✏️ Edit</button>
        <button class="btn small danger sch-del">🗑️</button>
      </div>
      <div style="color:var(--muted,#9aa4b2);font-size:12px;margin-top:4px;word-break:break-word;">${escapeHtml(String(j.prompt || j.description || '').slice(0, 160))}</div>
      <div style="color:var(--muted,#9aa4b2);font-size:11px;margin-top:4px;">🌍 ${escapeHtml(j.timezone || 'Asia/Jakarta')} · ${j.nextRun ? 'Next run: ' + new Date(j.nextRun).toLocaleString('id-ID', { timeZone: j.timezone || 'Asia/Jakarta' }) : 'Next run: disediakan scheduler'} · ${j.lastRun ? 'Last run: ' + new Date(j.lastRun).toLocaleString('id-ID', { timeZone: j.timezone || 'Asia/Jakarta' }) : 'Belum pernah dijalankan'}${j.lastError ? ' · Error: ' + String(j.lastError).slice(0, 120) : ''}</div>
      <details style="margin-top:6px;font-size:11px;"><summary style="cursor:pointer;color:var(--muted);">Riwayat eksekusi (${(j.history || []).length})</summary><div style="margin-top:5px;">${(j.history || []).slice().reverse().slice(0, 10).map(h => `<div>${new Date(h.at).toLocaleString('id-ID')} · ${escapeHtml(h.status || '')}${h.error ? ' · ' + escapeHtml(h.error) : ''}</div>`).join('') || '<i>Belum ada histori.</i>'}</div></details>`;
      item.querySelector('.sch-del').addEventListener('click', async () => {
        if (!confirm('Batalkan jadwal ini?')) return;
        const r = await fetch('/api/schedules/' + encodeURIComponent(j.id), { method:'DELETE' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Gagal membatalkan jadwal'); return; }
        await loadSchedules();
        toast('Jadwal dibatalkan ✅');
      });
      item.querySelector('.sch-edit').addEventListener('click', () => {
        $('sch-cron').value = schedExpr;
        $('sch-prompt').value = j.prompt || '';
        if ($('sch-timezone')) $('sch-timezone').value = j.timezone || 'Asia/Jakarta';
        $('sch-save').dataset.editId = j.id;
        $('sch-save').textContent = '💾 Update Jadwal';
        updateSchedulePreview();
        $('sch-prompt').focus();
        toast('Edit jadwal ' + j.id + ', lalu klik Update Jadwal');
      });
      item.querySelector('.sch-toggle').addEventListener('click', async () => {
        const action = j.paused ? 'resume' : 'pause';
        const r = await fetch('/api/schedules/' + encodeURIComponent(j.id) + '/' + action, { method:'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Gagal mengubah status jadwal'); return; }
        await loadSchedules();
        toast(action === 'pause' ? 'Jadwal dijeda ✅' : 'Jadwal dilanjutkan ✅');
      });
      item.querySelector('.sch-run').addEventListener('click', async () => {
        if (!confirm('Jalankan prompt jadwal ini sekarang? Ini akan memakai quota/token.')) return;
        const r = await fetch('/api/schedules/' + encodeURIComponent(j.id) + '/run', { method:'POST' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Gagal menjalankan jadwal'); return; }
        await loadSchedules();
        toast('Jadwal mulai dijalankan ✅');
      });
      box.appendChild(item);
    });
  } catch (e) { box.innerHTML = '<div class="msg-err">Gagal: ' + escapeHtml(e.message) + '</div>'; }
}
$('sch-save').addEventListener('click', async () => {
  const ok = $('sch-ok'), err = $('sch-err'); ok.textContent=''; err.textContent='';
  try {
    const cron = buildCronFromPicker();
    const editId = $('sch-save').dataset.editId || '';
    const r = editId
      ? await fetch('/api/schedules/' + encodeURIComponent(editId), { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ schedule: cron, prompt: $('sch-prompt').value.trim(), timezone: $('sch-timezone').value }) })
      : await fetch('/api/schedules', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ schedule: cron, prompt: $('sch-prompt').value.trim(), timezone: $('sch-timezone').value }) });
    const d = await r.json();
    if (r.ok) {
      ok.textContent = editId ? '✅ Jadwal diperbarui (' + cron + ').' : '✅ Jadwal dibuat (' + cron + ').';
      $('sch-prompt').value=''; $('sch-cron').value=''; delete $('sch-save').dataset.editId; $('sch-save').textContent = '➕ Tambah Jadwal';
      await loadSchedules();
      updateSchedulePreview();
    } else err.textContent = d.error || 'Gagal menyimpan jadwal';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});

// ---------- Jadwal: picker visual (instruksi Papi 15 Agu 2026) ----------
// User pilih jam/menit/hari via dropdown → cron di-generate otomatis (gak perlu hafal format).
const SCH_DAY_OPTIONS = [
  { value: '*', label: 'Setiap hari' },
  { value: '1-5', label: 'Hari kerja (Senin–Jumat)' },
  { value: '0,6', label: 'Akhir pekan (Sabtu–Minggu)' },
  { value: '1', label: 'Senin' },
  { value: '2', label: 'Selasa' },
  { value: '3', label: 'Rabu' },
  { value: '4', label: 'Kamis' },
  { value: '5', label: 'Jumat' },
  { value: '6', label: 'Sabtu' },
  { value: '0', label: 'Minggu' },
];
const SCH_DATE_OPTIONS = [
  { value: '*', label: 'Setiap tanggal' },
];
function initSchedulePicker() {
  const hourSel = $('sch-hour'), minSel = $('sch-minute'), daySel = $('sch-days'), dateSel = $('sch-date');
  if (!hourSel || !minSel || !daySel || !dateSel) return;
  hourSel.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option'); opt.value = String(h);
    const label = String(h).padStart(2, '0') + ':00';
    opt.textContent = label + (h < 12 ? ' pagi' : h < 18 ? ' siang/sore' : ' malam');
    hourSel.appendChild(opt);
  }
  hourSel.value = '7'; // default jam 7 pagi
  minSel.innerHTML = '';
  for (let m = 0; m < 60; m += 5) {
    const opt = document.createElement('option'); opt.value = String(m); opt.textContent = String(m).padStart(2, '0');
    minSel.appendChild(opt);
  }
  minSel.value = '0';
  daySel.innerHTML = '';
  SCH_DAY_OPTIONS.forEach((o) => {
    const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label;
    daySel.appendChild(opt);
  });
  dateSel.innerHTML = '';
  SCH_DATE_OPTIONS.forEach((o) => {
    const opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label;
    dateSel.appendChild(opt);
  });
  ['sch-hour','sch-minute','sch-days','sch-date'].forEach((id) => {
    const el = $(id); if (el) el.addEventListener('change', updateSchedulePreview);
  });
  $('sch-cron').addEventListener('input', updateSchedulePreview);
  updateSchedulePreview();
}
function scheduleDayLabel(v) {
  const found = SCH_DAY_OPTIONS.find((o) => o.value === v);
  return found ? found.label : (v === '*' ? 'Setiap hari' : 'hari ' + v);
}
function buildCronFromPicker() {
  const manual = ($('sch-cron').value || '').trim();
  if (manual) return manual; // format manual menang kalau diisi
  const minute = $('sch-minute').value;
  const hour = $('sch-hour').value;
  const day = $('sch-days').value;
  const date = $('sch-date').value;
  return [minute, hour, date, '*', day].join(' ');
}
function updateSchedulePreview() {
  const cron = buildCronFromPicker();
  const pv = $('sch-preview'), pt = $('sch-preview-text');
  if (!pv || !pt) return;
  pv.textContent = cron;
  const manual = ($('sch-cron').value || '').trim();
  if (manual) {
    pt.textContent = 'Format manual dipakai.';
    return;
  }
  const hh = String($('sch-hour').value).padStart(2, '0');
  const mm = String($('sch-minute').value).padStart(2, '0');
  const dayLabel = scheduleDayLabel($('sch-days').value);
  const dateLabel = $('sch-date').value === '*' ? '' : 'tanggal ' + $('sch-date').value + ' setiap bulan';
  pt.textContent = 'Agent akan bekerja ' + (dateLabel ? dateLabel + ', ' : '') + dayLabel + ' pukul ' + hh + ':' + mm + '.';
}
initSchedulePicker();

// ---------- Prompt Templates ----------
let sessionQuery = '';
let promptsCache = [];
$('session-search').addEventListener('input', (e) => { sessionQuery = e.target.value; renderSessions(); });
async function loadPrompts() {
  try {
    const r = await fetch('/api/prompts'); const d = await r.json();
    promptsCache = d.prompts || [];
    renderPrompts();
  } catch (e) {}
}
// ---------- Slash Commands kelola (Papi 16 Agu 2026) ----------
async function loadSlashList() {
  try {
    const r = await fetch('/api/slash'); const d = await r.json();
    slashCache = d.items || [];
    const box = $('slash-list'); if (!box) return;
    if (!slashCache.length) { box.innerHTML = '<div class="art-empty">Belum ada slash command.</div>'; return; }
    box.innerHTML = '';
    slashCache.forEach(sc => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';
      item.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:700;flex:1;font-size:14px;color:var(--accent);">/${escapeHtml(sc.name)}</span>
        <button class="btn small sc-edit">✏️</button>
        <button class="btn small sc-del">🗑️</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:4px;">${escapeHtml(sc.description || '')}</div>
      <div style="font-size:11.5px;color:var(--muted);margin-top:4px;background:var(--bg);padding:6px 8px;border-radius:6px;font-family:monospace;word-break:break-word;">${escapeHtml(sc.template || '').slice(0, 200)}${(sc.template||'').length>200?'…':''}</div>`;
      item.querySelector('.sc-del').addEventListener('click', async () => {
        if (!confirm('Hapus slash /' + sc.name + '?')) return;
        await fetch('/api/slash/' + sc.id, { method:'DELETE' });
        loadSlashList(); loadSlashCache();
      });
      item.querySelector('.sc-edit').addEventListener('click', () => {
        $('sc-name').value = sc.name; $('sc-desc').value = sc.description || ''; $('sc-text').value = sc.template;
        $('sc-save').dataset.editId = sc.id; $('sc-save').textContent = '💾 Update Slash';
        toast('Edit /' + sc.name + ' — ubah lalu klik Update');
      });
      box.appendChild(item);
    });
  } catch (e) {}
}
if ($('sc-save')) $('sc-save').addEventListener('click', async () => {
  const ok = $('sc-ok'), err = $('sc-err'); ok.textContent=''; err.textContent='';
  const editId = $('sc-save').dataset.editId || null;
  const payload = { name: $('sc-name').value.trim().toLowerCase().replace(/[^a-z0-9]/g,''), description: $('sc-desc').value.trim(), template: $('sc-text').value.trim() };
  if (!payload.name || !payload.template) { err.textContent = 'Nama & isi prompt wajib diisi.'; return; }
  try {
    const r = editId ? await fetch('/api/slash/' + editId, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
                     : await fetch('/api/slash', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal'; return; }
    ok.textContent = editId ? '✅ Slash diperbarui.' : '✅ Slash ditambahkan. Coba ketik /' + payload.name + ' di chat.';
    $('sc-name').value=''; $('sc-desc').value=''; $('sc-text').value=''; delete $('sc-save').dataset.editId; $('sc-save').textContent = 'Simpan Slash';
    loadSlashList(); loadSlashCache();
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
function renderPrompts() {
  const box = $('prompt-list');
  if (!promptsCache.length) { box.innerHTML = '<div class="art-empty">Belum ada template.<br>Buat di bawah ini.</div>'; return; }
  box.innerHTML = '';
  promptsCache.forEach(pt => {
    const item = document.createElement('div');
    item.className = 'pt-item';
    item.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';
    item.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
      <span style="font-weight:700;flex:1;font-size:14px;">${escapeHtml(pt.name)}</span>
      <button class="btn small pt-use">✉️ Pakai</button>
      <button class="btn small pt-del">🗑️</button>
    </div>`;
    item.querySelector('.pt-use').addEventListener('click', () => { $('message').value = pt.text; $('settings').classList.remove('open'); $('message').focus(); toast('Template dimasukkan ✅'); });
    item.querySelector('.pt-del').addEventListener('click', async () => {
      if (!confirm('Hapus template ini?')) return;
      await fetch('/api/prompts/' + pt.id, { method:'DELETE' });
      loadPrompts();
    });
    box.appendChild(item);
  });
}
$('pt-save').addEventListener('click', async () => {
  const ok = $('pt-ok'), err = $('pt-err'); ok.textContent=''; err.textContent='';
  try {
    const r = await fetch('/api/prompts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: $('pt-name').value.trim(), text: $('pt-text').value.trim() }) });
    const d = await r.json();
    if (r.ok) { ok.textContent = '✅ Template disimpan.'; $('pt-name').value=''; $('pt-text').value=''; loadPrompts(); }
    else err.textContent = d.error || 'Gagal simpan';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
$('prompt-btn').addEventListener('click', async () => {
  if (!promptsCache.length) { await loadPrompts(); }
  if (!promptsCache.length) { toast('Belum ada template. Buka Settings → Template'); return; }
  const names = promptsCache.map(p => p.name);
  const pick = prompt('Pilih template:\n' + names.map((n, i) => (i+1) + '. ' + n).join('\n'));
  if (!pick) return;
  const idx = parseInt(pick, 10) - 1;
  const pt = promptsCache[idx];
  if (pt) { $('message').value = pt.text; $('message').focus(); toast('Template dimasukkan ✅'); }
});

// ---------- MFA (Verifikasi 2 Langkah) ----------
async function loadMfaStatus() {
  const st = $('mfa-status'), setup = $('mfa-setup-box'), sb = $('mfa-setup-btn'), db = $('mfa-disable-btn');
  try {
    const r = await fetch('/api/mfa/status'); const d = await r.json();
    if (d.enabled) { st.textContent = '✅ MFA aktif — login butuh kode 6 digit.'; setup.style.display='none'; sb.style.display='none'; db.style.display=''; }
    else if (d.hasSecret) { st.textContent = '⚠️ Secret sudah dibuat, tapi MFA belum diaktifkan. Masukkan kode untuk mengaktifkan.'; sb.style.display='none'; db.style.display='none'; setup.style.display=''; mfaShowSetup(); }
    else { st.textContent = '❌ MFA belum aktif — disarankan aktifkan.'; setup.style.display='none'; db.style.display='none'; sb.style.display=''; }
  } catch(e) { st.textContent = 'gagal cek status'; }
}
async function mfaShowSetup() {
  try {
    const r = await fetch('/api/mfa/setup', { method:'POST' }); const d = await r.json();
    $('mfa-secret').textContent = d.secret || '—';
    const qr = $('mfa-qr'); qr.innerHTML = '';
    if (d.otpauth && typeof QRCode !== 'undefined') { new QRCode(qr, { text: d.otpauth, width: 160, height: 160 }); }
    else if (d.otpauth) { const a = document.createElement('a'); a.href = d.otpauth; a.textContent = 'Buka otpauth di aplikasi'; a.target='_blank'; qr.appendChild(a); }
  } catch(e) { $('mfa-err').textContent = 'Gagal setup: ' + e.message; }
}
$('mfa-setup-btn').addEventListener('click', async () => { $('mfa-setup-box').style.display=''; $('mfa-setup-btn').style.display='none'; await mfaShowSetup(); });
$('mfa-enable-btn').addEventListener('click', async () => {
  const ok = $('mfa-ok'), err = $('mfa-err'); ok.textContent=''; err.textContent='';
  try {
    const r = await fetch('/api/mfa/enable', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code: $('mfa-code').value.trim() }) });
    const d = await r.json();
    if (r.ok) {
      ok.textContent = '✅ MFA aktif! Login berikutnya butuh kode 6 digit.';
      if (d.backupCodes && d.backupCodes.length) {
        $('mfa-backup-codes').textContent = d.backupCodes.join('  ·  ');
        $('mfa-backup-box').style.display = '';
      }
      loadMfaStatus();
    }
    else err.textContent = d.error || 'Gagal aktifkan';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
$('mfa-regen-btn').addEventListener('click', async () => {
  const code = prompt('Masukkan kode 6 digit MFA saat ini untuk membuat kode cadangan baru:');
  if (!code) return;
  try {
    const r = await fetch('/api/mfa/backupcodes', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (r.ok) { $('mfa-backup-codes').textContent = d.backupCodes.join('  ·  '); $('mfa-backup-box').style.display = ''; toast('🔑 Kode cadangan baru dibuat'); }
    else toast(d.error || 'Gagal');
  } catch (e) { toast('Gagal: ' + e.message); }
});
$('mfa-disable-btn').addEventListener('click', async () => {
  const ok = $('mfa-ok'), err = $('mfa-err'); ok.textContent=''; err.textContent='';
  const code = prompt('Masukkan kode MFA 6 digit untuk menonaktifkan:');
  if (!code) return;
  try {
    const r = await fetch('/api/mfa/disable', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code }) });
    const d = await r.json();
    if (r.ok) { ok.textContent = 'MFA dinonaktifkan.'; loadMfaStatus(); }
    else err.textContent = d.error || 'Gagal nonaktifkan';
  } catch(e) { err.textContent = 'Gagal: ' + e.message; }
});

// ---------- Status Center (Mission Control) ----------
function fmtNum(n) { if (n == null) return '—'; return Number(n).toLocaleString('id-ID'); }
// Standar mata uang SATU: Rupiah (Papi 19 Agu 2026 — jangan campur $ dan Rp).
// Kurs diambil dari Faktor Jual (sfKurs, server) kalau sudah di-load; fallback 18000.
let USD_RATE = 18000;
function usdToRp(usd) { return 'Rp' + fmtNum(Math.round((Number(usd) || 0) * USD_RATE)); }
async function loadStatus() {
  const err = $('status-err'); if (err) err.textContent = '';
  try {
    const r = await fetch('/api/status');
    const d = await r.json();
    if (!r.ok || !d.ok) { if (err) err.textContent = d.error || 'Gagal ambil status'; return; }
    $('st-uptime').textContent = d.hub.uptimeHuman || '—';
    $('st-version').textContent = d.hub.version || '—';
    $('st-memory').textContent = d.hub.memoryRss || '—';
    $('st-files').textContent = d.hub.workspaceFiles != null ? d.hub.workspaceFiles + ' file' : '—';
    $('st-sessions').textContent = d.me.sessionsTotal + ' / ' + d.me.sessionsLimit;
    $('st-active').textContent = d.me.sessionsActive;
    $('st-model').textContent = d.me.model || '—';
    $('st-thinking').textContent = d.me.thinking || '—';
    $('st-session-name').textContent = d.me.activeSession ? d.me.activeSession.name + (d.me.activeSession.busy ? ' (sibuk)' : '') : '—';
    // F42 Infra Health (9 Sep 2026): indikator engine + jumlah model dari /api/models.
    const eng = $('st-engine');
    if (eng) {
      eng.innerHTML = d.ok ? '<span style="color:var(--ok,#2ecc71);font-weight:700;">🟢 Engine OK</span>' : '<span style="color:#e74c3c;font-weight:700;">🔴 Bermasalah</span>';
      eng.title = 'Server prime-agent hub v' + (d.hub.version || '?') + ' — ' + (d.hub.uptimeHuman || '');
    }
    try {
      const mr = await fetch('/api/models');
      const md = await mr.json();
      const mm = (md.models || []).length;
      const me = $('st-models');
      if (me) me.textContent = mm > 0 ? mm + ' model siap pakai' : '—';
      // Provider unik (tidak tampil secret — hanya nama penyedia)
      const provs = [...new Set((md.models || []).map((x) => x.provider).filter(Boolean))];
      if (me && provs.length) { me.textContent = mm + ' model · ' + provs.join(', '); me.style.fontSize = '13px'; }
    } catch (e) {}
  } catch (e) { if (err) err.textContent = 'Gagal: ' + e.message; }
  // Usage & cost (get_session_stats)
  try {
    const ur = await fetch('/api/usage');
    const ud = await ur.json();
    const u = ud.usage;
    $('st-cost').textContent = u && u.cost != null ? usdToRp(u.cost) : '—';
    $('st-tokens').textContent = u && u.tokens ? fmtNum(u.tokens.total) : '—';
    $('st-context').textContent = u && u.contextUsage ? (u.contextUsage.percent != null ? u.contextUsage.percent + '%' : '—') : '—';
    $('st-toolcalls').textContent = u && u.toolCalls != null ? fmtNum(u.toolCalls) : '—';
  } catch (e) {}
  loadMyUsage(); // grafik 14 hari + kuota (Papi 7 Sep 2026)
}


// ===== Chart pemakaian 14 hari (Papi 7 Sep 2026, audit P1) =====
function drawUsageChart(days) {
  try {
    const cv = $('usage-chart'); if (!cv || !days || !days.length) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, padL = 8, padB = 18, padT = 6;
    ctx.clearRect(0, 0, W, H);
    const maxT = Math.max(1, ...days.map((x) => x.t || 0));
    const n = days.length, slot = (W - padL - 4) / n, bw = Math.min(26, slot * 0.6);
    days.forEach((x, i) => {
      const hh = ((x.t || 0) / maxT) * (H - padT - padB);
      const bx = padL + i * slot + (slot - bw) / 2;
      ctx.fillStyle = x.t > 0 ? '#8b5cf6' : 'rgba(139,92,246,.14)';
      ctx.fillRect(bx, H - padB - Math.max(2, hh), bw, Math.max(2, hh));
      if (i % 2 === 0 || i === n - 1) {
        ctx.fillStyle = '#6b7280'; ctx.font = '9px system-ui,sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(String(x.k).slice(5), padL + i * slot + slot / 2, H - 5);
      }
    });
    const sumT = days.reduce((a, x) => a + (x.t || 0), 0);
    const sumC = days.reduce((a, x) => a + (x.c || 0), 0);
    const sum = $('usage-summary');
    if (sum) sum.textContent = 'Total 14 hari: ' + fmtNum(sumT) + ' token · ' + usdToRp(sumC);
  } catch (e) {}
}
async function loadMyUsage() {
  try {
    const r = await fetch('/api/myusage');
    if (!r.ok) return;
    const d = await r.json();
    if (!d || !d.days) return;
    drawUsageChart(d.days);
    const q = $('st-quota');
    if (q) {
      const pct = d.dailyTokens ? Math.min(100, Math.round((d.usedToday / d.dailyTokens) * 100)) : 0;
      const qf = $('quota-fill'); if (qf) qf.style.width = pct + '%';
      q.textContent = fmtNum(d.usedToday) + ' / ' + fmtNum(d.dailyTokens) + ' token (' + pct + '%) · tier ' + (d.tier || 'free') + ' · credit Rp' + fmtNum(d.credit);
    }
  } catch (e) {}
}

// ---------- Hemat Token ----------
async function loadThinkingState() {
  const modelEl = $('tok-model'), countEl = $('tok-count'), autoEl = $('tok-auto');
  modelEl.textContent = 'memuat...'; countEl.textContent = '—'; autoEl.textContent = '—';
  try {
    const r = await fetch('/api/thinking');
    const d = await r.json();
    modelEl.textContent = d.model || '—';
    countEl.textContent = d.messageCount != null ? d.messageCount : '—';
    autoEl.textContent = d.autoCompactionEnabled === false ? '❌ Mati' : '✅ Aktif';
    if (d.thinkingLevel) {
      const sel = $('tok-level');
      if ([...sel.options].some(o => o.value === d.thinkingLevel)) sel.value = d.thinkingLevel;
    }
  } catch (e) {
    modelEl.textContent = 'gagal ambil status';
  }
}
$('tok-save').addEventListener('click', async () => {
  const level = $('tok-level').value;
  const ok = $('tok-ok'), err = $('tok-err');
  ok.textContent=''; err.textContent='';
  try {
    const r = await fetch('/api/thinking', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ level }) });
    const d = await r.json();
    if (r.ok) { ok.textContent = '✅ Level berpikir diubah ke ' + level + ' — berlaku untuk sesi ini & sesi berikutnya.'; loadThinkingState(); }
    else err.textContent = d.error || 'Gagal simpan';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
$('tok-compact').addEventListener('click', async () => {
  const ok = $('tok-ok'), err = $('tok-err');
  ok.textContent=''; err.textContent='';
  const btn = $('tok-compact');
  btn.disabled = true; btn.textContent = '📦 Meringkas...';
  try {
    const r = await fetch('/api/compact', { method:'POST' });
    const d = await r.json();
    if (r.ok) { ok.textContent = '✅ Konteks diringkas! Riwayat lama di-compact, sesi tetap nyambung.'; }
    else err.textContent = d.error || 'Gagal compact';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
  btn.disabled = false; btn.textContent = '📦 Ringkas Konteks Sekarang';
});

// ---------- Update Prime Agent ----------
async function checkVersion() {
  const statusEl = $('ver-status'), localEl = $('ver-local'), latestEl = $('ver-latest');
  statusEl.textContent = 'memeriksa...';
  try {
    const [vr, ur] = await Promise.all([fetch('/api/version'), fetch('/api/update-state')]);
    const d = await vr.json();
    const us = await ur.json().catch(() => ({}));
    localEl.textContent = d.local || '—';
    latestEl.textContent = d.latest || '—';
    const state = us.state || {};
    $('ver-before').textContent = state.before || '—';
    $('ver-after').textContent = state.after || '—';
    const rollback = $('update-rollback');
    if (rollback) rollback.style.display = state.backup && !state.lock && state.status !== 'idle' ? '' : 'none';
    if (state.lock || state.maintenance) { statusEl.textContent = '⏳ Maintenance: update sedang berjalan'; statusEl.style.color = 'var(--gold)'; $('update-now').style.display = 'none'; }
    else if (state.status === 'rolled_back' || state.status === 'rollback_failed') { statusEl.textContent = state.status === 'rolled_back' ? '↩️ Rollback otomatis selesai' : '❌ Rollback gagal'; statusEl.style.color = state.status === 'rolled_back' ? 'var(--gold)' : 'var(--danger)'; $('update-now').style.display = 'none'; }
    else if (d.upToDate) { statusEl.textContent = '✅ Terbaru'; statusEl.style.color = 'var(--ok)'; $('update-now').style.display = 'none'; }
    else if (d.local && d.latest) { statusEl.textContent = '⚠️ Update tersedia'; statusEl.style.color = 'var(--gold)'; $('update-now').style.display = ''; }
    else { statusEl.textContent = '—'; statusEl.style.color = ''; $('update-now').style.display = 'none'; }
  } catch (e) {
    statusEl.textContent = 'gagal cek'; statusEl.style.color = 'var(--danger)';
  }
}
$('update-check').addEventListener('click', checkVersion);
// F31 Badge versi sidebar (9 Sep 2026): tampil ringkas vX.Y.Z + indikator update tersedia.
async function loadSideVersion() {
  try {
    const el = $('side-ver'); if (!el) return;
    const r = await fetch('/api/version');
    const d = await r.json().catch(() => ({}));
    const local = String(d.local || '').trim();
    if (local) {
      const short = local.replace(/^prime-agent\s*/i, '').replace(/^v/, '').slice(0, 12);
      el.textContent = '⚙️ v' + short;
      el.title = 'Engine: ' + local + (d.latest ? ' · terbaru: ' + d.latest : '');
      if (d.latest && d.upToDate === false) { el.textContent += ' ⬆️'; el.title += ' — update tersedia'; }
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => { try { $('settings-open').click(); } catch (e) {} });
    }
  } catch (e) {}
}
setTimeout(loadSideVersion, 3000); // lambat sedikit, tidak ganggu render awal
$('update-now').addEventListener('click', async () => {
  const log = $('update-log'), ok = $('update-ok'), err = $('update-err');
  if (!confirm('Update Prime Agent sekarang? Backup binary dibuat otomatis dan rollback berjalan jika health gate gagal.')) return;
  log.style.display = 'block'; log.textContent = 'Menjalankan update dengan backup & health gate...\n';
  ok.textContent=''; err.textContent=''; $('update-now').disabled = true;
  try {
    const res = await fetch('/api/update', { method: 'POST' });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Update ditolak'); }
    const reader = res.body.getReader(); const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break; log.textContent += decoder.decode(value, { stream: true }); log.scrollTop = log.scrollHeight; }
    await checkVersion();
  } catch (e) { err.textContent = 'Gagal update: ' + e.message; }
  $('update-now').disabled = false;
});
$('update-rollback').addEventListener('click', async () => {
  const ok = $('update-ok'), err = $('update-err');
  if (!confirm('Rollback Prime Agent ke backup terakhir? Container akan restart otomatis setelah pemulihan.')) return;
  ok.textContent = ''; err.textContent = '';
  try {
    const r = await fetch('/api/update/rollback', { method:'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = d.error || 'Rollback gagal'; return; }
    ok.textContent = '↩️ Rollback berhasil dipulihkan. Container restarting...';
    setTimeout(() => location.reload(), 8000);
  } catch (e) { ok.textContent = '↩️ Rollback dipicu. Halaman akan dimuat ulang...'; setTimeout(() => location.reload(), 5000); }
});
// Restart aplikasi — satu tempat dengan Update (Papi 19 Agu 2026)
$('restart-app').addEventListener('click', async () => {
  const ok = $('update-ok'), err = $('update-err');
  if (!confirm('🔄 Restart container sekarang?\n\nKoneksi akan putus ±10 detik. Semua proses Prime Agent aktif akan dihentikan dan container dihidupkan kembali otomatis. Data tersimpan di volume production. Lanjut?')) return;
  ok.textContent = ''; err.textContent = '';
  $('restart-app').disabled = true;
  try {
    const r = await fetch('/api/restart', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal restart container'; $('restart-app').disabled = false; return; }
    ok.textContent = '🔄 Container restarting... halaman akan muat ulang otomatis.';
    setTimeout(() => { location.reload(); }, 8000);
  } catch (e) {
    // fetch gagal karena server sudah restart — reload saja
    ok.textContent = '🔄 Restart dipicu — halaman muat ulang...';
    setTimeout(() => { location.reload(); }, 5000);
  }
});
function loadSettingsProfile() {
  if (!me) return;
  // FIX audit Dinda 29 Agu 2026 (K7): peringatan MFA untuk akun admin yang belum aktif
  const mfaWarn = $('mfa-warn-admin');
  if (mfaWarn) mfaWarn.style.display = (me.role === 'admin' && !me.mfaEnabled) ? 'block' : 'none';
  $('profile-name').value = me.name || '';
  const pa = $('profile-avatar');
  pa.innerHTML = '';
  const fallback = () => { pa.innerHTML = ''; pa.textContent = initials(me.name || me.username); };
  if (me.hasAvatar) { const img = document.createElement('img'); img.onerror = fallback; img.src='/api/avatar?u='+me.id+'&t='+Date.now(); img.style.cssText='width:100%;height:100%;border-radius:50%;object-fit:cover;'; pa.appendChild(img); }
  else fallback();
  $('profile-ok').textContent=''; $('profile-err').textContent='';
}
$('profile-save').addEventListener('click', async () => {
  $('profile-ok').textContent=''; $('profile-err').textContent='';
  const payload = { name: $('profile-name').value.trim() };
  if ($('profile-avatar-file').files[0]) {
    try {
      const raw = await fileToDataUrl($('profile-avatar-file').files[0]);
      payload.avatar = await compressImage(raw, 512);
    } catch (e) { $('profile-err').textContent = 'Gagal membaca gambar: ' + e.message; return; }
  }
  const r = await fetch('/api/profile', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const d = await r.json();
  if (r.ok) { $('profile-ok').textContent = 'Profil tersimpan ✅'; me = d.user; loadSettingsProfile(); updateSidebarUser(); refreshPrime(); }
  else $('profile-err').textContent = d.error || 'Gagal simpan';
});

// ---------- API Keys ----------
async function loadApiKeys() {
  try {
    const r = await fetch('/api/apikeys'); if (!r.ok) return;
    const d = await r.json();
    // Status Developer (BYOK) — Aaron 14 Agu 2026
    const dev = !!(me && me.isDev);
    const db = $('dev-badge'); if (db) db.style.display = dev ? '' : 'none';
    const ds = $('dev-status'); if (ds) ds.innerHTML = dev ? '🧑‍💻 <b>Kamu: Developer</b> — pakai API sendiri, quota 5×, harga paket lebih murah, token dibayar ke provider (tidak potong credit).' : '👤 <b>Kamu: User Umum</b> — pakai API dari kami (quota harian + credit).';
    const box = $('apikey-list');
    box.innerHTML = '';
    (d.providers || []).forEach(k => {
      const row = document.createElement('div'); row.className='key-row';
      row.innerHTML = `
        <span class="k-prov">${escapeHtml(k.provider)}</span>
        <span class="k-mask">${escapeHtml(k.masked)}</span>
        <span class="k-actions">
          ${k.builtin ? '<span class="badge">bawaan</span>' : ''}
          ${!k.builtin ? '<button class="btn small danger" data-del="' + escapeHtml(k.provider) + '">Hapus</button>' : ''}
        </span>`;
      const delBtn = row.querySelector('[data-del]');
      if (delBtn) delBtn.addEventListener('click', async () => {
        if (!confirm('Hapus API key ' + k.provider + '?')) return;
        await fetch('/api/apikeys/' + k.provider, { method:'DELETE' });
        toast('Key dihapus');
        refreshStatus(); loadApiKeys();
      });
      box.appendChild(row);
    });
    if (!(d.providers || []).length) box.innerHTML = '<div class="art-empty">Belum ada API key.<br>Tambah di bawah 👇</div>';
  } catch(e) {}
}
$('ak-save').addEventListener('click', async () => {
  const provider = $('ak-provider').value;
  const key = $('ak-key').value.trim();
  $('ak-ok').textContent=''; $('ak-err').textContent='';
  if (!key) { $('ak-err').textContent = 'Key wajib diisi.'; return; }
  const r = await fetch('/api/apikeys', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ provider, key }) });
  const d = await r.json();
  if (r.ok) {
    $('ak-ok').textContent = 'Key ' + provider + ' disimpan ✅';
    $('ak-key').value=''; loadApiKeys(); refreshModels();
    refreshStatus();
    if (d.isDev) toast('🧑‍💻 Selamat! Kamu sekarang Developer — quota 5×, token dari key-mu sendiri');
  }
  else $('ak-err').textContent = d.error || 'Gagal simpan key';
});

// ---------- Riwayat (FIX audit Dinda 29 Agu 2026, B5: statistik terbaca sebelum hapus) ----------
function relTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'baru saja';
  if (m < 60) return m + ' menit lalu';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' jam lalu';
  const d = Math.floor(h / 24);
  if (d < 30) return d + ' hari lalu';
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + ' bulan lalu';
  return Math.floor(mo / 12) + ' tahun lalu';
}
async function loadHistoryStats() {
  const box = $('history-list'); if (!box) return;
  try {
    const r = await fetch('/api/history');
    if (!r.ok) { box.innerHTML = '<div style="color:var(--muted);">Gagal memuat riwayat.</div>'; return; }
    const d = await r.json();
    $('hist-total-sessions').textContent = (d.totalSessions || 0).toLocaleString('id-ID');
    $('hist-total-messages').textContent = (d.totalMessages || 0).toLocaleString('id-ID');
    $('hist-member-since').textContent = d.createdAt ? new Date(d.createdAt).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    const sessions = d.sessions || [];
    if (!sessions.length) { box.innerHTML = '<div style="color:var(--muted);">Belum ada sesi.</div>'; return; }
    box.innerHTML = '';
    sessions.forEach((s) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;';
      row.innerHTML = `<span style="flex-shrink:0;">${s.pinned ? '📌' : '💬'}</span>
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.name || '(tanpa nama)')}</span>
        <span style="color:var(--muted);font-size:11.5px;flex-shrink:0;">${s.messageCount != null ? s.messageCount + ' pesan' : ''}</span>
        <span style="color:var(--muted);font-size:11.5px;flex-shrink:0;">${relTime(s.lastUsed)}</span>`;
      box.appendChild(row);
    });
  } catch (e) { box.innerHTML = '<div style="color:var(--muted);">Error: ' + escapeHtml(e.message) + '</div>'; }
}
$('history-clear-all').addEventListener('click', async () => {
  const answer = prompt('⚠️ Ini akan menghapus SEMUA riwayat percakapan secara PERMANEN.\n\nKetik HAPUS SEMUA (huruf besar) untuk melanjutkan:');
  if (answer !== 'HAPUS SEMUA') { toast('Dibatalkan — tidak ada yang dihapus'); return; }
  try {
    const r = await fetch('/api/history', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'HAPUS SEMUA' }) });
    if (r.ok) { $('history-ok').textContent = '✅ Semua riwayat dihapus.'; refreshSessions(); loadHistoryStats(); }
    else { const d = await r.json().catch(() => ({})); toast(d.error || 'Gagal hapus riwayat'); }
  } catch (e) { toast('Gagal: ' + e.message); }
});

// ---------- Security ----------
$('pw-save').addEventListener('click', async () => {
  const oldPw = $('pw-old').value, np = $('pw-new').value, np2 = $('pw-new2').value;
  $('pw-ok').textContent=''; $('pw-err').textContent='';
  if (np !== np2) { $('pw-err').textContent = 'Password baru tidak sama.'; return; }
  if (np.length < 8) { $('pw-err').textContent = 'Password baru minimal 8 karakter.'; return; }
  const r = await fetch('/api/password', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ oldPassword: oldPw, newPassword: np }) });
  const d = await r.json();
  if (r.ok) { $('pw-ok').textContent = 'Password diganti ✅'; $('pw-old').value=''; $('pw-new').value=''; $('pw-new2').value=''; }
  else $('pw-err').textContent = d.error || 'Gagal ganti password';
});

// ---------- Admin users ----------
async function loadUserList() {
  const r = await fetch('/api/users'); if (!r.ok) return;
  const d = await r.json();
  const box = $('user-list'); box.innerHTML='';
  d.users.forEach(u => {
    const row = document.createElement('div'); row.className='user-row';
    const av = document.createElement('div'); av.className='u-avatar';
    if (u.hasAvatar) { const img = document.createElement('img'); img.src='/api/avatar?u='+u.id+'&t='+Date.now(); img.style.cssText='width:100%;height:100%;border-radius:50%;object-fit:cover;'; av.appendChild(img); }
    else av.textContent = initials(u.name || u.username);
    row.appendChild(av);
    const info = document.createElement('div'); info.className='u-info';
    info.innerHTML = `<div class="u-name">${escapeHtml(u.name||u.username)} ${u.id===me.id ? '<span style="color:var(--muted);font-size:11px;">(kamu)</span>' : ''} ${u.suspended ? '<span class="badge" style="background:#ff3b30;color:#fff;font-size:10px;">SUSPENDED</span>' : ''}</div><div class="u-username">@${escapeHtml(u.username)} · <span class="badge ${u.role==='admin'?'':'member'}">${u.role}</span> · <span class="badge">${escapeHtml(u.tier || 'free')}</span></div>${(u.city || u.email || u.phone) ? `<div style="font-size:11px;color:var(--muted);">${escapeHtml(u.city || '')}${u.city && (u.email || u.phone) ? ' · ' : ''}${escapeHtml(u.phone || '')}${u.phone && u.email ? ' · ' : ''}${escapeHtml(u.email || '')}</div>` : ''}`;
    row.appendChild(info);
    if (u.id !== me.id) {
      const editBtn = document.createElement('button'); editBtn.className='btn small'; editBtn.textContent='✏️ Edit';
      editBtn.addEventListener('click', async () => {
        $('ue-username').textContent = '@' + u.username;
        $('ue-name').value = u.name || '';
        $('ue-role').value = u.role === 'admin' ? 'admin' : 'member';
        $('ue-tier').value = u.tier || 'free';
        $('ue-city').value = u.city || '';
        $('ue-phone').value = u.phone || '';
        $('ue-email').value = u.email || '';
        $('ue-ok').textContent = ''; $('ue-err').textContent = '';
        const modal = $('user-edit-modal');
        modal.style.display = 'flex';
        modal.dataset.uid = u.id;
      });
      row.appendChild(editBtn);
      const suspBtn = document.createElement('button'); suspBtn.className='btn small'; suspBtn.textContent = u.suspended ? '▶️ Aktifkan' : '⏸ Suspend';
      suspBtn.addEventListener('click', async () => {
        const act = u.suspended ? 'aktifkan kembali' : 'suspend (nonaktifkan sementara)';
        if (!confirm('Yakin ' + act + ' user @' + u.username + '?')) return;
        const rr = await fetch('/api/users/' + u.id + '/suspend', { method:'POST' });
        if (rr.ok) { toast('@' + u.username + (u.suspended ? ' diaktifkan ✅' : ' di-suspend ⏸')); loadUserList(); }
        else { const dd = await rr.json().catch(()=>({})); toast(dd.error || 'Gagal'); }
      });
      row.appendChild(suspBtn);
      const pwBtn = document.createElement('button'); pwBtn.className='btn small'; pwBtn.textContent='🔑 Password';
      pwBtn.addEventListener('click', async () => {
        const np = prompt('Ganti password untuk @' + u.username + ' (min 8 karakter):');
        if (!np) return;
        if (np.length < 8) { toast('Password minimal 8 karakter'); return; }
        const rr = await fetch('/api/users/' + u.id + '/password', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ newPassword: np }) });
        if (rr.ok) toast('Password @' + u.username + ' diganti ✅');
        else { const dd = await rr.json().catch(()=>({})); toast(dd.error || 'Gagal ganti password'); }
      });
      row.appendChild(pwBtn);
      const del = document.createElement('button'); del.className='btn danger small'; del.textContent='Hapus';
      del.addEventListener('click', async () => {
        if (!confirm('Hapus user @' + u.username + '?')) return;
        const rr = await fetch('/api/users/' + u.id, { method:'DELETE' });
        if (rr.ok) loadUserList(); else toast('Gagal hapus user');
      });
      row.appendChild(del);
    }
    box.appendChild(row);
  });
  if (d.users.length === 0) box.innerHTML = '<div class="art-empty">Belum ada user.</div>';
}
$('nu-save').addEventListener('click', async () => {
  const payload = { username: $('nu-username').value.trim(), password: $('nu-password').value, name: $('nu-name').value.trim(), role: $('nu-role').value };
  $('nu-ok').textContent=''; $('nu-err').textContent='';
  const r = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const d = await r.json();
  if (r.ok) { $('nu-ok').textContent = 'User ditambahkan ✅'; $('nu-username').value=''; $('nu-password').value=''; $('nu-name').value=''; loadUserList(); }
  else $('nu-err').textContent = d.error || 'Gagal tambah user';
});

// ---------- Prime avatar admin ----------
$('prime-avatar-save').addEventListener('click', async () => {
  if (!$('prime-avatar-file').files[0]) { $('prime-err').textContent = 'Pilih file dulu.'; return; }
  try {
    const raw = await fileToDataUrl($('prime-avatar-file').files[0]);
    const dataUrl = await compressImage(raw, 512, 0.9);
    const r = await fetch('/api/prime-avatar', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ avatar: dataUrl }) });
    const d = await r.json();
    if (r.ok) { $('prime-ok').textContent = 'Foto Prime diganti ✅'; $('prime-avatar-file').value=''; refreshPrime(); }
    else $('prime-err').textContent = d.error || 'Gagal';
  } catch (e) { $('prime-err').textContent = 'Gagal membaca gambar: ' + e.message; }
});
$('prime-avatar-reset').addEventListener('click', async () => {
  const r = await fetch('/api/prime-avatar', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ avatar: null }) });
  if (r.ok) { $('prime-ok').textContent = 'Foto Prime direset ke default ✅'; refreshPrime(); }
});

// ---------- Redesign 2026: Tema (Dinda 30 Agu 2026) ----------
function getTheme() { try { return localStorage.getItem('coblai-theme') || 'coblai'; } catch (e) { return 'coblai'; } }
function setTheme(name) {
  if (name === 'coblai') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', name);
  try { localStorage.setItem('coblai-theme', name); } catch (e) {}
  updateThemeUI();
}
function updateThemeUI() {
  const cur = getTheme();
  document.querySelectorAll('.theme-opt').forEach((o) => {
    o.classList.toggle('active', o.dataset.themeOpt === cur);
  });
}
document.querySelectorAll('.theme-opt').forEach((o) => {
  o.addEventListener('click', () => {
    setTheme(o.dataset.themeOpt);
    const nm = o.querySelector('.th-name');
    toast('🎨 Tema: ' + (nm ? nm.textContent : o.dataset.themeOpt));
  });
});
// Navigasi mobile (bar bawah) + tombol tutup sidebar di HP
if ($('mn-home')) $('mn-home').addEventListener('click', () => { window.location.href = '/'; });
if ($('mn-new')) $('mn-new').addEventListener('click', () => { $('new-chat-btn').click(); });
if ($('mn-art')) $('mn-art').addEventListener('click', () => { $('artifacts-toggle').click(); });
if ($('mn-menu')) $('mn-menu').addEventListener('click', () => { $('menu-btn').click(); });
if ($('sidebar-close')) $('sidebar-close').addEventListener('click', () => {
  const sb = $('sidebar'); if (sb) sb.classList.add('collapsed');
  const ov = $('sidebar-overlay'); if (ov) ov.classList.remove('show');
});
updateThemeUI();

// ---------- Init ----------
applyTheme(); // selalu gelap (mode terang dimatikan — Papi 19 Agu 2026)
checkAuth();

// ---------- Polling ADAPTIF + backoff (Paket C — Dinda 5 Sep 2026) ----------
// Sebelum: refreshArtifacts & refreshStatus dipanggil TETAP tiap 4 detik dan
// refreshSessions tiap 15 detik, walau layar idle & agent tidak bekerja.
// Sekarang: interval cepat (4 dtk / 15 dtk) hanya saat SSE terputus, agent
// sedang bekerja, atau baru ada aktivitas (<10 dtk). Saat idle & SSE sehat,
// interval naik otomatis (backoff): artifacts/status 20 dtk, sessions 30 dtk.
// Event SSE (agent_end/delta/changes/dll) tetap memicu refresh LANGSUNG,
// jadi polling di sini hanya pengaman/cadangan.
const POLL_FAST = 4000, POLL_IDLE = 20000, SESS_FAST = 15000, SESS_IDLE = 30000;
let lastPollActivity = Date.now();
function agentIsBusy() {
  try { const a = sessionsCache.find(s => s.active); return !!(a && a.busy); } catch (e) { return false; }
}
function sseIsAlive() { try { return !!(sseSource && sseSource.readyState === EventSource.OPEN); } catch (e) { return false; } }
function wantFastPoll() { return !sseIsAlive() || agentIsBusy() || (Date.now() - lastPollActivity < 10000); }
function notePollActivity() { lastPollActivity = Date.now(); }
function pollLoop(fn, getDelay) {
  setTimeout(async () => {
    if (authed) { try { await fn(); } catch (e) {} }
    pollLoop(fn, getDelay);
  }, getDelay());
}
pollLoop(refreshArtifacts, () => (wantFastPoll() ? POLL_FAST : POLL_IDLE));
pollLoop(refreshStatus,   () => (wantFastPoll() ? POLL_FAST : POLL_IDLE));
pollLoop(refreshSessions, () => (wantFastPoll() ? SESS_FAST : SESS_IDLE));
// Saat tab kembali terlihat: refresh langsung + kembali ke mode cepat sejenak
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && authed) {
    notePollActivity();
    refreshArtifacts().catch(() => {}); refreshStatus().catch(() => {}); refreshSessions().catch(() => {});
  }
});
window.addEventListener('focus', () => { if (authed) notePollActivity(); });

// ---------- Laporan (Markdown) ----------
$('report-download').addEventListener('click', async () => {
  try {
    const r = await fetch('/api/report');
    const d = await r.json();
    if (!r.ok || !d.markdown) { toast(d.error || 'Gagal buat laporan'); return; }
    const blob = new Blob([d.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = d.filename || 'laporan.md';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('Laporan diunduh ✅');
  } catch (e) { toast('Gagal: ' + e.message); }
});

// ---------- Command Palette (Ctrl+K) ----------
const cmdList = [
  { k: 'new', label: '✏️ Chat Baru', run: () => $('new-chat-btn').click() },
  { k: 'help', label: '❓ Bantuan & Panduan', run: openHelp },
  { k: 'settings', label: '⚙️ Pengaturan', run: () => { $('settings').classList.add('open'); switchTab('profile'); } },
  { k: 'status', label: '📊 Status Hub', run: () => { $('settings').classList.add('open'); switchTab('status'); } },
  { k: 'template', label: '📝 Template Prompt', run: () => { $('settings').classList.add('open'); switchTab('prompts'); } },
  { k: 'theme', label: '🎨 Ganti Tema (3 pilihan)', run: () => { $('settings').classList.add('open'); switchTab('theme'); } },
  { k: 'search', label: '🔍 Fokus Cari Sesi', run: () => { $('session-search').focus(); } },
  { k: 'artifacts', label: '📁 Buka Panel Artefak', run: () => $('artifacts').classList.add('open-mobile') },
  { k: 'model', label: '🧠 Ganti Model AI', run: () => { const s = $('model-select'); if (s) s.focus(); } },
  { k: 'upload', label: '📎 Upload File', run: () => $('upload-btn').click() },
  { k: 'image', label: '🎨 Buat Gambar AI', run: () => $('img-btn').click() },
  { k: 'diskusi', label: '💬 Mode Diskusi (on/off)', run: () => $('plan-toggle').click() },
  { k: 'subagents', label: '🧩 Peta Subagent', run: () => $('subagents-toggle').click() },
  { k: 'billing', label: '💳 Paket & Credit', run: () => { $('settings').classList.add('open'); switchTab('paket'); } },
  { k: 'memory', label: '🧠 Memory', run: () => { $('settings').classList.add('open'); switchTab('memory'); } },
];
function openCmd() { $('cmd-palette').style.display = ''; $('cmd-backdrop').style.display = ''; $('cmd-input').value=''; renderCmd(); setTimeout(() => $('cmd-input').focus(), 50); }
function closeCmd() { $('cmd-palette').style.display = 'none'; $('cmd-backdrop').style.display = 'none'; }
function renderCmd() {
  const q = $('cmd-input').value.toLowerCase();
  const box = $('cmd-list'); box.innerHTML = '';
  cmdList.filter(c => !q || c.label.toLowerCase().includes(q) || c.k.includes(q)).forEach(c => {
    const item = document.createElement('div');
    item.textContent = c.label;
    item.style.cssText = 'padding:10px 14px;border-radius:8px;cursor:pointer;font-size:14px;';
    item.addEventListener('mouseenter', () => item.style.background = 'var(--border,#2a2f3a)');
    item.addEventListener('mouseleave', () => item.style.background = '');
    item.addEventListener('click', () => { closeCmd(); c.run(); });
    box.appendChild(item);
  });
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (authed) openCmd(); }
  if (e.key === 'Escape') closeCmd();
});
$('cmd-input').addEventListener('input', renderCmd);
$('cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = $('cmd-list').firstChild; if (first) { closeCmd(); const c = cmdList.find(x => x.label === first.textContent); if (c) c.run(); } }
});
$('cmd-backdrop').addEventListener('click', closeCmd);

// ---------- Agent Tree Map (Subagents) ----------
let subagentsTimer = null;
$('subagents-toggle').addEventListener('click', () => {
  $('subagents-modal').style.display = ''; $('subagents-backdrop').style.display = '';
  loadSubagents();
  if (!subagentsTimer) subagentsTimer = setInterval(() => { if ($('subagents-modal').style.display !== 'none') loadSubagents(); }, 4000);
});
// F35 Ekspor sesi aktif (9 Sep 2026): server /api/export-session sudah ada (export_html),
// tambah tombol header ⬇️ → buka file HTML hasil ekspor di tab baru.
if ($('export-session-btn')) $('export-session-btn').addEventListener('click', async () => {
  const btn = $('export-session-btn'); const old = btn.textContent;
  // F35 (9 Sep 2026): pilih format — JSONL (portabel, bisa diimpor lagi) atau HTML (untuk dibaca).
  const portabel = confirm('Ekspor sesi aktif:\n\nOK  = file JSONL (portabel — bisa diimpor lagi di sini)\nBatal = file HTML (untuk dibaca/dicetak)');
  btn.textContent = '⏳'; btn.disabled = true;
  try {
    if (portabel) {
      const r = await fetch('/api/export-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'jsonl' }) });
      const d = await r.json();
      if (!r.ok || !d.data) { toast('Gagal ekspor: ' + (d.error || 'coba lagi')); return; }
      const blob = new Blob([d.data], { type: 'application/x-ndjson' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = d.name || 'sesi.jsonl';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('✅ Sesi diekspor (JSONL portabel)');
      return;
    }
    const r = await fetch('/api/export-session', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || !d.htmlFile) { toast('Gagal ekspor: ' + (d.error || 'coba lagi')); return; }
    toast('✅ Sesi diekspor — membuka file HTML…');
    // htmlFile adalah path absolut di server; buka via /api/artifact?path=... (raw)
    const rel = String(d.htmlFile).replace(/^\/workspace\//, '').split('/').slice(1).join('/');
    setTimeout(() => { try { const raw = '/api/artifact?path=' + encodeURIComponent(rel.split('/').pop()) + '&raw=1'; window.open(raw, '_blank'); } catch (e) { toast('Ekspor berhasil — cek panel artefak'); refreshArtifacts(); } }, 400);
    refreshArtifacts();
  } catch (e) { toast('Gagal ekspor: ' + e.message); }
  finally { btn.textContent = old; btn.disabled = false; }
});
// F35 Import sesi (9 Sep 2026): pilih file .jsonl riwayat → jadi sesi baru milik user ini.
if ($('import-session-btn')) $('import-session-btn').addEventListener('click', () => { const f = $('import-session-file'); if (f) f.click(); });
if ($('import-session-file')) $('import-session-file').addEventListener('change', async (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast('⚠️ File > 20MB, tidak didukung'); return; }
  const btn = $('import-session-btn'); const old = btn ? btn.textContent : '';
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const text = await file.text();
    const nm = (file.name || 'impor').replace(/\.(jsonl|json|txt)$/i, '').slice(0, 40) || 'impor';
    const r = await fetch('/api/import-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nm, data: text }) });
    const d = await r.json();
    if (!r.ok || !d.ok) { toast('Gagal impor: ' + (d.error || 'coba lagi')); return; }
    toast('✅ Sesi diimpor: ' + (d.messages || 0) + ' pesan');
    await refreshSessions();
    if (d.session && d.session.id) await switchSession(d.session.id);
  } catch (err) { toast('Gagal impor: ' + err.message); }
  finally { if (btn) { btn.textContent = old; btn.disabled = false; } }
});
// ===== F45 Inspector 3 tab (9 Sep 2026, PRD F45) =====
// Satu panel terpadu: Sesi (state/usage) · Agent (subagent RLM) · File (workspace).
// Semua data dari endpoint yang SUDAH ada — tidak ada endpoint baru, tidak ada klaim palsu.
let __inspTab = 'sesi';
function inspRow(label, value) {
  return '<div style="display:flex;gap:10px;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,.07);"><span style="color:var(--muted,#9aa3b5);min-width:140px;">' + label + '</span><span style="flex:1;word-break:break-word;">' + value + '</span></div>';
}
// F50 (9 Sep 2026): pasang listener pemilih profil bot di tab Agent
function bindAgentPick() {
  try {
    const sel = $('insp-agent-pick');
    if (!sel) return;
    sel.addEventListener('change', async () => {
      try {
        const rr = await fetch('/api/session-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: sel.value }) });
        const dd = await rr.json().catch(() => ({}));
        if (rr.ok && dd.ok) toast(sel.value ? '🤖 Profil bot aktif untuk sesi ini' : '↺ Kembali ke profil bawaan');
        else toast(dd.error || 'Gagal mengubah profil');
      } catch (e) { toast('Gagal: ' + e.message); }
    });
  } catch (e) {}
}
// F52 (9 Sep 2026): diskusi grup — kirim 1 pertanyaan ke beberapa profil bot sekaligus
function bindGroupChat() {
  try {
    const go = $('gc-go');
    if (!go) return;
    go.addEventListener('click', async () => {
      const picks = Array.from(document.querySelectorAll('.gc-pick:checked')).map((c) => c.value);
      const q = ($('gc-q') ? $('gc-q').value : '').trim();
      const out = $('gc-out');
      if (!picks.length) { toast('Pilih minimal 1 profil bot'); return; }
      if (!q) { toast('Pertanyaan masih kosong'); return; }
      const round = $('gc-round') && $('gc-round').checked;
      go.disabled = true; go.textContent = '⏳ Sedang berdiskusi…';
      if (out) out.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Menunggu jawaban ' + picks.length + ' profil bot (bisa 1-3 menit)…</div>';
      try {
        const r = await fetch('/api/group-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: q, agentIds: picks, mode: round ? 'round' : 'same' }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) { if (out) out.innerHTML = '<div style="color:#f87171;">' + escapeHtml(d.error || 'Gagal') + '</div>'; return; }
        if (out) out.innerHTML = (d.results || []).map((x) => '<div style="margin-bottom:10px;padding:8px;border-radius:9px;background:rgba(255,255,255,.04);"><b>🤖 ' + escapeHtml(x.name) + '</b><div style="margin-top:4px;white-space:pre-wrap;">' + escapeHtml(String(x.answer).slice(0, 1500)) + '</div></div>').join('');
      } catch (e) {
        if (out) out.innerHTML = '<div style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</div>';
      } finally { go.disabled = false; go.textContent = '▶️ Mulai diskusi'; }
    });
  } catch (e) {}
}
// F53 (9 Sep 2026): buka percakapan khusus bot — sesi baru yang langsung terikat profil bot
function bindAgentOpen() {
  try {
    const btn = $('insp-agent-open');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const sel = $('insp-agent-pick');
      const id = sel ? sel.value : '';
      if (!id) { toast('Pilih profil bot dulu di daftar di atas'); return; }
      const nm = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : 'Bot';
      btn.disabled = true; btn.textContent = '⏳ Membuka…';
      try {
        await createSession('🤖 ' + nm);
        const r = await fetch('/api/session-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: id }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) throw new Error(d.error || 'gagal set profil');
        toast('💬 Percakapan khusus "' + nm + '" dibuka');
        closeInspector();
      } catch (e) { toast('Gagal: ' + e.message); }
      finally { btn.disabled = false; btn.textContent = '💬 Buka percakapan khusus bot ini'; }
    });
  } catch (e) {}
}
async function inspLoad() {
  const body = $('inspector-body');
  if (!body) return;
  body.innerHTML = 'Memuat…';
  try {
    if (__inspTab === 'sesi') {
      const [sr, ur] = await Promise.all([fetch('/api/status').then((r) => r.json()).catch(() => null), fetch('/api/usage').then((r) => r.json()).catch(() => null)]);
      if (!sr || !sr.ok) { body.innerHTML = 'Gagal memuat status.'; return; }
      const u = (ur && ur.usage) || null;
      let h = '';
      h += inspRow('Sesi aktif', escapeHtml(sr.me.activeSession ? sr.me.activeSession.name + (sr.me.activeSession.busy ? ' · <b>sedang bekerja</b>' : ' · idle') : '—'));
      h += inspRow('Model', escapeHtml(sr.me.model || '—'));
      h += inspRow('Thinking', escapeHtml(String(sr.me.thinking != null ? sr.me.thinking : '—')));
      h += inspRow('Auto-compact', sr.me.autoCompact === true ? 'aktif' : (sr.me.autoCompact === false ? 'nonaktif' : '—'));
      h += inspRow('Sesi (aktif/total)', (sr.me.sessionsActive || 0) + ' / ' + (sr.me.sessionsTotal || 0) + ' (maks ' + (sr.me.sessionsLimit || '?') + ')');
      h += inspRow('Uptime hub', escapeHtml(sr.hub.uptimeHuman || '—'));
      h += inspRow('Memori hub', escapeHtml(sr.hub.memoryRss || '—'));
      h += inspRow('File workspace', String(sr.hub.workspaceFiles != null ? sr.hub.workspaceFiles : '—'));
      // Cadangan-9 (9 Sep 2026): status pemulihan konteks dari transkrip kanonik (best-effort).
      try {
        const rs = await fetch('/api/resume-status').then((r) => r.json()).catch(() => null);
        const rsv = rs && rs.resume;
        if (rsv && rsv.available) {
          const kb = Math.round((rsv.sizeBytes || 0) / 1024);
          h += inspRow('🔄 Pemulihan konteks', 'tersedia · ' + (rsv.messages || 0) + ' pesan (' + kb + ' KB)' + (rsv.mode === 'reseed' ? ' · <b>akan dibangun ulang</b>' : ' · sesi hidup'));
        } else {
          h += inspRow('🔄 Pemulihan konteks', '<span style="color:var(--muted,#9aa3b5);">belum ada transkrip (' + escapeHtml((rsv && rsv.reason) || '—') + ')</span>');
        }
      } catch (e) {}
      if (u) {
        h += inspRow('Token total', Number(u.tokens && u.tokens.total || 0).toLocaleString('id-ID'));
        h += inspRow('Biaya sesi', 'Rp' + Number(((u.cost || 0) * 18000)).toLocaleString('id-ID'));
        if (u.contextUsage && u.contextUsage.percent != null) h += inspRow('Konteks terpakai', u.contextUsage.percent + '%');
        if (u.toolCalls != null) h += inspRow('Tool calls', Number(u.toolCalls).toLocaleString('id-ID'));
      }
      // F29 Perf discipline (9 Sep 2026): tunjukkan BUDGET ASET nyata (ukuran yang benar-benar
      // diunduh browser + jumlah skrip eksternal) — supaya tidak ada pembengkakan diam-diam.
      try {
        const ents = (performance.getEntriesByType && performance.getEntriesByType('resource')) || [];
        let total = 0, n = 0;
        const per = {};
        ents.forEach((e) => {
          const nm = String(e.name || '');
          if (!/\.(js|css|html)(\?|$)/.test(nm)) return;
          const sz = e.transferSize || e.encodedBodySize || 0;
          total += sz; n++;
          const key = nm.split('/').pop().split('?')[0];
          per[key] = (per[key] || 0) + sz;
        });
        const top = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + ' ' + Math.round(v / 1024) + 'KB').join(' · ');
        h += inspRow('Aset (transfer)', n + ' file · ' + (Math.round(total / 1024)) + 'KB total' + (top ? '<div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-top:2px;">' + escapeHtml(top) + '</div>' : ''));
        const extCount = Array.from(document.querySelectorAll('script[src]')).filter((s) => /^https?:\/\//i.test(s.src)).length;
        h += inspRow('Skrip eksternal', String(extCount) + ' (CDN dimuat hanya saat dibutuhkan)');
      } catch (e) {}
      body.innerHTML = h;
      return;
    }
    if (__inspTab === 'agent') {
      // F50: pemilih PROFIL BOT untuk sesi aktif (ganti kapan saja)
      let agentPicker = '';
      try {
        const ar = await fetch('/api/session-agent');
        const ad = await ar.json().catch(() => ({}));
        if (ad && ad.ok) {
          const cur = ad.activeAgentId || '';
          const opts = '<option value="">(bawaan — semua profil digabung)</option>'
            + (ad.agents || []).map((a) => '<option value="' + escapeHtml(a.id) + '"' + (a.id === cur ? ' selected' : '') + '>' + escapeHtml(a.name) + '</option>').join('');
          agentPicker = '<div style="margin-bottom:10px;"><div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-bottom:4px;">Profil bot untuk sesi ini (berlaku pada pesan berikutnya)</div>'
            + '<select id="insp-agent-pick" style="width:100%;padding:8px 10px;border-radius:9px;border:1px solid var(--border,#2a2f3a);background:var(--bg,#14171f);color:var(--text,#e6e9ef);font-size:12.5px;">' + opts + '</select>'
            + '<button class="btn small" id="insp-agent-open" style="margin-top:6px;">💬 Buka percakapan khusus bot ini</button></div>';
        }
      } catch (e) {}
      // F52 Diskusi grup (9 Sep 2026): beberapa profil bot menjawab — biaya token = jumlah bot.
      let groupBox = '';
      try {
        const ar2 = await fetch('/api/session-agent');
        const ad2 = await ar2.json().catch(() => ({}));
        const list = (ad2 && ad2.agents) || [];
        if (list.length >= 1) {
          groupBox = '<details style="margin:10px 0 14px;"><summary style="cursor:pointer;font-size:12.5px;color:var(--muted,#9aa3b5);">👥 Diskusi grup (beberapa profil bot menjawab)</summary>'
            + '<div style="margin-top:8px;">'
            + list.map((a) => '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;padding:2px 0;"><input type="checkbox" class="gc-pick" value="' + escapeHtml(a.id) + '"> ' + escapeHtml(a.name) + '</label>').join('')
            + '<textarea id="gc-q" rows="2" placeholder="Pertanyaan untuk diskusi…" style="width:100%;margin-top:6px;padding:8px;border-radius:9px;border:1px solid var(--border,#2a2f3a);background:var(--bg,#14171f);color:var(--text,#e6e9ef);font-size:12.5px;"></textarea>'
            + '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted,#9aa3b5);margin:6px 0;"><input type="checkbox" id="gc-round"> Mode berantai (bot kedua melihat jawaban pertama)</label>'
            + '<button class="btn small" id="gc-go">▶️ Mulai diskusi</button>'
            + '<div id="gc-out" style="margin-top:10px;font-size:12.5px;"></div>'
            + '<div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-top:6px;">⚠️ Setiap bot memakai kuota token sendiri — pilih seperlunya.</div>'
            + '</div></details>';
        }
      } catch (e) {}
      const r = await fetch('/api/subagents');
      const d = await r.json().catch(() => ({}));
      const kids = d.children || d.subagents || d.agents || [];
      if (!kids.length) {
        body.innerHTML = agentPicker + groupBox + '<div style="color:var(--muted,#9aa3b5);">Belum ada subagent pada sesi ini. Subagent muncul otomatis kalau tugasnya besar (riset/audit) dan Dinda memecah pekerjaan.</div>';
        bindAgentPick();
        bindGroupChat();
        bindAgentOpen();
        return;
      }
      let h = agentPicker + groupBox + '<div style="color:var(--muted,#9aa3b5);margin-bottom:8px;">' + kids.length + ' subagent terdeteksi · klik untuk lihat pekerjaannya</div>';
      kids.forEach((c, i) => {
        const st = c.status || (c.done ? 'selesai' : 'bekerja');
        const cid = String(c.id || c.childId || '');
        h += '<div class="sub-item" data-cid="' + escapeHtml(cid) + '" data-i="' + i + '" style="border:1px solid var(--border,#2a2f3a);border-radius:9px;padding:8px 10px;margin-bottom:7px;">'
          + '<div style="font-weight:600;cursor:pointer;">🤖 ' + escapeHtml(String(c.name || c.id || 'subagent')) + ' <span style="color:var(--muted);font-weight:400;">· ' + escapeHtml(String(st)) + ' ▾</span></div>'
          + (c.task || c.goal || c.summary ? '<div style="color:var(--muted,#9aa3b5);font-size:12px;margin-top:3px;">' + escapeHtml(String(c.task || c.goal || c.summary)).slice(0, 300) + '</div>' : '')
          + '<div class="sub-body" style="display:none;margin-top:8px;"></div>'
          + '</div>';
      });
      body.innerHTML = h;
      body.querySelectorAll('.sub-item').forEach((box) => box.addEventListener('click', async (ev) => {
        const b = box.querySelector('.sub-body');
        if (!b) return;
        if (b.style.display !== 'none' && !ev.target.closest('.sub-reload')) { b.style.display = 'none'; return; }
        if (b.dataset.loaded === '1') { b.style.display = ''; return; }
        b.style.display = '';
        b.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Memuat pekerjaan subagent…</div>';
        try {
          const cid = box.dataset.cid || '';
          const rr = await fetch('/api/subagent?childId=' + encodeURIComponent(cid) + '&limit=40');
          const dd = await rr.json().catch(() => ({}));
          if (!dd.ok) { b.innerHTML = '<div style="color:var(--muted,#9aa3b5);">' + escapeHtml(dd.error || 'Tidak ada transcript tersimpan.') + '</div>'; return; }
          let hh = '<div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-bottom:5px;">' + (dd.count || 0) + ' pesan tersimpan' + (dd.spawnedAt ? ' · mulai ' + escapeHtml(String(dd.spawnedAt).slice(11, 19)) : '') + '</div>';
          (dd.messages || []).forEach((m) => {
            hh += '<div style="margin-bottom:6px;"><b style="font-size:11px;color:' + (m.role === 'user' ? '#93c5fd' : '#6ee7b7') + ';">' + (m.role === 'user' ? '🧑 instruksi' : '🤖 hasil') + '</b>'
              + '<div style="background:rgba(0,0,0,.22);border-radius:6px;padding:5px 7px;font-size:11.5px;white-space:pre-wrap;max-height:160px;overflow:auto;">' + escapeHtml(String(m.content).slice(0, 1200)) + '</div></div>';
          });
          b.innerHTML = hh; b.dataset.loaded = '1';
        } catch (e) { b.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Gagal memuat: ' + escapeHtml(e.message) + '</div>'; }
      }));
      bindAgentPick();
      bindGroupChat();
      bindAgentOpen();
      return;
    }
    if (__inspTab === 'memori') {
      // F41 Memori (9 Sep 2026): lihat/tambah/hapus memori user — data nyata dari /api/memory.
      const r = await fetch('/api/memory');
      const d = await r.json().catch(() => ({}));
      const items = d.items || [];
      let h = '<div style="display:flex;gap:6px;margin-bottom:10px;">'
        + '<input type="text" id="insp-mem-input" placeholder="Tambah memori (mis. nama klien, preferensi)" maxlength="500" style="flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--border,#2a2f3a);background:var(--bg,#14171f);color:var(--text,#e6e9ef);font-size:13px;">'
        + '<button class="btn small" id="insp-mem-add">➕</button></div>';
      if (!items.length) h += '<div style="color:var(--muted,#9aa3b5);">Belum ada memori tersimpan. Memori membuat Dinda mengingat hal penting lintas percakapan.</div>';
      items.slice(0, 100).forEach((it) => {
        h += '<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;border-bottom:1px dashed rgba(255,255,255,.07);">'
          + '<span style="flex:1;word-break:break-word;">🧠 ' + escapeHtml(String(it.text || '')) + '</span>'
          + '<button class="btn small insp-mem-del" data-id="' + escapeHtml(String(it.id || '')) + '" title="Hapus memori ini">🗑</button></div>';
      });
      body.innerHTML = h;
      const addBtn = $('insp-mem-add');
      if (addBtn) addBtn.addEventListener('click', async () => {
        const inp = $('insp-mem-input');
        const text = (inp && inp.value || '').trim();
        if (!text) { toast('Isi dulu teks memorinya'); return; }
        try {
          const rr = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
          if (rr.ok) { toast('🧠 Memori disimpan'); inspLoad(); } else { const dd = await rr.json().catch(() => ({})); toast(dd.error || 'Gagal simpan'); }
        } catch (e) { toast('Gagal simpan: ' + e.message); }
      });
      body.querySelectorAll('.insp-mem-del').forEach((b) => b.addEventListener('click', async () => {
        try {
          const rr = await fetch('/api/memory/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' });
          if (rr.ok) { toast('🗑 Memori dihapus'); inspLoad(); } else toast('Gagal hapus');
        } catch (e) { toast('Gagal hapus: ' + e.message); }
      }));
      return;
    }
    if (__inspTab === 'benchmark') {
      // Cadangan-5 (9 Sep 2026): regression test kualitas — skor otomatis, bukan opini.
      const r = await fetch('/api/benchmark');
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { body.innerHTML = escapeHtml(d.error || 'Gagal memuat'); return; }
      let h = '<div style="background:rgba(96,165,250,.08);border:1px solid rgba(96,165,250,.35);border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;margin-bottom:12px;">'
        + '🎯 <b>Uji kualitas terjadwal.</b> Skornya dihitung otomatis dari kriteria yang bisa dicek mesin (ada tabel? ada 3 poin? ada sumber? tanpa hype? jujur soal batas?). Ini <b>bukan</b> penilaian selera — jadi bisa dipakai membandingkan sebelum/sesudah upgrade.</div>';
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">'
        + (me && me.role === 'admin' ? '<button class="btn small" id="bench-run1">▶️ Jalankan 1 task (hemat)</button><button class="btn small" id="bench-run3">▶️ Jalankan 3 task</button>' : '<span style="color:var(--muted,#9aa3b5);font-size:12px;">Hanya admin yang bisa menjalankan uji.</span>')
        + '</div>';
      h += '<div style="font-weight:700;font-size:12.5px;margin:8px 0 4px;">📋 Daftar task (' + (d.tasks || []).length + ')</div>';
      (d.tasks || []).forEach((t) => { h += '<div style="font-size:12px;padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.06);"><b>' + escapeHtml(t.id) + '</b> · ' + escapeHtml(t.prompt) + '</div>'; });
      if ((d.runs || []).length) {
        h += '<div style="font-weight:700;font-size:12.5px;margin:12px 0 4px;">📈 Riwayat (terbaru di atas)</div>';
        d.runs.forEach((run) => {
          let tm = ''; try { const dt = new Date(run.ts); tm = String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); } catch (e) {}
          h += '<div style="font-size:12px;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,.06);">' + tm + ' · rata-rata <b>' + (run.avgPct || 0) + '%</b> · ' + (run.tasks || []).map((x) => x.id + ':' + x.pct + '%').join(' · ') + '</div>';
        });
      }
      h += '<div id="bench-out" style="margin-top:10px;font-size:12.5px;"></div>';
      if (d.note) h += '<div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-top:8px;">' + escapeHtml(d.note) + '</div>';
      body.innerHTML = h;
      const run = async (n) => {
        const out = $('bench-out');
        if (out) out.innerHTML = '⏳ Menjalankan ' + n + ' task… (tiap task bisa 10-60 detik)';
        try {
          const rr = await fetch('/api/benchmark/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskIds: (d.tasks || []).slice(0, n).map((t) => t.id) }) });
          const dd = await rr.json().catch(() => ({}));
          if (!rr.ok || !dd.ok) { if (out) out.innerHTML = '<span style="color:#f87171;">' + escapeHtml(dd.error || 'Gagal') + '</span>'; return; }
          if (out) out.innerHTML = '<div>Rata-rata: <b>' + dd.avgPct + '%</b></div>' + (dd.results || []).map((x) => '<div style="margin-top:6px;padding:6px 0;border-top:1px dashed rgba(255,255,255,.08);"><b>' + escapeHtml(x.id) + '</b> — ' + x.pct + '%<br>' + (x.notes || []).map((nt) => '<span style="color:var(--muted,#9aa3b5);font-size:11.5px;">' + escapeHtml(nt) + '</span>').join('<br>') + '</div>').join('');
        } catch (e) { if (out) out.innerHTML = '<span style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</span>'; }
      };
      if ($('bench-run1')) $('bench-run1').addEventListener('click', () => run(1));
      if ($('bench-run3')) $('bench-run3').addEventListener('click', () => run(3));
      return;
    }
    if (__inspTab === 'council') {
      // Cadangan-1 (9 Sep 2026): Dewan Juri 5 penilai — hanya jalan kalau diminta.
      let h = '<div style="background:rgba(168,85,247,.09);border:1px solid rgba(168,85,247,.35);border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;margin-bottom:12px;">'
        + '🏛️ <b>Dewan Juri</b> — untuk bahan PENTING (laporan yang mau dikirim, konten publik, keputusan besar). Lima penilai menilai dari sudut berbeda: Skeptic, Voice & Identity, Evidence & Calibration, Strategy & Stakes, lalu Adjudicator memutuskan <b>LULUS / LULUS DENGAN CATATAN / TAHAN</b>.<br><br>⚠️ Ini <b>tidak</b> jalan otomatis di setiap chat (biar chat cepat tetap ringan). Panggil hanya saat perlu — biaya token setara <b>5 pertanyaan</b>.</div>';
      h += '<textarea id="council-text" rows="5" placeholder="Tempel bahan yang mau dinilai (laporan, caption, keputusan)…" style="width:100%;padding:10px;border-radius:9px;border:1px solid var(--border,#2a2f3a);background:var(--bg,#14171f);color:var(--text,#e6e9ef);font-size:12.5px;"></textarea>'
        + '<div style="display:flex;gap:8px;margin-top:8px;"><button class="btn small" id="council-go">🏛️ Jalankan dewan juri</button>'
        + (me && me.role === 'admin' ? '<button class="btn small" id="council-skip">⏭️ Lewati (catat saja)</button>' : '') + '</div>'
        + '<div id="council-out" style="margin-top:10px;font-size:12.5px;"></div>';
      body.innerHTML = h;
      if ($('council-go')) $('council-go').addEventListener('click', async () => {
        const out = $('council-out');
        const t = ($('council-text') ? $('council-text').value : '').trim();
        if (!t) { toast('Isi bahan dulu'); return; }
        if (out) out.innerHTML = '⏳ 5 juri sedang menilai… (1-4 menit)';
        try {
          const rr = await fetch('/api/council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t }) });
          const dd = await rr.json().catch(() => ({}));
          if (!rr.ok || !dd.ok) { if (out) out.innerHTML = '<span style="color:#f87171;">' + escapeHtml(dd.error || 'Gagal') + '</span>'; return; }
          if (out) out.innerHTML = (dd.verdicts || []).map((v) => '<div style="margin-bottom:9px;padding:9px 11px;border-radius:10px;background:rgba(255,255,255,.04);"><b>⚖️ ' + escapeHtml(v.name) + '</b><div style="margin-top:4px;white-space:pre-wrap;">' + escapeHtml(v.answer) + '</div></div>').join('');
        } catch (e) { if (out) out.innerHTML = '<span style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</span>'; }
      });
      if ($('council-skip')) $('council-skip').addEventListener('click', async () => {
        try { await fetch('/api/council', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'dilewati', skip: true }) }); toast('⏭️ Dilewati & dicatat'); } catch (e) { toast('Gagal'); }
      });
      return;
    }
    if (__inspTab === 'shadow') {
      // Cadangan-8 Shadow-First Rollout (9 Sep 2026): amati dulu, aktifkan kemudian.
      const r = await fetch('/api/shadow');
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { body.innerHTML = escapeHtml(d.error || 'Gagal memuat'); return; }
      const inj = d.injection || {};
      const isShadow = d.mode === 'shadow';
      let h = '<div style="background:' + (isShadow ? 'rgba(96,165,250,.1);border:1px solid rgba(96,165,250,.4)' : 'rgba(34,197,94,.08);border:1px solid rgba(34,197,94,.35)') + ';border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;margin-bottom:12px;">'
        + (isShadow
          ? '🧪 <b>Mode UJI DIAM aktif.</b> Perubahan konteks (memori, profil bot, aturan tetap) <b>TIDAK dikirim</b> ke agent — hanya diukur. Jawaban agent berjalan normal tanpa tambahan itu.'
          : '✅ <b>Mode NORMAL aktif.</b> Memori, profil bot, dan aturan tetap benar-benar dibawa ke setiap percakapan.')
        + '</div>';
      h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">'
        + '<div style="flex:1;min-width:130px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:19px;font-weight:700;">' + (inj.count || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">pesan terukur</div></div>'
        + '<div style="flex:1;min-width:130px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:19px;font-weight:700;">' + (inj.avgChars || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">rata-rata karakter tambahan/chat</div></div>'
        + '<div style="flex:1;min-width:130px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:19px;font-weight:700;">≈' + (inj.avgTokensEst || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">estimasi token tambahan/chat</div></div>'
        + '</div>';
      if (d.note) h += '<div style="color:var(--muted,#9aa3b5);font-size:12px;line-height:1.6;margin-bottom:10px;">' + escapeHtml(d.note) + '</div>';
      if (me && me.role === 'admin') {
        h += '<div style="display:flex;gap:8px;margin-bottom:8px;">'
          + '<button class="btn small" id="shadow-on">🧪 Jalankan uji diam</button>'
          + '<button class="btn small" id="shadow-off">✅ Aktifkan normal</button></div>';
      } else {
        h += '<div style="color:var(--muted,#9aa3b5);font-size:12px;">Hanya admin yang bisa mengubah mode ini.</div>';
      }
      const samples = (d.last || []).filter((x) => x.kind === 'injection').slice(0, 8);
      if (samples.length) {
        h += '<div style="font-weight:700;font-size:12.5px;margin:10px 0 4px;">📋 Sampel terakhir</div>';
        samples.forEach((s) => {
          let tm = ''; try { const dt = new Date(s.ts); tm = String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); } catch (e) {}
          h += '<div style="font-size:12px;padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.06);color:var(--muted,#9aa3b5);">' + tm + ' · total ' + (s.chars || 0) + ' char (memori ' + (s.mem || 0) + ' · bot ' + (s.ag || 0) + ' · aturan ' + (s.ln || 0) + ')</div>';
        });
      }
      body.innerHTML = h;
      const btnOn = $('shadow-on'), btnOff = $('shadow-off');
      const setMode = async (mode) => {
        try {
          const rr = await fetch('/api/shadow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
          const dd = await rr.json().catch(() => ({}));
          if (!rr.ok || !dd.ok) { toast(dd.error || 'Gagal mengubah mode'); return; }
          toast(mode === 'shadow' ? '🧪 Mode uji diam aktif' : '✅ Mode normal aktif');
          inspLoad();
        } catch (e) { toast('Gagal: ' + e.message); }
      };
      if (btnOn) btnOn.addEventListener('click', () => setMode('shadow'));
      if (btnOff) btnOff.addEventListener('click', () => setMode('active'));
      return;
    }
    if (__inspTab === 'metrik') {
      // Cadangan-7 Metrik Jujur (9 Sep 2026): angka + peringatan cara angka itu bisa disalahgunakan.
      const r = await fetch('/api/honest-metrics');
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { body.innerHTML = escapeHtml(d.error || 'Gagal memuat metrik.'); return; }
      const q = d.quantity || {};
      let h = '<div style="background:rgba(255,193,7,.08);border:1px solid rgba(255,193,7,.35);border-radius:10px;padding:11px 13px;font-size:12.5px;line-height:1.6;margin-bottom:12px;">'
        + '⚠️ <b>Metrik ini sengaja "jujur"</b> — angkanya TIDAK bisa dijadikan bukti kualitas. Membuat lebih banyak percakapan atau pesan tidak berarti hasilnya lebih baik. Yang menentukan mutu adalah <b>pekerjaan yang benar-benar selesai</b>, dan itu dinilai oleh Papi — bukan oleh angka.</div>';
      h += '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px;">'
        + '<div style="flex:1;min-width:120px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:20px;font-weight:700;">' + (q.totalSesi || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">total percakapan (volume)</div></div>'
        + '<div style="flex:1;min-width:120px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:20px;font-weight:700;">' + (q.totalPesan || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">total pesan (volume)</div></div>'
        + '<div style="flex:1;min-width:120px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:20px;font-weight:700;">' + (q.sesiTerpakai || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">percakapan yang benar-benar dipakai</div></div>'
        + '<div style="flex:1;min-width:120px;background:rgba(255,255,255,.04);border-radius:10px;padding:10px 12px;"><div style="font-size:20px;font-weight:700;">' + (q.sesiAktif7h || 0) + '</div><div style="color:var(--muted,#9aa3b5);font-size:11.5px;">aktif 7 hari terakhir</div></div>'
        + '</div>';
      if (q.catatan) h += '<div style="color:var(--muted,#9aa3b5);font-size:12px;margin-bottom:10px;">' + escapeHtml(q.catatan) + '</div>';
      h += '<div style="font-weight:700;font-size:12.5px;margin-bottom:6px;">📌 Cara angka ini bisa menipu:</div>';
      (d.caveats || []).forEach((c) => { h += '<div style="font-size:12.5px;line-height:1.6;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,.07);">• ' + escapeHtml(c) + '</div>'; });
      body.innerHTML = h;
      return;
    }
    if (__inspTab === 'aktivitas') {
      // F30 Aktivitas akun sendiri (9 Sep 2026): jejak audit MILIK user ini (bukan milik orang lain).
      const r = await fetch('/api/my-audit?limit=80');
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { body.innerHTML = escapeHtml(d.error || 'Gagal memuat aktivitas.'); return; }
      const items = d.items || [];
      if (!items.length) { body.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Belum ada aktivitas tercatat untuk akun ini.</div>'; return; }
      const lbl = {
        login: '🔑 masuk', logout: '🚪 keluar', chat: '💬 kirim pesan', chat_duplicate_blocked: '🛡️ kiriman ganda dicegah',
        session_import: '⬆️ impor sesi', session_export: '⬇️ ekspor sesi', session_agent_set: '🤖 ganti profil bot',
        tools_policy_set: '🛡️ ubah kebijakan tool', memory_add: '🧠 tambah memori', memory_add_auto: '🧠 simpan memori',
        agent_create: '➕ buat profil bot', agent_delete: '🗑️ hapus profil bot', slash_used: '⚡ pakai pintasan',
        telegram_photo: '📷 kirim foto', model_test: '🧪 tes model', prompt_hijack_blocked: '🚫 upaya prompt jahat diblokir',
        image_edit: '🖼️ edit gambar', quota_exceeded: '⛔ kuota habis',
        learning_add: '📏 tambah aturan tetap', learning_disable: '⏸ nonaktifkan aturan',
        agents_export: '⬇️ ekspor profil bot', agents_import: '⬆️ impor profil bot', group_chat: '👥 diskusi grup',
        shadow_mode: '🧪 ubah mode uji diam', resume_seed: '🔄 pulihkan konteks dari transkrip',
        safety_block: '⚠️ aksi berbahaya diblokir (konfirmasi kurang)', security_selftest: '🧪 uji mandiri keamanan', credential_audit: '🔎 audit kebocoran kredensial',
        guardrails_set: '🧭 ubah guardrails kualitas',
        benchmark_run: '🎯 jalankan uji kualitas (benchmark)', council_run: '🏛️ jalankan dewan juri', council_skip: '⏭️ lewati dewan juri',
      };
      let h = '<div style="color:var(--muted,#9aa3b5);margin-bottom:8px;">📜 ' + (d.total || items.length) + ' aktivitas akun ini (terbaru di atas)</div>';
      items.forEach((ev) => {
        let tm = '';
        try { const dt = new Date(ev.ts); tm = String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); } catch (e) {}
        const name = lbl[String(ev.action)] || ('• ' + String(ev.action || ''));
        const sev = ev.severity === 'warn' ? 'color:#fbbf24;' : (ev.severity === 'error' ? 'color:#f87171;' : '');
        h += '<div style="display:flex;gap:8px;padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.06);font-size:12px;">'
          + '<span style="color:var(--muted,#9aa3b5);min-width:78px;">' + escapeHtml(tm) + '</span>'
          + '<span style="flex:1;' + sev + '">' + escapeHtml(name) + (ev.detail ? ' <span style="color:var(--muted,#9aa3b5);">· ' + escapeHtml(String(ev.detail).slice(0, 90)) + '</span>' : '') + '</span></div>';
      });
      body.innerHTML = h;
      return;
    }
    if (__inspTab === 'kebijakan') {
      // F43 Least privilege (9 Sep 2026): admin/user bisa membatasi tool agent (allowlist engine).
      const r = await fetch('/api/tools-policy');
      const d = await r.json().catch(() => ({}));
      if (!d.ok) { body.innerHTML = escapeHtml(d.error || 'Gagal memuat kebijakan.'); return; }
      const allowed = Array.isArray(d.allowed) ? d.allowed : [];
      const known = d.knownTools || [];
      let h = '<div style="color:var(--muted,#9aa3b5);font-size:12px;margin-bottom:10px;line-height:1.6;">'
        + '<b>🛡️ Batasi kemampuan Dinda.</b> Kalau dibiarkan kosong, semua tool aktif (perilaku normal). '
        + 'Kalau diisi, Dinda HANYA bisa memakai tool yang dipilih — pengaman tambahan untuk lingkungan ketat.</div>';
      h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">';
      known.forEach((t) => {
        const on = allowed.includes(t);
        h += '<button class="btn small pol-chip" data-tool="' + escapeHtml(t) + '" style="' + (on ? 'background:rgba(52,211,153,.18);border-color:rgba(52,211,153,.5);color:#6ee7b7;' : '') + '">' + (on ? '✅ ' : '') + escapeHtml(t) + '</button>';
      });
      h += '</div>';
      h += '<div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;">'
        + '<input type="text" id="pol-free" placeholder="tambah manual (dipisah koma)" style="flex:1;padding:9px 12px;border-radius:10px;border:1px solid var(--border,#2a2f3a);background:var(--bg,#14171f);color:var(--text,#e6e9ef);font-size:12.5px;">'
        + '<button class="btn small" id="pol-add">➕</button></div>';
      h += '<div style="display:flex;gap:8px;">'
        + '<button class="btn small" id="pol-save">💾 Simpan kebijakan</button>'
        + '<button class="btn small" id="pol-clear">↺ Kembalikan (semua tool)</button></div>';
      h += '<div id="pol-status" style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-top:8px;">'
        + (allowed.length ? 'Aktif dibatasi: ' + escapeHtml(allowed.join(', ')) : 'Saat ini: semua tool diizinkan')
        + '</div>';
      h += '<div style="color:var(--muted,#9aa3b5);font-size:11px;margin-top:8px;">ℹ️ ' + escapeHtml(d.note || '') + '</div>';
      body.innerHTML = h;
      let picked = allowed.slice();
      const paint = () => body.querySelectorAll('.pol-chip').forEach((c) => {
        const on = picked.includes(c.dataset.tool);
        c.textContent = (on ? '✅ ' : '') + c.dataset.tool;
        c.style.background = on ? 'rgba(52,211,153,.18)' : '';
        c.style.borderColor = on ? 'rgba(52,211,153,.5)' : '';
        c.style.color = on ? '#6ee7b7' : '';
      });
      body.querySelectorAll('.pol-chip').forEach((c) => c.addEventListener('click', () => {
        const t = c.dataset.tool;
        const i = picked.indexOf(t);
        if (i >= 0) picked.splice(i, 1); else picked.push(t);
        paint();
      }));
      const addBtn = $('pol-add');
      if (addBtn) addBtn.addEventListener('click', () => {
        const inp = $('pol-free');
        (inp && inp.value || '').split(',').map((x) => x.trim()).filter(Boolean).forEach((t) => { if (!picked.includes(t)) picked.push(t); });
        if (inp) inp.value = '';
        // tampilkan chip untuk tool manual yang belum ada
        const st = $('pol-status');
        if (st) st.textContent = 'Dipilih: ' + (picked.join(', ') || '(kosong)');
      });
      const saveBtn = $('pol-save');
      if (saveBtn) saveBtn.addEventListener('click', async () => {
        try {
          const rr = await fetch('/api/tools-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed: picked }) });
          const dd = await rr.json().catch(() => ({}));
          if (rr.ok && dd.ok) { toast('🛡️ Kebijakan disimpan'); inspLoad(); }
          else toast(dd.error || 'Gagal simpan');
        } catch (e) { toast('Gagal simpan: ' + e.message); }
      });
      const clearBtn = $('pol-clear');
      if (clearBtn) clearBtn.addEventListener('click', async () => {
        try {
          const rr = await fetch('/api/tools-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowed: [] }) });
          const dd = await rr.json().catch(() => ({}));
          if (rr.ok && dd.ok) { toast('↺ Semua tool diizinkan kembali'); inspLoad(); }
          else toast(dd.error || 'Gagal');
        } catch (e) { toast('Gagal: ' + e.message); }
      });
      // ---- Cadangan-6 & Cadangan-10 (9 Sep 2026): aksi berbahaya + isolasi kredensial ----
      try {
        const sr = await fetch('/api/safety');
        const sd = await sr.json().catch(() => ({}));
        if (sd && sd.ok) {
          let sh = '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border,#2a2f3a);">'
            + '<div style="font-weight:700;font-size:13px;margin-bottom:6px;">⚠️ Aksi Berbahaya (butuh kata konfirmasi)</div>'
            + '<div style="color:var(--muted,#9aa3b5);font-size:12px;line-height:1.6;margin-bottom:8px;">' + escapeHtml(sd.policy || '') + '</div>';
          (sd.actions || []).forEach((a) => {
            sh += '<div style="display:flex;gap:8px;font-size:12.5px;padding:5px 0;border-bottom:1px dashed rgba(255,255,255,.07);">'
              + '<span style="flex:1;">' + escapeHtml(a.desc) + '</span>'
              + '<span style="color:#fbbf24;font-family:monospace;">' + escapeHtml(a.word) + '</span></div>';
          });
          sh += '<div style="font-size:12.5px;margin-top:8px;">Percobaan tanpa konfirmasi yang tercatat di akun ini: <b style="color:' + ((sd.violations || 0) > 0 ? '#fbbf24' : '#6ee7b7') + ';">' + (sd.violations || 0) + '</b></div>';
          if ((sd.events || []).length) {
            sh += '<div style="margin-top:6px;">';
            sd.events.slice(0, 5).forEach((ev) => {
              let tm = ''; try { const dt = new Date(ev.ts); tm = String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + ' ' + String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0'); } catch (e) {}
              sh += '<div style="font-size:11.5px;color:var(--muted,#9aa3b5);">' + tm + ' · ' + escapeHtml(ev.action) + ' · ' + escapeHtml(ev.detail || '') + '</div>';
            });
            sh += '</div>';
          }
          sh += '</div>';
          if (me && me.role === 'admin') {
            sh += '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border,#2a2f3a);">'
              + '<div style="font-weight:700;font-size:13px;margin-bottom:6px;">🔐 Isolasi Kredensial</div>'
              + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">'
              + '<button class="btn small" id="sec-selftest">🧪 Uji mandiri keamanan</button>'
              + '<button class="btn small" id="sec-credaudit">🔎 Audit kebocoran kredensial</button></div>'
              + '<div id="sec-out" style="font-size:12.5px;"></div></div>';
          }
          body.insertAdjacentHTML('beforeend', sh);
          const stBtn = $('sec-selftest');
          if (stBtn) stBtn.addEventListener('click', async () => {
            const out = $('sec-out');
            if (out) out.innerHTML = '⏳ Menjalankan 4 pemeriksaan…';
            try {
              const rr = await fetch('/api/security/self-test');
              const dd = await rr.json().catch(() => ({}));
              if (!rr.ok || !dd.ok) { if (out) out.innerHTML = '<span style="color:#f87171;">' + escapeHtml(dd.error || 'Gagal') + '</span>'; return; }
              if (out) out.innerHTML = '<div style="margin-bottom:4px;">' + (dd.allPass ? '✅ <b>Semua pemeriksaan LULUS</b>' : '⚠️ <b>Ada pemeriksaan yang GAGAL</b>') + '</div>'
                + (dd.checks || []).map((c) => '<div style="padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.07);">' + (c.pass ? '✅' : '❌') + ' ' + escapeHtml(c.name) + ' <span style="color:var(--muted,#9aa3b5);">· ' + escapeHtml(String(c.detail || '')) + '</span></div>').join('');
            } catch (e) { if (out) out.innerHTML = '<span style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</span>'; }
          });
          const caBtn = $('sec-credaudit');
          if (caBtn) caBtn.addEventListener('click', async () => {
            const out = $('sec-out');
            if (out) out.innerHTML = '⏳ Memindai file…';
            try {
              const rr = await fetch('/api/security/credential-audit');
              const dd = await rr.json().catch(() => ({}));
              if (!rr.ok || !dd.ok) { if (out) out.innerHTML = '<span style="color:#f87171;">' + escapeHtml(dd.error || 'Gagal') + '</span>'; return; }
              const f = dd.findings || [];
              if (out) out.innerHTML = '<div style="margin-bottom:4px;">📄 ' + dd.scanned + ' file dipindai · <b>' + f.length + '</b> temuan</div>'
                + (f.length ? f.map((x) => '<div style="padding:4px 0;border-bottom:1px dashed rgba(255,255,255,.07);">⚠️ <b>' + escapeHtml(x.kind) + '</b> → <code style="font-size:11.5px;">' + escapeHtml(x.file) + '</code>' + (x.count ? ' <span style="color:var(--muted,#9aa3b5);">×' + x.count + '</span>' : '') + (x.mode ? ' <span style="color:var(--muted,#9aa3b5);">mode ' + escapeHtml(x.mode) + '</span>' : '') + '</div>').join('')
                  : '<div style="color:#6ee7b7;">Tidak ada pola kredensial ditemukan di file yang dipindai.</div>')
                + '<div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-top:6px;">' + escapeHtml(dd.policy || '') + '</div>';
            } catch (e) { if (out) out.innerHTML = '<span style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</span>'; }
          });
        }
      } catch (e) {}
      return;
    }
    if (__inspTab === 'monitor') {
      // F39 Live monitor (9 Sep 2026): aliran event real-time (ring buffer dari SSE) —
      // untuk melihat "apa yang sedang terjadi" tanpa membuka log server.
      const logs = __eventLog.slice().reverse();
      const cnt = {};
      __eventLog.forEach((e) => { cnt[e.type] = (cnt[e.type] || 0) + 1; });
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ×' + v).join(' · ');
      let h = '<div style="color:var(--muted,#9aa3b5);margin-bottom:8px;">📡 ' + __eventLog.length + ' event terakhir';
      if (top) h += '<div style="font-size:11.5px;margin-top:3px;">' + escapeHtml(top) + '</div>';
      h += '</div>';
      if (!logs.length) h += '<div style="color:var(--muted,#9aa3b5);">Belum ada event. Kirim pesan ke Dinda — aliran aktivitas akan muncul di sini secara live.</div>';
      logs.forEach((e) => {
        const d = new Date(e.t);
        const tm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
        const ico = e.type === 'tool_start' ? '🔧' : e.type === 'tool_end' ? '✅' : e.type === 'delta' ? '✍️' : e.type === 'changes' ? '📝' : e.type.indexOf('compact') === 0 ? '🧹' : e.type.indexOf('retry') === 0 ? '⚠️' : e.type === 'agent_start' ? '▶️' : e.type === 'agent_end' ? '⏹' : '•';
        h += '<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px dashed rgba(255,255,255,.06);font-size:11.5px;font-family:ui-monospace,Consolas,monospace;">'
          + '<span style="color:var(--muted,#9aa3b5);">' + tm + '</span><span>' + ico + '</span>'
          + '<span style="flex:1;">' + escapeHtml(e.type) + (e.tool ? ' · ' + escapeHtml(String(e.tool)) : '') + (e.n ? ' · ' + e.n : '') + '</span></div>';
      });
      body.innerHTML = h;
      return;
    }
    if (__inspTab === 'replay') {
      // F40 Replay (9 Sep 2026): timeline eksekusi nyata dari riwayat sesi (tool call + hasil).
      const r = await fetch('/api/replay?limit=200');
      const d = await r.json().catch(() => ({}));
      const items = d.items || [];
      if (!d.ok) { body.innerHTML = escapeHtml(d.error || 'Gagal memuat timeline.'); return; }
      if (!items.length) { body.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Belum ada aktivitas tool tercatat di sesi ini.</div>'; return; }
      const t0 = items[0] && items[0].ts ? new Date(items[0].ts).getTime() : 0;
      const fmtT = (ts) => { try { const dd = new Date(ts); return String(dd.getHours()).padStart(2, '0') + ':' + String(dd.getMinutes()).padStart(2, '0') + ':' + String(dd.getSeconds()).padStart(2, '0'); } catch (e) { return ''; } };
      const fmtMs = (ms) => (ms == null ? '' : (ms >= 1000 ? (ms / 1000).toFixed(1) + ' dtk' : ms + ' ms'));
      let h = '<div style="color:var(--muted,#9aa3b5);margin-bottom:8px;">' + (d.total || items.length) + ' langkah tool · putar ulang eksekusi sesi ini (klik langkah untuk lihat keluaran)</div>';
      items.slice().reverse().forEach((it, idx) => {
        const rel = (it.ts && t0) ? '+' + (((new Date(it.ts).getTime() - t0) / 1000).toFixed(1)) + 's' : '';
        const st = it.ok === true ? '✅' : (it.ok === false ? '❌' : '⏳');
        const id = 'rep-' + idx;
        h += '<div class="rep-item" data-rep="' + id + '" style="border:1px solid var(--border,#2a2f3a);border-radius:9px;padding:7px 9px;margin-bottom:6px;">'
          + '<div class="rep-head" style="display:flex;gap:8px;align-items:baseline;cursor:pointer;">'
          + '<span>' + st + '</span><span style="flex:1;font-weight:600;">' + escapeHtml(String(it.tool)) + '</span>'
          + '<span style="color:var(--muted,#9aa3b5);font-size:11px;">' + escapeHtml(fmtT(it.ts)) + (rel ? ' · ' + rel : '') + (it.ms != null ? ' · ' + fmtMs(it.ms) : '') + '</span>'
          + '</div>'
          + '<div id="' + id + '" style="display:none;margin-top:5px;">'
          + (it.argPreview ? '<div style="color:var(--muted,#9aa3b5);font-size:11.5px;margin-bottom:3px;">↳ perintah: <code>' + escapeHtml(String(it.argPreview).slice(0, 180)) + '</code></div>' : '')
          + (it.outPreview ? '<div style="background:rgba(0,0,0,.25);border-radius:6px;padding:5px 7px;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;max-height:120px;overflow:auto;">' + escapeHtml(String(it.outPreview).slice(0, 350)) + '</div>' : '')
          + '</div></div>';
      });
      body.innerHTML = h;
      body.querySelectorAll('.rep-head').forEach((hd) => hd.addEventListener('click', () => {
        const box = hd.parentElement && hd.parentElement.querySelector('div[id^="rep-"]');
        if (box) box.style.display = box.style.display === 'none' ? '' : 'none';
      }));
      return;
    }
    // tab file — F16 Workspace browser (9 Sep 2026): cari, urut terbaru, klik = buka file
    const r = await fetch('/api/artifacts');
    const d = await r.json().catch(() => ({}));
    const files = d.files || [];
    if (!files.length) { body.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Belum ada file di workspace.</div>'; return; }
    const norm = files.map((f) => (typeof f === 'string' ? { path: f, size: 0, mtime: 0 } : f)).filter((f) => f && f.path);
    const sorted = norm.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0)); // terbaru di atas
    let hf = '<input type="text" id="insp-file-search" placeholder="🔍 Cari file… (mis. laporan, .py)" style="width:100%;padding:9px 12px;border-radius:10px;border:1px solid var(--border,#2a2f3a);background:var(--bg,#14171f);color:var(--text,#e6e9ef);font-size:13px;margin-bottom:8px;">'
      + '<div id="insp-file-count" style="color:var(--muted,#9aa3b5);margin-bottom:6px;">' + sorted.length + ' file di workspace · diurutkan terbaru</div>'
      + '<div id="insp-file-list"></div>';
    body.innerHTML = hf;
    const drawList = (q) => {
      const list = document.getElementById('insp-file-list');
      if (!list) return;
      const ql = (q || '').toLowerCase();
      const f2 = ql ? sorted.filter((f) => String(f.path).toLowerCase().includes(ql)) : sorted;
      const cnt = document.getElementById('insp-file-count');
      if (cnt) cnt.textContent = f2.length + (ql ? ' hasil untuk "' + ql + '"' : ' file di workspace · diurutkan terbaru');
      let hh = '';
      f2.slice(0, 200).forEach((f) => {
        hh += '<div class="insp-file-row" data-path="' + escapeHtml(String(f.path)) + '" title="Klik untuk buka" style="display:flex;gap:8px;padding:5px 4px;border-bottom:1px dashed rgba(255,255,255,.07);font-family:ui-monospace,Consolas,monospace;font-size:12px;cursor:pointer;border-radius:6px;">'
          + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ' + escapeHtml(String(f.path)) + '</span>'
          + '<span style="color:var(--muted,#9aa3b5);">' + (f.size != null ? fmtSize(f.size) : '') + '</span></div>';
      });
      if (!f2.length) hh = '<div style="color:var(--muted,#9aa3b5);">Tidak ada file yang cocok.</div>';
      list.innerHTML = hh;
      list.querySelectorAll('.insp-file-row').forEach((row) => row.addEventListener('click', () => {
        try { openArtifact(row.dataset.path); } catch (e) { toast('Gagal membuka file'); }
      }));
    };
    drawList('');
    const fs2 = $('insp-file-search');
    if (fs2) fs2.addEventListener('input', (e) => drawList(e.target.value));
  } catch (e) { body.innerHTML = 'Gagal memuat: ' + escapeHtml(e.message); }
}
function openInspector(tab) {
  try {
    $('inspector-modal').style.display = '';
    $('inspector-backdrop').style.display = '';
    if (tab) __inspTab = tab;
    document.querySelectorAll('.insp-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === __inspTab));
    inspLoad();
  } catch (e) {}
}
function closeInspector() {
  try { $('inspector-modal').style.display = 'none'; $('inspector-backdrop').style.display = 'none'; } catch (e) {}
}
if ($('inspector-toggle')) $('inspector-toggle').addEventListener('click', () => openInspector());
if ($('inspector-close')) $('inspector-close').addEventListener('click', closeInspector);

// ================= F56 Panel Kedua (9 Sep 2026) =================
// Lihat percakapan LAIN berdampingan tanpa mengganggu sesi aktif (server = 1 sesi aktif per user,
// jadi panel ini baca-saja; tombol "Jadikan aktif" untuk berpindah).
function pane2Visible() { const p = $('pane2'); return !!p && p.style.display !== 'none'; }
function pane2Open() {
  const p = $('pane2');
  if (!p) return;
  p.style.display = 'flex';
  const sel = $('pane2-pick');
  if (sel) {
    const cur = ((sessionsCache.find((s) => s.active) || {}).id) || '';
    const opts = (sessionsCache || []).filter((s) => s.id !== cur)
      .map((s) => '<option value="' + escapeHtml(s.id) + '">' + escapeHtml(s.name) + (s.busy ? ' · ⏳' : '') + '</option>').join('');
    sel.innerHTML = '<option value="">— pilih percakapan —</option>' + opts;
    // auto-pilih percakapan terbaru yang bukan sesi aktif, supaya panel langsung berguna
    if (opts && !sel.dataset.picked) { sel.selectedIndex = 1; sel.dataset.picked = '1'; pane2Load(); }
  }
}
function pane2Close() { const p = $('pane2'); if (p) p.style.display = 'none'; }
async function pane2Load() {
  const sel = $('pane2-pick'), body = $('pane2-body');
  if (!sel || !body || !sel.value) return;
  body.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Memuat…</div>';
  try {
    const r = await fetch('/api/session-preview?id=' + encodeURIComponent(sel.value) + '&limit=20');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { body.innerHTML = '<div style="color:#f87171;">' + escapeHtml(d.error || 'Gagal memuat') + '</div>'; return; }
    if (!d.messages || !d.messages.length) { body.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Percakapan ini masih kosong.</div>'; return; }
    let h = '<div style="color:var(--muted,#9aa3b5);margin-bottom:8px;">' + (d.total || d.messages.length) + ' pesan · menampilkan ' + d.messages.length + ' terakhir</div>';
    d.messages.forEach((m) => {
      const isU = m.role === 'user';
      h += '<div style="margin-bottom:9px;padding:8px 10px;border-radius:9px;background:' + (isU ? 'rgba(90,140,255,.12)' : 'rgba(255,255,255,.04)') + ';">'
        + '<div style="font-size:11px;color:var(--muted,#9aa3b5);margin-bottom:3px;">' + (isU ? '🧑 Kamu' : '🤖 Agent') + '</div>'
        + '<div style="white-space:pre-wrap;word-break:break-word;">' + escapeHtml(String(m.content).slice(0, 700)) + '</div></div>';
    });
    body.innerHTML = h;
    body.scrollTop = body.scrollHeight;
  } catch (e) { body.innerHTML = '<div style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</div>'; }
}
if ($('pane2-toggle')) $('pane2-toggle').addEventListener('click', () => { pane2Visible() ? pane2Close() : pane2Open(); });
if ($('pane2-close')) $('pane2-close').addEventListener('click', pane2Close);
if ($('pane2-pick')) $('pane2-pick').addEventListener('change', pane2Load);
if ($('pane2-refresh')) $('pane2-refresh').addEventListener('click', pane2Load);
if ($('pane2-activate')) $('pane2-activate').addEventListener('click', async () => {
  const sel = $('pane2-pick');
  if (!sel || !sel.value) { toast('Pilih percakapan dulu'); return; }
  try {
    const r = await fetch('/api/sessions/' + sel.value + '/switch', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast(d.error || 'Gagal pindah sesi'); return; }
    toast('↪️ Percakapan dipindah jadi aktif');
    await refreshSessions();
    if (typeof loadSessionMessages === 'function') await loadSessionMessages(sel.value);
    pane2Close();
  } catch (e) { toast('Gagal: ' + e.message); }
});

// ================= CAD Papan Catatan (9 Sep 2026) =================
// Catatan kerja pribadi, tersimpan di perangkat (localStorage). Bisa dikirim ke kotak chat.
function notesLoad() {
  try { return JSON.parse(localStorage.getItem('coblai_notes') || '[]'); } catch (e) { return []; }
}
function notesSave(list) { try { localStorage.setItem('coblai_notes', JSON.stringify(list.slice(0, 200))); } catch (e) {} }
function notesRender() {
  const box = $('pane3-body');
  if (!box) return;
  const list = notesLoad();
  if (!list.length) { box.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Belum ada catatan. Tulis satu di bawah — tersimpan otomatis di perangkat ini.</div>'; return; }
  box.innerHTML = list.map((n, i) => '<div style="display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed rgba(255,255,255,.07);">'
    + '<input type="checkbox" data-note-done="' + i + '"' + (n.done ? ' checked' : '') + ' style="margin-top:3px;">'
    + '<div style="flex:1;font-size:12.5px;' + (n.done ? 'opacity:.55;text-decoration:line-through;' : '') + 'white-space:pre-wrap;word-break:break-word;">' + escapeHtml(n.text) + '</div>'
    + '<button class="btn small" data-note-send="' + i + '" title="Kirim ke kotak chat">↪️</button>'
    + '<button class="btn small" data-note-del="' + i + '" title="Hapus">×</button></div>').join('');
  box.querySelectorAll('[data-note-done]').forEach((el) => el.addEventListener('change', () => {
    const l = notesLoad(); const i = Number(el.dataset.noteDone); if (l[i]) { l[i].done = el.checked; notesSave(l); notesRender(); }
  }));
  box.querySelectorAll('[data-note-del]').forEach((el) => el.addEventListener('click', () => {
    const l = notesLoad(); l.splice(Number(el.dataset.noteDel), 1); notesSave(l); notesRender();
  }));
  box.querySelectorAll('[data-note-send]').forEach((el) => el.addEventListener('click', () => {
    const l = notesLoad(); const n = l[Number(el.dataset.noteSend)]; if (!n) return;
    const inp = $('input') || document.querySelector('textarea#input, textarea#prompt, #prompt-input, textarea');
    if (inp) { inp.value = (inp.value ? inp.value + '\n' : '') + n.text; inp.dispatchEvent(new Event('input', { bubbles: true })); toast('↪️ Catatan dimasukkan ke kotak chat'); }
    else toast('Kotak chat tidak ditemukan');
  }));
}
function pane3Open() { const p = $('pane3'); if (!p) return; p.style.display = 'flex'; notesRender(); }
function pane3Close() { const p = $('pane3'); if (p) p.style.display = 'none'; }
if ($('pane3-toggle')) $('pane3-toggle').addEventListener('click', () => { const p = $('pane3'); (p && p.style.display !== 'none') ? pane3Close() : pane3Open(); });
if ($('pane3-close')) $('pane3-close').addEventListener('click', pane3Close);
if ($('pane3-add')) $('pane3-add').addEventListener('click', () => {
  const t = $('pane3-input'); const v = t ? t.value.trim() : '';
  if (!v) { toast('Catatan masih kosong'); return; }
  const l = notesLoad(); l.unshift({ text: v, done: false, ts: Date.now() }); notesSave(l); t.value = ''; notesRender();
});
if ($('pane3-input')) $('pane3-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if ($('pane3-add')) $('pane3-add').click(); }
});
if ($('inspector-backdrop')) $('inspector-backdrop').addEventListener('click', closeInspector);
if ($('inspector-refresh')) $('inspector-refresh').addEventListener('click', () => inspLoad());
document.querySelectorAll('.insp-tab').forEach((b) => b.addEventListener('click', () => {
  __inspTab = b.dataset.tab;
  document.querySelectorAll('.insp-tab').forEach((x) => x.classList.toggle('on', x === b));
  inspLoad();
}));

function closeSubagents() {
  $('subagents-modal').style.display = 'none'; $('subagents-backdrop').style.display = 'none';
  if (subagentsTimer) { clearInterval(subagentsTimer); subagentsTimer = null; }
}
$('subagents-close').addEventListener('click', closeSubagents);
$('subagents-backdrop').addEventListener('click', closeSubagents);
async function loadSubagents() {
  try {
    const r = await fetch('/api/subagents');
    const d = await r.json();
    renderSubagents(d.children || []);
  } catch (e) { $('subagents-body').textContent = 'Gagal memuat: ' + e.message; }
}
function renderSubagents(children) {
  const body = $('subagents-body');
  if (!children.length) { body.innerHTML = '<div class="art-empty">Belum ada subagent aktif.<br>Minta Agent memakai agen pembantu (misal: "kerjakan riset ini pakai beberapa subagent paralel") — peta ini akan terisi otomatis.</div>'; return; }
  const stIco = { queued:'⏳', running:'🔄', done:'✅', error:'❌', cancelled:'⏹️' };
  const actIco = { waiting:'💤', writing:'✍️', executing:'🔧' };
  const byParent = {};
  children.forEach(c => { const k = c.parentId || 'root'; (byParent[k] = byParent[k] || []).push(c); });
  const now = Date.now();
  function ageOf(c) {
    // Hanya tampilkan durasi kalau field timestamp benar-benar ada (anti undefined).
    const base = c.startedAt || c.createdAt || c._updatedAt;
    if (!base) return '';
    const end = c.endedAt || c.finishedAt || now;
    const ms = Math.max(0, end - base);
    return ms >= 60000 ? Math.round(ms / 60000) + ' mnt' : ms >= 1000 ? (ms / 1000).toFixed(0) + ' dtk' : ms + ' ms';
  }
  function modelOf(c) {
    if (!c) return '';
    const m = c.model || c.modelId || (c.state && (c.state.model || c.state.modelId));
    if (!m) return '';
    return String(m.name || m.id || m).slice(0, 28);
  }
  let html = '';
  function walk(pid, depth) {
    (byParent[pid] || []).forEach(c => {
      const act = c.activity ? (actIco[c.activity.kind] || '') + (c.activity.toolName ? ' ' + c.activity.toolName : '') : '';
      const shortId = String(c.id).slice(0, 8);
      const model = modelOf(c);
      const age = ageOf(c);
      // F10 evidence (9 Sep 2026): durasi + model per child; bukti kerja bila engine kirim.
      const ev = c.evidence || c.output || c.result || c.summary;
      const evText = ev ? String(ev).replace(/\s+/g, ' ').slice(0, 140) : '';
      html += `<div style="padding:6px 0;padding-left:${depth * 18}px;border-left:${depth ? '1px solid var(--border,#2a2f3a)' : 'none'};margin-left:${depth ? '8px' : '0'};">
        <span title="${escapeHtml(c.id)}">${stIco[c.status] || '•'} <b>${shortId}</b></span>
        ${model ? `<span style="font-size:11px;color:var(--accent2,#6c8cff);background:rgba(108,140,255,.1);border-radius:10px;padding:0 6px;margin-left:4px;">${escapeHtml(model)}</span>` : ''}
        ${age ? `<span style="font-size:11px;color:var(--muted,#9aa4b2);margin-left:6px;">⏱ ${age}</span>` : ''}
        ${c.status === 'running' && act ? `<span style="color:var(--muted,#9aa4b2)"> · ${act}</span>` : ''}
        ${c.status === 'done' ? '<span style="color:var(--ok,#2ecc71)"> · selesai</span>' : c.status === 'error' ? '<span style="color:var(--danger,#ff3b30)"> · error</span>' : ''}
        ${evText ? `<div style="font-size:11px;color:var(--muted,#9aa4b2);margin:2px 0 0 2px;border-left:2px solid var(--border,#2a2f3a);padding-left:8px;">${escapeHtml(evText)}</div>` : ''}
      </div>`;
      walk(c.id, depth + 1);
    });
  }
  walk('root', 0);
  // node yang parentnya tidak ada → tampil sebagai root
  const known = new Set(children.map(c => c.id));
  children.filter(c => c.parentId && !known.has(c.parentId)).forEach(c => { if (!(byParent[c.parentId] || []).length) walk(c.id, 0); });
  const active = children.filter(c => c.status === 'running' || c.status === 'queued').length;
  body.innerHTML = `<div style="font-size:11px;color:var(--muted,#9aa4b2);margin-bottom:6px;">🧩 ${children.length} subagent · ${active} aktif · auto-refresh 4 dtk</div>` + (html || '<div class="art-empty">Belum ada subagent.</div>');
}

// ---------- Fix Keyboard Android (visualViewport fallback) — Aaron 13 Agu 2026 ----------
// Solusi utama: meta interactive-widget + CSS dvh. Ini backup untuk browser lama.
if (window.visualViewport && document.getElementById('app')) {
  const fixViewport = () => {
    const vv = window.visualViewport;
    const appEl = document.getElementById('app');
    if (vv && appEl) {
      // Atur tinggi app mengikuti viewport visual (termasuk saat keyboard muncul)
      appEl.style.height = vv.height + 'px';
    }
  };
  window.visualViewport.addEventListener('resize', fixViewport);
  window.visualViewport.addEventListener('scroll', fixViewport);
  fixViewport();
}

// ---------- Buat Gambar AI (Papi 16 Agu 2026 — fal.ai, kredit akurat) ----------
(function () {
  const imgBtn = $('img-btn');
  if (!imgBtn) return;
  imgBtn.addEventListener('click', async () => {
    const prompt = prompt('🎨 Deskripsi gambar (dipakai 300-4800 credit sesuai model):\n\nContoh: "Logo COBLAI, teknologi biru-ungu, minimalis"');
    if (!prompt || !prompt.trim()) return;
    const model = confirm('Pilih model:\nOK = Dev (kualitas bagus, 2400 credit)\nBatal = Schnell (cepat, 300 credit)') ? 'dev' : 'schnell';
    toast('🎨 Membuat gambar… (' + model + ')');
    try {
      const r = await fetch('/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), model }),
      });
      const d = await r.json();
      if (!r.ok) { toast('🎨 ' + (d.error || 'Gagal membuat gambar')); return; }
      toast('🎨 Gambar jadi! (' + model + ', ' + d.price + ' credit)');
      if (typeof refreshArtifacts === 'function') refreshArtifacts();
      // tampilkan gambar di chat sebagai pesan user+assistant
      addMessage('user', '🎨 Buat gambar: ' + prompt.trim());
      const img = document.createElement('img');
      img.src = d.url; img.style.cssText = 'max-width:100%;border-radius:12px;margin-top:8px;';
      const div = document.createElement('div'); div.className = 'msg assistant';
      div.innerHTML = '<div class="avatar" id="prime-avatar-msg">🤖</div>';
      const bubble = document.createElement('div'); bubble.className = 'bubble';
      bubble.appendChild(img); div.appendChild(bubble);
      messagesEl.appendChild(div); scrollChatBottom();
    } catch (e) { toast('🎨 Gagal: ' + e.message); }
  });
})();

// ---------- Ekspor jawaban (PDF/DOCX/XLSX/MD/Print) — Aaron 13 Agu 2026 ----------
async function exportAnswer(markdown, fmt) {
  try {
    if (fmt === 'print') {
      const w = window.open('', '_blank');
      if (w) {
        w.document.write(`<html><head><title>Jawaban</title><style>body{font-family:system-ui,sans-serif;padding:32px;max-width:800px;margin:auto;line-height:1.6}pre{background:#f5f5f5;padding:12px;border-radius:8px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}</style></head><body>${marked.parse(markdown)}</body></html>`);
        w.document.close(); w.focus(); setTimeout(() => w.print(), 500);
      }
      return;
    }
    if (fmt === 'notion') {
      const r = await fetch('/api/export/notion', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ markdown, title: 'Jawaban Agent — ' + new Date().toLocaleString('id-ID') }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Gagal kirim ke Notion');
      toast('📓 Terkirim ke Notion!');
      if (d.url) window.open(d.url, '_blank');
      return;
    }
    const r = await fetch('/api/export', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ markdown, format: fmt }) });
    if (!r.ok) { const d = await r.json().catch(()=>({})); throw new Error(d.error || 'Gagal ekspor'); }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^";]+)/);
    a.href = url; a.download = m ? m[1] : ('jawaban.' + fmt);
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    toast('⬇️ Berhasil diekspor (' + fmt.toUpperCase() + ')');
  } catch (e) { toast('Ekspor gagal: ' + e.message); }
}
function addShareBtn(actions, text) {
  // Tombol Share → dropdown Word, PDF, MD, Print, Notion (Papi 16 Agu 2026)
  const wrap = document.createElement('div');
  wrap.className = 'share-wrap';
  wrap.style.cssText = 'position:relative;display:inline-block;';
  const btn = document.createElement('button');
  btn.className = 'icon-btn'; btn.title = 'Share'; btn.textContent = '⬇️';
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (wrap.querySelector('.export-menu')) { wrap.querySelector('.export-menu').remove(); return; }
    const menu = document.createElement('div');
    menu.className = 'export-menu';
    menu.style.cssText = 'position:absolute;bottom:100%;left:0;background:var(--panel,#1a1e27);border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:6px;z-index:99;box-shadow:0 8px 24px rgba(0,0,0,.5);min-width:190px;';
    const fmts = [['docx','📘 Word (.docx)'],['pdf','📄 PDF'],['txt','📄 TXT (.txt)'],['md','📝 Markdown (.md)'],['print','🖨️ Print'],['notion','🗂️ Notion']];
    fmts.forEach(([f, label]) => {
      const mi = document.createElement('button');
      mi.style.cssText = 'display:block;width:100%;text-align:left;padding:8px 10px;border:none;background:none;color:var(--text,#e6e9ef);font-size:13px;cursor:pointer;border-radius:6px;';
      mi.textContent = label;
      mi.addEventListener('mouseenter', () => { mi.style.background = 'rgba(255,255,255,.06)'; });
      mi.addEventListener('mouseleave', () => { mi.style.background = 'none'; });
      mi.addEventListener('click', async () => {
        menu.remove();
        if (f === 'notion') { await sendToNotion(text); return; }
        exportAnswer(text, f);
      });
      menu.appendChild(mi);
    });
    wrap.appendChild(menu);
    const close = (e2) => { if (!wrap.contains(e2.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 10);
  });
  wrap.appendChild(btn);
  actions.appendChild(wrap);
}
// Notion — simpan jawaban penting ke Notion (Papi 16 Agu 2026)
async function sendToNotion(markdown) {
  try {
    const st = await (await fetch('/api/notion/status')).json();
    if (!st.hasToken) {
      toast('🗂️ Set dulu token Notion di Pengaturan → Notion');
      openSettingsTab('notion');
      return;
    }
    const title = 'COBLAI — ' + fmtMsgTime(Date.now());
    toast('🗂️ Menyimpan ke Notion…');
    const r = await fetch('/api/notion/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown, title }),
    });
    const d = await r.json();
    if (!r.ok) { toast('🗂️ ' + (d.error || 'Gagal simpan Notion')); return; }
    if (d.url) { safeCopy(d.url); toast('✅ Tersimpan di Notion! Link disalin'); }
    else toast('✅ Tersimpan di Notion');
  } catch (e) { toast('🗂️ Gagal: ' + e.message); }
}

// ---------- Notion settings (Papi 16 Agu 2026) ----------
function openSettingsTab(name) {
  const s = $('settings'); if (s) s.classList.add('open');
  switchTab(name);
}
async function loadNotionStatus() {
  try {
    const st = await (await fetch('/api/notion/status')).json();
    const el = $('notion-status');
    if (el) el.textContent = st.hasToken ? ('✅ Terhubung — token: ' + (st.masked || '')) : '❌ Belum diatur.';
  } catch (e) {}
}
$('notion-save').addEventListener('click', async () => {
  const token = $('notion-token').value.trim();
  const parent = $('notion-parent').value.trim();
  const err = $('notion-err'), ok = $('notion-ok');
  if (err) err.textContent = ''; if (ok) ok.textContent = '';
  if (!token) { if (err) err.textContent = 'Token wajib diisi.'; return; }
  try {
    const r = await fetch('/api/notion/token', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, parentPage: parent }),
    });
    const d = await r.json();
    if (!r.ok) { if (err) err.textContent = d.error || 'Gagal simpan'; return; }
    if (ok) ok.textContent = '✅ Token Notion tersimpan';
    $('notion-token').value = '';
    loadNotionStatus();
  } catch (e) { if (err) err.textContent = 'Gagal: ' + e.message; }
});

// ---------- Memory per-user (Papi 16 Agu 2026) ----------
async function loadMemoryList() {
  const box = $('memory-list'); if (!box) return;
  try {
    const r = await fetch('/api/memory');
    if (!r.ok) { box.innerHTML = '<div style="color:var(--muted);font-size:13px;">Gagal memuat memory.</div>'; return; }
    const d = await r.json();
    const items = d.items || [];
    if (!items.length) { box.innerHTML = '<div style="color:var(--muted);font-size:13px;">Belum ada ingatan. Tambahkan di atas, atau bilang ke agent: "ingat ya, saya..."</div>'; return; }
    box.innerHTML = '';
    items.forEach(it => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;';
      row.innerHTML = `<span style="font-size:15px;">🧠</span><span style="flex:1;font-size:12.5px;word-break:break-word;">${escapeHtml(it.text)}</span><button class="btn small" data-del="${it.id}" style="flex-shrink:0;">🗑️</button>`;
      row.querySelector('[data-del]').addEventListener('click', async () => {
        await fetch('/api/memory/' + it.id, { method: 'DELETE' });
        loadMemoryList();
      });
      box.appendChild(row);
    });
  } catch (e) { box.innerHTML = '<div style="color:var(--muted);font-size:13px;">Error: ' + escapeHtml(e.message) + '</div>'; }
}
if ($('memory-save')) $('memory-save').addEventListener('click', async () => {
  const text = $('memory-input').value.trim();
  if (!text) { const er = $('memory-err'); if (er) er.textContent = 'Isi dulu ingatannya.'; return; }
  const r = await fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const d = await r.json();
  if (!r.ok) { const er = $('memory-err'); if (er) er.textContent = d.error || 'Gagal simpan'; return; }
  $('memory-input').value = '';
  const ok = $('memory-ok'); if (ok) ok.textContent = '✅ Tersimpan. Agent akan ingat ini di sesi-sesi berikutnya.';
  loadMemoryList();
});

// ---------- Playground / Tokenizer (Papi 16 Agu 2026 — #27, ramah awam) ----------
function updatePlayground() {
  const t = $('pg-text').value || '';
  // Estimasi token: ±1 token per 4 karakter (approksimasi konservatif untuk Bahasa Indonesia)
  const tokens = Math.max(0, Math.ceil(t.length / 4));
  $('pg-tokens').textContent = tokens.toLocaleString('id-ID');
  // Cost estimasi: DeepSeek ±$0.27/1M token input → Rp ≈ kurs global
  const costUSD = (tokens / 1000000) * 0.27;
  const costRp = Math.round(costUSD * USD_RATE);
  $('pg-cost').textContent = 'Rp' + costRp.toLocaleString('id-ID');
  // Jatah harian (bila user premium/free quota 50k)
  const quota = (me && me.quota && me.quota.dailyTokens) || 50000;
  const pct = Math.min(100, Math.round((tokens / quota) * 100));
  $('pg-jatah').textContent = pct + '%';
}
if ($('pg-text')) $('pg-text').addEventListener('input', updatePlayground);
if ($('pg-text')) $('pg-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const v = $('pg-text').value; $('message').value = v; $('settings').classList.remove('open'); $('message').focus(); toast('Dikirim ke chat — coba kirim ya!'); } });

// ---------- Model Test Center & Health Check ----------
function renderHealthResult(data) {
  const list = $('health-list');
  if (!list) return;
  const entries = Object.entries(data.checks || {});
  list.innerHTML = entries.map(([name, check]) => `<div style="display:flex;gap:10px;align-items:center;padding:9px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:7px;"><span style="font-size:16px;">${check.ok ? '✅' : '❌'}</span><b style="min-width:120px;">${escapeHtml(name)}</b><span style="color:var(--muted);font-size:13px;">${escapeHtml(check.detail || '')}</span></div>`).join('');
  $('health-summary').textContent = data.ok ? '✅ Semua pemeriksaan lulus' : '⚠️ Ada komponen yang perlu diperiksa';
  $('health-summary').style.color = data.ok ? 'var(--success,#30d158)' : 'var(--gold,#f0c040)';
  $('health-time').textContent = data.checkedAt ? 'Diperiksa: ' + new Date(data.checkedAt).toLocaleString('id-ID') : '';
}
async function runHealthCheck() {
  const err = $('health-err'); if (err) err.textContent = '';
  const btn = $('health-run'); if (btn) { btn.disabled = true; btn.textContent = '⏳ Memeriksa...'; }
  try {
    const r = await fetch('/api/healthcheck');
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { if (err) err.textContent = d.error || 'Health check gagal'; return; }
    renderHealthResult(d);
  } catch (e) { if (err) err.textContent = 'Health check gagal: ' + e.message; }
  finally { if (btn) { btn.disabled = false; btn.textContent = '🔍 Jalankan Health Check'; } }
}
if ($('health-run')) $('health-run').addEventListener('click', runHealthCheck);
if ($('modeltest-run')) $('modeltest-run').addEventListener('click', async () => {
  const btn = $('modeltest-run'), err = $('modeltest-err'), result = $('modeltest-result');
  err.textContent = ''; result.style.display = 'none'; btn.disabled = true; btn.textContent = '⏳ Mengetes model...';
  try {
    const r = await fetch('/api/model-test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt: $('modeltest-prompt').value.trim() }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = d.error || 'Model test gagal'; return; }
    result.innerHTML = `<b>✅ Request berhasil</b><br><span style="font-size:12px;color:var(--muted);">Model: ${escapeHtml(d.model.provider + '/' + d.model.id)} · Latency: ${escapeHtml(String(d.latencyMs))} ms</span><div style="margin-top:10px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(d.response || '(respons kosong)')}</div>`;
    result.style.display = '';
  } catch (e) { err.textContent = 'Model test gagal: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = '🚀 Jalankan Test'; }
});

async function loadSystemControl() {
  const status = $('system-status'), err = $('system-err');
  if (!status || !err) return;
  err.textContent = '';
  status.textContent = '⏳ Memuat status system...';
  try {
    const severity = $('system-error-severity') ? $('system-error-severity').value : '';
    const q = $('system-error-query') ? $('system-error-query').value.trim() : '';
    const qs = new URLSearchParams(); if (severity) qs.set('severity', severity); if (q) qs.set('q', q);
    const [hr, er] = await Promise.all([fetch('/api/healthcheck'), fetch('/api/admin/errors?' + qs.toString())]);
    const health = await hr.json().catch(() => ({}));
    const audit = await er.json().catch(() => ({}));
    if (!hr.ok || !er.ok) { err.textContent = health.error || audit.error || 'Gagal memuat System Control'; return; }
    const checks = Object.values(health.checks || {});
    status.textContent = (health.ok ? '✅ System sehat' : '⚠️ System perlu diperiksa') + ' · ' + checks.filter(c => c.ok).length + '/' + checks.length + ' pemeriksaan lulus';
    const box = $('system-errors');
    const errors = audit.errors || [];
    box.innerHTML = errors.length ? errors.slice(0, 20).map(e => `<div style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-top:7px;font-size:12px;"><b>${escapeHtml(e.severity === 'error' ? '❌' : '⚠️')} ${escapeHtml(e.action || 'error')}</b> <span style="color:var(--muted);">${escapeHtml(e.ts || '')} · ${escapeHtml(e.requestId || '')}</span><br><span style="color:var(--muted);">${escapeHtml(String(e.detail || '').slice(0, 300))}</span></div>`).join('') : '<div style="padding:10px 0;color:var(--muted);font-size:13px;">✅ Belum ada error tercatat.</div>';
  } catch (e) { err.textContent = 'Gagal memuat System Control: ' + e.message; }
}
if ($('system-errors-refresh')) $('system-errors-refresh').addEventListener('click', loadSystemControl);
if ($('system-error-severity')) $('system-error-severity').addEventListener('change', loadSystemControl);
if ($('system-error-query')) $('system-error-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadSystemControl(); });
if ($('system-errors-export')) $('system-errors-export').addEventListener('click', () => {
  const qs = new URLSearchParams();
  const severity = $('system-error-severity') && $('system-error-severity').value; const q = $('system-error-query') && $('system-error-query').value.trim();
  if (severity) qs.set('severity', severity); if (q) qs.set('q', q);
  window.open('/api/admin/errors/export?' + qs.toString(), '_blank');
});
setInterval(() => { const panel = $('panel-system'); if (panel && panel.style.display !== 'none') loadSystemControl(); }, 30000);
if ($('system-agent-restart')) $('system-agent-restart').addEventListener('click', async () => {
  const btn = $('system-agent-restart'), err = $('system-err');
  if (!confirm('Restart proses Prime Agent sekarang? Container, session, dan workspace tetap hidup.')) return;
  btn.disabled = true; btn.textContent = '⏳ Restart Agent...'; err.textContent = '';
  try {
    const r = await fetch('/api/agent-restart', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = d.error || 'Gagal restart Prime Agent'; return; }
    toast('Prime Agent berhasil direstart ✅');
    await loadSystemControl();
  } catch (e) { err.textContent = 'Gagal restart Prime Agent: ' + e.message; }
  finally { btn.disabled = false; btn.textContent = '🔄 Restart Agent'; }
});
if ($('system-container-restart')) $('system-container-restart').addEventListener('click', async () => {
  const btn = $('system-container-restart'), err = $('system-err');
  if (!confirm('Restart CONTAINER sekarang? Semua user akan terputus sementara, lalu Docker menghidupkan aplikasi kembali otomatis.')) return;
  btn.disabled = true; btn.textContent = '⏳ Restart Container...'; err.textContent = '';
  try {
    const r = await fetch('/api/restart', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { err.textContent = d.error || 'Gagal restart container'; btn.disabled = false; btn.textContent = '🔄 Restart Container'; return; }
    $('system-status').textContent = '⏳ Container sedang restart... halaman akan dimuat ulang.';
    setTimeout(() => location.reload(), 8000);
  } catch (e) {
    $('system-status').textContent = '⏳ Restart dipicu... halaman akan dimuat ulang.';
    setTimeout(() => location.reload(), 5000);
  }
});

// ---------- Custom Agents (Papi 16 Agu 2026 — #8) ----------
async function loadAgentsList() {
  const box = $('agents-list'); if (!box) return;
  try {
    const r = await fetch('/api/agents'); const d = await r.json();
    const agents = d.agents || [];
    if (!agents.length) { box.innerHTML = '<div class="art-empty">Belum ada agent. Buat di bawah ini 👇</div>'; return; }
    box.innerHTML = '';
    agents.forEach(a => {
      const item = document.createElement('div');
      item.style.cssText = 'padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;';
      item.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
        <span style="font-weight:700;flex:1;font-size:14px;">🤖 ${escapeHtml(a.name)} ${a.enabled === false ? '<span style="font-size:11px;color:var(--muted)">(mati)</span>' : ''}</span>
        <button class="btn small ag-toggle">${a.enabled === false ? '▶️ Aktifkan' : '⏸️ Matikan'}</button>
        <button class="btn small ag-edit">✏️</button>
        <button class="btn small ag-del">🗑️</button>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:6px;">${escapeHtml((a.persona || '').slice(0, 120))}${(a.persona||'').length>120?'…':''}</div>`;
      item.querySelector('.ag-toggle').addEventListener('click', async () => {
        const r = await fetch('/api/agents/' + a.id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ enabled: a.enabled === false }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Gagal mengubah status agent'); return; }
        await loadAgentsList();
        toast(a.enabled === false ? 'Agent diaktifkan ✅' : 'Agent dimatikan (hemat token)');
      });
      item.querySelector('.ag-edit').addEventListener('click', () => {
        $('ag-name').value = a.name; $('ag-persona').value = a.persona || ''; $('ag-knowledge').value = a.knowledge || '';
        $('ag-save').dataset.editId = a.id; $('ag-save').textContent = '💾 Update Agent';
        toast('Edit ' + a.name + ' — ubah lalu klik Update');
      });
      item.querySelector('.ag-del').addEventListener('click', async () => {
        const ans = prompt('Hapus profil bot "' + a.name + '"?\n\nKetik HAPUS untuk melanjutkan:');
        if (ans === null) return;
        if (String(ans).trim().toUpperCase() !== 'HAPUS') { toast('Dibatalkan'); return; }
        const r = await fetch('/api/agents/' + a.id, { method:'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'HAPUS' }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) { toast(d.error || 'Gagal menghapus agent'); return; }
        await loadAgentsList();
        toast('Profil bot dihapus ✅');
      });
      box.appendChild(item);
    });
  } catch (e) {}
}
if ($('ag-save')) $('ag-save').addEventListener('click', async () => {
  const ok = $('ag-ok'), err = $('ag-err'); ok.textContent=''; err.textContent='';
  const editId = $('ag-save').dataset.editId || null;
  const payload = { name: $('ag-name').value.trim(), persona: $('ag-persona').value.trim(), knowledge: $('ag-knowledge').value.trim() };
  if (!payload.name) { err.textContent = 'Nama wajib diisi.'; return; }
  if (!payload.persona && !payload.knowledge) { err.textContent = 'Isi persona ATAU pengetahuan (minimal satu).'; return; }
  try {
    const r = editId ? await fetch('/api/agents/' + editId, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) })
                     : await fetch('/api/agents', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal'; return; }
    ok.textContent = editId ? '✅ Agent diperbarui.' : '✅ Agent dibuat! Persona & pengetahuannya aktif di chat.';
    $('ag-name').value=''; $('ag-persona').value=''; $('ag-knowledge').value=''; delete $('ag-save').dataset.editId; $('ag-save').textContent = '💾 Simpan Agent';
    loadAgentsList();
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});

// ================= Cadangan-3 Aturan Tetap (9 Sep 2026) =================
async function loadLearningsList() {
  const box = $('ln-list');
  if (!box) return;
  box.innerHTML = 'memuat…';
  try {
    const r = await fetch('/api/learnings');
    const d = await r.json().catch(() => ({}));
    if (!d.ok) { box.innerHTML = '<div style="color:#f87171;">' + escapeHtml(d.error || 'Gagal memuat') + '</div>'; return; }
    if (!d.items || !d.items.length) { box.innerHTML = '<div style="color:var(--muted,#9aa3b5);">Belum ada aturan tetap. Tambahkan satu di atas.</div>'; return; }
    box.innerHTML = '<div style="color:var(--muted,#9aa3b5);font-size:12px;margin-bottom:4px;">' + d.total + ' aturan · ' + d.active + ' aktif</div>'
      + d.items.slice().reverse().map((x) => {
        let tgl = '';
        try { const dt = new Date(x.createdAt); tgl = String(dt.getDate()).padStart(2, '0') + '/' + String(dt.getMonth() + 1).padStart(2, '0') + '/' + dt.getFullYear(); } catch (e) {}
        return '<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 11px;border:1px solid var(--border,#2a2f3a);border-radius:10px;' + (x.disabled ? 'opacity:.5;' : '') + '">'
          + '<div style="flex:1;font-size:13px;"><div style="' + (x.disabled ? 'text-decoration:line-through;' : '') + 'white-space:pre-wrap;word-break:break-word;">' + escapeHtml(x.text) + '</div>'
          + '<div style="color:var(--muted,#9aa3b5);font-size:11px;margin-top:3px;">' + (x.disabled ? '⏸ nonaktif' : '✅ aktif') + (tgl ? ' · ' + tgl : '') + (x.source ? ' · ' + escapeHtml(x.source) : '') + '</div></div>'
          + (x.disabled ? '' : '<button class="btn small" data-ln-off="' + escapeHtml(x.id) + '" title="Nonaktifkan (tetap tercatat)">⏸</button>')
          + '</div>';
      }).join('');
    box.querySelectorAll('[data-ln-off]').forEach((el) => el.addEventListener('click', async () => {
      try {
        const rr = await fetch('/api/learnings/' + el.dataset.lnOff, { method: 'DELETE' });
        if (rr.ok) { toast('⏸ Aturan dinonaktifkan (jejak tetap tersimpan)'); loadLearningsList(); }
        else toast('Gagal menonaktifkan');
      } catch (e) { toast('Gagal: ' + e.message); }
    }));
  } catch (e) { box.innerHTML = '<div style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</div>'; }
}
if ($('ln-save')) $('ln-save').addEventListener('click', async () => {
  const ok = $('ln-ok'), err = $('ln-err'); ok.textContent = ''; err.textContent = '';
  const t = ($('ln-input') ? $('ln-input').value : '').trim();
  if (!t) { err.textContent = 'Tulis aturannya dulu.'; return; }
  try {
    const r = await fetch('/api/learnings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t, source: 'koreksi user' }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { err.textContent = d.error || 'Gagal menyimpan'; return; }
    ok.textContent = '✅ Aturan disimpan — dibawa ke percakapan berikutnya.';
    $('ln-input').value = '';
    loadLearningsList();
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});

// ================= Cadangan-4 Template skill baku (9 Sep 2026) =================
if ($('skill-spec-btn')) $('skill-spec-btn').addEventListener('click', async () => {
  const box = $('skill-spec-box');
  const ta = $('skill-spec-text');
  if (box && box.style.display !== 'none') { box.style.display = 'none'; return; }
  if (box) box.style.display = 'block';
  if (ta && !ta.value) {
    ta.value = 'memuat…';
    try {
      const r = await fetch('/api/skill-spec');
      const d = await r.json().catch(() => ({}));
      ta.value = (d && d.template) || 'Gagal memuat template.';
    } catch (e) { ta.value = 'Gagal: ' + e.message; }
  }
});
if ($('skill-spec-copy')) $('skill-spec-copy').addEventListener('click', async () => {
  const ta = $('skill-spec-text');
  if (!ta) return;
  try { await navigator.clipboard.writeText(ta.value); toast('⧉ Template disalin'); }
  catch (e) { ta.select(); toast('Tekan Ctrl+C untuk menyalin'); }
});

// ================= Cadangan-2 Guardrails (9 Sep 2026) =================
async function loadGuardrails() {
  const box = $('guard-list');
  if (!box) return;
  box.innerHTML = 'memuat…';
  try {
    const r = await fetch('/api/guardrails');
    const d = await r.json().catch(() => ({}));
    if (!d.ok) { box.innerHTML = '<div style="color:#f87171;">' + escapeHtml(d.error || 'Gagal memuat') + '</div>'; return; }
    const g = d.guardrails || {};
    const info = d.info || {};
    const label = { contextGate: '🧠 Context Gate (berhenti & tanya kalau konteks kurang)', voiceCheck: '🗣️ Voice Check (jelas, tanpa hype)', qualityBar: '📐 Quality Bar (sertakan "Quality Check")' };
    box.innerHTML = ['contextGate', 'voiceCheck', 'qualityBar'].map((k) => '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border,#2a2f3a);border-radius:10px;cursor:pointer;">'
      + '<input type="checkbox" data-guard="' + k + '"' + (g[k] ? ' checked' : '') + ' style="margin-top:3px;">'
      + '<span><b style="font-size:13px;">' + escapeHtml(label[k] || k) + '</b><br><span style="color:var(--muted,#9aa3b5);font-size:12px;">' + escapeHtml(info[k] || '') + '</span></span></label>').join('');
  } catch (e) { box.innerHTML = '<div style="color:#f87171;">Gagal: ' + escapeHtml(e.message) + '</div>'; }
}
if ($('guard-save')) $('guard-save').addEventListener('click', async () => {
  const ok = $('guard-ok'), err = $('guard-err'); ok.textContent = ''; err.textContent = '';
  const payload = {};
  document.querySelectorAll('[data-guard]').forEach((c) => { payload[c.dataset.guard] = c.checked; });
  try {
    const r = await fetch('/api/guardrails', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) { err.textContent = d.error || 'Gagal menyimpan'; return; }
    ok.textContent = '✅ Guardrails disimpan — berlaku pada pesan berikutnya.';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});

// ---------- F51 Ekspor/Impor profil bot (9 Sep 2026) ----------
if ($('ag-export')) $('ag-export').addEventListener('click', async () => {
  const ok = $('ag-io-ok'), err = $('ag-io-err'); ok.textContent = ''; err.textContent = '';
  try {
    const r = await fetch('/api/agents/export');
    const d = await r.json();
    if (!r.ok || !d.ok) { err.textContent = d.error || 'Gagal mengekspor'; return; }
    if (!d.agents || !d.agents.length) { err.textContent = 'Belum ada profil bot untuk diekspor.'; return; }
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'coblai-profil-bot-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    ok.textContent = '✅ ' + d.agents.length + ' profil diekspor ke file .json';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
if ($('ag-import')) $('ag-import').addEventListener('click', () => { if ($('ag-import-file')) $('ag-import-file').click(); });
if ($('ag-import-file')) $('ag-import-file').addEventListener('change', async (ev) => {
  const ok = $('ag-io-ok'), err = $('ag-io-err'); ok.textContent = ''; err.textContent = '';
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  if (f.size > 512 * 1024) { err.textContent = 'File terlalu besar (maks 512KB).'; ev.target.value = ''; return; }
  try {
    const text = await f.text();
    let payload;
    try { payload = JSON.parse(text); } catch (e) { err.textContent = 'File bukan JSON yang valid.'; ev.target.value = ''; return; }
    const r = await fetch('/api/agents/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: payload.agents || payload }) });
    const d = await r.json();
    if (!r.ok || !d.ok) { err.textContent = d.error || 'Gagal mengimpor'; ev.target.value = ''; return; }
    ok.textContent = '✅ Masuk: ' + (d.added || []).join(', ') + ((d.skipped && d.skipped.length) ? ' · dilewati: ' + d.skipped.join(', ') : '');
    loadAgentsList();
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
  ev.target.value = '';
});

// ---------- Notifikasi / Webhook (Papi 16 Agu 2026 — #11 & #23) ----------
function loadNotify() {
  if (me && me.notifyUrl) $('notify-url').value = me.notifyUrl;
}
if ($('notify-save')) $('notify-save').addEventListener('click', async () => {
  const ok = $('notify-ok'), err = $('notify-err'); ok.textContent=''; err.textContent='';
  try {
    const r = await fetch('/api/notify', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url: $('notify-url').value.trim() }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal'; return; }
    if (me) me.notifyUrl = d.url || '';
    ok.textContent = d.url ? '✅ Webhook disimpan. Hasil agent akan dikirim ke URL ini.' : 'Webhook dihapus.';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
if ($('notify-test')) $('notify-test').addEventListener('click', async () => {
  const ok = $('notify-ok'), err = $('notify-err'); ok.textContent=''; err.textContent='';
  try {
    const r = await fetch('/api/notify/test', { method:'POST' });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal'; return; }
    ok.textContent = '✅ Test terkirim (status ' + d.status + '). Cek URL webhook kamu.';
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});
// ---------- F59 Push Notifikasi Browser (9 Sep 2026, PRD F59) ----------
// Backend web-push SUDAH ada (/api/push/vapid-key, /api/push/subscribe, /api/push/unsubscribe,
// pushSubs per-user, sendPushToUser saat agent_end). Ini sisi frontend: minta izin + subscribe SW.
async function pushEnable() {
  const ok = $('push-ok'), err = $('push-err'); if (ok) ok.textContent=''; if (err) err.textContent='';
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { if (err) err.textContent = 'Browser ini tidak mendukung notifikasi push.'; return; }
    if (!('Notification' in window)) { if (err) err.textContent = 'Notifikasi tidak didukung browser ini.'; return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { if (err) err.textContent = 'Izin notifikasi ditolak — aktifkan lewat pengaturan browser.'; return; }
    const reg = await navigator.serviceWorker.ready;
    const vr = await fetch('/api/push/vapid-key'); const vd = await vr.json();
    if (!vd.publicKey) { if (err) err.textContent = 'Push belum dikonfigurasi server (VAPID).'; return; }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vd.publicKey) });
    const sr = await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
    const sd = await sr.json();
    if (!sr.ok) { if (err) err.textContent = sd.error || 'Gagal daftar push'; return; }
    if (ok) ok.textContent = '✅ Notifikasi aktif — kamu akan dapat kabar saat agent selesai.';
    const en = $('push-enable'), dis = $('push-disable'); if (en) en.style.display='none'; if (dis) dis.style.display='';
  } catch (e) { if (err) err.textContent = 'Gagal: ' + e.message; }
}
async function pushDisable() {
  const ok = $('push-ok'), err = $('push-err'); if (ok) ok.textContent=''; if (err) err.textContent='';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    if (ok) ok.textContent = '🔕 Notifikasi dinonaktifkan.';
    const en = $('push-enable'), dis = $('push-disable'); if (en) en.style.display=''; if (dis) dis.style.display='none';
  } catch (e) { if (err) err.textContent = 'Gagal: ' + e.message; }
}
function urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const b = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b); const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
if ($('push-enable')) $('push-enable').addEventListener('click', pushEnable);
if ($('push-disable')) $('push-disable').addEventListener('click', pushDisable);
// Status awal: kalau sudah subscribe, tampilkan tombol nonaktif.
(async () => {
  try {
    if ('serviceWorker' in navigator && 'PushManager' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { const en = $('push-enable'), dis = $('push-disable'); if (en) en.style.display='none'; if (dis) dis.style.display=''; }
    }
  } catch (e) {}
})();

// ---------- Plugins (Papi 16 Agu 2026 — #24) ----------
async function loadPluginsList() {
  const box = $('plugins-list'); if (!box) return;
  try {
    const r = await fetch('/api/plugins'); const d = await r.json();
    const plugins = d.plugins || [];
    box.innerHTML = '';
    plugins.forEach(p => {
      const statusLabel = p.status === 'active' ? '✅ Aktif' : p.status === 'ready' ? '🟢 Siap' : p.status === 'dev' ? '🛠️ Dev' : '⏳ Butuh konfigurasi';
      const item = document.createElement('div');
      item.style.cssText = 'padding:12px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;';
      item.innerHTML = `<div style="display:flex;align-items:center;gap:10px;">
        <div style="flex:1;">
          <div style="font-weight:700;font-size:14px;">${escapeHtml(p.name)} <span style="font-size:11px;color:${p.connected ? 'var(--ok)' : 'var(--muted)'};">${p.connected ? '✅ Connected' : p.enabled ? '🟡 Enabled, not tested' : '⚪ Disconnected'}</span></div>
          <div style="font-size:12.5px;color:var(--muted);margin-top:3px;">${escapeHtml(p.desc)}</div>
          <div style="font-size:11.5px;color:var(--muted);margin-top:3px;">Permission: ${escapeHtml((p.permissions || []).join(', '))} · Credential: ${p.hasCredentials ? 'tersimpan terenkripsi' : 'belum diatur'}</div>
          ${p.lastError ? `<div style="font-size:11px;color:var(--danger);margin-top:3px;">Last error: ${escapeHtml(p.lastError)}</div>` : ''}
          ${p.lastTestAt ? `<div style="font-size:11px;color:var(--muted);margin-top:3px;">Last test: ${new Date(p.lastTestAt).toLocaleString('id-ID')} · Retry: ${(p.retry && p.retry.attempts) || 0}/3</div>` : ''}
        </div>
        <button class="btn small pl-config">⚙️ Config</button>
        <button class="btn small pl-test">🧪 Test</button>
        <button class="btn small pl-connect">${p.enabled ? '⏸️ Disconnect' : '▶️ Connect'}</button>
        <button class="btn small pl-toggle" style="display:none;">${p.enabled ? '⏸️ Matikan' : '▶️ Aktifkan'}</button>
      </div>`;
      const btn = item.querySelector('.pl-toggle');
      item.querySelector('.pl-test').addEventListener('click', async () => {
        const testBtn = item.querySelector('.pl-test');
        testBtn.disabled = true; testBtn.textContent = '⏳ Test...';
        try {
          const r = await fetch('/api/plugins/test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: p.id }) });
          const d = await r.json().catch(() => ({}));
          toast(r.ok ? '✅ ' + (d.detail || p.name + ' terhubung') : '❌ ' + (d.error || 'Test gagal'));
        } catch (e) { toast('❌ Test gagal: ' + e.message); }
        finally { testBtn.disabled = false; testBtn.textContent = '🧪 Test'; await loadPluginsList(); }
      });
      item.querySelector('.pl-config').addEventListener('click', async () => {
        const credentials = {};
        for (const field of (p.secretFields || [])) { const value = prompt('Masukkan ' + field + ' untuk ' + p.name + '. Disimpan terenkripsi; kosong = tidak mengubah.'); if (value) credentials[field] = value; }
        const config = {};
        if (p.id === 'mcp') { const command = prompt('MCP command (belum dieksekusi tanpa sandbox):', ''); if (command) config.command = command; const args = prompt('MCP args opsional:', ''); if (args) config.args = args; }
        if (!Object.keys(credentials).length && !Object.keys(config).length) return;
        const rr = await fetch('/api/plugins/' + encodeURIComponent(p.id) + '/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ credentials, config }) });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) toast('❌ ' + (dd.error || 'Config gagal')); else { toast('✅ Config tersimpan terenkripsi'); await loadPluginsList(); }
      });
      item.querySelector('.pl-connect').addEventListener('click', async () => {
        const connecting = !p.enabled;
        if (!connecting && !confirm('Disconnect ' + p.name + '?')) return;
        const rr = await fetch('/api/plugins/' + encodeURIComponent(p.id) + '/' + (connecting ? 'connect' : 'disconnect'), { method:'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) toast('❌ ' + (dd.error || 'Operasi gagal')); else { toast(connecting ? '✅ Enabled. Jalankan Test Connection.' : '✅ Disconnected'); await loadPluginsList(); }
      });
      if (p.status !== 'active') {
        btn.addEventListener('click', async () => {
          // Slack/toggle umum bisa langsung; Telegram/WhatsApp/MCP kasih info kebutuhan token
          if (p.status === 'needs' || p.status === 'dev') { toast('⚠️ ' + p.needs); return; }
          const r = await fetch('/api/plugins', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: p.id, enabled: !p.enabled }) });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) { toast(d.error || 'Gagal mengubah plugin'); return; }
          toast(p.enabled ? p.name + ' dimatikan' : p.name + ' diaktifkan ✅');
          await loadPluginsList();
        });
      }
      box.appendChild(item);
    });
  } catch (e) {}
}
if (typeof switchTab === 'function') { /* hook di bawah */ }

// ---------- Bot config (Papi 16 Agu 2026 — nama bot bisa diganti, TIDAK hardcode) ----------
async function loadBotConfig() {
  try {
    const r = await fetch('/api/admin/botconfig'); const d = await r.json();
    if (!r.ok) return;
    const bot = d.bot || {};
    $('bot-agentname').value = bot.agentName || 'Dinda';
    $('bot-username').value = bot.botUsername || '';
    $('bot-tagline').value = bot.tagline || '';
    const st = $('bot-status');
    st.innerHTML = '<b>Status:</b><br>• 🤖 Telegram token: ' + (d.hasToken ? '✅ terpasang' : '❌ belum') +
      '<br>• 💬 WhatsApp (Twilio): ' + (d.hasWa ? '✅ terpasang' : '❌ belum') +
      '<br>• 💡 Username bot di atas hanya informasi tampilan — webhook tetap pakai token yang tersimpan. Nama agent otomatis dipakai di pesan bot & instruksi chat.';
  } catch (e) {}
}
if ($('bot-save')) $('bot-save').addEventListener('click', async () => {
  const ok = $('bot-ok'), err = $('bot-err'); ok.textContent=''; err.textContent='';
  try {
    const r = await fetch('/api/admin/botconfig', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({
      agentName: $('bot-agentname').value.trim(), botUsername: $('bot-username').value.trim().replace(/^@/, ''), tagline: $('bot-tagline').value.trim(),
    }) });
    const d = await r.json();
    if (!r.ok) { err.textContent = d.error || 'Gagal'; return; }
    ok.textContent = '✅ Nama agent diperbarui ke "' + (d.bot && d.bot.agentName) + '". Ketik /new di bot Telegram untuk aktifkan.';
    loadBotConfig();
  } catch (e) { err.textContent = 'Gagal: ' + e.message; }
});

// ---------- Kelola Artefak (Pengaturan) — FIX Papi 15 Agu 2026 ----------
// Hapus artefak HANYA dari Pengaturan → Artefak. Panel depan cuma lihat & download.
let artMgmtFiles = [];
let artSel = new Set();
function updateArtSelUI() {
  const btn = $('art-delete-selected');
  if (btn) { btn.disabled = artSel.size === 0; btn.textContent = '🗑️ Hapus Terpilih (' + artSel.size + ')'; }
  const cnt = $('art-sel-count');
  if (cnt) cnt.textContent = artSel.size ? artSel.size + ' dipilih' : '';
}
// helper global (dipakai Check All & render tree) — folder checkbox state
function artGetDirFiles(dirPath) {
  const p = dirPath + '/';
  return artMgmtFiles.filter(f => f.path.startsWith(p)).map(f => f.path);
}
function artUpdateFolderChecks() {
  document.querySelectorAll('.art-folder-check').forEach(chk => {
    const files = artGetDirFiles(chk.dataset.dir);
    const sel = files.filter(p => artSel.has(p)).length;
    chk.checked = sel > 0 && sel === files.length;
    chk.indeterminate = sel > 0 && sel < files.length;
  });
}
async function loadArtMgmt() {
  const box = $('art-mgmt-list');
  const okEl = $('art-mgmt-ok'), errEl = $('art-mgmt-err');
  if (okEl) okEl.textContent = ''; if (errEl) errEl.textContent = '';
  try {
    const r = await fetch('/api/artifacts'); if (!r.ok) return;
    const d = await r.json();
    artMgmtFiles = d.files || [];
    if (!artMgmtFiles.length) { box.innerHTML = '<div class="art-empty">Tidak ada artefak.</div>'; return; }
    box.innerHTML = '';
    // Tree folder (Papi 19 Agu 2026): susunan SAMA seperti panel chat — folder tetap folder,
    // isi folder tidak dibongkar; file di root tampil langsung.
    const tree = {};
    artMgmtFiles.forEach(f => {
      const parts = f.path.split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        const dir = parts[i];
        if (!node[dir]) node[dir] = {};
        node = node[dir];
      }
      const leaf = parts[parts.length - 1];
      if (!node.__files) node.__files = [];
      node.__files.push(f);
    });
    function countFiles(node) {
      let n = (node.__files || []).length;
      Object.keys(node).filter(k => k !== '__files').forEach(k => n += countFiles(node[k]));
      return n;
    }
    function artItem(f) {
      const item = document.createElement('div');
      item.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;';
      const ext = f.path.split('.').pop().toLowerCase();
      const icon = { js:'📜', ts:'📘', py:'🐍', html:'🌐', css:'🎨', json:'🧾', md:'📝', sh:'⚡', sql:'🗄️', png:'🖼️', jpg:'🖼️', jpeg:'🖼️', gif:'🖼️', webp:'🖼️', pdf:'📄', svg:'🖼️' }[ext] || '📄';
      item.innerHTML = `<input type="checkbox" class="art-check" data-path="${escapeHtml(f.path)}" style="flex-shrink:0;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" ${artSel.has(f.path)?'checked':''}><span>${icon}</span><span style="flex:1;font-size:12.5px;word-break:break-all;cursor:pointer;" title="${escapeHtml(f.path)}">${escapeHtml(f.path.split('/').pop())}</span><span style="color:var(--muted);font-size:10.5px;flex-shrink:0;max-width:105px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Sesi: ${escapeHtml(f.session || '—')}">${escapeHtml(f.session || '—')}</span><span style="color:var(--muted);font-size:10.5px;flex-shrink:0;max-width:85px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="User: ${escapeHtml(f.user || '—')}">${escapeHtml(f.user || '—')}</span><span style="color:var(--muted);font-size:11px;flex-shrink:0;">${fmtSize(f.size)}</span>`;
      const dl = document.createElement('button'); dl.className = 'btn small'; dl.textContent = '⬇️'; dl.title = 'Download';
      dl.addEventListener('click', () => { window.location.href = '/api/artifact/download?path=' + encodeURIComponent(f.path); });
      item.appendChild(dl);
      const del = document.createElement('button'); del.className = 'btn small danger'; del.textContent = '🗑️'; del.title = 'Hapus file ini';
      del.addEventListener('click', async () => {
        if (!confirm('Hapus file ini?\n' + f.path + '\n\nTidak bisa dibatalkan.')) return;
        const rr = await fetch('/api/artifact?path=' + encodeURIComponent(f.path), { method:'DELETE' });
        if (rr.ok) { if (okEl) okEl.textContent = '✅ ' + f.path.split('/').pop() + ' dihapus'; toast('🗑️ dihapus'); }
        else { if (errEl) errEl.textContent = 'Gagal hapus'; }
        loadArtMgmt(); refreshArtifacts();
      });
      item.appendChild(del);
      item.querySelector('.art-check').addEventListener('change', (ev) => {
        if (ev.target.checked) artSel.add(f.path); else artSel.delete(f.path);
        updateArtSelUI();
        updateFolderChecks();
      });
      return item;
    }
    function getDirFiles(dirPath) {
      const p = dirPath + '/';
      return artMgmtFiles.filter(f => f.path.startsWith(p)).map(f => f.path);
    }
    function updateFolderChecks() {
      document.querySelectorAll('.art-folder-check').forEach(chk => {
        const files = getDirFiles(chk.dataset.dir);
        const sel = files.filter(p => artSel.has(p)).length;
        chk.checked = sel > 0 && sel === files.length;
        chk.indeterminate = sel > 0 && sel < files.length;
      });
    }
    function renderArtTree(node, container, prefix) {
      const dirs = Object.keys(node).filter(k => k !== '__files').sort();
      dirs.forEach(dir => {
        const dirPath = prefix ? prefix + '/' + dir : dir;
        const group = document.createElement('div'); group.className = 'art-folder';
        const head = document.createElement('div'); head.className = 'art-folder-head';
        head.innerHTML = `<input type="checkbox" class="art-folder-check" data-dir="${escapeHtml(dirPath)}" style="flex-shrink:0;width:16px;height:16px;accent-color:var(--accent);cursor:pointer;" title="Centang folder = pilih semua isinya"><span>📁</span><span class="fname">${escapeHtml(dir)}</span><span style="margin-left:auto;color:var(--muted);font-size:11px;">${countFiles(node[dir])} file</span>`;
        head.addEventListener('click', (e) => { if (e.target.classList && e.target.classList.contains('art-folder-check')) return; group.classList.toggle('open'); });
        const chkF = head.querySelector('.art-folder-check');
        chkF.addEventListener('change', (e) => {
          e.stopPropagation();
          const files = getDirFiles(chkF.dataset.dir);
          files.forEach(p => { if (chkF.checked) artSel.add(p); else artSel.delete(p); });
          // sinkronkan checkbox file di dalam folder
          document.querySelectorAll('.art-check').forEach(fchk => {
            if (fchk.dataset.path && fchk.dataset.path.startsWith(chkF.dataset.dir + '/')) fchk.checked = artSel.has(fchk.dataset.path);
          });
          updateArtSelUI();
          updateFolderChecks();
        });
        const body = document.createElement('div'); body.className = 'art-folder-body';
        renderArtTree(node[dir], body, dirPath);
        (node[dir].__files || []).forEach(f => body.appendChild(artItem(f)));
        group.appendChild(head); group.appendChild(body);
        container.appendChild(group);
      });
      (node.__files || []).forEach(f => container.appendChild(artItem(f)));
    }
    renderArtTree(tree, box);
    updateFolderChecks();
  } catch (e) { if (errEl) errEl.textContent = 'Gagal: ' + e.message; }
}
// Centang Semua / batal centang (Papi 19 Agu 2026 — hapus banyak sekaligus)
$('art-check-all').addEventListener('click', () => {
  const allChecked = artSel.size === artMgmtFiles.length && artMgmtFiles.length > 0;
  artSel.clear();
  if (!allChecked) artMgmtFiles.forEach(f => artSel.add(f.path));
  // re-render checkbox sesuai state (pakai data-path — urutan di tree beda dari list)
  document.querySelectorAll('.art-check').forEach(chk => { chk.checked = artSel.has(chk.dataset.path); });
  updateArtSelUI();
  artUpdateFolderChecks();
});
// Hapus artefak TERPILIH (bukan satu-satu, bukan semua)
$('art-delete-selected').addEventListener('click', async () => {
  const okEl = $('art-mgmt-ok'), errEl = $('art-mgmt-err');
  if (!artSel.size) return;
  if (!confirm('Hapus ' + artSel.size + ' artefak terpilih?\n\nTidak bisa dibatalkan.')) return;
  const paths = [...artSel];
  let ok = 0;
  for (const p of paths) {
    const r = await fetch('/api/artifact?path=' + encodeURIComponent(p), { method: 'DELETE' });
    if (r.ok) ok++;
  }
  artSel.clear();
  toast('🗑️ ' + ok + ' file dihapus');
  if (okEl) okEl.textContent = '✅ ' + ok + ' file dihapus';
  if (errEl) errEl.textContent = '';
  loadArtMgmt(); refreshArtifacts();
});
$('art-mgmt-clear-all').addEventListener('click', async () => {
  const okEl = $('art-mgmt-ok'), errEl = $('art-mgmt-err');
  if (okEl) okEl.textContent = ''; if (errEl) errEl.textContent = '';
  if (!artMgmtFiles.length) { toast('Tidak ada artefak'); return; }
  if (!confirm('Hapus SEMUA artefak (' + artMgmtFiles.length + ' file)?\n\nIni tidak bisa dibatalkan.')) return;
  let ok = 0;
  for (const f of artMgmtFiles) {
    const r = await fetch('/api/artifact?path=' + encodeURIComponent(f.path), { method:'DELETE' });
    if (r.ok) ok++;
  }
  toast('🗑️ ' + ok + ' file dihapus');
  if (okEl) okEl.textContent = '✅ ' + ok + ' file dihapus';
  loadArtMgmt(); refreshArtifacts();
});

// ---------- Password: lihat/sembunyikan (ikon mata) — Aaron 13 Agu 2026 ----------
document.querySelectorAll('.pw-eye').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.for);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  });
});

// ---------- Foto Prime: tombol pilih terpisah — Aaron 13 Agu 2026 ----------
$('prime-avatar-pick').addEventListener('click', () => $('prime-avatar-file').click());

// ---------- Instal Aplikasi (PWA) — muncul tiap bisa, + tombol manual — Aaron 13 Agu 2026 ----------
let deferredPrompt = null;
// FIX PWA (audit ulang Aaron 15 Agu 2026): service worker TIDAK pernah didaftarkan
// → Chrome tidak memunculkan beforeinstallprompt → tombol install tidak muncul.
// Registrasi SW adalah syarat wajib PWA installable.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('[pwa] service worker register gagal:', err);
    });
  });
}
// ===== Push Notification (fitur #1 Dinda 29 Agu 2026) =====
async function initPushNotifications() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return;
    if (Notification.permission === 'denied') return;
    const r = await fetch('/api/push/vapid-key', { cache: 'no-store' });
    const d = await r.json();
    if (!d.publicKey) return;
    let permission = Notification.permission;
    if (permission === 'default') {
      try { permission = await Notification.requestPermission(); } catch (e) { return; }
    }
    if (permission !== 'granted') return;
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(d.publicKey) });
    }
    const payload = { subscription: { endpoint: sub.endpoint, keys: { p256dh: arrayBufferToBase64(sub.getKey('p256dh')), auth: arrayBufferToBase64(sub.getKey('auth')) } } };
    await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (e) { /* notifikasi opsional — gagal tidak mengganggu */ }
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = $('install-app-btn');
  if (btn) btn.style.display = '';
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  const btn = $('install-app-btn');
  if (btn) btn.style.display = 'none';
  toast('📲 Aplikasi terpasang! Cek layar utama HP');
});
$('install-app-btn').addEventListener('click', async () => {
  if (!deferredPrompt) {
    toast('Gunakan menu ⋮ browser → "Tambahkan ke layar utama"');
    return;
  }
  deferredPrompt.prompt();
  try { await deferredPrompt.userChoice; } catch (e) {}
  deferredPrompt = null;
  const btn = $('install-app-btn');
  if (btn) btn.style.display = 'none';
});
// ---------- Paket & Billing (user) — Aaron 13 Agu 2026 ----------
async function loadPaket() {
  try {
    const r = await fetch('/api/me'); const d = await r.json();
    if (!d.authed) return;
    const q = d.quota || { tier: 'free', tierLabel: 'Free', usedToday: 0, dailyTokens: 50000, percent: 0 };
    const box = $('paket-info');
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
      <div><b>Paket kamu: ${q.tierLabel}</b></div>
      <div style="color:var(--muted);font-size:13px;">Kuota hari ini: ${fmtNum(q.usedToday)} / ${fmtNum(q.dailyTokens)} token</div>
    </div>
    <div class="quota-bar" style="margin-top:10px;"><div class="quota-fill" style="width:${Math.min(100,q.percent)}%;${q.percent>=100?'background:#ff3b30;':q.percent>=80?'background:#ff9f0a;':''}"></div></div>`;
  } catch (e) {}
}

// ---------- Untung-Rugi (admin) — Aaron 13 Agu 2026 ----------
async function loadAdminOverview() {
  $('ad-err').textContent = ''; $('ad-ok').textContent = '';
  try {
    const r = await fetch('/api/admin/overview');
    if (r.status === 403) { $('ad-users').textContent = 'Hanya admin.'; return; }
    const d = await r.json();
    $('ad-rev30').textContent = 'Rp' + fmtNum(Math.round(d.month.revenue || 0));
    $('ad-cost30').textContent = usdToRp(d.month.cost || 0);
    $('ad-margin').textContent = (d.marginMonth >= 0 ? '+' : '−') + usdToRp(Math.abs(d.marginMonth || 0));
    if (d.marginMonth < 0) $('ad-err').textContent = '⚠️ Margin bulan ini NEGATIF — cost AI melebihi revenue. Cek harga tier atau batasi quota!';
    $('ad-tokens30').textContent = fmtNum(d.month.tokens || 0);
    const box = $('ad-users');
    box.innerHTML = '';
    const rows = d.users || [];
    if (!rows.length) { box.innerHTML = '<i>Belum ada data.</i>'; return; }
    rows.forEach(u => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;';
      row.innerHTML = `<div style="flex:1;min-width:120px;"><b>${escapeHtml(u.name || u.username)}</b> <span style="color:var(--muted);font-size:11px;">@${escapeHtml(u.username)}</span></div>
        <span class="badge ${u.tier==='free'?'':'member'}">${escapeHtml(u.tier)}</span>
        <span style="font-size:11px;color:var(--muted);">${fmtNum(u.usedToday)}/${fmtNum(u.dailyTokens)}</span>
        <span style="font-size:11px;color:var(--muted);" title="Cost 30 hari">${usdToRp(u.cost30d || 0)}</span>
        <button class="btn small" data-reset="${u.username}" style="font-size:10px;">🔄 Reset</button>
        <select data-tier="${u.username}" style="font-size:11px;padding:4px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text);">
          <option value="free" ${u.tier==='free'?'selected':''}>Free</option>
          <option value="premium" ${u.tier==='premium'?'selected':''}>Premium</option>
          <option value="enterprise" ${u.tier==='enterprise'?'selected':''}>Enterprise</option>
        </select>`;
      row.querySelector('[data-reset]').addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm('Reset kuota hari ini untuk @' + u.username + '?')) return;
        const rr = await fetch('/api/admin/reset-quota', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userId: u.id }) });
        if (rr.ok) { toast('Kuota @' + u.username + ' direset ✅'); loadAdminOverview(); } else toast('Gagal reset');
      });
      row.querySelector('[data-tier]').addEventListener('change', async (ev) => {
        const newTier = ev.target.value;
        if (!confirm('Ganti tier @' + u.username + ' ke ' + newTier + '?')) { ev.target.value = u.tier; return; }
        const rr = await fetch('/api/users/' + u.id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tier: newTier }) });
        if (rr.ok) { toast('Tier @' + u.username + ' → ' + newTier + ' ✅'); loadAdminOverview(); } else toast('Gagal ganti tier');
      });
      box.appendChild(row);
    });
  } catch (e) { $('ad-users').textContent = 'Gagal: ' + e.message; }
}
$('ad-rev-save').addEventListener('click', async () => {
  const amount = parseFloat($('ad-amount').value);
  const note = $('ad-note').value.trim();
  if (!amount || amount <= 0) { $('ad-err').textContent = 'Isi nominal dulu.'; return; }
  try {
    const r = await fetch('/api/admin/revenue', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ amount, note }) });
    const d = await r.json();
    if (r.ok) { $('ad-ok').textContent = '✅ Pembayaran dicatat: Rp' + fmtNum(amount); $('ad-amount').value=''; $('ad-note').value=''; loadAdminOverview(); }
    else $('ad-err').textContent = d.error || 'Gagal';
  } catch (e) { $('ad-err').textContent = 'Gagal: ' + e.message; }
});
// ---------- Order & Kupon (toko online) — Aaron 14 Agu 2026 ----------
const PAY_PRICES = { premium: 99000, enterprise: 499000 };
let selDiscount = 0, selCoupon = null;
let payGw = 'manual'; // xendit | midtrans | manual — pilihan cara bayar (Aaron 14 Agu 2026)
function initPayMethodBtns() {
  const btns = document.querySelectorAll('.pay-method-btn');
  btns.forEach(b => {
    b.addEventListener('click', () => {
      payGw = b.dataset.gw;
      btns.forEach(x => x.classList.toggle('active', x === b));
      $('pay-gw-note').innerHTML = payGw === 'xendit' ? '⚡ Xendit — otomatis konfirmasi & langsung aktif. Transfer bank / e-wallet / QRIS / kartu.' :
        payGw === 'midtrans' ? '💳 Midtrans — otomatis konfirmasi & langsung aktif. Kartu kredit, VA, e-wallet, QRIS.' :
        '🏦 Manual — transfer ke rekening kami, diverifikasi ≤24 jam. Nominal pakai angka unik biar verifikasi cepat.';
    });
  });
}
function calcPay() {
  const tier = $('pay-tier').value;
  const months = parseInt($('pay-months').value, 10);
  const base = PAY_PRICES[tier] * months;
  const total = Math.max(0, base - Math.round(base * selDiscount / 100));
  $('pay-total').textContent = 'Rp' + total.toLocaleString('id-ID');
  $('pay-disc-label').textContent = selDiscount > 0 ? ' (diskon ' + selDiscount + '% — hemat Rp' + (base - total).toLocaleString('id-ID') + ')' : '';
}
$('pay-tier').addEventListener('change', () => { selCoupon = null; selDiscount = 0; $('pay-coupon').value = ''; calcPay(); });
$('pay-months').addEventListener('change', () => { selCoupon = null; selDiscount = 0; $('pay-coupon').value = ''; calcPay(); });
$('pay-coupon-check').addEventListener('click', async () => {
  const code = $('pay-coupon').value.trim().toUpperCase();
  if (!code) { $('pay-err').textContent = 'Masukkan kode kupon dulu.'; return; }
  $('pay-err').textContent = ''; $('pay-ok').textContent = '';
  try {
    const r = await fetch('/api/coupons/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code, tier: $('pay-tier').value, months: parseInt($('pay-months').value, 10) }) });
    const d = await r.json();
    if (!r.ok) { $('pay-err').textContent = d.error || 'Kupon tidak valid'; selCoupon = null; selDiscount = 0; calcPay(); return; }
    selCoupon = code; selDiscount = d.discountPct;
    $('pay-ok').textContent = '✅ Kupon valid — diskon ' + d.discountPct + '%' + (d.trial ? ' (TRIAL khusus daftar 1 bulan)' : '');
    calcPay();
  } catch (e) { $('pay-err').textContent = 'Gagal cek kupon'; }
});
async function loadPayHistory() {
  try {
    const r = await fetch('/api/orders');
    const d = await r.json();
    const box = $('pay-history');
    const os = (d.orders || []).slice(0, 10);
    if (!os.length) { box.innerHTML = '<i style="color:var(--muted);">Belum ada pesanan.</i>'; return; }
    const st = { pending: '⏳ Menunggu bayar', awaiting: '🕐 Menunggu verifikasi', paid: '✅ Aktif', rejected: '❌ Ditolak', expired: '⏰ Kadaluarsa', trial: '🎁 Trial' };
    box.innerHTML = os.map(x => `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <span>${x.id} — ${x.tier === 'premium' ? '💎 Premium' : '🏢 Enterprise'} × ${x.months} bln <b>Rp${fmtNum(x.totalAmount)}</b></span>
      <span style="color:var(--muted);font-size:11px;">${st[x.status] || x.status} ${x.status === 'pending' ? `<a href="/thankyou?order=${x.id}" style="font-size:11px;">bayar →</a>` : ''}</span>
    </div>`).join('');
  } catch (e) { $('pay-history').textContent = 'Gagal: ' + e.message; }
}
$('pay-submit').addEventListener('click', async () => {
  $('pay-err').textContent = ''; $('pay-ok').textContent = '';
  const tier = $('pay-tier').value;
  const months = parseInt($('pay-months').value, 10);
  $('pay-submit').disabled = true; $('pay-submit').textContent = 'Membuat pesanan...';
  try {
    const r = await fetch('/api/orders', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tier, months, couponCode: selCoupon || undefined }) });
    const d = await r.json();
    if (!r.ok) { $('pay-err').textContent = d.error || 'Gagal buat pesanan'; $('pay-submit').disabled = false; $('pay-submit').textContent = '🛒 Buat Pesanan & Lanjut Bayar'; return; }
    if (d.trialActive) { toast('🎁 Trial aktif 1 hari!'); loadPayHistory(); refreshStatus(); $('pay-submit').disabled = false; $('pay-submit').textContent = '🛒 Buat Pesanan & Lanjut Bayar'; return; }
    if (payGw === 'xendit' || payGw === 'midtrans') {
      const gr = await fetch('/api/orders/' + d.order.id + '/pay-gateway', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ gateway: payGw }) });
      const gd = await gr.json();
      if (gr.ok && gd.redirectUrl) { window.open(gd.redirectUrl, '_blank'); window.location.href = '/thankyou?order=' + d.order.id; }
      else { $('pay-err').textContent = gd.error || 'Gagal gateway'; window.location.href = '/thankyou?order=' + d.order.id; }
    } else {
      window.location.href = '/thankyou?order=' + d.order.id;
    }
  } catch (e) { $('pay-err').textContent = 'Gagal: ' + e.message; $('pay-submit').disabled = false; $('pay-submit').textContent = '🛒 Buat Pesanan & Lanjut Bayar'; }
});
async function loadAdminPayments() {
  try {
    const r = await fetch('/api/admin/payments');
    if (r.status === 403) { $('ad-payments').textContent = 'Hanya admin.'; return; }
    const d = await r.json();
    const box = $('ad-payments');
    const ps = (d.payments || []).slice(0, 50);
    if (!ps.length) { box.innerHTML = '<i style="color:var(--muted);">Belum ada pembayaran.</i>'; return; }
    const st = { pending: '⏳', awaiting: '🕐', paid: '✅', rejected: '❌', expired: '⏰', cancelled: '🚫', voided: '⊘', refund_requested: '↩️', refunded: '✅↩️' };
    box.innerHTML = '';
    ps.forEach(x => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;';
      row.innerHTML = `<span>${st[x.status]} <b>@${escapeHtml(x.username)}</b> — ${x.tier === 'premium' ? '💎 Premium' : '🏢 Enterprise'} Rp${fmtNum(x.amount)}</span>
        <span style="font-size:11px;color:var(--muted);">${new Date(x.createdAt).toLocaleString('id-ID')} · ${escapeHtml(x.method)}</span>
        ${x.note ? `<span style="font-size:11px;color:var(--muted);">📝 ${escapeHtml(x.note)}</span>` : ''}
        ${x.proofPath ? `<button class="btn small" data-proof="${escapeHtml(x.proofPath)}" style="font-size:10px;">🖼️ Bukti</button>` : ''}
        <button class="btn small" data-timeline="${x.id}" style="font-size:10px;">🧾 Timeline</button>
        ${x.status === 'pending' || x.status === 'awaiting' ? `<button class="btn small" data-approve="${x.id}" style="font-size:10px;background:rgba(52,199,89,.15);">✅ Approve</button><button class="btn small" data-void="${x.id}" style="font-size:10px;">⊘ Void</button><button class="btn small danger" data-reject="${x.id}" style="font-size:10px;">❌ Tolak</button>` : ''}
        ${x.status === 'paid' ? `<button class="btn small danger" data-refund="${x.id}" style="font-size:10px;">↩️ Request Refund</button>` : ''}`;
      const approveBtn = row.querySelector('[data-approve]');
      if (approveBtn) approveBtn.addEventListener('click', async () => {
        if (!confirm('Approve pembayaran @' + x.username + ' dan aktifkan tier ' + x.tier + '?')) return;
        const rr = await fetch('/api/admin/payments/' + x.id + '/approve', { method:'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (rr.ok) { toast('✅ ' + x.username + ' diaktifkan ' + x.tier); loadAdminPayments(); loadAdminOverview(); } else toast(dd.error || 'Gagal approve');
      });
      const rejectBtn = row.querySelector('[data-reject]');
      if (rejectBtn) rejectBtn.addEventListener('click', async () => {
        if (!confirm('Tolak pembayaran @' + x.username + '?')) return;
        const rr = await fetch('/api/admin/payments/' + x.id + '/reject', { method:'POST' });
        if (!rr.ok) toast('Gagal menolak pembayaran');
        loadAdminPayments();
      });
      const voidBtn = row.querySelector('[data-void]');
      if (voidBtn) voidBtn.addEventListener('click', async () => {
        if (!confirm('Void payment ini?')) return;
        const rr = await fetch('/api/admin/payments/' + x.id + '/void', { method:'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) toast(dd.error || 'Gagal void'); else { toast('✅ Payment di-void'); loadAdminPayments(); }
      });
      const refundBtn = row.querySelector('[data-refund]');
      if (refundBtn) refundBtn.addEventListener('click', async () => {
        if (!confirm('Catat request refund? Ini belum mengembalikan dana ke customer sampai provider dikonfirmasi.')) return;
        const rr = await fetch('/api/admin/payments/' + x.id + '/refund', { method:'POST' });
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) toast(dd.error || 'Gagal request refund'); else { toast('↩️ Refund request tercatat'); loadAdminPayments(); loadAdminOverview(); }
      });
      const timelineBtn = row.querySelector('[data-timeline]');
      if (timelineBtn) timelineBtn.addEventListener('click', async () => {
        const rr = await fetch('/api/admin/payments/' + x.id);
        const dd = await rr.json().catch(() => ({}));
        if (!rr.ok) { toast(dd.error || 'Timeline gagal dimuat'); return; }
        alert((dd.timeline || []).map(e => new Date(e.at).toLocaleString('id-ID') + ' · ' + e.type + ' · ' + e.status + (e.actor ? ' · ' + e.actor : '')).join('\\n') || 'Belum ada event');
      });
      const proofBtn = row.querySelector('[data-proof]');
      if (proofBtn) proofBtn.addEventListener('click', () => {
        window.open('/api/admin/payment-proof?path=' + encodeURIComponent(proofBtn.dataset.proof), '_blank');
      });
      box.appendChild(row);
    });
  } catch (e) { $('ad-payments').textContent = 'Gagal: ' + e.message; }
}
async function loadPaymentReport() {
  const box = $('ad-payment-report'); if (!box) return;
  try {
    const r = await fetch('/api/admin/payment-report'); const d = await r.json().catch(() => ({}));
    if (!r.ok) { box.textContent = d.error || 'Report gagal dimuat'; return; }
    const t = d.totals || {}, c = d.counts || {};
    box.innerHTML = `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:8px;"><span>Paid: <b>${c.paid || 0}</b></span><span>Pending: <b>${c.pending || 0}</b></span><span>Rejected: <b>${c.rejected || 0}</b></span><span>Refund request: <b>${c.refundRequested || 0}</b></span></div><div>Settled: <b>Rp${fmtNum(t.settled || 0)}</b> · Pending: <b>Rp${fmtNum(t.pending || 0)}</b> · Refund: <b>Rp${fmtNum(t.refunds || 0)}</b></div><div style="margin-top:5px;">Ledger events: ${d.ledgerEntries || 0} · Unmatched paid: <b style="color:${(d.unmatched || []).length ? 'var(--danger)' : 'var(--ok)'}">${(d.unmatched || []).length}</b></div>`;
  } catch (e) { box.textContent = 'Gagal: ' + e.message; }
}
$('ad-payment-report-refresh').addEventListener('click', loadPaymentReport);

async function loadAdminCoupons() {
  try {
    const r = await fetch('/api/admin/coupons');
    if (r.status === 403) { $('cp-list').textContent = 'Hanya admin.'; return; }
    const d = await r.json();
    const box = $('cp-list');
    const cs = d.coupons || [];
    if (!cs.length) { box.innerHTML = '<i style="color:var(--muted);">Belum ada kupon. Generate di atas 👆</i>'; return; }
    box.innerHTML = '';
    cs.slice(0, 20).forEach(c => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;';
      const expired = c.validUntil && Date.now() > c.validUntil;
      row.innerHTML = `<span style="font-weight:700;">${escapeHtml(c.code)}</span>
        <span class="badge" style="${c.active && !expired ? 'background:rgba(52,199,89,.15);color:var(--ok);' : 'background:rgba(255,59,48,.12);color:#ff3b30;'}">${c.active && !expired ? 'Aktif' : 'Nonaktif'}</span>
        <span style="color:var(--muted);font-size:11px;">${c.discountPct}%${c.trial ? ' · 🎁TRIAL' : ''} · dipakai ${c.usedCount}${c.maxUses ? '/' + c.maxUses : ''} · s/d ${new Date(c.validUntil).toLocaleDateString('id-ID')}</span>
        <button class="btn small" data-cp-toggle="${c.id}" style="font-size:10px;">${c.active ? 'Nonaktifkan' : 'Aktifkan'}</button>`;
      row.querySelector('[data-cp-toggle]').addEventListener('click', async () => {
        await fetch('/api/admin/coupons/' + c.id + '/toggle', { method:'POST' });
        loadAdminCoupons();
      });
      box.appendChild(row);
    });
  } catch (e) { $('cp-list').textContent = 'Gagal: ' + e.message; }
}
$('cp-gen').addEventListener('click', async () => {
  const discountPct = parseInt($('cp-disc').value, 10);
  if (isNaN(discountPct) || discountPct < 0 || discountPct > 100) { $('ad-err').textContent = 'Diskon harus 0-100%.'; return; }
  try {
    const r = await fetch('/api/admin/coupons', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ discountPct, validDays: parseInt($('cp-days').value, 10) || 30, maxUses: parseInt($('cp-uses').value, 10) || 0, trial: $('cp-trial').checked, code: $('cp-code').value.trim() }) });
    const d = await r.json();
    if (r.ok) { $('ad-ok').textContent = '🎟️ Kupon dibuat: ' + d.coupon.code + ' (' + d.coupon.discountPct + '%)'; $('cp-code').value = ''; loadAdminCoupons(); }
    else $('ad-err').textContent = d.error || 'Gagal';
  } catch (e) { $('ad-err').textContent = 'Gagal: ' + e.message; }
});
async function loadAdminOrders() {
  try {
    const r = await fetch('/api/admin/orders?status=' + (adminOrderFilter === 'all' ? '' : adminOrderFilter));
    if (r.status === 403) { $('ad-orders').textContent = 'Hanya admin.'; return; }
    const d = await r.json();
    const box = $('ad-orders');
    const os = d.orders || [];
    if (!os.length) { box.innerHTML = '<i style="color:var(--muted);">Tidak ada pesanan.</i>'; return; }
    const st = { pending: '⏳ Belum bayar', awaiting: '🕐 Menunggu verifikasi', paid: '✅ Aktif', rejected: '❌ Ditolak', expired: '⏰ Expired', trial: '🎁 Trial' };
    box.innerHTML = '';
    os.slice(0, 30).forEach(o => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;';
      row.innerHTML = `<span><b>${escapeHtml(o.id)}</b><br><span style="font-size:11px;color:var(--muted);">@${escapeHtml(o.username)} · ${o.tier === 'premium' ? '💎' : '🏢'} ${o.tier} × ${o.months} · <b style="color:var(--text);">Rp${fmtNum(o.payAmount != null ? o.payAmount : o.totalAmount)}</b>${o.uniqueCode ? ` <span style="color:var(--ok);">🔑${o.uniqueCode}</span>` : ''}${o.method ? ' · ' + escapeHtml(o.method) : ''}${o.couponCode ? ' · 🎟️' + escapeHtml(o.couponCode) : ''}</span></span>
        <span class="badge">${st[o.status] || o.status}</span>
        ${o.status === 'awaiting' && o.proofPath ? `<button class="btn small" data-proof="${escapeHtml(o.proofPath)}" style="font-size:10px;">🖼️ Bukti</button>` : ''}
        ${(o.status === 'awaiting' || o.status === 'pending') ? `<button class="btn small" data-approve="${o.id}" style="font-size:10px;background:rgba(52,199,89,.15);">✅ Approve</button>` : ''}
        ${(o.status === 'awaiting' || o.status === 'pending') ? `<button class="btn small danger" data-reject="${o.id}" style="font-size:10px;">❌ Tolak</button>` : ''}`;
      const proofBtn = row.querySelector('[data-proof]');
      if (proofBtn) proofBtn.addEventListener('click', () => window.open('/api/admin/payment-proof?path=' + encodeURIComponent(proofBtn.dataset.proof), '_blank'));
      const ap = row.querySelector('[data-approve]');
      if (ap) ap.addEventListener('click', async () => {
        if (!confirm('Approve pesanan ' + o.id + ' (@' + o.username + ') dan aktifkan ' + o.tier + ' ' + o.months + ' bulan?')) return;
        const rr = await fetch('/api/admin/orders/' + o.id + '/approve', { method:'POST' });
        if (rr.ok) { toast('✅ ' + o.username + ' diaktifkan'); loadAdminOrders(); loadAdminOverview(); loadAdminPayments(); } else toast('Gagal approve');
      });
      const rj = row.querySelector('[data-reject]');
      if (rj) rj.addEventListener('click', async () => {
        if (!confirm('Tolak pesanan ' + o.id + '?')) return;
        await fetch('/api/admin/orders/' + o.id + '/reject', { method:'POST' });
        loadAdminOrders();
      });
      box.appendChild(row);
    });
  } catch (e) { $('ad-orders').textContent = 'Gagal: ' + e.message; }
}
document.querySelectorAll('[data-of]').forEach(btn => {
  btn.addEventListener('click', () => {
    adminOrderFilter = btn.dataset.of;
    document.querySelectorAll('[data-of]').forEach(b => b.style.borderColor = b === btn ? 'var(--accent)' : '');
    loadAdminOrders();
  });
});

// ---------- Rekening Bank Tujuan (admin) — Aaron 14 Agu 2026 ----------
async function loadBanksAdmin() {
  const box = $('banks-list'); if (!box) return;
  try {
    const r = await fetch('/api/admin/banks');
    if (r.status === 403) { box.innerHTML = '<i>Hanya admin.</i>'; return; }
    const d = await r.json();
    const bs = d.banks || [];
    if (!bs.length) { box.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:10px;border:1px dashed var(--border);border-radius:10px;">Belum ada rekening. Tambahkan minimal 3 bank di form bawah 👇</div>'; return; }
    box.innerHTML = bs.map(b => `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid ${b.active ? 'var(--border)' : 'var(--danger)'};border-radius:10px;background:var(--bg);flex-wrap:wrap;">
      <div style="flex:1;min-width:180px;">
        <div style="font-weight:700;">🏦 ${escapeHtml(b.bankName)} ${b.active ? '' : '<span style="color:var(--danger);font-size:11px;">(nonaktif)</span>'}</div>
        <div style="font-size:12px;color:var(--muted);">${escapeHtml(b.accountNumber)} · A/N ${escapeHtml(b.holder)}</div>
      </div>
      <button class="btn small" data-edit="${b.id}">✏️ Edit</button>
      <button class="btn small" data-toggle="${b.id}">${b.active ? '⏸ Nonaktifkan' : '▶️ Aktifkan'}</button>
      <button class="btn small danger" data-del="${b.id}">🗑</button>
    </div>`).join('');
    box.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', async () => {
      const b = bs.find(x => x.id === btn.dataset.edit); if (!b) return;
      const name = prompt('Nama Bank:', b.bankName); if (name === null) return;
      const number = prompt('No. Rek:', b.accountNumber); if (number === null) return;
      const holder = prompt('A/N (Atas Nama):', b.holder); if (holder === null) return;
      const rr = await fetch('/api/admin/banks/' + b.id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bankName: name, accountNumber: number, holder }) });
      if (rr.ok) { toast('Rekening diperbarui ✅'); loadBanksAdmin(); } else { const dd = await rr.json().catch(()=>({})); toast(dd.error || 'Gagal'); }
    }));
    box.querySelectorAll('[data-toggle]').forEach(btn => btn.addEventListener('click', async () => {
      const rr = await fetch('/api/admin/banks/' + btn.dataset.toggle + '/toggle', { method:'POST' });
      if (rr.ok) { toast('Status rekening diubah ✅'); loadBanksAdmin(); }
    }));
    box.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Hapus rekening ini?')) return;
      const rr = await fetch('/api/admin/banks/' + btn.dataset.del, { method:'DELETE' });
      if (rr.ok) { toast('Rekening dihapus'); loadBanksAdmin(); }
    }));
  } catch (e) { box.textContent = 'Gagal: ' + e.message; }
}
$('bk-add').addEventListener('click', async () => {
  const bankName = $('bk-name').value.trim();
  const accountNumber = $('bk-number').value.trim();
  const holder = $('bk-holder').value.trim();
  $('bk-err').textContent = '';
  if (!bankName || !accountNumber || !holder) { $('bk-err').textContent = 'Nama Bank, No. Rek, dan A/N wajib diisi.'; return; }
  try {
    const r = await fetch('/api/admin/banks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ bankName, accountNumber, holder }) });
    const d = await r.json();
    if (!r.ok) { $('bk-err').textContent = d.error || 'Gagal simpan'; return; }
    $('bk-name').value = ''; $('bk-number').value = ''; $('bk-holder').value = '';
    toast('🏦 ' + bankName + ' disimpan ✅');
    loadBanksAdmin();
  } catch (e) { $('bk-err').textContent = 'Gagal: ' + e.message; }
});
// ---------- Payment Gateway (admin) — Aaron 14 Agu 2026 ----------
async function loadPaymentAdmin() {
  const box = $('pg-status'); if (!box) return;
  try {
    const r = await fetch('/api/admin/payment');
    if (r.status === 403) { box.innerHTML = '<i>Hanya admin.</i>'; return; }
    const d = await r.json();
    box.innerHTML = `
      <div class="stat-card"><div class="stat-label">⚡ Xendit</div><div class="stat-value" style="font-size:14px;">${d.xendit.hasKey ? '✅ Aktif' : '⛔ Belum aktif'}</div><div style="font-size:11px;color:var(--muted);">${d.xendit.hasKey ? maskKey(d.xendit.secretKeyMasked) : 'Masukkan secret key'}</div></div>
      <div class="stat-card"><div class="stat-label">💳 Midtrans</div><div class="stat-value" style="font-size:14px;">${d.midtrans.hasKey ? '✅ Aktif' : '⛔ Belum aktif'}</div><div style="font-size:11px;color:var(--muted);">${d.midtrans.hasKey ? maskKey(d.midtrans.serverKeyMasked) + (d.midtrans.isProduction ? ' · LIVE' : ' · Sandbox') : 'Masukkan server key'}</div></div>`;
    $('pg-xendit-badge').textContent = d.xendit.hasKey ? '✅ Aktif' : '⛔ Belum aktif';
    $('pg-xendit-badge').className = 'badge ' + (d.xendit.hasKey ? 'member' : '');
    $('pg-mid-badge').textContent = d.midtrans.hasKey ? (d.midtrans.isProduction ? '✅ LIVE' : '✅ Sandbox') : '⛔ Belum aktif';
    $('pg-mid-badge').className = 'badge ' + (d.midtrans.hasKey ? 'member' : '');
    $('pg-mid-prod').checked = !!d.midtrans.isProduction;
    if (d.webhookUrls) { if ($('pg-xendit-url')) $('pg-xendit-url').textContent = d.webhookUrls.xendit; if ($('pg-mid-url')) $('pg-mid-url').textContent = d.webhookUrls.midtrans; }
  } catch (e) { box.textContent = 'Gagal: ' + e.message; }
}
function maskKey(s) { return s || ''; }
$('pg-save').addEventListener('click', async () => {
  $('pg-err').textContent = ''; $('pg-ok').textContent = '';
  const body = {};
  const xk = $('pg-xendit-key').value.trim();
  const xw = $('pg-xendit-webhook').value.trim();
  const mk = $('pg-mid-key').value.trim();
  if (xk) body.xenditSecretKey = xk;
  if (xw) body.xenditWebhookToken = xw;
  if (mk) body.midtransServerKey = mk;
  body.midtransProduction = $('pg-mid-prod').checked;
  if (!xk && !xw && !mk) { $('pg-err').textContent = 'Isi minimal satu key dulu.'; return; }
  try {
    const r = await fetch('/api/admin/payment', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { $('pg-err').textContent = d.error || 'Gagal simpan'; return; }
    $('pg-ok').textContent = '✅ Payment gateway tersimpan (key terenkripsi)';
    $('pg-xendit-key').value = ''; $('pg-xendit-webhook').value = ''; $('pg-mid-key').value = '';
    loadPaymentAdmin();
  } catch (e) { $('pg-err').textContent = 'Gagal: ' + e.message; }
});

// ---------- Knowledge Base (admin & semua user) — Aaron 14 Agu 2026 ----------
let kbEditId = null;
function buildKbSectionHeader(icon, title, desc) {
  const h = document.createElement('div');
  h.style.cssText = 'margin:4px 0 10px;';
  h.innerHTML = `<div style="font-weight:900;font-size:14px;">${icon} ${escapeHtml(title)}</div><div style="font-size:11.5px;color:var(--muted);margin-top:2px;">${escapeHtml(desc)}</div>`;
  return h;
}
function buildKbCard(item, isAdmin) {
  const card = document.createElement('div');
  card.style.cssText = 'border:1px solid var(--border);border-radius:12px;background:var(--bg);overflow:hidden;' + (item.scope === 'whitelabel' ? 'border-color:rgba(240,192,64,.45);' : '');
  card.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--border);flex-wrap:wrap;">
      <span class="badge" style="background:rgba(124,92,255,.15);color:var(--accent2);">${escapeHtml(item.category)}</span>
      ${item.scope === 'whitelabel' ? '<span class="badge" style="background:rgba(240,192,64,.15);color:var(--gold);">🏷️ Whitelabel</span>' : ''}
      <div style="flex:1;font-weight:800;font-size:13.5px;">${escapeHtml(item.title)}</div>
      ${isAdmin ? `<button class="btn small" data-kb-edit="${item.id}">✏️ Edit</button><button class="btn small danger" data-kb-del="${item.id}">🗑</button>` : ''}
    </div>
    <pre style="white-space:pre-wrap;word-break:break-word;padding:12px 14px;font-family:monospace;font-size:12px;line-height:1.7;color:var(--muted);margin:0;">${escapeHtml(item.content)}</pre>
    <div style="padding:6px 14px;font-size:10.5px;color:var(--muted);border-top:1px solid var(--border);">Diperbarui: ${new Date(item.updatedAt).toLocaleString('id-ID')}</div>`;
  if (isAdmin) {
    card.querySelector('[data-kb-edit]').addEventListener('click', () => openKbForm(item));
    card.querySelector('[data-kb-del]').addEventListener('click', async () => {
      if (!confirm('Hapus prompt "' + item.title + '"?')) return;
      const rr = await fetch('/api/kb/' + item.id, { method:'DELETE' });
      if (rr.ok) { toast('Prompt dihapus'); loadKb(); } else toast('Gagal hapus');
    });
  }
  return card;
}
async function loadKb() {
  const box = $('kb-list'); if (!box) return;
  try {
    const r = await fetch('/api/kb');
    if (!r.ok) { box.innerHTML = '<i style="color:var(--muted);">Silakan login dulu.</i>'; return; }
    const d = await r.json();
    const items = d.items || [];
    const isAdmin = !!(me && me.role === 'admin');
    $('kb-add-btn').style.display = isAdmin ? '' : 'none';
    if (!items.length) { box.innerHTML = '<div style="color:var(--muted);font-size:13px;">Belum ada prompt tersimpan.</div>'; return; }
    box.innerHTML = '';
    // Section 1: Umum — proteksi & aturan inti
    const general = items.filter(i => i.scope !== 'whitelabel');
    if (general.length) {
      box.appendChild(buildKbSectionHeader('📚', 'Knowledge Base Umum', 'Proteksi & aturan inti agent — berlaku di semua pemakaian, termasuk whitelabel.'));
      general.forEach(item => box.appendChild(buildKbCard(item, isAdmin)));
    }
    // Section 2: Whitelabel — dipisah, di bawah
    const wl = items.filter(i => i.scope === 'whitelabel');
    if (wl.length) {
      const sep = document.createElement('div');
      sep.style.cssText = 'margin:22px 0 4px;border-top:2px dashed var(--border);';
      box.appendChild(sep);
      box.appendChild(buildKbSectionHeader('🏷️', 'Whitelabel', 'Khusus produk whitelabel (brand milik pembeli) — dipisah dari prompt umum biar tidak bercampur.'));
      wl.forEach(item => box.appendChild(buildKbCard(item, isAdmin)));
    }
  } catch (e) { box.textContent = 'Gagal: ' + e.message; }
}
function openKbForm(item) {
  kbEditId = item ? item.id : null;
  $('kb-scope').value = item ? (item.scope === 'whitelabel' ? 'whitelabel' : 'general') : 'general';
  $('kb-cat').value = item ? item.category : '';
  $('kb-title').value = item ? item.title : '';
  $('kb-content').value = item ? item.content : '';
  $('kb-err').textContent = '';
  $('kb-form-box').style.display = '';
  $('kb-add-btn').style.display = 'none';
  $('kb-title').focus();
}
function closeKbForm() {
  $('kb-form-box').style.display = 'none';
  kbEditId = null;
  $('kb-add-btn').style.display = (me && me.role === 'admin') ? '' : 'none';
}
$('kb-add-btn').addEventListener('click', () => openKbForm(null));
$('kb-cancel').addEventListener('click', closeKbForm);
$('kb-save').addEventListener('click', async () => {
  const scope = $('kb-scope').value === 'whitelabel' ? 'whitelabel' : 'general';
  const category = $('kb-cat').value.trim();
  const title = $('kb-title').value.trim();
  const content = $('kb-content').value.trim();
  $('kb-err').textContent = '';
  if (!title || !content) { $('kb-err').textContent = 'Judul dan isi wajib diisi.'; return; }
  try {
    const url = kbEditId ? '/api/kb/' + kbEditId : '/api/kb';
    const method = kbEditId ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body: JSON.stringify({ scope, category, title, content }) });
    const d = await r.json();
    if (!r.ok) { $('kb-err').textContent = d.error || 'Gagal simpan'; return; }
    toast('📚 Prompt disimpan ✅');
    closeKbForm();
    loadKb();
  } catch (e) { $('kb-err').textContent = 'Gagal: ' + e.message; }
});

// ---------- Modal Edit User (admin) — Aaron 14 Agu 2026 ----------
$('ue-cancel').addEventListener('click', () => { $('user-edit-modal').style.display = 'none'; });
$('ue-save').addEventListener('click', async () => {
  const modal = $('user-edit-modal');
  const uid = modal.dataset.uid;
  $('ue-ok').textContent = ''; $('ue-err').textContent = '';
  try {
    const rr = await fetch('/api/users/' + uid, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name: $('ue-name').value, role: $('ue-role').value, tier: $('ue-tier').value, city: $('ue-city').value, email: $('ue-email').value, phone: $('ue-phone').value }) });
    if (rr.ok) { $('ue-ok').textContent = '✅ User diperbarui'; setTimeout(() => { modal.style.display = 'none'; loadUserList(); }, 800); }
    else { const dd = await rr.json().catch(()=>({})); $('ue-err').textContent = dd.error || 'Gagal simpan'; }
  } catch (e) { $('ue-err').textContent = 'Gagal: ' + e.message; }
});
// ---------- Akuntansi Token (admin) — Aaron 14 Agu 2026 ----------
async function loadTokenAccounting() {
  try {
    const r = await fetch('/api/admin/token-accounting');
    if (r.status === 403) { $('acc-users').textContent = 'Hanya admin.'; return; }
    const d = await r.json();
    const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
    $('acc-month').textContent = d.month;
    $('acc-saldo').textContent = d.budget > 0 ? fmt(d.budget) : '— (belum diisi)';
    $('acc-used').textContent = fmt(d.used);
    $('acc-remaining').textContent = d.budget > 0 ? fmt(d.remaining) : '—';
    $('acc-percent').textContent = d.budget > 0 ? d.percent + '%' : '—';
    $('acc-projected').textContent = d.projected > 0 ? fmt(d.projected) : '—';
    $('acc-budget').value = d.budget > 0 ? d.budget : '';
    $('acc-note').value = d.note || '';
    const bar = $('acc-bar');
    if (bar) {
      bar.style.width = Math.min(100, d.percent) + '%';
      bar.style.background = d.percent >= 100 ? '#ff3b30' : d.percent >= 80 ? '#ff9f0a' : 'linear-gradient(135deg,var(--accent),var(--accent2))';
    }
    $('acc-warning').style.display = d.willRunOut ? '' : 'none';
    const box = $('acc-users');
    const us = d.users || [];
    if (!us.length) { box.innerHTML = '<i style="color:var(--muted);">Belum ada pemakaian bulan ini.</i>'; return; }
    box.innerHTML = '';
    const totalTokens = us.reduce((s, x) => s + (x.tokens || 0), 0) || 1;
    us.forEach(u => {
      const pct = Math.round((u.tokens || 0) * 100 / totalTokens);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border);flex-wrap:wrap;';
      row.innerHTML = `<div style="flex:1;min-width:140px;"><b>${escapeHtml(u.name || u.username)}</b> <span style="color:var(--muted);font-size:11px;">@${escapeHtml(u.username)}</span> <span class="badge">${escapeHtml(u.tier)}</span></div>
        <span style="font-size:12px;">${fmt(u.tokens)} token</span>
        <span style="font-size:11px;color:var(--muted);">${usdToRp(u.cost || 0)}</span>
        <span style="font-size:11px;color:var(--muted);">${pct}%</span>
        <div style="width:80px;height:6px;background:var(--bg2);border-radius:999px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--accent2);border-radius:999px;"></div></div>`;
      box.appendChild(row);
    });
  } catch (e) { $('acc-users').textContent = 'Gagal: ' + e.message; }
}
$('acc-save').addEventListener('click', async () => {
  const tokens = parseInt($('acc-budget').value, 10);
  if (isNaN(tokens) || tokens < 0) { alert('Isi jumlah token yang valid.'); return; }
  try {
    const r = await fetch('/api/admin/token-budget', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tokens, note: $('acc-note').value }) });
    const d = await r.json();
    if (r.ok) { toast('💰 Saldo token ' + d.month + ' disimpan: ' + Number(d.tokens).toLocaleString('id-ID')); loadTokenAccounting(); }
    else alert(d.error || 'Gagal simpan');
  } catch (e) { alert('Gagal: ' + e.message); }
});
// ---------- Faktor Jual & Simulasi Profit (admin) — Aaron 14 Agu 2026 ----------
let sfModels = [], sfKurs = 17876;
function fmtRp(n) { return 'Rp' + Math.round(n).toLocaleString('id-ID'); }
function renderSellFactorTable() {
  const factor = parseFloat($('sf-factor').value) || 6;
  const box = $('sf-table');
  if (!sfModels.length) { box.innerHTML = '<i style="color:var(--muted);">Belum ada data.</i>'; return; }
  let html = '<div style="background:var(--panel);border:1px solid var(--border);border-radius:12px;overflow:hidden;">';
  html += '<div style="display:flex;padding:10px 12px;background:var(--bg2);font-weight:800;font-size:11px;color:var(--muted);"><div style="flex:1;">Model</div><div style="width:110px;text-align:right;">Cost riil</div><div style="width:130px;text-align:right;">Potongan ×' + factor + '</div><div style="width:130px;text-align:right;color:var(--ok);">PROFIT</div><div style="width:70px;text-align:right;">Margin</div></div>';
  sfModels.forEach(m => {
    const cost = (0.7 * m.input + 0.3 * m.output) * sfKurs;
    const potong = cost * factor;
    const profit = potong - cost;
    html += `<div style="display:flex;padding:9px 12px;border-top:1px solid var(--border);align-items:center;font-size:12px;"><div style="flex:1;font-weight:700;">${escapeHtml(m.name)}</div><div style="width:110px;text-align:right;color:var(--muted);">${fmtRp(cost)}</div><div style="width:130px;text-align:right;">${fmtRp(potong)}</div><div style="width:130px;text-align:right;color:var(--ok);font-weight:800;">${fmtRp(profit)}</div><div style="width:70px;text-align:right;color:var(--muted);">${((factor - 1) / factor * 100).toFixed(1)}%</div></div>`;
  });
  html += '</div>';
  box.innerHTML = html;
}
async function loadSellFactor() {
  try {
    const r = await fetch('/api/admin/sellfactor');
    if (r.status === 403) { $('sf-table').textContent = 'Hanya admin.'; return; }
    const d = await r.json();
    $('sf-factor').value = d.factor || 6;
    sfModels = d.models || [];
    sfKurs = d.kurs || 17876;
    USD_RATE = sfKurs; // sinkronkan kurs global (standar Rp semua menu)
    if ($('sf-kurs')) $('sf-kurs').value = sfKurs;
    if ($('sf-kurs-label')) $('sf-kurs-label').textContent = Number(sfKurs).toLocaleString('id-ID');
    $('sf-info').textContent = 'Faktor aktif: ' + (d.factor || 6) + '× · margin ' + (((d.factor || 6) - 1) / (d.factor || 6) * 100).toFixed(1) + '% · kurs Rp' + Number(sfKurs).toLocaleString('id-ID') + '/USD · diupdate: ' + (d.factorUpdatedAt ? new Date(d.factorUpdatedAt).toLocaleString('id-ID') : 'belum');
    renderSellFactorTable();
  } catch (e) { $('sf-table').textContent = 'Gagal: ' + e.message; }
}
$('sf-factor').addEventListener('input', renderSellFactorTable);
if ($('sf-kurs')) $('sf-kurs').addEventListener('input', () => {
  const k = parseFloat($('sf-kurs').value);
  if (!isNaN(k) && k > 0) { sfKurs = k; renderSellFactorTable(); }
});
$('sf-save').addEventListener('click', async () => {
  const factor = parseFloat($('sf-factor').value);
  if (isNaN(factor) || factor < 1 || factor > 100) { alert('Faktor harus 1-100.'); return; }
  const kurs = parseFloat($('sf-kurs') ? $('sf-kurs').value : '');
  try {
    const body = { factor };
    if (!isNaN(kurs) && kurs > 0) body.kurs = kurs;
    const r = await fetch('/api/admin/sellfactor', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const d = await r.json();
    if (r.ok) { toast('⚙️ Faktor jual disimpan: ' + d.factor + '× (margin ' + ((d.factor - 1) / d.factor * 100).toFixed(1) + '%)' + (d.kurs ? ' · kurs Rp' + Number(d.kurs).toLocaleString('id-ID') : '')); loadSellFactor(); }
    else alert(d.error || 'Gagal simpan');
  } catch (e) { alert('Gagal: ' + e.message); }
});
// ---------- Credit & Pemakaian (user) — Aaron 14 Agu 2026 ----------
async function loadCreditPage() {
  try {
    const r = await fetch('/api/me');
    const d = await r.json();
    if (!d.authed) return;
    const q = d.quota || { dailyTokens: 50000, usedToday: 0, percent: 0, overLimit: false, credit: 0 };
    const pct = q.percent || 0;
    $('cr-daily').textContent = Number(q.dailyTokens || 0).toLocaleString('id-ID');
    $('cr-used').textContent = Number(q.usedToday || 0).toLocaleString('id-ID');
    $('cr-balance').textContent = 'Rp' + Number(q.credit || 0).toLocaleString('id-ID');
    const bar = $('cr-bar');
    bar.style.width = Math.min(100, pct) + '%';
    bar.style.background = pct > 90 ? '#ff3b30' : pct >= 70 ? '#ff9f0a' : 'linear-gradient(135deg,var(--accent),var(--accent2))';
    $('cr-status').textContent = q.overLimit ? (q.credit > 0 ? 'Pakai credit ⚡' : 'Jatah habis ⛔') : pct >= 70 ? 'Menipis 🟠' : 'Aman 🟢';
    $('cr-note').textContent = q.overLimit
      ? (q.credit > 0 ? '✅ Jatah harian habis — pemakaian lanjut dipotong dari credit anda.' : '⛔ Jatah harian habis. Beli credit di bawah untuk melanjutkan project.')
      : 'Sisa jatah hari ini: ' + Number(Math.max(0, (q.dailyTokens || 0) - (q.usedToday || 0))).toLocaleString('id-ID') + ' token.';
    // Riwayat top-up credit
    const or = await fetch('/api/orders');
    const od = await or.json();
    const cr = (od.orders || []).filter(x => x.tier === 'credit').slice(0, 10);
    const box = $('cr-history');
    if (!cr.length) { box.innerHTML = '<i style="color:var(--muted);">Belum ada top-up credit.</i>'; return; }
    const st = { pending: '⏳ Menunggu bayar', awaiting: '🕐 Menunggu verifikasi', paid: '✅ Masuk', rejected: '❌ Ditolak', expired: '⏰ Kadaluarsa' };
    box.innerHTML = cr.map(x => `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">
      <span>➕ <b>Rp${Number(x.totalAmount).toLocaleString('id-ID')}</b></span>
      <span style="color:var(--muted);font-size:11px;">${x.id} · ${st[x.status] || x.status} ${x.status === 'pending' ? `<a href="/thankyou?order=${x.id}" style="font-size:11px;">bayar →</a>` : ''}</span>
    </div>`).join('');
  } catch (e) { $('cr-history').textContent = 'Gagal: ' + e.message; }
}


// ---------- Panah ke bawah (chat) — Aaron 14 Agu 2026 ----------
function initScrollDown() {
  const chat = $('chat');
  const btn = $('scroll-down');
  if (!chat || !btn) return;
  const check = () => {
    const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200;
    btn.style.display = nearBottom ? 'none' : '';
  };
  chat.addEventListener('scroll', check, { passive: true });
  btn.addEventListener('click', () => { chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' }); });
  setTimeout(check, 800);
}
// ---------- Branding Platform (admin) — Aaron 14 Agu 2026 ----------
async function loadBranding() {
  try {
    const r = await fetch('/api/branding');
    const d = await r.json();
    $('br-name').value = d.productName || 'COBLAI';
    $('br-tagline').value = d.tagline || '';
  } catch (e) {}
}
$('br-save').addEventListener('click', async () => {
  $('br-ok').textContent = ''; $('br-err').textContent = '';
  try {
    const r = await fetch('/api/admin/branding', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ productName: $('br-name').value, tagline: $('br-tagline').value }) });
    const d = await r.json();
    if (r.ok) { $('br-ok').textContent = '✅ Branding disimpan: ' + d.branding.productName; }
    else $('br-err').textContent = d.error || 'Gagal';
  } catch (e) { $('br-err').textContent = 'Gagal: ' + e.message; }
});
// ---------- Branding dinamis (login & sidebar) — Aaron 14 Agu 2026 ----------
// Identitas global (diisi applyBranding) — dipakai untuk sapaan & placeholder yang konsisten
let agentName = 'Dinda';
let productName = 'COBLAI';
async function applyBranding() {
  try {
    const r = await fetch('/api/branding', { cache: 'no-store' });
    const d = await r.json();
    if (!d) return;
    if (d.productName) {
      productName = d.productName;
      const lb = $('login-brand-name'); if (lb) lb.textContent = d.productName;
      const sb = $('side-brand-name'); if (sb) sb.textContent = d.productName;
      document.title = d.productName;
      // Logo & favicon dinamis (whitelabel)
      const logoUrls = d.logoUrl ? d.logoUrl + '?v=' + Date.now() : '';
      const sl = $('side-brand-logo'); if (sl) { sl.src = logoUrls; sl.style.display = d.logoUrl ? '' : 'none'; }
      const ll = $('login-brand-logo'); if (ll) { ll.src = logoUrls; ll.style.display = d.logoUrl ? '' : 'none'; }
      if (d.faviconUrl) {
        let link = document.querySelector("link[rel='icon']");
        if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
        link.href = d.faviconUrl + '?v=' + Date.now();
      }
    }
    if (d.agentName) {
      agentName = d.agentName;
      applyAgentName();
    } else {
      // Fallback: backend lama belum menyertakan agentName → ambil dari botconfig (admin) / default
      try {
        const rb = await fetch('/api/admin/botconfig', { cache: 'no-store' });
        if (rb.ok) { const db = await rb.json(); if (db.bot && db.bot.agentName) { agentName = db.bot.agentName; applyAgentName(); } }
      } catch (e) {}
    }
  } catch (e) {}
}
function applyAgentName() {
  const an = agentName || 'Dinda';
  const ph = $('message');
  if (ph) ph.placeholder = 'Ketik pesan ke ' + an + '... (Enter kirim, Shift+Enter baris baru)';
  const greet = document.querySelector('#messages .msg.assistant .bubble');
  if (greet && !window.__chatStarted) {
    const nm = (me && (me.name || me.username)) ? escapeHtml(me.name || me.username) : 'Bos';
    greet.innerHTML = 'Halo ' + nm + '! 👋 Aku <b>' + escapeHtml(an) + '</b> — siap bantu kamu. Ketik perintahmu di bawah, atau upload file untuk dianalisa. File yang kubuat akan muncul di panel artefak.';
  }
}
// ---------- Kupon di Beli Credit — Aaron 14 Agu 2026 ----------
let crDiscount = 0, crCoupon = null;
$('cr-coupon-check').addEventListener('click', async () => {
  const code = $('cr-coupon').value.trim().toUpperCase();
  $('cr-err').textContent = ''; $('cr-ok').textContent = '';
  if (!code) { $('cr-err').textContent = 'Masukkan kode kupon dulu.'; return; }
  try {
    const r = await fetch('/api/coupons/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code, tier: 'premium', months: 1 }) });
    const d = await r.json();
    if (!r.ok) { $('cr-err').textContent = d.error || 'Kupon tidak valid'; crDiscount = 0; crCoupon = null; $('cr-price').textContent = ''; return; }
    crCoupon = code; crDiscount = d.discountPct;
    $('cr-price').textContent = '✅ Kupon valid — diskon ' + d.discountPct + '%. Contoh: beli Rp20.000 credit → bayar Rp' + (20000 - Math.round(20000 * d.discountPct / 100)).toLocaleString('id-ID') + ' (credit masuk sesuai yang dibayar).';
  } catch (e) { $('cr-err').textContent = 'Gagal cek kupon.'; }
});
// Submit paket credit dengan kupon
document.querySelectorAll('[data-cr]').forEach(btn => {
  if (btn._creditHooked) return;
  btn._creditHooked = true;
  btn.addEventListener('click', async () => {
    const amount = parseInt(btn.dataset.cr, 10);
    $('cr-ok').textContent = ''; $('cr-err').textContent = '';
    btn.disabled = true; btn.textContent = 'Memproses...';
    try {
      const r = await fetch('/api/orders', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ creditAmount: amount, couponCode: crCoupon || undefined }) });
      const d = await r.json();
      if (!r.ok) { $('cr-err').textContent = d.error || 'Gagal'; btn.disabled = false; return; }
      window.location.href = '/thankyou?order=' + d.order.id;
    } catch (e) { $('cr-err').textContent = 'Gagal: ' + e.message; btn.disabled = false; }
  });
});

// === Quotes/Reply (Papi 1 Sep 2026): blok teks di pesan -> tombol -> kutipan masuk input ===
(function () {
  let qBtn = null;
  function hideQ() { if (qBtn) { qBtn.remove(); qBtn = null; } }
  function showQ(x, y, txt) {
    hideQ();
    const b = document.createElement('button');
    b.textContent = '💬 Quotes / Reply';
    b.title = 'Sisipkan kalimat terpilih sebagai kutipan, lalu ketik balasanmu';
    b.style.cssText = 'position:fixed;z-index:99999;left:' + x + 'px;top:' + y + 'px;' +
      'background:var(--accent,#7c3aed);color:#fff;border:none;border-radius:20px;padding:7px 14px;' +
      'font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.45);' +
      'font-family:inherit;pointer-events:auto;';
    b.addEventListener('mousedown', function (ev) { ev.preventDefault(); ev.stopPropagation(); });
    b.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      const clean = txt.replace(/\s+/g, ' ').trim();
      const quote = '> "' + clean + '"\n\n';
      const el = document.getElementById('message');
      if (el) {
        const start = el.selectionStart || el.value.length;
        el.value = el.value.slice(0, start) + quote + el.value.slice(el.selectionEnd || start);
        el.focus();
        const pos = start + quote.length;
        el.setSelectionRange(pos, pos);
        if (typeof autoGrow === 'function') autoGrow();
        if (typeof toast === 'function') toast('Kalimat dikutip — lanjut ketik balasanmu');
      }
      hideQ();
    });
    document.body.appendChild(b);
    qBtn = b;
    setTimeout(function () {
      document.addEventListener('click', function h(e2) {
        if (!b.contains(e2.target)) { hideQ(); document.removeEventListener('click', h); }
      });
    }, 10);
  }
  document.addEventListener('mouseup', function () {
    setTimeout(function () {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { hideQ(); return; }
      const txt = sel.toString();
      if (!txt || !txt.trim()) { hideQ(); return; }
      const anchor = sel.anchorNode;
      if (!anchor || !anchor.parentElement) return;
      if (!anchor.parentElement.closest('#messages')) return;
      const r = sel.getRangeAt(0).getBoundingClientRect();
      showQ(r.left + window.scrollX, r.top + window.scrollY - 42, txt);
    }, 10);
  });
  document.addEventListener('scroll', function () { hideQ(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideQ(); });
})();
