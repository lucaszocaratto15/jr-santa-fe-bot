import { ipcBridge } from '@/common';
import type { BrainNoteKind, BrainNoteProposal, BrainProposalResult } from '@/common/types/agent/brainTypes';
import { loadLatestConversationMessages } from '@renderer/utils/chat/messagePagination';
import { Alert, Button, DatePicker, Form, Input, Message, Modal, Radio, Select } from '@arco-design/web-react';
import dayjs from 'dayjs';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authorizedExcerpt } from './noteSelection';
import { getBrainContextVersion, useBrainContextVersion } from '../brainShared';

/** Explicit excerpt authorization, followed by a separate exact-version sharing decision. */
export default function BrainNoteComposer({
  conversationId,
  factId,
  onPublished,
}: {
  conversationId?: string;
  factId?: number;
  onPublished?: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const contextVersion = useBrainContextVersion();
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [excerpt, setExcerpt] = useState('');
  const [sourceRole, setSourceRole] = useState<'user' | 'assistant'>('assistant');
  const [result, setResult] = useState<BrainProposalResult | null>(null);
  const [text, setText] = useState('');
  const [quote, setQuote] = useState('');
  const [areaId, setAreaId] = useState<number>();
  const [kind, setKind] = useState<BrainNoteKind>('shared_note');
  const [validUntil, setValidUntil] = useState<number | null>(null);
  const owner = useRef<string | null>(null);
  useEffect(() => {
    setVisible(false);
    setResult(null);
    setExcerpt('');
    setText('');
    setQuote('');
  }, [contextVersion]);
  useEffect(
    () =>
      ipcBridge.jr?.accessChanged?.on?.((state) => {
        const next = state.status === 'authenticated' ? (state.user?.id ?? null) : null;
        if (next !== owner.current || next === null) {
          setVisible(false);
          setResult(null);
          setExcerpt('');
          setText('');
          setQuote('');
        }
        owner.current = next;
      }),
    []
  );
  const proposal = result?.proposal;
  const dirty =
    proposal &&
    (text !== proposal.text ||
      quote !== proposal.sourceQuote ||
      areaId !== proposal.areaId ||
      kind !== proposal.kind ||
      validUntil !== (proposal.validUntil ?? null));
  const apply = (next: BrainProposalResult): void => {
    setResult((current) => ({ ...next, audiences: next.audiences ?? current?.audiences }));
    setText(next.proposal.text);
    setQuote(next.proposal.sourceQuote);
    setAreaId(next.proposal.areaId);
    setKind(next.proposal.kind);
    setValidUntil(next.proposal.validUntil ?? null);
  };
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch {
      Message.error(t('common.jr.brainNotes.failed'));
    } finally {
      setBusy(false);
    }
  };
  const open = (): void => {
    const selection = window.getSelection()?.toString() ?? '';
    const currentContext = getBrainContextVersion();
    void run(async () => {
      const state = await ipcBridge.jr?.accessStatus?.invoke?.();
      if (currentContext !== getBrainContextVersion()) return;
      if (state && state.status !== 'authenticated') throw new Error('access_required');
      owner.current = state?.user?.id ?? null;
      const currentOwner = owner.current;
      if (factId !== undefined) {
        const next = await ipcBridge.brain.notes.create.invoke({ factId });
        if (currentOwner !== owner.current || currentContext !== getBrainContextVersion()) return;
        apply(next);
        setVisible(true);
        return;
      }
      if (!conversationId) return;
      const page = await loadLatestConversationMessages(conversationId, { limit: 30, contentMode: 'compact' });
      if (currentOwner !== owner.current || currentContext !== getBrainContextVersion()) return;
      setResult(null);
      setSourceRole('assistant');
      setExcerpt(authorizedExcerpt(page.items, selection));
      setVisible(true);
    });
  };
  const cancel = (): void => {
    if (busy) return;
    // Closing must work offline too. A failed discard leaves a private draft, never a publication.
    setResult(null);
    setVisible(false);
    setExcerpt('');
    void run(async () => {
      if (proposal?.status === 'draft')
        await ipcBridge.brain.notes.consent.invoke({
          id: proposal.id,
          version: proposal.version,
          hash: proposal.hash,
          decision: 'discard',
        });
    });
  };
  const revise = (current: BrainNoteProposal): Promise<BrainProposalResult> =>
    ipcBridge.brain.notes.revise.invoke({
      id: current.id,
      version: current.version,
      text,
      sourceQuote: quote,
      areaId: areaId ?? current.areaId,
      kind,
      validUntil,
    });
  const submit = (): void => {
    if (contextVersion !== getBrainContextVersion()) return;
    const currentContext = contextVersion;
    void run(async () => {
      const currentOwner = owner.current;
      if (!proposal) {
        const next = await ipcBridge.brain.notes.create.invoke({ excerpt, sourceRole });
        if (currentOwner === owner.current && currentContext === getBrainContextVersion()) apply(next);
      } else if (dirty) {
        // Review the server's new version before the next, separate sharing click.
        const next = await revise(proposal);
        if (currentOwner === owner.current && currentContext === getBrainContextVersion()) apply(next);
      } else {
        const published = await ipcBridge.brain.notes.consent.invoke({
          id: proposal.id,
          version: proposal.version,
          hash: proposal.hash,
          decision: 'share',
        });
        if (currentOwner !== owner.current || currentContext !== getBrainContextVersion()) return;
        Message.success(
          t(
            published.proposal.status === 'pending_review'
              ? 'common.jr.brainNotes.pending'
              : 'common.jr.brainNotes.shared'
          )
        );
        setVisible(false);
        setResult(null);
        onPublished?.();
      }
    });
  };
  return (
    <>
      <Button size='small' loading={busy && !visible} onClick={open}>
        {t(factId === undefined ? 'common.jr.brainNotes.create' : 'common.jr.brainNotes.edit')}
      </Button>
      <Modal
        visible={visible}
        title={t('common.jr.brainNotes.create')}
        closable={!busy}
        maskClosable={false}
        onCancel={cancel}
        footer={
          <div className='flex justify-end gap-8px'>
            <Button disabled={busy} onClick={cancel}>
              {t('common.cancel')}
            </Button>
            <Button
              type='primary'
              loading={busy}
              disabled={!proposal ? !excerpt.trim() : !text.trim() || !quote.trim() || areaId === undefined}
              onClick={submit}
            >
              {t(
                !proposal
                  ? 'common.jr.brainNotes.authorizeExcerpt'
                  : dirty
                    ? 'common.jr.brainNotes.revise'
                    : 'common.jr.brainNotes.shareVersion'
              )}
            </Button>
          </div>
        }
      >
        <Alert
          type='info'
          content={t(!proposal ? 'common.jr.brainNotes.excerptNotice' : 'common.jr.brainNotes.reviewNotice')}
        />
        <Form layout='vertical' className='mt-16px'>
          {!proposal ? (
            <Form.Item label={t('common.jr.brainNotes.excerpt')}>
              <Input.TextArea
                disabled={busy}
                aria-label={t('common.jr.brainNotes.excerpt')}
                value={excerpt}
                onChange={(value) => {
                  setExcerpt(value);
                  setSourceRole('user');
                }}
                maxLength={4000}
                autoSize={{ minRows: 5, maxRows: 12 }}
              />
            </Form.Item>
          ) : (
            <>
              <Form.Item label={t('common.jr.brainNotes.text')}>
                <Input.TextArea
                  disabled={busy}
                  aria-label={t('common.jr.brainNotes.text')}
                  value={text}
                  onChange={setText}
                  maxLength={2000}
                  autoSize={{ minRows: 3, maxRows: 8 }}
                />
              </Form.Item>
              <Form.Item label={t('common.jr.brainNotes.source')}>
                <Input.TextArea
                  disabled={busy}
                  aria-label={t('common.jr.brainNotes.source')}
                  value={quote}
                  onChange={setQuote}
                  maxLength={2000}
                />
              </Form.Item>
              <Form.Item label={t('common.jr.brainNotes.audience')}>
                <Select
                  disabled={busy}
                  aria-label={t('common.jr.brainNotes.audience')}
                  value={areaId}
                  onChange={setAreaId}
                  options={(result.audiences ?? []).map((area) => ({ label: area.name, value: area.id }))}
                />
              </Form.Item>
              <Form.Item label={t('common.jr.brainNotes.kind')}>
                <Radio.Group
                  disabled={busy}
                  value={kind}
                  onChange={(value: BrainNoteKind) => setKind(value)}
                  options={[
                    { label: t('common.jr.brainNotes.sharedNote'), value: 'shared_note' },
                    { label: t('common.jr.brainNotes.officialProcedure'), value: 'official_procedure' },
                  ]}
                />
              </Form.Item>
              <Form.Item label={t('common.jr.brainNotes.validUntil')}>
                <DatePicker
                  disabled={busy}
                  allowClear
                  value={validUntil === null ? undefined : dayjs(validUntil).format('YYYY-MM-DD')}
                  onChange={(date) => setValidUntil(date ? dayjs(date).endOf('day').valueOf() : null)}
                />
              </Form.Item>
              {kind === 'official_procedure' && (
                <Alert type='warning' content={t('common.jr.brainNotes.officialNotice')} />
              )}
            </>
          )}
        </Form>
      </Modal>
    </>
  );
}
