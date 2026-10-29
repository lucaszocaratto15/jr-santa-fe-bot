/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import DescribeCard from './DescribeCard';
import GeneratingCard from './GeneratingCard';
import ReviewCard from './ReviewCard';
import SecureCard from './SecureCard';
import { registerTeachHost, useTeachUi } from './teachStore';
import { dismissSecureRequest, resyncSecureRequests, useSecureRequests } from './useSecureRequests';

type TeachCardHostProps = {
  /** The conversation this host sits in; the describe/review cards and the draft prompt use it. */
  conversationId: string;
};

/**
 * Overlay above the send box for teach cards. Cards are not part of the transcript.
 * Secure requests target the single in-app browser, so they show in whichever chat is open
 * (and go first: a save-to-vault offer arrives right as the draft is generated). The
 * describe and review cards only show in the conversation that started the teaching.
 */
const TeachCardHost: React.FC<TeachCardHostProps> = ({ conversationId }) => {
  const requests = useSecureRequests();
  const teach = useTeachUi();
  useEffect(() => {
    void resyncSecureRequests();
  }, []);
  useEffect(() => registerTeachHost(conversationId), [conversationId]);

  const current = requests[0];
  if (current) {
    return <SecureCard key={current.id} request={current} onDone={() => dismissSecureRequest(current.id)} />;
  }
  const ours = teach.conversationId === null || teach.conversationId === conversationId;
  if (!ours) return null;
  if (teach.phase === 'describing') return <DescribeCard />;
  if (teach.phase === 'generating') return <GeneratingCard />;
  if (teach.phase === 'review' && teach.draft) {
    return <ReviewCard key={teach.draft.markdown} event={teach.draft} prompt={teach.prompt} />;
  }
  return null;
};

export default TeachCardHost;
