/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { IConversationMcpStatus } from '@/common/config/storage';
import CommandQueuePanel from '@/renderer/components/chat/CommandQueuePanel';
import MobileActionSheet, { useAttachEntry } from '@/renderer/components/chat/MobileActionSheet';
import SendBox from '@/renderer/components/chat/SendBox';
import ThoughtDisplay from '@/renderer/components/chat/ThoughtDisplay';
import FileAttachButton from '@/renderer/components/media/FileAttachButton';
import FilePreview from '@/renderer/components/media/FilePreview';
import HorizontalFileList from '@/renderer/components/media/HorizontalFileList';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useAutoTitle } from '@/renderer/hooks/chat/useAutoTitle';
import { getSendBoxDraftHook, type FileOrFolderItem } from '@/renderer/hooks/chat/useSendBoxDraft';
import { createSetUploadFile, useSendBoxFiles } from '@/renderer/hooks/chat/useSendBoxFiles';
import { useSlashCommands } from '@/renderer/hooks/chat/useSlashCommands';
import { useOpenFileSelector } from '@/renderer/hooks/file/useOpenFileSelector';
import { useLatestRef } from '@/renderer/hooks/ui/useLatestRef';
import {
  useConversationCommandQueue,
  type ConversationCommandQueueItem,
} from '@/renderer/pages/conversation/platforms/useConversationCommandQueue';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { getConversationRuntimeWorkspaceErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { getChatSurfaceWidthClass } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { useTeamPermission } from '@/renderer/pages/team/hooks/TeamPermissionContext';
import type { TeamSendBoxRuntime } from '@/renderer/pages/team/components/teamSendRuntime';
import { allSupportedExts } from '@/renderer/services/FileService';
import type { SessionRef } from '@/common/adapter/ipcBridge';
import CrossSessionDisabledBanner from '@/renderer/components/chat/CrossSessionDisabledBanner';
import { useCrossSessionMessageEnabled } from '@/renderer/hooks/chat/useCrossSessionMessageEnabled';
import { emitter, useAddEventListener, type SendBoxSendRequest } from '@/renderer/utils/emitter';
import { getJrBot } from '@/renderer/pages/Jr/jrBots';
import useSWR from 'swr';
import { type ChatFileRef, isChatFileRef, uploadFileRef } from '@/common/types/chatFile';
import { localSelectionItems, mergeFileSelectionItems } from '@/renderer/utils/file/fileSelection';
import { collectChatFileRefs, splitChatFileRefs } from '@/renderer/utils/file/messageFiles';
import { Button, Message, Tag } from '@arco-design/web-react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { classifyConversationBusyError } from '../conversationBusyError';
import { useAionrsMessage } from './useAionrsMessage';
import type { AionrsModelSelection } from './useAionrsModelSelection';

const useAionrsSendBoxDraft = getSendBoxDraftHook('aionrs', {
  _type: 'aionrs',
  atPath: [],
  content: '',
  uploadFile: [],
});

/** Bot id from the hash route or the search string, without using the router. */
function jrBotIdFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash || '';
  const search = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : window.location.search.replace(/^\?/, '');
  const id = new URLSearchParams(search).get('bot');
  return id && id.trim() ? id : null;
}

const EMPTY_AT_PATH: Array<string | FileOrFolderItem> = [];
const EMPTY_UPLOAD_FILES: string[] = [];

const useSendBoxDraft = (conversation_id: string) => {
  const { data, mutate } = useAionrsSendBoxDraft(conversation_id);

  const atPath = data?.atPath ?? EMPTY_AT_PATH;
  const uploadFile = data?.uploadFile ?? EMPTY_UPLOAD_FILES;
  const content = data?.content ?? '';

  const setAtPath = useCallback(
    (nextAtPath: Array<string | FileOrFolderItem>) => {
      mutate((prev) => ({ ...prev, atPath: nextAtPath }));
    },
    [data, mutate]
  );

  const setUploadFile = createSetUploadFile(mutate, data);

  const setContent = useCallback(
    (nextContent: string) => {
      mutate((prev) => ({ ...prev, content: nextContent }));
    },
    [data, mutate]
  );

  return {
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
    content,
    setContent,
  };
};

