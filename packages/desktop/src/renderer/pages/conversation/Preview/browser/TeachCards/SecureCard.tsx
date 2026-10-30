/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { SecureRequest } from '@/common/adapter/ipcBridge';
import { Button, Checkbox, Input, Message } from '@arco-design/web-react';
import { Close, Lock, Protect } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from './TeachCards.module.css';

type SecureCardProps = {
  request: SecureRequest;
  onDone: () => void;
};

const WHAT_KEY = {
  otp: 'common.jr.teach.secure.whatOtp',
  password: 'common.jr.teach.secure.whatPassword',
  text: 'common.jr.teach.secure.whatText',
} as const;

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Masked field for a code or password the bot needs. The value goes straight to the main
 * process filler and is cleared from the card as soon as it is sent.
 */
const SecureCard: React.FC<SecureCardProps> = ({ request, onDone }) => {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [save, setSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const saveOnly = request.purpose === 'save-only';
  const origin = hostOf(request.origin);
  const title = saveOnly
    ? t('common.jr.teach.secure.saveOnlyTitle', { origin })
    : t('common.jr.teach.secure.title', { origin, what: t(WHAT_KEY[request.kind]) });

  const answer = async (response: Parameters<typeof ipcBridge.teach.secureRespond.invoke>[0]) => {
    setBusy(true);
    try {
      const result = await ipcBridge.teach.secureRespond.invoke(response);
      if (saveOnly && result?.saved === false) {
        // Main keeps the offer open, so the employee can retry from this card.
        Message.warning(t('common.jr.teach.secure.saveOnlyFailed'));
        setBusy(false);
        return;
      }
      if (result?.saved === false) Message.warning(t('common.jr.teach.secure.saveFailed'));
      onDone();
    } catch {
      Message.error(t('common.jr.teach.secure.sendFailed'));
      setBusy(false);
    }
  };

  const submit = () => {
    if (!value || busy) return;
    const typed = value;
    setValue('');
    void answer({ id: request.id, value: typed, save: saveOnly || (request.allowSave && save) });
  };

  return (
    <div className={styles.card} role='dialog' aria-label={title}>
      <div className={styles.title}>
        <Lock theme='outline' size={16} className={styles.icon} />
        <span className='flex-1'>{title}</span>
        <Button
          type='text'
          shape='circle'
          size='small'
          className={styles.close}
          icon={<Close theme='outline' size={14} />}
          onClick={() => void answer({ id: request.id, cancelled: true })}
          disabled={busy}
        >
          <span className='sr-only'>{t('common.jr.teach.secure.cancel')}</span>
        </Button>
      </div>
      {request.label && <div className={styles.label}>{request.label}</div>}
      <div className={styles.row}>
        <Input.Password
          autoFocus
          autoComplete='off'
          value={value}
          onChange={setValue}
          onPressEnter={submit}
          disabled={busy}
          className={`${styles.input} ${styles.code}`}
        />
        <Button type='primary' shape='round' onClick={submit} disabled={!value} loading={busy}>
          {saveOnly ? t('common.jr.teach.secure.saveOnlySubmit') : t('common.jr.teach.secure.send')}
        </Button>
      </div>
      <div className={styles.footer}>
        {request.allowSave && !saveOnly ? (
          <Checkbox checked={save} onChange={setSave} className={styles.save}>
            {t('common.jr.teach.secure.saveToVault')}
          </Checkbox>
        ) : (
          <span />
        )}
        <span className={styles.footnote}>
          <Protect theme='outline' size={12} />
          {t('common.jr.teach.secure.footnote')}
        </span>
      </div>
    </div>
  );
};

export default SecureCard;
