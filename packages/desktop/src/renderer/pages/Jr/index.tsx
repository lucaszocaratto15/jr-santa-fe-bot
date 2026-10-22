import { Button, Alert, Dropdown, Input, Menu, Modal, Spin, Tooltip } from '@arco-design/web-react';
import { ArrowUp, Delete, Edit, FolderOpen, More } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { emitter } from '@/renderer/utils/emitter';
import { deleteJrBot, getJrBot, listJrBots, startJrConversation, type JrBot } from './jrBots';
import JrBotDialog from './JrBotDialog';
import JrCharacter from './JrCharacter';
import styles from './JrWorkspace.module.css';

export const JR_BOTS_KEY = 'jr.bots';
export const JR_RECENT_KEY = 'jr.recent';

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
  const [dialog, setDialog] = useState(false);
  const [editing, setEditing] = useState<JrBot>();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  useEffect(() => {
    if (params.get('create') === '1') {
      setEditing(undefined);
      setDialog(true);
    }
  }, [params]);
  const closeDialog = () => {
    setDialog(false);
    if (params.has('create')) {
      const next = new URLSearchParams(params);
      next.delete('create');
      setParams(next, { replace: true });
    }
  };
  const onSaved = async (saved: JrBot) => {
    await refreshBots();
    await mutate(['jr.bot', saved.id], saved);
    setParams({ bot: saved.id });
  };
  const send = async () => {
    if (!bot || !input.trim() || sending) return;
    setSending(true);
    setSendError(false);
    try {
      const conversation = await startJrConversation(bot, input);
      if (!conversation?.id) throw new Error('Conversation was not created');
      sessionStorage.setItem(`aionrs_initial_message_${conversation.id}`, JSON.stringify({ input: input.trim() }));
      try {
        localStorage.setItem(`workspace-preference-${conversation.id}`, 'collapsed');
      } catch {
        // Session creation must continue if optional layout preferences cannot be stored.
      }
      emitter.emit('chat.history.refresh');
      void mutate(JR_RECENT_KEY);
      await navigate(`/conversation/${conversation.id}`);
    } catch {
      setSendError(true);
    } finally {
      setSending(false);
    }
  };
  const remove = () => {
    if (!bot) return;
    Modal.confirm({
      title: t('common.jr.deleteBot'),
      content: t('common.jr.deleteBotHint'),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      onOk: async () => {
        await deleteJrBot(bot.id);
        await refreshBots();
        setParams({});
      },
    });
  };

  return (
    <main className={`${styles.page} ${styles.chatPage}`}>
      <header className={styles.pageHeader}>
        <div className={styles.botHeading}>
          {bot && (
            <>
              <JrCharacter appearance={bot.appearance} size={24} />
              <h1>{bot.name}</h1>
            </>
          )}
        </div>
        {bot && (
          <Dropdown
            trigger='click'
            position='bottom'
            droplist={
              <Menu
                className={styles.profileMenu}
                onClickMenuItem={(key) => {
                  if (key === 'edit') {
                    setEditing(bot);
                    setDialog(true);
                  }
                  if (key === 'delete') remove();
                }}
              >
                <Menu.Item key='edit'>
                  <Edit size={16} />
                  {t('common.jr.editBot')}
                </Menu.Item>
                <Menu.Item key='delete'>
                  <Delete size={16} />
                  {t('common.jr.deleteBot')}
                </Menu.Item>
              </Menu>
            }
          >
            <Button type='text' shape='circle' icon={<More size={18} />} aria-label={t('common.more')} />
          </Dropdown>
        )}
      </header>
      <section className={styles.chatWorkspace}>
        {isLoading ? (
          <Spin />
        ) : error ? (
          <div className={styles.empty} role='alert'>
            <Alert type='error' content={t('common.jr.loadError')} />
            <Button onClick={() => void refreshBots()}>{t('common.jr.retry')}</Button>
          </div>
        ) : !bots?.length ? (
          <div className={styles.empty}>
            <Button
              type='primary'
              className={styles.primary}
              onClick={() => {
                setEditing(undefined);
                setDialog(true);
              }}
            >
              {t('common.jr.firstBot')}
            </Button>
          </div>
        ) : botLoading ? (
          <Spin />
        ) : botError || !bot ? (
          <div className={styles.empty} role='alert'>
            <Alert type='error' content={t('common.jr.loadError')} />
            <Button onClick={() => void refreshBot()}>{t('common.jr.retry')}</Button>
          </div>
        ) : (
          <>
            <div className={styles.composer}>
              <label htmlFor='jr-task' className={styles.srOnly}>
                {t('common.jr.taskTitle')}
              </label>
              <Input.TextArea
                id='jr-task'
                value={input}
                onChange={setInput}
                autoSize={{ minRows: 1, maxRows: 10 }}
                disabled={sending}
                placeholder={t('common.jr.taskPlaceholder', { name: bot.name })}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className={styles.composerFooter}>
                <Tooltip content={bot.workspace}>
                  <span className={styles.folder} role='img' aria-label={t('common.jr.workspace')}>
                    <FolderOpen size={18} />
                    <span className={styles.srOnly}>{bot.workspace}</span>
                  </span>
                </Tooltip>
                <Button
                  className={`${styles.primary} ${styles.sendButton}`}
                  type='primary'
                  loading={sending}
                  disabled={!input.trim()}
                  shape='circle'
                  icon={<ArrowUp size={18} />}
                  aria-label={t('common.jr.startTask')}
                  title={t('common.jr.startTask')}
                  onClick={() => void send()}
                />
              </div>
            </div>
            {sendError && (
              <div role='alert'>
                <Alert type='error' content={t('common.jr.connectionError')} />
              </div>
            )}
          </>
        )}
      </section>
      <JrBotDialog visible={dialog} bot={editing} onClose={closeDialog} onSaved={onSaved} />
    </main>
  );
};
export default JrWorkspace;
