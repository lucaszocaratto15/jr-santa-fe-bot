import { ipcBridge } from '@/common';
import { Alert, Button, Message, Spin } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { useBrainContextVersion } from '../brainShared';

export default function ReviewQueue({ ownerId }: { ownerId: string | null }): React.JSX.Element {
  const { t } = useTranslation();
  const contextVersion = useBrainContextVersion();
  const queue = useSWR(
    ownerId ? ['jr.brain.notes.pending', ownerId, contextVersion] : null,
    () => ipcBridge.brain.notes.pending.invoke(),
    {
      shouldRetryOnError: false,
    }
  );
  const [busy, setBusy] = useState<string | null>(null);
  const review = async (id: string, version: number, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(id);
    try {
      await ipcBridge.brain.notes.review.invoke({ id, version, decision });
      await queue.mutate();
    } catch {
      Message.error(t('common.jr.brainNotes.failed'));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className='mt-16px'>
      <h3>{t('common.jr.brainNotes.reviews')}</h3>
      {queue.error ? (
        <Alert type='warning' content={t('common.jr.brainNotes.authorizationRequired')} />
      ) : !queue.data ? (
        <Spin />
      ) : queue.data.length === 0 ? (
        <p>{t('common.jr.brainNotes.noReviews')}</p>
      ) : (
        queue.data.map((note) => (
          <div key={note.id} className='border border-base rounded-8px p-12px mb-12px'>
            <p className='whitespace-pre-wrap'>{note.text}</p>
            <p className='text-t-secondary whitespace-pre-wrap'>{note.sourceQuote}</p>
            <div className='flex gap-8px'>
              <Button
                disabled={busy !== null}
                loading={busy === note.id}
                type='primary'
                onClick={() => void review(note.id, note.version, 'approve')}
              >
                {t('common.jr.brainNotes.approve')}
              </Button>
              <Button disabled={busy !== null} onClick={() => void review(note.id, note.version, 'reject')}>
                {t('common.jr.brainNotes.reject')}
              </Button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
