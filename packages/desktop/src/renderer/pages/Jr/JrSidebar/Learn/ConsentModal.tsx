import { ipcBridge } from '@/common';
import { LEARN_TERM_VERSION, type LearnState } from '@/common/types/agent/learnTypes';
import MarkdownView from '@renderer/components/Markdown';
import { Alert, Button, Checkbox, Link, Message, Modal } from '@arco-design/web-react';
import { PreviewClose, PreviewOpen } from '@icon-park/react';
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
            <Button shape='round' onClick={onClose}>
              {t('common.jr.learn.consent.notNow')}
            </Button>
            <Button type='primary' shape='round' disabled={!agreed} loading={saving} onClick={() => void allow()}>
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
          <div className='mt-16px grid grid-cols-1 gap-12px sm:grid-cols-2'>
            <section className='rounded-12px bg-fill-2 p-14px'>
              <h4 className='m-0 mb-10px text-13px font-600 text-t-primary'>
                {t('common.jr.learn.consent.seesTitle')}
              </h4>
              <ul
                className='m-0 p-0 list-none flex flex-col gap-8px text-13px leading-20px'
                data-testid='learn-consent-sees'
              >
                {(['sees1', 'sees2'] as const).map((key) => (
                  <li key={key} className='flex gap-8px'>
                    <PreviewOpen theme='outline' size={14} className='mt-3px shrink-0 text-t-secondary' />
                    <span>{t(`common.jr.learn.consent.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className='rounded-12px bg-fill-2 p-14px'>
              <h4 className='m-0 mb-10px text-13px font-600 text-t-primary'>
                {t('common.jr.learn.consent.neverTitle')}
              </h4>
              <ul className='m-0 p-0 list-none flex flex-col gap-8px text-13px leading-20px'>
                {(['never1', 'never2', 'never3', 'never4'] as const).map((key) => (
                  <li key={key} className='flex gap-8px'>
                    <PreviewClose theme='outline' size={14} className='mt-3px shrink-0 text-t-tertiary' />
                    <span>{t(`common.jr.learn.consent.${key}`)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
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
          <div className='mt-16px pt-14px flex flex-wrap items-center justify-between gap-8px border-t border-t-solid border-[var(--jr-hairline)]'>
            <Checkbox checked={agreed} onChange={(checked: boolean) => setAgreed(checked)}>
              {t('common.jr.learn.consent.checkbox')}
            </Checkbox>
            <Link onClick={() => setShowTerm(true)}>{t('common.jr.learn.consent.readFull')}</Link>
          </div>
        </div>
      </Modal>
      <TermModal visible={showTerm} onClose={() => setShowTerm(false)} />
    </>
  );
};

export default ConsentModal;
