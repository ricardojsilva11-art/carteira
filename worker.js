/* ============================================================
   Carteira — servidor (Cloudflare Worker «carteira-api»)
   - GET  /               estado do servidor
   - POST /api/sync       junta e guarda os dados (PC ↔ iPhone)
   - POST /api/precos     preços e histórico (Yahoo Finance) + câmbios para euros
   - POST /api/pesquisa   procura ativos (ações, ETFs, REITs, cripto)
   - POST /api/classificar  setores e tipo de um ativo (ETFs com IA)
   - POST /api/analisar   análise técnica + fundamental com IA e pesquisa na web
   - POST /api/sugestoes  sugestões de investimento para a carteira (IA + web + justETF)
   - POST /api/importar   lê o extrato da corretora (CSV, Excel convertido, PDF) com IA
   - POST /api/calendario  dividendos (anunciados e estimados) e resultados
   - POST /api/composicao  posições, países e setores dentro de um ETF (IA + justETF)
   - POST /api/resumo     resumo semanal da carteira com IA
   - POST /api/push/*     notificações no iPhone e no PC (Web Push)
   - cron (de 15 em 15 min): alertas de preço, variações, dividendos, resultados e resumo de domingo
   Ligações: D1 «DB» (obrigatória). Segredo: ANTHROPIC_API_KEY (para a IA).
   Variáveis opcionais: MODEL (claude-sonnet-5-5), IA_LIMITE_DIA (40).
   ============================================================ */
const CORS = {"access-control-allow-origin":"*", "access-control-allow-methods":"GET, POST, OPTIONS", "access-control-allow-headers":"content-type"};
const json = (o, status = 200) => new Response(JSON.stringify(o), {status, headers:Object.assign({"content-type":"application/json; charset=utf-8"}, CORS)});
const err = (msg, status) => Object.assign(new Error(msg), {status});
const lisbonDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {timeZone:"Europe/Lisbon"}).format(d);
const SINGLES = ["sugestoes"];
const SETORES = ["Tecnologia","Saúde","Financeiro","Consumo cíclico","Consumo básico","Industrial","Energia","Materiais","Imobiliário","Comunicações","Utilities","Cripto","Obrigações","Outros"];

