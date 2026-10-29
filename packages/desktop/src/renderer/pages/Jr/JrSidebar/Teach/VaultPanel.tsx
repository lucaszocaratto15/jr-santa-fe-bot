import { ipcBridge } from '@/common';
import type { VaultItemPublic } from '@/common/adapter/ipcBridge';
import { Alert, Button, Form, Input, Message, Popconfirm, Tooltip } from '@arco-design/web-react';
import { Delete, Earth, Edit, Key, Lock, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from '../JrSidebar.module.css';
import { EmptyState, PageHeader } from './PanelParts';

type Draft = { id?: string; name: string; origins: string; username: string; password: string; hints: string };

const emptyDraft: Draft = { name: '', origins: '', username: '', password: '', hints: '' };

const splitOrigins = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);

const VaultPanel: React.FC = () => {
  const { t } = useTranslation();
  const available = useSWR('jr.vault.available', () => ipcBridge.vault.available.invoke());
  const items = useSWR('jr.vault.list', () => ipcBridge.vault.list.invoke());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const usable = available.data === true;

  const startEdit = (item: VaultItemPublic) =>
    setDraft({
      id: item.id,
      name: item.name,
      origins: item.origins.join(', '),
      username: item.username,
      password: '',
      hints: item.hints,
    });

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await ipcBridge.vault.upsert.invoke({
        ...(draft.id ? { id: draft.id } : {}),
        name: draft.name.trim(),
        origins: splitOrigins(draft.origins),
        username: draft.username,
        // A blank password field means "keep the stored one"; never send ''.
        ...(draft.password ? { password: draft.password } : {}),
        hints: draft.hints,
      });
      setDraft(null);
      await items.mutate();
    } catch {
      Message.error(t('common.jr.vault.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await ipcBridge.vault.remove.invoke({ id });
      await items.mutate();
    } catch {
      Message.error(t('common.jr.vault.deleteFailed'));
    }
  };

  const set = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  return (
    <div>
      <PageHeader
        title={t('common.jr.vault.title')}
        subtitle={
          <>
            <Lock theme='outline' size={12} />
            <span>{t('common.jr.vault.subtitle')}</span>
          </>
        }
        aside={
          usable && (
            <Button
              type='primary'
              shape='round'
              icon={<Plus theme='outline' size={14} />}
              onClick={() => setDraft({ ...emptyDraft })}
            >
              {t('common.jr.vault.add')}
            </Button>
          )
        }
      />
      {available.data === false && <Alert type='warning' content={t('common.jr.vault.unavailable')} />}
      {usable && (
        <>
          {draft && (
            <div className={styles.card}>
              <p className={styles.cardTitle}>
                {draft.id ? t('common.jr.vault.formEdit') : t('common.jr.vault.formAdd')}
              </p>
              <Form layout='vertical' onSubmit={() => void save()}>
                <Form.Item label={t('common.jr.vault.name')}>
                  <Input value={draft.name} onChange={(name) => set({ name })} />
                </Form.Item>
                <Form.Item label={t('common.jr.vault.origins')}>
                  <Input
                    value={draft.origins}
                    placeholder={t('common.jr.vault.originsPlaceholder')}
                    onChange={(origins) => set({ origins })}
                  />
                </Form.Item>
                <Form.Item label={t('common.jr.vault.username')}>
                  <Input value={draft.username} onChange={(username) => set({ username })} />
                </Form.Item>
                <Form.Item label={t('common.jr.vault.password')}>
                  <Input.Password
                    value={draft.password}
                    autoComplete='new-password'
                    placeholder={draft.id ? t('common.jr.vault.passwordKeep') : undefined}
                    onChange={(password) => set({ password })}
                  />
                </Form.Item>
                <Form.Item label={t('common.jr.vault.hints')}>
                  <Input value={draft.hints} onChange={(hints) => set({ hints })} />
                </Form.Item>
                <div className={styles.rowActions}>
                  <Button type='primary' htmlType='submit' loading={saving} disabled={!draft.name.trim()}>
                    {t('common.jr.vault.save')}
                  </Button>
                  <Button className={styles.softButton} onClick={() => setDraft(null)}>
                    {t('common.jr.vault.cancel')}
                  </Button>
                </div>
              </Form>
            </div>
          )}
          <div className={`${styles.card} ${styles.cardList}`}>
            {(items.data ?? []).length === 0 && (
              <EmptyState
                icon={<Key theme='outline' size={18} />}
                title={t('common.jr.vault.empty')}
                hint={t('common.jr.vault.emptyHint')}
              />
            )}
            {(items.data ?? []).map((item) => (
              <div key={item.id} className={styles.row}>
                <span className={styles.rowIcon} aria-hidden='true'>
                  <Earth theme='outline' size={16} />
                </span>
                <div className={styles.rowCopy}>
                  <p className={`${styles.rowTitle} font-500`}>{item.name}</p>
                  <p className={styles.rowMeta}>
                    {[
                      item.origins.join(', '),
                      item.username,
                      item.hasPassword ? t('common.jr.vault.passwordSaved') : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <div className={styles.rowActions}>
                  <Tooltip content={t('common.jr.vault.edit')}>
                    <Button
                      className={styles.ghostIcon}
                      shape='circle'
                      size='small'
                      aria-label={t('common.jr.vault.edit')}
                      icon={<Edit theme='outline' size={15} />}
                      onClick={() => startEdit(item)}
                    />
                  </Tooltip>
                  <Popconfirm
                    title={t('common.jr.vault.deleteConfirm')}
                    okText={t('common.jr.vault.confirmOk')}
                    cancelText={t('common.jr.vault.cancel')}
                    onOk={() => remove(item.id)}
                  >
                    <Button
                      className={styles.ghostIcon}
                      shape='circle'
                      size='small'
                      aria-label={t('common.jr.vault.delete')}
                      icon={<Delete theme='outline' size={15} />}
                    />
                  </Popconfirm>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default VaultPanel;
