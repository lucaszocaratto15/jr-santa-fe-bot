import type { HandbookView } from '@/common/types/agent/handbookTypes';

export const ITEM_ID = '11111111-2222-4333-8444-555555555555';
export const MEDIA_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';

/** A role payload as main sends it: no author ids or names anywhere. */
export const view: HandbookView = {
  role: { key: 'auxiliar de escritorio', title: 'Auxiliar de escritório' },
  items: [
    {
      id: ITEM_ID,
      kind: 'activity',
      source: 'taught',
      body: {
        title: 'Lançar NF',
        description: 'Lança a nota no portal',
        frequency: 'daily',
        steps: [
          { text: 'Abrir o portal', mediaId: MEDIA_ID },
          { text: 'Entrar com a senha do cofre' },
          { text: 'Clicar em Emitir' },
        ],
        confirmBefore: ['Valor da nota'],
      },
      approvedAt: 1,
      updatedAt: 1,
      media: [MEDIA_ID],
    },
  ],
  indicators: {
    activities: [{ title: 'Lançar NF', timesPerWeek: 5, minutesPerRun: 6 }],
    timePerApp: [{ app: 'Excel', minutesPerDay: 40 }],
    contributors: 2,
  },
  roleFlowchart: 'flowchart TD\n  role(["Auxiliar de escritório"])',
  flowcharts: { [ITEM_ID]: 'flowchart TD\n  start(["Lançar NF"])' },
};
