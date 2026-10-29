import { ipcBridge } from '@/common';
import type { ICronJob } from '@/common/adapter/ipcBridge';
import { Button, Dropdown, Menu, Message, Modal, Tooltip } from '@arco-design/web-react';
import { AlarmClock, Edit, MagicWand, More, PlayOne, Plus } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { listJrBots, providersForNewConversation, selectJrModel, startJrConversation } from '@renderer/pages/Jr/jrBots';
import CreateTaskDialog, { type CronTaskPrefill } from '@renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog';
import { queueConversationIntent } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
import styles from '../JrSidebar.module.css';
import EditTaskModal from './EditTaskModal';
import { EmptyState, PageHeader, SkeletonRows } from './PanelParts';
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

  /** The taught jobs as the backend has them now; rejects when the list cannot be read. */
  const freshJobsBySkill = async (): Promise<Map<string, ICronJob[]>> => {
    const latest = await ipcBridge.cron.listJobs.invoke();
    void refreshJobs(latest, { revalidate: false });
    return taughtJobsBySkill(latest);
  };

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
      // Jobs first: a job left behind would run a skill that no longer exists. A fresh list,
      // because the panel's copy may still be loading or may have failed to load.
      const taskJobs = (await freshJobsBySkill()).get(name) ?? [];
      await Promise.all(taskJobs.map((job) => ipcBridge.cron.removeJob.invoke({ job_id: job.id })));
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
    setRunning(task.name);
    try {
      const bot = pickRunBot(await listJrBots(), params.get('bot'));
      if (!bot) {
        Message.warning(t('common.jr.teach.tasks.noBot'));
        return;
      }
      onClose?.();
      await runTaughtTask({ bot, prompt: buildRunPrompt(t, task, 'now'), navigate: (path) => void navigate(path) });
    } catch {
      Message.error(t('common.jr.teach.tasks.runFailed'));
    } finally {
      setRunning(null);
    }
  };

  /** "Ensinar tarefa": a new conversation of the active bot with its browser open and the describe card up. */
  const teach = async () => {
    try {
      const bot = pickRunBot(await listJrBots(), params.get('bot'));
      if (!bot) {
        Message.warning(t('common.jr.teach.tasks.noBot'));
        return;
      }
      onClose?.();
      const conversation = await startJrConversation(bot, { newConversation: true });
      queueConversationIntent(conversation.id, { openBrowser: true, describe: '' });
      void navigate(`/conversation/${conversation.id}?bot=${encodeURIComponent(bot.id)}`);
    } catch {
      Message.error(t('common.jr.teach.tasks.runFailed'));
    }
  };

  const schedule = async (task: TaughtTaskSummary) => {
    if (preparing) return;
    setPreparing(task.name);
    try {
      // A fresh list: a job missed while the panel's copy loads would become a duplicate.
      const existing = (await freshJobsBySkill()).get(task.name)?.[0];
      if (existing) {
        setScheduling({ job: existing });
        return;
      }
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
            // bind: false keeps the employee's own chat as the bot's sidebar conversation.
            startJrConversation(bot, { newConversation: true, bind: false }).then((conversation) => ({
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
      <PageHeader
        title={t('common.jr.teach.tasks.title')}
        subtitle={t('common.jr.teach.tasks.subtitle')}
        aside={
          <Button
            type='primary'
            shape='round'
            icon={<Plus theme='outline' size={14} fill='currentColor' />}
            onClick={() => void teach()}
          >
            {t('common.jr.teach.tasks.teach')}
          </Button>
        }
      />
      <div className={`${styles.card} ${styles.cardList}`}>
        {!skills.data && !skills.error && <SkeletonRows />}
        {skills.error && <p className={styles.muted}>{t('common.jr.teach.tasks.loadFailed')}</p>}
        {!skills.error && skills.data && tasks.length === 0 && (
          <EmptyState
            icon={<MagicWand theme='outline' size={18} />}
            title={t('common.jr.teach.tasks.emptyTitle')}
            hint={t('common.jr.teach.tasks.emptyHint')}
            action={
              <Button
                className={styles.softButton}
                shape='round'
                icon={<Plus theme='outline' size={14} />}
                onClick={() => void teach()}
              >
                {t('common.jr.teach.tasks.teach')}
              </Button>
            }
          />
        )}
        {tasks.map((task) => {
          const job = jobsBySkill.get(task.name)?.[0];
          return (
            <div key={task.name} className={styles.row}>
              <span className={styles.rowIcon} aria-hidden='true'>
                <MagicWand theme='outline' size={16} />
              </span>
              <div className={styles.rowCopy}>
                <p className={`${styles.rowTitle} font-500`}>{task.description || task.name}</p>
                <p className={styles.rowMeta}>
                  <span className={styles.mono}>{task.name}</span>
                  {job && (
                    <span className={styles.chip}>
                      <AlarmClock theme='outline' size={11} />
                      <span>{job.schedule.description}</span>
                    </span>
                  )}
                </p>
              </div>
              <div className={styles.rowActions}>
                <Button
                  className={styles.softButton}
                  shape='round'
                  size='small'
                  icon={<PlayOne theme='outline' size={14} />}
                  loading={running === task.name}
                  onClick={() => void run(task)}
                >
                  {t('common.jr.teach.tasks.run')}
                </Button>
                <Tooltip content={t('common.jr.teach.tasks.edit')}>
                  <Button
                    className={styles.ghostIcon}
                    shape='circle'
                    size='small'
                    aria-label={t('common.jr.teach.tasks.edit')}
                    icon={<Edit theme='outline' size={15} />}
                    onClick={() => setEditing(task.name)}
                  />
                </Tooltip>
                <Tooltip content={t('common.jr.teach.tasks.schedule')}>
                  <Button
                    className={styles.ghostIcon}
                    shape='circle'
                    size='small'
                    aria-label={t('common.jr.teach.tasks.schedule')}
                    icon={<AlarmClock theme='outline' size={15} />}
                    loading={preparing === task.name}
                    onClick={() => void schedule(task)}
                  />
                </Tooltip>
                <Dropdown
                  trigger='click'
                  position='br'
                  droplist={
                    <Menu
                      onClickMenuItem={() => {
                        setDeleting(task.name);
                        // The confirmation names the schedules; make sure it reads a current list.
                        void refreshJobs();
                      }}
                    >
                      <Menu.Item key='delete'>{t('common.jr.teach.tasks.delete')}</Menu.Item>
                    </Menu>
                  }
                >
                  <Button
                    className={styles.ghostIcon}
                    shape='circle'
                    size='small'
                    aria-label={t('common.jr.teach.tasks.more')}
                    icon={<More theme='outline' size={15} />}
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
