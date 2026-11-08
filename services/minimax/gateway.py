#!/usr/bin/env python3
# MiniMax gateway: troca token jrmm_ do funcionario pela chave real. Auditoria (LGPD, aviso aceito no instalador) em /data/audit/<user>/<data>.jsonl, texto truncado.
import os, json, hashlib, time, threading, http.client, ssl, sys, secrets, re, shutil, ipaddress, unicodedata
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit
DB = os.environ.get("GW_DB", "/data/tokens.json")
UP = urlsplit(os.environ.get("UPSTREAM", "https://api.minimax.io/v1"))
KEY = os.environ["MINIMAX_API_KEY"]
RPM = int(os.environ.get("GW_RPM", "60"))
lock = threading.Lock(); hits = {}
def upconn(timeout):
    if UP.scheme == "http": return http.client.HTTPConnection(UP.hostname, UP.port or 80, timeout=timeout)  # só testes
    return http.client.HTTPSConnection(UP.hostname, UP.port or 443, timeout=timeout, context=ssl.create_default_context())
_POOL = []; _POOL_LOCK = threading.Lock()
def pool_get():
    with _POOL_LOCK:
        while _POOL:
            c, t = _POOL.pop()
            if time.time() - t < 50: return c, True
            try: c.close()
            except Exception: pass
    return upconn(180), False
def pool_put(c, r):
    """Devolve a conexão ao pool só se a resposta foi lida inteira e o servidor não pediu para fechar."""
    if r is not None and r.isclosed() and not r.will_close:
        c.timeout = 180
        with _POOL_LOCK:
            if len(_POOL) < 8: _POOL.append((c, time.time())); return
    try: c.close()
    except Exception: pass
FLASH = os.environ.get("GW_DEFAULT_MODEL", "MiniMax-M3.1-Flash")
def route_model(model, internal, settings):
    """Flash é o padrão; M3 só quando o master liberar (settings allowM3). Pedidos internos sempre no Flash."""
    if not model: return model
    if internal: return FLASH
    if model.startswith("MiniMax-M3") and model != FLASH and not settings.get("allowM3"): return FLASH
    return model
def load():
    try: return json.load(open(DB))
    except FileNotFoundError: return {"users": {}}
def save(d):
    t = DB + ".tmp"; json.dump(d, open(t, "w"), indent=1); os.replace(t, DB)
def month(): return time.strftime("%Y-%m")
AUD = os.path.join(os.path.dirname(DB), "audit"); TR = int(os.environ.get("GW_AUDIT_CHARS", "2000"))
def _txt(c):
    if isinstance(c, str): return c
    if isinstance(c, list): return " ".join(p.get("text", "") if p.get("type") == "text" else "[%s]" % p.get("type", "?") for p in c if isinstance(p, dict))
    return ""
def prompt_of(j):
    try:
        ms = j.get("messages") or []
        last = next((m for m in reversed(ms) if m.get("role") == "user"), None)
        return (_txt(last.get("content")) if last else "")[:TR], len(ms), len(j.get("tools") or [])
    except Exception: return "", 0, 0
def audit(name, rec):
    try:
        dd = os.path.join(AUD, name.replace("/", "_")); os.makedirs(dd, exist_ok=True)
        with open(os.path.join(dd, time.strftime("%Y-%m-%d") + ".jsonl"), "a") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception as e: print("audit_err", type(e).__name__, flush=True)
POLICY = os.path.join(os.path.dirname(DB), "policy.json"); SETTINGS = os.path.join(os.path.dirname(DB), "settings.json")
UPD = os.path.join(os.path.dirname(DB), "updates")
def jload(p, d):
    try: return json.load(open(p))
    except Exception: return d
def vtuple(v):
    try: return tuple(int(x) for x in str(v).split("-")[0].split(".")[:3])
    except Exception: return None
def log(**k): print(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **k}), flush=True)
def find(tok):
    h = hashlib.sha256(tok.encode()).hexdigest()
    d = load()
    for n, u in d["users"].items():
        if u.get("hash") == h and not u.get("revoked"): return n, u
    return None, None
SERVED = {"tokens": 0}
def add_usage(name, pin, pout):
    SERVED["tokens"] += (pin or 0) + (pout or 0)
    with lock:
        d = load(); u = d["users"].get(name)
        if not u: return
        m = u.setdefault("usage", {}).setdefault(month(), {"in": 0, "out": 0, "req": 0})
        m["in"] += pin; m["out"] += pout; m["req"] += 1; u["lastUse"] = time.strftime("%Y-%m-%dT%H:%M:%S"); save(d)
ADM_RPM = int(os.environ.get("GW_ADMIN_RPM", "30")); ahits = {}; ADMLOG = os.path.join(os.path.dirname(DB), "admin-audit.jsonl")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,39}$")
def admin_audit(actor, action, target=None, ip=None, ok=True, **extra):
    try:
        with open(ADMLOG, "a") as f: f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "actor": actor, "action": action, "target": target, "ip": ip, "ok": ok, **extra}, ensure_ascii=False) + "\n")
    except Exception as e: print("admin_audit_err", type(e).__name__, flush=True)
def save_json(p, obj):
    if os.path.exists(p): shutil.copy(p, p + time.strftime(".bak-%Y%m%d%H%M%S"))
    t = p + ".tmp"; json.dump(obj, open(t, "w"), indent=1); os.replace(t, p)
def user_view(n, u):
    m = u.get("usage", {}).get(month(), {})
    return {"name": n, "role": u.get("role", "employee"), "status": "revogado" if u.get("revoked") else "ativo", "revoked": u.get("revoked"),
            "created": u.get("created"), "lastUse": u.get("lastUse"), "tokensMonth": m.get("in", 0) + m.get("out", 0), "requestsMonth": m.get("req", 0), "limit": u.get("limit"), "deviceBound": u.get("deviceBound") if u.get("device") else None}
# ---------------- Análise de risco (regras + MiniMax barato) e aprovação do administrador ----------------
RISK_LEVELS = {"low": 0, "medium": 1, "high": 2}
RISK_CATEGORIES = {
    "destrutivo": "Comando destrutivo (apagar em massa, formatar, desligar)",
    "apagar_arquivos": "Apagar arquivos",
    "dinheiro": "Banco, pagamento ou compra",
    "credenciais": "Senhas, chaves ou tokens",
    "mensagens": "Enviar e-mail ou mensagem",
    "exportar_dados": "Exportar ou enviar muitos dados para fora",
    "sistema": "Mudar configurações do sistema",
    "comando": "Executar comando no terminal/PowerShell",
}
CMD_TOOL_RE = re.compile(r"(^|_)(bash|shell|powershell|cmd|terminal|run_command|execute_command|exec|run_code|evaluate|eval)($|_)", re.I)
DEFAULT_RISK = {"enabled": True, "holdTimeoutSec": 240, "llm": True, "llmCanHold": False,
                "categories": {"destrutivo": "high", "apagar_arquivos": "medium", "dinheiro": "high", "credenciais": "high",
                               "mensagens": "medium", "exportar_dados": "high", "sistema": "medium"}}
