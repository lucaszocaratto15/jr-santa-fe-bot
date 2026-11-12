const READ_TOOLS = new Set([
  'erp.quem_sou',
  'erp.consultas.buscar',
  'erp.consultas.descrever',
  'erp.consultas.executar',
]);
const DIRECT_TOOLS = {
  strata_identidade: 'erp.quem_sou',
  strata_consultas_buscar: 'erp.consultas.buscar',
  strata_consultas_descrever: 'erp.consultas.descrever',
  strata_consultas_executar: 'erp.consultas.executar',
};
const TERMINAL_ERRORS = new Set([
  'strata_rate_limited',
  'rate_limited',
  'strata_reconnect_required',
  'strata_forbidden',
  'permission_denied',
  'strata_link_required',
]);

/** Catalog discovery is cheap and models often call it twice; it must not trip the read guard. */
const DISCOVERY_TOOLS = new Set(['strata_list_tools']);

/** Cap of ERP catalog reads in one user turn before a deterministic stop. */
export const STRATA_READ_BUDGET = 24;

const STOP_REASONS = {
  strata_rate_limited:
    'O ERP atingiu o limite de chamadas. Interrompi a consulta para evitar novas tentativas em sequência.',
  rate_limited: 'O ERP atingiu o limite de chamadas. Interrompi a consulta para evitar novas tentativas em sequência.',
  strata_reconnect_required:
    'A conexão com o Strata precisa ser renovada. Religue a conta em Conectar aplicativos e tente de novo.',
  strata_forbidden: 'O ERP negou esta consulta com as permissões atuais. Nenhuma alteração de negócio foi tentada.',
  permission_denied: 'O ERP negou esta consulta com as permissões atuais. Nenhuma alteração de negócio foi tentada.',
  strata_link_required:
    'Não há conta Strata vinculada neste aparelho. Conecte o Strata em Conectar aplicativos e tente de novo.',
  repeated_failure: 'Interrompi as consultas porque o ERP falhou duas vezes seguidas na mesma resposta.',
  repeated_query: 'Interrompi as consultas porque a mesma leitura do ERP foi pedida de novo com os mesmos argumentos.',
  read_budget: `Interrompi as consultas porque esta resposta já usou ${STRATA_READ_BUDGET} leituras do ERP. Continue em uma nova mensagem com o próximo passo.`,
};

/** Honor explicit MCP-only read requests; ERP remains the authority for permissions. */
export function isStrataReadOnlyTurn(messages) {
  const user = messages.findLast((message) => message?.role === 'user');
  const content = Array.isArray(user?.content)
    ? user.content
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('\n')
    : user?.content;
  if (typeof content !== 'string') return false;
  const text = content
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return (
    /\b(strata|erp)\b/.test(text) &&
    /\b(somente|apenas|so|exclusivamente)\b[^.!?\n]{0,60}\bmcp\b/.test(text) &&
    /\b(sem alterar|nao altere|nao alterar|somente (leitura|consultas)|apenas (leitura|consultas))\b/.test(text)
  );
}

/** Only fixed catalog reads qualify, never the generic ERP command tool. */
export function isStrataReadTool(name) {
  return typeof name === 'string' && Object.hasOwn(DIRECT_TOOLS, name.replace(/^mcp__jr-teach__/, ''));
}

function json(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, ordered(value[key])])
    );
  return value;
}

function resultOf(message) {
  const body = json(
    Array.isArray(message.content)
      ? message.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : message.content
  );
  if (Array.isArray(body?.content)) {
    const inner = json(body.content.find((part) => part.type === 'text')?.text);
    return inner && typeof inner === 'object'
      ? { ...inner, ...(body.isError === true ? { isError: true } : {}) }
      : body;
  }
  return body;
}

function trackedName(name, operation) {
  if (DISCOVERY_TOOLS.has(name)) return name;
  return operation || name;
}

