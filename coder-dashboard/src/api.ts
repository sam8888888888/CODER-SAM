import type { ApiError, Message, Session, User } from './types';
export type Workspace = { id: string; name: string; slug: string };
export type Project = { id: string; workspaceId: string; name: string; slug: string };
export type RunSummary = { id: string; conversationId: string | null; status: string; prompt: string; result: string | null; model: string | null; errorCode?: string | null; createdAt: string; finishedAt: string | null; inputTokens: number; outputTokens: number; costMicros: number; estimated: number; costUsd: number };
export type WorkflowStep = { id?: string; name?: string; type: 'prompt'|'condition'|'branch'|'approval'|'delay'; prompt?: string; value?: string; field?: string; op?: string; goto?: string; cases?: { field?: string; op?: string; value?: string; goto?: string }[]; default?: string; seconds?: number };
export type Workflow = { id: string; name: string; description: string; steps: WorkflowStep[]; status: string; scheduleEnabled?: boolean; intervalMinutes?: number | null; nextRunAt?: string | null; lastRunAt?: string | null };
export type ExecutionStep = { id: string; stepIndex: number; stepId: string; type: string; status: string; input: string; output: string; error?: string | null; startedAt?: string; finishedAt?: string };
export type ExecutionDetail = { id: string; workflowId: string; status: string; approvalStatus: string; attempt: number; currentStep: number; input: string; output: string; error?: string | null; createdAt: string; steps: ExecutionStep[] };
export type KnowledgeDocument = { id: string; projectId: string; title: string; sourceType: string; filename?: string | null; checksum: string; chunkCount?: number; createdAt: string; updatedAt: string };
export type KnowledgeHit = { documentId: string; title: string; chunkIndex: number; content: string; score: number };
export type Member = { userId: string; email: string; displayName: string; role: string; joinedAt: string };
export type Invitation = { id: string; email: string; role: string; expiresAt: string; acceptedAt: string | null; createdAt: string };
export type Artifact = { id: string; projectId: string; runId?: string | null; name: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string };
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
  login: (username: string, password: string, code?: string) => request<{ user: User; mfaEnabled?: boolean }>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: username, password, code }) }),
  register: (username: string, password: string, name: string) => request<{ user: User; workspace: Workspace }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: username, password, displayName: name }) }),
  logout: () => request('/v1/auth/logout', { method: 'POST' }),
  workspaces: () => request<Workspace[]>('/v1/workspaces'),
  projects: (workspaceId: string) => request<Project[]>(`/v1/workspaces/${workspaceId}/projects`),
  chatSessions: (projectId: string) => request<Session[]>(`/v1/projects/${projectId}/conversations`),
  createSession: (projectId: string, title = 'Percakapan baru') => request<{ conversation: Session }>(`/v1/projects/${projectId}/conversations`, { method: 'POST', body: JSON.stringify({ title }) }),
  messages: (id: string) => request<{ messages: Message[] }>(`/v1/conversations/${encodeURIComponent(id)}/messages`),
  uploadKnowledge: (projectId: string, filename: string, contentBase64: string, title?: string) => request<KnowledgeDocument>(`/v1/projects/${projectId}/knowledge/upload`, { method: 'POST', body: JSON.stringify({ filename, contentBase64, title }) }),
  searchKnowledge: (projectId: string, query: string) => request<KnowledgeHit[]>(`/v1/projects/${projectId}/knowledge/search?q=${encodeURIComponent(query)}`),
  document: (projectId: string, documentId: string) => request<{ document: KnowledgeDocument; chunks: { chunkIndex: number; preview: string }[] }>(`/v1/projects/${projectId}/knowledge/${documentId}`),
  deleteKnowledge: (projectId: string, documentId: string) => request(`/v1/projects/${projectId}/knowledge/${documentId}`, { method: 'DELETE' }),
  members: (workspaceId: string) => request<Member[]>(`/v1/workspaces/${workspaceId}/members`),
  updateMemberRole: (workspaceId: string, userId: string, role: string) => request(`/v1/workspaces/${workspaceId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
  removeMember: (workspaceId: string, userId: string) => request(`/v1/workspaces/${workspaceId}/members/${userId}`, { method: 'DELETE' }),
  invite: (workspaceId: string, email: string, role: string) => request<{ id: string; token: string; email: string }>(`/v1/workspaces/${workspaceId}/invitations`, { method: 'POST', body: JSON.stringify({ email, role }) }),
  invitations: (workspaceId: string) => request<Invitation[]>(`/v1/workspaces/${workspaceId}/invitations`),
  acceptInvitation: (token: string) => request<{ accepted: boolean; workspaceId: string; role: string }>('/v1/invitations/accept', { method: 'POST', body: JSON.stringify({ token }) }),
  revokeInvitation: (invitationId: string) => request(`/v1/invitations/${invitationId}`, { method: 'DELETE' }),
  artifacts: (projectId: string) => request<Artifact[]>(`/v1/projects/${projectId}/artifacts`),
  uploadArtifact: (projectId: string, name: string, mimeType: string, contentBase64: string) => request(`/v1/projects/${projectId}/artifacts`, { method: 'POST', body: JSON.stringify({ name, mimeType, contentBase64 }) }),
  knowledge: (projectId: string) => request<KnowledgeDocument[]>(`/v1/projects/${projectId}/knowledge`),
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
  renameSession: (id: string, title: string, pinned?: boolean) => request<{ id: string; title: string; pinned: boolean }>(`/v1/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title, pinned }) }),
  deleteSession: (id: string) => request(`/v1/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  exportSession: (id: string) => request<{ format: string; conversation: { title: string }; messages: Message[] }>(`/v1/conversations/${encodeURIComponent(id)}/export`),
  importSession: (projectId: string, payload: { title: string; messages: Message[] }) => request<{ conversation: { id: string; title: string } }>(`/v1/projects/${projectId}/conversations/import`, { method: 'POST', body: JSON.stringify({ conversation: payload }) }),
  cancelRun: (runId: string) => request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' }),
  usage: (projectId: string, days = 30) => request<{
    totals: { runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number; costMicros: number; costUsd: number; estimatedRuns: number; measuredRuns: number; unpricedRuns: number | null };
    byModel: { model: string; provider: string; runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; costMicros: number; costUsd: number }[];
    daily: { day: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number }[];
    note: string;
  }>(`/v1/projects/${projectId}/usage?days=${days}`),
  auditEvents: (workspaceId: string) => request<AuditEvent[]>(`/v1/workspaces/${workspaceId}/audit`),
  decideApproval: (executionId: string, decision: 'approved'|'rejected') => request(`/v1/workflow-executions/${executionId}/approval`, { method: 'POST', body: JSON.stringify({ decision }) }),
  sendMessage: (id: string, content: string, model?: string) => request<{ message: Message; run: { id: string } }>(`/v1/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ content, model }) }),
  sessions: () => request<{ id: string; createdAt: string; lastSeenAt: string | null; expiresAt: string; userAgent: string | null; current: boolean }[]>('/v1/auth/sessions'),
  revokeSession: (id: string) => request<{ revoked: boolean }>(`/v1/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ changed: boolean }>('/v1/auth/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  mfaStatus: () => request<{ enabled: boolean; pendingSetup: boolean }>('/v1/auth/mfa'),
  mfaSetup: () => request<{ secret: string; otpauthUrl: string }>('/v1/auth/mfa/setup', { method: 'POST' }),
  mfaEnable: (code: string) => request<{ enabled: boolean; recoveryCodes: string[] }>('/v1/auth/mfa/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaDisable: (password: string, code: string) => request<{ enabled: boolean }>('/v1/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ password, code }) }),
  forgotPassword: (email: string) => request<{ ok: boolean; delivery: 'email' | 'unavailable'; note?: string }>('/v1/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) => request<{ reset: boolean }>('/v1/auth/password/reset', { method: 'POST', body: JSON.stringify({ token, password }) }),
  verifyEmail: (token: string) => request<{ verified: boolean }>('/v1/auth/email/verify', { method: 'POST', body: JSON.stringify({ token }) }),
  requestEmailVerification: () => request<{ sent: boolean; reason?: string }>('/v1/auth/email/verify/request', { method: 'POST' }),
  notifications: () => request<{ notifications: { id: string; kind: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string }[]; unread: number }>('/v1/notifications'),
  readNotification: (id: string) => request<{ read: boolean }>(`/v1/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  readAllNotifications: () => request<{ read: number }>('/v1/notifications/read-all', { method: 'POST' }),
  adminOverview: () => request<any>('/v1/admin/overview'),
  adminUsers: () => request<any[]>('/v1/admin/users'),
  adminWorkspaces: () => request<any[]>('/v1/admin/workspaces'),
  setAdmin: (userId: string, enabled: boolean) => request<{ isAdmin: boolean }>(`/v1/admin/users/${encodeURIComponent(userId)}/admin`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  workspaceLimits: (workspaceId: string, limits: { dailyCostLimitMicros?: number | null; monthlyCostLimitMicros?: number | null; runsPerHourLimit?: number | null }) => request<any>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/limits`, { method: 'PUT', body: JSON.stringify(limits) }),
  readWorkspaceLimits: (workspaceId: string) => request<{ dailyCostLimitMicros: number | null; monthlyCostLimitMicros: number | null; runsPerHourLimit: number | null; effective: { dailyCostLimitMicros: number; monthlyCostLimitMicros: number; runsPerHourLimit: number } }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/limits`),
  createWorkspace: (name: string) => request<Workspace>('/v1/workspaces', { method: 'POST', body: JSON.stringify({ name }) }),
  createProject: (workspaceId: string, name: string, description?: string) => request<Project>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/projects`, { method: 'POST', body: JSON.stringify({ name, description }) }),
  updateProject: (projectId: string, patch: { name?: string; description?: string }) => request<{ project: Project }>(`/v1/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  runs: (projectId: string, conversationId?: string) => request<{ runs: RunSummary[] }>(`/v1/projects/${encodeURIComponent(projectId)}/runs${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`),
  models: () => request<{ available: boolean; error?: string; default: { model: string | null; provider: string | null }; models: { provider: string; model: string; context: string; maxOutput: string; thinking: boolean; images: boolean }[] }>('/v1/models'),
};
