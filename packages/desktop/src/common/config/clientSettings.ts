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
};

export type JrAccessUser = { id: string; name: string; role: 'admin' | 'employee' };

/** The seeded owner is the administrator even if a stored role label drifted. */
export function isJrAdmin(user: { id: string; role: string } | null | undefined): boolean {
  return user?.role === 'admin' || user?.id === 'owner';
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
};
export type JrAdminEmployee = JrAccessUser & {
  email?: string | null;
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
};
