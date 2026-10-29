import { ipcBridge } from '@/common';
import type { ICronJob } from '@/common/adapter/ipcBridge';
import { Button, Dropdown, Menu, Message, Modal } from '@arco-design/web-react';
import { AlarmClock, Edit, More, PlayOne } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { JR_BOTS_KEY } from '@renderer/pages/Jr/index';
import { listJrBots, providersForNewConversation, selectJrModel, startJrConversation } from '@renderer/pages/Jr/jrBots';
import CreateTaskDialog, { type CronTaskPrefill } from '@renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog';
import styles from '../JrSidebar.module.css';
import EditTaskModal from './EditTaskModal';
import {
  buildRunPrompt,
  pickRunBot,
  runTaughtTask,
  TAUGHT_SKILL_PREFIX,
  taughtJobsBySkill,
  type TaughtTaskSummary,
} from './taskActions';

export { TAUGHT_SKILL_PREFIX };

const JOBS_KEY = 'jr.teach.jobs';
/** Default schedule of a new taught-task job: weekdays at 09:00. */
const DEFAULT_FREQUENCY = 'weekdays';
const DEFAULT_TIME = '09:00';

type TasksPanelProps = {
  /** Closes the settings modal (Executar leaves it for the new conversation). */
  onClose?: () => void;
};

type Scheduling = { job: ICronJob } | { prefill: CronTaskPrefill };

