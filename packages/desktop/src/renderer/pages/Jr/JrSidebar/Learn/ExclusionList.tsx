import type { LearnExclusion } from '@/common/types/agent/learnTypes';
import { Button, Input, Select, Tag } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import styles from '../JrSidebar.module.css';

/** Builtin rule ids are `<group>-…`; the defaults are shown and removed as three groups. */
const GROUPS = ['bank', 'whatsapp', 'mail'] as const;
type Group = (typeof GROUPS)[number];
const groupOf = (rule: LearnExclusion): Group | null =>
  rule.builtin ? (GROUPS.find((group) => rule.id.startsWith(`${group}-`)) ?? null) : null;

type ExclusionListProps = {
  rules: LearnExclusion[];
  onChange: (rules: LearnExclusion[]) => void;
  onRestore: () => void;
};

/** "Não observar": default groups plus the employee's own rules. */
const ExclusionList: React.FC<ExclusionListProps> = ({ rules, onChange, onRestore }) => {
  const { t } = useTranslation();
  const [kind, setKind] = useState<LearnExclusion['kind']>('domain');
  const [pattern, setPattern] = useState('');

  const groups = GROUPS.filter((group) => rules.some((rule) => groupOf(rule) === group));
  const custom = rules.filter((rule) => groupOf(rule) === null);

  const add = () => {
    const value = pattern.trim();
    if (!value) return;
    const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    onChange([...rules, { id, kind, pattern: value, builtin: false }]);
    setPattern('');
  };

  return (
    <div>
      <p className={styles.muted}>{t('common.jr.learn.exclusions.hint')}</p>
      <div className='flex flex-wrap gap-8px my-12px' data-testid='learn-exclusions'>
        {groups.length === 0 && custom.length === 0 && (
          <span className={styles.muted}>{t('common.jr.learn.exclusions.empty')}</span>
        )}
        {groups.map((group) => (
          <Tag
            key={group}
            closable
            onClose={() => onChange(rules.filter((rule) => groupOf(rule) !== group))}
            aria-label={t(`common.jr.learn.exclusions.groups.${group}`)}
          >
            {t(`common.jr.learn.exclusions.groups.${group}`)}
          </Tag>
        ))}
        {custom.map((rule) => (
          <Tag key={rule.id} closable onClose={() => onChange(rules.filter((item) => item.id !== rule.id))}>
            {`${t(`common.jr.learn.exclusions.kind.${rule.kind}`)}: ${rule.pattern}`}
          </Tag>
        ))}
      </div>
      <div className='flex flex-wrap items-center gap-8px'>
        <Select
          className={`${styles.softSelect} w-150px`}
          size='small'
          value={kind}
          onChange={(value: LearnExclusion['kind']) => setKind(value)}
          options={(['domain', 'app', 'title'] as const).map((value) => ({
            value,
            label: t(`common.jr.learn.exclusions.kind.${value}`),
          }))}
        />
        <Input
          className='w-220px'
          size='small'
          value={pattern}
          maxLength={200}
          placeholder={t('common.jr.learn.exclusions.patternPlaceholder')}
          onChange={setPattern}
          onPressEnter={add}
        />
        <Button
          className={styles.softButton}
          size='small'
          icon={<Plus theme='outline' size={14} />}
          disabled={!pattern.trim()}
          onClick={add}
        >
          {t('common.jr.learn.exclusions.add')}
        </Button>
        {groups.length < GROUPS.length && (
          <Button type='text' size='small' onClick={onRestore}>
            {t('common.jr.learn.exclusions.restore')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default ExclusionList;
