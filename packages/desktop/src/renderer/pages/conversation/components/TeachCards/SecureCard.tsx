/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { SecureRequest } from '@/common/adapter/ipcBridge';
import { Button, Checkbox, Input, Message } from '@arco-design/web-react';
import { Lock } from '@icon-park/react';
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

  const answer = async (response: Parameters<typeof ipcBridge.teach.secureRespond.invoke>[0]) => {
    setBusy(true);
    try {
      await ipcBridge.teach.secureRespond.invoke(response);
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
    <div className={styles.card} role='dialog' aria-label={t('common.jr.teach.secure.footnote')}>
      <div className={styles.title}>
        <Lock theme='outline' size={16} className={styles.icon} />
        <span>
          {saveOnly
            ? t('common.jr.teach.secure.saveOnlyTitle', { origin })
            : t('common.jr.teach.secure.title', { origin, what: t(WHAT_KEY[request.kind]) })}
        </span>
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
          className={styles.input}
        />
        <Button type='primary' onClick={submit} disabled={!value} loading={busy}>
          {saveOnly ? t('common.jr.teach.secure.saveOnlySubmit') : t('common.jr.teach.secure.send')}
        </Button>
        <Button onClick={() => void answer({ id: request.id, cancelled: true })} disabled={busy}>
          {t('common.jr.teach.secure.cancel')}
        </Button>
      </div>
      {request.allowSave && !saveOnly && (
        <Checkbox checked={save} onChange={setSave} className={styles.save}>
          {t('common.jr.teach.secure.saveToVault')}
        </Checkbox>
      )}
      <div className={styles.footnote}>{t('common.jr.teach.secure.footnote')}</div>
    </div>
  );
};

export default SecureCard;
