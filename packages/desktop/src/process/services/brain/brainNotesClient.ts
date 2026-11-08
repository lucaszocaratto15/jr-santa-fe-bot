import type {
  BrainNoteProposal,
  BrainProposalConsent,
  BrainProposalPatch,
  BrainProposalResult,
} from '@/common/types/agent/brainTypes';
import type { BrainCall } from '../jr/brainClient';

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const invalid = (): never => {
  throw new Error('unavailable');
};

function proposal(value: unknown): BrainNoteProposal {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/.test(value.id) ||
    !Number.isInteger(value.version) ||
    typeof value.hash !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.sourceQuote !== 'string' ||
    !Number.isInteger(value.areaId) ||
    !['low', 'high'].includes(String(value.risk)) ||
    !['shared_note', 'official_procedure'].includes(String(value.kind)) ||
    !['draft', 'active', 'pending_review', 'rejected', 'superseded', 'suspended'].includes(String(value.status))
  )
    return invalid();
  if (value.validFrom !== undefined && (typeof value.validFrom !== 'number' || !Number.isFinite(value.validFrom)))
    return invalid();
  if (
    value.validUntil !== undefined &&
    value.validUntil !== null &&
    (typeof value.validUntil !== 'number' || !Number.isFinite(value.validUntil))
  )
    return invalid();
  return value as BrainNoteProposal;
}

function result(value: unknown): BrainProposalResult {
  if (!record(value)) return invalid();
  const parsed = proposal(value.proposal);
  if (value.audiences === undefined) return { proposal: parsed };
  if (!Array.isArray(value.audiences)) return invalid();
  const audiences = value.audiences.map((item) => {
    if (!record(item) || !Number.isInteger(item.id) || typeof item.name !== 'string') return invalid();
    return { id: item.id as number, name: item.name };
  });
  return { proposal: parsed, audiences };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Explicit note actions only. Legacy conversation queue items never enter this client. */
export function createBrainNotesClient(call: BrainCall) {
  return {
    create: async (input: {
      requestId: string;
      excerpt?: string;
      factId?: number;
      sourceRole?: 'user' | 'assistant';
    }): Promise<BrainProposalResult> =>
      result(
        await call(
          '/api/brain/proposals',
          json('POST', {
            requestId: input.requestId,
            authorized: true,
            ...(input.factId === undefined
              ? { messages: [{ role: input.sourceRole ?? 'user', text: input.excerpt }] }
              : { factId: input.factId }),
          })
        )
      ),
    revise: async ({ id, ...patch }: BrainProposalPatch & { id: string }): Promise<BrainProposalResult> =>
      result(await call(`/api/brain/proposals/${id}`, json('PATCH', patch))),
    consent: async ({ id, ...input }: BrainProposalConsent): Promise<BrainProposalResult> =>
      result(await call(`/api/brain/proposals/${id}/consent`, json('POST', input))),
    pending: async (): Promise<BrainNoteProposal[]> => {
      const value = await call('/api/brain/manage/proposals');
      if (!record(value) || !Array.isArray(value.proposals)) return invalid();
      return value.proposals.map(proposal);
    },
    review: async ({
      id,
      ...input
    }: {
      id: string;
      version: number;
      decision: 'approve' | 'reject';
    }): Promise<BrainProposalResult> =>
      result(await call(`/api/brain/manage/proposals/${id}/review`, json('POST', input))),
  };
}