RISK_RULES = [
    ("destrutivo", r"rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|\bmkfs\b|\bformat\s+[a-z]:|\bdd\s+if=|\bshutdown\b|\breboot\b|del\s+/[sq]|rd\s+/s|remove-item\b.*-recurse|drop\s+(table|database)|truncate\s+table|git\s+push\s+(-f|--force)|git\s+reset\s+--hard|:\(\)\s*\{|\|\s*(ba)?sh\b|diskpart|cipher\s+/w"),
    ("apagar_arquivos", r"\brm\s|\bunlink\b|\bdel\s|remove-item|\btrash\b|delete_file|\"(delete|remove)\w*\"|apag(ar|ue)\s+(o|os|a|as)?\s*arquivo"),
    ("dinheiro", r"\bpix\b|boleto|pagamento|pagar\b|checkout|carrinho|comprar|transfer[eê]ncia|\bted\b|cart[aã]o de cr[eé]dito|itau\.com|bradesco|santander|nubank|bb\.com\.br|caixa\.gov|paypal|mercadopago|pagseguro|stripe\.com|internet\s*banking"),
    ("credenciais", r"\bsenha|password|passwd|api[_ -]?key|secret|\btoken\b|id_rsa|\.ssh/|\.env\b|keychain|credential|cookies?\.sqlite|login data|security\s+find-generic-password"),
    ("mensagens", r"send_?(e?mail|message)|gmail.*send|enviar\s+(e-?mail|mensagem|whats)|whatsapp|smtp|sendmail|slack.*post|telegram"),
    ("exportar_dados", r"\bscp\s|rsync\s.*@|wetransfer|upload.*(drive|dropbox|onedrive)|curl\s+.*(-T|--upload-file|-F\s|--data-binary\s+@)|zip\s+-r\s+\S+\s+(~|/Users|/home|c:\\users)|tar\s+c\S*\s+\S+\s+(~|/Users|/home)|export.*(todos|all).*(clientes|contatos|customers)"),
    ("sistema", r"\bsudo\b|defaults\s+write|systemsetup|regedit|reg\s+(add|delete)|netsh|set-executionpolicy|launchctl|crontab|schtasks|chmod\s+-r|chown\s+-r|/etc/hosts|firewall|bcdedit|sc\s+(stop|delete|config)"),
]
_RISK_RE = [(c, re.compile(p, re.I)) for c, p in RISK_RULES]
def risk_settings():
    pol = jload(POLICY, {}).get("risk") or {}
    out = json.loads(json.dumps(DEFAULT_RISK)); out.update({k: v for k, v in pol.items() if k != "categories"})
    out["categories"].update({k: v for k, v in (pol.get("categories") or {}).items() if k in RISK_CATEGORIES and v in RISK_LEVELS})
    return out
def rule_risk(text, cats=None):
    """Devolve (nivel, [categorias]) só por regras determinísticas."""
    cats = cats or DEFAULT_RISK["categories"]; hit = [c for c, rx in _RISK_RE if rx.search(text or "")]
    lvl = max([cats.get(c, "low") for c in hit], key=lambda x: RISK_LEVELS[x], default="low")
    return lvl, hit
