import { ipcBridge } from '@/common';
import type { Lesson, LessonScope } from '@/common/types/agent/lessonTypes';
import { lessonErrorCode } from '@renderer/pages/conversation/Preview/browser/TeachCards/LessonCard';
import { Button, Input, Message, Modal, Switch, Tooltip } from '@arco-design/web-react';
import { BookOpen, Edit, History } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from '../JrSidebar.module.css';
import { EmptyState, PageHeader, SectionLabel, SkeletonRows } from './PanelParts';
import { TAUGHT_SKILL_PREFIX } from './taskActions';

const LESSONS_KEY = 'jr.teach.lessons';
const COUNTERS_KEY = 'jr.teach.lessons.counters';
const TASKS_KEY = 'jr.teach.tasks';
const MAX_LENGTH = 200;
const GENERAL = '__general__';

type Group = { key: string; label: string; lessons: Lesson[] };

const groupKey = (scope: LessonScope): string => (scope.kind === 'general' ? GENERAL : scope.skill);

/** "Lições": what the bot learned from the employee's corrections, to switch off, edit or roll back. */
const LessonsPanel: React.FC = () => {
  const { t } = useTranslation();
  const lessons = useSWR(LESSONS_KEY, () => ipcBridge.teach.lessonsList.invoke());
  const counters = useSWR(COUNTERS_KEY, () => ipcBridge.teach.lessonsCounters.invoke());
  const skills = useSWR(TASKS_KEY, () => ipcBridge.fs.listAvailableSkills.invoke());
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const refreshLessons = lessons.mutate;
  const refreshCounters = counters.mutate;

  // Lessons also change from the chat card; the main process announces every change.
  useEffect(() => {
    return ipcBridge.teach.lessonsChanged.on(() => {
      void refreshLessons();
      void refreshCounters();
    });
  }, [refreshLessons, refreshCounters]);

  const groups = useMemo<Group[]>(() => {
    const labels = new Map((skills.data ?? []).map((skill) => [skill.name, skill.description]));
    const byKey = new Map<string, Group>();
    for (const lesson of lessons.data ?? []) {
      const key = groupKey(lesson.scope);
      let group = byKey.get(key);
      if (!group) {
        const label =
          key === GENERAL
            ? t('common.jr.teach.lessons.panel.general')
            : labels.get(key) || key.replace(TAUGHT_SKILL_PREFIX, '');
        group = { key, label, lessons: [] };
        byKey.set(key, group);
      }
      group.lessons.push(lesson);
    }
    // General first, then the tasks in the order their first lesson appears.
    return [...byKey.values()].toSorted((a, b) => Number(b.key === GENERAL) - Number(a.key === GENERAL));
  }, [lessons.data, skills.data, t]);

  /** Runs one mutation; the main process already re-syncs rules and skills, so only re-fetch here. */
  const mutateLesson = async (id: string, run: () => Promise<unknown>): Promise<boolean> => {
    setBusy(id);
    try {
      await run();
      await Promise.all([refreshLessons(), refreshCounters()]);
      return true;
    } catch (failure) {
      const code = lessonErrorCode(failure);
      Message.error(code ? t(`common.jr.teach.lessons.errors.${code}`) : t('common.jr.teach.lessons.panel.failed'));
      void refreshLessons();
      return false;
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    const current = lessons.data?.find((lesson) => lesson.id === editing.id);
    if (!text || text === current?.text) {
      setEditing(null);
      return;
    }
    if (await mutateLesson(editing.id, () => ipcBridge.teach.lessonsUpdate.invoke({ id: editing.id, text }))) {
      setEditing(null);
    }
  };

  const historyLesson = lessons.data?.find((lesson) => lesson.id === historyId);
  const stats = counters.data;

  return (
    <div>
      <PageHeader
        title={t('common.jr.teach.lessons.panel.title')}
        subtitle={t('common.jr.teach.lessons.panel.subtitle')}
      />
      {stats && (
        <p className={styles.muted}>
          {t('common.jr.teach.lessons.panel.counters', {
            offered: stats.offered,
            saved: stats.saved,
            edited: stats.edited,
            discarded: stats.discarded,
          })}
        </p>
      )}
      {!lessons.data && !lessons.error && (
        <div className={`${styles.card} ${styles.cardList}`}>
          <SkeletonRows />
        </div>
      )}
      {lessons.error && <p className={styles.muted}>{t('common.jr.teach.lessons.panel.loadFailed')}</p>}
      {!lessons.error && lessons.data && lessons.data.length === 0 && (
        <div className={`${styles.card} ${styles.cardList}`}>
          <EmptyState
            icon={<BookOpen theme='outline' size={18} />}
            title={t('common.jr.teach.lessons.panel.emptyTitle')}
            hint={t('common.jr.teach.lessons.panel.emptyHint')}
          />
        </div>
      )}
      {groups.map((group) => (
        <section key={group.key}>
          <SectionLabel>{group.label}</SectionLabel>
          <div className={`${styles.card} ${styles.cardList}`}>
            {group.lessons.map((lesson) => (
              <div key={lesson.id} className={styles.row}>
                <div className={styles.rowCopy}>
                  {editing?.id === lesson.id ? (
                    <Input.TextArea
                      value={editing.text}
                      onChange={(text) => setEditing({ id: lesson.id, text })}
                      maxLength={MAX_LENGTH}
                      showWordLimit
                      autoSize={{ minRows: 1, maxRows: 4 }}
                      aria-label={t('common.jr.teach.lessons.textLabel')}
                    />
                  ) : (
                    <p className={`${styles.rowTitle} font-500`}>{lesson.text}</p>
                  )}
                </div>
                <div className={styles.rowActions}>
                  {editing?.id === lesson.id ? (
                    <>
                      <Button size='small' shape='round' onClick={() => setEditing(null)}>
                        {t('common.jr.teach.lessons.panel.cancel')}
                      </Button>
                      <Button
                        size='small'
                        shape='round'
                        type='primary'
                        loading={busy === lesson.id}
                        disabled={!editing.text.trim()}
                        onClick={() => void saveEdit()}
                      >
                        {t('common.jr.teach.lessons.save')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Tooltip content={t('common.jr.teach.lessons.panel.edit')}>
                        <Button
                          className={styles.ghostIcon}
                          shape='circle'
                          size='small'
                          aria-label={t('common.jr.teach.lessons.panel.edit')}
                          icon={<Edit theme='outline' size={15} />}
                          onClick={() => setEditing({ id: lesson.id, text: lesson.text })}
                        />
                      </Tooltip>
                      <Tooltip content={t('common.jr.teach.lessons.panel.history')}>
                        <Button
                          className={styles.ghostIcon}
                          shape='circle'
                          size='small'
                          aria-label={t('common.jr.teach.lessons.panel.history')}
                          icon={<History theme='outline' size={15} />}
                          onClick={() => setHistoryId(lesson.id)}
                        />
                      </Tooltip>
                    </>
                  )}
                  <Switch
                    size='small'
                    checked={lesson.active}
                    disabled={busy === lesson.id}
                    aria-label={t('common.jr.teach.lessons.panel.active')}
                    onChange={(active) =>
                      void mutateLesson(lesson.id, () =>
                        ipcBridge.teach.lessonsSetActive.invoke({ id: lesson.id, active })
                      )
                    }
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      <Modal
        visible={historyLesson !== undefined}
        title={t('common.jr.teach.lessons.panel.historyTitle')}
        footer={null}
        onCancel={() => setHistoryId(null)}
        unmountOnExit
      >
        {historyLesson?.versions.length === 0 && (
          <p className={styles.muted}>{t('common.jr.teach.lessons.panel.noVersions')}</p>
        )}
        {historyLesson &&
          historyLesson.versions
            .map((version, index) => ({ version, index }))
            .toReversed()
            .map(({ version, index }) => (
              <div key={index} className={styles.row}>
                <div className={styles.rowCopy}>
                  <p className={styles.rowTitle}>{version.text}</p>
                  <p className={styles.rowMeta}>{new Date(version.at).toLocaleString()}</p>
                </div>
                <Button
                  size='small'
                  shape='round'
                  loading={busy === historyLesson.id}
                  disabled={version.text === historyLesson.text}
                  onClick={() =>
                    void mutateLesson(historyLesson.id, () =>
                      ipcBridge.teach.lessonsRevert.invoke({ id: historyLesson.id, versionIndex: index })
                    ).then((ok) => ok && setHistoryId(null))
                  }
                >
                  {t('common.jr.teach.lessons.panel.revert')}
                </Button>
              </div>
            ))}
      </Modal>
    </div>
  );
};

export default LessonsPanel;
