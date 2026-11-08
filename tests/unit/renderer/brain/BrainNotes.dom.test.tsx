import React from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ptBR, withI18n } from '../teach/learn/i18nTestUtils';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  revise: vi.fn(),
  consent: vi.fn(),
  load: vi.fn(),
  pending: vi.fn(),
}));
const connection = vi.hoisted(() => ({ changed: null as (() => void) | null }));
vi.mock('@/common', () => ({
  ipcBridge: {
    brain: {
      notes: {
        create: { invoke: mocks.create },
        revise: { invoke: mocks.revise },
        consent: { invoke: mocks.consent },
        pending: { invoke: mocks.pending },
      },
    },
    jr: {
      strata: {
        changed: {
          on: (listener: () => void) => {
            connection.changed = listener;
            return () => {};
          },
        },
      },
    },
  },
}));
vi.mock('@renderer/utils/chat/messagePagination', () => ({ loadLatestConversationMessages: mocks.load }));
vi.mock('@arco-design/web-react', async () => ({
  ...(await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react')),
  Message: { success: vi.fn(), error: vi.fn() },
}));
import BrainNoteComposer from '@/renderer/pages/Jr/Brain/Notes';
import ReviewQueue from '@/renderer/pages/Jr/Brain/Notes/ReviewQueue';

const i18n = ptBR();
const key = (name: string): string => i18n.t(`common.jr.brainNotes.${name}`);
const proposal = {
  id: 'proposal-fixture',
  version: 1,
  hash: 'hash-fixture',
  text: 'Nota curta',
  sourceQuote: 'Resposta atual',
  areaId: 2,
  risk: 'low',
  kind: 'shared_note',
  status: 'draft',
};
beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  vi.clearAllMocks();
  mocks.load.mockResolvedValue({
    items: [
      { id: 'u', type: 'text', position: 'right', content: { content: 'Pergunta privada antiga' } },
      { id: 'a', type: 'text', position: 'left', content: { content: 'Resposta atual' } },
    ],
  });
  mocks.create.mockResolvedValue({ proposal, audiences: [{ id: 2, name: 'Equipe de exemplo' }] });
  mocks.consent.mockImplementation(async (input) => ({
    proposal: { ...proposal, status: input.decision === 'share' ? 'active' : 'rejected' },
  }));
});

