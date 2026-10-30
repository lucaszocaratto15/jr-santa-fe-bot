import { ipcBridge } from '@/common';
import type { BrainFactPatch, BrainManagedFact } from '@/common/types/agent/brainTypes';
import { Alert, Button, Input, Modal, Select, Spin } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import styles from './Brain.module.css';
import type { BrainAreaOption } from './brainShared';

const TEXT_MAX = 2000;

type EditProps = {
  fact: BrainManagedFact;
  /** Areas the fact can be moved to (Geral is reached through "Promover a Geral"). */
  areas: BrainAreaOption[];
  busy: boolean;
  onSave: (patch: BrainFactPatch) => void;
  onCancel: () => void;
};

/** Edit text, area and risk; only the fields that changed are sent. */
export const EditFactModal: React.FC<EditProps> = ({ fact, areas, busy, onSave, onCancel }) => {
  const { t } = useTranslation();
  const [text, setText] = useState(fact.text);
  const [areaId, setAreaId] = useState(fact.areaId);
  const [risk, setRisk] = useState(fact.risk);
  const patch: BrainFactPatch = {};
  if (text.trim() !== fact.text) patch.text = text.trim();
  if (areaId !== fact.areaId) patch.areaId = areaId;
  if (risk !== fact.risk) patch.risk = risk;
  const changed = Object.keys(patch).length > 0 && text.trim().length > 0;
  const options = areas.some((area) => area.id === fact.areaId)
    ? areas
    : [...areas, { id: fact.areaId, name: String(fact.areaId), isGeneral: false, isFallback: false }];
  return (
    <Modal
      visible
      title={t('common.jr.brainManage.facts.editTitle')}
      closable={!busy}
      maskClosable={!busy}
      onCancel={onCancel}
      footer={[
        <Button key='cancel' type='text' shape='round' disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>,
        <Button
          key='save'
          type='primary'
          shape='round'
          loading={busy}
          disabled={!changed}
          onClick={() => onSave(patch)}
        >
          {t('common.save')}
        </Button>,
      ]}
    >
      <label className={styles.field}>
        <span>{t('common.jr.brainManage.facts.textLabel')}</span>
        <Input.TextArea
          value={text}
          onChange={setText}
          maxLength={TEXT_MAX}
          showWordLimit
          autoSize={{ minRows: 3, maxRows: 8 }}
          aria-label={t('common.jr.brainManage.facts.textLabel')}
        />
      </label>
      <div className={styles.field}>
        <span>{t('common.jr.brainManage.facts.areaLabel')}</span>
        <Select value={areaId} onChange={setAreaId} aria-label={t('common.jr.brainManage.facts.areaLabel')}>
          {options.map((area) => (
            <Select.Option key={area.id} value={area.id} disabled={area.isGeneral && area.id !== fact.areaId}>
              {area.name}
            </Select.Option>
          ))}
        </Select>
      </div>
      <div className={styles.field}>
        <span>{t('common.jr.brainManage.facts.riskLabel')}</span>
        <Select value={risk} onChange={setRisk} aria-label={t('common.jr.brainManage.facts.riskLabel')}>
          <Select.Option value='low'>{t('common.jr.brainManage.facts.risk.low')}</Select.Option>
          <Select.Option value='high'>{t('common.jr.brainManage.facts.risk.high')}</Select.Option>
        </Select>
      </div>
      <p className={styles.meta}>{t('common.jr.brainManage.facts.editHint')}</p>
    </Modal>
  );
};

/** The supersession chain of a fact, oldest first. */
export const HistoryModal: React.FC<{ factId: number; onClose: () => void }> = ({ factId, onClose }) => {
  const { t, i18n } = useTranslation();
  const history = useSWR(['jr.brain.history', factId], () => ipcBridge.brain.manage.history.invoke({ id: factId }), {
    shouldRetryOnError: false,
  });
  return (
    <Modal visible title={t('common.jr.brainManage.facts.historyTitle')} footer={null} onCancel={onClose}>
      {history.error && <Alert type='error' content={t('common.jr.brainManage.errors.generic')} />}
      {!history.data && !history.error && <Spin />}
      {history.data?.length === 0 && <p className={styles.empty}>{t('common.jr.brainManage.facts.historyEmpty')}</p>}
      {history.data?.map((version) => (
        <div key={version.id} className={styles.areaRow}>
          <div className={styles.grow}>
            <p className={styles.text}>{version.text}</p>
            <span className={styles.meta}>
              {new Date(version.createdAt).toLocaleDateString(i18n.language)}
              {version.id === factId && ` · ${t('common.jr.brainManage.facts.historyCurrent')}`}
            </span>
          </div>
        </div>
      ))}
    </Modal>
  );
};
