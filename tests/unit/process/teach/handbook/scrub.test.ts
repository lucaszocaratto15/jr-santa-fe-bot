import { describe, expect, it } from 'vitest';
import { SCRUBBED, scrubText } from '@process/services/teach/handbook/scrub';

describe('scrubText', () => {
  it('removes a password stated in a sentence', () => {
    expect(scrubText('Entrar no ERP: a senha do ERP é Ab12cd e depois abrir Compras')).toBe(
      `Entrar no ERP: a ${SCRUBBED} e depois abrir Compras`
    );
    expect(scrubText('A senha do wifi e jrsantafe2024.')).toBe(`A ${SCRUBBED}`);
    expect(scrubText('o token da API é Xk9!pq')).toBe(`o ${SCRUBBED}`);
  });

  it('keeps plain talk about passwords and the old forms still work', () => {
    expect(scrubText('A senha do ERP é trocada todo mês')).toBe('A senha do ERP é trocada todo mês');
    expect(scrubText('A senha e o login ficam com o TI')).toBe('A senha e o login ficam com o TI');
    expect(scrubText('senha: abc123')).toBe(SCRUBBED);
  });
});