_llm_cache = {}
def llm_risk(text):
    """Classificação + resumo em pt-BR numa chamada curta ao MiniMax (cacheada; fora da cota do funcionário).
    Devolve {"nivel": low|medium|high|None, "resumo": str, "motivo": str} ou None."""
    if not text.strip(): return None
    h = hashlib.sha256(text[:1500].encode()).hexdigest()
    if h in _llm_cache: return _llm_cache[h]
    body = json.dumps({"model": os.environ.get("GW_RISK_MODEL", FLASH), "max_tokens": 300, "temperature": 0,
        "messages": [{"role": "system", "content": "Voce avalia pedidos feitos por funcionarios a um assistente de computador de uma empresa. Responda SOMENTE um JSON, em portugues do Brasil: {\"risco\":\"low|medium|high\",\"resumo\":\"uma frase curta dizendo o que a pessoa pediu\",\"motivo\":\"motivo curto do risco\"}. high = apagar dados, mexer com dinheiro/banco, senhas, enviar dados para fora, mudar o sistema. medium = enviar mensagens, apagar poucos arquivos, instalar programas. low = o resto."},
                     {"role": "user", "content": text[:1500]}]}).encode()
    out = None
    try:
        c = upconn(20)
        c.request("POST", UP.path.rstrip("/") + "/chat/completions", body=body, headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
        r = c.getresponse(); d = json.loads(r.read()); c.close()
        us = d.get("usage") or {}; SERVED["tokens"] += (us.get("prompt_tokens") or 0) + (us.get("completion_tokens") or 0)
        t = re.sub(r"<think>.*?</think>", "", ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or "", flags=re.S).strip()
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            j = json.loads(m.group(0)); lv = str(j.get("risco", "")).lower()
            out = {"nivel": lv if lv in RISK_LEVELS else None, "resumo": str(j.get("resumo") or "")[:200], "motivo": str(j.get("motivo") or "")[:160]}
        else:
            lv = next((w for w in ("high", "medium", "low") if w in t.lower()), None)
            out = {"nivel": lv, "resumo": "", "motivo": ""}
    except Exception as e: print("risk_llm_err", type(e).__name__, flush=True)
    if len(_llm_cache) > 5000: _llm_cache.clear()
    _llm_cache[h] = out
    return out
INTERNAL_RE = re.compile(r"^(you are (the|a|an) |you have no tools|generate (a|the) |write (a|the) (short )?(title|summary)|summari[sz]e |return (only )?json|reply with )|card\s*=\s*true|<system|\bCAPTURE step\b", re.I)
APP_MARKER_RE = re.compile(r"^You are the CAPTURE step of a memory system|\bcard\s*=\s*true\b")
def is_internal(cp, ntools):
    """Pedidos internos do app: marcadores fixos do próprio app, ou sem ferramentas E com texto de sistema.
    Um pedido do funcionário (com ferramentas) nunca vira interno por começar com "You are a…" (o opencode
    põe o prompt de sistema antes do texto do usuário)."""
    head = (cp or "")[:400]
    if APP_MARKER_RE.search(head): return True
    return ntools == 0 and bool(INTERNAL_RE.search(head))
def short_ask(cp, llm=None):
    if llm and llm.get("resumo"): return llm["resumo"]
    first = re.split(r"(?<=[.!?])\s", cp, 1)[0]
    return (first[:160] + "…") if len(first) > 160 else first
def reason_of(cats, llm=None):
    if llm and llm.get("motivo"): return llm["motivo"]
    return ", ".join(RISK_CATEGORIES.get(c, c) for c in cats) or "avaliado pela IA"
def combine_risk(rule_lvl, llm_lvl, settings):
    if isinstance(llm_lvl, dict): llm_lvl = llm_lvl.get("nivel")
    if llm_lvl == "high" and not settings.get("llmCanHold"): llm_lvl = "medium"
    return max([rule_lvl, llm_lvl or "low"], key=lambda x: RISK_LEVELS[x])
def clean_prompt(t):
    t = re.sub(r"<(system[-_]reminder|SYSTEM_MESSAGE|system)[^>]*>.*?</\1>", " ", t or "", flags=re.S | re.I)
    t = re.sub(r"\s+", " ", t).strip()
    return t
def fold_text(s):
    n = unicodedata.normalize("NFD", s or "")
    return "".join(c for c in n if not unicodedata.category(c).startswith("M")).lower()
def user_ask(text):
    """Último parágrafo do que a pessoa escreveu (o prompt de sistema vem antes, separado por linha em branco)."""
    parts = re.split(r"\n\s*\n", (text or "").strip())
    last = (parts[-1] if parts else "").strip()
    return last[-800:] if len(last) > 800 else last
OMB_PERSONA_RE = re.compile(r"^\s*You are [^\n]{0,120}?a personal bot in OpenMausBot", re.I)
NO_ASK_RE = re.compile(r"n[aã]o (houve|h[aá]) (nenhum )?pedido|sem (solicitar|pedido)|nenhum pedido|n[aã]o pediu", re.I)
def risk_text(pr):
    """Só o que a pessoa escreveu: tira o prompt de sistema do bot OpenMausBot que vem no início da mensagem."""
    t = pr or ""
    if not OMB_PERSONA_RE.search(t): return t
    m = list(re.finditer(r"Current time when this message was sent:[^\n]*\n\s*\n", t))
    t = t[m[-1].end():] if m else user_ask(t)
    return "" if OMB_PERSONA_RE.search(t) else t
def classify_toolset(text):
    t = re.sub(r"\s+", " ", fold_text(user_ask(text))).strip()
    if not t: return "chat"
    url = re.search(r"https?://\S", t)
    site = re.search(r"\b(site|chrome|navegador|gmail|pagina|http|g1|youtube|instagram|internet banking)\b", t)
    open_verb = re.search(r"\b(abre|abrir|abra|acessa|acessar|entra|entrar)\b", t)
    interact = re.search(r"\b(login|logar|loga|clica|clique|preenche|preencha|formulario|cadastr)\b", t)
    if url or (open_verb and site) or (interact and (site or url)) or re.search(r"\b(no chrome|no navegador|no site)\b", t): return "browser"
    win_app = re.search(r"\b(excel|word|powerpoint|notepad|bloco de notas|calculadora|paint|outlook|teams|explorador de arquivos|menu iniciar|area de trabalho)\b", t)
    win_act = re.search(r"\b(abre|abrir|abra|fecha|feche|clica|clique|digita|controle|controla|na tela|no pc|no computador)\b", t)
    if win_app and win_act: return "windows"
    path = re.search(r"[a-z]:\\", t); ext = re.search(r"\.(xlsx|docx|pdf|csv|txt|json)\b", t)
    file_noun = re.search(r"\b(arquivo|pasta|diretorio)\b", t) or path or ext
    file_verb = re.search(r"\b(le|leia|ler|edita|edite|editar|cria|crie|criar|salva|salve|apaga|move|copia|abre o arquivo|abre a pasta)\b", t)
    shell = re.search(r"\b(terminal|powershell|prompt de comando|cmd|script)\b", t) or re.search(r"\b(roda|rode|executa|execute)\b.{0,24}\b(comando|script)\b", t)
    if (file_noun and (file_verb or path or re.search(r"\.(xlsx|docx|pdf|csv|txt)\b", t))) or shell: return "files"
    if (re.search(r"\b(vai chover|previsao do tempo|temperatura|clima|chuva|chover|umidade|noticias|manchete|cotacao|dolar|euro|bitcoin|ibovespa)\b", t)
        or re.search(r"\btempo\b.{0,24}\b(em|hoje|amanha)\b", t)
        or re.search(r"\b(pesquisa|pesquise|busca|busque|procure)\b", t)): return "info"
    return "chat"
def browser_mode_of(messages):
    mode = "local"
    for m in messages or []:
        if not isinstance(m, dict): continue
        for hit in re.finditer(r"JR_BROWSER=(app|local)", _txt(m.get("content"))): mode = hit.group(1)
    return mode
_BROWSER_KEEP = ("screenshot", "navigate", "snapshot", "click", "type", "fill", "press", "select", "tabs", "wait", "handle_dialog", "hover", "file_upload", "close", "scroll")
_BROWSER_DROP = ("console", "network", "run_code", "evaluate", "install", "resize", "pdf", "drag", "tracing", "mouse", "verify", "generate")
_FILES_RE = re.compile(r"(?:^|_)(?:read|edit|write|apply_patch|bash|shell|glob|grep|list|skill)$")
_INFO_RE = re.compile(r"(?:^|_)(?:websearch|webfetch|web_search)$")
INFO_RESULT_CHARS = 8000
TOOL_RESULT_CHARS = 8000
PROMPT_TOKEN_BUDGET = 30000
def tool_allowed(name, toolset, browser):
    return True  # repassa todas as ferramentas do cliente, sem exceção
    # Playwright e windows-mcp sempre ativos (navegação/leitura); o risco é avaliado nas chamadas.
    if "windows_" in n or "windows-" in n: return True
    if "browser" in n and not (any(d in n for d in _BROWSER_DROP) or re.search(r"(^|_)eval($|_)", n)) and any(k in n for k in _BROWSER_KEEP):
        return ("agent_browser" in n) == (browser == "app")
    if toolset == "chat": return False
    if toolset == "info": return "browser" not in n and bool(_INFO_RE.search(n))
    if toolset == "browser":
        if "browser" not in n: return False
        if browser == "app":
            if "agent_browser" not in n: return False
        elif "agent_browser" in n: return False
        if any(d in n for d in _BROWSER_DROP) or re.search(r"(^|_)eval($|_)", n): return False
        return any(k in n for k in _BROWSER_KEEP)
    if toolset == "windows": return "windows_" in n or "windows-" in n or "_windows_" in n
    if toolset == "files": return "browser" not in n and bool(_FILES_RE.search(n))
    return False
def content_chars(content):
    if isinstance(content, str): return len(content)
    try: return len(json.dumps(content, ensure_ascii=False))
    except Exception: return 0
def _stubbed(content):
    return isinstance(content, str) and content.startswith("[saída antiga omitida,")
def cap_content(content, limit):
    if _stubbed(content) or content_chars(content) <= limit: return content, False
    if isinstance(content, str):
        note = "\n[... cortado: %d caracteres omitidos ...]\n" % (len(content) - limit)
        keep = max(0, limit - len(note)); head = keep * 2 // 3
        return content[:head] + note + content[len(content) - (keep - head):], True
    if isinstance(content, list):
        budget = limit; out = []; changed = False
        for p in content:
            if isinstance(p, dict) and isinstance(p.get("text"), str) and len(p["text"]) > budget:
                out.append(dict(p, text=(p["text"][:budget] + "\n[cortado]") if budget else "[cortado]")); budget = 0; changed = True
            else:
                out.append(p)
                if isinstance(p, dict) and isinstance(p.get("text"), str): budget -= len(p["text"])
        return out, True if changed or content_chars(out) < content_chars(content) else False
    try: raw = json.dumps(content, ensure_ascii=False)
    except Exception: return content, False
    return raw[:limit] + "\n[cortado]", True
def estimate_tokens(j):
    chars = 0
    for m in j.get("messages") or []:
        chars += content_chars(m.get("content"))
        if m.get("tool_calls"): chars += content_chars(m.get("tool_calls"))
    chars += content_chars(j.get("tools") or [])
    return chars // 4
def prompt_parts(j):
    """Tamanho de cada parte, sem o texto."""
    parts = []
    for i, m in enumerate(j.get("messages") or []):
        if len(parts) >= 60: break
        content = m.get("content"); role = m.get("role")
        if isinstance(content, list):
            for p in content:
                if len(parts) >= 60: break
                parts.append({"i": i, "role": role, "type": (p.get("type") if isinstance(p, dict) else None) or "text", "chars": content_chars(p)})
        else:
            parts.append({"i": i, "role": role, "type": "text", "chars": content_chars(content)})
    tools = j.get("tools") or []
    parts.append({"role": "tools", "type": "schemas", "chars": content_chars(tools), "n": len(tools)})
    return parts
def cached_tokens_of(usage):
    us = usage or {}
    return ((us.get("prompt_tokens_details") or {}).get("cached_tokens") or us.get("cache_read_input_tokens") or 0) or 0
def measure_ctx(j):
    ms = j.get("messages") or []; tools = j.get("tools") or []
    return {"sysChars": sum(content_chars(m.get("content")) for m in ms if m.get("role") == "system"),
            "toolsChars": content_chars(tools),
            "toolResultChars": sum(content_chars(m.get("content")) for m in ms if m.get("role") == "tool"),
            "histChars": sum(content_chars(m.get("content")) for m in ms if m.get("role") in ("user", "assistant")),
            "prefixHash": hashlib.sha256((json.dumps(ms[:1], ensure_ascii=False) + json.dumps(tools, ensure_ascii=False)).encode()).hexdigest()[:12],
            "tools": [((t.get("function") or {}).get("name") or "")[:60] for t in tools],
            "parts": prompt_parts(j)}
SNAP_OLD = "[snapshot antigo removido]"
def _tool_names(messages):
    out = {}
    for m in messages:
        if isinstance(m, dict) and m.get("role") == "assistant":
            for tc in m.get("tool_calls") or []:
                if isinstance(tc, dict): out[tc.get("id")] = ((tc.get("function") or {}).get("name") or "").lower()
    return out
def _is_snapshot(m, names):
    if "snapshot" in names.get(m.get("tool_call_id"), ""): return True
    t = _txt(m.get("content"))[:3000]
    return "Page Snapshot" in t or "```yaml" in t
def prune_snapshots(messages):
    """Mantém só o último snapshot do navegador inteiro (determinístico: os antigos viram sempre o mesmo texto)."""
    names = _tool_names(messages)
    idx = [i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "tool" and m.get("content") != SNAP_OLD and _is_snapshot(m, names)]
    for i in idx[:-1]: messages[i]["content"] = SNAP_OLD
    return bool(idx[:-1])
def sticky_toolsets(messages, window=8):
    """Se a tarefa em andamento usou ferramentas, mantém esses grupos mesmo com 'sim, pode'/'ok'."""
    last_user = max([i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "user"], default=len(messages))
    recent = [m for m in messages[max(0, last_user - window):] if isinstance(m, dict)]
    out = []
    for m in recent:
        for tc in m.get("tool_calls") or []:
            n = ((tc.get("function") or {}).get("name") or "").lower() if isinstance(tc, dict) else ""
            ts = "browser" if "browser" in n else "windows" if ("windows_" in n or "windows-" in n) else "files" if _FILES_RE.search(n) else "info" if _INFO_RE.search(n) else None
            if ts and ts not in out: out.append(ts)
    return out
def apply_jr_context(j, policy=None):
    """Prune only completed turns; active tool results must remain complete for reports."""
    changed = False
    messages = j.get("messages") or []
    last_user = max((i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "user"), default=-1)
    ask = ""
    for m in reversed(messages):
        if isinstance(m, dict) and m.get("role") == "user": ask = _txt(m.get("content")); break
    toolset = classify_toolset(ask)
    browser = browser_mode_of(messages)
    sets = [toolset] + [x for x in sticky_toolsets(messages) if x != toolset]
    if toolset == "chat" and len(sets) > 1: toolset = sets[1]
    if prune_snapshots(messages[:max(0, last_user)]): changed = True
    tools = j.get("tools")
    if isinstance(tools, list):
        kept = [t for t in tools if isinstance(t, dict) and any(tool_allowed((t.get("function") or {}).get("name"), ts, browser) for ts in sets)]
        if len(kept) != len(tools):
            if kept: j["tools"] = kept
            else: j.pop("tools", None); j.pop("tool_choice", None)
            changed = True
    prune = (policy or {}).get("contextPruning") is not False
    for i, m in enumerate(messages):
        if not isinstance(m, dict) or m.get("role") != "tool" or i > last_user: continue
        limit = INFO_RESULT_CHARS if toolset == "info" else (TOOL_RESULT_CHARS if prune else None)
        if limit is None: continue
        content, did = cap_content(m.get("content"), limit)
        if did: m["content"] = content; changed = True
    if prune:
        while estimate_tokens(j) > PROMPT_TOKEN_BUDGET:
            idxs = [i for i, m in enumerate(messages) if i < last_user and isinstance(m, dict) and m.get("role") == "tool"]
            if not idxs: break
            target = next((i for i in idxs if not _stubbed(messages[i].get("content"))), None)
            if target is None: break
            n = content_chars(messages[target].get("content"))
            messages[target]["content"] = "[saída antiga omitida, %d caracteres]" % n
            changed = True
    return {"changed": changed, "toolset": toolset, "toolsKept": [((t.get("function") or {}).get("name") or "")[:60] for t in (j.get("tools") or [])], "browser": browser}
_ACT = [
    (r"^(bash|shell|run_command|execute|terminal|powershell)", lambda a: "Executou o comando: " + str(a.get("command") or a.get("cmd") or a.get("script") or "")[:200]),
    (r"browser_navigate|navigate|open_url|agent_browser_open", lambda a: "Abriu o site " + str(a.get("url") or "")[:200]),
    (r"browser_click|agent_browser_click|click", lambda a: "Clicou em " + str(a.get("element") or a.get("ref") or a.get("selector") or "um elemento")[:120]),
    (r"browser_type|agent_browser_(fill|type)|fill|type", lambda a: "Digitou um texto" + (" em " + str(a.get("element"))[:80] if a.get("element") else "")),
    (r"^(write|create_file|edit|apply_patch|patch)", lambda a: "Alterou o arquivo " + str(a.get("filePath") or a.get("path") or a.get("file_path") or "")[:200]),
    (r"^(read|view|cat)", lambda a: "Leu o arquivo " + str(a.get("filePath") or a.get("path") or "")[:200]),
    (r"^(glob|grep|list|ls|find|search)", lambda a: "Procurou arquivos/textos: " + str(a.get("pattern") or a.get("path") or a.get("query") or "")[:120]),
    (r"webfetch|fetch|http", lambda a: "Acessou " + str(a.get("url") or "")[:200]),
    (r"websearch|search", lambda a: "Pesquisou na web: " + str(a.get("query") or "")[:120]),
    (r"todo", lambda a: "Atualizou a lista de tarefas"),
    (r"snapshot|screenshot", lambda a: "Olhou a tela/página"),
]
def describe_action(name, args):
    try: a = json.loads(args) if isinstance(args, str) and args.strip().startswith("{") else {}
    except Exception: a = {}
    n = (name or "").split("_", 1)[-1] if (name or "").startswith(("mcp_", "navegador_", "chrome_")) else (name or "")
    for pat, fn in _ACT:
        if re.search(pat, n, re.I) or re.search(pat, name or "", re.I):
            try: return fn(a)
            except Exception: break
    return "Usou a ferramenta " + (name or "?")
PENDING = {}; PLOCK = threading.Lock(); PROMPT_DECISIONS = {}
RISKLOG = os.path.join(os.path.dirname(DB), "risk-decisions.jsonl")
def risk_log(rec):
    try:
        with open(RISKLOG, "a") as f: f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception: pass
def hold_for_approval(user, actions, level, cats, prompt, timeout, keepalive=None, pediu="", motivo=""):
    """Bloqueia até o master aprovar/negar ou o prazo acabar. Devolve (aprovado, motivo)."""
    pid = secrets.token_hex(6); ev = threading.Event()
    if risk_settings().get("hold") is False:
        # Aprovações desligadas: só registra para auditoria, não segura nem nega.
        risk_log({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "id": pid, "user": user, "risk": level, "categories": cats, "pediu": pediu or (actions[0].get("resumo") if actions else ""), "motivo": motivo or reason_of(cats), "actions": [x.get("resumo") for x in actions[:10]], "approved": True, "reason": "aprovacoes desligadas (so registro)", "by": "auto"})
        return True, ""
    item = {"id": pid, "user": user, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "risk": level, "categories": cats, "prompt": prompt[:400],
            "actions": actions[:10], "expires": int(time.time() + timeout), "event": ev, "decision": None,
            "quem": user, "pediu": pediu or (actions[0].get("resumo") if actions else ""), "motivo": motivo or reason_of(cats)}
    with PLOCK: PENDING[pid] = item
    end = time.time() + timeout
    try:
        while not ev.wait(min(10, max(0.1, end - time.time()))):
            if time.time() >= end: break
            if keepalive:
                try: keepalive()
                except Exception: break
    finally:
        with PLOCK: PENDING.pop(pid, None)
    dec = item["decision"] or {"approved": False, "reason": "sem resposta do administrador no prazo", "by": None}
    risk_log({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "id": pid, "user": user, "risk": level, "categories": cats, "pediu": item["pediu"], "motivo": item["motivo"], "actions": [x.get("resumo") for x in actions[:10]], **dec})
    return dec["approved"], dec.get("reason") or ""
def pending_view(user=None):
    with PLOCK:
        return [{k: v for k, v in it.items() if k not in ("event", "decision")} for it in PENDING.values() if user is None or it["user"] == user]
def decide(pid, approved, reason, by):
    with PLOCK:
        it = PENDING.get(pid)
        if not it: return False
        it["decision"] = {"approved": bool(approved), "reason": (reason or "")[:300], "by": by}; it["event"].set()
    return True
def prompt_llm_level(pr):
    """Nível que o classificador (em segundo plano) deu para o pedido, se já respondeu."""
    try: return (_llm_cache.get(hashlib.sha256(clean_prompt(pr)[:1500].encode()).hexdigest()) or {}).get("nivel")
    except Exception: return None
def assess_actions(tcalls, settings, pr=None):
    acts = []; top = "low"; allc = []
    if pr and settings.get("llmCanHold") and prompt_llm_level(risk_text(pr)) == "high": top = "high"; allc.append("ia")
    for nm, args in tcalls[:20]:
        lvl, cats = rule_risk((nm or "") + " " + (args or ""), settings["categories"])
        if CMD_TOOL_RE.search(nm or ""): lvl = "high"; cats = cats + ["comando"]
        acts.append({"ferramenta": nm, "resumo": describe_action(nm, args), "risco": lvl, "categorias": cats, "detalhes": (args or "")[:600]})
        allc += cats; top = max([top, lvl], key=lambda x: RISK_LEVELS[x])
    return acts, top, sorted(set(allc))
def blocked_message(reason):
    return "⛔ Ação bloqueada pelo administrador da JR" + (": " + reason if reason else "") + ". Não tente de novo nem por outro caminho; explique ao usuário que a ação foi negada."
# ---------------- Vínculo com o computador e trava de rede ----------------
DEVICE_RE = re.compile(r"^[a-f0-9]{64}$")
def client_ip(h):
    return (h.headers.get("X-Forwarded-For") or h.client_address[0]).split(",")[0].strip()
def ip_allowed(ip, allow):
    try: a = ipaddress.ip_address(ip)
    except ValueError: return False
    for c in allow or []:
        try:
            if a in ipaddress.ip_network(str(c).strip(), strict=False): return True
        except ValueError: continue
    return False
def network_refusal(name, u, ip):
    net = jload(POLICY, {}).get("network") or {}
    if not net.get("enabled"): return None
    if u.get("role") == "master" and net.get("exemptMaster", True): return None
    if ip_allowed(ip, net.get("allow")): return None
    return "Acesso permitido só pela rede da empresa. Conecte-se à rede da JR e tente de novo."
def device_check(name, u, dev, ip):
    """None = ok (vincula no primeiro uso); senão a mensagem de recusa. O app manda o hash do computador em X-JR-Device."""
    st = jload(SETTINGS, {})
    if u.get("role") == "master" and not st.get("bindMaster"): return None
    if st.get("deviceBinding", True) is False: return None
    if not dev or not DEVICE_RE.match(dev): return "Atualize o JR Santa Fé Bot: esta versão não identifica o computador."
    bound = u.get("device")
    if not bound:
        with lock:
            d = load(); uu = d["users"].get(name)
            if uu is not None and not uu.get("device"):
                uu["device"] = dev; uu["deviceBound"] = time.strftime("%Y-%m-%dT%H:%M:%S"); save(d)
        log(ev="device_bound", user=name); return None
    if bound == dev: return None
    rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "evento": "outro_computador", "ip": ip, "risco": "high", "categorias": ["dispositivo"],
           "prompt": "", "resposta": "", "acoes": [{"ferramenta": "login", "resumo": "Tentou usar o código em outro computador (recusado)", "risco": "high", "categorias": ["dispositivo"], "detalhes": "dispositivo " + dev[:12] + "…"}]}
    audit(name, rec); risk_log({**rec, "user": name})
    log(ev="device_mismatch", user=name, ip=ip)
    return "Este código está vinculado a outro computador. Peça ao administrador da JR para liberar."
