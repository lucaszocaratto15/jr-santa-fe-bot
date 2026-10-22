import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ workspace: vi.fn(), save: vi.fn(), skills: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/common', () => ({
  ipcBridge: {
    jr: { createWorkspace: { invoke: mocks.workspace } },
    fs: { listAvailableSkills: { invoke: mocks.skills } },
  },
}));
vi.mock('@/renderer/pages/Jr/jrBots', () => ({
  saveJrBot: mocks.save,
  JR_DEFAULT_INSTRUCTIONS: 'Responda sempre em português do Brasil.',
}));
import JrBotDialog from '@/renderer/pages/Jr/JrBotDialog';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.workspace.mockResolvedValue('/tmp/novo-bot');
  mocks.save.mockResolvedValue({ id: 'bot-1', name: 'Compras', workspace: '/tmp/novo-bot' });
  mocks.skills.mockResolvedValue([]);
});
it('requires only a name and appearance in the creation form', () => {
  render(<JrBotDialog visible onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.close' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.createAction' })).toBeDisabled();
  expect(screen.queryByLabelText('common.jr.botInstructions')).not.toBeInTheDocument();
  expect(screen.queryByText('common.jr.chooseFolder')).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /common.jr.shapes./ })).toHaveLength(13);
  expect(screen.getAllByRole('button', { name: /common.jr.colors./ })).toHaveLength(11);
  expect(mocks.workspace).not.toHaveBeenCalled();
});
it('provisions the local folder and saves the selected character', async () => {
  const saved = vi.fn();
  render(<JrBotDialog visible onClose={vi.fn()} onSaved={saved} />);
  fireEvent.change(screen.getByLabelText('common.jr.botName'), { target: { value: 'Compras' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.shapes.heart' }));
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.colors.blue' }));
  fireEvent.click(screen.getByText('common.jr.createAction'));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  expect(mocks.save).toHaveBeenCalledWith(
    expect.objectContaining({
      name: 'Compras',
      workspace: '/tmp/novo-bot',
      appearance: { shape: 'heart', color: 'blue' },
      useChrome: true,
    }),
    undefined
  );
});
it('selects every skill by default and can clear them, with Chrome checked', async () => {
  mocks.skills.mockResolvedValue([
    { name: 'planilhas', description: 'Planilhas' },
    { name: 'pesquisa-jr', description: 'Pesquisa' },
  ]);
  render(<JrBotDialog visible onClose={vi.fn()} onSaved={vi.fn()} />);
  expect(screen.getByRole('checkbox', { name: 'common.jr.chromeEnabled' })).toBeChecked();
  fireEvent.change(screen.getByLabelText('common.jr.botName'), { target: { value: 'Compras' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'common.jr.skillsSelectNone' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.skillsSelectNone' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'common.jr.chromeEnabled' }));
  fireEvent.click(screen.getByText('common.jr.createAction'));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ skillIds: [], useChrome: false }), undefined)
  );
});
it('retains the name and character after a failed save', async () => {
  mocks.save.mockRejectedValue(new Error('unavailable'));
  render(<JrBotDialog visible onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('common.jr.botName'), { target: { value: 'Compras' } });
  fireEvent.click(screen.getByRole('button', { name: 'common.jr.shapes.heart' }));
  fireEvent.click(screen.getByText('common.jr.createAction'));
  expect(await screen.findByRole('alert')).toHaveTextContent('common.jr.saveError');
  expect(screen.getByDisplayValue('Compras')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.jr.shapes.heart' })).toHaveAttribute('aria-pressed', 'true');
});
