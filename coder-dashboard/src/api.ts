import type { ApiError, Message, Session, User } from './types';
export type Workspace = { id: string; name: string; slug: string };
export type Project = { id: string; workspaceId: string; name: string; slug: string };
export type RunSummary = { id: string; conversationId: string | null; status: string; prompt: string; result: string | null; model: string | null; errorCode?: string | null; createdAt: string; finishedAt: string | null; inputTokens: number; outputTokens: number; costMicros: number; estimated: number; costUsd: number };
export type WorkflowStep = { id?: string; name?: string; type: 'prompt'|'condition'|'branch'|'approval'|'delay'; prompt?: string; value?: string; field?: string; op?: string; goto?: string; cases?: { field?: string; op?: string; value?: string; goto?: string }[]; default?: string; seconds?: number };
export type Workflow = { id: string; name: string; description: string; steps: WorkflowStep[]; status: string; scheduleEnabled?: boolean; intervalMinutes?: number | null; cron?: string | null; scheduleDescription?: string | null; nextRunAt?: string | null; lastRunAt?: string | null };
export type ExecutionStep = { id: string; stepIndex: number; stepId: string; type: string; status: string; input: string; output: string; error?: string | null; startedAt?: string; finishedAt?: string };
export type ExecutionDetail = { id: string; workflowId: string; status: string; approvalStatus: string; attempt: number; currentStep: number; input: string; output: string; error?: string | null; createdAt: string; steps: ExecutionStep[] };
export type KnowledgeDocument = { id: string; projectId: string; title: string; sourceType: string; filename?: string | null; checksum: string; chunkCount?: number; createdAt: string; updatedAt: string };
export type KnowledgeHit = { documentId: string; title: string; chunkIndex: number; content: string; score: number };
export type Member = { userId: string; email: string; displayName: string; role: string; joinedAt: string };
export type Invitation = { id: string; email: string; role: string; expiresAt: string; acceptedAt: string | null; createdAt: string };
export type Artifact = { id: string; projectId: string; runId?: string | null; name: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string };
export type AuditEvent = { id: string; action: string; actorUserId?: string | null; metadata: Record<string, unknown>; createdAt: string };
export type WorkflowExecution = { id: string; workflowId: string; status: string; approvalStatus: string; attempt: number; currentStep: number; input: string; output: string; error?: string; createdAt: string };

