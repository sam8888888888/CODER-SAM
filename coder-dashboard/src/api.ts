import type { ApiError, Message, Session, User } from './types';
export type Workspace = { id: string; name: string; slug: string };
export type Project = { id: string; workspaceId: string; name: string; slug: string };
export type RunSummary = { id: string; conversationId: string | null; status: string; prompt: string; result: string | null; model: string | null; errorCode?: string | null; createdAt: string; finishedAt: string | null; inputTokens: number; outputTokens: number; costMicros: number; estimated: number; costUsd: number };
/** Wave 11A (butir 46): satu pelanggaran guardrail yang tercatat pada sebuah run.
 *  Server menyisipkan larangan SEBELUM run dibuat, jadi daftar ini hampir selalu kosong; kolomnya
 *  tetap dibaca apa adanya supaya catatan lama atau jalur lain (mis. penyisipan aturan manual) terlihat. */
export type RunViolation = { id: string; ruleId: string; judul: string; kind: string; pattern: string; snippet: string; createdAt: string };
/** Rincian satu run (GET /v1/runs/:id). Wave 11A menambah penanda perpindahan model (butir 57) dan daftar pelanggaran guardrail (butir 46). */
export type RunDetail = { id: string; projectId: string; status: string; prompt: string; result: string | null; model: string | null; errorCode: string | null; fallbackFrom: string | null; fallbackCount: number; startedAt: string | null; finishedAt: string | null; createdAt: string; violations?: RunViolation[] };
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
export type AdminUserRow = { id: string; email: string; displayName: string; tier: string; isAdmin: boolean; emailVerified: boolean; createdAt: string; workspaces: number; deletedAt?: string | null; purgeAfter?: string | null };
export type Branding = { appName: string; tagline: string; primaryColor: string; logoUrl: string; faviconUrl: string; supportEmail: string };


// ============================ WAVE 3: agent workspace ============================
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentSettings = { thinking_level: ThinkingLevel; auto_compact: number; compact_after_messages: number; tools_allow: string; autonomous_default: number; autonomous_max_turns: number; autonomous_max_tokens: number; /** Wave 11A (butir 57): model cadangan berurutan, disimpan sebagai teks JSON. */ fallback_models?: string };
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
export type ApiKeyRow = { id: string; name: string; prefix: string; scopes: string; workspaceId: string; createdAt: string; lastUsedAt: string | null; lastIp?: string | null; requestCount: number; revokedAt: string | null;
  /** Wave 6: batas harian per kunci dan pemakaian hari ini. 0 berarti tanpa batas khusus. */
  dailyRequestLimit?: number; dailyTokenLimit?: number; requestsToday?: number; tokensToday?: number;
  /** Wave 10 (butir 24): token yang sudah dipegang run yang masih berjalan, plus daftar run-nya. */
  tokensReserved?: number; inFlight?: Array<{ runId: string; tokens: number; status: string; createdAt: string }>;
  quota?: { requestLimit: number; requestsUsed: number; tokenLimit: number; tokensUsed: number; tokensReserved: number; tokensRemaining: number | null; requestsRemaining: number | null } };
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


/** Wave 9 (butir 19): konsol harga AI. costMicros = yang dibayar platform, sellMicros = yang ditagihkan. */
export type PricingNumbers = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PricingModel = {
  // Butir 19: 'vendor' = harga resmi vendor dipakai karena katalog mesin sudah tidak berlaku.
  model: string; provider: string | null; source: 'catalog' | 'override' | 'vendor' | 'none';
  base: PricingNumbers; sell: PricingNumbers; updatedAt: string | null; updatedBy: string | null;
  used: boolean; runs: number; baseMicros: number; sellMicros: number; marginMicros: number;
};
export type PricingTotals = { runs: number; baseMicros: number; sellMicros: number; marginMicros: number; pricedRuns: number; unpricedRuns: number; modelsUsed: number };
export type PricingTable = {
  markup: number; currency: string; updatedAt: string | null; updatedBy: string | null;
  catalogSize: number; overrideCount: number; days: number; models: PricingModel[]; totals: PricingTotals; note: string;
};
export type PricingSettingsResult = { ok: true; markup: number; updatedAt: string | null; rowsUpdated: number; totals: PricingTotals; message: string };

/** Butir 19: satu baris rekonsiliasi biaya tercatat vs biaya menurut harga yang berlaku sekarang. */
export type CostReconciliationRow = {
  model: string; provider: string | null; source: 'catalog' | 'override' | 'vendor' | 'none';
  runs: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  recordedMicros: number; correctedMicros: number; driftMicros: number; driftPercent: number; peakBuckets: number;
};
export type CostReconciliation = {
  days: number; generatedAt: string; rows: CostReconciliationRow[];
  totals: { runs: number; recordedMicros: number; correctedMicros: number; driftMicros: number; driftPercent: number; unpricedRuns: number };
  note: string;
};
export type PricingModelResult = { ok: true; price: PricingModel; message: string };

/** Properti halaman konsol harga. Sudah dipakai halaman AdminPricing.tsx. */
export type PricingQuery = { search?: string; only?: 'all' | 'used' | 'overridden'; limit?: number; days?: number };

// ======================= WAVE 11A (v0.21.0): tipe bersama =======================
// Bentuk di bawah disalin dari kode API yang sudah jadi (coder-platform/apps/api/src/wave11a/*),
// bukan dari perkiraan, supaya halaman tidak menebak nama bidang.
/** Mode percakapan (butir 42). `diskusi` = agen hanya menganalisis; `eksekusi` = agen boleh menulis. */
export type AgentMode = 'diskusi' | 'eksekusi';
export type AgentModeState = { conversationId: string; mode: AgentMode; bolehUbah: boolean; updatedAt: string | null; catatan?: string };

/** Artefak versi publik yang dikirim server (tanpa jalur simpan di disk). */
export type PublicArtifact = { id: string; projectId: string; name: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string };

/** Butir 48: isi artefak + nomor revisi dasar untuk modal Edit. */
export type ArtifactContentResponse = {
  artifact: PublicArtifact; revision: number; maxBytes: number; limit: number;
  content: string | null; editable: boolean; message?: string;
  bytes?: number; sha256OnDisk?: string; sha256Matches?: boolean;
};
export type ArtifactSaveResponse = {
  artifact: PublicArtifact; content: string; revision: number; snapshotRevision: number | null;
  sha256: string; sizeBytes: number; limit: number; maxBytes: number; message: string;
};
export type ArtifactRevision = { revisionNumber: number; sizeBytes: number; checksum: string; createdBy: string | null; note: string; createdAt: string };
export type ArtifactRevisionList = {
  artifact: PublicArtifact; revisions: ArtifactRevision[]; count: number; limit: number;
  totalBytes: number; limitBytes: number; usageBytes: number; latestRevision: number; note: string;
};
export type ArtifactRevisionContent = ArtifactRevision & { artifact: PublicArtifact; content: string; latestRevision: number };
export type ArtifactRestoreResponse = {
  artifact: PublicArtifact; restored: number; revision: number; snapshotRevision: number | null;
  sha256: string; sizeBytes: number; content: string; message: string;
};