async function sha(s){
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

/* ---------- armazenamento (D1) ---------- */
let ready = false;
async function ensure(env){
  if (!env.DB) throw err("O servidor não tem a base de dados ligada (D1 com o nome «DB»).", 501);
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS estado (k TEXT PRIMARY KEY, v TEXT NOT NULL, upd INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, k TEXT NOT NULL, sub TEXT NOT NULL, nome TEXT, upd INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS enviados (id TEXT PRIMARY KEY, t INTEGER)")
  ]);
  ready = true;
}
async function getVal(env, k){ await ensure(env); const r = await env.DB.prepare("SELECT v FROM estado WHERE k = ?").bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function putVal(env, k, v){ await ensure(env); await env.DB.prepare("INSERT INTO estado (k, v, upd) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, upd = excluded.upd").bind(k, JSON.stringify(v), Date.now()).run(); }
async function cacheGet(env, k, maxAgeMs){ await ensure(env); const r = await env.DB.prepare("SELECT v, t FROM cache WHERE k = ?").bind(k).first(); return r && Date.now() - r.t < maxAgeMs ? JSON.parse(r.v) : null; }
async function cachePut(env, k, v){ await ensure(env); await env.DB.prepare("INSERT INTO cache (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t").bind(k, JSON.stringify(v), Date.now()).run(); }

function merge(a, b){
  a = a || {v:1, cfg:{upd:0}}; if (!b) return a;
  const out = Object.assign({}, a);
  out.cfg = (b.cfg && (b.cfg.upd || 0) > ((a.cfg || {}).upd || 0)) ? Object.assign({}, a.cfg, b.cfg) : (a.cfg || {upd:0});
  SINGLES.forEach(k => { out[k] = (b[k] && (!a[k] || (b[k].upd || 0) > (a[k].upd || 0))) ? b[k] : (a[k] || null); });
  const cols = new Set();
  Object.keys(a).concat(Object.keys(b)).forEach(k => { if (Array.isArray(a[k]) || Array.isArray(b[k])) cols.add(k); });
  cols.forEach(c => {
    const map = new Map();
    (a[c] || []).forEach(x => x && x.id && map.set(x.id, x));
    (Array.isArray(b[c]) ? b[c] : []).forEach(x => { if (!x || !x.id) return; const o = map.get(x.id); if (!o || (x.upd || 0) > (o.upd || 0)) map.set(x.id, x); });
    out[c] = [...map.values()];
  });
  delete out.local;
  return out;
}

/* ---------- Yahoo Finance ---------- */
const UA = {"user-agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept":"application/json"};
async function yahoo(path){
  let last = null;
  for (const host of ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"]){
    try{
      const r = await fetch(host + path, {headers:UA, cf:{cacheTtl:60}});
      if (r.ok) return await r.json();
      last = `${r.status}`;
    }catch(e){ last = e.message; }
  }
  throw err(`O serviço de preços não respondeu (${last}).`, 502);
}
const symOk = s => /^[A-Za-z0-9.\-=^]{1,24}$/.test(s);
/* histórico (cache 6 h) separado do preço de agora (cache 3 min): menos processamento e menos pedidos ao Yahoo */
const H_MAX = 6 * 3600e3, LIVE_MAX = 3 * 60e3;
function compactar(h2){
  /* mais de 2 anos atrás: um ponto por semana, só data e fecho (chega para o gráfico da carteira) */
  const lim = new Date(Date.now() - 730 * 864e5).toISOString().slice(0, 10), out = [];
  let semana = null;
  for (const h of h2){
    if (h[0] >= lim){ out.push([h[0], h[1], h[2], h[3]]); continue; }
    const d = new Date(h[0] + "T00:00:00Z"), k = Math.floor((d.getTime() / 864e5 + 3) / 7);
    if (k === semana) out[out.length - 1] = [h[0], h[1]]; else { out.push([h[0], h[1]]); semana = k; }
  }
  return out;
}
async function buscarHist(env, sym, range){
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false&events=div%2Csplit`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw err(`Ativo «${sym}» não encontrado.`, 404);
  const m = r.meta || {}, q = ((r.indicators || {}).quote || [{}])[0] || {}, ts = r.timestamp || [];
  const tz = m.exchangeTimezoneName || "UTC";
  const fmt = new Intl.DateTimeFormat("en-CA", {timeZone:tz});
  const dayOf = t => fmt.format(new Date(t * 1000));
  const byDay = new Map();
  ts.forEach((t, i) => { const c = q.close && q.close[i]; if (c != null && isFinite(c)) byDay.set(dayOf(t), [dayOf(t), +c.toFixed(5), q.high && q.high[i] != null ? +(+q.high[i]).toFixed(5) : +c.toFixed(5), q.low && q.low[i] != null ? +(+q.low[i]).toFixed(5) : +c.toFixed(5)]); });
  const h2 = [...byDay.values()];
  const divs = Object.values(((r.events || {}).dividends) || {}).filter(d => d && d.amount > 0 && d.date).map(d => [dayOf(d.date), +(+d.amount).toFixed(6)]).sort((a, b) => a[0].localeCompare(b[0]));
  const last = h2.length ? h2[h2.length - 1] : null;
  const H = {divs, sym:m.symbol || sym, nome:m.longName || m.shortName || sym, moeda:m.currency || "", tipoY:m.instrumentType || "", bolsa:m.fullExchangeName || m.exchangeName || "",
    max52:m.fiftyTwoWeekHigh || null, min52:m.fiftyTwoWeekLow || null, hist:compactar(h2)};
  /* preço de recurso, caso o pedido do preço de agora falhe */
  const L = {preco:+(m.regularMarketPrice != null ? m.regularMarketPrice : (last ? last[1] : 0)), anterior:+(m.chartPreviousClose || (h2.length > 1 ? h2[h2.length - 2][1] : 0)) || null, sessao:"", hora:m.regularMarketTime || 0, dia:m.regularMarketTime ? dayOf(m.regularMarketTime) : (last ? last[0] : "")};
  return {H, L};
}
async function buscarLive(env, sym){
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=${/=X$/.test(sym) ? "false" : "true"}`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) return null;
  const m = r.meta || {}, tl = r.timestamp || [], cl = (((r.indicators || {}).quote || [{}])[0] || {}).close || [];
  let preco = m.regularMarketPrice != null ? +m.regularMarketPrice : null, hora = m.regularMarketTime || 0, sessao = "";
  let lt = null, lp = null;
  for (let i = tl.length - 1; i >= 0; i--) if (cl[i] != null && isFinite(cl[i])){ lt = tl[i]; lp = +cl[i]; break; }
  if (preco == null && lp != null){ preco = lp; hora = lt; }
  const reg = (m.currentTradingPeriod || {}).regular || {};
  if (!/=X$/.test(sym) && lt && m.regularMarketTime && lt > m.regularMarketTime + 120 && lp > 0){ preco = lp; hora = lt; sessao = reg.start && lt < reg.start ? "pré-abertura" : "após fecho"; }
  if (preco == null) return null;
  const tz = m.exchangeTimezoneName || "UTC";
  return {preco, anterior:m.chartPreviousClose != null ? +m.chartPreviousClose : null, sessao, hora, dia:hora ? new Intl.DateTimeFormat("en-CA", {timeZone:tz}).format(new Date(hora * 1000)) : ""};
}
/* junta o histórico (texto JSON guardado) com o preço de agora, sem voltar a ler o JSON todo */
const juntar = (rawH, L) => rawH.slice(0, -1) + "," + JSON.stringify(L).slice(1);
/* para quem precisa do objeto (importação): lê e junta */
async function chart(env, sym, range){
  const [h, l] = await Promise.all([cacheGet(env, `h4:${sym}:${range}`, H_MAX), cacheGet(env, `l4:${sym}`, LIVE_MAX)]);
  if (h && l) return Object.assign({}, h, l);
  const f = await buscarHist(env, sym, range);
  await cachePut(env, `h4:${sym}:${range}`, f.H);
  let L = l; if (!L){ try{ L = await buscarLive(env, sym); }catch(e){} if (L) await cachePut(env, `l4:${sym}`, L); }
  return Object.assign({}, f.H, L || f.L);
}
/* converte para euros: GBp (pence) → GBP/100; outras moedas pelo par XXXEUR=X */
async function precos(env, body){
  const syms = [...new Set((body.symbols || []).map(s => String(s).trim()).filter(symOk))].slice(0, 40);
  const range = ["5d","1mo","6mo","1y","2y","5y","10y","max"].includes(body.range) ? body.range : "1y";
  const erros = {}, now = Date.now();
  await ensure(env);
  const moedasProv = ["USD","GBP","CHF","JPY","CAD","AUD","DKK","SEK","NOK","HKD"].map(c => `${c}EUR=X`);
  const todos = syms.concat(moedasProv);
  const keys = todos.map(s => `h4:${s}:${range}`).concat(todos.map(s => `l4:${s}`));
  const pre = new Map();
  for (let i = 0; i < keys.length; i += 90){
    const part = keys.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT k, v, t FROM cache WHERE k IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    (r.results || []).forEach(x => pre.set(x.k, x));
  }
  const writes = [];
  let pedidos = 0;
  const um = async s => {
    const hk = `h4:${s}:${range}`, lk = `l4:${s}`;
    const ph = pre.get(hk), pl = pre.get(lk);
    let rawH = ph && now - ph.t < H_MAX ? ph.v : null, L = pl && now - pl.t < LIVE_MAX ? JSON.parse(pl.v) : null, Lrec = null;
    if (!rawH){
      if (++pedidos > 44) throw err("Demasiados ativos para atualizar de uma vez; tenta outra vez daqui a pouco.", 503);
      const f = await buscarHist(env, s, range);
      rawH = JSON.stringify(f.H); writes.push([hk, rawH]); Lrec = f.L;
    }
    if (!L){
      if (pedidos < 44){ pedidos++; try{ L = await buscarLive(env, s); }catch(e){ L = null; } if (L) writes.push([lk, JSON.stringify(L)]); }
      if (!L && pl) L = JSON.parse(pl.v);           /* preço guardado mais antigo */
      if (!L) L = Lrec;
      if (!L){ const H = JSON.parse(rawH), h = H.hist, u = h[h.length - 1]; L = {preco:u ? u[1] : 0, anterior:h.length > 1 ? h[h.length - 2][1] : null, sessao:"", hora:0, dia:u ? u[0] : ""}; }
    }
    if (L.anterior == null){
      /* sem fecho anterior no preço de agora: vai ao histórico (só neste caso lê o JSON) */
      const h = JSON.parse(rawH).hist, ant = [...h].reverse().find(x => x[0] < (L.dia || "9999"));
      L = Object.assign({}, L, {anterior:ant ? ant[1] : L.preco});
    }
    return juntar(rawH, L);
  };
  const outRaw = {};
  await Promise.all(syms.map(async s => { try{ outRaw[s] = await um(s); }catch(e){ erros[s] = e.message; } }));
  const moedas = new Set();
  Object.values(outRaw).forEach(r => { const m = /"moeda":"([A-Za-z]*)"/.exec(r); const c = m ? (m[1] === "GBp" || m[1] === "GBX" ? "GBP" : m[1]) : ""; if (c && c !== "EUR") moedas.add(c); });
  const fxRaw = {};
  await Promise.all([...moedas].map(async c => { try{ fxRaw[c] = await um(`${c}EUR=X`); }catch(e){ erros[`${c}EUR`] = "Câmbio indisponível: " + e.message; } }));
  if (writes.length){
    for (let i = 0; i < writes.length; i += 40)
      await env.DB.batch(writes.slice(i, i + 40).map(([k, v]) => env.DB.prepare("INSERT INTO cache (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t").bind(k, v, now)));
  }
  const obj = o => "{" + Object.entries(o).map(([k, v]) => JSON.stringify(k) + ":" + v).join(",") + "}";
  return new Response(`{"precos":${obj(outRaw)},"fx":${obj(Object.assign({EUR:'{"preco":1,"hist":[]}'}, fxRaw))},"erros":${JSON.stringify(erros)},"quando":${Date.now()}}`,
    {headers:Object.assign({"content-type":"application/json; charset=utf-8"}, CORS)});
}
async function pesquisa(env, body){
  const q = String(body.q || "").trim().slice(0, 60);
  if (q.length < 1) return {res:[]};
  const ck = "ps:" + q.toLowerCase();
  const hit = await cacheGet(env, ck, 24 * 3600e3); if (hit) return hit;
  const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0&enableFuzzyQuery=false`);
  const res = (j.quotes || []).filter(x => x.symbol && ["EQUITY","ETF","MUTUALFUND","CRYPTOCURRENCY","INDEX","CURRENCY"].includes(x.quoteType)).map(x => ({
    sym:x.symbol, nome:x.longname || x.shortname || x.symbol, tipoY:x.quoteType, bolsa:x.exchDisp || x.exchange || "", setorY:x.sector || x.sectorDisp || "", industriaY:x.industry || x.industryDisp || ""
  }));
  const out = {res}; await cachePut(env, ck, out); return out;
}

/* ---------- IA (Claude + pesquisa na web) ---------- */
const apiKey = env => {
  const raw = String(env.ANTHROPIC_API_KEY || "").replace(/[^\x21-\x7E]/g, "");
  const m = /sk-ant-[A-Za-z0-9_\-]+/.exec(raw);
  return m ? m[0] : raw.replace(/^["'`]+|["'`]+$/g, "");
};
async function claude(env, system, prompt, {maxTokens = 4000, searches = 0, fetchDomains = null, fetches = 0} = {}){
  if (!env.ANTHROPIC_API_KEY) throw err("A IA ainda não está ligada no servidor: falta a chave ANTHROPIC_API_KEY.", 501);
  const messages = [{role:"user", content:prompt}];
  let tools = [];
  if (searches) tools.push({type:"web_search_20250305", name:"web_search", max_uses:searches});
  if (fetches) tools.push(Object.assign({type:"web_fetch_20250910", name:"web_fetch", max_uses:fetches, max_content_tokens:8000}, fetchDomains ? {allowed_domains:fetchDomains} : {}));
  if (!tools.length) tools = undefined;
  const fontes = new Map();
  let texto = "";
  for (let volta = 0; volta < 4; volta++){
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"x-api-key":apiKey(env), "anthropic-version":"2023-06-01", "content-type":"application/json"},
      body:JSON.stringify(Object.assign({model:env.MODEL || "claude-sonnet-5-5", max_tokens:maxTokens, system, messages}, tools ? {tools} : {}))
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok){
      const msg = (j.error && j.error.message) || String(r.status);
      if (/pdf/i.test(msg) && /(password|encrypt|protect)/i.test(msg)) throw err("O PDF está protegido com palavra-passe. Abre-o, escolhe Imprimir › Guardar como PDF e envia esse ficheiro novo.", 400);
      if (/pdf/i.test(msg) && /(page|pages)/i.test(msg)) throw err("O PDF tem demasiadas páginas. Envia só as páginas com os títulos/ações (máximo 100).", 400);
      if (/pdf|document/i.test(msg)) throw err("A IA não conseguiu ler este PDF (" + msg.slice(0, 120) + "). Experimenta Imprimir › Guardar como PDF, ou uma fotografia das páginas.", 400);
      if (/too large|exceeds|maximum/i.test(msg)) throw err("O ficheiro é demasiado grande para a IA. Envia só as páginas necessárias.", 400);
      throw err("A IA respondeu com erro: " + msg, 502);
    }
    (j.content || []).forEach(c => {
      if (c.type === "web_search_tool_result" && Array.isArray(c.content)) c.content.forEach(x => x && x.url && !fontes.has(x.url) && fontes.set(x.url, {titulo:x.title || x.url, url:x.url}));
      if (c.type === "web_fetch_tool_result" && c.content && c.content.url) fontes.set(c.content.url, {titulo:(c.content.content && c.content.content.title) || c.content.url, url:c.content.url, lida:true});
      if (c.type === "text"){ texto += c.text; (c.citations || []).forEach(x => x && x.url && !fontes.has(x.url) && fontes.set(x.url, {titulo:x.title || x.url, url:x.url})); }
    });
    if (j.stop_reason !== "pause_turn") break;
    messages.push({role:"assistant", content:j.content});
  }
  let out = lerJSON(texto);
  if (!out){
    /* 2.ª passagem: a IA converte a sua própria resposta para o formato pedido (resposta estruturada garantida) */
    try{ out = await formatar(env, system, texto); }catch(e){ out = null; }
  }
  if (!out){
    try{ await ensure(env); await cachePut(env, "dbg:ultima-falha", {quando:new Date().toISOString(), inicio:texto.slice(0, 1500), fim:texto.slice(-1500), tam:texto.length}); }catch(e){}
    throw err("Não consegui interpretar a resposta da IA. Tenta outra vez.", 502);
  }
  return {out, fontes:[...fontes.values()]};
}
/* tenta ler o JSON de uma resposta (tira texto à volta, blocos ```json e vírgulas a mais) */
function lerJSON(t){
  t = String(t || "").replace(/```(?:json)?/gi, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  const bruto = t.slice(a, b + 1);
  for (const c of [bruto, bruto.replace(/,\s*([}\]])/g, "$1")]){ try{ return JSON.parse(c); }catch(e){} }
  return null;
}
async function formatar(env, systemOriginal, texto){
  if (!texto || texto.length < 20) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"x-api-key":apiKey(env), "anthropic-version":"2023-06-01", "content-type":"application/json"},
    body:JSON.stringify({model:env.MODEL || "claude-sonnet-5-5", max_tokens:8000,
      system:"Convertes uma resposta já escrita para o formato JSON pedido, sem acrescentar nem inventar informação. Mantém o português de Portugal. Usa a ferramenta «resultado».",
      messages:[{role:"user", content:`Instruções originais (com o formato JSON pedido):\n${systemOriginal.slice(0, 6000)}\n\nResposta a converter:\n${texto.slice(-60000)}`}],
      tools:[{name:"resultado", description:"Devolve o objeto JSON final no formato descrito nas instruções originais.", input_schema:{type:"object", additionalProperties:true}}],
      tool_choice:{type:"tool", name:"resultado"}})
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  const tu = (j.content || []).find(c => c.type === "tool_use");
  return tu && tu.input && typeof tu.input === "object" && Object.keys(tu.input).length ? tu.input : null;
}
async function limiteIA(env, key){
  const lim = +(env.IA_LIMITE_DIA || 40), ck = `ia:${key}:${lisbonDay()}`;
  const used = (await getVal(env, ck)) || 0;
  if (used >= lim) throw err(`Limite diário de análises com IA atingido (${lim}). Volta amanhã ou aumenta IA_LIMITE_DIA no servidor.`, 429);
  await putVal(env, ck, used + 1);
}

/* setor sem IA para ações e cripto (setores do Yahoo → português) */
const MAP_Y = {"Technology":"Tecnologia","Healthcare":"Saúde","Financial Services":"Financeiro","Consumer Cyclical":"Consumo cíclico","Consumer Defensive":"Consumo básico","Industrials":"Industrial","Energy":"Energia","Basic Materials":"Materiais","Real Estate":"Imobiliário","Communication Services":"Comunicações","Utilities":"Utilities"};
async function classificar(env, key, body){
  const sym = String(body.sym || "").trim();
  if (!symOk(sym)) throw err("Símbolo inválido.", 400);
  const tipoY = String(body.tipoY || "").toUpperCase(), setorY = String(body.setorY || ""), indY = String(body.industriaY || "");
  if (tipoY === "CRYPTOCURRENCY" || /-(EUR|USD|USDT)$/.test(sym) && tipoY !== "EQUITY" && tipoY !== "ETF") return {tipo:"Cripto", setores:{"Cripto":100}, fonte:"automático"};
  if (tipoY === "EQUITY" && MAP_Y[setorY]){
    const reit = /REIT/i.test(indY);
    return {tipo:reit ? "REIT" : "Ação", setores:{[MAP_Y[setorY]]:100}, fonte:"automático"};
  }
  const ck = "cls:" + sym;
  const hit = await cacheGet(env, ck, 30 * 864e5); if (hit) return hit;
  await limiteIA(env, key);
  const system = `És um analista de fundos e ações. Classificas um ativo financeiro para uma app de carteira em português de Portugal.
Responde APENAS com JSON: {"tipo":"ETF|Ação|REIT|Cripto|Obrigações|Fundo","setores":{"<setor>":percentagem,...},"regiao":"texto curto","nota":"1 frase"}.
Setores possíveis (usa só estes nomes): ${SETORES.join(", ")}.
As percentagens somam 100 e são números. Para um ETF usa a composição setorial mais recente que encontrares na web (ficha do emitente ou sites de análise). Para uma ação, um único setor com 100. Não inventes: se não encontrares, faz a melhor estimativa e diz na nota que é estimativa.`;
  const {out, fontes} = await claude(env, system, `Ativo: ${sym} — ${String(body.nome || "").slice(0, 120)} (tipo Yahoo: ${tipoY || "desconhecido"}; setor Yahoo: ${setorY || "-"}; indústria: ${indY || "-"}).`, {maxTokens:1500, searches:tipoY === "EQUITY" ? 1 : 3});
  const setores = {};
  Object.entries(out.setores || {}).forEach(([k, v]) => { const n = SETORES.includes(k) ? k : "Outros"; setores[n] = (setores[n] || 0) + (+v || 0); });
  const tot = Object.values(setores).reduce((a, b) => a + b, 0) || 1;
  Object.keys(setores).forEach(k => setores[k] = Math.round(setores[k] / tot * 1000) / 10);
  const res = {tipo:["ETF","Ação","REIT","Cripto","Obrigações","Fundo"].includes(out.tipo) ? out.tipo : "ETF", setores:Object.keys(setores).length ? setores : {"Outros":100}, regiao:String(out.regiao || ""), nota:String(out.nota || ""), fontes:fontes.slice(0, 5), fonte:"IA"};
  await cachePut(env, ck, res);
  return res;
}

async function analisar(env, key, body){
  const sym = String(body.sym || "").trim();
  if (!symOk(sym)) throw err("Símbolo inválido.", 400);
  const ck = `an:${sym}:${lisbonDay()}`;
  if (!body.forcar){ const hit = await cacheGet(env, ck, 12 * 3600e3); if (hit) return Object.assign({cache:true}, hit); }
  await limiteIA(env, key);
  const isETF = /ETF|FUND/i.test(String(body.tipo || "")) || /ETF/i.test(String(body.tipoY || ""));
  const isin = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(body.isin || "")) ? body.isin : "";
  const system = `És um analista financeiro que escreve para um investidor particular em Portugal (português europeu, claro e direto, sem jargão desnecessário).
Recebes indicadores técnicos já calculados pela app e pesquisas na web por dados fundamentais recentes e opiniões de sites de análise (relatórios de resultados, Morningstar, Seeking Alpha, Reuters, sites do emitente, etc.).
Responde APENAS com JSON:
{"resumo":"2-3 frases com a leitura geral",
 "sinalTecnico":"positivo|neutro|negativo",
 "sinalFundamental":"positivo|neutro|negativo",
 "tecnica":"3-5 frases a interpretar tendência, médias móveis, RSI, MACD, suportes e resistências",
 "metricas":[{"nome":"P/E","valor":"texto com unidade","nota":"curta: barato/caro face ao setor, etc."}],
 "fundamental":"3-5 frases: crescimento, rentabilidade, dívida, avaliação, dividendos (para ETFs: custos, composição, replicação; para cripto: adoção, oferta, riscos)",
 "consenso":"o que dizem os analistas/sites (preço-alvo médio e recomendação, se existirem)",
 "riscos":["risco curto"],
 "oportunidades":["ponto curto"]${isETF ? `,
 "justetf":{"url":"endereço da página do ETF no justETF","isin":"","nome":"","indice":"índice replicado","ter":"custo anual %","tamanho":"tamanho do fundo em milhões €","replicacao":"física (completa/amostragem) ou sintética","distribuicao":"acumulação ou distribuição (e frequência)","domicilio":"país","dataLancamento":"","nPosicoes":"","rentabilidade":{"1a":"%","3a":"%","5a":"%"},"volatilidade1a":"%","nota":"1 frase com o que o justETF destaca (ex.: classificação, alternativas mais baratas no mesmo índice)"}` : ""}}
Regras: usa só números que encontraste ou que te foram dados; se não encontrares, escreve "n/d"; 4 a 8 métricas adequadas ao tipo de ativo; não dês ordens de compra ou venda, descreve o cenário.${isETF ? `
Este ativo é um ETF: é OBRIGATÓRIO ler a página do ETF no justETF (justetf.com) com a ferramenta web_fetch. Se te for dado o endereço, abre-o diretamente; senão pesquisa «justETF <nome ou ticker> ISIN» e abre a página "etf-profile" do resultado. Usa os dados do justETF no objeto "justetf", nas métricas (TER, tamanho, replicação, distribuição, rentabilidades) e na leitura fundamental. Se o justETF não abrir, preenche "justetf" com "n/d" e explica na nota.` : ""}`;
  const prompt = `Ativo: ${sym} — ${String(body.nome || "").slice(0, 120)} (${String(body.tipo || "")}). Moeda: ${String(body.moeda || "")}.
Indicadores técnicos calculados pela app (JSON): ${JSON.stringify(body.ind || {}).slice(0, 4000)}
Posição do investidor neste ativo (JSON, pode estar vazia): ${JSON.stringify(body.posicao || {}).slice(0, 1000)}
${isETF && isin ? `Página do ETF no justETF: https://www.justetf.com/pt/etf-profile.html?isin=${isin}\n` : ""}Hoje é ${lisbonDay()}.`;
  const {out, fontes} = await claude(env, system, prompt, isETF ? {maxTokens:5000, searches:4, fetches:2, fetchDomains:["justetf.com"]} : {maxTokens:4000, searches:4});
  const res = {sym, quando:Date.now(), resumo:String(out.resumo || ""), sinalTecnico:out.sinalTecnico || "neutro", sinalFundamental:out.sinalFundamental || "neutro", tecnica:String(out.tecnica || ""),
    metricas:(out.metricas || []).slice(0, 10), fundamental:String(out.fundamental || ""), consenso:String(out.consenso || ""), riscos:(out.riscos || []).slice(0, 6), oportunidades:(out.oportunidades || []).slice(0, 6), fontes:fontes.slice(0, 10), justetf:isETF && out.justetf && typeof out.justetf === "object" ? out.justetf : null};
  await cachePut(env, ck, res);
  return res;
}

async function sugestoes(env, key, body){
  await limiteIA(env, key);
  const system = `És um consultor de investimentos que escreve para um investidor particular em Portugal (português europeu).
Recebes a composição da carteira (pesos por ativo, classe e setor) e o perfil do investidor. Pesquisa na web análises recentes de ações, ETFs, REITs e cripto em sites de análise e notícias financeiras, e propõe ideias para melhorar a carteira (diversificação, concentração, custos, setores em falta, oportunidades).
Responde APENAS com JSON:
{"resumo":"2-3 frases sobre o estado da carteira",
 "alertas":[{"titulo":"curto","detalhe":"1-2 frases"}],
 "ideias":[{"titulo":"curto","isin":"ISIN (obrigatório nos ETFs)","ter":"custo anual % (ETFs)","justetf":"endereço da página no justETF (ETFs)","sym":"símbolo do Yahoo Finance (ex.: VWCE.DE, AAPL, O, BTC-EUR, IWDA.AS)","nome":"nome do ativo","tipo":"Ação|ETF|REIT|Cripto|Obrigações","porque":"2-3 frases concretas ligadas à carteira","tecnica":"1 frase sobre o gráfico","fundamental":"1 frase com dados","risco":"baixo|médio|alto","confianca":número 0-100,"efeito":"o que muda na carteira (ex.: Tecnologia de 41% para 36%)"}]}
Para cada ETF sugerido é OBRIGATÓRIO confirmar os dados na página do justETF (justetf.com) com a ferramenta web_fetch: ISIN, TER, tamanho, replicação, distribuição e rentabilidade; usa o justETF também para comparar alternativas ao mesmo índice e escolher a mais barata e líquida.
Regras: 4 a 6 ideias diferentes; prefere ativos acessíveis a um investidor europeu (ETFs UCITS em bolsas europeias quando for ETF); respeita o perfil de risco; não inventes números; não garantas rentabilidades; descreve, não ordenes.`;
  const prompt = `Carteira (JSON): ${JSON.stringify(body.carteira || {}).slice(0, 20000)}
Perfil do investidor: ${JSON.stringify(body.perfil || {}).slice(0, 500)}
Hoje é ${lisbonDay()}.`;
  const {out, fontes} = await claude(env, system, prompt, {maxTokens:10000, searches:5, fetches:4, fetchDomains:["justetf.com"]});
  return {quando:Date.now(), upd:Date.now(), resumo:String(out.resumo || ""), alertas:(out.alertas || []).slice(0, 6), ideias:(out.ideias || []).slice(0, 8), fontes:fontes.slice(0, 12)};
}

/* ---------- importar extrato da corretora ---------- */
/* símbolos no formato das corretoras (XTB, etc.: AAPL.US, VWCE.DE, SAP.DE, ASML.NL) → Yahoo */
const SUF_CORRETORA = {US:"", UK:".L", DE:".DE", NL:".AS", FR:".PA", PT:".LS", ES:".MC", IT:".MI", BE:".BR", CH:".SW", DK:".CO", SE:".ST", NO:".OL", FI:".HE", PL:".WA", IE:".IR", AT:".VI"};
function tickerParaYahoo(tk){
  const m = /^([A-Z0-9.\-]+)\.([A-Z]{2})$/.exec(String(tk || "").trim().toUpperCase());
  if (!m || !(m[2] in SUF_CORRETORA)) return null;
  return m[1].replace(/\./g, "-") + SUF_CORRETORA[m[2]];
}
const REGRAS_CORRETORA = {
  xtb:`Ficheiro da XTB: o Excel tem várias folhas (posições abertas, posições fechadas, operações de caixa, ordens pendentes) que repetem os mesmos movimentos. Usa APENAS a folha de operações de caixa (CASH OPERATION HISTORY / Histórico de operações de caixa) para não duplicar:
- "Stock purchase" / "Compra de ações" (ou tipo semelhante) = compra; a quantidade e o preço estão no comentário, ex.: "OPEN BUY 5 @ 123.45" ou "OPEN BUY 5/10 @ 123.45" (quantidade = primeiro número);
- "Stock sale" / "Venda de ações" = venda; ex.: "CLOSE BUY 3/5 @ 130.10" (quantidade vendida = 3);
- a coluna Amount/Montante está na moeda da conta: se a conta for em EUR, o valor absoluto é o "totalEUR" (já inclui conversão cambial e comissões);
- "DIVIDENT" / "Dividend" / "Dividendo" = dividendo bruto; "Withholding Tax" / "Imposto retido" com o mesmo símbolo e data = imposto; junta-os num item (totalEUR = dividendo − imposto, impostoEUR = imposto, brutoEUR = dividendo);
- ignora "Free-funds Interest", juros, "deposit", "withdrawal", transferências, "SEC fee", "Sub account transfer" e operações de CFD;
- copia o símbolo da XTB tal como aparece (ex.: AAPL.US, VWCE.DE, O.US) para "ticker" e põe a bolsa segundo o sufixo (US = EUA, DE = Xetra, UK = Londres, NL = Amesterdão, FR = Paris, PT = Lisboa, ES = Madrid, IT = Milão).
Se não existir a folha de operações de caixa, usa as posições abertas como compras na data de abertura e as fechadas como compra na abertura + venda no fecho.
Se a moeda da conta não for EUR, põe totalEUR null e indica valor e moeda na moeda da conta.`
};
const TIPO_Y_PREF = {".DE":["XETRA","GER","Xetra","Frankfurt"], ".AS":["Amsterdam"], ".PA":["Paris"], ".MI":["Milan"], ".L":["London","LSE"], ".LS":["Lisbon"], ".SW":["Swiss"], ".MC":["Madrid"], ".BR":["Brussels"]};
function escolherSimbolo(res, it){
  if (!res.length) return null;
  const bolsa = String(it.bolsa || "").toLowerCase(), moeda = String(it.moeda || "").toUpperCase(), tk = String(it.ticker || "").toUpperCase();
  const score = r => {
    let s = 0;
    const ex = String(r.exchDisp || r.exchange || "").toLowerCase();
    if (bolsa && (ex.includes(bolsa) || bolsa.includes(ex))) s += 6;
    Object.entries(TIPO_Y_PREF).forEach(([suf, nomes]) => { if (r.symbol.endsWith(suf) && nomes.some(n => bolsa.includes(n.toLowerCase()))) s += 6; });
    if (tk && (r.symbol.toUpperCase() === tk || r.symbol.toUpperCase().startsWith(tk + "."))) s += 4;
    if (moeda === "EUR" && /\.(DE|AS|PA|MI|LS|MC|BR)$/.test(r.symbol)) s += 2;
    if (moeda === "USD" && !r.symbol.includes(".")) s += 2;
    if (r.quoteType === "ETF" || r.quoteType === "EQUITY") s += 1;
    return s;
  };
  return res.slice().sort((a, b) => score(b) - score(a))[0];
}
async function importar(env, key, body){
  const f = body.ficheiro || {};
  const content = [];
  if (f.b64 && f.mime === "application/pdf") content.push({type:"document", source:{type:"base64", media_type:"application/pdf", data:f.b64}});
  else if (f.b64 && /^image\/(png|jpeg|webp|gif)$/.test(f.mime)) content.push({type:"image", source:{type:"base64", media_type:f.mime, data:f.b64}});
  else if (f.texto) content.push({type:"text", text:`Conteúdo do ficheiro «${String(f.nome || "extrato").slice(0, 80)}»:\n\n${String(f.texto).slice(0, 200000)}`});
  else throw err("Ficheiro vazio ou formato não suportado (usa CSV, Excel, PDF ou imagem).", 400);
  await limiteIA(env, key);
  content.push({type:"text", text:`Corretora indicada pela pessoa: ${String(body.corretora || "não indicada").slice(0, 40)}. Responde só com o JSON.`});
  const system = `Lês extratos e relatórios de corretoras (Degiro, Trading 212, XTB, Interactive Brokers, Revolut, Lightyear, Trade Republic, bancos portugueses, etc.) e devolves os movimentos de investimento para uma app de carteira em português de Portugal.
Responde APENAS com JSON:
{"corretora":"nome","resumo":"1 frase","ignorados":"1 frase sobre o que ignoraste (depósitos, levantamentos, câmbios, juros...)",
 "itens":[{"tipo":"compra|venda|dividendo","data":"AAAA-MM-DD","nome":"nome do ativo","isin":"ISIN ou vazio","ticker":"ticker ou vazio","bolsa":"bolsa/mercado se aparecer","qtd":número de unidades (0 nos dividendos),"preco":preço unitário na moeda do ativo,"moeda":"moeda do ativo (EUR, USD, GBP, GBX...)","valor":montante bruto na moeda do ativo (qtd×preço; nos dividendos o bruto),"totalEUR":valor em euros tal como aparece no extrato (compras: total pago COM comissões e taxas; vendas: total recebido JÁ SEM comissões; dividendos: valor líquido recebido depois de impostos) ou null se o extrato não tiver o valor em euros,"comissaoEUR":número ou 0,"impostoEUR":imposto retido nos dividendos em euros ou 0,"brutoEUR":dividendo bruto em euros ou null,"posicao":false,"custoDesconhecido":false}]}
${REGRAS_CORRETORA[String(body.corretora || "").toLowerCase()] || ""}
Extrato de posição / carteira de títulos (lista de ativos detidos com quantidade e valor, sem compras nem vendas — comum nos bancos): devolve um item "compra" por ativo com "posicao":true, data = data de aquisição se aparecer, senão a data do extrato; qtd = quantidade detida; totalEUR = custo de aquisição total (preço médio de compra × quantidade) se aparecer, senão o valor de mercado em euros indicado no extrato, e nesse caso "custoDesconhecido":true. Se o documento tiver operações E posição, usa só as operações.
Regras: um item por operação executada (junta execuções parciais da mesma ordem no mesmo dia); nas linhas de dividendo junta o dividendo e o imposto retido do mesmo ativo e data num só item; ignora depósitos, levantamentos, conversões de moeda, juros, transferências e ordens canceladas; números com ponto decimal e sempre positivos; não inventes valores; se uma data não tiver ano, usa o mais provável.`;
  const {out} = await claude(env, system, content, {maxTokens:32000});
  let itens = (Array.isArray(out.itens) ? out.itens : []).filter(x => x && ["compra","venda","dividendo"].includes(x.tipo) && /^\d{4}-\d{2}-\d{2}$/.test(String(x.data || ""))).slice(0, 1500);
  /* símbolo do Yahoo para cada ativo (por ISIN, depois ticker, depois nome) */
  const chaves = [...new Set(itens.map(x => x.isin || x.ticker || x.nome).filter(Boolean))].slice(0, 30);
  const resolvidos = {};
  for (const k of chaves){
    const it = itens.find(x => (x.isin || x.ticker || x.nome) === k);
    /* 1.º o símbolo da corretora convertido (AAPL.US → AAPL), confirmado no Yahoo */
    const cand = tickerParaYahoo(it.ticker);
    if (cand){
      try{
        const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(cand)}&quotesCount=6&newsCount=0&listsCount=0`);
        const r = (j.quotes || []).find(x => String(x.symbol).toUpperCase() === cand);
        if (r){ resolvidos[k] = {sym:r.symbol, nomeY:r.longname || r.shortname || r.symbol, tipoY:r.quoteType, setorY:r.sector || "", industriaY:r.industry || "", bolsaY:r.exchDisp || ""}; continue; }
        const c = await chart(env, cand, "5d");
        if (c && c.preco){ resolvidos[k] = {sym:cand, nomeY:c.nome, tipoY:c.tipoY === "ETF" ? "ETF" : c.tipoY === "CRYPTOCURRENCY" ? "CRYPTOCURRENCY" : "EQUITY", setorY:"", industriaY:"", bolsaY:c.bolsa}; continue; }
      }catch(e){}
    }
    for (const q of [it.isin, it.ticker, it.nome].filter(Boolean)){
      try{
        const j = await yahoo(`/v1/finance/search?q=${encodeURIComponent(String(q).slice(0, 60))}&quotesCount=8&newsCount=0&listsCount=0`);
        const res = (j.quotes || []).filter(x => x.symbol && ["EQUITY","ETF","MUTUALFUND","CRYPTOCURRENCY"].includes(x.quoteType));
        const r = escolherSimbolo(res, it);
        if (r){ resolvidos[k] = {sym:r.symbol, nomeY:r.longname || r.shortname || r.symbol, tipoY:r.quoteType, setorY:r.sector || "", industriaY:r.industry || "", bolsaY:r.exchDisp || ""}; break; }
      }catch(e){ break; }
    }
  }
  /* valores em euros: usa o do extrato; se faltar, converte pelo câmbio da data */
  const fxCache = {};
  const taxa = async (moeda, data) => {
    let m = String(moeda || "EUR").toUpperCase(), esc = 1;
    if (m === "GBX" || moeda === "GBp"){ m = "GBP"; esc = .01; }
    if (m === "EUR") return esc;
    if (!fxCache[m]){ try{ fxCache[m] = (await chart(env, `${m}EUR=X`, "10y")).hist; }catch(e){ fxCache[m] = []; } }
    const h = fxCache[m]; let r = null;
    for (const x of h){ if (x[0] <= data) r = x[1]; else break; }
    return r != null ? r * esc : (h.length ? h[0][1] * esc : null);
  };
  const final = [];
  for (const x of itens){
    const k = x.isin || x.ticker || x.nome, r = resolvidos[k] || null;
    let total = +x.totalEUR > 0 ? +x.totalEUR : null, aviso = "";
    if (total == null && +x.valor > 0){
      const t = await taxa(x.moeda, x.data);
      if (t){
        total = +x.valor * t;
        if (x.tipo === "compra") total += +x.comissaoEUR || 0;
        if (x.tipo === "venda") total -= +x.comissaoEUR || 0;
        if (x.tipo === "dividendo") total -= +x.impostoEUR || 0;
        aviso = `Convertido de ${x.moeda} ao câmbio de ${x.data}.`;
      } else aviso = "Sem valor em euros: confirma o total.";
    }
    if (x.posicao) aviso = (aviso ? aviso + " " : "") + (x.custoDesconhecido ? "Posição do extrato: o banco não indica o custo de compra; usei o valor de mercado — corrige o total se souberes quanto pagaste." : "Posição do extrato (custo de compra indicado pelo banco).");
    if (!r) aviso = (aviso ? aviso + " " : "") + "Símbolo não encontrado: escolhe-o à mão.";
    final.push({tipo:x.tipo, data:x.data, nome:x.nome || (r && r.nomeY) || k, isin:x.isin || "", ticker:x.ticker || "", sym:r ? r.sym : "", tipoY:r ? r.tipoY : "", setorY:r ? r.setorY : "", industriaY:r ? r.industriaY : "",
      qtd:+x.qtd || 0, total:total != null ? Math.round(total * 100) / 100 : 0, bruto:+x.brutoEUR || null, imposto:+x.impostoEUR || 0, moeda:x.moeda || "", aviso});
  }
  return {corretora:String(out.corretora || body.corretora || ""), resumo:String(out.resumo || ""), ignorados:String(out.ignorados || ""), itens:final};
}


