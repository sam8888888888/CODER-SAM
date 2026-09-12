import type { ApiError, Message, Session, User } from './types';
export type Workspace = { id: string; name: string; slug: string };
export type Project = { id: string; workspaceId: string; name: string; slug: string };
export type Knowledge = { id: string; title: string; checksum: string; updatedAt: string };
export type Workflow = { id: string; name: string; description: string; steps: unknown[]; status: string };
export type WorkflowExecution = { id: string; workflowId: string; status: string; input: string; output: string; error?: string; createdAt: string };

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
  workspaces: () => request<Workspace[]>('/v1/workspaces'),
  projects: (workspaceId: string) => request<Project[]>(`/v1/workspaces/${workspaceId}/projects`),
  sessions: (projectId: string) => request<Session[]>(`/v1/projects/${projectId}/conversations`),
  createSession: (projectId: string, title = 'Percakapan baru') => request<{ conversation: Session }>(`/v1/projects/${projectId}/conversations`, { method: 'POST', body: JSON.stringify({ title }) }),
  messages: (id: string) => request<{ messages: Message[] }>(`/v1/conversations/${encodeURIComponent(id)}/messages`),
  knowledge: (projectId: string) => request<Knowledge[]>(`/v1/projects/${projectId}/knowledge`),
  addKnowledge: (projectId: string, title: string, content: string) => request(`/v1/projects/${projectId}/knowledge`, { method: 'POST', body: JSON.stringify({ title, content }) }),
  workflows: (projectId: string) => request<Workflow[]>(`/v1/projects/${projectId}/workflows`),
  addWorkflow: (projectId: string, name: string, steps: unknown[]) => request(`/v1/projects/${projectId}/workflows`, { method: 'POST', body: JSON.stringify({ name, steps }) }),
  executeWorkflow: (workflowId: string, input: string) => request(`/v1/workflows/${workflowId}/execute`, { method: 'POST', body: JSON.stringify({ input }) }),
  workflowExecutions: (workflowId: string) => request<WorkflowExecution[]>(`/v1/workflows/${workflowId}/executions`),
  decideApproval: (executionId: string, decision: 'approved'|'rejected') => request(`/v1/workflow-executions/${executionId}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }),
  sendMessage: (id: string, content: string) => request<{ message: Message; run: { id: string } }>(`/v1/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
};