/** Hapus riwayat (butir 54): ekspor dulu (satu berkas), baru boleh hapus. Artefak tidak ikut terhapus. */
export type BulkDeleteScope = 'project' | 'workspace';
export type BulkExportResponse = { exportId: string; conversations: number; messages: number; sizeBytes: number; expiresAt: string };
export type BulkDeleteResponse = {
  deletedConversations: number; deletedMessages: number; deletedSummaries: number; artifactsKept: number;
  scope: { jenis: BulkDeleteScope; id: string; nama: string }; exportId: string; catatan: string;
};

/** Perkiraan biaya Playground (butir 56): harga jual, bukan tagihan, dan tanpa efek samping. */
export type PlaygroundEstimate = {
  model: string; promptChars: number; tokens: { input: number; output: number; total: number; runs: number };
  hargaJualPerJuta: { input: number; output: number; mataUang: string };
  markup: number; priceSource: string; estimatedCostMicros: number; estimatedCostIdr: number; usdIdrRate: number;
  percentOfDailyQuota: number | null; dailyLimitTokens: number; catatan: string; tanpaEfekSamping: boolean;
};

/** Guardrails (butir 46) dan laporan audit-diri (butir 53). */
export type GuardrailRule = {
  id: string; userId: string; kind: 'kualitas' | 'larangan'; title: string; body: string;
  enabled: number; sortOrder: number; createdAt: string; updatedAt: string;
};
export type GuardrailsResponse = { rules: GuardrailRule[]; kinds: string[]; injectLimit: number; maxRules: number; help: string };
export type SafetyEvent = { id: string; ruleId: string; ruleTitle?: string | null; runId?: string | null; pattern?: string | null; snippet?: string | null; createdAt: string };
export type SafetyReport = {
  windowDays: number; total: number; terakhir: string | null;
  byRule: { ruleId: string; title: string; jumlah: number; terakhir: string | null }[]; events: SafetyEvent[];
};

/** Skill milik pengguna (butir 51). */
export type UserSkill = {
  id: string; userId: string; name: string; description: string; content: string;
  enabled: number; useCount: number; createdAt: string; updatedAt: string;
};
export type UserSkillsResponse = { skills: UserSkill[]; activeLimit: number; charsLimit: number; activeCount: number; activeChars: number; help: string };

/** Basis pengetahuan platform (butir 52). */
export type KnowledgeBaseEntry = {
  id: string; section: 'umum' | 'whitelabel'; title: string; content: string; enabled: number;
  sortOrder: number; createdBy: string | null; createdAt: string; updatedAt: string;
};
export type KnowledgeBaseResponse = {
  entries: KnowledgeBaseEntry[]; sections: string[]; limitChars: number;
  activeChars: number; activeEntries: number; catatan: string;
};

/** Kebijakan alat (butir 47) dan model cadangan (butir 57).
 *  `maxToolNameChars` = panjang nama alat yang diterima server (64). `catalogFilled` false berarti
 *  katalog alat masih kosong, jadi halaman menampilkan isian nama bebas, bukan daftar centang. */
export type ToolsPolicyResponse = {
  mode: 'bawaan' | 'tanpa_alat' | 'daftar';
  tools: string[] | null;
  raw: string;
  catalog: string[];
  catalogFilled: boolean;
  maxToolNameChars?: number;
  help: string;
  /** Hanya ada pada jawaban PUT: true bila kebijakan berlaku mulai run berikutnya. */
  diterapkanPadaRunBerikutnya?: boolean;
};
/** Butir 53: satu butir pemeriksaan audit-diri platform (GET /v1/admin/self-audit). */
export type SelfAuditStatus = 'ok' | 'warn' | 'fail';
export type SelfAuditCheck = { id: string; judul: string; status: SelfAuditStatus; catatan: string };
export type SelfAuditReport = {
  ranAt: string;
  checks: SelfAuditCheck[];
  ringkasan: { ok: number; warn: number; fail: number };
};
export type FallbackModelsResponse = { models: string[]; maxModels: number; maxSwitchesPerRun: number; help: string };

/* ------------------------------------------------------ Wave 11B (butir 58-72, v0.22.0) */

/** Butir 60: pelajaran akun. Disimpan di tabel yang sama dengan bank memori, dibedakan kolom kind. */
export type Learning = {
  id: string; userId: string; title: string; body: string; tags: string; pinned: number; enabled: number;
  useCount: number; createdAt: string; updatedAt: string;
};
export type LearningsResponse = {
  learnings: Learning[]; total: number; activeCount: number; activeLimit: number; maxTotal: number; help: string;
};

/** Butir 58: dewan juri (perkiraan, jawaban jalan, dan daftar dewan terakhir). */
export type CouncilEstimateResponse = {
  jurors: string[]; perkiraanBiayaMicros: number; promptChars: number; assumedOutputTokens: number; catatan: string;
};
export type CouncilVerdict = {
  id: string; juror: string; verdict: string; score: number | null; notes: string; runId: string | null;
  costMicros: number; errorCode: string | null; createdAt: string;
};
export type CouncilRunResponse = {
  councilRunId: string; status: string; jurors: string[]; perkiraanBiayaMicros: number; catatan: string;
  costMicros: number; biayaDasarMicros: number; summary: string;
};
export type CouncilRunRow = {
  id: string; status: string; question: string; jurors: string[]; summary: string; costMicros: number;
  createdAt: string; finishedAt: string | null; verdictCount: number; failedCount: number; materialChars: number;
};
export type CouncilRunDetail = {
  id: string; status: string; question: string; materialChars: number; jurors: string[]; summary: string;
  costMicros: number; createdAt: string; finishedAt: string | null; verdicts: CouncilVerdict[];
  perkiraanBiayaMicros: number; biayaDasarMicros: number; catatan: string;
};
export type CouncilRunsResponse = { runs: CouncilRunRow[]; catatan: string };

/** Butir 61: benchmark beberapa model pada soal bawaan server. */
export type BenchmarkSummaryRow = { model: string; dijawab: number; gagal: number; biayaMicros: number; rataLatencyMs: number | null };
export type BenchmarkEstimateResponse = {
  models: string[]; questionCount: number; perkiraanBiayaMicros: number;
  perModel: { model: string; biayaMicros: number }[]; sumberSoal: string; catatan: string;
};
export type BenchmarkRunResponse = {
  benchmarkRunId: string; status: string; models: string[]; questionCount: number; estimatedCostMicros: number;
  catatan: string; costMicros: number; ringkasan: BenchmarkSummaryRow[];
};
export type BenchmarkResultRow = {
  id: string; model: string; questionId: string; question: string; answer: string; score: number | null;
  latencyMs: number | null; costMicros: number; errorCode: string | null; createdAt: string;
};
export type BenchmarkRunDetail = {
  id: string; status: string; models: string[]; questionCount: number; estimatedCostMicros: number;
  costMicros: number; createdAt: string; finishedAt: string | null; results: BenchmarkResultRow[];
  ringkasan: { perModel: BenchmarkSummaryRow[] }; biayaDasarMicros: number; catatan: string;
};