/** "Minhas tarefas": the tasks the employee taught the bot, with Executar, Editar, Agendar and Excluir. */
const TasksPanel: React.FC<TasksPanelProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const skills = useSWR('jr.teach.tasks', () => ipcBridge.fs.listAvailableSkills.invoke());
  const bots = useSWR(JR_BOTS_KEY, listJrBots);
  const jobs = useSWR(JOBS_KEY, () => ipcBridge.cron.listJobs.invoke());
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<Scheduling | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const tasks = (skills.data ?? []).filter((skill) => skill.name.startsWith(TAUGHT_SKILL_PREFIX));
  const jobsBySkill = useMemo(() => taughtJobsBySkill(jobs.data ?? []), [jobs.data]);
  const refreshJobs = jobs.mutate;

  useEffect(() => {
    const refresh = (): void => {
      void refreshJobs();
    };
    const offs = [
      ipcBridge.cron.onJobCreated.on(refresh),
      ipcBridge.cron.onJobUpdated.on(refresh),
      ipcBridge.cron.onJobRemoved.on(refresh),
    ];
    return () => offs.forEach((off) => off());
  }, [refreshJobs]);

  const remove = async (name: string) => {
    setRemoving(true);
    try {
      // Jobs first: a job left behind would run a skill that no longer exists.
      for (const job of jobsBySkill.get(name) ?? []) {
        await ipcBridge.cron.removeJob.invoke({ job_id: job.id });
      }
      await ipcBridge.fs.deleteSkill.invoke({ skill_name: name });
      setDeleting(null);
      await Promise.all([skills.mutate(), refreshJobs()]);
    } catch {
      Message.error(t('common.jr.teach.tasks.deleteFailed'));
      setDeleting(null);
      void refreshJobs();
    } finally {
      setRemoving(false);
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

  const schedule = async (task: TaughtTaskSummary) => {
    const existing = jobsBySkill.get(task.name)?.[0];
    if (existing) {
      setScheduling({ job: existing });
      return;
    }
    if (preparing) return;
    setPreparing(task.name);
    try {
      // Fresh list: loading bots re-syncs their fixed skill defaults to include this task.
      const bot = pickRunBot(await listJrBots(), params.get('bot'));
      if (!bot) {
        Message.warning(t('common.jr.teach.tasks.noBot'));
        return;
      }
      const model = selectJrModel((await providersForNewConversation()).providers);
      if (!model?.id) {
        Message.error(t('common.jr.teach.tasks.scheduleFailed'));
        return;
      }
      setScheduling({
        prefill: {
          name: task.description || task.name,
          prompt: buildRunPrompt(t, task, 'scheduled'),
          assistantId: bot.id,
          model: { providerId: model.id, modelId: model.use_model },
          workspace: bot.workspace,
          frequency: DEFAULT_FREQUENCY,
          time: DEFAULT_TIME,
          executionMode: 'existing',
          resolveConversation: () =>
            startJrConversation(bot, { newConversation: true }).then((conversation) => ({
              id: conversation.id,
              title: conversation.name,
            })),
        },
      });
    } catch {
      Message.error(t('common.jr.teach.tasks.scheduleFailed'));
    } finally {
      setPreparing(null);
    }
  };

  const closeSchedule = () => {
    setScheduling(null);
    void refreshJobs();
  };

  const deletingHasJobs = deleting !== null && (jobsBySkill.get(deleting)?.length ?? 0) > 0;

  return (
    <div>
      <h2 className={styles.pageTitle}>{t('common.jr.teach.tasks.title')}</h2>
      <p className={styles.muted}>{t('common.jr.teach.tasks.subtitle')}</p>
      <div className={`${styles.card} ${styles.cardList}`}>
        {skills.error && <p className={styles.muted}>{t('common.jr.teach.tasks.loadFailed')}</p>}
        {!skills.error && skills.data && tasks.length === 0 && (
          <p className={styles.muted}>{t('common.jr.teach.tasks.empty')}</p>
        )}
        {tasks.map((task) => {
          const job = jobsBySkill.get(task.name)?.[0];
          return (
            <div key={task.name} className={`${styles.row} flex-wrap`}>
              <div className={styles.rowCopy}>
                <p className={styles.rowTitle}>{task.name}</p>
                <p className={styles.muted}>{task.description}</p>
                {job && (
                  <p className={`${styles.muted} flex items-center gap-4px`}>
                    <AlarmClock theme='outline' size={12} />
                    <span>{job.schedule.description}</span>
                  </p>
                )}
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
                <Button
                  className={styles.softButton}
                  size='small'
                  icon={<AlarmClock theme='outline' size={14} />}
                  loading={preparing === task.name}
                  onClick={() => void schedule(task)}
                >
                  {t('common.jr.teach.tasks.schedule')}
                </Button>
                <Dropdown
                  trigger='click'
                  position='br'
                  droplist={
                    <Menu onClickMenuItem={() => setDeleting(task.name)}>
                      <Menu.Item key='delete'>{t('common.jr.teach.tasks.delete')}</Menu.Item>
                    </Menu>
                  }
                >
                  <Button
                    className={styles.softButton}
                    size='small'
                    aria-label={t('common.jr.teach.tasks.more')}
                    icon={<More theme='outline' size={14} />}
                  />
                </Dropdown>
              </div>
            </div>
          );
        })}
      </div>
      <EditTaskModal name={editing} onClose={() => setEditing(null)} onSaved={() => void skills.mutate()} />
      {scheduling && (
        <CreateTaskDialog
          visible
          onClose={closeSchedule}
          editJob={'job' in scheduling ? scheduling.job : undefined}
          prefill={'prefill' in scheduling ? scheduling.prefill : undefined}
        />
      )}
      <Modal
        visible={deleting !== null}
        title={t('common.jr.teach.tasks.delete')}
        okText={t('common.jr.teach.tasks.delete')}
        cancelText={t('common.jr.teach.describe.cancel')}
        okButtonProps={{ status: 'danger' }}
        confirmLoading={removing}
        onOk={() => deleting && void remove(deleting)}
        onCancel={() => setDeleting(null)}
        unmountOnExit
      >
        {t(deletingHasJobs ? 'common.jr.teach.tasks.deleteConfirmScheduled' : 'common.jr.teach.tasks.deleteConfirm')}
      </Modal>
    </div>
  );
};

export default TasksPanel;
