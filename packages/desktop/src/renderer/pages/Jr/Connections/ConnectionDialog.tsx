import type { IMcpServer } from '@/common/config/storage';
import { Alert, Button, Input, Modal, Select } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConnectionSaveError, connectionPayload, type ConnectionDraft } from './connections';
import styles from './Connections.module.css';

type ConnectionDialogProps = {
  draft: ConnectionDraft;
  server?: IMcpServer;
  servers: IMcpServer[];
  onClose: () => void;
  onSave: (payload: ReturnType<typeof connectionPayload>, server?: IMcpServer) => Promise<IMcpServer>;
};

const ConnectionDialog: React.FC<ConnectionDialogProps> = ({
  draft: initialDraft,
  server,
  servers,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialDraft);
  const [persistedServer, setPersistedServer] = useState(server);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setError('');
    let payload: ReturnType<typeof connectionPayload>;
    try {
      payload = connectionPayload(draft, persistedServer);
    } catch (validationError) {
      const key = validationError instanceof Error ? validationError.message : 'invalidName';
      setError(t(`common.jr.mcp.${key}`));
      return;
    }
    if (
      servers.some(
        (item) => item.id !== persistedServer?.id && item.name.trim().toLowerCase() === payload.name.toLowerCase()
      )
    ) {
      setError(t('common.jr.mcp.duplicateName'));
      return;
    }
    setSaving(true);
    try {
      await onSave(payload, persistedServer);
      onClose();
    } catch (saveError) {
      if (saveError instanceof ConnectionSaveError) setPersistedServer(saveError.server);
      setError(
        t(saveError instanceof ConnectionSaveError ? 'common.jr.mcp.partialSaveError' : 'common.jr.mcp.saveError')
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      visible
      alignCenter
      className={styles.configDialog}
      title={t(server ? 'common.jr.mcp.editTitle' : 'common.jr.mcp.customTitle')}
      onCancel={onClose}
      maskClosable={!saving}
      closable={!saving}
      escToExit={!saving}
      focusLock
      footer={[
        <Button key='cancel' className={styles.secondaryButton} disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button key='save' type='primary' className={styles.connectButton} loading={saving} onClick={() => void save()}>
          {t('common.save')}
        </Button>,
      ]}
    >
      <div className={styles.fields}>
        {error && <Alert type='error' content={error} />}
        <label htmlFor='jr-mcp-name'>{t('common.jr.mcp.name')}</label>
        <Input
          id='jr-mcp-name'
          value={draft.name}
          onChange={(value) => update('name', value)}
          maxLength={80}
          disabled={saving}
          autoFocus
        />
        <label id='jr-mcp-transport-label'>{t('common.jr.mcp.transport')}</label>
        <Select
          aria-labelledby='jr-mcp-transport-label'
          value={draft.type}
          onChange={(value: ConnectionDraft['type']) => update('type', value)}
          disabled={saving}
          options={[
            { value: 'stdio', label: t('common.jr.mcp.localTransport') },
            { value: 'http', label: t('common.jr.mcp.httpTransport') },
            { value: 'sse', label: t('common.jr.mcp.sseTransport') },
          ]}
        />
        {draft.type === 'stdio' ? (
          <>
            <label htmlFor='jr-mcp-command'>{t('common.jr.mcp.command')}</label>
            <Input
              id='jr-mcp-command'
              value={draft.command}
              onChange={(value) => update('command', value)}
              disabled={saving}
            />
            <label htmlFor='jr-mcp-arguments'>{t('common.jr.mcp.arguments')}</label>
            <Input.TextArea
              id='jr-mcp-arguments'
              value={draft.args}
              onChange={(value) => update('args', value)}
              disabled={saving}
              autoSize={{ minRows: 3, maxRows: 8 }}
            />
            <p className={styles.hint}>{t('common.jr.mcp.argumentsHint')}</p>
          </>
        ) : (
          <>
            <label htmlFor='jr-mcp-url'>{t('common.jr.mcp.url')}</label>
            <Input id='jr-mcp-url' value={draft.url} onChange={(value) => update('url', value)} disabled={saving} />
          </>
        )}
        {server && <p className={styles.hint}>{t('common.jr.mcp.preserveSecrets')}</p>}
      </div>
    </Modal>
  );
};

export default ConnectionDialog;