describe('note consent in chat', () => {
  it('clears the authorized excerpt and ignores an old-company draft that finishes after a switch', async () => {
    let finish: ((value: unknown) => void) | undefined;
    mocks.create.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(withI18n(i18n, <BrainNoteComposer conversationId='fixture-chat' />));
    fireEvent.click(screen.getByRole('button', { name: key('create') }));
    fireEvent.click(await screen.findByRole('button', { name: key('authorizeExcerpt') }));
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    act(() => connection.changed?.());
    await act(async () => {
      finish?.({ proposal, audiences: [{ id: 2, name: 'Old company' }] });
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: key('create') })).toBeNull());
    expect(screen.queryByText('Nota curta')).toBeNull();
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it('does not reuse the previous company review queue for the same employee', async () => {
    mocks.pending.mockResolvedValueOnce([
      { ...proposal, text: 'Company A private review', sourceQuote: 'Company A source' },
    ]);
    mocks.pending.mockImplementationOnce(() => new Promise(() => {}));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ReviewQueue ownerId='same-employee' />
      </SWRConfig>
    );
    await screen.findByText('Company A private review');
    act(() => connection.changed?.());
    expect(screen.queryByText('Company A private review')).toBeNull();
    expect(screen.queryByText('Company A source')).toBeNull();
  });

  it('does not reuse another reviewers cached private proposal or source', async () => {
    mocks.pending.mockResolvedValueOnce([{ ...proposal, text: 'Private review A', sourceQuote: 'Source A' }]);
    mocks.pending.mockImplementationOnce(() => new Promise(() => {}));
    const cache = new Map();
    const view = (ownerId: string) => (
      <SWRConfig value={{ provider: () => cache }}>
        <ReviewQueue ownerId={ownerId} />
      </SWRConfig>
    );
    const mounted = render(view('reviewer-a'));
    await screen.findByText('Private review A');
    mounted.rerender(view('reviewer-b'));
    expect(screen.queryByText('Private review A')).toBeNull();
    expect(screen.queryByText('Source A')).toBeNull();
  });
  it('does not send anything on mount or opening the excerpt editor', async () => {
    render(withI18n(i18n, <BrainNoteComposer conversationId='fixture-chat' />));
    expect(mocks.load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: key('create') }));
    const excerpt = await screen.findByRole('textbox', { name: key('excerpt') });
    expect((excerpt as HTMLTextAreaElement).value).toBe('Resposta atual');
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('explains sharing on keyboard focus and dismisses the explanation with Escape', async () => {
    render(withI18n(i18n, <BrainNoteComposer compact sourceText='Resposta escolhida' />));
    const button = screen.getByRole('button', { name: key('create') });
    fireEvent.focus(button);
    const hint = await screen.findByText(key('createHint'));
    expect(hint).toBeVisible();
    fireEvent.keyDown(button, { key: 'Escape' });
    await waitFor(() => expect(hint).not.toBeVisible());
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('uses the clicked response instead of loading a newer or private conversation', async () => {
    render(withI18n(i18n, <BrainNoteComposer compact conversationId='fixture-chat' sourceText='Resposta escolhida' />));
    fireEvent.click(screen.getByRole('button', { name: key('create') }));
    expect(await screen.findByRole('textbox', { name: key('excerpt') })).toHaveValue('Resposta escolhida');
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: key('authorizeExcerpt') }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({ excerpt: 'Resposta escolhida', sourceRole: 'assistant' })
    );
    expect(mocks.consent).not.toHaveBeenCalled();
  });

  it('sends only the edited authorized excerpt and requires another action to share', async () => {
    render(withI18n(i18n, <BrainNoteComposer conversationId='fixture-chat' />));
    fireEvent.click(screen.getByRole('button', { name: key('create') }));
    fireEvent.change(await screen.findByRole('textbox', { name: key('excerpt') }), {
      target: { value: 'Trecho escolhido' },
    });
    fireEvent.click(screen.getByRole('button', { name: key('authorizeExcerpt') }));
    await screen.findByRole('button', { name: key('shareVersion') });
    expect(mocks.create).toHaveBeenCalledWith({ excerpt: 'Trecho escolhido', sourceRole: 'user' });
    expect(mocks.consent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: key('shareVersion') }));
    await waitFor(() =>
      expect(mocks.consent).toHaveBeenCalledWith({
        id: proposal.id,
        version: 1,
        hash: proposal.hash,
        decision: 'share',
      })
    );
  });

  it('canceling a proposal discards it without sharing', async () => {
    render(withI18n(i18n, <BrainNoteComposer conversationId='fixture-chat' />));
    fireEvent.click(screen.getByRole('button', { name: key('create') }));
    fireEvent.click(await screen.findByRole('button', { name: key('authorizeExcerpt') }));
    await screen.findByRole('textbox', { name: key('text') });
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
    await waitFor(() => expect(mocks.consent).toHaveBeenCalledWith(expect.objectContaining({ decision: 'discard' })));
    expect(mocks.consent.mock.calls.some(([input]) => input.decision === 'share')).toBe(false);
  });

  it('an edit updates the draft and cannot publish until the new version is reviewed', async () => {
    mocks.revise.mockResolvedValue({ proposal: { ...proposal, version: 2, hash: 'new-hash', text: 'Texto revisado' } });
    render(withI18n(i18n, <BrainNoteComposer conversationId='fixture-chat' />));
    fireEvent.click(screen.getByRole('button', { name: key('create') }));
    fireEvent.click(await screen.findByRole('button', { name: key('authorizeExcerpt') }));
    fireEvent.change(await screen.findByRole('textbox', { name: key('text') }), {
      target: { value: 'Texto revisado' },
    });
    fireEvent.click(screen.getByRole('button', { name: key('revise') }));
    await screen.findByRole('button', { name: key('shareVersion') });
    expect(mocks.consent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: key('shareVersion') }));
    await waitFor(() =>
      expect(mocks.consent).toHaveBeenCalledWith(expect.objectContaining({ version: 2, hash: 'new-hash' }))
    );
  });
});
