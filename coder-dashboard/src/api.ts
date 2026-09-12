import type { ApiError, Message, Session, User } from './types';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error((data as ApiError | null)?.error || `Request gagal (${response.status})`);
  return data as T;
}
export const api = {
  me: () => request<{ user: User }>('/v1/auth/me'),
  login: (username: string, password: string) => request<{ user: User }>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: username, password }) }),
  register: (username: string, password: string, name: string) => request<{ user: User }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: username, password, displayName: name }) }),
  logout: () => request('/v1/auth/logout', { method: 'POST' }),
  sessions: () => request<{ sessions: Session[] }>('/sessions'),
  createSession: (name = 'Percakapan baru') => request<{ session: Session }>('/sessions', { method: 'POST', body: JSON.stringify({ name }) }),
  messages: (id: string) => request<{ messages: Message[] }>(`/sessions/${encodeURIComponent(id)}/messages`, { method: 'POST' }),
  chat: (message: string, sessionId: string, files: unknown[] = []) => fetch('/api/chat', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sessionId, files }) }),
};
