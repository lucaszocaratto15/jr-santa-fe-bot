import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { localeNames, ptBR, readCommon, withI18n } from './i18nTestUtils';

const { accept } = vi.hoisted(() => ({ accept: vi.fn() }));

vi.mock('@/common', () => ({ ipcBridge: { learn: { accept: { invoke: accept } } } }));
vi.mock('@renderer/components/Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <div data-testid='markdown'>{children}</div>,
}));
vi.mock('@arco-design/web-react', async () => {
  const actual = await vi.importActual<typeof import('@arco-design/web-react')>('@arco-design/web-react');
  return { ...actual, Message: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } };
});

import ConsentModal from '@renderer/pages/Jr/JrSidebar/Learn/ConsentModal';

const i18n = ptBR();
const renderModal = (props: Partial<React.ComponentProps<typeof ConsentModal>> = {}) => {
  const onClose = vi.fn();
  const onAccepted = vi.fn();
  render(
    withI18n(i18n, <ConsentModal visible reconsent={false} onClose={onClose} onAccepted={onAccepted} {...props} />)
  );
  return { onClose, onAccepted };
};
const allowButton = () => screen.getByRole('button', { name: 'Permitir' });

describe('ConsentModal', () => {
  beforeEach(() => {
    accept.mockReset();
  });

  it('Permitir is disabled until the checkbox is checked', () => {
    renderModal();
    expect(allowButton()).toBeDisabled();
    fireEvent.click(screen.getByText('Li e concordo com o Termo de Consentimento de Dados'));
    expect(allowButton()).not.toBeDisabled();
  });

  it('shows the sees list without "cliques" and the never list with "Seus cliques e o que você digita"', () => {
    renderModal();
    const sees = screen.getByTestId('learn-consent-sees');
    expect(sees).not.toHaveTextContent(/cliques/i);
    expect(sees).toHaveTextContent('no navegador do JR Bot, o endereço e o título das páginas abertas');
    expect(screen.getByText('Seus cliques e o que você digita')).toBeInTheDocument();
    expect(screen.getByText('Nada enquanto estiver pausado ou desligado')).toBeInTheDocument();
  });

  it('Permitir calls learn.accept with LEARN_TERM_VERSION', async () => {
    const state = { status: 'active' };
    accept.mockResolvedValue(state);
    const { onAccepted } = renderModal();
    fireEvent.click(screen.getByText('Li e concordo com o Termo de Consentimento de Dados'));
    fireEvent.click(allowButton());
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith(state));
    expect(accept).toHaveBeenCalledWith({ termVersion: '1.3' });
  });

  it('a failed accept keeps the modal open and does not report acceptance', async () => {
    accept.mockRejectedValue(new Error('LEARN_UNAVAILABLE'));
    const { onAccepted, onClose } = renderModal();
    fireEvent.click(screen.getByText('Li e concordo com o Termo de Consentimento de Dados'));
    fireEvent.click(allowButton());
    await waitFor(() => expect(accept).toHaveBeenCalled());
    expect(onAccepted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Não agora closes without calling accept', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Não agora' }));
    expect(onClose).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('the link opens the full term containing "Versão 1.3"', async () => {
    renderModal();
    fireEvent.click(screen.getByText('Ler o termo completo'));
    const full = await screen.findByTestId('learn-term-full');
    expect(full).toHaveTextContent('Versão 1.3');
    expect(full).toHaveTextContent('transferência internacional de dados');
  });

  it('the Quem vê block says approved Manual items are visible to the gestor and future holders of the role', () => {
    renderModal();
    const who = screen.getByTestId('learn-consent-who');
    expect(who).toHaveTextContent(/seu gestor/);
    expect(who).toHaveTextContent(/quem ocupar o seu cargo no futuro/);
    expect(within(who).getByText('Manual da função').tagName).toBe('STRONG');
  });

  it('Onde fica names the fallback AI processors outside Brazil (v1.3)', () => {
    renderModal();
    expect(
      screen.getByText(
        /à MiniMax e, se ela estiver indisponível, à OpenRouter ou ao Google \(Gemini\), todos com servidores fora do Brasil/
      )
    ).toBeInTheDocument();
  });

  it('shows the reconsent notice only when the term changed', () => {
    renderModal({ reconsent: true });
    expect(screen.getByText(/O termo mudou/)).toBeInTheDocument();
  });
});

describe('consent locales', () => {
  const learnOf = (lang: string) =>
    (readCommon(lang).jr as { learn: { consent: unknown; term: { full: string } } }).learn;

  it('every locale has the same consent.* and term.full text as pt-BR', () => {
    const reference = learnOf('pt-BR');
    const langs = localeNames();
    expect(langs).toHaveLength(13);
    for (const lang of langs) {
      expect(learnOf(lang).consent, lang).toEqual(reference.consent);
      expect(learnOf(lang).term.full, lang).toBe(reference.term.full);
    }
  });

  it('term.full is the v1.3 "Termo completo" with the controller and DPO', () => {
    const full = learnOf('pt-BR').term.full;
    expect(full).toContain('Versão 1.3 — 29/10/2026');
    expect(full).toContain('CNPJ 65.472.078/0001-54');
    expect(full).toContain('João Batista Zocaratto Junior');
    expect(full).toContain('**8. Alterações**');
  });

  it('term.full §5 discloses OpenRouter and Google (Gemini) as fallback processors outside Brazil', () => {
    const full = learnOf('pt-BR').term.full;
    const section5 = full.slice(full.indexOf('**5.'), full.indexOf('**6.'));
    expect(section5).toContain('provedor de inteligência artificial MiniMax');
    expect(section5).toMatch(/OpenRouter e Google \(Gemini\), também com servidores localizados fora do Brasil/);
    expect(section5).toContain('transferência internacional de dados');
  });

  it('term.full §5 says screens never reach the AI but the manual text (steps, indicators, flowchart) does', () => {
    const full = learnOf('pt-BR').term.full;
    const section5 = full.slice(full.indexOf('**5.'), full.indexOf('**6.'));
    expect(section5).toContain('As telas **nunca** são enviadas ao provedor de IA.');
    expect(section5).toMatch(
      /o texto do manual \(atividades, passo a passo, indicadores do cargo e fluxograma.*\) é enviado ao provedor de IA/
    );
    expect(full).not.toContain('o passo a passo **não** são enviados');
    expect(full).not.toContain('ele recebe só o texto do manual');
  });
});
