import type { ApiError, Message, Session, User } from './types';
export type Workspace = { id: string; name: string; slug: string };
export type Project = { id: string; workspaceId: string; name: string; slug: string };

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
  register: (username: string, password: string, name: string) => request<{ user: User; workspace: Workspace }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: username, password, displayName: name }) }),
  logout: () => request('/v1/auth/logout', { method: 'POST' }),
  workspaces: () => request<{ workspaces: Workspace[] }>('/v1/workspaces'),
  projects: (workspaceId: string) => request<{ projects: Project[] }>(`/v1/workspaces/${workspaceId}/projects`),
  sessions: (projectId: string) => request<{ conversations: Session[] }>(`/v1/projects/${projectId}/conversations`),
  createSession: (projectId: string, title = 'Percakapan baru') => request<{ conversation: Session }>(`/v1/projects/${projectId}/conversations`, { method: 'POST', body: JSON.stringify({ title }) }),
  messages: (id: string) => request<{ messages: Message[] }>(`/v1/conversations/${encodeURIComponent(id)}/messages`),
  sendMessage: (id: string, content: string) => request<{ message: Message; run: { id: string } }>(`/v1/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
};