/* ============================================================
   CALENDÁRIO: dividendos e resultados
   ============================================================ */
const lisboaDia = (d = new Date()) => new Intl.DateTimeFormat("en-CA", {timeZone:"Europe/Lisbon"}).format(d);
const addDia = (dia, n) => { const [y, m, d] = dia.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const diaDeTs = t => t ? new Date(t * 1000).toISOString().slice(0, 10) : "";
/* cookie + crumb do Yahoo (necessários para datas de resultados e de dividendos anunciados) */
async function yCrumb(env){
  const c = await cacheGet(env, "sys:ycrumb", 12 * 3600e3); if (c) return c.falhou ? null : c;
  try{
    const r1 = await fetch("https://fc.yahoo.com/", {headers:{"user-agent":UA["user-agent"]}, redirect:"manual"});
    const sc = r1.headers.get("set-cookie") || "";
    const cookie = sc.split(/,(?=\s*[A-Za-z0-9_]+=)/).map(x => x.split(";")[0].trim()).filter(x => /^A[13S]=/.test(x)).join("; ");
    if (cookie){
      const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {headers:{"user-agent":UA["user-agent"], cookie}});
      const crumb = (await r2.text()).trim();
      if (r2.ok && crumb && crumb.length < 40 && !/[<{ ]/.test(crumb)){ const o = {cookie, crumb}; await cachePut(env, "sys:ycrumb", o); return o; }
    }
  }catch(e){}
  await cachePut(env, "sys:ycrumb", {falhou:true});   /* não insiste durante 12 h */
  return null;
}
async function eventosYahoo(env, sym){
  const c = await yCrumb(env); if (!c) return null;
  try{
    const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents%2CsummaryDetail&crumb=${encodeURIComponent(c.crumb)}`, {headers:{"user-agent":UA["user-agent"], cookie:c.cookie, accept:"application/json"}});
    if (r.status === 401 || r.status === 403){ await cachePut(env, "sys:ycrumb", {falhou:true}); return null; }
    const j = await r.json(); const q = (((j || {}).quoteSummary || {}).result || [])[0]; if (!q) return null;
    const ce = q.calendarEvents || {}, sd = q.summaryDetail || {};
    const raw = x => x && x.raw ? x.raw : null;
    return {exDiv:diaDeTs(raw(ce.exDividendDate) || raw(sd.exDividendDate)), payDiv:diaDeTs(raw(ce.dividendDate)),
      resultados:((ce.earnings || {}).earningsDate || []).map(x => diaDeTs(raw(x))).filter(Boolean), taxaDiv:raw(sd.dividendRate)};
  }catch(e){ return null; }
}
/* informação de calendário de um ativo (cache 12 h) */
async function calInfo(env, sym, orc){
  const ck = `cal:${sym}`;
  const hit = await cacheGet(env, ck, 12 * 3600e3); if (hit) return hit;
  if (orc && orc.n <= 0) return null;
  if (orc) orc.n -= 2;
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=3mo&events=div`);
  const r = j && j.chart && j.chart.result && j.chart.result[0]; if (!r) return null;
  const m = r.meta || {}, tz = m.exchangeTimezoneName || "UTC", fmt = new Intl.DateTimeFormat("en-CA", {timeZone:tz});
  const divs = Object.values(((r.events || {}).dividends) || {}).filter(d => d && d.amount > 0 && d.date).map(d => [fmt.format(new Date(d.date * 1000)), +(+d.amount).toFixed(6)]).sort((a, b) => a[0].localeCompare(b[0]));
  const ev = /=X$|-(EUR|USD)$/.test(sym) ? null : await eventosYahoo(env, sym);
  const hoje = lisboaDia();
  /* frequência habitual e próximos pagamentos estimados */
  let gap = 0; const prox = [];
  if (divs.length >= 2){
    const gs = []; for (let i = Math.max(1, divs.length - 6); i < divs.length; i++) gs.push((new Date(divs[i][0]) - new Date(divs[i - 1][0])) / 864e5);
    gs.sort((a, b) => a - b); gap = Math.round(gs[Math.floor(gs.length / 2)]);
    const ult = divs[divs.length - 1];
    if (gap >= 20 && (new Date(hoje) - new Date(ult[0])) / 864e5 < gap * 1.8){
      let d = ult[0];
      for (let i = 0; i < 24 && prox.length < Math.ceil(400 / gap); i++){ d = addDia(d, gap); if (d > addDia(hoje, -3)) prox.push({ex:d, valor:ult[1], estimado:true}); }
    }
  }
  if (ev && ev.exDiv && ev.exDiv >= addDia(hoje, -10)){
    const ja = prox.findIndex(p => Math.abs(new Date(p.ex) - new Date(ev.exDiv)) / 864e5 < gap / 2);
    const ult = divs.length ? divs[divs.length - 1][1] : (ev.taxaDiv ? ev.taxaDiv / 4 : 0);
    const anunc = {ex:ev.exDiv, pag:ev.payDiv || "", valor:divs.length && divs[divs.length - 1][0] === ev.exDiv ? divs[divs.length - 1][1] : ult, estimado:false};
    if (ja >= 0) prox[ja] = anunc; else if (!divs.some(d => d[0] === ev.exDiv)) prox.unshift(anunc);
  }
  const out = {sym, moeda:m.currency || "", divs:divs.slice(-12), gap, prox:prox.sort((a, b) => a.ex.localeCompare(b.ex)),
    resultados:ev ? ev.resultados : [], comCalendario:!!ev, quando:Date.now()};
  await cachePut(env, ck, out);
  return out;
}
async function calendario(env, body){
  const syms = [...new Set((body.symbols || []).map(s => String(s).trim()).filter(symOk))].slice(0, 30);
  const orc = {n:40}, cal = {};
  for (const s of syms){ try{ const c = await calInfo(env, s, orc); if (c) cal[s] = c; }catch(e){} }
  return {cal, completo:Object.keys(cal).length === syms.length};
}

/* ============================================================
   COMPOSIÇÃO DE UM ETF (posições, países, setores) — justETF
   ============================================================ */
async function composicao(env, key, body){
  const sym = String(body.sym || "").trim();
  if (!symOk(sym)) throw err("Símbolo inválido.", 400);
  const ck = "comp:" + sym;
  if (!body.forcar){ const hit = await cacheGet(env, ck, 30 * 864e5); if (hit) return hit; }
  await limiteIA(env, key);
  const isin = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(String(body.isin || "")) ? body.isin : "";
  const system = `Descreves a composição de um ETF para uma app de carteira em português de Portugal.
Lê a página do ETF no justETF (justetf.com, página "etf-profile") com a ferramenta web_fetch; se não tiveres o endereço, pesquisa «justETF <nome ou ticker> ISIN» primeiro.
Responde APENAS com JSON:
{"isin":"","nome":"","indice":"","nPosicoes":número,"top":[{"nome":"nome da empresa","ticker":"ticker principal no Yahoo Finance (ex.: AAPL, MSFT, NVDA, ASML.AS, NESN.SW, 2330.TW)","peso":percentagem}],"paises":{"Estados Unidos":percentagem,...},"setores":{"<setor>":percentagem,...},"data":"data dos dados","nota":"1 frase"}
"top": as 10 maiores posições com o peso em %; "paises" e "setores": as percentagens indicadas (o resto em "Outros"). Setores possíveis: ${SETORES.join(", ")}. Nomes de países em português. Não inventes números.`;
  const {out, fontes} = await claude(env, system, `ETF: ${sym} — ${String(body.nome || "").slice(0, 120)}${isin ? `\nPágina no justETF: https://www.justetf.com/pt/etf-profile.html?isin=${isin}` : ""}`, {maxTokens:2500, searches:2, fetches:2, fetchDomains:["justetf.com"]});
  const norm = o => { const r = {}; Object.entries(o || {}).forEach(([k, v]) => { v = +String(v).replace(",", "."); if (v > 0) r[k] = Math.round(v * 10) / 10; }); return r; };
  const setores = {}; Object.entries(norm(out.setores)).forEach(([k, v]) => { const n = SETORES.includes(k) ? k : "Outros"; setores[n] = (setores[n] || 0) + v; });
  const res = {sym, isin:out.isin || isin, nome:String(out.nome || ""), indice:String(out.indice || ""), nPosicoes:+out.nPosicoes || null,
    top:(Array.isArray(out.top) ? out.top : []).filter(x => x && x.nome && +x.peso > 0).slice(0, 15).map(x => ({nome:String(x.nome).slice(0, 60), ticker:String(x.ticker || "").toUpperCase().slice(0, 15), peso:+(+String(x.peso).replace(",", ".")).toFixed(2)})),
    paises:norm(out.paises), setores, data:String(out.data || ""), nota:String(out.nota || ""), fontes:fontes.slice(0, 4), quando:Date.now()};
  await cachePut(env, ck, res);
  return res;
}

/* ============================================================
   CARTEIRA NO SERVIDOR (para alertas e resumo)
   ============================================================ */
function quantidades(st){
  const q = {};
  (st.ops || []).filter(o => o && !o.del && o.tipo !== "dividendo").sort((a, b) => String(a.data).localeCompare(String(b.data))).forEach(o => {
    q[o.sym] = q[o.sym] || 0;
    q[o.sym] = o.tipo === "venda" ? Math.max(0, q[o.sym] - (+o.qtd || 0)) : q[o.sym] + (+o.qtd || 0);
  });
  Object.keys(q).forEach(k => { if (q[k] < 1e-9) delete q[k]; });
  return q;
}
async function precosAgora(env, syms, orc){
  const out = {}, now = Date.now();
  await ensure(env);
  const keys = syms.map(s => `l4:${s}`);
  const pre = new Map();
  for (let i = 0; i < keys.length; i += 90){ const part = keys.slice(i, i + 90); const r = await env.DB.prepare(`SELECT k, v, t FROM cache WHERE k IN (${part.map(() => "?").join(",")})`).bind(...part).all(); (r.results || []).forEach(x => pre.set(x.k, x)); }
  const writes = [];
  for (const s of syms){
    const p = pre.get(`l4:${s}`);
    if (p && now - p.t < 10 * 60e3){ out[s] = JSON.parse(p.v); continue; }
    if (orc.n <= 0){ if (p) out[s] = JSON.parse(p.v); continue; }
    orc.n--;
    try{ const L = await buscarLive(env, s); if (L){ out[s] = L; writes.push([`l4:${s}`, JSON.stringify(L)]); } else if (p) out[s] = JSON.parse(p.v); }catch(e){ if (p) out[s] = JSON.parse(p.v); }
  }
  if (writes.length) await env.DB.batch(writes.map(([k, v]) => env.DB.prepare("INSERT INTO cache (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t").bind(k, v, now)));
  return out;
}
const moedaDe = async (env, sym) => { const c = await cacheGet(env, `cal:${sym}`, 90 * 864e5); if (c && c.moeda) return c.moeda; const r = await env.DB.prepare("SELECT v FROM cache WHERE k LIKE ? ORDER BY t DESC LIMIT 1").bind(`h4:${sym}:%`).first(); const m = r ? /"moeda":"([A-Za-z]*)"/.exec(r.v) : null; return m ? m[1] : ""; };
const paraEUR = (valor, moeda, fx) => { const c = moeda === "GBp" || moeda === "GBX" ? "GBP" : (moeda || "EUR"); const esc = c !== moeda && moeda ? .01 : 1; return c === "EUR" ? valor * esc : valor * esc * (fx[c] || NaN); };
const eurTxt = v => (Math.round((+v || 0) * 100) / 100).toLocaleString("pt-PT", {minimumFractionDigits:2, maximumFractionDigits:2}) + " €";
const pctTxt = v => (v >= 0 ? "+" : "−") + Math.abs(v * 100).toLocaleString("pt-PT", {minimumFractionDigits:1, maximumFractionDigits:1}) + " %";

/* ---------- resumo semanal com IA ---------- */
async function resumoSemanal(env, key, st, viaCron){
  const q = quantidades(st), syms = Object.keys(q);
  if (!syms.length) throw err("Ainda não tens posições.", 400);
  if (!viaCron) await limiteIA(env, key);
  const orc = {n:30};
  const moedas = {}; for (const s of syms) moedas[s] = await moedaDe(env, s);
  const precisaFx = [...new Set(Object.values(moedas).map(m => m === "GBp" || m === "GBX" ? "GBP" : m).filter(m => m && m !== "EUR"))];
  const L = await precosAgora(env, syms.concat(precisaFx.map(c => `${c}EUR=X`)), orc);
  const fx = {}; precisaFx.forEach(c => fx[c] = (L[`${c}EUR=X`] || {}).preco);
  /* preço há uma semana (cache 6 h) */
  const pos = [];
  for (const s of syms){
    let semana = null;
    try{
      const ck = `wk:${s}`; let h = await cacheGet(env, ck, 6 * 3600e3);
      if (!h && orc.n > 0){ orc.n--; const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(s)}?range=1mo&interval=1d`); const r = j.chart.result[0], ts = r.timestamp || [], cl = ((r.indicators.quote || [{}])[0] || {}).close || []; h = ts.map((t, i) => [diaDeTs(t), cl[i]]).filter(x => x[1] != null); await cachePut(env, ck, h); }
      if (h){ const lim = addDia(lisboaDia(), -7); const b = [...h].reverse().find(x => x[0] <= lim); semana = b ? b[1] : null; }
    }catch(e){}
    const p = (L[s] || {}).preco, valor = paraEUR(q[s] * p, moedas[s], fx);
    pos.push({sym:s, nome:((st.ativos || []).find(a => a.id === s) || {}).nome || s, valor, varSemana:semana && p ? p / semana - 1 : null, varDia:(L[s] || {}).anterior ? p / L[s].anterior - 1 : null});
  }
  const tot = pos.reduce((a, p) => a + (isFinite(p.valor) ? p.valor : 0), 0);
  const ini = pos.reduce((a, p) => a + (isFinite(p.valor) && p.varSemana != null ? p.valor / (1 + p.varSemana) : (isFinite(p.valor) ? p.valor : 0)), 0);
  const varSem = ini > 0 ? tot / ini - 1 : 0;
  const dados = pos.filter(p => isFinite(p.valor)).sort((a, b) => b.valor - a.valor).map(p => ({ativo:p.sym, nome:p.nome, pesoPct:+(p.valor / tot * 100).toFixed(1), semanaPct:p.varSemana != null ? +(p.varSemana * 100).toFixed(1) : null}));
  let ia = null, fontes = [];
  if (env.ANTHROPIC_API_KEY){
    try{
      const system = `Escreves o resumo semanal da carteira de investimentos de um investidor particular em Portugal (português europeu, tom claro e próximo, sem jargão).
Recebes as posições com peso e variação da semana. Pesquisa as notícias mais relevantes da semana sobre as maiores posições (resultados, guidance, decisões de bancos centrais que as afetem).
Responde APENAS com JSON: {"titulo":"frase curta (máx. 70 caracteres) para a notificação","resumo":"3-4 frases com o essencial da semana","destaques":[{"ativo":"","texto":"1 frase: o que aconteceu e porquê"}],"atencao":["ponto curto a vigiar na próxima semana (ex.: resultados de X na quinta)"]}
Regras: 3 a 5 destaques; usa só factos que encontraste; não dês ordens de compra ou venda.`;
      const r = await claude(env, system, `Semana até ${lisboaDia()}. Valor da carteira: ${eurTxt(tot)} (${pctTxt(varSem)} na semana).\nPosições (JSON): ${JSON.stringify(dados).slice(0, 6000)}`, {maxTokens:2500, searches:3});
      ia = r.out; fontes = r.fontes.slice(0, 8);
    }catch(e){ ia = null; }
  }
  const melhor = dados.filter(d => d.semanaPct != null).sort((a, b) => b.semanaPct - a.semanaPct);
  const res = {id:lisboaDia(), upd:Date.now(), quando:Date.now(), valor:Math.round(tot * 100) / 100, varSemana:varSem, variacaoEUR:Math.round((tot - ini) * 100) / 100,
    melhor:melhor[0] || null, pior:melhor.length > 1 ? melhor[melhor.length - 1] : null,
    titulo:ia && ia.titulo ? String(ia.titulo).slice(0, 90) : `Carteira ${pctTxt(varSem)} esta semana`,
    resumo:ia ? String(ia.resumo || "") : "", destaques:ia && Array.isArray(ia.destaques) ? ia.destaques.slice(0, 6) : [], atencao:ia && Array.isArray(ia.atencao) ? ia.atencao.slice(0, 5) : [], fontes};
  st.resumos = (st.resumos || []).filter(x => x.id !== res.id).concat(res).sort((a, b) => String(a.id).localeCompare(String(b.id))).slice(-8);
  await putVal(env, key, st);
  return res;
}

/* ============================================================
   NOTIFICAÇÕES: Web Push (RFC 8291 + VAPID RFC 8292)
   ============================================================ */
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); const b = atob(s + "===".slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const cat = (...a) => { const n = a.reduce((x, y) => x + y.length, 0), o = new Uint8Array(n); let i = 0; a.forEach(x => { o.set(x, i); i += x.length; }); return o; };
async function vapid(env){
  let v = await getVal(env, "sys:vapid");
  if (!v){
    const kp = await crypto.subtle.generateKey({name:"ECDSA", namedCurve:"P-256"}, true, ["sign", "verify"]);
    v = {priv:await crypto.subtle.exportKey("jwk", kp.privateKey), pub:b64u(await crypto.subtle.exportKey("raw", kp.publicKey))};
    await putVal(env, "sys:vapid", v);
  }
  return v;
}
async function vapidAuth(env, endpoint){
  const v = await vapid(env), aud = new URL(endpoint).origin;
  const h = b64u(enc.encode(JSON.stringify({typ:"JWT", alg:"ES256"})));
  const c = b64u(enc.encode(JSON.stringify({aud, exp:Math.floor(Date.now() / 1000) + 12 * 3600, sub:"mailto:carteira-app@users.noreply.github.com"})));
  const key = await crypto.subtle.importKey("jwk", v.priv, {name:"ECDSA", namedCurve:"P-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign({name:"ECDSA", hash:"SHA-256"}, key, enc.encode(h + "." + c));
  return `vapid t=${h}.${c}.${b64u(sig)}, k=${v.pub}`;
}
async function hkdf(salt, ikm, info, len){
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name:"HKDF", hash:"SHA-256", salt, info}, k, len * 8));
}
async function cifrar(sub, texto){
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = await crypto.subtle.generateKey({name:"ECDH", namedCurve:"P-256"}, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, {name:"ECDH", namedCurve:"P-256"}, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name:"ECDH", public:uaKey}, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(enc.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv:nonce}, k, cat(enc.encode(texto), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function enviarPush(env, sub, msg){
  const body = await cifrar(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, {method:"POST", headers:{"Authorization":await vapidAuth(env, sub.endpoint), "Content-Encoding":"aes128gcm", "Content-Type":"application/octet-stream", "TTL":"43200", "Urgency":"high"}, body});
  if (r.status === 404 || r.status === 410){ await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(sub.endpoint).run(); return false; }
  if (!r.ok) throw new Error(`Serviço de notificações respondeu ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return true;
}
async function subsDe(env, k){ await ensure(env); const r = await env.DB.prepare("SELECT sub FROM subs WHERE k = ?").bind(k).all(); return (r.results || []).map(x => JSON.parse(x.sub)); }
async function enviarTodos(env, k, msg){
  let n = 0, e1 = null;
  for (const s of await subsDe(env, k)){ try{ if (await enviarPush(env, s, msg)) n++; }catch(e){ e1 = e; } }
  if (!n && e1) throw e1;
  return n;
}

/* ============================================================
   TAREFA PERIÓDICA (cron de 15 em 15 min)
   ============================================================ */
function lisboa(d = new Date()){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone:"Europe/Lisbon", year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", weekday:"short", hourCycle:"h23"}).formatToParts(d).map(x => [x.type, x.value]));
  return {dia:`${p.year}-${p.month}-${p.day}`, min:(+p.hour) * 60 + (+p.minute), dow:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday)};
}
const NOTIF_DEF = {variacao:5, alertas:true, dividendos:true, resultados:true, resumo:true, resumoHora:"19:00"};
const dmTxt = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "";
async function avisosDe(env, k, st, L, orc){
  const cfg = Object.assign({}, NOTIF_DEF, (st.cfg || {}).notif || {}), out = [], mud = {alertas:false};
  const q = quantidades(st);
  const alertas = (st.alertas || []).filter(a => a && !a.del && !a.disparado && a.sym && +a.preco > 0);
  const syms = [...new Set(Object.keys(q).concat(cfg.alertas ? alertas.map(a => a.sym) : []))];
  if (!syms.length) return {out, mud};
  const moedas = {}; for (const s of Object.keys(q)) moedas[s] = await moedaDe(env, s);
  const precisaFx = [...new Set(Object.values(moedas).map(m => m === "GBp" || m === "GBX" ? "GBP" : m).filter(m => m && m !== "EUR"))];
  const P = await precosAgora(env, syms.concat(precisaFx.map(c => `${c}EUR=X`)), orc);
  const fx = {}; precisaFx.forEach(c => fx[c] = (P[`${c}EUR=X`] || {}).preco);
  const nome = s => ((st.ativos || []).find(a => a.id === s) || {}).nome || s;
  /* alertas de preço */
  if (cfg.alertas) alertas.forEach(a => {
    const p = (P[a.sym] || {}).preco; if (!(p > 0)) return;
    if ((a.cond === "abaixo" && p <= +a.preco) || (a.cond !== "abaixo" && p >= +a.preco)){
      out.push({id:`al:${a.id}`, title:`${a.sym} ${a.cond === "abaixo" ? "desceu abaixo de" : "subiu acima de"} ${(+a.preco).toLocaleString("pt-PT")}`, body:`Está agora a ${p.toLocaleString("pt-PT", {maximumFractionDigits:2})}. ${a.nota ? a.nota : nome(a.sym)}`, url:`./#analise/${encodeURIComponent(a.sym)}`, tag:"alerta-" + a.id});
      a.disparado = true; a.quando = Date.now(); a.upd = Date.now(); mud.alertas = true;
    }
  });
  /* variação forte do dia nas posições */
  if (+cfg.variacao > 0 && L.min >= 8 * 60 && L.min < 23 * 60) Object.keys(q).forEach(s => {
    const x = P[s]; if (!x || !(x.anterior > 0) || !(x.preco > 0)) return;
    const v = x.preco / x.anterior - 1;
    if (Math.abs(v) * 100 >= +cfg.variacao){
      const efeito = paraEUR(q[s] * (x.preco - x.anterior), moedas[s], fx);
      out.push({id:`vr:${s}:${L.dia}:${v > 0 ? "s" : "d"}`, title:`${s} ${v > 0 ? "sobe" : "desce"} ${pctTxt(v).replace("+", "").replace("−", "")} hoje`, body:`${nome(s)}${isFinite(efeito) ? ` · na tua posição: ${efeito >= 0 ? "+" : "−"}${eurTxt(Math.abs(efeito))}` : ""}${x.sessao ? ` (${x.sessao})` : ""}`, url:`./#analise/${encodeURIComponent(s)}`, tag:"var-" + s});
    }
  });
  /* dividendos e resultados (uma vez por dia, de manhã até à noite) */
  if ((cfg.dividendos || cfg.resultados) && L.min >= 8 * 60 && L.min < 22 * 60){
    for (const s of Object.keys(q)){
      let c = null; try{ c = await calInfo(env, s, orc); }catch(e){}
      if (!c) continue;
      if (cfg.dividendos){
        const qtd = q[s], vEUR = v => paraEUR(qtd * v, c.moeda || moedas[s], fx);
        /* data ex hoje (anunciada): o dividendo fica garantido */
        c.prox.filter(p => !p.estimado && p.ex === L.dia).forEach(p => { const e = vEUR(p.valor); out.push({id:`dx:${s}:${p.ex}`, title:`Dividendo de ${s} garantido`, body:`Hoje é a data ex-dividendo: vais receber cerca de ${isFinite(e) ? eurTxt(e) : "?"} (bruto)${p.pag ? `, pagos a ${dmTxt(p.pag)}` : ""}.`, url:"./#dividendos", tag:"div-" + s}); });
        /* dia do pagamento */
        c.prox.filter(p => p.pag === L.dia).forEach(p => { const e = vEUR(p.valor); out.push({id:`dp:${s}:${p.pag}`, title:`Dividendo de ${s} a entrar hoje`, body:`Cerca de ${isFinite(e) ? eurTxt(e) : "?"} brutos (antes de impostos). Regista o valor líquido na app quando entrar.`, url:"./#dividendos", tag:"div-" + s}); });
        /* sem calendário: dividendo novo no histórico (últimos 4 dias) */
        if (!c.comCalendario) c.divs.filter(d => d[0] >= addDia(L.dia, -4) && d[0] <= L.dia).forEach(d => { const e = vEUR(d[1]); out.push({id:`dh:${s}:${d[0]}`, title:`${s} paga dividendo`, body:`${d[1].toLocaleString("pt-PT")} ${c.moeda} por ação (data ex ${dmTxt(d[0])}): cerca de ${isFinite(e) ? eurTxt(e) : "?"} brutos para ti.`, url:"./#dividendos", tag:"div-" + s}); });
      }
      if (cfg.resultados && c.resultados && c.resultados.length){
        const amanha = addDia(L.dia, 1);
        c.resultados.filter(d => d === amanha || d === L.dia).forEach(d => out.push({id:`er:${s}:${d}:${d === L.dia ? 0 : 1}`, title:`${s} apresenta resultados ${d === L.dia ? "hoje" : "amanhã"}`, body:`${nome(s)}: costuma haver mais variação no preço nesse dia.`, url:`./#analise/${encodeURIComponent(s)}`, tag:"res-" + s}));
      }
    }
  }
  return {out, mud};
}
async function tick(env){
  if (!env.DB) return;
  await ensure(env);
  const L = lisboa();
  const subs = (await env.DB.prepare("SELECT k, sub FROM subs").all()).results || [];
  const porK = {}; subs.forEach(s => (porK[s.k] = porK[s.k] || []).push(JSON.parse(s.sub)));
  const orc = {n:40};
  for (const k of Object.keys(porK)){
    const st = await getVal(env, k); if (!st) continue;
    const cfg = Object.assign({}, NOTIF_DEF, (st.cfg || {}).notif || {});
    /* resumo de domingo */
    const [hh, mm] = String(cfg.resumoHora || "19:00").split(":").map(Number), alvo = (hh || 19) * 60 + (mm || 0);
    if (cfg.resumo && L.dow === 0 && L.min >= alvo && L.min < alvo + 180){
      const id = k.slice(3, 15) + ":rs:" + L.dia;
      if (!(await env.DB.prepare("SELECT 1 FROM enviados WHERE id = ?").bind(id).first())){
        await env.DB.prepare("INSERT OR IGNORE INTO enviados (id, t) VALUES (?, ?)").bind(id, Date.now()).run();
        try{
          const r = await resumoSemanal(env, k, st, true);
          for (const s of porK[k]){ try{ await enviarPush(env, s, {title:r.titulo, body:`${eurTxt(r.valor)} · ${pctTxt(r.varSemana)} (${r.variacaoEUR >= 0 ? "+" : "−"}${eurTxt(Math.abs(r.variacaoEUR))}) esta semana. Toca para ler o resumo.`, url:"./#sugestoes", tag:"resumo"}); }catch(e){} }
        }catch(e){}
        continue;   /* o resumo usa os pedidos todos deste ciclo */
      }
    }
    let r;
    try{ r = await avisosDe(env, k, st, L, orc); }catch(e){ continue; }
    for (const n of r.out){
      const id = k.slice(3, 15) + ":" + n.id;
      if (await env.DB.prepare("SELECT 1 FROM enviados WHERE id = ?").bind(id).first()) continue;
      await env.DB.prepare("INSERT OR IGNORE INTO enviados (id, t) VALUES (?, ?)").bind(id, Date.now()).run();
      for (const s of porK[k]){ try{ await enviarPush(env, s, n); }catch(e){} }
    }
    if (r.mud.alertas) await putVal(env, k, st);
  }
  if (L.min < 15) await env.DB.prepare("DELETE FROM enviados WHERE t < ?").bind(Date.now() - 60 * 864e5).run();
}

/* ---------- pedidos ---------- */
export default {
  async scheduled(event, env, ctx){ ctx.waitUntil(tick(env)); },
  async fetch(req, env){
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {status:204, headers:CORS});
    try{
      if (req.method === "GET") return json({ok:true, app:"carteira-api", versao:2, ia:!!env.ANTHROPIC_API_KEY, base:env.DB ? "D1" : "nenhuma"});
      if (req.method !== "POST") return json({error:"Método não suportado."}, 405);
      const body = await req.json().catch(() => null);
      if (!body) return json({error:"Pedido inválido."}, 400);
      const code = String(body.code || "").trim();
      if (code.length < 12) return json({error:"Código pessoal inválido (mínimo 12 caracteres)."}, 401);
      const key = "st:" + await sha(code);
      const p = url.pathname;

      if (p === "/api/sync"){
        const stored = await getVal(env, key);
        const merged = merge(stored, body.data);
        if (JSON.stringify(merged) !== JSON.stringify(stored)) await putVal(env, key, merged);
        return json({data:merged});
      }
      /* o resto só funciona para códigos que já sincronizaram (evita uso por estranhos) */
      if (!(await getVal(env, key))) return json({error:"Sincroniza primeiro este código pessoal."}, 403);
      if (p === "/api/precos") return await precos(env, body);
      if (p === "/api/pesquisa") return json(await pesquisa(env, body));
      if (p === "/api/classificar") return json(await classificar(env, key, body));
      if (p === "/api/analisar"){
        const r = await analisar(env, key, body);
        const st = await getVal(env, key);
        if (st){ const lista = (st.analises || []).filter(x => x.id !== r.sym); lista.push(Object.assign({id:r.sym}, r, {upd:Date.now()})); st.analises = lista.slice(-40); await putVal(env, key, st); }
        return json(r);
      }
      if (p === "/api/sugestoes"){
        const r = await sugestoes(env, key, body);
        const st = await getVal(env, key);
        if (st){ st.sugestoes = r; await putVal(env, key, st); }
        return json(r);
      }
      if (p === "/api/importar") return json(await importar(env, key, body));
      if (p === "/api/calendario") return json(await calendario(env, body));
      if (p === "/api/composicao") return json(await composicao(env, key, body));
      if (p === "/api/resumo") return json(await resumoSemanal(env, key, await getVal(env, key), false));
      if (p.startsWith("/api/push/")){
        await ensure(env);
        const acao = p.slice(10);
        if (acao === "chave") return json({chave:(await vapid(env)).pub});
        if (acao === "registar"){
          const sub = body.sub || {};
          if (!/^https:\/\//.test(sub.endpoint || "") || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return json({error:"Subscrição inválida."}, 400);
          await env.DB.prepare("INSERT INTO subs (endpoint, k, sub, nome, upd) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET k = excluded.k, sub = excluded.sub, nome = excluded.nome, upd = excluded.upd").bind(sub.endpoint, key, JSON.stringify({endpoint:sub.endpoint, keys:{p256dh:sub.keys.p256dh, auth:sub.keys.auth}}), String(body.nome || "").slice(0, 40), Date.now()).run();
          return json({ok:true});
        }
        if (acao === "remover"){ await env.DB.prepare("DELETE FROM subs WHERE endpoint = ? AND k = ?").bind(String(body.endpoint || ""), key).run(); return json({ok:true}); }
        if (acao === "estado"){ const r = await env.DB.prepare("SELECT nome, upd FROM subs WHERE k = ?").bind(key).all(); return json({aparelhos:r.results || []}); }
        if (acao === "teste"){ const n = await enviarTodos(env, key, {title:"Carteira · notificações ligadas", body:"É assim que vão aparecer os alertas de preço, os dividendos e o resumo de domingo.", url:"./#painel", tag:"teste"}); return json({ok:true, enviados:n}); }
        if (acao === "verificar"){ const st = await getVal(env, key); const r = await avisosDe(env, key, st, lisboa(), {n:30}); return json({avisos:r.out}); }
        return json({error:"Endereço desconhecido."}, 404);
      }
      return json({error:"Endereço desconhecido."}, 404);
    }catch(e){
      return json({error:String(e.message || e)}, e.status || 500);
    }
  }
};