/** Reads the readable CSRF cookie; the API compares it with the x-csrf-token header. */
function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)coder_csrf=([^;]+)/);
  return match ? { 'x-csrf-token': decodeURIComponent(match[1]) } : {};
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const unsafe = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const response = await fetch(`/api${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(unsafe ? csrfHeader() : {}), ...(options.headers || {}) } });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error((data as ApiError | null)?.error || `Request gagal (${response.status})`);
  return data as T;
}
export type Plan = { code: string; name: string; description: string; priceIdr: number; periodDays: number; tier: string; dailyTokenLimit: number; monthlyTokenLimit: number; bonusTokens: number; features: string[]; sortOrder?: number; active?: boolean };
export type BillingOrder = { id: string; userId?: string; userEmail?: string; planCode: string; months: number; amountIdr: number; discountIdr: number; totalIdr: number; couponCode: string | null; method: string; status: 'pending' | 'paid' | 'rejected' | 'cancelled'; note: string; proofArtifactId: string | null; decidedAt: string | null; createdAt: string; updatedAt?: string };
export type BankAccount = { id: string; bankName: string; accountNumber: string; accountHolder: string; note?: string; sortOrder?: number; active?: boolean };
export type Coupon = { code: string; percent: number; amountIdr: number; maxUses: number; uses: number; expiresAt: string | null; active: boolean; createdAt?: string };
export type QuotaState = { tier: string; dayKey?: string; monthKey?: string; usedToday: number; usedMonth: number; dailyLimit: number; monthlyLimit: number; creditTokens: number; remainingToday: number | null; remainingMonth: number | null; blocked: boolean; reason: string | null };
export type BillingMe = {
  tier: string; plan: Plan | null;
  subscription: { id: string; planCode: string; status: string; startedAt: string; expiresAt: string } | null;
  quota: QuotaState; orders: BillingOrder[]; banks: BankAccount[]; creditHistory: { id: string; tokens: number; reason: string; note: string; createdAt: string }[];
  payment: { gateway: string; xenditEnabled: boolean; midtransEnabled: boolean; xenditConfigured: boolean; midtransConfigured: boolean; instructions: string };
  currency: string;
};
export type PaymentConfig = { gateway: string; xenditEnabled: boolean; midtransEnabled: boolean; xenditConfigured: boolean; midtransConfigured: boolean; instructions: string; updatedAt?: string };
export type RevenueSummary = { days: number; since: string; revenueIdr: number; costIdr: number; marginIdr: number; marginPercent: number | null; paidOrders: number; pendingOrders: number; tokens: number; costUsd: number; usdIdrRate: number; activeSubscriptions: number; newSubscriptions: number; creditGrantedTokens: number };
export type AdminUserRow = { id: string; email: string; displayName: string; tier: string; isAdmin: boolean; emailVerified: boolean; createdAt: string; workspaces: number };
export type Branding = { appName: string; tagline: string; primaryColor: string; logoUrl: string; faviconUrl: string; supportEmail: string };


// ============================ WAVE 3: agent workspace ============================
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentSettings = { thinking_level: ThinkingLevel; auto_compact: number; compact_after_messages: number; tools_allow: string; autonomous_default: number; autonomous_max_turns: number; autonomous_max_tokens: number };
export type AgentPreview = {
  settings: AgentSettings; persona: { id: string; name: string; systemPrompt: string; tone: string; language: string; model: string | null; thinkingLevel: string } | null;
  blocks: string[]; flags: string[]; summaryCount: number; messages: number; notes: string[];
  conversation: { id: string; engineSessionId: string | null; compactedAt: string | null; personaId: string | null } | null;
  session: { files: number; bytes: number; newest: string | null } | null;
};
export type MemoryNote = { id: string; title: string; body: string; tags: string; pinned: number; enabled: number; useCount: number; createdAt: string; updatedAt: string };
export type PromptTemplate = { id: string; name: string; body: string; description: string; slash: string | null; tags: string; useCount: number; createdAt: string; updatedAt: string };
export type Persona = { id: string; name: string; systemPrompt: string; tone: string; language: string; model: string | null; thinkingLevel: string; isDefault: number; useCount: number; createdAt: string; updatedAt: string };
export type SkillRow = { key: string; name: string; available: boolean; detail: string; needs: string | null; group: string };
export type DirStats = { files: number; bytes: number; newest: string | null };
export type StatusHub = {
  version: string | null; generatedAt: string; durationMs: number;
  engine: { available: boolean; version?: string; models: number; note?: string | null; error?: string | null };
  database: { ok: boolean; detail: string; tables: number; migrations: { version: number; note: string; appliedAt: string }[] };
  counts: Record<string, number>;
  money: { todayTokens: number; payments: { gateway: string; xenditEnabled: boolean; midtransEnabled: boolean; xenditConfigured: boolean; midtransConfigured: boolean } };
  mail: { configured: boolean; from: string; host: string | null; secure: boolean };
  security: { csrfStrict: boolean; sessionCookie: string; adminEmails: number; metricsEnabled: boolean };
  limits: { dailyCostMicros: number; monthlyCostMicros: number; runsPerHour: number; engineTimeoutMs: number };
  storage: { data: DirStats | null; engineSessions: DirStats | null };
  lastRuns: { id: string; status: string; model: string | null; errorCode: string | null; createdAt: string; finishedAt: string | null; costMicros: number | null }[];
  backup: { note: string; cron: string }; queue: Record<string, number>;
};
export type PlaygroundResult = { text: string; usage: unknown; thinking: string; autonomous: boolean; model: string | null; systemBlocks: number; tokens: number; durationMs: number; sessionId: string };
export type CompactionResult = { compacted: true; summary: string; messagesCovered: number; charsBefore: number; charsAfter: number; engineSessionId: string; source: 'engine' | 'fallback'; usage: unknown };
export type AgentMapSession = {
  conversationId: string; title: string; projectId: string; projectName: string; workspaceName: string; updatedAt: string;
  messages: number; summaries: number; compactedAt: string | null; personaId: string | null; engineSessionId: string | null; engineSession: DirStats | null;
  runs: { id: string; status: string; model: string | null; thinkingLevel: string | null; autonomous: number; parentRunId: string | null; errorCode: string | null; promptChars: number | null; appendSystemChars: number | null; createdAt: string; finishedAt: string | null; totalTokens: number }[];
};
export type DiffLine = { type: ' ' | '-' | '+' | '@@'; text: string; left?: number; right?: number };
export type DiffResult = { left: { name: string; lines: number }; right: { name: string; lines: number }; added: number; removed: number; changes: number; hunks: DiffLine[] };
export type ConversationSummary = { id: string; summary: string; messagesCovered: number; charsBefore: number; charsAfter: number; createdAt: string };

// --- Wave 6: API tulis publik, webhook keluar, batas harian per kunci --------
/** Nama peristiwa webhook yang dikenal server. */
export type WebhookEventName = 'run.completed' | 'run.failed';
export type WebhookEventInfo = { event: string; description: string };
export type Webhook = { id: string; workspaceId: string; userId: string; url: string; events: string[]; active: boolean; description: string | null;
  createdAt: string; updatedAt: string; lastDeliveryAt: string | null; lastStatus: string | null; failureCount: number };
export type WebhookDelivery = { id: string; webhookId: string; event: string; payload: unknown; status: 'queued' | 'delivered' | 'failed' | string; attempts: number;
  responseStatus: number | null; lastError: string | null; durationMs: number | null; jobId: string | null; createdAt: string; updatedAt: string; deliveredAt: string | null };
export type WebhookStats = { hooks: number; active: number; deliveries: number; queued: number; delivered: number; failed: number; lastDeliveryAt: string | null };
export type WebhookLimits = { maxPerWorkspace: number; maxAttempts: number; timeoutMs: number; allowLocal: boolean };
export type WebhooksResponse = { webhooks: Webhook[]; stats: WebhookStats; events: WebhookEventInfo[]; limits: WebhookLimits; note: string; canManage: boolean };
export type WebhookTestReport = { status: string; responseStatus: number | null; error: string | null; durationMs: number };

// --- Wave 7: pertumbuhan, undangan, dan langkah awal -------------------------
export type ReferralStatus = 'pending' | 'qualified' | 'rewarded' | 'blocked';
export type ReferralRow = { id: string; code: string; inviterUserId: string; inviteeUserId: string; inviteeEmail: string | null;
  status: ReferralStatus; blockedReason: string | null; inviterTokens: number; inviteeTokens: number;
  createdAt: string; qualifiedAt: string | null; rewardedAt: string | null };
export type ReferralLimits = { enabled: boolean; inviterTokens: number; inviteeTokens: number; maxRewardedPerUser: number };
export type ReferralCounters = { invited: number; pending: number; qualified: number; rewarded: number; blocked: number };
export type ReferralSummary = { enabled: boolean; code: string; link: string; limits: ReferralLimits; counters: ReferralCounters;
  tokensEarned: number; recent: ReferralRow[]; invitedBy: ReferralRow | null; site: string };
export type ReferralStats = { codes: number; total: number; pending: number; qualified: number; rewarded: number; blocked: number;
  tokensGranted: number; blockedByReason: { reason: string; count: number }[] };
export type ReferralLeader = { userId: string; email: string; rewarded: number; tokens: number; invited: number };
export type OnboardingStep = { key: string; label: string; done: boolean; hint: string; link: string };
export type OnboardingState = { steps: OnboardingStep[]; done: number; total: number; percent: number;
  nextStep: string | null; complete: boolean; dismissed: boolean;
  counts: { projects: number; conversations: number; runsDone: number; keys: number; teammates: number; emailVerified: boolean } };
export type QuotaAlertLevel = 'ok' | 'warning' | 'critical' | 'exceeded';
export type QuotaAlert = { level: QuotaAlertLevel; percent: number; dayPercent: number; monthPercent: number;
  usedToday: number; dailyLimit: number; usedMonth: number; monthlyLimit: number;
  remainingToday: number | null; remainingMonth: number | null; creditTokens: number; tier: string;
  blocked: boolean; reason: string | null; message: string; packagePath: string; refreshSeconds: number };
export type GrowthFunnelStep = { key: string; label: string; users: number; allTime: number };
export type GrowthActivityRow = { day: string; signups: number; runsCompleted: number; events: number; activeUsers: number };
export type GrowthRetention = { dau: number; wau: number; mau: number; newUsers7d: number; newUsers30d: number; payingUsers: number; note: string };
export type GrowthReport = {
  funnel: { days: number; since: string; steps: GrowthFunnelStep[]; note: string };
  activity: GrowthActivityRow[];
  retention: GrowthRetention;
  events: { name: string; count: number; users: number }[];
  totals: { users: number; workspaces: number; projects: number; conversations: number; runsCompleted: number; eventsRecorded: number };
  catalogue: string[];
  windowDays: number;
  referrals: ReferralStats;
  leaderboard: ReferralLeader[];
  referralLimits: ReferralLimits;
};
export type PublicApiDocs = { product: string; baseUrl: string; version: string | null;
  auth: { scheme: string; header: string; example: string; scopes: string[]; note: string };
  endpoints: PublicEndpoint[]; limits: Record<string, unknown>;
  webhook: { enabled: boolean; events: string[]; signatureHeader: string; signatureFormat: string; headers: string[];
    retries: { attempts: number; timeoutMs: number; backoffSeconds: string } };
  errors: { code: string; meaning: string }[]; page: string };

// --- Wave 4: platform terbuka, notifikasi email dan kepatuhan data -----------
export type ApiKeyRow = { id: string; name: string; prefix: string; scopes: string; workspaceId: string; createdAt: string; lastUsedAt: string | null; lastUsedIp?: string | null; requestCount: number; revokedAt: string | null;
  /** Wave 6: batas harian per kunci dan pemakaian hari ini. 0 berarti tanpa batas khusus. */
  dailyRequestLimit?: number; dailyTokenLimit?: number; requestsToday?: number; tokensToday?: number };
export type PublicEndpoint = { method: string; path: string; scope: string; description: string; available?: boolean };
export type ApiKeyDocs = { prefix: string; scopes: string[]; phase: string; rateLimitPerMinute: number; endpoints: PublicEndpoint[]; plannedEndpoints?: PublicEndpoint[]; example: { curl: string; note: string } };
export type NotificationPrefs = { userId: string; emailQuota: number; emailRuns: number; emailBilling: number; emailTeam: number; emailSecurity: number; updatedAt: string };
export type EmailWorkerState = { enabled: boolean; mailerConfigured: boolean; from: string };
export type OutboxEmail = { id: string; userId: string | null; toEmail: string; kind: string; subject: string; body: string; status: string; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null };
export type OutboxStats = { pending: number; sent: number; failed: number; skipped: number; total: number; lastSentAt: string | null };
export type ExportSection = { name: string; rows: number };
export type DataExport = { id: string; userId: string; status: string; sizeBytes: number; sections: ExportSection[]; createdAt: string; expiresAt: string };
export type RetentionPolicy = { enabled: boolean; auditDays: number; notificationDays: number; runEventDays: number; exportDays: number };
export type RetentionTableReport = { table: string; column: string; cutoff: string; candidates: number; removed: number };
export type RetentionReport = { policy: RetentionPolicy; generatedAt: string; tables: RetentionTableReport[]; totalCandidates: number; enabled?: boolean; note?: string };
export type PrivacySummary = { policy: RetentionPolicy; sectionsInExport: ExportSection[]; storedTotals: { sections: number; rows: number }; exports: DataExport[]; email: EmailWorkerState; notes: string[] };
export type PublicPackage = { code: string; name: string; description: string; priceIdr: number; periodDays: number; tier: string; dailyTokenLimit: number; monthlyTokenLimit: number; bonusTokens: number; features: unknown };
export type PublicPricing = { branding: any; currency: string; usdToIdrRate: number; gateways: { xendit: boolean; midtrans: boolean; manualTransfer: boolean }; plans: PublicPackage[] };
/** Wave 5: one durable background job. Same shape as the row the server keeps in the jobs table. */
export type BackgroundJob = { id: string; kind: string; status: 'queued' | 'running' | 'done' | 'failed'; payload: string; result: string | null; attempts: number; maxAttempts: number; runAfter: string; lockOwner: string | null; lockExpiresAt: string | null; lastError: string | null; dedupeKey: string | null; createdAt: string; updatedAt: string; finishedAt: string | null };
export type JobStats = { queued: number; running: number; done: number; failed: number; total: number; oldestQueuedAt: string | null; lastFinishedAt: string | null; byKind: Record<string, number> };
export type JobCycleReport = { owner: string; startedAt: string; finishedAt: string; recoveredLeases: number; scheduled: string[]; claimed: number; succeeded: number; failed: number; details: { id: string; kind: string; outcome: 'done' | 'failed' | 'retry'; note?: string }[] };
export type JobWorkerInfo = { running: boolean; intervalMs: number; leaseMs: number; batchSize: number; orphanAfterMs: number; handlers: string[]; cyclesRun: number; lastCycle: JobCycleReport | null };
export type AdminJobsResponse = { worker: JobWorkerInfo; stats: JobStats; jobs: BackgroundJob[]; kinds: string[] };

export const api = {
  me: () => request<{ user: User }>('/v1/auth/me'),
  login: (username: string, password: string, code?: string) => request<{ user: User; mfaEnabled?: boolean; referral?: { accepted: boolean; error?: string } }>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email: username, password, code }) }),
  register: (username: string, password: string, name: string, ref?: string) => request<{ user: User; workspace: Workspace; referral?: { accepted: boolean; error?: string } }>('/v1/auth/register', { method: 'POST', body: JSON.stringify({ email: username, password, displayName: name, ref }) }),
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
  scheduleWorkflow: (workflowId: string, intervalMinutes: number | null, enabled: boolean, cron?: string | null) => request<{ scheduleEnabled: boolean; intervalMinutes: number | null; cron?: string | null; nextRunAt: string | null; description?: string }>(`/v1/workflows/${workflowId}/schedule`, { method: 'POST', body: JSON.stringify({ intervalMinutes, enabled, cron: cron ?? null }) }),
  deleteWorkflow: (workflowId: string) => request<{ ok: true }>(`/v1/workflows/${workflowId}`, { method: 'DELETE' }),
  deleteArtifact: (artifactId: string) => request<{ ok: true }>(`/v1/artifacts/${artifactId}`, { method: 'DELETE' }),
  artifactRawUrl: (artifactId: string) => `/api/v1/artifacts/${artifactId}/raw`,
  deleteProject: (projectId: string) => request<{ ok: true }>(`/v1/projects/${projectId}`, { method: 'DELETE' }),
  deleteWorkspace: (workspaceId: string, confirm: string) => request<{ ok: true }>(`/v1/workspaces/${workspaceId}`, { method: 'DELETE', body: JSON.stringify({ confirm }) }),
  updateProfile: (displayName: string) => request<{ user: User }>('/v1/auth/me', { method: 'PATCH', body: JSON.stringify({ displayName }) }),
  deleteAccount: (password: string) => request<{ ok: true; deletedWorkspaces: number }>('/v1/auth/account', { method: 'DELETE', body: JSON.stringify({ password, confirm: 'HAPUS AKUN' }) }),
  usageCsvUrl: (projectId: string) => `/api/v1/projects/${projectId}/usage/export`,
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
  sendMessage: (id: string, content: string, model?: string, attachments?: { name: string; mimeType: string; contentBase64: string }[], options?: { thinking?: ThinkingLevel; autonomous?: boolean; personaId?: string | null }) => request<{ message: Message; run: { id: string; status: string; thinkingLevel?: string; autonomous?: boolean; willCompact?: boolean; messages?: number } }>(`/v1/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ content, model, ...(attachments?.length ? { attachments } : {}), ...(options?.thinking ? { thinking: options.thinking } : {}), ...(options?.autonomous ? { autonomous: true } : {}), ...(options?.personaId ? { personaId: options.personaId } : {}) }) }),
  // Lampiran chat: berkas dikirim sebagai base64 dan disimpan di server.
  attachmentUrl: (attachmentId: string) => `/api/v1/attachments/${encodeURIComponent(attachmentId)}`,
  branchSession: (id: string, body: { fromMessageId?: string; title?: string; rerun?: boolean; model?: string } = {}) =>
    request<{ conversation: { id: string; projectId: string; title: string; createdAt: string }; run: { id: string; status: string } | null; warning?: string }>(`/v1/conversations/${encodeURIComponent(id)}/branch`, { method: 'POST', body: JSON.stringify(body) }),
  bulkDeleteArtifacts: (ids: string[]) => request<{ deleted: number; skipped: string[] }>('/v1/artifacts/bulk-delete', { method: 'POST', body: JSON.stringify({ ids }) }),
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

  // --- Paket, pesanan, kredit token dan kuota ---------------------------------
  plans: () => request<{ plans: Plan[]; currency: string }>('/v1/billing/plans'),
  billingMe: () => request<BillingMe>('/v1/billing/me'),
  createOrder: (planCode: string, months: number, couponCode?: string) => request<{ order: BillingOrder }>('/v1/billing/orders', { method: 'POST', body: JSON.stringify({ planCode, months, couponCode }) }),
  validateCoupon: (code: string, amountIdr: number) => request<{ code: string; discountIdr: number; percent: number }>('/v1/billing/coupons/validate', { method: 'POST', body: JSON.stringify({ code, amountIdr }) }),
  uploadOrderProof: (orderId: string, filename: string, contentBase64: string) => request<{ order: BillingOrder; artifactId: string }>(`/v1/billing/orders/${encodeURIComponent(orderId)}/proof`, { method: 'POST', body: JSON.stringify({ filename, contentBase64 }) }),
  myOrders: () => request<{ orders: BillingOrder[] }>('/v1/billing/orders'),

  // --- Admin: pesanan, pendapatan, kupon, rekening, pembayaran ---------------
  adminOrders: (status?: string) => request<{ orders: BillingOrder[] }>(`/v1/admin/orders${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  decideOrder: (orderId: string, decision: 'paid' | 'rejected', note?: string) => request<{ order: BillingOrder }>(`/v1/admin/orders/${encodeURIComponent(orderId)}/decision`, { method: 'POST', body: JSON.stringify({ decision, note }) }),
  adminRevenue: (days = 30) => request<RevenueSummary>(`/v1/admin/revenue?days=${days}`),
  adminCoupons: () => request<{ coupons: Coupon[] }>('/v1/admin/coupons'),
  createCoupon: (input: { code: string; percent?: number; amountIdr?: number; maxUses?: number; expiresAt?: string | null }) => request<{ coupon: Coupon }>('/v1/admin/coupons', { method: 'POST', body: JSON.stringify(input) }),
  setCouponActive: (code: string, active: boolean) => request<{ coupon: Coupon }>(`/v1/admin/coupons/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ active }) }),
  adminBanks: () => request<{ banks: BankAccount[] }>('/v1/admin/banks'),
  createBank: (input: { bankName: string; accountNumber: string; accountHolder: string; note?: string; sortOrder?: number }) => request<{ bank: BankAccount }>('/v1/admin/banks', { method: 'POST', body: JSON.stringify(input) }),
  deleteBank: (bankId: string) => request<{ ok: boolean }>(`/v1/admin/banks/${encodeURIComponent(bankId)}`, { method: 'DELETE' }),
  adminPaymentConfig: () => request<PaymentConfig>('/v1/admin/payment-config'),
  savePaymentConfig: (patch: { gateway?: string; xenditEnabled?: boolean; midtransEnabled?: boolean; instructions?: string }) => request<PaymentConfig>('/v1/admin/payment-config', { method: 'PUT', body: JSON.stringify(patch) }),
  adminPlans: () => request<{ plans: Plan[] }>('/v1/admin/plans'),
  updatePlan: (code: string, patch: Partial<Plan>) => request<{ plan: Plan }>(`/v1/admin/plans/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminUserList: () => request<{ users: AdminUserRow[] }>('/v1/admin/user-list'),
  adminCreateUser: (input: { email: string; displayName: string; password: string; tier?: string }) => request<{ user: AdminUserRow }>('/v1/admin/users', { method: 'POST', body: JSON.stringify(input) }),
  adminUpdateUser: (userId: string, patch: { displayName?: string; tier?: string; isAdmin?: boolean; emailVerified?: boolean }) => request<{ user: AdminUserRow }>(`/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminResetQuota: (userId: string) => request<{ ok: boolean; quota: QuotaState }>(`/v1/admin/users/${encodeURIComponent(userId)}/reset-quota`, { method: 'POST' }),
  adminGrantCredit: (userId: string, tokens: number, note?: string) => request<{ creditTokens: number }>(`/v1/admin/users/${encodeURIComponent(userId)}/credit`, { method: 'POST', body: JSON.stringify({ tokens, note }) }),
  setUsdRate: (rate: number) => request<{ usdIdrRate: number }>('/v1/admin/currency', { method: 'PUT', body: JSON.stringify({ rate }) }),

  // --- Branding --------------------------------------------------------------
  branding: () => request<Branding>('/v1/branding'),
  saveBranding: (patch: Partial<Branding>) => request<Branding>('/v1/admin/branding', { method: 'PUT', body: JSON.stringify(patch) }),

  // --- Wave 3: agent workspace ----------------------------------------------
  agentSettings: () => request<{ settings: AgentSettings; thinkingLevels: ThinkingLevel[]; toolsAllowHelp: string; autonomousHelp: string; quota: QuotaState }>('/v1/agents/settings'),
  saveAgentSettings: (patch: { thinkingLevel?: ThinkingLevel; autoCompact?: boolean; compactAfterMessages?: number; toolsAllow?: string; autonomousDefault?: boolean; autonomousMaxTurns?: number; autonomousMaxTokens?: number }) => request<{ settings: AgentSettings }>('/v1/agents/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  agentPreview: (conversationId?: string, personaId?: string) => request<AgentPreview>(`/v1/agents/preview?${new URLSearchParams({ ...(conversationId ? { conversationId } : {}), ...(personaId ? { personaId } : {}) }).toString()}`),
  agentMap: (limit = 30) => request<{ sessions: AgentMapSession[]; engine: { available: boolean; version?: string }; engineRoot: string; rootStorage: DirStats | null; note: string }>(`/v1/agents/map?limit=${limit}`),
  memories: () => request<{ memories: MemoryNote[] }>('/v1/memories'),
  createMemory: (input: { title: string; body: string; tags?: string; pinned?: boolean }) => request<{ memory: MemoryNote }>('/v1/memories', { method: 'POST', body: JSON.stringify(input) }),
  updateMemory: (memoryId: string, patch: { title?: string; body?: string; tags?: string; pinned?: boolean; enabled?: boolean }) => request<{ memory: MemoryNote }>(`/v1/memories/${encodeURIComponent(memoryId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMemory: (memoryId: string) => request<{ deleted: boolean }>(`/v1/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' }),
  promptTemplates: () => request<{ templates: PromptTemplate[] }>('/v1/prompt-templates'),
  createTemplate: (input: { name: string; body: string; description?: string; slash?: string; tags?: string }) => request<{ template: PromptTemplate }>('/v1/prompt-templates', { method: 'POST', body: JSON.stringify(input) }),
  updateTemplate: (templateId: string, patch: { name?: string; body?: string; description?: string; slash?: string; tags?: string }) => request<{ template: PromptTemplate }>(`/v1/prompt-templates/${encodeURIComponent(templateId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTemplate: (templateId: string) => request<{ deleted: boolean }>(`/v1/prompt-templates/${encodeURIComponent(templateId)}`, { method: 'DELETE' }),
  useTemplate: (templateId: string, variables?: Record<string, string>) => request<{ id: string; name: string; text: string; remainingVariables: string[] }>(`/v1/prompt-templates/${encodeURIComponent(templateId)}/use`, { method: 'POST', body: JSON.stringify({ variables: variables ?? {} }) }),
  personas: () => request<{ personas: Persona[] }>('/v1/personas'),
  createPersona: (input: { name: string; systemPrompt: string; tone?: string; language?: string; model?: string; thinkingLevel?: ThinkingLevel; makeDefault?: boolean }) => request<{ persona: Persona }>('/v1/personas', { method: 'POST', body: JSON.stringify(input) }),
  updatePersona: (personaId: string, patch: { name?: string; systemPrompt?: string; tone?: string; language?: string; model?: string; thinkingLevel?: ThinkingLevel }) => request<{ persona: Persona }>(`/v1/personas/${encodeURIComponent(personaId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePersona: (personaId: string) => request<{ deleted: boolean }>(`/v1/personas/${encodeURIComponent(personaId)}`, { method: 'DELETE' }),
  setDefaultPersona: (personaId: string) => request<{ isDefault: boolean; personaId: string }>(`/v1/personas/${encodeURIComponent(personaId)}/default`, { method: 'POST' }),
  setConversationPersona: (conversationId: string, personaId: string | null) => request<{ conversationId: string; personaId: string | null }>(`/v1/conversations/${encodeURIComponent(conversationId)}/persona`, { method: 'PATCH', body: JSON.stringify({ personaId }) }),
  skills: () => request<{ skills: SkillRow[]; groups: string[]; engine: { available: boolean; version?: string }; storage: { data: DirStats | null; engineSessions: DirStats | null } }>('/v1/skills'),
  statusHub: () => request<StatusHub>('/v1/status-hub'),
  playground: (input: { prompt: string; model?: string; thinking?: ThinkingLevel; personaId?: string; useMemory?: boolean; autonomous?: boolean }) => request<PlaygroundResult>('/v1/playground/run', { method: 'POST', body: JSON.stringify(input) }),
  compactConversation: (conversationId: string) => request<CompactionResult>(`/v1/conversations/${encodeURIComponent(conversationId)}/compact`, { method: 'POST' }),
  conversationSummaries: (conversationId: string) => request<{ summaries: ConversationSummary[]; conversation: { engineSessionId: string | null; compactedAt: string | null }; messages: number }>(`/v1/conversations/${encodeURIComponent(conversationId)}/summaries`),
  artifactDiff: (artifactId: string, otherId: string, context = 3) => request<DiffResult>(`/v1/artifacts/${encodeURIComponent(artifactId)}/diff/${encodeURIComponent(otherId)}?context=${context}`),
  reportUrl: (projectId: string, kind: 'project' | 'conversation' = 'project', conversationId?: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/report.md?kind=${kind}${conversationId ? `&conversationId=${encodeURIComponent(conversationId)}` : ''}`,

  // --- Wave 4: kunci API, API publik, notifikasi email, privasi data ----------
  apiKeys: (workspaceId?: string) => request<{ keys: ApiKeyRow[]; note: string; limits: { maxActive: number; rateLimitPerMinute: number; dailyRequestsDefault?: number; dailyTokensDefault?: number }; scopesAvailable: string[] }>(`/v1/api-keys${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  apiKeyDocs: () => request<ApiKeyDocs>('/v1/api-keys/docs'),
  createApiKey: (input: { name: string; scopes?: string[]; workspaceId?: string; dailyRequestLimit?: number; dailyTokenLimit?: number }) => request<{ key: ApiKeyRow; secret: string; workspaceId: string; warning: string }>('/v1/api-keys', { method: 'POST', body: JSON.stringify(input) }),
  updateApiKey: (keyId: string, patch: { name?: string; scopes?: string[]; dailyRequestLimit?: number; dailyTokenLimit?: number }) => request<{ key: ApiKeyRow }>(`/v1/api-keys/${encodeURIComponent(keyId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  revokeApiKey: (keyId: string) => request<{ revoked: boolean; keyId: string }>(`/v1/api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }),
  publicPlans: () => request<PublicPricing>('/v1/public/plans'),
  notificationPrefs: () => request<{ preferences: NotificationPrefs; email: EmailWorkerState; kinds: { key: string; label: string }[]; note: string }>('/v1/account/notification-preferences'),
  saveNotificationPrefs: (patch: Partial<NotificationPrefs>) => request<{ preferences: NotificationPrefs; message: string }>('/v1/account/notification-preferences', { method: 'PUT', body: JSON.stringify(patch) }),
  privacySummary: () => request<PrivacySummary>('/v1/account/privacy'),
  createExport: () => request<{ export: DataExport; sections: ExportSection[]; downloadUrl: string; message: string }>('/v1/account/export', { method: 'POST' }),
  listExports: () => request<{ exports: DataExport[] }>('/v1/account/exports'),
  deleteExport: (exportId: string) => request<{ deleted: boolean; exportId: string }>(`/v1/account/exports/${encodeURIComponent(exportId)}`, { method: 'DELETE' }),
  exportDownloadUrl: (exportId: string) => `/api/v1/account/exports/${encodeURIComponent(exportId)}/download`,
  adminEmailOutbox: (status?: string) => request<{ worker: EmailWorkerState; stats: OutboxStats; emails: OutboxEmail[]; note: string }>(`/v1/admin/email-outbox${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  retryOutboxEmail: (emailId: string) => request<{ retried: boolean; emailId: string }>(`/v1/admin/email-outbox/${encodeURIComponent(emailId)}/retry`, { method: 'POST' }),
  deliverOutbox: () => request<{ enabled: boolean; mailerConfigured: boolean; considered: number; sent: number; failed: number; skipped: number; pending: number; reason?: string }>('/v1/admin/email-outbox/deliver', { method: 'POST' }),
  /** Wave 5: daftar pekerjaan latar, statistik antrean, dan keadaan worker. */
  adminJobs: (status?: string, kind?: string) => request<AdminJobsResponse>(`/v1/admin/jobs${status || kind ? `?${status ? `status=${encodeURIComponent(status)}` : ''}${status && kind ? '&' : ''}${kind ? `kind=${encodeURIComponent(kind)}` : ''}` : ''}`),
  retryAdminJob: (jobId: string) => request<{ retried: boolean; job: BackgroundJob }>(`/v1/admin/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST' }),
  runAdminJobCycle: () => request<{ cycle: JobCycleReport; stats: JobStats; worker: JobWorkerInfo }>('/v1/admin/jobs/tick', { method: 'POST' }),
  deleteOutboxEmail: (emailId: string) => request<{ deleted: boolean; emailId: string }>(`/v1/admin/email-outbox/${encodeURIComponent(emailId)}`, { method: 'DELETE' }),
  /** Wave 6: webhook keluar. Rahasia penandatanganan hanya muncul sekali, saat webhook dibuat. */
  webhooks: (workspaceId?: string) => request<WebhooksResponse>(`/v1/webhooks${workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : ''}`),
  createWebhook: (input: { url: string; events?: string[]; description?: string; workspaceId?: string }) =>
    request<{ webhook: Webhook; secret: string; warning: string }>('/v1/webhooks', { method: 'POST', body: JSON.stringify(input) }),
  updateWebhook: (webhookId: string, patch: { url?: string; events?: string[]; active?: boolean; description?: string | null }) =>
    request<{ webhook: Webhook }>(`/v1/webhooks/${encodeURIComponent(webhookId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteWebhook: (webhookId: string) =>
    request<{ deleted: boolean; webhookId: string; note?: string }>(`/v1/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' }),
  webhookDeliveries: (webhookId: string, limit = 50) =>
    request<{ webhook: Webhook; deliveries: WebhookDelivery[] }>(`/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries?limit=${encodeURIComponent(String(limit))}`),
  testWebhook: (webhookId: string) =>
    request<{ report: WebhookTestReport; delivery: WebhookDelivery | null }>(`/v1/webhooks/${encodeURIComponent(webhookId)}/test`, { method: 'POST' }),
  retentionReport: () => request<RetentionReport>('/v1/admin/retention'),
  runRetention: (dryRun = true) => request<RetentionReport & { dryRun: boolean; totalRemoved: number; expiredExports: { marked: number; filesRemoved: number }; message: string }>('/v1/admin/retention/run', { method: 'POST', body: JSON.stringify({ dryRun }) }),
  /** Wave 7: program undangan. Kode dibuat otomatis saat panel dibuka pertama kali. */
  referralMe: () => request<ReferralSummary>('/v1/referrals/me'),
  referrals: (limit = 100) => request<{ code: string; referrals: ReferralRow[]; invitedBy: ReferralRow | null; limits: ReferralLimits }>(`/v1/referrals?limit=${encodeURIComponent(String(limit))}`),
  rotateReferralCode: () => request<{ code: string; link: string }>('/v1/referrals/code', { method: 'POST' }),
  /** Wave 7: langkah awal untuk pengguna baru. */
  onboarding: () => request<OnboardingState>('/v1/onboarding'),
  dismissOnboarding: () => request<{ dismissed: boolean; onboarding: OnboardingState }>('/v1/onboarding/dismiss', { method: 'POST' }),
  /** Wave 7: peringatan kuota yang jujur. */
  quotaAlert: () => request<QuotaAlert>('/v1/billing/quota-alert'),
  /** Wave 7: angka pertumbuhan, khusus admin platform. */
  adminGrowth: (days = 30) => request<GrowthReport>(`/v1/admin/growth?days=${encodeURIComponent(String(days))}`),
  adminReferrals: (limit = 100) => request<{ stats: ReferralStats; leaderboard: ReferralLeader[]; referrals: (ReferralRow & { inviterEmail: string; inviteeEmailConfirmed: string })[] }>(`/v1/admin/referrals?limit=${encodeURIComponent(String(limit))}`),
  /** Wave 7: dokumentasi API publik tanpa sesi. */
  publicDocs: () => request<PublicApiDocs>('/v1/public/docs'),
};