# ---------------- Capacidade real do plano: % da cota MiniMax x tokens servidos ----------------
QUOTALOG = os.path.join(os.path.dirname(DB), "quota-samples.jsonl")
def plan_remains():
    """Lê o % restante do plano (janela de 5 h e semanal). Nunca registra a chave."""
    c = upconn(20)
    c.request("GET", "/v1/api/openplatform/coding_plan/remains", headers={"Authorization": "Bearer " + KEY})
    d = json.loads(c.getresponse().read()); c.close()
    g = next((m for m in d.get("model_remains") or [] if m.get("model_name") == "general"), None)
    if not g: return None
    return {"pct5h": 100 - int(g.get("current_interval_remaining_percent", 100)), "pctWeek": 100 - int(g.get("current_weekly_remaining_percent", 100)),
            "win5hStart": g.get("start_time"), "weekStart": g.get("weekly_start_time")}
def quota_sample():
    try:
        q = plan_remains()
        if not q: return
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "served": SERVED["tokens"], **q}
        with open(QUOTALOG, "a") as f: f.write(json.dumps(rec) + "\n")
        log(ev="quota", **rec)
    except Exception as e: print("quota_err", type(e).__name__, flush=True)
def capacity_estimate(samples):
    """Tokens por 1% de cada janela, a partir de pares de amostras dentro da mesma janela (desde o início do processo)."""
    est = {}
    for key, win in (("pct5h", "win5hStart"), ("pctWeek", "weekStart")):
        tok = pct = 0
        for a, b in zip(samples, samples[1:]):
            if a.get(win) != b.get(win) or b["served"] < a["served"]: continue
            dp = b[key] - a[key]
            if dp > 0: tok += b["served"] - a["served"]; pct += dp
        est[key] = {"tokensPer1pct": int(tok / pct) if pct else None, "totalEstimate": int(tok / pct * 100) if pct else None, "pctObserved": pct, "tokensObserved": tok,
                    "confiavel": pct >= 10}
    return est
