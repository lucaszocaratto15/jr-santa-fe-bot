/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { LessonProposal, LessonScope } from '@/common/types/agent/lessonTypes';
import { TAUGHT_SKILL_PREFIX } from '@renderer/pages/Jr/JrSidebar/Teach/taskActions';
import { Alert, Button, Checkbox, Input, Select } from '@arco-design/web-react';
import { BookOpen } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clearLessonCard } from './lessonCardStore';
import styles from './TeachCards.module.css';

const GENERAL = '__general__';
const LESSON_ERRORS = ['limit_task', 'limit_general', 'secret', 'too_long', 'not_found'] as const;
type LessonError = (typeof LESSON_ERRORS)[number];

type LessonCardProps = {
  conversationId: string;
  proposals: LessonProposal[];
  upToMessageId: string;
};

type Row = { checked: boolean; text: string; scope: string };
type TaskOption = { name: string; label: string };

const scopeValue = (scope: LessonScope): string => (scope.kind === 'general' ? GENERAL : scope.skill);
const toScope = (value: string): LessonScope =>
  value === GENERAL ? { kind: 'general' } : { kind: 'task', skill: value };

/** The lesson store error code in an IPC rejection (`JR_LESSON_<CODE>`), or null. */
export const lessonErrorCode = (failure: unknown): LessonError | null => {
  const message = failure instanceof Error ? failure.message : typeof failure === 'string' ? failure : '';
  const match = /JR_LESSON_([A-Z_]+)/.exec(message);
  const code = match?.[1]?.toLowerCase();
  return LESSON_ERRORS.find((known) => known === code) ?? null;
};

/**
 * The lessons the bot offers after a corrected stretch. Nothing is stored until the employee
 * keeps it with Salvar; each lesson can be edited, moved to another scope or left out.
 */
const LessonCard: React.FC<LessonCardProps> = ({ conversationId, proposals, upToMessageId }) => {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[]>(() =>
    proposals.map((proposal) => ({ checked: true, text: proposal.text, scope: scopeValue(proposal.scope) }))
  );
  const [tasks, setTasks] = useState<TaskOption[]>([]);
  const [oldTexts, setOldTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    void ipcBridge.fs.listAvailableSkills
      .invoke()
      .then((skills) => {
        if (!alive) return;
        setTasks(
          skills
            .filter((skill) => skill.name.startsWith(TAUGHT_SKILL_PREFIX))
            .map((skill) => ({ name: skill.name, label: skill.description || skill.name }))
        );
      })
      .catch(() => {});
    if (proposals.some((proposal) => proposal.updateId)) {
      void ipcBridge.teach.lessonsList
        .invoke()
        .then((lessons) => {
          if (alive) setOldTexts(Object.fromEntries(lessons.map((lesson) => [lesson.id, lesson.text])));
        })
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [proposals]);

  const patch = (index: number, change: Partial<Row>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...change } : row)));

  const close = () => clearLessonCard(conversationId);

  const send = async (keep: boolean) => {
    setBusy(true);
    setError(null);
    const accepted = keep
      ? proposals.flatMap((proposal, index) => {
          const row = rows[index];
          if (!row?.checked || !row.text.trim()) return [];
          const text = row.text.trim();
          const scope = toScope(row.scope);
          const edited = text !== proposal.text || row.scope !== scopeValue(proposal.scope);
          return [{ proposal: { ...proposal, text, scope }, edited }];
        })
      : [];
    try {
      await ipcBridge.teach.lessonsSave.invoke({
        conversationId,
        upToMessageId,
        accepted,
        discarded: proposals.length - accepted.length,
      });
      close();
    } catch (failure) {
      const code = lessonErrorCode(failure);
      setError(code ? t(`common.jr.teach.lessons.errors.${code}`) : t('common.jr.teach.lessons.saveFailed'));
      setBusy(false);
    }
  };

  const options = [
    { value: GENERAL, label: t('common.jr.teach.lessons.scopeAll') },
    ...tasks.map((task) => ({ value: task.name, label: task.label })),
  ];
  // A proposal for a task that is no longer taught still shows its own scope.
  const optionsFor = (current: string) =>
    options.some((option) => option.value === current) ? options : [...options, { value: current, label: current }];

  const title = t('common.jr.teach.lessons.title');
  const nothingChecked = !rows.some((row) => row.checked && row.text.trim());

  return (
    <div className={`${styles.card} ${styles.suggestion}`} role='region' aria-label={title}>
      <div className={styles.title}>
        <BookOpen theme='outline' size={16} className={styles.icon} />
        <span>{title}</span>
        <Button
          type='text'
          size='small'
          className={styles.editSuggestion}
          disabled={busy}
          aria-expanded={editing}
          onClick={() => setEditing((value) => !value)}
        >
          {t(editing ? 'common.jr.look.finishEditing' : 'common.edit')}
        </Button>
      </div>
      {proposals.map((proposal, index) => {
        const row = rows[index];
        if (!row) return null;
        const oldText = proposal.updateId ? oldTexts[proposal.updateId] : undefined;
        return (
          <div key={`${index}-${proposal.sourceQuote}`} className={styles.lesson}>
            <Checkbox
              checked={row.checked}
              disabled={busy}
              onChange={(checked) => patch(index, { checked })}
              aria-label={t('common.jr.teach.lessons.keep')}
            />
            <div className={styles.lessonBody}>
              {proposal.updateId && (
                <div className={styles.lessonUpdate}>
                  <span className={styles.chipLabel}>{t('common.jr.teach.lessons.updates')}</span>
                  {oldText && <del>{oldText}</del>}
                </div>
              )}
              {editing ? (
                <>
                  <Input.TextArea
                    value={row.text}
                    onChange={(text) => patch(index, { text })}
                    disabled={busy || !row.checked}
                    maxLength={200}
                    showWordLimit
                    autoSize={{ minRows: 1, maxRows: 4 }}
                    aria-label={t('common.jr.teach.lessons.textLabel')}
                  />
                  <Select
                    size='small'
                    value={row.scope}
                    onChange={(scope) => patch(index, { scope })}
                    // An update keeps the existing lesson's scope: the store does not move lessons.
                    disabled={busy || !row.checked || Boolean(proposal.updateId)}
                    options={optionsFor(row.scope)}
                    aria-label={t('common.jr.teach.lessons.scopeLabel')}
                  />
                </>
              ) : (
                <div className={styles.lessonSummary}>
                  <p>{row.text}</p>
                  <span>{optionsFor(row.scope).find((option) => option.value === row.scope)?.label}</span>
                </div>
              )}
              <span className={styles.footnote}>
                {t('common.jr.teach.lessons.quote', { quote: proposal.sourceQuote })}
              </span>
            </div>
          </div>
        );
      })}
      {error && <Alert type='error' content={error} />}
      <div className={styles.actions}>
        <Button type='text' disabled={busy} onClick={() => void send(false)}>
          {t('common.jr.teach.lessons.discard')}
        </Button>
        <Button type='primary' disabled={busy || nothingChecked} loading={busy} onClick={() => void send(true)}>
          {t('common.jr.teach.lessons.save')}
        </Button>
      </div>
    </div>
  );
};

export default LessonCard;
