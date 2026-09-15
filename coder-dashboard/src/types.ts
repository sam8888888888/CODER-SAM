export type User = { id: string; email: string; displayName: string; username?: string; name?: string; role?: string; tier?: string; hasAvatar?: boolean; isAdmin?: boolean };
export type Session = { id: string; name?: string; pinned?: boolean; createdAt?: number; lastUsed?: number };
export type MessageAttachment = { id: string; messageId: string; name: string; mimeType: string; sizeBytes: number };
export type Message = { id?: string; role: 'user' | 'assistant'; content: string; createdAt?: number; runId?: string | null; attachments?: MessageAttachment[] };
export type ApiError = { error?: string };
