/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationArtifact } from '@/common/adapter/ipcBridge';
import { Message } from '@arco-design/web-react';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { queueConversationIntent } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';
import { taughtSkillFromPrompt } from './taskActions';

/** Triggers already handled in this window (the stream can repeat an artifact). */
const handled = new Set<string>();

/**
 * When a scheduled taught task fires, opens its conversation and the in-app browser (the
 * agent only controls the browser while the tab is mounted), with an in-app notice and a
 * desktop notification (skipped by main while the window is focused). Other jobs are ignored.
 */
export function useTaughtRunWatcher(): void {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => {
    const onArtifact = async (artifact: IConversationArtifact) => {
      if (artifact.kind !== 'cron_trigger' || handled.has(artifact.id)) return;
      const jobId = artifact.payload.cron_job_id || artifact.cron_job_id;
      if (!jobId) return;
      handled.add(artifact.id);
      let job;
      try {
        job = await ipcBridge.cron.getJob.invoke({ job_id: jobId });
      } catch {
        return;
      }
      if (!job || !taughtSkillFromPrompt(job.target?.payload?.text ?? '')) return;
      const conversationId = artifact.conversation_id;
      const botId = job.metadata?.agent_config?.assistant_id;
      queueConversationIntent(conversationId, { openBrowser: true });
      void navigate(`/conversation/${conversationId}${botId ? `?bot=${encodeURIComponent(botId)}` : ''}`);
      const notice = t('common.jr.teach.tasks.runningScheduled', { name: job.name });
      Message.info(notice);
      void ipcBridge.notification.show
        .invoke({
          title: notice,
          body: t('common.jr.teach.tasks.runningScheduledBody'),
          conversation_id: conversationId,
        })
        .catch(() => {});
    };
    return ipcBridge.conversation.artifactStream.on((artifact: IConversationArtifact): void => {
      void onArtifact(artifact);
    });
  }, [navigate, t]);
}
