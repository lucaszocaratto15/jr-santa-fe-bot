import { Alert, Button, Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { getJrBot, listJrBots, reportJrOpenError, startJrConversation, type JrBot } from './jrBots';
import JrBotDialog from './JrBotDialog';
import styles from './JrWorkspace.module.css';

export const JR_BOTS_KEY = 'jr.bots';

const JrWorkspace: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const { data: bots, error, isLoading, mutate: refreshBots } = useSWR(JR_BOTS_KEY, listJrBots);
  const selectedId = params.get('bot') || bots?.[0]?.id;
  const {
    data: bot,
    error: botError,
    isLoading: botLoading,
    mutate: refreshBot,
  } = useSWR(selectedId ? ['jr.bot', selectedId] : null, () => getJrBot(selectedId!));
  const creating = params.get('create') === '1';
  const editing = params.get('edit') === '1';
  const newConversation = params.get('new') === '1';
  const dialogVisible = creating || editing;
  const [openError, setOpenError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!bot || dialogVisible) return;
    let cancelled = false;
    setOpenError(null);
    setDetailOpen(false);
    const opening = newConversation ? startJrConversation(bot, { newConversation: true }) : startJrConversation(bot);
    void opening.then(
      (conversation) => {
        if (!cancelled) {
          if (newConversation) void mutate(JR_BOTS_KEY);
          void navigate(`/conversation/${conversation.id}?bot=${encodeURIComponent(bot.id)}`, { replace: true });
        }
      },
      (openFailure: unknown) => {
        if (!cancelled) setOpenError(reportJrOpenError(openFailure));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [bot, dialogVisible, navigate, newConversation, retry]);

  const closeDialog = () => setParams(bot ? { bot: bot.id } : {});
  const onSaved = async (saved: JrBot) => {
    await refreshBots();
    await mutate(['jr.bot', saved.id], saved);
    setParams({ bot: saved.id });
  };

  return (
    <main className={`${styles.page} ${styles.chatPage}`}>
      {isLoading || botLoading ? (
        <Spin aria-label={t('common.loading')} />
      ) : error || botError ? (
        <div className={styles.empty} role='alert'>
          <Alert type='error' content={t('common.jr.loadError')} />
          <Button
            onClick={() => {
              void refreshBots();
              void refreshBot();
            }}
          >
            {t('common.jr.retry')}
          </Button>
        </div>
      ) : !bots?.length ? (
        <div className={styles.empty}>
          <Button type='primary' className={styles.primary} onClick={() => setParams({ create: '1' })}>
            {t('common.jr.firstBot')}
          </Button>
        </div>
      ) : openError ? (
        <div className={styles.empty} role='alert'>
          <Alert type='error' content={t('common.jr.connectionError')} />
          <Button type='text' aria-expanded={detailOpen} onClick={() => setDetailOpen((open) => !open)}>
            {t('common.jr.errorDetail')}
          </Button>
          {detailOpen ? <p className={styles.errorDetail}>{openError}</p> : null}
          <Button onClick={() => setRetry((value) => value + 1)}>{t('common.jr.retry')}</Button>
        </div>
      ) : !dialogVisible ? (
        <Spin aria-label={t('common.loading')} />
      ) : null}
      <JrBotDialog
        visible={dialogVisible && (!editing || Boolean(bot))}
        bot={editing ? bot : undefined}
        onClose={closeDialog}
        onSaved={onSaved}
      />
    </main>
  );
};
export default JrWorkspace;
