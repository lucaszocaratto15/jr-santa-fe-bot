import { Alert, Button, Input, Message, Modal } from '@arco-design/web-react';
import { Check } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TTeam } from '@/common/types/team/teamTypes';
import { WorkspaceFolderSelect } from '@renderer/components/workspace';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import JrCharacter from './JrCharacter';
import { JR_MODEL, type JrBot } from './jrBots';
import styles from './JrWorkspace.module.css';

const JrBotTeamDialog: React.FC<{
  visible: boolean;
  bots: JrBot[];
  onClose: () => void;
  onCreated: (team: TTeam) => void;
}> = ({ visible, bots, onClose, onCreated }) => {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [saving, setSaving] = useState(false);
  const availableBots = bots.filter((bot) => bot.teamSelectable !== false);

  useEffect(() => {
    if (!visible) return;
    const selectable = bots.filter((bot) => bot.teamSelectable !== false);
    setName(t('common.jr.teamNameDefault'));
    setSelectedIds(selectable.map((bot) => bot.id));
    setWorkspace(
      selectable.length > 0 && selectable.every((bot) => bot.workspace === selectable[0].workspace)
        ? selectable[0].workspace
        : ''
    );
  }, [visible, bots, t]);

  const create = async () => {
    const members = availableBots.filter((bot) => selectedIds.includes(bot.id));
    if (members.length < 2) {
      Message.warning(t('common.jr.teamNeedTwoBots'));
      return;
    }
    if (!workspace || !name.trim()) return;
    setSaving(true);
    try {
      const team = await ipcBridge.team.create.invoke({
        user_id: user?.id ?? 'system_default_user',
        name: name.trim(),
        workspace,
        workspace_mode: 'shared',
        agents: members.map((bot, index) => ({
          role: index === 0 ? 'leader' : 'teammate',
          assistant_name: bot.name,
          assistant_id: bot.id,
          model: JR_MODEL,
        })),
      });
      const result = team as TTeam | { __bridgeError?: boolean; message?: string };
      if (!result || '__bridgeError' in result) {
        const bridgeError = result as { message?: string };
        Message.error(bridgeError.message || t('common.jr.teamCreateError'));
        return;
      }
      onCreated(team);
      onClose();
    } catch {
      Message.error(t('common.jr.teamCreateError'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={visible}
      title={t('common.jr.teamDialogTitle')}
      onCancel={onClose}
      maskClosable={!saving}
      closable={!saving}
      footer={[
        <Button key='cancel' shape='round' disabled={saving} onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button
          key='create'
          type='primary'
          shape='round'
          loading={saving}
          disabled={saving || selectedIds.length < 2 || !workspace || !name.trim()}
          onClick={() => void create()}
        >
          {t('common.jr.teamStart')}
        </Button>,
      ]}
    >
      <div className='flex flex-col gap-12px'>
        <label htmlFor='jr-team-name' className={styles.fieldLabel}>
          {t('common.jr.teamName')}
        </label>
        <Input id='jr-team-name' value={name} onChange={setName} maxLength={80} disabled={saving} />
        <div className={`${styles.fieldLabel} flex items-center mt-4px`}>
          <span className='flex-1'>{t('common.jr.teamBots')}</span>
          <span className='font-400 text-t-tertiary'>{t('common.jr.teamSelected', { count: selectedIds.length })}</span>
        </div>
        {availableBots.length < 2 ? (
          <Alert type='warning' content={t('common.jr.teamUnavailable')} />
        ) : (
          <div className={styles.teamPicker} role='group' aria-label={t('common.jr.teamBots')}>
            {availableBots.map((bot) => {
              const selected = selectedIds.includes(bot.id);
              return (
                <Button
                  key={bot.id}
                  type='text'
                  className={`${styles.teamChoice} ${selected ? styles.teamChoiceOn : ''}`}
                  aria-pressed={selected}
                  disabled={saving}
                  onClick={() =>
                    setSelectedIds((current) =>
                      current.includes(bot.id) ? current.filter((id) => id !== bot.id) : [...current, bot.id]
                    )
                  }
                >
                  {selected && (
                    <span className={styles.teamChoiceCheck} aria-hidden='true'>
                      <Check size={10} fill='currentColor' strokeWidth={5} />
                    </span>
                  )}
                  <JrCharacter appearance={bot.appearance} size={36} still />
                  <span className={styles.teamChoiceName}>{bot.name}</span>
                </Button>
              );
            })}
          </div>
        )}
        <label className={`${styles.fieldLabel} mt-4px`}>{t('common.jr.teamWorkspace')}</label>
        <WorkspaceFolderSelect
          value={workspace}
          onChange={setWorkspace}
          placeholder={t('common.jr.chooseFolder')}
          recentLabel={t('common.jr.recentFolders')}
          chooseDifferentLabel={t('common.jr.chooseAnotherFolder')}
        />
        <p className='m-0 text-12px text-t-tertiary'>{t('common.jr.teamWorkspaceHint')}</p>
      </div>
    </Modal>
  );
};

export default JrBotTeamDialog;