def quota_loop():
    while True:
        quota_sample(); time.sleep(int(os.environ.get("GW_QUOTA_EVERY", "600")))
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, *a): pass
    def err(self, code, msg):
        b = json.dumps({"error": {"message": msg, "type": "gateway"}}).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def ok(self, obj, code=200):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def handle_admin(self, method, path):
        ip = self.headers.get("X-Forwarded-For", self.client_address[0])
        now = time.time()
        with lock:
            q = [t for t in ahits.get(ip, []) if now - t < 60]
            if len(q) >= ADM_RPM: ahits[ip] = q; return self.err(429, "muitas requisicoes, aguarde")
            q.append(now); ahits[ip] = q
        auth = self.headers.get("Authorization", ""); tok = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        actor, u = find(tok) if tok.startswith("jrmm_") else (None, None)
        if not actor: admin_audit(None, "auth", path, ip, False); return self.err(401, "codigo invalido ou revogado")
        if u.get("role") != "master": admin_audit(actor, "forbidden", path, ip, False); return self.err(403, "apenas o codigo master pode administrar")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536: return self.err(413, "corpo grande demais")
        try: body = json.loads(self.rfile.read(n)) if n else {}
        except Exception: return self.err(400, "json invalido")
        if not isinstance(body, dict): return self.err(400, "json invalido")
        sp = urlsplit(path); parts = [p for p in sp.path.split("/") if p][1:]
        qs = dict(x.split("=", 1) for x in sp.query.split("&") if "=" in x)
        def lim(v):
            if v in (None, "", 0, "0"): return None
            v = int(v)
            if v < 0 or v > 10**11: raise ValueError
            return v
        try:
            if parts == ["me"] and method == "GET": return self.ok({"name": actor, "role": "master"})
            if parts == ["users"] and method == "GET":
                return self.ok({"month": month(), "users": [user_view(k, v) for k, v in sorted(load()["users"].items())]})
            if parts == ["users"] and method == "POST":
                nm = str(body.get("name", "")).strip().lower()
                if not NAME_RE.match(nm): return self.err(400, "nome invalido (use a-z, 0-9, ponto, hifen; 2 a 40)")
                role = body.get("role", "employee")
                if role not in ("employee", "admin"): return self.err(400, "papel invalido")
                with lock:
                    d = load(); U = d["users"]
                    if nm in U and not U[nm].get("revoked"): return self.err(409, "ja existe: " + nm)
                    code = "jrmm_" + secrets.token_urlsafe(32)
                    U[nm] = {"hash": hashlib.sha256(code.encode()).hexdigest(), "created": time.strftime("%F"), "usage": U.get(nm, {}).get("usage", {}),
                             "limit": lim(body.get("limit", os.environ.get("GW_DEFAULT_LIMIT"))), "role": role, "createdBy": actor}
                    save(d); os.chmod(DB, 0o600)
                admin_audit(actor, "create", nm, ip, limit=U[nm]["limit"], role=role)
                return self.ok({"user": user_view(nm, U[nm]), "code": code}, 201)
            if len(parts) == 3 and parts[0] == "users" and method == "POST" and parts[2] in ("revoke", "reactivate", "limit", "unbind"):
                nm = parts[1]
                with lock:
                    d = load(); U = d["users"]
                    if nm not in U: return self.err(404, "usuario nao encontrado")
                    if U[nm].get("role") == "master" and parts[2] == "revoke": return self.err(400, "o codigo master nao pode ser revogado pelo app (use mmx-gw no servidor)")
                    if parts[2] == "revoke": U[nm]["revoked"] = time.strftime("%F")
                    elif parts[2] == "reactivate": U[nm].pop("revoked", None)
                    elif parts[2] == "unbind": U[nm].pop("device", None); U[nm].pop("deviceBound", None)
                    else: U[nm]["limit"] = lim(body.get("limit"))
                    save(d)
                admin_audit(actor, parts[2], nm, ip, limit=U[nm].get("limit"))
                return self.ok({"user": user_view(nm, U[nm])})
            if len(parts) >= 2 and parts[0] == "audit" and method == "GET":
                nm = parts[1]
                if not NAME_RE.match(nm): return self.err(400, "nome invalido")
                dd = os.path.join(AUD, nm); days = sorted((x[:-6] for x in os.listdir(dd) if x.endswith(".jsonl")), reverse=True) if os.path.isdir(dd) else []
                day = qs.get("day") or (days[0] if days else time.strftime("%F"))
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", day): return self.err(400, "data invalida")
                recs = []; p = os.path.join(dd, day + ".jsonl")
                if os.path.exists(p):
                    for l in open(p):
                        try: recs.append(json.loads(l))
                        except Exception: pass
                admin_audit(actor, "view_audit", nm, ip, day=day)
                return self.ok({"name": nm, "day": day, "days": days[:90], "records": recs[-500:]})
            if parts == ["policy"]:
                if method == "GET": return self.ok({"policy": jload(POLICY, {})})
                pol = body.get("policy")
                if not isinstance(pol, dict): return self.err(400, "politica deve ser um objeto JSON")
                save_json(POLICY, pol); admin_audit(actor, "policy_set", None, ip, keys=sorted(pol.keys())[:30])
                return self.ok({"policy": pol})
            if parts == ["minversion"]:
                st = jload(SETTINGS, {})
                if method == "GET": return self.ok({"minVersion": st.get("minVersion")})
                v = body.get("minVersion")
                if v in (None, "", "off", "0"): v = None
                elif vtuple(v) is None: return self.err(400, "versao invalida (ex.: 0.1.120)")
                st["minVersion"] = v; save_json(SETTINGS, st); admin_audit(actor, "minversion_set", None, ip, minVersion=v)
                return self.ok({"minVersion": v})
            if parts == ["capacity"] and method == "GET":
                samples = []
                if os.path.exists(QUOTALOG):
                    for x in open(QUOTALOG).read().splitlines()[-2000:]:
                        try: samples.append(json.loads(x))
                        except Exception: pass
                return self.ok({"samples": samples[-48:], "estimate": capacity_estimate(samples), "plan": None,
                                "nota": "O nome do plano não vem na API de cota da MiniMax; só o % usado."})
            if parts == ["pending"] and method == "GET": return self.ok({"pending": pending_view()})
            if len(parts) == 3 and parts[0] == "pending" and method == "POST" and parts[2] in ("approve", "deny"):
                ok = decide(parts[1], parts[2] == "approve", str(body.get("reason", ""))[:300], actor)
                admin_audit(actor, "risk_" + parts[2], parts[1], ip, ok=ok, reason=str(body.get("reason", ""))[:300])
                return self.ok({"ok": True}) if ok else self.err(404, "pedido nao encontrado (ja decidido ou expirado)")
            if parts == ["risk"] and method == "GET":
                lines = open(RISKLOG).read().splitlines()[-300:] if os.path.exists(RISKLOG) else []
                recs = []
                for x in lines:
                    try: recs.append(json.loads(x))
                    except Exception: pass
                return self.ok({"records": recs[::-1]})
            if parts == ["log"] and method == "GET":
                lines = open(ADMLOG).read().splitlines()[-200:] if os.path.exists(ADMLOG) else []
                return self.ok({"records": [json.loads(x) for x in lines]})
        except (ValueError, TypeError): return self.err(400, "valor invalido")
        return self.err(404, "rota de administracao desconhecida")
    def do_GET(self): self.handle_any("GET")
    def do_POST(self): self.handle_any("POST")
    def handle_any(self, method):
        path = self.path; t_in = time.time()
        if path == "/healthz": return self.err(200, "ok")
        if path.startswith("/updates/") and method == "GET":
            fn = os.path.basename(urlsplit(path).path)
            fp = os.path.join(UPD, fn)
            if not fn or fn.startswith(".") or not os.path.isfile(fp): return self.err(404, "not found")
            ct = "text/yaml" if fn.endswith(".yml") else "application/octet-stream"
            size = os.path.getsize(fp)
            self.send_response(200); self.send_header("Content-Type", ct); self.send_header("Content-Length", str(size)); self.send_header("Cache-Control", "no-cache"); self.end_headers()
            with open(fp, "rb") as f:
                while True:
                    ch = f.read(1 << 16)
                    if not ch: break
                    self.wfile.write(ch)
            return
        if path.startswith("/admin/"): return self.handle_admin(method, path)
        if not path.startswith("/v1/"): return self.err(404, "not found")
        auth = self.headers.get("Authorization", "")
        tok = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        name, u = find(tok) if tok.startswith("jrmm_") else (None, None)
        if not name: log(ev="deny", path=path); return self.err(401, "codigo invalido ou revogado")
        mv = jload(SETTINGS, {}).get("minVersion"); cv = self.headers.get("X-JR-Bot-Version")
        if mv and cv and vtuple(cv) is not None and vtuple(mv) is not None and vtuple(cv) < vtuple(mv):
            log(ev="outdated", user=name, version=cv); return self.err(426, "Versao desatualizada do JR Santa Fe Bot (%s). Atualize para %s ou mais nova." % (cv, mv))
        ip = client_ip(self)
        why = network_refusal(name, u, ip)
        if why: log(ev="network_block", user=name, ip=ip); return self.err(423, why)
        why = device_check(name, u, self.headers.get("X-JR-Device", "").strip().lower(), ip)
        if why: return self.err(409, why)
        if path == "/v1/jr/policy":
            bd = json.dumps(jload(POLICY, {})).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(bd))); self.end_headers(); self.wfile.write(bd)
            return
        if path == "/v1/jr/pending":
            bd = json.dumps({"pending": [{"id": x["id"], "ts": x["ts"], "risk": x["risk"], "pediu": x.get("pediu"), "motivo": x.get("motivo"), "actions": [a.get("resumo") for a in x["actions"]], "expires": x["expires"]} for x in pending_view(name)]}, ensure_ascii=False).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(bd))); self.end_headers(); self.wfile.write(bd)
            return
        if path == "/v1/jr/usage":
            mm = month(); x = (u.get("usage") or {}).get(mm, {}); y, mo = map(int, mm.split("-"))
            reset = "%04d-%02d-01" % (y + (mo == 12), 1 if mo == 12 else mo + 1)
            bd = json.dumps({"name": name, "month": mm, "used": x.get("in", 0) + x.get("out", 0), "in": x.get("in", 0), "out": x.get("out", 0),
                             "requests": x.get("req", 0), "limit": u.get("limit"), "resetDate": reset}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(bd))); self.end_headers(); self.wfile.write(bd)
            return
        if path == "/v1/jr/whoami":
            bd = json.dumps({"name": name, "role": u.get("role", "employee")}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(bd))); self.end_headers(); self.wfile.write(bd)
            return
        now = time.time()
        with lock:
            q = [t for t in hits.get(name, []) if now - t < 60]
            if len(q) >= RPM: hits[name] = q; return self.err(429, "muitas requisicoes, aguarde")
            q.append(now); hits[name] = q
        lim = u.get("limit")
        m = u.get("usage", {}).get(month(), {})
        if lim and m.get("in", 0) + m.get("out", 0) >= lim:
            log(ev="cap", user=name); return self.err(429, "limite mensal de tokens atingido")
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else None
        stream = False; pr = ""; nmsg = ntools = 0; model = None; ctx = {}; pcache = 0
        if body and path.startswith("/v1/chat/completions"):
            try:
                j = json.loads(body); stream = bool(j.get("stream")); model = j.get("model")
                pr, nmsg, ntools = prompt_of(j)
                try: ctx = measure_ctx(j)
                except Exception: ctx = {}
                internal = bool(pr) and path.startswith("/v1/chat") and is_internal(clean_prompt(pr), ntools)
                pol = jload(POLICY, {})
                nm = route_model(model, internal, pol)
                changed = nm != model
                if changed: j["model"] = nm; ctx["routedFrom"] = model; model = nm
                # Conversa sem ferramentas; ação carrega só o conjunto pedido. Pedido interno não entra aqui.
                if not internal:
                    meta = apply_jr_context(j, pol)
                    if meta["changed"]: changed = True
                    ctx["toolset"] = meta["toolset"]; ctx["toolsKept"] = meta["toolsKept"]
                # Memória/títulos/resumos: sem ferramentas (se o histórico não tiver chamadas de ferramenta).
                if False and internal and j.get("tools") and not any(m.get("role") == "tool" or m.get("tool_calls") for m in (j.get("messages") or [])):
                    j.pop("tools", None); j.pop("tool_choice", None); changed = True; ctx["toolsStripped"] = True
                try:
                    ctx.update(measure_ctx(j))
                except Exception: pass
                if stream:
                    so = j.get("stream_options") or {}; so["include_usage"] = True; j["stream_options"] = so
                if stream or changed:
                    body = json.dumps(j).encode()
            except Exception: pass
        prompt_risk = ("low", [])
        rs0 = risk_settings() if path.startswith("/v1/chat") else {"enabled": False}
        ask_summary = ""; ask_reason = ""
        cp = clean_prompt(risk_text(pr)) if pr else ""
        if rs0.get("enabled") and cp and not is_internal(clean_prompt(pr), ntools):
            rl, rc = rule_risk(cp, rs0["categories"])
            # Latência: o classificador só segura o pedido quando as regras já acharam algo; senão roda em segundo plano.
            if rs0.get("llm") and (rc or rl != "low"): ll = llm_risk(cp)
            else:
                ll = _llm_cache.get(hashlib.sha256(cp[:1500].encode()).hexdigest())
                if rs0.get("llm") and ll is None: threading.Thread(target=llm_risk, args=(cp,), daemon=True).start()
            lvl = (ll or {}).get("nivel")
            prompt_risk = (combine_risk(rl, ll, rs0), rc + (["ia"] if lvl in ("medium", "high") else []))
            if ll and NO_ASK_RE.search(ll.get("motivo", "")) and prompt_risk[0] == "high": prompt_risk = ("medium", prompt_risk[1])
            ask_summary = short_ask(cp, ll); ask_reason = reason_of(rc, ll)
            if prompt_risk[0] == "high":
                key = (name, hashlib.sha256(cp.encode()).hexdigest())
                dec = PROMPT_DECISIONS.get(key)
                if dec is None:
                    ok, why = hold_for_approval(name, [{"ferramenta": "pedido", "resumo": ask_summary, "risco": "high", "categorias": rc, "detalhes": cp[:600]}], "high", rc, cp, int(rs0.get("holdTimeoutSec") or 240), pediu=ask_summary, motivo=ask_reason)
                    dec = PROMPT_DECISIONS[key] = (ok, why)
                if not dec[0]:
                    audit(name, {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "path": path, "model": model, "status": 200, "prompt": pr, "resumo": cp[:300], "pediu": ask_summary, "motivo": ask_reason, "risco": "high", "categorias": rc,
                                 "acoes": [], "aprovacao": {"status": "negado", "motivo": dec[1]}, "tin": 0, "tout": 0})
                    msg = blocked_message(dec[1])
                    if stream:
                        bd = ("data: %s\n\ndata: [DONE]\n\n" % json.dumps({"id": "jr-bloqueio", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {"role": "assistant", "content": msg}, "finish_reason": "stop"}]}, ensure_ascii=False)).encode()
                        self.send_response(200); self.send_header("Content-Type", "text/event-stream"); self.send_header("Content-Length", str(len(bd))); self.end_headers(); self.wfile.write(bd)
                    else:
                        bd = json.dumps({"id": "jr-bloqueio", "object": "chat.completion", "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": msg}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 0, "completion_tokens": 0}}, ensure_ascii=False).encode()
                        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(bd))); self.end_headers(); self.wfile.write(bd)
                    return
        c, reused = pool_get()
        hdr = {"Authorization": "Bearer " + KEY, "Content-Type": self.headers.get("Content-Type", "application/json"), "Accept": self.headers.get("Accept", "*/*")}
        if body is not None: hdr["Content-Length"] = str(len(body))
        t0 = time.time()
        try:
            try:
                c.request(method, UP.path.rstrip("/") + path[3:], body=body, headers=hdr); r = c.getresponse()
            except (http.client.HTTPException, OSError):
                if not reused: raise
                try: c.close()
                except Exception: pass
                c = upconn(180); c.request(method, UP.path.rstrip("/") + path[3:], body=body, headers=hdr); r = c.getresponse()
            try: ctx["gwPreMs"] = int((t0 - t_in) * 1000); ctx["ttfbMs"] = int((time.time() - t0) * 1000); ctx["reused"] = reused
            except Exception: pass
        except Exception as e:
            log(ev="upstream_err", user=name, path=path, err=type(e).__name__); return self.err(502, "upstream indisponivel")
        self.send_response(r.status)
        ct = r.getheader("Content-Type", "application/json")
        self.send_header("Content-Type", ct)
        pin = pout = 0; resp = []; tcalls = []
        rs = risk_settings() if path.startswith("/v1/chat") else {"enabled": False}
        risk_on = bool(rs.get("enabled")) and r.status == 200
        calls = {}  # índice -> [nome, argumentos]
        def chunk(b):
            self.wfile.write(b"%x\r\n%s\r\n" % (len(b), b)); self.wfile.flush()
        def note_calls(lst):
            for i, tc in enumerate(lst or []):
                fn = tc.get("function") or {}; k = tc.get("index", i)
                cur = calls.setdefault(k, ["", ""])
                if fn.get("name"): cur[0] += fn["name"]
                if fn.get("arguments"): cur[1] += fn["arguments"]
        held = None  # resultado da análise das ações
        if "text/event-stream" in ct:
            self.send_header("Cache-Control", "no-cache"); self.send_header("Transfer-Encoding", "chunked"); self.end_headers()
            buf = b""; pending = []  # linhas seguradas depois que aparece uma chamada de ferramenta
            try:
                while True:
                    ch = r.read1(8192) if hasattr(r, "read1") else r.read(8192)
                    if not ch: break
                    buf += ch
                    out = b""
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        has_tool = False
                        if line.startswith(b"data:") and b'"delta"' in line:
                            try:
                                for chc in json.loads(line[5:]).get("choices") or []:
                                    dl = chc.get("delta") or {}
                                    if dl.get("content") and sum(map(len, resp)) < TR: resp.append(dl["content"])
                                    if dl.get("tool_calls"): has_tool = True; note_calls(dl["tool_calls"])
                            except Exception: pass
                        if line.startswith(b"data:") and b'"usage"' in line:
                            try:
                                us = json.loads(line[5:]).get("usage") or {}
                                pin = us.get("prompt_tokens", pin) or pin; pout = us.get("completion_tokens", pout) or pout
                                got = cached_tokens_of(us)
                                if got: pcache = got
                            except Exception: pass
                        if risk_on and (pending or has_tool): pending.append(line + b"\n")
                        else: out += line + b"\n"
                    if out: chunk(out)
                if buf:
                    if risk_on and pending: pending.append(buf)
                    else: chunk(buf)
                if pending:
                    acts, lvl, cats = assess_actions([(v[0], v[1]) for _, v in sorted(calls.items())], rs, pr)
                    held = {"acoes": acts, "risco": lvl, "categorias": cats}
                    ok, why = True, ""
                    if lvl == "high":
                        held["status"] = "aguardando"
                        ok, why = hold_for_approval(name, acts, lvl, cats, clean_prompt(pr), int(rs.get("holdTimeoutSec") or 240), keepalive=lambda: chunk(b": aguardando aprovacao do administrador\n\n"), pediu="; ".join(a["resumo"] for a in acts if a["risco"] == "high")[:200], motivo=reason_of(cats))
                        held["status"] = "aprovado" if ok else "negado"; held["motivo"] = why
                    if ok: chunk(b"".join(pending))
                    else:
                        msg = {"id": "jr-bloqueio", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {"role": "assistant", "content": blocked_message(why)}, "finish_reason": None}]}
                        fin = {"id": "jr-bloqueio", "object": "chat.completion.chunk", "model": model, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
                        chunk(("data: %s\n\ndata: %s\n\ndata: [DONE]\n\n" % (json.dumps(msg, ensure_ascii=False), json.dumps(fin))).encode())
                self.wfile.write(b"0\r\n\r\n"); self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError): pass
        else:
            data = r.read()
            try:
                dj = json.loads(data); us = dj.get("usage") or {}
                pin = us.get("prompt_tokens", 0) or 0; pout = us.get("completion_tokens", 0) or 0
                got = cached_tokens_of(us)
                if got: pcache = got
                for chc in dj.get("choices") or []:
                    msg = chc.get("message") or {}
                    if msg.get("content"): resp.append(str(msg["content"]))
                    note_calls(msg.get("tool_calls"))
                if risk_on and calls:
                    acts, lvl, cats = assess_actions([(v[0], v[1]) for _, v in sorted(calls.items())], rs, pr)
                    held = {"acoes": acts, "risco": lvl, "categorias": cats}
                    if lvl == "high":
                        ok, why = hold_for_approval(name, acts, lvl, cats, clean_prompt(pr), int(rs.get("holdTimeoutSec") or 240), pediu="; ".join(a["resumo"] for a in acts if a["risco"] == "high")[:200], motivo=reason_of(cats))
                        held["status"] = "aprovado" if ok else "negado"; held["motivo"] = why
                        if not ok:
                            dj["choices"] = [{"index": 0, "message": {"role": "assistant", "content": blocked_message(why)}, "finish_reason": "stop"}]
                            data = json.dumps(dj, ensure_ascii=False).encode()
            except Exception: pass
            self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
        tcalls = [v[0] for _, v in sorted(calls.items())]
        pool_put(c, r)
        if pin or pout or path.startswith("/v1/chat"): add_usage(name, pin, pout)
        if path.startswith("/v1/chat"):
            ctx["cached_tokens"] = pcache
            rec_risk = (held or {}).get("risco", "low"); rec_cats = list((held or {}).get("categorias", []))
            if rs.get("enabled"):
                plvl, pcats = prompt_risk
                rec_risk = max([rec_risk, plvl], key=lambda x: RISK_LEVELS[x]); rec_cats = sorted(set(rec_cats + pcats))
            audit(name, {"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "path": path, "model": model, "status": r.status, "stream": stream,
                         "tin": pin, "tout": pout, "tcache": pcache, "ctx": ctx, "ms": int((time.time()-t0)*1000), "ip": self.headers.get("X-Forwarded-For", self.client_address[0]),
                         "msgs": nmsg, "tools": ntools, "prompt": pr, "resumo": clean_prompt(pr)[:300], "pediu": ask_summary or short_ask(clean_prompt(pr)), "motivo": ask_reason or reason_of(rec_cats) if rec_risk != "low" else "", "interno": is_internal(clean_prompt(pr), ntools), "resposta": "".join(resp)[:TR], "tool_calls": tcalls[:20],
                         "risco": rec_risk, "categorias": rec_cats, "acoes": (held or {}).get("acoes", []), "aprovacao": {k: held[k] for k in ("status", "motivo") if held and k in held} or None})
        log(ev="req", user=name, path=path, status=r.status, stream=stream, tin=pin, tout=pout, ms=int((time.time()-t0)*1000))
if __name__ == "__main__":
    if not os.path.exists(DB): save({"users": {}})
    if os.environ.get("GW_QUOTA_EVERY", "600") != "0": threading.Thread(target=quota_loop, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8080), H).serve_forever()
