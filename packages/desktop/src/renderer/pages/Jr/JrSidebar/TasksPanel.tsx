import { ipcBridge } from '@/common';
import { Button, Message, Popconfirm } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from './JrSidebar.module.css';

/** Taught skills are named `jr-tarefa-<slug>` (see process/services/teach/recording/skillDraft.ts). */
export const TAUGHT_SKILL_PREFIX = 'jr-tarefa-';

/** "Minhas tarefas": the tasks the employee taught the bot, with delete. */
const TasksPanel: React.FC = () => {
  const { t } = useTranslation();
  const skills = useSWR('jr.teach.tasks', () => ipcBridge.fs.listAvailableSkills.invoke());
  const tasks = (skills.data ?? []).filter((skill) => skill.name.startsWith(TAUGHT_SKILL_PREFIX));

  const remove = async (name: string) => {
    try {
      await ipcBridge.fs.deleteSkill.invoke({ skill_name: name });
      await skills.mutate();
    } catch {
      Message.error(t('common.jr.teach.tasks.deleteFailed'));
    }
  };

  return (
    <div>
      <h2 className={styles.pageTitle}>{t('common.jr.teach.tasks.title')}</h2>
      <p className={styles.muted}>{t('common.jr.teach.tasks.subtitle')}</p>
      <div className={`${styles.card} ${styles.cardList}`}>
        {skills.error && <p className={styles.muted}>{t('common.jr.teach.tasks.loadFailed')}</p>}
        {!skills.error && skills.data && tasks.length === 0 && (
          <p className={styles.muted}>{t('common.jr.teach.tasks.empty')}</p>
        )}
        {tasks.map((task) => (
          <div key={task.name} className={styles.row}>
            <div className={styles.rowCopy}>
              <p className={styles.rowTitle}>{task.name}</p>
              <p className={styles.muted}>{task.description}</p>
            </div>
            <div className={styles.rowActions}>
              <Popconfirm
                title={t('common.jr.teach.tasks.deleteConfirm')}
                okText={t('common.jr.teach.tasks.delete')}
                cancelText={t('common.jr.teach.describe.cancel')}
                onOk={() => remove(task.name)}
              >
                <Button className={styles.softButton} size='small' status='danger'>
                  {t('common.jr.teach.tasks.delete')}
                </Button>
              </Popconfirm>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default TasksPanel;
