import { ipcBridge } from '@/common';
import { Alert, Button, Input, Message, Modal, Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { knownTeachError } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
import styles from '../JrSidebar.module.css';

type EditTaskModalProps = {
  /** The taught skill to edit; null keeps the modal hidden. */
  name: string | null;
  onClose: () => void;
  onSaved: () => void;
};

type LoadState = 'loading' | 'ready' | 'failed';

const errorText = (error: unknown): string | null =>
  knownTeachError(error instanceof Error ? error.message : typeof error === 'string' ? error : null);

/**
 * "Minhas tarefas" → Editar: the task's one-line description and its SKILL.md body (steps).
 * The name is the id schedules use, so it is shown but cannot be changed. Main validates and
 * writes; a refused save keeps the modal open with the reason.
 */
const EditTaskModal: React.FC<EditTaskModalProps> = ({ name, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [load, setLoad] = useState<LoadState>('loading');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    setLoad('loading');
    setError(null);
    ipcBridge.teach.readTask
      .invoke({ name })
      .then((task) => {
        if (cancelled) return;
        setDescription(task.description);
        setBody(task.body);
        setLoad('ready');
      })
      .catch(() => {
        if (!cancelled) setLoad('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (!name) return null;

  const save = async () => {
    if (saving || !description.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await ipcBridge.teach.saveTask.invoke({ name, description: description.trim(), body });
      Message.success(t('common.jr.teach.tasks.editSaved'));
      onSaved();
      onClose();
    } catch (failure) {
      const code = errorText(failure);
      setError(code ? t(`common.jr.teach.errors.${code}`) : t('common.jr.teach.tasks.editFailed'));
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <>
      <Button onClick={onClose} disabled={saving}>
        {t('common.cancel')}
      </Button>
      {load === 'ready' && (
        <Button type='primary' loading={saving} disabled={!description.trim()} onClick={() => void save()}>
          {t('common.save')}
        </Button>
      )}
    </>
  );

  return (
    <Modal visible title={t('common.jr.teach.tasks.editTitle')} onCancel={onClose} footer={footer} unmountOnExit>
      <p className={styles.rowTitle}>{name}</p>
      {load === 'loading' && <Spin />}
      {load === 'failed' && <Alert type='error' content={t('common.jr.teach.tasks.editFailed')} />}
      {load === 'ready' && (
        <div className='flex flex-col gap-12px mt-12px'>
          <label className='flex flex-col gap-4px'>
            <span className={styles.muted}>{t('common.jr.teach.tasks.editDescription')}</span>
            <Input value={description} maxLength={300} onChange={setDescription} disabled={saving} />
          </label>
          <label className='flex flex-col gap-4px'>
            <span className={styles.muted}>{t('common.jr.teach.tasks.editBody')}</span>
            <Input.TextArea
              data-testid='edit-task-body'
              className='font-mono'
              value={body}
              autoSize={{ minRows: 10, maxRows: 24 }}
              onChange={setBody}
              disabled={saving}
            />
          </label>
          {error && <Alert type='error' content={error} />}
        </div>
      )}
    </Modal>
  );
};

export default EditTaskModal;
