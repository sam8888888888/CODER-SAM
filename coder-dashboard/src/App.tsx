import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Tools } from './Tools';
import { Home } from './Home';
import { Projects } from './Projects';
import { Runs } from './Runs';
import { NAV_ITEMS, isToolPage, type PageKey } from './nav';
import { ProfilePanel } from './ProfilePanel';
import { WorkspaceAdmin } from './WorkspaceAdmin';
import type { Message, Session, User } from './types';
import type { Workspace, Project } from './api';

const starterPrompts = ['Tinjau kode saya dan temukan masalahnya', 'Buatkan rencana implementasi fitur ini', 'Rangkum dokumen yang saya kirim', 'Bantu saya melakukan riset mendalam'];

function App() {
  const [user, setUser] = useState<User | null>(null); const [toolsOpen, setToolsOpen] = useState(false); const [projectId, setProjectId] = useState<string | null>(null); const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  // Left navigation is the map of the platform: every page is reachable without a modal.
  const [page, setPage] = useState<PageKey>('home'); const [workspaceOptions, setWorkspaceOptions] = useState<Workspace[]>([]); const [projectOptions, setProjectOptions] = useState<Project[]>([]); const [settingsOpen, setSettingsOpen] = useState(false); const [sessions, setSessions] = useState<Session[]>([]); const [current, setCurrent] = useState<string | null>(null); const [messages, setMessages] = useState<Message[]>([]); const [prompt, setPrompt] = useState(''); const [busy, setBusy] = useState(false); const [sidebar, setSidebar] = useState(false); const [authOpen, setAuthOpen] = useState(false); const [notifOpen, setNotifOpen] = useState(false); const [notifItems, setNotifItems] = useState<{ id: string; kind: string; title: string; body: string | null; readAt: string | null; createdAt: string }[]>([]); const [notifUnread, setNotifUnread] = useState(0); const [banner, setBanner] = useState(''); const [resetToken, setResetToken] = useState<string | null>(null); const [inviteToken, setInviteToken] = useState<string | null>(null); const [authMode, setAuthMode] = useState<'login'|'register'>('login'); const [error, setError] = useState(''); const [online, setOnline] = useState(true); const [notice, setNotice] = useState(''); const [query, setQuery] = useState(''); const [activeRun, setActiveRun] = useState<string | null>(null); const endRef = useRef<HTMLDivElement>(null);
  // Signed out visitors always land on the chat surface; pages belong to signed in users.
  const view = user ? page : 'chat';
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
    // Invitation links are created in the Team tab as /?invitation=<token>; the token is accepted after sign-in.
    const invite = params.get('invitation');
    if (invite) setInviteToken(invite);
    api.me().then(d => { setUser(d.user); setOnline(true); loadSessions().catch(() => setOnline(false)); void loadNotifications(); }).catch(() => { setOnline(false); });
  }, []);
  async function loadNotifications() { try { const data = await api.notifications(); setNotifItems(data.notifications || []); setNotifUnread(data.unread || 0); } catch { /* belum masuk */ } }
  async function markAllRead() { try { await api.readAllNotifications(); await loadNotifications(); } catch (e) { setError((e as Error).message); } }
  // An invited person must sign in first, so the token is kept until a session exists.
  useEffect(() => {
    if (!inviteToken) return;
    if (!user) { setNotice('Anda menerima undangan workspace. Masuk atau daftar dengan email yang diundang untuk menerimanya.'); return; }
    let cancelled = false;
    api.acceptInvitation(inviteToken).then(async (result) => {
      if (cancelled) return;
      setInviteToken(null);
      window.history.replaceState({}, '', '/');
      setNotice(`Anda sudah bergabung ke workspace ini sebagai ${result.role}.`);
      await loadSessions().catch(() => undefined);
    }).catch((e) => {
      if (cancelled) return;
      const message = (e as Error).message || '';
      setInviteToken(null);
      window.history.replaceState({}, '', '/');
      setNotice(message.includes('INVITATION_EMAIL_MISMATCH') ? 'Undangan ini ditujukan untuk alamat email lain. Masuk dengan email yang diundang lalu buka tautannya lagi.'
        : message.includes('INVITATION_INVALID_OR_EXPIRED') ? 'Undangan sudah kedaluwarsa atau sudah dipakai.'
        : message || 'Undangan tidak bisa diterima.');
    });
    return () => { cancelled = true; };
  }, [user, inviteToken]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, busy]);
  async function loadSessions(): Promise<string | null> { try { const all = await api.workspaces(); setWorkspaceOptions(all || []); const ws = all[0]; if (!ws) return null; setWorkspaceId(ws.id); const projects = await api.projects(ws.id); setProjectOptions(projects || []); const project = projects[0]; if (!project) { setProjectId(null); return null; } setProjectId(project.id); const d = await api.chatSessions(project.id); setSessions(d || []); return project.id; } catch { setOnline(false); return null; } }
  /** Switch the active workspace and reload its projects, sessions and default selection. */
  /** Reloads the workspace list and activates one of them; used after create or delete. */
  async function reloadWorkspaces(selectId?: string) {
    try {
      const all = await api.workspaces();
      setWorkspaceOptions(all || []);
      const target = (selectId ? (all || []).find(item => item.id === selectId) : (all || [])[0]) ?? null;
      if (target) await switchWorkspace(target.id);
      else { setWorkspaceId(null); setProjectOptions([]); setProjectId(null); setSessions([]); setCurrent(null); }
    } catch { /* the list keeps its previous value */ }
  }

  async function switchWorkspace(id: string) { setWorkspaceId(id); setProjectOptions([]); setProjectId(null); setSessions([]); setCurrent(null); try { const projects = await api.projects(id); setProjectOptions(projects || []); const first = projects?.[0]; if (first) { setProjectId(first.id); setSessions((await api.chatSessions(first.id)) || []); } } catch (e) { setError((e as Error).message); } }
  /** Switch the active project; chat sessions follow the project. */
  async function switchProject(id: string) { setProjectId(id); setCurrent(null); setMessages([]); try { setSessions((await api.chatSessions(id)) || []); } catch (e) { setError((e as Error).message); } }
  /** Called by the project page after a project is created. */
  async function reloadProjects(preferId?: string) { if (!workspaceId) return; try { const projects = await api.projects(workspaceId); setProjectOptions(projects || []); const target = preferId && projects?.some(p => p.id === preferId) ? preferId : projects?.[0]?.id; if (target) await switchProject(target); else { setProjectId(null); setSessions([]); setCurrent(null); setMessages([]); } } catch (e) { setError((e as Error).message); } }
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

  async function newChat() { if (!user) { setAuthOpen(true); return null; } try { // The project id is resolved here: the state value is still stale right after loadSessions().
    const target = projectId ?? await loadSessions(); if (!target) { setError('Proyek belum siap. Buat proyek dulu di halaman Proyek.'); return null; } const d = await api.createSession(target, 'Percakapan baru'); setSessions(s => [d.conversation, ...s]); setCurrent(d.conversation.id); setMessages([]); setSidebar(false); return d.conversation.id; } catch (e) { setError((e as Error).message); return null; } }
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

  async function send(text = prompt) { const content = text.trim(); if (!content || busy) return; if (!user) { setAuthOpen(true); return; } // Await the id: the first message of a new conversation was silently dropped before.
    let sessionId = current; if (!sessionId) sessionId = await newChat(); if (!sessionId) return; setPrompt(''); setMessages(m => [...m, { role: 'user', content }]); setBusy(true); try { const response = await api.sendMessage(sessionId, content, model || undefined); setActiveRun(response.run.id); setMessages(m => [...m, { role: 'assistant', content: '' }]); const source = new EventSource(`/api/v1/runs/${response.run.id}/events`); let answer = ''; source.onmessage = event => { try { const data = JSON.parse(event.data); const delta = data.data?.delta || data.data || ''; if (data.type === 'text' && typeof delta === 'string') { answer += delta; setMessages(m => [...m.slice(0, -1), { role: 'assistant', content: answer }]); } if (['completed', 'failed', 'cancelled'].includes(data.type)) { source.close(); setBusy(false); setActiveRun(null); } } catch { /* ignore heartbeat */ } }; source.onerror = () => { source.close(); setBusy(false); setActiveRun(null); }; } catch (e) { setMessages(m => [...m, { role: 'assistant', content: `Terjadi kendala: ${(e as Error).message}` }]); setBusy(false); } }
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
    <header className="topbar"><div className="brand"><button className="icon-button mobile-only" onClick={() => setSidebar(v => !v)}>☰</button><div className="brand-mark">C</div><div><div className="brand-name">COBLAI</div><div className="brand-sub">CODER WORKSPACE</div></div></div><div className="top-actions">{user && <div className="picker-group"><label className="picker" title="Workspace aktif"><span>Workspace</span><select value={workspaceId ?? ''} onChange={e => void switchWorkspace(e.target.value)}>{workspaceOptions.map(ws => <option key={ws.id} value={ws.id}>{ws.name}</option>)}</select></label><label className="picker" title="Proyek aktif"><span>Proyek</span><select value={projectId ?? ''} onChange={e => void switchProject(e.target.value)}>{projectOptions.length === 0 && <option value="">(belum ada proyek)</option>}{projectOptions.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div>}<span className={`connection ${online ? 'ok' : ''}`}><i />{online ? 'Terhubung' : 'Mode lokal'}</span><button className="new-button desktop-only" onClick={newChat}>＋ Chat baru</button><div className="bell-wrap"><button className="icon-button" title="Notifikasi" onClick={() => { setNotifOpen(v => !v); void loadNotifications(); }}>🔔{notifUnread > 0 && <span className="bell-count">{notifUnread > 9 ? '9+' : notifUnread}</span>}</button>{notifOpen && <div className="bell-panel"><div className="bell-head"><strong>Notifikasi</strong><button type="button" className="link-button" onClick={markAllRead}>Tandai semua dibaca</button></div>{notifItems.length === 0 && <p className="settings-hint">Belum ada notifikasi.</p>}{notifItems.slice(0, 12).map(item => <button type="button" key={item.id} className={`bell-item ${item.readAt ? '' : 'unread'}`} onClick={() => { if (item.readAt) return; void api.readNotification(item.id).then(loadNotifications).catch(() => undefined); }}><strong>{item.title}</strong>{item.body && <span>{item.body}</span>}<em>{new Date(item.createdAt).toLocaleString('id-ID')}{item.readAt ? '' : ' · baru'}</em></button>)}</div>}</div><button className="profile-button" onClick={() => user ? setSettingsOpen(true) : setAuthOpen(true)}>{(user?.displayName || user?.name || user?.email || '?')[0].toUpperCase()}</button></div></header>
    <div className="workspace"><aside className={`sidebar ${sidebar ? 'open' : ''}`}><nav className="page-nav">{user && NAV_ITEMS.map(item => <button type="button" key={item.key} title={item.blurb} className={`page-link ${view === item.key ? 'active' : ''}`} onClick={() => { setPage(item.key); setSidebar(false); }}><span className="page-icon">{item.icon}</span>{item.label}</button>)}</nav>{view === 'chat' && <><button className="new-chat" onClick={newChat}>＋ Percakapan baru</button><div className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Cari percakapan" /></div><div className="section-label">WORKSPACE <span>{visibleSessions.length}</span></div><nav className="session-list">{visibleSessions.map(s => <div className={`session-row ${current === s.id ? 'active' : ''}`} key={s.id}><button className={`session ${current === s.id ? 'active' : ''}`} onClick={() => switchSession(s)}><span>{s.pinned ? '◆' : '◇'}</span><b>{s.name || 'Percakapan baru'}</b><small>{s.lastUsed ? new Date(s.lastUsed).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : ''}</small></button><div className="session-actions"><button title="Ganti nama" onClick={() => renameSession(s)}>✎</button><button title={s.pinned ? 'Lepas pin' : 'Pin'} onClick={() => pinSession(s)}>◆</button><button title="Ekspor" onClick={() => exportSession(s)}>↓</button><button title="Hapus" onClick={() => removeSession(s)}>✕</button></div></div>)}{!visibleSessions.length && <div className="empty-side">Belum ada percakapan</div>}</nav></>}{view !== 'chat' && <div className="empty-side">Halaman aktif: {page}. Buka Percakapan untuk kembali ke chat.</div>}<div className="sidebar-bottom"><button onClick={() => user ? setToolsOpen(true) : setAuthOpen(true)}>▦ Knowledge & workflow</button><button onClick={() => user ? setSettingsOpen(true) : setAuthOpen(true)}>⚙ Pengaturan & akun</button>{user && <button className="logout" onClick={logout}>Keluar</button>}</div></aside>
    <main className="main">{view === 'chat' ? <><section className="conversation">{!hasChat ? <div className="welcome"><span className="eyebrow">✦ RUANG KERJA AI UNTUK MEMBANGUN LEBIH CEPAT</span><h1>Apa yang ingin<br /><em>Anda kerjakan?</em></h1><p>Tulis ide, kirim kode, atau unggah dokumen. COBLAI membantu Anda dari rencana sampai hasil.</p><div className="starter-grid">{starterPrompts.map((p, i) => <button key={p} onClick={() => { setPrompt(p); }}>{p}<strong>{['⌘','↗','▤','⌁'][i]}</strong></button>)}</div></div> : <div className="messages">{messages.map((m, i) => <article className={`message ${m.role}`} key={`${i}-${m.content.slice(0, 8)}`}><div className="message-author">{m.role === 'user' ? 'ANDA' : 'DINDA'}</div><div className="bubble">{m.content || (busy ? 'Dinda sedang bekerja…' : '')}</div></article>)}{busy && <div className="typing"><i /><i /><i /> Dinda sedang bekerja</div>}<div ref={endRef} /></div>}</section><div className="composer-wrap"><form className="composer" onSubmit={e => { e.preventDefault(); send(); }}><textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="Tulis pesan untuk Dinda…" rows={1} /><div className="composer-actions">{modelOptions.length > 0 && <label className="model-picker" title="Model AI untuk pesan berikutnya">⚙<select value={model} onChange={e => { setModel(e.target.value); localStorage.setItem('coblai.model', e.target.value); }}>{modelOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}<label className="upload-button" title="Impor percakapan (JSON)">＋<input type="file" accept=".json" onChange={e => { const file = e.target.files?.[0]; if (file) void importSession(file); e.target.value = ''; }} /></label>{busy && <button type="button" className="stop" title="Hentikan" onClick={stopRun}>■ Berhenti</button>}<span>Enter untuk kirim · Shift+Enter untuk baris baru</span><button className="send" disabled={!prompt.trim() || busy}>↑</button></div></form><small>AI dapat membuat kesalahan. Periksa hasil sebelum digunakan.</small></div></> : <section className="page-shell">{view === 'home' ? <Home workspaceId={workspaceId} projectId={projectId} onNavigate={setPage} />: page === 'projects' ? <Projects workspaceId={workspaceId} projectId={projectId} onSelect={id => void switchProject(id)} onCreated={id => void reloadProjects(id)} onDeleted={() => void reloadProjects()} />: page === 'runs' ? <Runs projectId={projectId} />: page === 'settings' && user ? <Settings inline user={user} workspaceId={workspaceId} workspaceName={workspaceOptions.find(w => w.id === workspaceId)?.name} onClose={() => setPage('chat')} onLogout={logout} onSelectWorkspace={id => void switchWorkspace(id)} onWorkspaceCreated={id => void switchWorkspace(id)} onWorkspaceDeleted={() => void reloadWorkspaces()} />: projectId && isToolPage(page) ? <Tools projectId={projectId} workspaceId={workspaceId} tab={page} embedded />: <div className="page-shell-inner"><p className="settings-hint">Halaman ini butuh proyek aktif. Buat atau pilih proyek dulu.</p><button type="button" className="primary" onClick={() => setPage('projects')}>Buka halaman Proyek</button></div>}</section>}</main></div>{banner && <button className="toast notice-toast" onClick={() => setBanner('')}>{banner}</button>}{error && <button className="toast" onClick={() => setError('')}>{error}</button>}{notice && <button className="toast notice-toast" onClick={() => setNotice('')}>{notice}</button>}{toolsOpen && projectId && <Tools projectId={projectId} workspaceId={workspaceId} onClose={() => setToolsOpen(false)} />} {settingsOpen && user && <Settings user={user} workspaceId={workspaceId} workspaceName={workspaceOptions.find(w => w.id === workspaceId)?.name} onClose={() => setSettingsOpen(false)} onLogout={logout} onSelectWorkspace={id => void switchWorkspace(id)} onWorkspaceCreated={id => void switchWorkspace(id)} onWorkspaceDeleted={() => void reloadWorkspaces()} />} {resetToken && <ResetPassword token={resetToken} onClose={() => { setResetToken(null); window.history.replaceState({}, '', '/'); }} onDone={(msg) => { setResetToken(null); window.history.replaceState({}, '', '/'); setBanner(msg); setAuthMode('login'); setAuthOpen(true); }} />} {authOpen && <Auth mode={authMode} onClose={() => setAuthOpen(false)} onSwitch={() => { setAuthMode(v => v === 'login' ? 'register' : 'login'); setError(''); }} onSubmit={submitAuth} error={error} mfaNeeded={mfaNeeded} />}</div>;
}

function Settings({ user, workspaceId, workspaceName, onClose, onLogout, onSelectWorkspace, onWorkspaceCreated, onWorkspaceDeleted, inline }: { user: User; workspaceId: string | null; workspaceName?: string; onClose: () => void; onLogout: () => void; onSelectWorkspace?: (id: string) => void; onWorkspaceCreated?: (id: string) => void; onWorkspaceDeleted?: () => void; inline?: boolean }) {
  const [deleteName, setDeleteName] = useState(''); const [deletingWorkspace, setDeletingWorkspace] = useState(false);
  const [current, setCurrent] = useState(''); const [next, setNext] = useState('');
  const [message, setMessage] = useState(''); const [problem, setProblem] = useState('');
  const [sessions, setSessions] = useState<{ id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; userAgent: string | null; current: boolean }[]>([]);
  const [mfa, setMfa] = useState<{ enabled: boolean; pendingSetup: boolean } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState(''); const [disablePassword, setDisablePassword] = useState(''); const [disableCode, setDisableCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [limits, setLimits] = useState({ daily: '', monthly: '', perHour: '' });
  const [limitDefaults, setLimitDefaults] = useState<{ dailyCostLimitMicros: number; monthlyCostLimitMicros: number; runsPerHourLimit: number } | null>(null);
  // The role is per workspace, so it is read from the member list instead of the login payload.
  const [canManageLimits, setCanManageLimits] = useState(false);
  const [admin, setAdmin] = useState<any | null>(null); const [adminUsers, setAdminUsers] = useState<any[]>([]);
  async function refresh() {
    try { setSessions(await api.sessions()); } catch { setSessions([]); }
    try { setMfa(await api.mfaStatus()); } catch { setMfa(null); }
    try { const me = await api.me(); setEmailVerified(Boolean((me.user as { emailVerified?: boolean }).emailVerified)); } catch { setEmailVerified(null); }
    try { const overview = await api.adminOverview(); setAdmin(overview); const people = await api.adminUsers(); setAdminUsers(people); } catch { setAdmin(null); setAdminUsers([]); }
    // Every member reads the workspace limits through their own endpoint; the admin listing is refused for normal owners.
    try {
      if (workspaceId) {
        const mine = await api.readWorkspaceLimits(workspaceId);
        setLimits({ daily: mine.dailyCostLimitMicros === null ? '' : String(mine.dailyCostLimitMicros), monthly: mine.monthlyCostLimitMicros === null ? '' : String(mine.monthlyCostLimitMicros), perHour: mine.runsPerHourLimit === null ? '' : String(mine.runsPerHourLimit) });
        setLimitDefaults(mine.effective);
        const people = await api.members(workspaceId).catch(() => []);
        const self = Array.isArray(people) ? people.find((row: any) => row.userId === user.id) : null;
        setCanManageLimits(['owner', 'admin'].includes(String(self?.role ?? '')));
      }
    } catch { setLimitDefaults(null); setCanManageLimits(false); }
  }
  useEffect(() => { void refresh(); }, []);
  function run(action: () => Promise<void>) { setMessage(''); setProblem(''); void action().catch((e) => setProblem((e as Error).message)); }
  return <div className={inline ? 'page-inline' : 'modal-backdrop'}><section className="auth-card settings-card">{!inline && <button type="button" className="close" onClick={onClose}>×</button>}<span className="eyebrow">AKUN &amp; WORKSPACE</span><h2>Pengaturan</h2>
    <div className="settings-meta"><span>Status akun</span><strong>Aktif</strong></div><div className="settings-meta"><span>Role</span><strong>{user.role || 'member'}</strong></div>
    <ProfilePanel email={user.email} displayName={user.displayName || user.name || ''} onChanged={() => void refresh()} onDeleted={onLogout} />
    <h3 className="settings-heading">Workspace</h3>
    <WorkspaceAdmin isAdmin={Boolean(admin)} activeWorkspaceId={workspaceId ?? undefined} onSelect={id => onSelectWorkspace?.(id)} onCreated={id => onWorkspaceCreated?.(id)} />
    {workspaceId && canManageLimits && <section className="settings-card danger-zone">
      <h3 className="settings-heading">Hapus workspace ini</h3>
      <p className="settings-hint">Semua proyek, percakapan, run, artefak, dan knowledge di dalam workspace ini akan dihapus permanen. Tindakan ini tidak bisa dibatalkan.</p>
      <label>Ketik nama workspace untuk konfirmasi<input value={deleteName} onChange={e => setDeleteName(e.target.value)} placeholder={workspaceName || 'nama workspace'} /></label>
      <button type="button" className="btn-danger" disabled={deletingWorkspace || !workspaceName || deleteName.trim() !== workspaceName} onClick={() => { if (!workspaceId || !workspaceName) return; setDeletingWorkspace(true); setProblem(''); run(async () => { try { await api.deleteWorkspace(workspaceId, workspaceName); setDeleteName(''); setMessage('Workspace dihapus.'); onWorkspaceDeleted?.(); } finally { setDeletingWorkspace(false); } }); }}>{deletingWorkspace ? 'Menghapus…' : 'Hapus workspace'}</button>
    </section>}
    <h3 className="settings-heading">Verifikasi email</h3>
    <div className="settings-meta"><span>Status email</span><strong>{emailVerified === null ? 'tidak diketahui' : emailVerified ? 'terverifikasi' : 'belum terverifikasi'}</strong></div>
    {emailVerified === false && <button type="button" onClick={() => run(async () => { const result = await api.requestEmailVerification(); setMessage(result.sent ? 'Email verifikasi sudah dikirim.' : result.reason === 'EMAIL_NOT_CONFIGURED' ? 'Server email belum dikonfigurasi, jadi tautan verifikasi belum bisa dikirim.' : `Gagal mengirim email (${result.reason ?? 'tidak diketahui'}).`); })}>Kirim ulang email verifikasi</button>}
    <h3 className="settings-heading">Batas pemakaian workspace</h3>
    {canManageLimits ? <>
      <p className="settings-hint">Angka dalam micro-USD (1 USD = 1.000.000). Kosongkan sebuah kolom untuk memakai batas default platform{limitDefaults ? ` (harian $${(limitDefaults.dailyCostLimitMicros / 1_000_000).toFixed(2)}, 30 hari $${(limitDefaults.monthlyCostLimitMicros / 1_000_000).toFixed(2)}, ${limitDefaults.runsPerHourLimit === 0 ? 'tanpa batas run' : `${limitDefaults.runsPerHourLimit} run per jam`})` : ''}. Isi 0 untuk benar-benar tanpa batas.</p>
      <label>Batas biaya harian<input inputMode="numeric" value={limits.daily} onChange={e => setLimits(v => ({ ...v, daily: e.target.value }))} /></label>
      <label>Batas biaya 30 hari<input inputMode="numeric" value={limits.monthly} onChange={e => setLimits(v => ({ ...v, monthly: e.target.value }))} /></label>
      <label>Batas jumlah run per jam<input inputMode="numeric" value={limits.perHour} onChange={e => setLimits(v => ({ ...v, perHour: e.target.value }))} /></label>
      <button type="button" onClick={() => run(async () => { if (!workspaceId) throw new Error('Workspace belum dipilih.'); const num = (value: string) => value.trim() === '' ? null : Number(value); await api.workspaceLimits(workspaceId, { dailyCostLimitMicros: num(limits.daily), monthlyCostLimitMicros: num(limits.monthly), runsPerHourLimit: num(limits.perHour) }); setMessage('Batas pemakaian disimpan.'); await refresh(); })}>Simpan batas</button>
    </> : <p className="settings-hint">Hanya pemilik atau admin workspace yang bisa mengubah batas. Batas saat ini: harian {limitDefaults ? (limitDefaults.dailyCostLimitMicros === 0 ? 'tanpa batas' : `$${(limitDefaults.dailyCostLimitMicros / 1_000_000).toFixed(2)}`) : 'tidak diketahui'}.</p>}
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
    {problem && <p className="error">{problem}</p>}
    <label>Kata sandi baru<input type="password" value={next} onChange={e => setNext(e.target.value)} /></label>
    <label>Ulangi kata sandi<input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
    <button type="button" className="primary" onClick={() => { setProblem(''); if (next !== confirm) { setProblem('Kata sandi tidak sama.'); return; } void api.resetPassword(token, next).then(() => onDone('Kata sandi baru tersimpan. Silakan masuk.')).catch(e => setProblem((e as Error).message)); }}>Simpan kata sandi</button>
  </section></div>;
}
