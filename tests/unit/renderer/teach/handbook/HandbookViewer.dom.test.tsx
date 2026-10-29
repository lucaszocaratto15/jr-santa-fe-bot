import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { ITEM_ID, MEDIA_ID, view } from './fixtures';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
  }),
}));
vi.mock('@renderer/components/Markdown/MermaidBlock', () => ({
  __esModule: true,
  default: ({ code }: { code: string }) => <pre data-testid='mermaid'>{code}</pre>,
}));

import HandbookViewer from '@renderer/components/media/HandbookViewer';
import RoleIndicators from '@renderer/components/media/HandbookViewer/RoleIndicators';
import StepReplay from '@renderer/components/media/HandbookViewer/StepReplay';

const loadMedia = vi.fn(async (id: string) => `data:image/jpeg;base64,${id}`);

describe('StepReplay', () => {
  const steps = view.items[0].body.steps;

  it('replay shows the protected-step text where a step has no image', async () => {
    render(<StepReplay steps={steps} loadMedia={loadMedia} />);
    expect(await screen.findByRole('img')).toHaveAttribute('src', `data:image/jpeg;base64,${MEDIA_ID}`);
    fireEvent.click(screen.getByText('common.jr.handbook.replay.next'));
    expect(screen.getByText('common.jr.handbook.replay.noShot')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('replay navigates with Próximo/Anterior and stops at the ends', () => {
    render(<StepReplay steps={steps} loadMedia={loadMedia} />);
    const previous = screen.getByText('common.jr.handbook.replay.previous').closest('button') as HTMLButtonElement;
    const next = screen.getByText('common.jr.handbook.replay.next').closest('button') as HTMLButtonElement;
    expect(previous).toBeDisabled();
    expect(screen.getByText(/"current":1,"total":3/)).toBeInTheDocument();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getByText(/"current":3,"total":3/)).toBeInTheDocument();
    expect(screen.getByText('Clicar em Emitir')).toBeInTheDocument();
    expect(next).toBeDisabled();
    fireEvent.click(previous);
    expect(screen.getByText(/"current":2,"total":3/)).toBeInTheDocument();
  });
});

describe('RoleIndicators', () => {
  it('indicators render per role and the component never shows author names', () => {
    const { container } = render(<RoleIndicators indicators={view.indicators} />);
    expect(container.textContent).toContain('"times":5');
    expect(container.textContent).toContain('"count":2');
    expect(container.textContent).not.toMatch(/Autor|author/i);
  });

  it('shows the empty text without indicators', () => {
    render(<RoleIndicators indicators={null} />);
    expect(screen.getByText('common.jr.handbook.indicators.empty')).toBeInTheDocument();
  });
});

describe('HandbookViewer', () => {
  it('shows the role flowchart and opens an activity with its flowchart and replay', async () => {
    render(<HandbookViewer payload={view} loadMedia={loadMedia} />);
    expect(screen.getByTestId('mermaid')).toHaveTextContent('Auxiliar de escritório');
    fireEvent.click(screen.getByText(/Lançar NF ·/));
    expect(await screen.findByTestId('handbook-replay')).toBeInTheDocument();
    expect(screen.getByTestId('mermaid')).toHaveTextContent('start');
    expect(screen.getByText('Valor da nota')).toBeInTheDocument();
    fireEvent.click(screen.getByText('common.jr.handbook.viewer.back'));
    expect(screen.getByTestId('handbook-role')).toBeInTheDocument();
  });

  it('with activityId shows that activity only, without a way back to the role', () => {
    render(<HandbookViewer payload={view} activityId={ITEM_ID} loadMedia={loadMedia} />);
    expect(screen.getByTestId('handbook-activity')).toBeInTheDocument();
    expect(screen.queryByText('common.jr.handbook.viewer.back')).not.toBeInTheDocument();
  });

  it('says plainly when the role has no handbook', () => {
    render(<HandbookViewer payload={{ ...view, items: [], indicators: null }} loadMedia={loadMedia} />);
    expect(screen.getByText('common.jr.handbook.viewer.noHandbook')).toBeInTheDocument();
  });

  it('has no edit or delete control', () => {
    render(<HandbookViewer payload={view} activityId={ITEM_ID} loadMedia={loadMedia} />);
    expect(screen.queryByText(/withdraw|dismiss|delete|edit/i)).not.toBeInTheDocument();
  });
});
