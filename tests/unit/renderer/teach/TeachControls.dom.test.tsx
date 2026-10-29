import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { takeOver, takeOverState, stop } = vi.hoisted(() => ({
  takeOver: vi.fn(async (_input: { on: boolean }) => {}),
  takeOverState: vi.fn(async () => ({ on: false })),
  stop: vi.fn(async () => ({ id: 'rec', timeline: '', description: 'x', secretOrigins: [], prompt: 'PROMPT' })),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    teach: {
      available: { invoke: async () => true },
      state: { on: () => () => {} },
      draft: { on: () => () => {} },
      takeOver: { invoke: takeOver },
      takeOverState: { invoke: takeOverState },
      stop: { invoke: stop },
    },
  },
}));

import TeachControls, {
  formatElapsed,
  TeachRecordingBar,
} from '@renderer/pages/conversation/Preview/browser/TeachControls';
import { resetTeachUiForTests, useTeachUi } from '@renderer/pages/conversation/components/TeachCards/teachStore';

const Phase: React.FC = () => <span data-testid='phase'>{useTeachUi().phase}</span>;

beforeEach(() => {
  vi.clearAllMocks();
  resetTeachUiForTests({ available: true, hosts: ['c1'] });
});

describe('TeachControls', () => {
  it('formats elapsed time as mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(134_999)).toBe('02:14');
    expect(formatElapsed(600_000)).toBe('10:00');
  });

  it('is hidden when teach is unavailable; Ensinar needs a chat that can show the cards', () => {
    resetTeachUiForTests({ available: false, hosts: ['c1'] });
    const { rerender } = render(<TeachControls agentActive />);
    expect(screen.queryByText('common.jr.teach.controls.teach')).toBeNull();
    expect(screen.queryByText('common.jr.teach.controls.takeOver')).toBeNull();
    act(() => resetTeachUiForTests({ available: true, hosts: [] }));
    rerender(<TeachControls agentActive />);
    expect(screen.queryByText('common.jr.teach.controls.teach')).toBeNull();
    // Assumir does not depend on a mounted card host.
    expect(screen.getByText('common.jr.teach.controls.takeOver')).toBeTruthy();
  });

  it('resyncs the take-over state from main on mount', async () => {
    takeOverState.mockResolvedValueOnce({ on: true });
    render(<TeachControls agentActive={false} />);
    await waitFor(() => expect(screen.getByText('common.jr.teach.controls.giveBack')).toBeTruthy());
  });

  it('Ensinar opens the describe card', () => {
    render(
      <>
        <TeachControls agentActive={false} />
        <Phase />
      </>
    );
    expect(screen.queryByText('common.jr.teach.controls.takeOver')).toBeNull();
    fireEvent.click(screen.getByText('common.jr.teach.controls.teach'));
    expect(screen.getByTestId('phase').textContent).toBe('describing');
  });

  it('offers Assumir while the agent drives, then Devolver ao bot', async () => {
    render(<TeachControls agentActive />);
    fireEvent.click(screen.getByText('common.jr.teach.controls.takeOver'));
    await waitFor(() => expect(screen.getByText('common.jr.teach.controls.giveBack')).toBeTruthy());
    expect(takeOver).toHaveBeenCalledWith({ on: true });
    fireEvent.click(screen.getByText('common.jr.teach.controls.giveBack'));
    await waitFor(() => expect(takeOver).toHaveBeenLastCalledWith({ on: false }));
  });

  it('shows the recording bar with the timer and finishes through teach.stop', async () => {
    resetTeachUiForTests({ available: true, hosts: ['c1'], phase: 'recording', elapsedMs: 134_000 });
    render(<TeachRecordingBar />);
    expect(screen.getByText(/02:14 \/ 10:00/)).toBeTruthy();
    fireEvent.click(screen.getByText('common.jr.teach.controls.finish'));
    await waitFor(() => expect(stop).toHaveBeenCalled());
  });
});