/** Butir 62: timeline satu run (langkah dari run_events + baris runs, tanpa langkah karangan). */
export type TimelineStep = { seq: number; at: string; kind: string; name: string; summary: string; status: string };
export type RunTimelineResponse = { runId: string; status: string; total: number; langkah: TimelineStep[]; catatan: string };

/** Butir 63: kelayakan lanjutan run yang gagal. */
export type ResumeStatus = {
  runId: string; status: string; errorCode: string | null; resumeState: string | null;
  canResume: boolean; canAutoResume: boolean; reason: string; attempts: number;
  maxAttemptsOtomatis: number; maxPercobaanManual: number; conversationId: string | null; modePercakapan: string;
  ringkasanTerakhirAda: boolean; biayaSebelumnyaMicros: number; resumedFrom: string | null; catatan: string;
};
export type ResumeStartResponse = {
  runId: string; resumedFrom: string; mode: string; status: string; jalur: string;
  ringkasanDipakai: boolean; conversationId: string | null; catatan: string;
};

/** Butir 64: ekspor/impor persona sebagai berkas JSON. */
export type PersonaTransferEntry = {
  name: string; systemPrompt: string; tone: string; language: string; model: string | null; thinkingLevel: string;
};
export type PersonaTransferFile = { versi: number; dieksporPada: string; personas: PersonaTransferEntry[] };
export type PersonaImportResponse = { added: number; skipped: string[]; total: number; catatan: string };

/** Butir 65: pemakaian dan aktivitas akun sendiri. */
export type UsageBreakdownRow = {
  tanggal?: string; model?: string; tokenInput: number; tokenOutput: number; tokenTotal: number;
  biayaTerbillingMicros: number; biayaTidakTertagihMicros: number;
};
export type AccountUsageResponse = {
  period: string; days: number; sejak: string; tokenInput: number; tokenOutput: number; tokenTotal: number;
  biayaTerbillingMicros: number; biayaTidakTertagihMicros: number; totalMicros: number;
  rekonsiliasi: { selisihMicros: number; jumlahRun: number; catatan: string };
  perHari: UsageBreakdownRow[]; perModel: UsageBreakdownRow[]; catatan: string;
};
export type AccountAuditEvent = { id: string; action: string; createdAt: string; metadata: Record<string, unknown> };
export type AccountAuditResponse = { days: number; sejak: string; total: number; events: AccountAuditEvent[]; catatan: string };

/** Butir 66: laporan galat admin (rahasia sudah disaring server sebelum disimpan). */
export type ErrorEventRow = {
  id: string; kind: string; code: string; message: string; runId: string | null; userId: string | null; createdAt: string;
};
export type AdminErrorsResponse = {
  total: number; kind: string | null; from: string | null; to: string | null; rows: ErrorEventRow[]; catatan: string;
};

/** Butir 67: pembukuan token bulanan (saldo admin vs pemakaian nyata). */
export type TokenAccountingResponse = {
  month: string; saldo: number; terpakai: number; sisa: number; proyeksi: number; daysElapsed: number;
  daysInMonth: number; peringatan: string | null; perkiraan: boolean; updatedAt: string | null;
  perPengguna: { userId: string; email: string; tokens: number }[]; catatan: string;
};

/** Butir 59: mode bayangan (hanya mengukur, tidak mengubah jawaban). */
export type ShadowModeResponse = { mode: string; catatan: string; kinds: string[]; total: number; updatedAt: string | null };

/** Butir 72: jadwal prompt. */
export type Schedule = {
  id: string; prompt: string; cron: string; cronText: string; timezone: string; projectId: string | null;
  conversationId: string | null; model: string | null; thinking: string; autonomous: boolean; enabled: boolean;
  lastRunAt: string | null; nextRunAt: string | null; createdAt: string; updatedAt: string;
};
export type SchedulesResponse = {
  schedules: Schedule[]; total: number; limit: number; defaultTimezone: string; help: string;
};
export type ScheduleRunNowResponse = { dijalankan: boolean; runId: string | null; alasan: string; catatan: string };

/* ================= Wave 11C (butir 68/69/71/74/76/78) =================
 * Semua bentuk di bawah diambil dari jawaban NYATA modul server `apps/api/src/wave11c/*.ts`.
 * Aturan yang berlaku di seluruh Wave 11C: rahasia (token Notion, token bot, URL/token konektor)
 * TIDAK pernah dikembalikan server. Yang ada hanya penanda `terpasang` dan `ekor` (4 karakter
 * terakhir), dan halaman ini menampilkan apa adanya tanpa pernah menyimpan rahasia di state. */

/** Butir 68 — satu halaman Notion yang tercatat sebagai riwayat (bukan teks isi halaman). */
export type NotionPage = { id: string; title: string; url: string; createdAt: string };
/** Butir 68 — keadaan sambungan Notion milik satu pengguna. */
export type NotionIntegration = {
  provider: string; terpasang: boolean; tersegel: boolean; bisaDibuka: boolean; ekor: string | null;
  workspace: { id?: string; name?: string } | null; halaman: NotionPage[]; jumlahHalaman: number;
  lastPageUrl: string | null; connectedAt: string | null; lastPageAt: string | null;
  createdAt: string | null; updatedAt: string | null;
};
export type NotionResponse = {
  integration: NotionIntegration; kunci: string;
  batas: { pembuatanHalaman: number; jendelaMenit: number; halamanDisimpan: number; judulMaks: number; isiMaks: number; tokenMaks: number };
  catatan: string;
};
export type NotionPageResponse = { halaman: NotionPage; integration: NotionIntegration };

/** Butir 69 — kanal bot (Telegram/WhatsApp). `webhook.pesan` memuat jawaban hulu apa adanya. */
export type BotChannelWebhook = {
  jalur: string; rahasiaTerpasang: boolean; url: string | null;
  terdaftar?: boolean; status?: number; pesan?: string;
};
export type BotChannel = {
  id: string; provider: 'telegram' | 'whatsapp'; name: string; enabled: boolean;
  agentName: string; tagline: string;
  rahasia: { terpasang: boolean; ekor: string; dapatDibaca: boolean; jenis: string };
  webhook: BotChannelWebhook; createdAt: string; updatedAt: string;
};
export type BotChannelsResponse = { channels: BotChannel[] };

/** Butir 69 (v0.23.1) — hasil "uji kirim": satu pesan nyata ke kanal tersimpan, jawaban hulu apa adanya. */
export type BotTestResponse = {
  terkirim: boolean; jalur: string; statusHulu: number[]; tujuan: string; panjangTeks: number;
  pesanHulu: string; kanal: BotChannel;
};

