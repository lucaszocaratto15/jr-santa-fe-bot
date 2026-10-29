/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import SecureCard from './SecureCard';
import { dismissSecureRequest, resyncSecureRequests, useSecureRequests } from './useSecureRequests';

type TeachCardHostProps = {
  /** The conversation this host sits in; teach review cards (Task 9) are scoped by it. */
  conversationId: string;
};

/**
 * Overlay above the send box for teach cards. Cards are not part of the transcript.
 * Secure requests target the single in-app browser, so they show in whichever chat is open.
 */
const TeachCardHost: React.FC<TeachCardHostProps> = () => {
  const requests = useSecureRequests();
  useEffect(() => {
    void resyncSecureRequests();
  }, []);
  const current = requests[0];
  if (!current) return null;
  return <SecureCard key={current.id} request={current} onDone={() => dismissSecureRequest(current.id)} />;
};

export default TeachCardHost;