const AionrsSendBox: React.FC<{
  conversation_id: string;
  modelSelection: AionrsModelSelection;
  session_mode?: string;
  agent_name?: string;
  teamSendMessage?: (payload: { input: string; files: ChatFileRef[] }) => Promise<void>;
  teamRuntime?: TeamSendBoxRuntime;
}> = ({ conversation_id, modelSelection, agent_name, teamSendMessage, teamRuntime }) => {
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);
  const layout = useLayoutContext();
  const isMobile = Boolean(layout?.isMobile);
  const conversationContext = useConversationContextSafe();
  const loadedMcpStatuses =
    conversationContext?.loadedMcpStatuses ??
    (conversationContext?.loadedMcpServers ?? []).map<IConversationMcpStatus>((name) => ({
      id: name,
      name,
      status: 'loaded',
    }));
  const { t } = useTranslation();
  const jrBotId = jrBotIdFromLocation();
  const { data: composerBot } = useSWR(jrBotId ? ['jr.composerBot', jrBotId] : null, () => getJrBot(jrBotId as string));
  const { checkAndUpdateTitle } = useAutoTitle();
  const { current_model } = modelSelection;
  const teamPermission = useTeamPermission();
  const { running, turnStartedAtMs, setActiveMsgId, setWaitingResponse, resetState } =
    useAionrsMessage(conversation_id);
  const runtimeView = useConversationRuntimeView(conversation_id);
  const { isConversationWaitingConfirmation } = useConversationListSync();
  const { markSendStarted, markSendAccepted, markSendFailed } = runtimeView;

  const { atPath, uploadFile, setAtPath, setUploadFile, content, setContent } = useSendBoxDraft(conversation_id);

  const handleContentChange = useCallback(
    (val: string) => {
      setContent(val);
    },
    [setContent]
  );

  const [agentWarmed, setAgentWarmed] = useState(false);
  const prepareRuntimeSync = useCallback(async () => {
    if (teamPermission) {
      await teamPermission.warmupSession();
      return;
    }
    await ensureConversationRuntime(conversation_id);
  }, [conversation_id, teamPermission]);
  useEffect(() => {
    if (!conversation_id) return;
    setAgentWarmed(false);
    void prepareRuntimeSync()
      .then(() => {
        setAgentWarmed(true);
      })
      .catch((error) => {
        Message.error(
          getConversationRuntimeWorkspaceErrorMessage(error, t) || t('conversation.agentError.fallbackTitle')
        );
      });
  }, [conversation_id, prepareRuntimeSync, t]);

  const slash_commands = useSlashCommands(conversation_id, {
    conversation_type: 'aionrs',
    agentStatus: agentWarmed ? 'active' : null,
    prepareRuntime: teamPermission ? prepareRuntimeSync : undefined,
  });

  const { setSendBoxHandler } = usePreviewContext();
  const commandQueueRuntimeGate = teamRuntime?.runtimeGate ?? {
    hydrated: runtimeView.hydrated,
    canSendMessage: runtimeView.canSendMessage,
    isProcessing: runtimeView.isProcessing,
  };
  const awaitingConfirmation = isConversationWaitingConfirmation(conversation_id);
  const isCancelling = runtimeView.state === 'cancelling';
  const isBusy = isCancelling || commandQueueRuntimeGate.isProcessing || !commandQueueRuntimeGate.canSendMessage;

  const setContentRef = useLatestRef(setContent);
  const contentRef = useLatestRef(content);
  const atPathRef = useLatestRef(atPath);

  // Register handler for adding text from preview panel to sendbox
  useEffect(() => {
    const handler = (text: string) => {
      const new_content = content ? `${content}\n${text}` : text;
      setContentRef.current(new_content);
    };
    setSendBoxHandler(handler);
  }, [setSendBoxHandler, content]);

  // Listen for sendbox.fill event to append text to sendbox
  useAddEventListener(
    'sendbox.fill',
    (text: string) => {
      const prev = contentRef.current;
      setContentRef.current(prev ? `${prev}${text}` : text);
    },
    []
  );

  // Shared file handling logic
  const { handleFilesAdded, clearFiles } = useSendBoxFiles({
    atPath,
    uploadFile,
    setAtPath,
    setUploadFile,
  });

  const executeCommand = useCallback(
    async ({ input, files, sessions }: Pick<ConversationCommandQueueItem, 'input' | 'files' | 'sessions'>) => {
      if (teamPermission) await teamPermission.warmupSession();
      if (!current_model?.use_model) {
        Message.warning(t('conversation.chat.noModelSelected'));
        throw new Error('No model selected');
      }

      // The message body is plain user text; the backend resolves each
      // ChatFileRef to an absolute path and injects the [[AION_FILES]] marker at
      // the send edge — the front-end no longer builds paths nor the marker.
      try {
        void checkAndUpdateTitle(conversation_id, input);
        if (teamSendMessage) {
          await teamSendMessage({ input, files });
          emitter.emit('chat.history.refresh');
          if (files.length > 0) {
            emitter.emit('aionrs.workspace.refresh');
          }
          return;
        }

        markSendStarted();
        setWaitingResponse(true);
        const res = await ipcBridge.conversation.sendMessage.invoke({
          input,
          conversation_id,
          files,
          // `@@` references. Omitting this makes the whole feature silently
          // no-op for this platform.
          sessions,
        });
        setActiveMsgId(res.msg_id);
        markSendAccepted(res.turn_id, res.runtime, res.msg_id);
        emitter.emit('chat.history.refresh');
        if (files.length > 0) {
          emitter.emit('aionrs.workspace.refresh');
        }
      } catch (error) {
        const errorMessage =
          getConversationRuntimeWorkspaceErrorMessage(error, t) || t('conversation.agentError.fallbackTitle');
        const busyError = classifyConversationBusyError(error);
        if (busyError) {
          markSendFailed({
            kind: 'busy_conflict',
            reason: errorMessage,
            busyKind: busyError.kind,
            status: busyError.status,
            code: busyError.code,
          });
          throw error;
        }

        markSendFailed({ kind: 'ordinary', reason: errorMessage });
        Message.error(errorMessage);
        throw error;
      }
    },
    [
      checkAndUpdateTitle,
      conversation_id,
      current_model?.use_model,
      markSendAccepted,
      markSendFailed,
      markSendStarted,
      setActiveMsgId,
      setWaitingResponse,
      t,
      teamPermission,
      teamSendMessage,
    ]
  );

  const {
    items: queuedCommands,
    mode: queueMode,
    isInteractionLocked: isQueueInteractionLocked,
    enqueue,
    remove,
    prioritize,
    clear,
    reorder,
    toggleMode,
    lockInteraction,
    unlockInteraction,
    resetActiveExecution,
  } = useConversationCommandQueue({
    conversation_id: conversation_id,
    enabled: true,
    isBusy,
    runtimeGate: commandQueueRuntimeGate,
    onExecute: executeCommand,
  });

  // Handle initial message from Guid page — wait until model is ready
  useEffect(() => {
    if (!conversation_id || !current_model?.use_model) return;

    const storageKey = `aionrs_initial_message_${conversation_id}`;
    const processedKey = `aionrs_initial_processed_${conversation_id}`;

    const processInitialMessage = async () => {
      if (sessionStorage.getItem(processedKey)) return;
      const storedMessage = sessionStorage.getItem(storageKey);
      if (!storedMessage) return;

      sessionStorage.setItem(processedKey, '1');
      sessionStorage.removeItem(storageKey);

      try {
        const { input, files: initialFiles } = JSON.parse(storedMessage);
        // Guid-page initial files are source-tagged ChatFileRefs (`local` for
        // backend-machine picks, `upload` for device uploads). Legacy string[]
        // entries (a stale pre-upgrade session) coerce to upload refs.
        const initialRefs: ChatFileRef[] = Array.isArray(initialFiles)
          ? initialFiles.map((f: unknown) => (typeof f === 'string' ? uploadFileRef(f) : f)).filter(isChatFileRef)
          : [];
        await executeCommand({ input, files: initialRefs });
      } catch (error) {
        console.error('[AionrsSendBox] Failed to send initial message:', error);
        sessionStorage.removeItem(processedKey);
      }
    };

    void processInitialMessage();
  }, [conversation_id, current_model?.use_model, executeCommand]);

  // `@@` session references the user picked. Declared before the handlers that
  // read it — every send path has to both forward and release it.
  const [selectedSessions, setSelectedSessions] = useState<SessionRef[]>([]);
  const { enabled: crossSessionEnabled } = useCrossSessionMessageEnabled();

  const releaseComposer = useCallback(() => {
    setContent('');
    clearFiles();
    setSelectedSessions([]);
    emitter.emit('aionrs.selected.file.clear');
  }, [clearFiles, setContent]);

  // While a run is active, Send stores the draft — text and files — in the
  // visible queue. The queue sends it when the run ends. Send now is the
  // separate action that interrupts the run.
  const onSendHandler = async (message: string): Promise<void | false> => {
    const filesToSend = collectChatFileRefs(uploadFile, atPath);
    const sessions = selectedSessions.length > 0 ? selectedSessions : undefined;
    if (isBusy) {
      const queued = enqueue({ input: message, files: filesToSend, sessions });
      if (!queued) return false;
      releaseComposer();
      return;
    }

    releaseComposer();
    await executeCommand({ input: message, files: filesToSend, sessions });
  };

  // Programmatic sends (teach cards) take the same path as Enter; queued while busy.
  // executeCommand already shows its own failure toast; the result goes back to the caller.
  useAddEventListener(
    'sendbox.send',
    (request: SendBoxSendRequest) => {
      if (request.conversationId !== conversation_id) return;
      request.claimed = true;
      if (isBusy) {
        request.onResult(Boolean(enqueue({ input: request.text, files: [] })));
        return;
      }
      executeCommand({ input: request.text, files: [] }).then(
        () => request.onResult(true),
        () => request.onResult(false)
      );
    },
    [conversation_id, isBusy, enqueue, executeCommand]
  );

  const [interrupting, setInterrupting] = useState(false);
  const hasComposerDraft = content.trim().length > 0 || uploadFile.length > 0 || atPath.length > 0;

  // Explicit "add to queue" entry — visibility is keyed only to the user's
  // own input (non-empty draft), never to the agent's busy/replying state:
  // tying it to that racy, async signal made the entry appear/disappear
  // unpredictably. Clicking while idle is semantically fine — the queue's own
  // mode governs (auto drains immediately, manual holds). Clears the draft
  // the same way a send would.
  const canQueueCurrentDraft = content.trim().length > 0;
  const handleAddToQueue = useCallback(() => {
    const filesToSend = collectChatFileRefs(uploadFile, atPath);
    // `@@` references must ride along, and must be released from the send box
    // the same way the draft text is — otherwise they leak into whatever the
    // user sends next.
    enqueue({
      input: content,
      files: filesToSend,
      sessions: selectedSessions.length > 0 ? selectedSessions : undefined,
    });
    setContent('');
    clearFiles();
    setSelectedSessions([]);
    emitter.emit('aionrs.selected.file.clear');
  }, [atPath, clearFiles, content, enqueue, selectedSessions, setContent, uploadFile]);

  const handleEditQueuedCommand = useCallback(
    (item: ConversationCommandQueueItem) => {
      remove(item.id);
      setContent(item.input);
      // Restore the two selection lanes: upload refs → uploadFile paths,
      // project refs → atPath items carrying their chatRef (so a re-send
      // collects the same project ref).
      const { uploadFiles, atPath: restoredAtPath } = splitChatFileRefs(item.files);
      setUploadFile(uploadFiles);
      setAtPath(restoredAtPath);
      emitter.emit('aionrs.selected.file.clear');
    },
    [remove, setAtPath, setContent, setUploadFile]
  );

  const appendSelectedFiles = useCallback(
    (files: string[]) => {
      // "Add files" picks a file from the backend machine's own filesystem
      // (native dialog / server-fs browse) — an absolute backend path. Send it
      // as a `local` ref (via the atPath lane, external-owned), NOT an `upload`
      // ref: the raw path is not under the managed upload dir and would be
      // rejected. Merge into this box's atPath only (no cross-column emit).
      const merged = mergeFileSelectionItems(atPathRef.current, localSelectionItems(files));
      if (merged !== atPathRef.current) setAtPath(merged as Array<string | FileOrFolderItem>);
    },
    [setAtPath]
  );
  const { openFileSelector, onSlashBuiltinCommand } = useOpenFileSelector({
    onFilesSelected: appendSelectedFiles,
  });

  const { entries: attachEntries, hiddenFileInput: attachHiddenInput } = useAttachEntry({
    openFileSelector,
    onLocalFilesAdded: handleFilesAdded,
    dividerBefore: true,
  });

  const sheetEntries = isMobile ? attachEntries : [];

  // Accept file-selection events only when targeted at this conversation (or
  // untargeted); stops same-type peers on the team route from receiving each
  // other's selections. See emitter EventTypes comment.
  useAddEventListener(
    'aionrs.selected.file',
    (items: Array<string | FileOrFolderItem>, targetConversationId: string | undefined) => {
      if (targetConversationId === undefined || targetConversationId === conversation_id) setAtPath(items);
    },
    [conversation_id, setAtPath]
  );
  useAddEventListener(
    'aionrs.selected.file.append',
    (selectedItems: Array<string | FileOrFolderItem>, targetConversationId: string | undefined) => {
      if (targetConversationId !== undefined && targetConversationId !== conversation_id) return;
      const merged = mergeFileSelectionItems(atPathRef.current, selectedItems);
      if (merged !== atPathRef.current) {
        setAtPath(merged as Array<string | FileOrFolderItem>);
      }
    },
    [conversation_id, setAtPath]
  );

  // Stop conversation handler
  const handleStop = async (): Promise<void> => {
    // Best-effort cancel: swallow rejections so they don't bubble up as
    // unhandled rejections. UI state is still reset via finally.
    const turnId = runtimeView.activeTurnId;
    if (!turnId) {
      resetState();
      resetActiveExecution('stop');
      return;
    }
    runtimeView.markStopRequested(turnId);
    try {
      const result = await ipcBridge.conversation.stop.invoke({ conversation_id, turn_id: turnId });
      runtimeView.markStopAcknowledged(turnId, result.runtime);
    } catch (error) {
      console.warn('[AionrsSendBox] stop request failed', error);
      runtimeView.resetLocalGate('stop_failed');
    } finally {
      resetState();
      resetActiveExecution('stop');
    }
  };
  const effectiveHandleStop = teamRuntime?.onStop ?? handleStop;
  const handleSendNow = async () => {
    if (!hasComposerDraft || interrupting) return;
    const files = collectChatFileRefs(uploadFile, atPath);
    const input = content;
    const sessions = selectedSessions.length > 0 ? selectedSessions : undefined;
    setInterrupting(true);
    try {
      if (teamRuntime?.onInterruptSend && input.trim()) {
        releaseComposer();
        await teamRuntime.onInterruptSend({ input, files });
        return;
      }
      const queued = enqueue({ input, files, sessions });
      if (!queued) return;
      releaseComposer();
      await effectiveHandleStop();
      prioritize(queued.id);
    } finally {
      setInterrupting(false);
    }
  };
  const handleSendNowQueued = useCallback(
    async (item: ConversationCommandQueueItem) => {
      // Stop the current reply (best-effort), then promote the chosen command
      // to the front of the queue in auto mode.  The drain effect will fire it
      // once the execution gate shows canExecute — avoiding the 409 race that
      // occurs when sendNow() calls onExecute() directly before the backend
      // has finished processing the stop.
      await effectiveHandleStop();
      prioritize(item.id);
    },
    [effectiveHandleStop, prioritize]
  );
  const sendBoxWidthClass = getChatSurfaceWidthClass();

  return (
    <div className={`${sendBoxWidthClass} flex flex-col mt-auto mb-16px`}>
      <CommandQueuePanel
        items={queuedCommands}
        mode={queueMode}
        isMobile={isMobile}
        interactionLocked={isQueueInteractionLocked}
        onInteractionLock={lockInteraction}
        onInteractionUnlock={unlockInteraction}
        onEdit={handleEditQueuedCommand}
        onSendNow={handleSendNowQueued}
        onToggleMode={toggleMode}
        onReorder={reorder}
        onRemove={remove}
        onClear={clear}
      />
      <ThoughtDisplay
        running={(teamRuntime?.loading ?? running) && !awaitingConfirmation}
        statusText={awaitingConfirmation ? t('conversation.chat.awaitingConfirmation') : teamRuntime?.statusText}
        externalElapsedSource={Boolean(teamRuntime) || turnStartedAtMs != null}
        startedAtMs={teamRuntime ? (teamRuntime.startedAtMs ?? null) : turnStartedAtMs}
        onStop={effectiveHandleStop}
        onRetryStart={teamRuntime?.onRetryStart ? () => void teamRuntime.onRetryStart?.() : undefined}
      />
      <CrossSessionDisabledBanner />
      <SendBox
        data-testid='aionrs-sendbox'
        onMobilePlusClick={isMobile ? () => setIsMobileSheetOpen(true) : undefined}
        value={content}
        onChange={handleContentChange}
        selectedWorkspaceItems={atPath}
        onSelectedWorkspaceItemsChange={(items) => {
          emitter.emit('aionrs.selected.file', items, conversation_id);
          setAtPath(items);
        }}
        selectedSessions={selectedSessions}
        onSelectedSessionsChange={setSelectedSessions}
        crossSessionEnabled={crossSessionEnabled}
        isTeamConversation={Boolean(teamRuntime)}
        loading={teamRuntime?.loading ?? isBusy}
        active={teamRuntime?.isActive}
        onFocused={teamRuntime?.onFocus}
        disabled={!current_model?.use_model}
        sendTooltip={
          isBusy
            ? t('conversation.commandQueue.addToQueueBusyHint', {
                defaultValue: 'Save to Draft box and send it later.',
              })
            : undefined
        }
        placeholder={
          current_model?.use_model
            ? composerBot?.name
              ? t('common.jr.taskPlaceholder', { name: composerBot.name })
              : t('acp.sendbox.placeholder', {
                  backend: agent_name || 'AionCLI',
                  defaultValue: `Send message to {{backend}}...`,
                })
            : t('conversation.chat.noModelSelected')
        }
        onStop={effectiveHandleStop}
        className='z-10'
        onFilesAdded={handleFilesAdded}
        hasPendingAttachments={uploadFile.length > 0 || atPath.length > 0}
        supportedExts={allSupportedExts}
        defaultMultiLine={!isMobile}
        lockMultiLine={!isMobile}
        tools={
          <FileAttachButton
            openFileSelector={openFileSelector}
            onLocalFilesAdded={handleFilesAdded}
            loadedMcpStatuses={loadedMcpStatuses}
          />
        }
        prefix={
          <>
            {uploadFile.length > 0 && (
              <HorizontalFileList>
                {uploadFile.map((path) => (
                  <FilePreview
                    key={path}
                    data-testid={`aionrs-file-tag-${uploadFile.indexOf(path)}`}
                    path={path}
                    onRemove={() => setUploadFile(uploadFile.filter((v) => v !== path))}
                  />
                ))}
              </HorizontalFileList>
            )}
            {atPath.some((item) => (typeof item === 'string' ? false : !item.isFile)) && (
              <div className='flex flex-wrap items-center gap-8px mb-8px'>
                {atPath.map((item) => {
                  if (typeof item === 'string') return null;
                  if (!item.isFile) {
                    const folderIndex = atPath.filter((v) => typeof v !== 'string' && !v.isFile).indexOf(item);
                    return (
                      <Tag
                        key={item.path}
                        data-testid={`aionrs-folder-tag-${folderIndex}`}
                        color='blue'
                        closable
                        onClose={() => {
                          const newAtPath = atPath.filter((v) => (typeof v === 'string' ? true : v.path !== item.path));
                          emitter.emit('aionrs.selected.file', newAtPath, conversation_id);
                          setAtPath(newAtPath);
                        }}
                      >
                        {item.name}
                      </Tag>
                    );
                  }
                  return null;
                })}
              </div>
            )}
          </>
        }
        onSend={onSendHandler}
        slash_commands={slash_commands}
        onSlashBuiltinCommand={onSlashBuiltinCommand}
        onAddToDraft={handleAddToQueue}
        addToDraftDisabled={!canQueueCurrentDraft}
        addToDraftTooltip={
          isBusy
            ? t('conversation.commandQueue.addToQueueBusyHint', {
                defaultValue: 'Save to Draft box and send it later.',
              })
            : t('conversation.commandQueue.addToQueue', { defaultValue: 'Save to Draft box' })
        }
        allowSendWhileLoading
        showStopWhileComposing
        sendButtonPrefix={
          isBusy && hasComposerDraft ? (
            <Button size='mini' type='secondary' loading={interrupting} onClick={() => void handleSendNow()}>
              {t('conversation.commandQueue.sendNow', { defaultValue: 'Send now' })}
            </Button>
          ) : undefined
        }
      />
      {isMobile && (
        <>
          <MobileActionSheet
            open={isMobileSheetOpen}
            onClose={() => setIsMobileSheetOpen(false)}
            title={t('common.more', { defaultValue: 'More' })}
            entries={sheetEntries}
          />
          {attachHiddenInput}
        </>
      )}
    </div>
  );
};

export default AionrsSendBox;
