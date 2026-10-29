import { ipcBridge } from '@/common';
import { Badge, Button, Dropdown, Menu, Message } from '@arco-design/web-react';
import { Brain } from '@icon-park/react';
import classNames from 'classnames';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useLearnState } from '@renderer/hooks/agent/useLearnState';
import { emitter } from '@renderer/utils/emitter';

type MenuKey = 'pause1h' | 'pauseUntilResume' | 'resume' | 'open' | 'review' | 'turnOff';

/**
 * 🧠 in the titlebar: always visible while "Aprender" is on (also paused), and after a
 * prior accept when the term changed. Pause, resume, open settings and turn off.
 */
const LearnIndicator: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { state } = useLearnState();
  if (!state) return null;
  const { status } = state;
  const needsConsent = status === 'needs-consent' && state.acceptedVersion !== null;
  if (status !== 'active' && status !== 'paused' && !needsConsent) return null;

  const time = (at: number) =>
    new Intl.DateTimeFormat(i18n.language || 'pt-BR', { hour: '2-digit', minute: '2-digit' }).format(at);
  const statusLine =
    status === 'active'
      ? state.activeSince
        ? t('common.jr.learn.indicator.learningSince', { time: time(state.activeSince) })
        : t('common.jr.learn.indicator.learning')
      : status === 'paused'
        ? state.pausedUntil
          ? t('common.jr.learn.indicator.pausedUntil', { time: time(state.pausedUntil) })
          : t('common.jr.learn.indicator.paused')
        : t('common.jr.learn.panel.status.needsConsent');

  const run = (action: () => Promise<unknown>) => {
    action().catch(() => Message.error(t('common.jr.learn.panel.actionFailed')));
  };

  const onMenu = (key: string) => {
    switch (key as MenuKey) {
      case 'pause1h':
        return run(() => ipcBridge.learn.pause.invoke({ minutes: 60 }));
      case 'pauseUntilResume':
        return run(() => ipcBridge.learn.pause.invoke({ minutes: null }));
      case 'resume':
        return run(() => ipcBridge.learn.resume.invoke());
      case 'turnOff':
        return run(() => ipcBridge.learn.turnOff.invoke());
      case 'review':
        emitter.emit('jr.settings.open', { tab: 'learn', autoConsent: true });
        return;
      case 'open':
        emitter.emit('jr.settings.open', { tab: 'learn' });
    }
  };

  const droplist = (
    <Menu onClickMenuItem={onMenu}>
      <Menu.Item key='status' disabled>
        {statusLine}
      </Menu.Item>
      {status === 'active' && <Menu.Item key='pause1h'>{t('common.jr.learn.indicator.pause1h')}</Menu.Item>}
      {status === 'active' && (
        <Menu.Item key='pauseUntilResume'>{t('common.jr.learn.indicator.pauseUntilResume')}</Menu.Item>
      )}
      {status === 'paused' && <Menu.Item key='resume'>{t('common.jr.learn.indicator.resume')}</Menu.Item>}
      {needsConsent && <Menu.Item key='review'>{t('common.jr.learn.indicator.reviewTerm')}</Menu.Item>}
      <Menu.Item key='open'>{t('common.jr.learn.indicator.open')}</Menu.Item>
      <Menu.Item key='turnOff'>{t('common.jr.learn.indicator.turnOff')}</Menu.Item>
    </Menu>
  );

  return (
    <Dropdown trigger='click' position='br' droplist={droplist}>
      <Badge dot count={needsConsent ? 1 : 0} offset={[-4, 4]}>
        <Button
          type='text'
          shape='circle'
          size='small'
          data-testid='learn-indicator'
          aria-label={t('common.jr.learn.indicator.label')}
          className={classNames('app-titlebar__learn', status === 'paused' && 'app-titlebar__learn--paused')}
          icon={
            <span className='app-titlebar__learn-icon'>
              <Brain theme='outline' size={18} />
              {status === 'active' && <span className='app-titlebar__learn-dot' aria-hidden='true' />}
            </span>
          }
        />
      </Badge>
    </Dropdown>
  );
};

export default LearnIndicator;
