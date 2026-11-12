export type JrRoutine = {
  id: string;
  name: string;
  instructions: string;
  conversationId: string;
  cronJobId: string;
  enabled: boolean;
  createdAt: string | null;
  lastRunAt: string | null;
  webhookUrl?: string;
  webhookSecret?: string;
};

export type JrRoutineTrigger = {
  id: string;
  routineId: string;
  cronJobId: string;
  conversationId: string;
  instructions: string;
  name: string;
  payload: Record<string, unknown> | null;
  createdAt: string | null;
  expiresAt: string | null;
};

export type JrRoutineCreateInput = {
  name: string;
  instructions: string;
  conversationId: string;
  cronJobId: string;
};