/** Butir 69 — kode pemasangan akun ke bot (sekali pakai, berlaku terbatas). */
export type BotLinkCode = {
  kode: string; identityId: string; channelId: string; kanal: string; provider: string;
  berlakuMenit: number; kedaluwarsa: string; caraPakai: string; perintah: string; maksPercobaan: number;
};
export type BotIdentity = {
  id: string; channelId: string; provider: string; kanal: string; externalId: string;
  userId: string; linkedAt: string; usedAt: string | null;
};

/** Butir 71 — katalog konektor dan keadaan satu sambungan. `lastError` ditampilkan apa adanya. */
export type ConnectorKind = 'slack' | 'discord' | 'mcp';
export type ConnectorCatalogueEntry = {
  kind: ConnectorKind; nama: string; keterangan: string; rahasia: string; contoh: string;
  dasarStatus: 'platform' | 'sambungan_pengguna'; status: string;
};
export type ConnectorView = {
  id: string; kind: ConnectorKind; nama: string; enabled: boolean; status: string; lastError: string | null;
  tautan: { terpasang: boolean; tersegel: boolean; bisaDibuka: boolean; ekor: string | null; host: string | null; alat: string[] };
  createdAt: string; updatedAt: string;
};
/** Balasan rute admin daftar putih alat MCP (butir 71) — satu-satunya penulis di produksi. */
export type McpAllowedToolsResponse = {
  alat: string[]; terbuka: boolean; batas?: { maksimalAlat: number; polaNama: string }; catatan?: string; pesan?: string;
};
export type ConnectorsResponse = {
  katalog: ConnectorCatalogueEntry[]; konektor: ConnectorView[]; total: number;
  pengaturan: {
    kunci: string; jenisKonektor: string[]; statusSah: string[]; mcpAllowedTools: string[]; mcpTerbuka: boolean;
    daftarPutihHost: string[]; pekerjaDalamProses: boolean; batasMenungguHuluMs: number;
    batasHidupProsesAnakMs: number; maksimalKonektor: number;
  };
  catatan: string;
};
export type ConnectorTestResponse = {
  konektor: ConnectorView;
  hasil: { dijalankan: boolean; status: string; kode: string; pesan: string; upstreamStatus: number | null; durasiMs: number } | null;
  pekerjaan: { id: string | null; diklaim: string; pesan: string };
  pengaturan?: { pekerjaDalamProses: boolean; batasMenungguHuluMs: number; batasHidupProsesAnakMs: number };
};

/** Butir 74 — nominal unik. `nominalBayarIdr` = dasar + kode; `amount_idr` TIDAK diubah server. */
export type UniqueAmountOrder = {
  orderId: string; amountIdr: number; totalIdr: number; dasarIdr: number;
  uniqueAmountIdr: number | null; nominalBayarIdr: number; k: number | null; method: string; status: string;
};
export type UniqueAmountResponse = {
  order: UniqueAmountOrder; uniqueAmountIdr: number; k: number; baseIdr: number; percobaan: number;
  sudahAda: boolean; catatan: string;
};
export type ManualQueueRow = {
  orderId: string; userId: string; email: string; planCode: string; months: number; amountIdr: number;
  totalIdr: number; uniqueAmountIdr: number | null; nominalBayarIdr: number; punyaNominalUnik: boolean; createdAt: string;
};
export type ManualQueueResponse = { orders: ManualQueueRow[]; belumBernominalUnik: number };
export type ManualQueueFillResponse = {
  diisi: number; gagal: number;
  orders: Array<{ orderId: string; uniqueAmountIdr: number; k: number }>;
  kegagalan: Array<{ orderId: string; error: string }>;
};

/** Butir 76 — avatar. Server menulis ulang gambar sebagai PNG; JPEG/WebP mentah dijawab 503. */
export type AvatarResult = {
  userId?: string; terpasang: boolean; berkas: string | null; ukuran: number | null; lebar: number | null;
  tinggi: number | null; jenis?: string;
  asal?: { lebar: number; tinggi: number; jenis: string; byte: number } | null;
  potong?: { kiri: number; atas: number; sisi: number } | null;
  berkasLamaDihapus?: boolean; namaKlienDipakai?: boolean; catatan?: string;
  diperbaruiPada?: string | null; oleh?: string | null; mediaPath?: string | null;
};

/** Butir 78 tahap 1 — laporan versi mesin (admin). `engineVersion` bisa berupa kalimat
 *  "versi tidak dilaporkan" bila mesin tidak melaporkan versinya; halaman menampilkan apa adanya. */
export type EngineVersionReport = {
  engineVersion: string | null; platformVersion: string; startedAt: string; schemaVersion: number;
  engineKind: string; engineAvailable: boolean; engineVersionSource: string;
  engineBinary: { path: string; present: boolean; version: string | null; detail: string | null };
  healthError: string | null; checkedAt: string;
  tahap2: { tersedia: boolean; catatan: string }; catatan: string;
};

/** Kalimat yang dipakai server saat mesin tidak melaporkan versinya (wave11c/engine-version.ts). */
export const VERSI_TIDAK_DILAPORKAN = 'versi tidak dilaporkan';

/* ================= Wave 11A (butir 80): pagar konteks total =================
 * Bentuk di bawah disalin dari balasan NYATA rute `GET /api/v1/context-budget/report`
 * (`budgetReport()` + `limitMin`/`limitMax`/`defaultChars` di apps/api/src/wave11a/context-budget.ts).
 * Halaman Pemakaian menampilkan angka apa adanya, termasuk saat ada yang dipotong. */

/** Satu bagian sisipan yang dibuang atau dipotong sebagian. `alasan` hanya dua nilai dari server. */
export type ContextBudgetDrop = { name: string; chars: number; alasan: 'prioritas_terendah' | 'dipotong_sebagian' };

/** Keadaan satu bagian sisipan: `terkirim=false` berarti bagian itu TIDAK ikut ke mesin. */
export type ContextBudgetBlock = { name: string; priority: number; chars: number; keterangan: string; terkirim: boolean };

/** Laporan pagar konteks: pagar aktif, total sebelum dipotong, yang terkirim, dan catatan jujur server. */
export type ContextBudgetReport = {
  budgetChars: number; keptChars: number; totalCharsBeforeTrim: number; overBudget: boolean;
  dipotong: ContextBudgetDrop[]; blocks: ContextBudgetBlock[]; catatan: string;
  limitMin: number; limitMax: number; defaultChars: number;
};

/** Galat API yang menyimpan kode mesin, status, dan badan jawaban (pesan Indonesia dari server). */
export type ApiFailureDetails = { status: number; code: string; message: string; body: Record<string, unknown> | null };

