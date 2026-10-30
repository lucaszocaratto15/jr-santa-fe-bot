import { ipcBridge } from '@/common';
import { BRAIN_TERM_VERSION } from '@/common/types/agent/brainTypes';
import { Button, Message, Modal } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const POINTS = ['collected', 'purpose', 'who', 'blocked', 'retention', 'provider', 'pause'] as const;

/** Once per app open: closing without the button shows it again at the next launch. */
let shownThisLaunch = false;

/** Test helper: behaves like a fresh app launch. */
export const resetDataNoticeLaunch = (): void => {
  shownThisLaunch = false;
};

/**
 * "Aviso de uso de dados" (BRAIN_TERM_VERSION). A notice, not a consent: the employee can only
 * acknowledge it, and capture and Aprender run whether or not they do.
 */
const DataNoticeModal: React.FC = () => {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (shownThisLaunch) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const state = await ipcBridge.brain?.consentState?.invoke();
        if (cancelled || !state || state.current) return;
        shownThisLaunch = true;
        setVisible(true);
      } catch {
        // No brain service (older main, WebUI): no notice.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const acknowledge = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await ipcBridge.brain.accept.invoke({ termVersion: BRAIN_TERM_VERSION });
      setVisible(false);
    } catch {
      Message.error(t('common.jr.dataNotice.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      title={t('common.jr.dataNotice.title')}
      onCancel={() => setVisible(false)}
      maskClosable={false}
      unmountOnExit
      className='!w-600px max-w-[calc(100vw-32px)]'
      footer={
        <Button type='primary' shape='round' loading={saving} onClick={() => void acknowledge()}>
          {t('common.jr.dataNotice.button')}
        </Button>
      }
    >
      <div className='max-h-60vh overflow-y-auto text-14px leading-22px text-t-secondary' data-testid='data-notice'>
        <p className='m-0'>{t('common.jr.dataNotice.intro')}</p>
        {POINTS.map((key) => (
          <section key={key} className='mt-12px'>
            <h4 className='m-0 mb-4px text-14px font-600 text-t-primary'>{t(`common.jr.dataNotice.${key}Title`)}</h4>
            <p className='m-0'>{t(`common.jr.dataNotice.${key}Body`)}</p>
          </section>
        ))}
      </div>
    </Modal>
  );
};

export default DataNoticeModal;
