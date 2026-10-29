import { ipcBridge } from '@/common';
import { LEARN_TERM_VERSION, type LearnState } from '@/common/types/agent/learnTypes';
import MarkdownView from '@renderer/components/Markdown';
import { Alert, Button, Checkbox, Link, Message, Modal } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

const BOLD = { b: <strong /> };

/** The full term (LEARN_TERM_VERSION), rendered from its markdown i18n key. */
export const TermModal: React.FC<{ visible: boolean; onClose: () => void }> = ({ visible, onClose }) => {
  const { t } = useTranslation();
  return (
    <Modal
      visible={visible}
      title={t('common.jr.learn.consent.fullTitle')}
      footer={null}
      onCancel={onClose}
      unmountOnExit
      className='!w-640px max-w-[calc(100vw-32px)]'
    >
      <div className='max-h-60vh overflow-y-auto' data-testid='learn-term-full'>
        <MarkdownView hiddenCodeCopyButton>{t('common.jr.learn.term.full')}</MarkdownView>
      </div>
    </Modal>
  );
};

type ConsentModalProps = {
  visible: boolean;
  /** The stored accept is for another term version: say the term changed. */
  reconsent: boolean;
  onClose: () => void;
  onAccepted: (state: LearnState) => void;
};

/** LGPD approval screen with the exact term text. Permitir unlocks only with the checkbox. */
const ConsentModal: React.FC<ConsentModalProps> = ({ visible, reconsent, onClose, onAccepted }) => {
  const { t } = useTranslation();
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTerm, setShowTerm] = useState(false);

  useEffect(() => {
    if (!visible) setAgreed(false);
  }, [visible]);

  const allow = async () => {
    if (!agreed || saving) return;
    setSaving(true);
    try {
      onAccepted(await ipcBridge.learn.accept.invoke({ termVersion: LEARN_TERM_VERSION }));
    } catch {
      Message.error(t('common.jr.learn.panel.actionFailed'));
    } finally {
      setSaving(false);
    }
  };

  const section = (titleKey: string, body: React.ReactNode) => (
    <section className='mt-12px'>
      <h4 className='m-0 mb-4px text-14px font-600 text-t-primary'>{t(titleKey)}</h4>
      {body}
    </section>
  );

  return (
    <>
      <Modal
        visible={visible}
        title={t('common.jr.learn.consent.title')}
        onCancel={onClose}
        unmountOnExit
        className='!w-560px max-w-[calc(100vw-32px)]'
        footer={
          <>
            <Button onClick={onClose}>{t('common.jr.learn.consent.notNow')}</Button>
            <Button type='primary' disabled={!agreed} loading={saving} onClick={() => void allow()}>
              {t('common.jr.learn.consent.allow')}
            </Button>
          </>
        }
      >
        <div className='text-14px leading-22px text-t-secondary'>
          {reconsent && (
            <Alert className='mb-12px' type='warning' content={t('common.jr.learn.consent.reconsentNotice')} />
          )}
          <p className='m-0'>{t('common.jr.learn.consent.intro')}</p>
          {section(
            'common.jr.learn.consent.seesTitle',
            <ul className='m-0 pl-20px' data-testid='learn-consent-sees'>
              <li>{t('common.jr.learn.consent.sees1')}</li>
              <li>{t('common.jr.learn.consent.sees2')}</li>
            </ul>
          )}
          {section(
            'common.jr.learn.consent.neverTitle',
            <ul className='m-0 pl-20px'>
              <li>{t('common.jr.learn.consent.never1')}</li>
              <li>{t('common.jr.learn.consent.never2')}</li>
              <li>{t('common.jr.learn.consent.never3')}</li>
              <li>{t('common.jr.learn.consent.never4')}</li>
            </ul>
          )}
          {section(
            'common.jr.learn.consent.whereTitle',
            <p className='m-0'>{t('common.jr.learn.consent.whereBody')}</p>
          )}
          {section(
            'common.jr.learn.consent.whoTitle',
            <p className='m-0' data-testid='learn-consent-who'>
              <Trans i18nKey='common.jr.learn.consent.whoBody' components={BOLD} />
            </p>
          )}
          <p className='mt-12px mb-0'>
            <Trans i18nKey='common.jr.learn.consent.control' components={BOLD} />
          </p>
          <div className='mt-16px'>
            <Checkbox checked={agreed} onChange={(checked: boolean) => setAgreed(checked)}>
              {t('common.jr.learn.consent.checkbox')}
            </Checkbox>
          </div>
          <Link className='mt-8px inline-block' onClick={() => setShowTerm(true)}>
            {t('common.jr.learn.consent.readFull')}
          </Link>
        </div>
      </Modal>
      <TermModal visible={showTerm} onClose={() => setShowTerm(false)} />
    </>
  );
};

export default ConsentModal;
