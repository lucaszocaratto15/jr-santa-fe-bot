import { ipcBridge } from '@/common';
import { Button, Message, Popconfirm } from '@arco-design/web-react';
import { Edit, PlayOne } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { JR_BOTS_KEY } from '@renderer/pages/Jr/index';
import { listJrBots } from '@renderer/pages/Jr/jrBots';
import styles from '../JrSidebar.module.css';
import EditTaskModal from './EditTaskModal';
import { buildRunPrompt, pickRunBot, runTaughtTask, TAUGHT_SKILL_PREFIX, type TaughtTaskSummary } from './taskActions';

export { TAUGHT_SKILL_PREFIX };

type TasksPanelProps = {
  /** Closes the settings modal (Executar leaves it for the new conversation). */
  onClose?: () => void;
};

/** "Minhas tarefas": the tasks the employee taught the bot, with Executar, Editar and delete. */
const TasksPanel: React.FC<TasksPanelProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const skills = useSWR('jr.teach.tasks', () => ipcBridge.fs.listAvailableSkills.invoke());
  const bots = useSWR(JR_BOTS_KEY, listJrBots);
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const tasks = (skills.data ?? []).filter((skill) => skill.name.startsWith(TAUGHT_SKILL_PREFIX));

  const remove = async (name: string) => {
    try {
      await ipcBridge.fs.deleteSkill.invoke({ skill_name: name });
      await skills.mutate();
    } catch {
      Message.error(t('common.jr.teach.tasks.deleteFailed'));
    }
  };

  const run = async (task: TaughtTaskSummary) => {
    if (running) return;
    const bot = pickRunBot(bots.data ?? [], params.get('bot'));
    if (!bot) {
      Message.warning(t('common.jr.teach.tasks.noBot'));
      return;
    }
    setRunning(task.name);
    onClose?.();
    try {
      await runTaughtTask({ bot, prompt: buildRunPrompt(t, task, 'now'), navigate: (path) => void navigate(path) });
    } catch {
      Message.error(t('common.jr.teach.tasks.runFailed'));
    } finally {
      setRunning(null);
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
              <Button
                className={styles.softButton}
                size='small'
                icon={<PlayOne theme='outline' size={14} />}
                loading={running === task.name}
                onClick={() => void run(task)}
              >
                {t('common.jr.teach.tasks.run')}
              </Button>
              <Button
                className={styles.softButton}
                size='small'
                icon={<Edit theme='outline' size={14} />}
                onClick={() => setEditing(task.name)}
              >
                {t('common.jr.teach.tasks.edit')}
              </Button>
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
      <EditTaskModal name={editing} onClose={() => setEditing(null)} onSaved={() => void skills.mutate()} />
    </div>
  );
};

export default TasksPanel;
