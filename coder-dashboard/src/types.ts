export type User = { id: string; username: string; name?: string; role?: string; tier?: string; hasAvatar?: boolean };
export type Session = { id: string; name?: string; pinned?: boolean; createdAt?: number; lastUsed?: number };
export type Message = { role: 'user' | 'assistant'; content: string; createdAt?: number };
export type ApiError = { error?: string };
