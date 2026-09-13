import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Tools } from './Tools';
import type { Message, Session, User } from './types';

const starterPrompts = ['Tinjau kode saya dan temukan masalahnya', 'Buatkan rencana implementasi fitur ini', 'Rangkum dokumen yang saya kirim', 'Bantu saya melakukan riset mendalam'];

function App() {
  const [user, setUser] = useState<User | null>(null); const [toolsOpen, setToolsOpen] = useState(false); const [projectId, setProjectId] = useState<string | null>(null); const [workspaceId, setWorkspaceId] = useState<string | null>(null); const [settingsOpen, setSettingsOpen] = useState(false); const [sessions, setSessions] = useState<Session[]>([]); const [current, setCurrent] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([]); const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false); const [sidebar, setSidebar] = useState(false); const [authOpen, setAuthOpen] = useState(false); const [notifOpen, setNotifOpen] = useState(false); const [notifItems, setNotifItems] = useState<{ id: string; kind: string; title: string; body: string | null; readAt: string | null; createdAt: string }[]>([]); const [notifUnread, setNotifUnread] = useState(0); const [banner, setBanner] = useState(''); const [resetToken, setResetToken] = useState<string | null>(null); const [authMode, setAuthMode] = useState<'login'|'register'>('login'); const [error, setError] = useState(''); const [online, setOnline] = useState(true); const [notice, setNotice] = useState(''); const [query, setQuery] = useState(''); const [activeRun, setActiveRun] = useState<string | null>(null); const endRef = useRef<HTMLDivElement>(null);
  const hasChat = Boolean(current || messages.length);
  const visibleSessions = useMemo(() => sessions.filter(s => (s.name || '').toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))), [sessions, query]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const path = window.location.pathname;
    if (token && (path.includes('verify-email') || params.get('verify') === '1')) {
      api.verifyEmail(token).then(() => setBanner('Email Anda sudah terverifikasi.')).catch((e) => setBanner((e as Error).message));
    } else if (token && (path.includes('reset-password') || params.get('reset') === '1')) {
      setResetToken(token);
    }
    api.me().then(d => { setUser(d.user); setOnline(true); loadSessions().catch(() => setOnline(false)); void loadNotifications(); }).catch(() => { setOnline(false); });
  }, []);
  async function loadNotifications() { try { const data = await api.notifications(); setNotifItems(data.notifications || []); setNotifUnread(data.unread || 0); } catch { /* belum masuk */ } }
  async function markAllRead() { try { await api.readAllNotifications(); await loadNotifications(); } catch (e) { setError((e as Error).message); } }
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  async function loadSessions() { try { const ws = (await api.workspaces())[0]; if (!ws) return; setWorkspaceId(ws.id); const projects = (await api.projects(ws.id)); const project = projects[0]; if (!project) return; setProjectId(project.id); const d = await api.chatSessions(project.id); setSessions(d || []); } catch { setOnline(false); } }
  async function renameSession(s: Session) { const title = window.prompt('Judul percakapan', s.name || ''); if (title === null) return; try { await api.renameSession(s.id, title.trim() || 'Percakapan baru', s.pinned); await loadSessions(); } catch (e) { setError((e as Error).message); } }
  async function pinSession(s: Session) { try { await api.renameSession(s.id, s.name || 'Percakapan baru', !s.pinned); await loadSessions(); } catch (e) { setError((e as Error).message); } }
  async function removeSession(s: Session) { if (!window.confirm(`Hapus percakapan "${s.name || 'Percakapan baru'}"?`)) return; try { await api.deleteSession(s.id); if (current === s.id) { setCurrent(null); setMessages([]); } await loadSessions(); setNotice('Percakapan dihapus.'); } catch (e) { setError((e as Error).message); } }
  async function exportSession(s: Session) { try { const payload = await api.exportSession(s.id); const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${(s.name || 'percakapan').replace(/[^\w.-]+/g, '-')}.json`; link.click(); URL.revokeObjectURL(url); } catch (e) { setError((e as Error).message); } }
  async function importSession(file: File) {
    if (!projectId) { setError('Proyek belum siap.'); return; }
    try {
      const payload = JSON.parse(await file.text());
      const imported = await api.importSession(projectId, { title: payload?.conversation?.title ?? file.name, messages: payload?.messages ?? [] });
      await loadSessions(); setNotice(`Percakapan "${imported.conversation.title}" diimpor.`);
    } catch (e) { setError(`Impor gagal: ${(e as Error).message}`); }
  }
  async function stopRun() { if (!activeRun) return; try { await api.cancelRun(activeRun); setNotice('Permintaan berhenti dikirim.'); } catch (e) { setError((e as Error).message); } }

  async function newChat() { if (!user) { setAuthOpen(true); return; } try { if (!projectId) { await loadSessions(); } const d = await api.createSession(projectId!, 'Percakapan baru'); setSessions(s => [d.conversation, ...s]); setCurrent(d.conversation.id); setMessages([]); setSidebar(false); } catch (e) { setError((e as Error).message); } }
  async function switchSession(session: Session) { setCurrent(session.id); setSidebar(false); try { const d = await api.messages(session.id); setMessages(d.messages || []); } catch (e) { setError((e as Error).message); } }
  const [mfaNeeded, setMfaNeeded] = useState(false);
  const [model, setModel] = useState('');
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    // The catalogue comes from the engine itself, so an empty list means the picker stays hidden.
    api.models().then(data => {
      const options = [{ value: '', label: data.default.model ? `Bawaan (${data.default.model})` : 'Model bawaan' }].concat(data.models.map(row => ({ value: row.model, label: `${row.provider} · ${row.model}` })));
      setModelOptions(options);
      const stored = localStorage.getItem('coblai.model') || '';
      if (stored && data.models.some(row => row.model === stored)) setModel(stored);
    }).catch(() => setModelOptions([]));
  }, []);

  async function send(text = prompt) { const content = text.trim(); if (!content || busy) return; if (!user) { setAuthOpen(true); return; } let sessionId = current; if (!sessionId) { await newChat(); sessionId = current; } if (!sessionId) return; setPrompt(''); setMessages(m => [...m, { role: 'user', content }]); setBusy(true); try { const response = await api.sendMessage(sessionId, content, model || undefined); setActiveRun(response.run.id); setMessages(m => [...m, { role: 'assistant', content: '' }]); const source = new EventSource(`/api/v1/runs/${response.run.id}/events`); let answer = ''; source.onmessage = event => { try { const data = JSON.parse(event.data); const delta = data.data?.delta || data.data || ''; if (data.type === 'text' && typeof delta === 'string') { answer += delta; setMessages(m => [...m.slice(0, -1), { role: 'assistant', content: answer }]); } if (['completed', 'failed', 'cancelled'].includes(data.type)) { source.close(); setBusy(false); setActiveRun(null); } } catch { /* ignore heartbeat */ } }; source.onerror = () => { source.close(); setBusy(false); setActiveRun(null); }; } catch (e) { setMessages(m => [...m, { role: 'assistant', content: `Terjadi kendala: ${(e as Error).message}` }]); setBusy(false); } }
  async function submitAuth(username: string, password: string, name: string, code = '') {
    try {
      const d = authMode === 'login' ? await api.login(username, password, code || undefined) : await api.register(username, password, name);
      setUser(d.user); setAuthOpen(false); setMfaNeeded(false); setError('');
    } catch (e) {
      // The API asks for a second factor with MFA_REQUIRED; the form then shows the code field.
      const message = (e as Error).message;
      setMfaNeeded(message.includes('MFA_REQUIRED') || message.includes('MFA_INVALID_CODE'));
      // Error codes from the API are shown as plain Indonesian sentences.
      const friendly: Record<string, string> = {
        INVALID_CREDENTIALS: 'Email/username atau kata sandi salah.',
        EMAIL_EXISTS: 'Email ini sudah terdaftar. Silakan masuk.',
        LOGIN_RATE_LIMITED: 'Terlalu banyak percobaan masuk. Tunggu beberapa menit lalu coba lagi.',
        INVALID_REGISTRATION: 'Pendaftaran gagal. Periksa email dan kata sandi (minimal 10 karakter).',
        MFA_INVALID_CODE: 'Kode verifikasi salah. Coba lagi.',
        MFA_REQUIRED: 'Masukkan kode verifikasi 6 angka dari aplikasi authenticator Anda.',
      };
      const code = Object.keys(friendly).find(key => message.includes(key));
      setError(code ? friendly[code] : message);
    }
  }
  async function logout() { await api.logout().catch(() => undefined); setUser(null); setSessions([]); setCurrent(null); setMessages([]); }
  return <div className="app-shell min-h-screen">
    <header className="topbar"><div className="brand"><button className="icon-button mobile-only" onClick={() => setSidebar(v => !v)}>☰</button><div className="brand-mark">C</div><div><div className="brand-name">COBLAI</div><div className="brand-sub">CODER WORKSPACE</div></div></div><div className="top-actions"><span className={`connection ${online ? 'ok' : ''}`}><i />{online ? 'Terhubung' : 'Mode lokal'}</span><button className="new-button desktop-only" onClick={newChat}>＋ Chat baru</button><div className="bell-wrap"><button className="icon-button" title="Notifikasi" onClick={() => { setNotifOpen(v => !v); void loadNotifications(); }}>🔔{notifUnread > 0 && <span className="bell-count">{notifUnread > 9 ? '9+' : notifUnread}</span>}</button>{notifOpen && <div className="bell-panel"><div className="bell-head"><strong>Notifikasi</strong><button type="button" className="link-button" onClick={markAllRead}>Tandai semua dibaca</button></div>{notifItems.length === 0 && <p className="settings-hint">Belum ada notifikasi.</p>}{notifItems.slice(0, 12).map(item => <button type="button" key={item.id} className={`bell-item ${item.readAt ? '' : 'unread'}`} onClick={() => { if (item.readAt) return; void api.readNotification(item.id).then(loadNotifications).catch(() => undefined); }}><strong>{item.title}</strong>{item.body && <span>{item.body}</span>}<em>{new Date(item.createdAt).toLocaleString('id-ID')}{item.readAt ? '' : ' · baru'}</em></button>)}</div>}</div><button className="profile-button" onClick={() => user ? setSettingsOpen(true) : setAuthOpen(true)}>{(user?.displayName || user?.name || user?.email || '?')[0].toUpperCase()}</button></div></header>
    <div className="workspace"><aside className={`sidebar ${sidebar ? 'open' : ''}`}><button className="new-chat" onClick={newChat}>＋ Percakapan baru</button><div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Cari percakapan" /></div><div className="section-label">WORKSPACE <span>{visibleSessions.length}</span></div><nav className="session-list">{visibleSessions.map(s => <div className={`session-row ${current === s.id ? 'active' : ''}`} key={s.id}><button className={`session ${current === s.id ? 'active' : ''}`} onClick={() => switchSession(s)}><span>{s.pinned ? '◆' : '◇'}</span><b>{s.name || 'Percakapan baru'}</b><small>{s.lastUsed ? new Date(s.lastUsed).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : ''}</small></button><div className="session-actions"><button title="Ganti nama" onClick={() => renameSession(s)}>✎</button><button title={s.pinned ? 'Lepas pin' : 'Pin'} onClick={() => pinSession(s)}>◆</button><button title="Ekspor" onClick={() => exportSession(s)}>↓</button><button title="Hapus" onClick={() => removeSession(s)}>✕</button></div></div>)}{!visibleSessions.length && <div className="empty-side">Belum ada percakapan</div>}</nav><div className="sidebar-bottom"><button onClick={() => user ? setToolsOpen(true) : setAuthOpen(true)}>▦ Knowledge & workflow</button><button onClick={() => user ? setSettingsOpen(true) : setAuthOpen(true)}>⚙ Pengaturan & akun</button>{user && <button className="logout" onClick={logout}>Keluar</button>}</div></aside>
    <main className="main"><section className={`conversation ${hasChat ? 'has-chat' : ''}`}>{!hasChat ? <div className="welcome"><span className="eyebrow">✦ RUANG KERJA AI UNTUK MEMBANGUN LEBIH CEPAT</span><h1>Apa yang ingin<br /><em>Anda kerjakan?</em></h1><p>Tulis ide, kirim kode, atau unggah dokumen. COBLAI membantu Anda dari rencana sampai hasil.</p><div className="starter-grid">{starterPrompts.map((p, i) => <button key={p} onClick={() => { setPrompt(p); }}>{p}<strong>{['⌘','↗','▤','⌁'][i]}</strong></button>)}</div></div> : <div className="messages">{messages.map((m, i) => <article className={`message ${m.role}`} key={`${i}-${m.content.slice(0, 8)}`}><div className="message-author">{m.role === 'user' ? 'ANDA' : 'DINDA'}</div><div className="bubble">{m.content || (busy ? 'Dinda sedang bekerja…' : '')}</div></article>)}{busy && <div className="typing"><i /><i /><i /> Dinda sedang bekerja</div>}<div ref={endRef} /></div>}</section><div className="composer-wrap"><form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Tulis pesan untuk Dinda…" rows={1} /><div className="composer-actions">{modelOptions.length > 0 && <label className="model-picker" title="Model AI untuk pesan berikutnya">⚙<select value={model} onChange={e => { setModel(e.target.value); localStorage.setItem('coblai.model', e.target.value); }}>{modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}<label className="upload-button" title="Impor percakapan (JSON)">＋<input type="file" accept=".json" onChange={e => { const file = e.target.files?.[0]; if (file) void importSession(file); e.target.value = ''; }} /></label>{busy && <button type="button" className="stop" title="Hentikan" onClick={stopRun}>■ Berhenti</button>}<span>Enter untuk kirim · Shift+Enter untuk baris baru</span><button className="send" disabled={!prompt.trim() || busy}>↑</button></div></form><small>AI dapat membuat kesalahan. Periksa hasil sebelum digunakan.</small></div></main></div>{banner && <button className="toast notice-toast" onClick={() => setBanner('')}>{banner}</button>}{error && <button className="toast" onClick={() => setError('')}>{error}</button>}{notice && <button className="toast notice-toast" onClick={() => setNotice('')}>{notice}</button>}{toolsOpen && projectId && <Tools projectId={projectId} workspaceId={workspaceId} onClose={() => setToolsOpen(false)} />} {settingsOpen && user && <Settings user={user} workspaceId={workspaceId} onClose={() => setSettingsOpen(false)} onLogout={logout} />} {resetToken && <ResetPassword token={resetToken} onClose={() => { setResetToken(null); window.history.replaceState({}, '', '/'); }} onDone={(msg) => { setResetToken(null); window.history.replaceState({}, '', '/'); setBanner(msg); setAuthMode('login'); setAuthOpen(true); }} />} {authOpen && <Auth mode={authMode} onClose={() => setAuthOpen(false)} onSwitch={() => { setAuthMode(v => v === 'login' ? 'register' : 'login'); setError(''); }} onSubmit={submitAuth} error={error} mfaNeeded={mfaNeeded} />}</div>;
}

function Settings({ user, workspaceId, onClose, onLogout }: { user: User; workspaceId: string | null; onClose: () => void; onLogout: () => void }) {
  const [current, setCurrent] = useState(''); const [next, setNext] = useState('');
  const [message, setMessage] = useState(''); const [problem, setProblem] = useState('');
  const [sessions, setSessions] = useState<{ id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; userAgent: string | null; current: boolean }[]>([]);
  const [mfa, setMfa] = useState<{ enabled: boolean; pendingSetup: boolean } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState(''); const [disablePassword, setDisablePassword] = useState(''); const [disableCode, setDisableCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [limits, setLimits] = useState({ daily: '', monthly: '', perHour: '' });
  const [admin, setAdmin] = useState<any | null>(null); const [adminUsers, setAdminUsers] = useState<any[]>([]);
  async function refresh() {
    try { setSessions(await api.sessions()); } catch { setSessions([]); }
    try { setMfa(await api.mfaStatus()); } catch { setMfa(null); }
    try { const me = await api.me(); setEmailVerified(Boolean((me.user as { emailVerified?: boolean }).emailVerified)); } catch { setEmailVerified(null); }
    try { const overview = await api.adminOverview(); setAdmin(overview); const people = await api.adminUsers(); setAdminUsers(people); } catch { setAdmin(null); setAdminUsers([]); }
    try { const rows = workspaceId ? await api.adminWorkspaces().catch(() => []) : []; const mine = Array.isArray(rows) ? rows.find((row: any) => row.id === workspaceId) : null; if (mine) setLimits({ daily: mine.dailyCostLimitMicros ? String(mine.dailyCostLimitMicros) : '', monthly: mine.monthlyCostLimitMicros ? String(mine.monthlyCostLimitMicros) : '', perHour: mine.runsPerHourLimit ? String(mine.runsPerHourLimit) : '' }); } catch { /* batas bersifat opsional */ }
  }
  useEffect(() => { void refresh(); }, []);
  function run(action: () => Promise<void>) { setMessage(''); setProblem(''); void action().catch((e) => setProblem((e as Error).message)); }
  return <div className="modal-backdrop"><section className="auth-card settings-card"><button type="button" className="close" onClick={onClose}>×</button><span className="eyebrow">AKUN &amp; WORKSPACE</span><h2>Pengaturan</h2>
    <label>Nama tampilan<input readOnly value={user.displayName || user.name || ''} /></label><label>Email<input readOnly value={user.email} /></label>
    <div className="settings-meta"><span>Status akun</span><strong>Aktif</strong></div><div className="settings-meta"><span>Role</span><strong>{user.role || 'member'}</strong></div>
    <h3 className="settings-heading">Verifikasi email</h3>
    <div className="settings-meta"><span>Status email</span><strong>{emailVerified === null ? 'tidak diketahui' : emailVerified ? 'terverifikasi' : 'belum terverifikasi'}</strong></div>
    {emailVerified === false && <button type="button" onClick={() => run(async () => { const result = await api.requestEmailVerification(); setMessage(result.sent ? 'Email verifikasi sudah dikirim.' : result.reason === 'EMAIL_NOT_CONFIGURED' ? 'Server email belum dikonfigurasi, jadi tautan verifikasi belum bisa dikirim.' : `Gagal mengirim email (${result.reason ?? 'tidak diketahui'}).`); })}>Kirim ulang email verifikasi</button>}
    <h3 className="settings-heading">Batas pemakaian workspace</h3>
    <p className="settings-hint">Kosongkan untuk tanpa batas. Biaya dalam micro-USD (1 USD = 1.000.000).</p>
    <label>Batas biaya harian<input inputMode="numeric" value={limits.daily} onChange={e => setLimits(v => ({ ...v, daily: e.target.value }))} /></label>
    <label>Batas biaya 30 hari<input inputMode="numeric" value={limits.monthly} onChange={e => setLimits(v => ({ ...v, monthly: e.target.value }))} /></label>
    <label>Batas jumlah run per hari<input inputMode="numeric" value={limits.perHour} onChange={e => setLimits(v => ({ ...v, perHour: e.target.value }))} /></label>
    <button type="button" onClick={() => run(async () => { if (!workspaceId) throw new Error('Workspace belum dipilih.'); const num = (value: string) => value.trim() === '' ? null : Number(value); await api.workspaceLimits(workspaceId, { dailyCostLimitMicros: num(limits.daily), monthlyCostLimitMicros: num(limits.monthly), runsPerHourLimit: num(limits.perHour) }); setMessage('Batas pemakaian disimpan.'); })}>Simpan batas</button>
    <h3 className="settings-heading">Ganti password</h3>
    <label>Password sekarang<input type="password" value={current} onChange={e => setCurrent(e.target.value)} /></label>
    <label>Password baru (minimal 10 karakter)<input type="password" value={next} onChange={e => setNext(e.target.value)} /></label>
    {admin && <><h3 className="settings-heading">Admin platform</h3><div className="settings-meta"><span>Pengguna / workspace</span><strong>{admin.totals?.users} / {admin.totals?.workspaces}</strong></div><div className="settings-meta"><span>Run total</span><strong>{admin.totals?.runs}</strong></div><div className="settings-meta"><span>Biaya total</span><strong>${admin.usage?.costUsd ?? 0}</strong></div><div className="settings-meta"><span>Biaya 24 jam</span><strong>${admin.today?.costUsd ?? 0} ({admin.today?.runs ?? 0} run)</strong></div><div className="settings-meta"><span>Versi skema DB</span><strong>{admin.schemaVersion}</strong></div><div className="settings-meta"><span>Engine</span><strong>{admin.engine?.available ? `siap (${admin.engine?.version ?? '-'})` : 'tidak siap'}</strong></div><ul className="session-list">{adminUsers.slice(0, 20).map((row: any) => <li key={row.id}><div><strong>{row.email}</strong><span className="settings-hint">{row.displayName} · {row.workspaces} workspace · {row.sessions} sesi{row.isAdmin ? ' · admin' : ''}</span></div><button type="button" onClick={() => run(async () => { await api.setAdmin(row.id, !row.isAdmin); const people = await api.adminUsers(); setAdminUsers(people); setMessage(row.isAdmin ? 'Akses admin dicabut.' : 'Akses admin diberikan.'); })}>{row.isAdmin ? 'Cabut admin' : 'Jadikan admin'}</button></li>)}</ul></>}
    <button type="button" className="primary" onClick={() => run(async () => { await api.changePassword(current, next); setCurrent(''); setNext(''); setMessage('Password diganti. Sesi lain sudah dikeluarkan.'); await refresh(); })}>Simpan password</button>
    <h3 className="settings-heading">Perangkat &amp; sesi aktif</h3>
    <ul className="session-list">{sessions.map(row => <li key={row.id}><div><strong>{row.userAgent ? row.userAgent.slice(0, 48) : 'Perangkat tanpa keterangan'}{row.current ? ' · ini perangkat Anda' : ''}</strong><span>Masuk {new Date(row.createdAt).toLocaleString('id-ID')} · terakhir aktif {row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString('id-ID') : '-'}</span></div><button type="button" className="download" onClick={() => run(async () => { await api.revokeSession(row.id); setMessage('Sesi dikeluarkan.'); await refresh(); })}>Keluarkan</button></li>)}</ul>
    <h3 className="settings-heading">Verifikasi dua langkah (TOTP)</h3>
    <div className="settings-meta"><span>Status</span><strong>{mfa?.enabled ? 'Aktif' : mfa?.pendingSetup ? 'Menunggu konfirmasi kode' : 'Belum aktif'}</strong></div>
    {!mfa?.enabled && <><p className="settings-hint">Buka aplikasi authenticator (Google Authenticator, Authy, 1Password), tambah akun, lalu masukkan kunci di bawah atau tempel tautan otpauth.</p>
      <button type="button" className="switch" onClick={() => run(async () => { const data = await api.mfaSetup(); setSetup(data); setMessage('Kunci dibuat. Masukkan kode 6 angka dari aplikasi Anda.'); await refresh(); })}>Buat kunci baru</button>
      {(setup || mfa?.pendingSetup) && setup && <label>Kunci rahasia<input readOnly value={setup.secret} /></label>}
      {setup && <label>Tautan otpauth<input readOnly value={setup.otpauthUrl} /></label>}
      {(setup || mfa?.pendingSetup) && <><label>Kode dari aplikasi<input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" placeholder="6 angka" /></label>
        <button type="button" className="primary" onClick={() => run(async () => { const data = await api.mfaEnable(code); setRecovery(data.recoveryCodes); setCode(''); setSetup(null); setMessage('Verifikasi dua langkah aktif. Simpan kode pemulihan di tempat aman.'); await refresh(); })}>Aktifkan</button></>}</>}
    {recovery.length > 0 && <div className="recovery-codes"><strong>Kode pemulihan (sekali pakai)</strong><ul>{recovery.map(entry => <li key={entry}><code>{entry}</code></li>)}</ul></div>}
    {mfa?.enabled && <><label>Password<input type="password" value={disablePassword} onChange={e => setDisablePassword(e.target.value)} /></label>
      <label>Kode verifikasi<input value={disableCode} onChange={e => setDisableCode(e.target.value)} inputMode="numeric" /></label>
      <button type="button" className="switch" onClick={() => run(async () => { await api.mfaDisable(disablePassword, disableCode); setDisablePassword(''); setDisableCode(''); setMessage('Verifikasi dua langkah dimatikan.'); await refresh(); })}>Matikan</button></>}
    {message && <p className="settings-ok">{message}</p>}{problem && <p className="error">{problem}</p>}
    <button type="button" className="primary" onClick={onClose}>Selesai</button><button type="button" className="switch" onClick={onLogout}>Keluar dari akun</button></section></div>;
}

function Auth({ mode, onClose, onSwitch, onSubmit, error, mfaNeeded }: { mode: 'login'|'register'; onClose: () => void; onSwitch: () => void; onSubmit: (u: string, p: string, n: string, code?: string) => void; error: string; mfaNeeded?: boolean }) { const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState(''); const [code, setCode] = useState(''); const [forgot, setForgot] = useState(false); const [forgotEmail, setForgotEmail] = useState(''); const [forgotMsg, setForgotMsg] = useState('');
  if (forgot) return <div className="modal-backdrop"><form className="auth-card" onSubmit={e => { e.preventDefault(); setForgotMsg(''); void api.forgotPassword(forgotEmail).then(result => setForgotMsg(result.delivery === 'email' ? 'Tautan atur ulang sudah dikirim ke email Anda.' : 'Server email belum dikonfigurasi, jadi tautan belum bisa dikirim. Hubungi admin.')).catch(err => setForgotMsg((err as Error).message)); }}><button type="button" className="close" onClick={onClose}>×</button><span className="eyebrow">COBLAI CODER</span><h2>Lupa kata sandi</h2><p className="settings-hint">Masukkan email akun Anda. Kami kirimkan tautan atur ulang yang berlaku 60 menit.</p><input required value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} placeholder="Email akun" /><button className="primary">Kirim tautan</button>{forgotMsg && <p className="settings-ok">{forgotMsg}</p>}<button type="button" className="switch" onClick={() => setForgot(false)}>Kembali ke halaman masuk</button></form></div>;
  return <div className="modal-backdrop"><form className="auth-card" onSubmit={e => { e.preventDefault(); onSubmit(username, password, name, code); }}><button type="button" className="close" onClick={onClose}>×</button><span className="eyebrow">COBLAI CODER</span><h2>{mode === 'login' ? 'Masuk ke workspace' : 'Buat akun baru'}</h2>{mode === 'register' && <input value={name} onChange={e => setName(e.target.value)} placeholder="Nama Anda" /> }<input required value={username} onChange={e => setUsername(e.target.value)} placeholder="Email atau username" /><input required type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password" />{mode === 'login' && mfaNeeded && <input autoFocus value={code} onChange={e => setCode(e.target.value)} placeholder="Kode verifikasi 6 angka" inputMode="numeric" />}<button className="primary">Lanjutkan</button>{error && <p className="error">{error}</p>}<button type="button" className="switch" onClick={onSwitch}>{mode === 'login' ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}</button>{mode === 'login' && <button type="button" className="switch" onClick={() => { setForgotEmail(username); setForgot(true); }}>Lupa kata sandi?</button>}</form></div>; }

export { App };

/** Standalone screen for the password reset link that arrives by email. */
function ResetPassword({ token, onClose, onDone }: { token: string; onClose: () => void; onDone: (message: string) => void }) {
  const [next, setNext] = useState(''); const [confirm, setConfirm] = useState(''); const [problem, setProblem] = useState('');
  return <div className="modal-backdrop"><section className="auth-card settings-card"><button type="button" className="close" onClick={onClose}>×</button><span className="eyebrow">PEMULIHAN AKUN</span><h2>Buat kata sandi baru</h2>
    <p className="settings-hint">Minimal 10 karakter. Semua sesi lain akan dikeluarkan setelah disimpan.</p>
    {problem && <p className="auth-error">{problem}</p>}
    <label>Kata sandi baru<input type="password" value={next} onChange={e => setNext(e.target.value)} /></label>
    <label>Ulangi kata sandi<input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
    <button type="button" className="primary" onClick={() => { setProblem(''); if (next !== confirm) { setProblem('Kata sandi tidak sama.'); return; } void api.resetPassword(token, next).then(() => onDone('Kata sandi baru tersimpan. Silakan masuk.')).catch(e => setProblem((e as Error).message)); }}>Simpan kata sandi</button>
  </section></div>;
}
