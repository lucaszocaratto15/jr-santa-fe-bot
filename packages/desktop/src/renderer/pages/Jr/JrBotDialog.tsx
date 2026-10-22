import { ipcBridge } from '@/common';
import type { JrAppearance } from '@/common/config/clientSettings';
import { Close } from '@icon-park/react';
import { Alert, Button, Input, Modal } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { JR_DEFAULT_INSTRUCTIONS, saveJrBot, type JrBot } from './jrBots';
import { CHARACTER_COLORS, CHARACTER_PALETTE, CHARACTER_SHAPES, normalizeAppearance } from './botAppearance';
import JrCharacter from './JrCharacter';
import styles from './JrWorkspace.module.css';

const JrBotDialog: React.FC<{
  visible: boolean;
  bot?: JrBot;
  onClose: () => void;
  onSaved: (bot: JrBot) => void | Promise<void>;
}> = ({ visible, bot, onClose, onSaved }) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [appearance, setAppearance] = useState<JrAppearance>({ shape: 'cloud', color: 'red' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (visible) {
      setName(bot?.name || '');
      setAppearance(normalizeAppearance(bot?.appearance));
      setError('');
    }
  }, [visible, bot]);
  const save = async () => {
    if (saving) return;
    if (!name.trim() || name.trim().length > 80) {
      setError(t('common.jr.invalidName'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const workspace = bot?.workspace || (await ipcBridge.jr.createWorkspace.invoke());
      const saved = await saveJrBot(
        { name, instructions: bot?.instructions || JR_DEFAULT_INSTRUCTIONS, workspace, appearance },
        bot?.id
      );
      await onSaved(saved);
      onClose();
    } catch {
      setError(t('common.jr.saveError'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      visible={visible}
      title={
        <>
          {t(bot ? 'common.jr.editBot' : 'common.jr.newBotTitle')}
          <Button
            type='text'
            shape='circle'
            className={styles.dialogClose}
            icon={<Close size={18} />}
            aria-label={t('common.close')}
            disabled={saving}
            onClick={onClose}
          />
        </>
      }
      className={styles.characterDialog}
      onCancel={onClose}
      maskClosable={!saving}
      closable={false}
      escToExit={!saving}
      focusLock
      footer={[
        <Button key='cancel' shape='round' disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button
          key='save'
          shape='round'
          type='primary'
          className={styles.primary}
          loading={saving}
          disabled={!name.trim()}
          onClick={() => void save()}
        >
          {t(bot ? 'common.jr.saveBot' : 'common.jr.createAction')}
        </Button>,
      ]}
    >
      <div className={styles.characterEditor}>
        {error && <Alert type='error' content={error} />}
        <div className={styles.characterPreview}>
          <JrCharacter appearance={appearance} size={96} />
        </div>
        <label htmlFor='jr-bot-name' className={styles.srOnly}>
          {t('common.jr.botName')}
        </label>
        <Input
          id='jr-bot-name'
          value={name}
          onChange={setName}
          maxLength={80}
          disabled={saving}
          className={styles.characterName}
          placeholder={t('common.jr.namePlaceholder')}
          autoFocus
          onPressEnter={() => void save()}
        />
        <div className={styles.shapePicker} role='group' aria-label={t('common.jr.characterShape')}>
          {CHARACTER_SHAPES.map((shape) => (
            <Button
              key={shape}
              type='text'
              className={`${styles.shapeChoice} ${shape === appearance.shape ? styles.shapeSelected : ''}`}
              aria-label={t(`common.jr.shapes.${shape}`)}
              aria-pressed={shape === appearance.shape}
              disabled={saving}
              onClick={() => setAppearance({ ...appearance, shape })}
            >
              <JrCharacter appearance={{ ...appearance, shape }} size={36} />
            </Button>
          ))}
        </div>
        <div className={styles.colorPicker} role='group' aria-label={t('common.jr.characterColor')}>
          {CHARACTER_COLORS.map((color) => (
            <Button
              key={color}
              shape='circle'
              className={`${styles.colorChoice} ${color === appearance.color ? styles.colorSelected : ''}`}
              aria-label={t(`common.jr.colors.${color}`)}
              aria-pressed={color === appearance.color}
              disabled={saving}
              onClick={() => setAppearance({ ...appearance, color })}
            >
              <span className={styles.colorSwatch} style={{ backgroundColor: CHARACTER_PALETTE[color] }} />
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
};
export default JrBotDialog;
