import type { SpeechToTextConfig } from '@/common/types/provider/speech';
import type { IMcpServer, TProviderWithModel } from '@/common/config/storage';

export type GoogleClientSetting = {
  proxy?: string;
};

export type ImageGenerationModelSetting = TProviderWithModel & {
  switch?: boolean;
};

export type ClientBusinessSettingMap = {
  'jr.botWorkspaces':
    | Record<
        string,
        {
          workspace: string;
          appearance?: JrAppearance;
          conversationId?: string;
          instructions?: string;
          learning?: string;
          /** A section the person named. Absent bots stay in the main list. */
          section?: string;
          skillIds?: string[];
          /** Always true. A stored false is rewritten the next time the bot is loaded. */
          useChrome?: boolean;
        }
      >
    | undefined;
  'google.config': GoogleClientSetting;
  'mcp.config': IMcpServer[] | undefined;
  'tools.imageGenerationModel': ImageGenerationModelSetting | undefined;
  'tools.speechToText': SpeechToTextConfig | undefined;
  'acp.promptTimeout': number | undefined;
  'acp.agentIdleTimeout': number | undefined;
  /**
   * Preview size ceiling for text-like files, **in whole megabytes**.
   *
   * Stored in MB rather than bytes because that is the unit the settings field
   * presents; the byte conversion belongs to the one place that compares against a
   * file size (`resolvePreviewPayload`). Keeping the stored unit and the displayed
   * unit identical means a value read back from storage never has to be
   * reinterpreted.
   *
   * `undefined` means "never configured" and falls back to the built-in default —
   * distinct from any number the user could enter.
   */
  'preview.textSizeLimitMb': number | undefined;
};

export type ClientBusinessSettingKey = keyof ClientBusinessSettingMap;

export type JrShape =
  | 'bubble'
  | 'cloud'
  | 'square'
  | 'sparkle'
  | 'clover'
  | 'heart'
  | 'flower'
  | 'drop'
  | 'pill'
  | 'wedge'
  | 'house'
  | 'star'
  | 'hexagon';
export type JrColor =
  | 'black'
  | 'brown'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'violet'
  | 'magenta'
  | 'gray';
export type JrAppearance = { shape: JrShape; color: JrColor };

export type JrUsageSnapshot = {
  startedAt: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens?: number | null;
  /** Reported tokens in the last 5 hours. Absent when the server did not send a window. */
  tokensLast5h?: number | null;
  /** Reported tokens in the last 7 days. Absent when the server did not send a window. */
  tokensThisWeek?: number | null;
  cachedPromptTokens: number | null;
  modelRequests: number;
  requests?: number;
  completedRequests?: number;
  meteredRequests?: number;
  unmeteredRequests?: number;
  averageLatencyMs?: number | null;
  averageFirstByteMs?: number | null;
  lastRequestAt?: string | null;
  /** Last 30 São Paulo days, oldest first. Absent on older control servers. */
  daily?: JrUsageDay[];
  /** Busiest rolling 5-hour window inside the last 1, 7 and 30 days. Absent on older control servers. */
  peak5h?: JrUsagePeak[];
};

export type JrUsageDay = { date: string; tokens: number; requests: number };
export type JrUsagePeak = { days: number; tokens: number; startedAt: string | null };

export type JrAccessUser = { id: string; name: string; role: 'admin' | 'employee' };

/** The seeded owner is the administrator even if a stored role label drifted. */
export function isJrAdmin(user: { id?: string; role?: string } | null | undefined): boolean {
  if (!user) return false;
  if (user.id === 'owner') return true;
  const role = user.role?.trim().toLocaleLowerCase('pt-BR') ?? '';
  return role === 'admin' || role === 'administrator' || role === 'administrador';
}
export type JrAccessState = {
  status:
    | 'checking'
    | 'signed-out'
    | 'authenticated'
    | 'revoked'
    | 'blocked'
    | 'outside-hours'
    | 'offline'
    | 'unconfigured'
    | 'pilot';
  user: JrAccessUser | null;
  /** Set when sign-in is waiting on OS encryption rather than a missing service URL. */
  notice?: 'storage';
};
export type JrAdminEmployee = JrAccessUser & {
  email?: string | null;
  /** Optional job title. Missing on older control servers. */
  title?: string | null;
  revoked: boolean;
  createdAt: string;
  revokedAt: string | null;
  blocked: boolean;
  blockedAt: string | null;
  tokenLimit: number | null;
  accessStart: string | null;
  accessEnd: string | null;
  devices: Array<{ id: string; name: string; lastSeenAt: string; expiresAt: string; revokedAt: string | null }>;
  usage: JrUsageSnapshot | null;
};
export type JrEmployee = JrAdminEmployee;
export type JrInvite = { id: string; code: string; expiresAt: string };

export type JrConnectionStatus = {
  connected: boolean;
  model: string | null;
  usage: JrUsageSnapshot | null;
  /** Set when the control service is answering through a free fallback provider. */
  fallback?: boolean;
};