/** Baca kode/status/pesan dari galat apa pun; galat lama (kode mesin saja) tetap aman. */
export function failureOf(error: unknown): ApiFailureDetails {
  const raw = (error ?? {}) as { code?: unknown; status?: unknown; body?: unknown; message?: unknown };
  const fallback = typeof raw.message === 'string' && raw.message ? raw.message : String(error);
  return {
    status: typeof raw.status === 'number' ? raw.status : 0,
    code: typeof raw.code === 'string' && raw.code ? raw.code : fallback,
    message: typeof raw.message === 'string' && raw.message ? raw.message : fallback,
    body: (raw.body ?? null) as Record<string, unknown> | null,
  };
}

/** Ambil daftar baris dari jawaban server walau pembungkusnya berbeda-beda. */
export function rowsOf<T>(payload: unknown, ...keys: string[]): T[] {
  if (Array.isArray(payload)) return payload as T[];
  const source = (payload ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

/** Panggilan yang mempertahankan pesan Indonesia + kode mesin dari server (rute Wave 11A). */
async function requestDetailed<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const unsafe = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(unsafe ? csrfHeader() : {}), ...(options.headers || {}) },
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const body = (data ?? null) as (ApiError & { message?: string }) | null;
    const code = body?.error || `HTTP_${response.status}`;
    const failure = new Error(body?.message || code) as Error & { code: string; status: number; body: Record<string, unknown> | null };
    failure.code = code;
    failure.status = response.status;
    failure.body = (body as Record<string, unknown> | null);
    throw failure;
  }
  return data as T;
}

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
  /** Wave 8: closing an account is a soft delete. An export made in the last day is required first. */
  deleteAccount: (password: string, exportId?: string) => request<{ ok: true; deletedAt: string; purgeAfter: string; recoveryDays: number; exportId: string }>(
    '/v1/auth/account', { method: 'DELETE', body: JSON.stringify({ password, confirm: 'HAPUS AKUN', exportId }) }),
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
  /** Rincian satu run: dipakai Riwayat run untuk menampilkan penanda perpindahan model (butir 57). */
  runDetail: (runId: string) => request<RunDetail>(`/v1/runs/${encodeURIComponent(runId)}`),
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
  adminUpdateUser: (userId: string, patch: { displayName?: string; email?: string; tier?: string; isAdmin?: boolean; emailVerified?: boolean }) => request<{ user: AdminUserRow }>(`/v1/admin/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Wave 8: an admin can set a password for somebody else and bring a closed account back. */
  adminSetUserPassword: (userId: string, password?: string) => request<{ ok: true; userId: string; email: string; password: string; generated: boolean }>(
    `/v1/admin/users/${encodeURIComponent(userId)}/password`, { method: 'POST', body: JSON.stringify(password ? { password } : {}) }),
  adminRestoreUser: (userId: string) => request<{ ok: true; userId: string; email: string }>(
    `/v1/admin/users/${encodeURIComponent(userId)}/restore`, { method: 'POST' }),
  adminResetQuota: (userId: string) => request<{ ok: boolean; quota: QuotaState }>(`/v1/admin/users/${encodeURIComponent(userId)}/reset-quota`, { method: 'POST' }),
  adminGrantCredit: (userId: string, tokens: number, note?: string) => request<{ creditTokens: number }>(`/v1/admin/users/${encodeURIComponent(userId)}/credit`, { method: 'POST', body: JSON.stringify({ tokens, note }) }),
  setUsdRate: (rate: number) => request<{ usdIdrRate: number }>('/v1/admin/currency', { method: 'PUT', body: JSON.stringify({ rate }) }),

  // --- Branding --------------------------------------------------------------
  branding: () => request<Branding>('/v1/branding'),
  saveBranding: (patch: Partial<Branding>) => request<Branding>('/v1/admin/branding', { method: 'PUT', body: JSON.stringify(patch) }),

  // --- Wave 3: agent workspace ----------------------------------------------
  agentSettings: () => request<{ settings: AgentSettings; /** Wave 11A (butir 57): model cadangan tersimpan, dalam urutan pemakaian. */ fallbackModels: string[]; fallbackHelp?: string; thinkingLevels: ThinkingLevel[]; toolsAllowHelp: string; autonomousHelp: string; quota: QuotaState }>('/v1/agents/settings'),
  saveAgentSettings: (patch: { thinkingLevel?: ThinkingLevel; autoCompact?: boolean; compactAfterMessages?: number; toolsAllow?: string; autonomousDefault?: boolean; autonomousMaxTurns?: number; autonomousMaxTokens?: number; /** Wave 11A (butir 57): maksimal 3 model cadangan, urut prioritas, tanpa model utama. */ fallbackModels?: string[]; /** Model utama yang sedang dipakai; server menolak cadangan yang sama dengannya. */ modelUtama?: string }) => request<{ settings: AgentSettings }>('/v1/agents/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
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
  /** Wave 9 (butir 19): konsol harga AI. Hanya admin platform yang boleh memakainya. */
  adminPricing: (query: PricingQuery = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.only) params.set('only', query.only);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.days) params.set('days', String(query.days));
    const suffix = params.toString();
    return request<PricingTable>(`/v1/admin/pricing${suffix ? `?${suffix}` : ''}`);
  },
  adminPricingReconcile: (query: { days?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.days) params.set('days', String(query.days));
    if (query.limit) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return request<CostReconciliation>(`/v1/admin/pricing/reconcile${suffix ? `?${suffix}` : ''}`);
  },
  adminPricingSetMarkup: (markup: number) =>
    request<PricingSettingsResult>('/v1/admin/pricing/settings', { method: 'PUT', body: JSON.stringify({ markup }) }),
  adminPricingSetModel: (model: string, price: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) =>
    request<PricingModelResult>(`/v1/admin/pricing/models/${encodeURIComponent(model)}`, { method: 'PUT', body: JSON.stringify(price) }),
  adminPricingResetModel: (model: string) =>
    request<PricingModelResult>(`/v1/admin/pricing/models/${encodeURIComponent(model)}`, { method: 'DELETE' }),
  // --- Wave 11A (v0.21.0, butir 42/46-57) -------------------------------------
  // Rute di bawah memakai requestDetailed supaya pesan Indonesia dari server tampil apa adanya,
  // sementara kode mesinnya (mis. ARTIFACT_CHANGED) tetap bisa dibaca UI lewat failureOf().
  /** Butir 42: mode percakapan "diskusi" atau "eksekusi". */
  conversationMode: (conversationId: string) => requestDetailed<AgentModeState>(`/v1/conversations/${encodeURIComponent(conversationId)}/mode`),
  saveConversationMode: (conversationId: string, mode: AgentMode) => requestDetailed<AgentModeState>(`/v1/conversations/${encodeURIComponent(conversationId)}/mode`, { method: 'PUT', body: JSON.stringify({ mode }) }),

  /** Butir 48: isi artefak, simpan revisi baru, daftar revisi, lihat revisi, dan pulihkan. */
  artifactContent: (artifactId: string) => requestDetailed<ArtifactContentResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}/content`),
  saveArtifactContent: (artifactId: string, input: { content: string; baseRevision: number; note?: string }) =>
    requestDetailed<ArtifactSaveResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}/content`, { method: 'PUT', body: JSON.stringify(input) }),
  artifactRevisions: (artifactId: string) => requestDetailed<ArtifactRevisionList>(`/v1/artifacts/${encodeURIComponent(artifactId)}/revisions`),
  artifactRevisionContent: (artifactId: string, revision: number) =>
    requestDetailed<{ revisionNumber: number; content: string }>(`/v1/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(String(revision))}`),
  restoreArtifactRevision: (artifactId: string, revision: number, baseRevision?: number) =>
    requestDetailed<ArtifactRestoreResponse>(`/v1/artifacts/${encodeURIComponent(artifactId)}/revisions/${encodeURIComponent(String(revision))}/restore`, { method: 'POST', body: JSON.stringify(baseRevision === undefined ? {} : { baseRevision }) }),

  /** Butir 54: ekspor dulu, lalu hapus riwayat percakapan sekaligus. Artefak tidak ikut terhapus. */
  bulkExportConversations: (input: { scope: BulkDeleteScope; projectId?: string; workspaceId?: string }) =>
    requestDetailed<BulkExportResponse>('/v1/conversations/bulk-export', { method: 'POST', body: JSON.stringify(input) }),
  bulkDeleteConversations: (input: { scope: BulkDeleteScope; projectId?: string; workspaceId?: string; exportId: string; confirm: string }) =>
    requestDetailed<BulkDeleteResponse>('/v1/conversations/bulk-delete', { method: 'POST', body: JSON.stringify(input) }),

  /** Butir 56: perkiraan biaya tanpa efek samping (tidak menulis run atau pemakaian). */
  playgroundEstimate: (input: { model: string; prompt: string; outputTokens?: number; runs?: number }) =>
    requestDetailed<PlaygroundEstimate>('/v1/playground/estimate', { method: 'POST', body: JSON.stringify(input) }),

  /** Butir 46: guardrails platform + laporan audit-diri (butir 53). */
  guardrails: () => requestDetailed<GuardrailsResponse>('/v1/guardrails'),
  createGuardrail: (input: { kind: string; title: string; body: string; enabled?: boolean; sortOrder?: number }) =>
    requestDetailed<{ rule: GuardrailRule }>('/v1/guardrails', { method: 'POST', body: JSON.stringify(input) }),
  updateGuardrail: (ruleId: string, patch: { kind?: string; title?: string; body?: string; enabled?: boolean; sortOrder?: number }) =>
    requestDetailed<{ rule: GuardrailRule }>(`/v1/guardrails/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteGuardrail: (ruleId: string) => requestDetailed<{ deleted: boolean; id: string }>(`/v1/guardrails/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }),
  safetyReport: () => requestDetailed<SafetyReport>('/v1/safety'),

  /** Butir 51: skill milik pengguna (pasang, ubah, hapus). */
  mySkills: () => requestDetailed<UserSkillsResponse>('/v1/skills/mine'),
  installMySkill: (input: { name: string; description?: string; content?: string; enabled?: boolean }) =>
    requestDetailed<{ skill: UserSkill }>('/v1/skills/mine', { method: 'POST', body: JSON.stringify(input) }),
  updateMySkill: (skillId: string, patch: { name?: string; description?: string; content?: string; enabled?: boolean }) =>
    requestDetailed<{ skill: UserSkill }>(`/v1/skills/mine/${encodeURIComponent(skillId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMySkill: (skillId: string) => requestDetailed<{ deleted: boolean; id: string }>(`/v1/skills/mine/${encodeURIComponent(skillId)}`, { method: 'DELETE' }),

  /** Butir 52: basis pengetahuan platform (baca untuk semua, tulis untuk admin). */
  knowledgeBase: () => requestDetailed<KnowledgeBaseResponse>('/v1/knowledge-base'),
  adminCreateKnowledgeBase: (input: { section: string; title: string; content: string; enabled?: boolean; sortOrder?: number }) =>
    requestDetailed<{ entry: KnowledgeBaseEntry }>('/v1/admin/knowledge-base', { method: 'POST', body: JSON.stringify(input) }),
  adminUpdateKnowledgeBase: (entryId: string, patch: { section?: string; title?: string; content?: string; enabled?: boolean; sortOrder?: number }) =>
    requestDetailed<{ entry: KnowledgeBaseEntry }>(`/v1/admin/knowledge-base/${encodeURIComponent(entryId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  adminDeleteKnowledgeBase: (entryId: string) =>
    requestDetailed<{ deleted: boolean; id: string }>(`/v1/admin/knowledge-base/${encodeURIComponent(entryId)}`, { method: 'DELETE' }),

  /** Butir 47: kebijakan alat (tools policy). Butir 57: daftar model cadangan. */
  toolsPolicy: () => requestDetailed<ToolsPolicyResponse>('/v1/tools-policy'),
  /** `null`, `[]`, atau 'none' berarti TANPA ALAT; daftar nama berarti hanya alat itu yang boleh dipakai. */
  saveToolsPolicy: (tools: string[] | null | 'none') =>
    requestDetailed<ToolsPolicyResponse>('/v1/tools-policy', { method: 'PUT', body: JSON.stringify({ tools }) }),
  /** Butir 47 (khusus admin): isi katalog alat yang dikenal platform; kirim [] untuk mengosongkannya. */
  saveToolCatalog: (tools: string[]) =>
    requestDetailed<{ catalog: string[]; count: number }>('/v1/admin/tool-catalog', { method: 'PUT', body: JSON.stringify({ tools }) }),
  /** Butir 53: audit-diri kredensial & konfigurasi (khusus admin platform, 403 ADMIN_REQUIRED bila bukan). */
  selfAudit: () => requestDetailed<SelfAuditReport>('/v1/admin/self-audit'),
  fallbackModels: () => requestDetailed<FallbackModelsResponse>('/v1/agents/fallback'),

  /* ---------------------------------------- Wave 11B (butir 58-72, v0.22.0) */

  /** Butir 60: pelajaran akun (daftar, tambah, ubah, hapus). */
  learnings: () => requestDetailed<LearningsResponse>('/v1/learnings'),
  createLearning: (input: { title: string; body: string; tags?: string; pinned?: boolean }) =>
    requestDetailed<{ learning: Learning }>('/v1/learnings', { method: 'POST', body: JSON.stringify(input) }),
  updateLearning: (learningId: string, patch: { title?: string; body?: string; tags?: string; pinned?: boolean; enabled?: boolean }) =>
    requestDetailed<{ learning: Learning }>(`/v1/learnings/${encodeURIComponent(learningId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteLearning: (learningId: string) =>
    requestDetailed<{ deleted: boolean; id: string }>(`/v1/learnings/${encodeURIComponent(learningId)}`, { method: 'DELETE' }),

  /** Butir 58: dewan juri — perkiraan dulu, lalu jalan, lalu hasil per juri. */
  councilEstimate: (input: { material: string; question: string; jurors?: string[] }) =>
    requestDetailed<CouncilEstimateResponse>('/v1/council/estimate', { method: 'POST', body: JSON.stringify(input) }),
  councilRun: (input: { material: string; question: string; jurors?: string[]; projectId?: string | null; conversationId?: string | null }) =>
    requestDetailed<CouncilRunResponse>('/v1/council/run', { method: 'POST', body: JSON.stringify(input) }),
  councilRuns: () => requestDetailed<CouncilRunsResponse>('/v1/council/runs'),
  councilRunDetail: (councilRunId: string) =>
    requestDetailed<CouncilRunDetail>(`/v1/council/runs/${encodeURIComponent(councilRunId)}`),

  /** Butir 61: benchmark. Perkiraan WAJIB dihitung dulu; angka itu yang dikirim ulang saat menjalankan. */
  benchmarkEstimate: (models: string[]) =>
    requestDetailed<BenchmarkEstimateResponse>('/v1/benchmark/estimate', { method: 'POST', body: JSON.stringify({ models }) }),
  benchmarkRun: (models: string[], estimatedCostMicros: number) =>
    requestDetailed<BenchmarkRunResponse>('/v1/benchmark/run', { method: 'POST', body: JSON.stringify({ models, estimatedCostMicros }) }),
  benchmarkRunDetail: (benchmarkRunId: string) =>
    requestDetailed<BenchmarkRunDetail>(`/v1/benchmark/runs/${encodeURIComponent(benchmarkRunId)}`),

  /** Butir 62 + 63: timeline satu run dan kelayakan lanjutannya. */
  runTimeline: (runId: string) => requestDetailed<RunTimelineResponse>(`/v1/runs/${encodeURIComponent(runId)}/timeline`),
  resumeStatus: (runId: string) => requestDetailed<ResumeStatus>(`/v1/runs/${encodeURIComponent(runId)}/resume-status`),
  resumeRun: (runId: string, mode: 'auto' | 'manual') =>
    requestDetailed<ResumeStartResponse>(`/v1/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: JSON.stringify({ mode }) }),

  /** Butir 64: ekspor lewat tautan unduh (cookie sesi), impor lewat JSON yang dikirim badan permintaan. */
  personaExportUrl: () => '/api/v1/personas/export',
  importPersonas: (personas: unknown[]) =>
    requestDetailed<PersonaImportResponse>('/v1/personas/import', { method: 'POST', body: JSON.stringify({ personas }) }),

  /** Butir 65: pemakaian dan aktivitas akun sendiri. */
  accountUsage: (period: string) => requestDetailed<AccountUsageResponse>(`/v1/account/usage?period=${encodeURIComponent(period)}`),
  accountAudit: (days: number) => requestDetailed<AccountAuditResponse>(`/v1/account/audit?days=${encodeURIComponent(String(days))}`),

  /** Butir 66: laporan galat admin (daftar JSON + tautan CSV). */
  adminErrors: (filter: { kind?: string; from?: string; to?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.from) query.set('from', filter.from);
    if (filter.to) query.set('to', filter.to);
    if (filter.limit) query.set('limit', String(filter.limit));
    const suffix = query.toString();
    return requestDetailed<AdminErrorsResponse>(`/v1/admin/errors${suffix ? `?${suffix}` : ''}`);
  },
  adminErrorsCsvUrl: (filter: { kind?: string; from?: string; to?: string } = {}) => {
    const query = new URLSearchParams();
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.from) query.set('from', filter.from);
    if (filter.to) query.set('to', filter.to);
    const suffix = query.toString();
    return `/api/v1/admin/errors/export.csv${suffix ? `?${suffix}` : ''}`;
  },

  /** Butir 67: pembukuan token (baca untuk admin, set saldo bulanan). */
  tokenAccounting: (month?: string) =>
    requestDetailed<TokenAccountingResponse>(`/v1/admin/token-accounting${month ? `?month=${encodeURIComponent(month)}` : ''}`),
  setTokenBudget: (month: string, tokens: number, note?: string) =>
    requestDetailed<{ month: string; saldo: number; note: string; updatedAt: string }>('/v1/admin/token-budget', {
      method: 'POST', body: JSON.stringify({ month, tokens, ...(note === undefined ? {} : { note }) }),
    }),

  /** Butir 59: mode bayangan. */
  shadowMode: () => requestDetailed<ShadowModeResponse>('/v1/admin/shadow'),
  setShadowMode: (mode: 'on' | 'off') =>
    requestDetailed<{ mode: string; diterapkanPadaRunBerikutnya: boolean; catatan: string }>('/v1/admin/shadow', {
      method: 'PUT', body: JSON.stringify({ mode }),
    }),

  /** Butir 72: jadwal prompt. */
  schedules: () => requestDetailed<SchedulesResponse>('/v1/schedules'),
  createSchedule: (input: { prompt: string; cron: string; timezone?: string; projectId?: string | null; conversationId?: string | null; model?: string | null; thinking?: string; autonomous?: boolean; enabled?: boolean }) =>
    requestDetailed<{ schedule: Schedule }>('/v1/schedules', { method: 'POST', body: JSON.stringify(input) }),
  updateSchedule: (scheduleId: string, patch: { prompt?: string; cron?: string; timezone?: string; model?: string | null; thinking?: string; autonomous?: boolean; enabled?: boolean }) =>
    requestDetailed<{ schedule: Schedule }>(`/v1/schedules/${encodeURIComponent(scheduleId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteSchedule: (scheduleId: string) =>
    requestDetailed<{ deleted: boolean; scheduleId: string }>(`/v1/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' }),
  runScheduleNow: (scheduleId: string) =>
    requestDetailed<ScheduleRunNowResponse>(`/v1/schedules/${encodeURIComponent(scheduleId)}/run-now`, { method: 'POST' }),

  /* ---------------- Wave 11C: butir 68/69/71/74/76/78 ----------------
   * Catatan pemakaian: semua metode ini memakai `requestDetailed` supaya kode galat mesin dari
   * server (`NOTION_TOKEN_INVALID`, `CONNECTOR_HOST_NOT_ALLOWED`, `IMAGE_PROCESSOR_UNAVAILABLE`, dst.)
   * tetap terbaca lewat `failureOf(error).code` dan pesan Indonesia dari server ditampilkan apa adanya. */

  /** Butir 68: keadaan sambungan Notion. Token TIDAK pernah dikembalikan; yang ada hanya ekor. */
  notion: () => requestDetailed<NotionResponse>('/v1/integrations/notion'),
  notionConnect: (token: string) =>
    requestDetailed<{ integration: NotionIntegration; workspace: { id?: string; name?: string }; pesan: string }>(
      '/v1/integrations/notion', { method: 'PUT', body: JSON.stringify({ token }) }),
  notionDisconnect: () =>
    requestDetailed<{ deleted: boolean; provider: string }>('/v1/integrations/notion', { method: 'DELETE' }),
  notionCreatePage: (input: { title: string; content: string }) =>
    requestDetailed<NotionPageResponse>('/v1/integrations/notion/pages', { method: 'POST', body: JSON.stringify(input) }),

  /** Butir 69: kanal bot (admin platform) dan identitas bot milik pengguna. */
  botChannels: () => requestDetailed<BotChannelsResponse>('/v1/admin/bot-channels'),
  saveBotChannel: (input: {
    id?: string; provider: 'telegram' | 'whatsapp'; name?: string; token?: string; accountSid?: string;
    fromNumber?: string; agentName?: string; tagline?: string; enabled?: boolean; pasangWebhook?: boolean;
  }) => requestDetailed<{ channel: BotChannel }>('/v1/admin/bot-channels', { method: 'PUT', body: JSON.stringify(input) }),
  botLinkCode: (channelId?: string) =>
    requestDetailed<{ kode: BotLinkCode }>('/v1/bot-identities/link-code', { method: 'POST', body: JSON.stringify(channelId ? { channelId } : {}) }),
  botIdentities: () => requestDetailed<{ identitas: BotIdentity[] }>('/v1/bot-identities'),
  botRevokeIdentity: (identityId: string) =>
    requestDetailed<{ dihapus: boolean; id: string; oleh: string }>(`/v1/bot-identities/${encodeURIComponent(identityId)}`, { method: 'DELETE' }),
  /** Butir 69: kirim SATU pesan uji ke kanal bot tersimpan (admin platform). Isi `chatId` opsional:
   *  tanpa itu server memakai tautan paling baru di kanal tersebut, atau menjawab 409 apa adanya. */
  botTestChannel: (channelId: string, input?: { chatId?: string; teks?: string }) =>
    requestDetailed<BotTestResponse>(`/v1/admin/bot-channels/${encodeURIComponent(channelId)}/test`, { method: 'POST', body: JSON.stringify(input ?? {}) }),

  /** Butir 71: katalog konektor + uji kirim. Status 'aktif' hanya datang dari server. */
  connectors: () => requestDetailed<ConnectorsResponse>('/v1/connectors'),
  createConnector: (input: { kind: ConnectorKind; url: string; token?: string; alat?: string[]; nama?: string; enabled?: boolean }) =>
    requestDetailed<{ konektor: ConnectorView; pesan: string }>('/v1/connectors', { method: 'POST', body: JSON.stringify(input) }),
  updateConnector: (connectorId: string, patch: { url?: string; token?: string; alat?: string[]; nama?: string; enabled?: boolean }) =>
    requestDetailed<{ konektor: ConnectorView; pesan: string }>(`/v1/connectors/${encodeURIComponent(connectorId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteConnector: (connectorId: string) =>
    requestDetailed<{ deleted: boolean; id: string }>(`/v1/connectors/${encodeURIComponent(connectorId)}`, { method: 'DELETE' }),
  testConnector: (connectorId: string, teks?: string) =>
    requestDetailed<ConnectorTestResponse>(`/v1/connectors/${encodeURIComponent(connectorId)}/test`, { method: 'POST', body: JSON.stringify(teks === undefined ? {} : { teks }) }),

  /** Butir 71 (admin): daftar putih alat MCP. Tanpa penulis ini konektor MCP tidak bisa dibuat sama sekali. */
  mcpAllowedTools: () => requestDetailed<McpAllowedToolsResponse>('/v1/admin/mcp-allowed-tools'),
  saveMcpAllowedTools: (alat: string[]) =>
    requestDetailed<McpAllowedToolsResponse>('/v1/admin/mcp-allowed-tools', { method: 'PUT', body: JSON.stringify({ alat }) }),

  /** Butir 74: nominal unik untuk pesanan transfer manual. */
  billingUniqueAmount: (orderId: string) =>
    requestDetailed<UniqueAmountResponse>(`/v1/billing/orders/${encodeURIComponent(orderId)}/unique-amount`, { method: 'POST', body: JSON.stringify({}) }),
  billingManualQueue: (limit?: number) =>
    requestDetailed<ManualQueueResponse>(`/v1/billing/manual-orders/queue${limit === undefined ? '' : `?limit=${limit}`}`),
  billingFillManualQueue: (limit?: number) =>
    requestDetailed<ManualQueueFillResponse>('/v1/billing/manual-orders/queue/unique-amounts', { method: 'POST', body: JSON.stringify(limit === undefined ? {} : { limit }) }),

  /** Butir 76: avatar. Isi gambar ditransformasi di peramban lebih dulu (PNG), server tetap memeriksa. */
  uploadAvatar: (contentBase64: string, declaredName?: string, declaredMimeType?: string) =>
    requestDetailed<{ avatar: AvatarResult }>('/v1/account/avatar', {
      method: 'PUT',
      body: JSON.stringify({ contentBase64, ...(declaredName ? { declaredName } : {}), ...(declaredMimeType ? { declaredMimeType } : {}) }),
    }),
  deleteAvatar: () => requestDetailed<{ avatar: AvatarResult }>('/v1/account/avatar', { method: 'DELETE' }),
  agentAvatar: () => requestDetailed<{ agentAvatar: AvatarResult }>('/v1/admin/agent-avatar'),
  uploadAgentAvatar: (contentBase64: string, declaredName?: string, declaredMimeType?: string) =>
    requestDetailed<{ agentAvatar: AvatarResult }>('/v1/admin/agent-avatar', {
      method: 'PUT',
      body: JSON.stringify({ contentBase64, ...(declaredName ? { declaredName } : {}), ...(declaredMimeType ? { declaredMimeType } : {}) }),
    }),
  deleteAgentAvatar: () => requestDetailed<{ agentAvatar: AvatarResult }>('/v1/admin/agent-avatar', { method: 'DELETE' }),
  avatarUrl: (userId: string) => `/api/v1/media/avatar/${encodeURIComponent(userId)}`,
  agentAvatarUrl: () => '/api/v1/media/agent-avatar',

  /** Butir 78 tahap 1: laporan versi mesin (admin platform). */
  engineVersion: () => requestDetailed<EngineVersionReport>('/v1/admin/engine/version'),

  /** Butir 80: laporan pagar konteks total + daftar sisipan yang dipotong. `conversationId` opsional;
   *  tanpa itu server memeriksa sisipan untuk pengguna yang sedang masuk. */
  contextBudgetReport: (conversationId?: string) =>
    request<ContextBudgetReport>(`/v1/context-budget/report${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`),

  /** Wave 10: gerbang umum untuk halaman baru. Jalur ditulis tanpa awalan /api, dan cookie CSRF
   *  ditambahkan otomatis untuk metode yang mengubah data. */
  get: <T>(path: string) => request<T>(path),
  send: <T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown) =>
    request<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  /** Jawaban teks biasa, misalnya /v1/metrics, yang TIDAK berformat JSON. */
  text: async (path: string) => {
    const response = await fetch(`/api${path}`, { credentials: 'include' });
    const body = await response.text();
    if (!response.ok) throw new Error(body.slice(0, 200) || `Request gagal (${response.status})`);
    return body;
  },
};
