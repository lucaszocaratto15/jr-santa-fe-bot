import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { openBrowserTab } = vi.hoisted(() => ({ openBrowserTab: vi.fn() }));

vi.mock('@renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      available: { invoke: async () => true },
      state: { on: () => () => {} },
      draft: { on: () => () => {} },
      takeOverState: { invoke: async () => ({ on: false }) },
      secureListPending: { invoke: async () => [] },
      secureRequest: { on: () => () => {} },
      secureExpired: { on: () => () => {} },
    },
  },
}));

import TeachChatButton from '@renderer/pages/conversation/platforms/aionrs/TeachChatButton';
import { TeachRecordingBar } from '@renderer/pages/conversation/Preview/browser/TeachControls';
import { resetTeachUiForTests, useTeachUi } from '@renderer/pages/conversation/Preview/browser/TeachCards/teachStore';

const Phase: React.FC = () => <span data-testid='phase'>{useTeachUi().phase}</span>;

beforeEach(() => {
  vi.clearAllMocks();
  resetTeachUiForTests({ available: true, hosts: ['c1'] });
});

describe('TeachChatButton', () => {
  it('opens the browser and the describe card from the chat', () => {
    render(
      <>
        <TeachChatButton />
        <Phase />
      </>
    );
    fireEvent.click(screen.getByText('common.jr.teach.controls.teach'));
    expect(openBrowserTab).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('phase').textContent).toBe('describing');
  });

  it('is hidden when teach is unavailable or a teaching is under way', () => {
    resetTeachUiForTests({ available: false, hosts: ['c1'] });
    const { unmount } = render(<TeachChatButton />);
    expect(screen.queryByText('common.jr.teach.controls.teach')).toBeNull();
    unmount();
    resetTeachUiForTests({ available: true, hosts: ['c1'], phase: 'recording' });
    render(<TeachChatButton />);
    expect(screen.queryByText('common.jr.teach.controls.teach')).toBeNull();
  });
});

describe('TeachRecordingBar in the chat', () => {
  it('shows the timer and controls while recording', () => {
    resetTeachUiForTests({ available: true, hosts: ['c1'], phase: 'recording', elapsedMs: 65_000 });
    render(<TeachRecordingBar inChat />);
    expect(screen.getByRole('status').textContent).toContain('01:05 / 10:00');
    expect(screen.getByText('common.jr.teach.controls.finish')).toBeTruthy();
  });
});