function cleanSubject(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function searchSubject(args) {
  if (!args || typeof args !== 'object') return '';
  return cleanSubject(args.q || args.query || args.module || args.id || args.name || '');
}

/** True when a catalog search returned zero authorized matches. */
export function isEmptyCatalogSearch(result) {
  if (!result || typeof result !== 'object' || result.isError === true || result.ok === false) return false;
  if (typeof result.error === 'string' || result.error?.code) return false;
  for (const key of ['items', 'consultas', 'results', 'matches', 'tools', 'data']) {
    if (Array.isArray(result[key])) return result[key].length === 0;
  }
  if (result.result && typeof result.result === 'object') {
    for (const key of ['items', 'consultas', 'results', 'matches', 'data', 'rows']) {
      if (Array.isArray(result.result[key])) return result.result[key].length === 0;
    }
  }
  if (Number.isFinite(result.total) && result.total === 0) return true;
  if (Number.isFinite(result.count) && result.count === 0) return true;
  return false;
}

function notFoundMessage(subject) {
  const label = cleanSubject(subject);
  if (label) {
    return (
      `Não encontrei no Strata Certa nenhuma consulta ou processo para «${label}». ` +
      'Confira o nome com quem libera o ERP, diga outro termo ou verifique se sua conta tem permissão para esse módulo.'
    );
  }
  return (
    'Não encontrei no Strata Certa a consulta ou o processo pedido. ' +
    'Confira o nome com quem libera o ERP ou diga outro termo. Pode ser falta de permissão no módulo.'
  );
}

/** Bound a single ERP read turn without caching data or changing any ERP permission. */
export function inspectStrataTurn(messages) {
  const start = messages.findLastIndex((message) => message?.role === 'user');
  if (start < 0) return null;
  const calls = new Map();
  const completed = new Set();
  const repeats = new Map();
  let count = 0;
  let failures = 0;
  let fuelSummary = null;
  let lastSubject = '';
  for (const message of messages.slice(start + 1)) {
    for (const call of message?.tool_calls || []) {
      if (typeof call.id !== 'string' || !call.id) continue;
      const name = (call.function?.name || '').replace(/^mcp__jr-teach__/, '');
      const args = json(call.function?.arguments);
      const operation = name === 'strata_call_tool' ? args?.name : DIRECT_TOOLS[name];
      if (!READ_TOOLS.has(operation) && !DISCOVERY_TOOLS.has(name)) continue;
      const callArgs = name === 'strata_call_tool' ? args?.arguments : args;
      calls.set(call.id, {
        discovery: DISCOVERY_TOOLS.has(name),
        search: operation === 'erp.consultas.buscar',
        subject: searchSubject(callArgs) || (typeof args?.name === 'string' ? cleanSubject(args.name) : ''),
        key: `${trackedName(name, operation)}:${JSON.stringify(ordered(callArgs))}`,
      });
    }
    if (message?.role !== 'tool' || !calls.has(message.tool_call_id) || completed.has(message.tool_call_id)) continue;
    completed.add(message.tool_call_id);
    const tracked = calls.get(message.tool_call_id);
    const result = resultOf(message);
    const code = typeof result?.error === 'string' ? result.error : result?.error?.code;
    if (result?.operation === 'frota.consumo-combustivel' && result.summary?.complete === true)
      fuelSummary = result.summary;
    if (tracked.subject) lastSubject = tracked.subject;

    // Discovery can be repeated while the model finds a process tool; it is not an ERP read loop.
    if (tracked.discovery) {
      if (TERMINAL_ERRORS.has(code)) return { reason: code, count, fuelSummary, subject: lastSubject };
      if (isEmptyCatalogSearch(result))
        return { reason: 'not_found', count, fuelSummary, subject: lastSubject || 'ferramentas do MCP' };
      continue;
    }

    count += 1;
    repeats.set(tracked.key, (repeats.get(tracked.key) || 0) + 1);
    const failed = Boolean(code || result?.isError === true || result?.ok === false);
    failures = failed ? failures + 1 : 0;

    // Empty catalog search: stop with an explicit "não encontrei" instead of letting the model retry.
    if (tracked.search && isEmptyCatalogSearch(result)) {
      return { reason: 'not_found', count, fuelSummary, subject: tracked.subject || lastSubject };
    }

    const reason = TERMINAL_ERRORS.has(code)
      ? code
      : failures >= 2
        ? 'repeated_failure'
        : repeats.get(tracked.key) >= 2
          ? 'repeated_query'
          : count >= STRATA_READ_BUDGET
            ? 'read_budget'
            : null;
    if (reason) return { reason, count, fuelSummary, subject: lastSubject };
  }
  return null;
}

/** A deterministic stop cannot ask the executor to retry, sleep or switch to a browser. */
export function strataStopMessage({ reason, fuelSummary, subject }) {
  let message =
    reason === 'not_found'
      ? notFoundMessage(subject)
      : STOP_REASONS[reason] ||
        'Interrompi as consultas porque houve repetição, falha persistente ou o limite de etapas desta resposta foi atingido.';
  if (fuelSummary && Number.isFinite(fuelSummary.totalLiters) && Number.isInteger(fuelSummary.records)) {
    const format = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });
    message += `\n\nO retorno completo já confirmado do MCP contém ${format.format(fuelSummary.totalLiters)} litros em ${fuelSummary.records} registros. Fonte: frota.consumo-combustivel. Consulte as unidades e os alertas de qualidade antes de calcular médias.`;
  }
  if (reason === 'not_found') {
    return (
      message +
      '\n\nNenhuma alteração de negócio foi executada. Diga outro nome ou peça para quem libera o ERP conferir a permissão.'
    );
  }
  return (
    message +
    '\n\nNão concluí todas as etapas do relatório. Esta tentativa foi encerrada; nenhuma alteração de negócio foi executada por esta proteção.'
  );
}
