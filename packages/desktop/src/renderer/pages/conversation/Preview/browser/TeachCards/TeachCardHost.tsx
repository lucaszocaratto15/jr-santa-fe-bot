/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { useOptionalPreviewContext } from '../../context/PreviewContext';
import { TeachRecordingBar } from '../TeachControls';
import DescribeCard from './DescribeCard';
import GeneratingCard from './GeneratingCard';
import HandbookCard from './HandbookCard';
import { closeHandbookCard, startHandbookCards, useHandbookCard } from './handbookCardStore';
import ReviewCard from './ReviewCard';
import SecureCard from './SecureCard';
import {
  openDescribe,
  registerTeachHost,
  takeConversationIntent,
  useConversationIntentsVersion,
  useTeachUi,
} from './teachStore';
import { dismissSecureRequest, resyncSecureRequests, useSecureRequests } from './useSecureRequests';

const RECORDING_PHASES = new Set(['recording', 'paused', 'stopping', 'discarding']);

type TeachCardHostProps = {
  /** The conversation this host sits in; the describe/review cards and the draft prompt use it. */
  conversationId: string;
};

/**
 * Overlay above the send box for teach cards. Cards are not part of the transcript.
 * Secure requests target the single in-app browser, so they show in whichever chat is open
 * (and go first: a save-to-vault offer arrives right as the draft is generated). The
 * describe and review cards only show in the conversation that started the teaching. A
 * "Manual da função" card only shows in the conversation whose bot asked for it, after them.
 */
const TeachCardHost: React.FC<TeachCardHostProps> = ({ conversationId }) => {
  const requests = useSecureRequests();
  const teach = useTeachUi();
  // "Manual da função" card asked for by this conversation's bot (handbook_show).
  const handbook = useHandbookCard(conversationId);
  useEffect(() => startHandbookCards(), []);
  useEffect(() => {
    void resyncSecureRequests();
  }, []);
  useEffect(() => registerTeachHost(conversationId), [conversationId]);
  const openBrowserTab = useOptionalPreviewContext()?.openBrowserTab;
  // Re-checks when an intent is queued while this conversation is already on screen.
  const intentsVersion = useConversationIntentsVersion();
  // Runs after registerTeachHost, so openDescribe targets this conversation.
  useEffect(() => {
    if (!openBrowserTab) return;
    const intent = takeConversationIntent(conversationId);
    if (!intent) return;
    openBrowserTab(intent.url);
    if (intent.describe !== undefined) openDescribe(intent.describe);
  }, [conversationId, openBrowserTab, intentsVersion]);

  const current = requests[0];
  if (current) {
    return <SecureCard key={current.id} request={current} onDone={() => dismissSecureRequest(current.id)} />;
  }
  const ours = teach.conversationId === null || teach.conversationId === conversationId;
  if (ours && teach.phase === 'describing') return <DescribeCard />;
  // Timer and controls also sit in the chat that started the recording.
  if (teach.conversationId === conversationId && RECORDING_PHASES.has(teach.phase)) return <TeachRecordingBar inChat />;
  if (ours && teach.phase === 'generating') return <GeneratingCard />;
  if (ours && teach.phase === 'review' && teach.draft) {
    return <ReviewCard key={teach.draft.markdown} event={teach.draft} prompt={teach.prompt} />;
  }
  // The handbook card waits behind a secure request and the teach cards.
  if (handbook) {
    return (
      <HandbookCard
        key={`${handbook.roleKey ?? ''}:${handbook.activityId}`}
        activityId={handbook.activityId}
        roleKey={handbook.roleKey}
        onClose={() => closeHandbookCard(conversationId)}
      />
    );
  }
  return null;
};

export default TeachCardHost;
