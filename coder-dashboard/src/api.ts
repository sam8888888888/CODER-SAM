import type { ApiError, Message, Session, User } from './types';
export type Workspace = { id: string; name: string; slug: string };
export type Project = { id: string; workspaceId: string; name: string; slug: string };
export type Knowledge = { id: string; title: string; checksum: string; updatedAt: string };
export type WorkflowStep = { id?: string; name?: string; type: 'prompt'|'condition'|'branch'|'approval'|'delay'; prompt?: string; value?: string; field?: string; op?: string; goto?: string; cases?: { field?: string; op?: string; value?: string; goto?: string }[]; default?: string; seconds?: number };
export type Workflow = { id: string; name: string; description: string; steps: WorkflowStep[]; status: string; scheduleEnabled?: boolean; intervalMinutes?: number | null; nextRunAt?: string | null; lastRunAt?: string | null };
export type ExecutionStep = { id: string; stepIndex: number; stepId: string; type: string; status: string; input: string; output: string; error?: string | null; startedAt?: string; finishedAt?: string };
export type ExecutionDetail = { id: string; workflowId: string; status: string; approvalStatus: string; attempt: number; currentStep: number; input: string; output: string; error?: string | null; createdAt: string; steps: ExecutionStep[] };
export type AuditEvent = { id: string; action: string; actorUserId?: string | null; metadata: Record<string, unknown>; createdAt: string };
export type WorkflowExecution = { id: string; workflowId: string; status: string; approvalStatus: string; attempt: number; currentStep: number; input: string; output: string; error?: string; createdAt: string };

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
  updateWorkflow: (workflowId: string, payload: { name?: string; description?: string; steps?: WorkflowStep[] }) => request(`/v1/workflows/${workflowId}`, { method: 'PUT', body: JSON.stringify(payload) }),
  publishWorkflow: (workflowId: string) => request(`/v1/workflows/${workflowId}/publish`, { method: 'POST' }),
  scheduleWorkflow: (workflowId: string, intervalMinutes: number | null, enabled: boolean) => request<{ scheduleEnabled: boolean; intervalMinutes: number | null; nextRunAt: string | null }>(`/v1/workflows/${workflowId}/schedule`, { method: 'POST', body: JSON.stringify({ intervalMinutes, enabled }) }),
  execution: (executionId: string) => request<ExecutionDetail>(`/v1/workflow-executions/${executionId}`),
  cancelExecution: (executionId: string) => request(`/v1/workflow-executions/${executionId}/cancel`, { method: 'POST' }),
  retryExecution: (executionId: string) => request<{ id: string; attempt: number }>(`/v1/workflow-executions/${executionId}/retry`, { method: 'POST' }),
  auditEvents: (workspaceId: string) => request<AuditEvent[]>(`/v1/workspaces/${workspaceId}/audit`),
  decideApproval: (executionId: string, decision: 'approved'|'rejected') => request(`/v1/workflow-executions/${executionId}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }),
  sendMessage: (id: string, content: string) => request<{ message: Message; run: { id: string } }>(`/v1/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
};
