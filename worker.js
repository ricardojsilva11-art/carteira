/* ============================================================
   Carteira — servidor (Cloudflare Worker «carteira-api»)
   - GET  /               estado do servidor
   - POST /api/sync       junta e guarda os dados (PC ↔ iPhone)
   - POST /api/precos     preços e histórico (Yahoo Finance) + câmbios para euros
   - POST /api/pesquisa   procura ativos (ações, ETFs, REITs, cripto)
   - POST /api/classificar  setores e tipo de um ativo (ETFs com IA)
   - POST /api/analisar   análise técnica + fundamental com IA e pesquisa na web
   - POST /api/sugestoes  sugestões de investimento para a carteira (IA + web)
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
    env.DB.prepare("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL)")
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
async function chart(env, sym, range){
  const ck = `ch:${sym}:${range}`;
  const hit = await cacheGet(env, ck, range === "5d" ? 3 * 60e3 : 10 * 60e3);
  if (hit) return hit;
  const j = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d&includePrePost=false&events=div%2Csplit`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw err(`Ativo «${sym}» não encontrado.`, 404);
  const m = r.meta || {}, q = ((r.indicators || {}).quote || [{}])[0] || {}, ts = r.timestamp || [];
  const tz = m.exchangeTimezoneName || "UTC";
  const dayOf = t => new Intl.DateTimeFormat("en-CA", {timeZone:tz}).format(new Date(t * 1000));
  const hist = [];
  ts.forEach((t, i) => { const c = q.close && q.close[i]; if (c != null && isFinite(c)) hist.push([dayOf(t), +c.toFixed(6), q.high && q.high[i] != null ? +(+q.high[i]).toFixed(6) : c, q.low && q.low[i] != null ? +(+q.low[i]).toFixed(6) : c, q.volume && q.volume[i] || 0]); });
  /* um dia pode aparecer duas vezes (barra do dia em curso): fica a última */
  const byDay = new Map(); hist.forEach(h => byDay.set(h[0], h));
  const h2 = [...byDay.values()];
  const price = +(m.regularMarketPrice != null ? m.regularMarketPrice : (h2.length ? h2[h2.length - 1][1] : 0));
  const today = m.regularMarketTime ? dayOf(m.regularMarketTime) : (h2.length ? h2[h2.length - 1][0] : "");
  const prevBar = [...h2].reverse().find(h => h[0] < today);
  const out = {sym:m.symbol || sym, nome:m.longName || m.shortName || sym, moeda:m.currency || "", tipoY:m.instrumentType || "", bolsa:m.fullExchangeName || m.exchangeName || "",
    preco:price, anterior:prevBar ? prevBar[1] : (m.chartPreviousClose || price), dia:today, max52:m.fiftyTwoWeekHigh || null, min52:m.fiftyTwoWeekLow || null, hist:h2};
  await cachePut(env, ck, out);
  return out;
}
/* converte para euros: GBp (pence) → GBP/100; outras moedas pelo par XXXEUR=X */
async function precos(env, body){
  const syms = [...new Set((body.symbols || []).map(s => String(s).trim()).filter(symOk))].slice(0, 60);
  const range = ["5d","1mo","6mo","1y","2y","5y","10y","max"].includes(body.range) ? body.range : "1y";
  const out = {}, erros = {};
  await Promise.all(syms.map(async s => { try{ out[s] = await chart(env, s, range); }catch(e){ erros[s] = e.message; } }));
  const moedas = new Set(Object.values(out).map(x => x.moeda === "GBp" || x.moeda === "GBX" ? "GBP" : x.moeda).filter(c => c && c !== "EUR"));
  const fx = {EUR:{preco:1, hist:[]}};
  await Promise.all([...moedas].map(async c => {
    try{ const r = await chart(env, `${c}EUR=X`, range); fx[c] = {preco:r.preco, hist:r.hist.map(h => [h[0], h[1]])}; }
    catch(e){ erros[`${c}EUR`] = "Câmbio indisponível: " + e.message; }
  }));
  return {precos:out, fx, erros, quando:Date.now()};
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
async function claude(env, system, prompt, {maxTokens = 4000, searches = 0} = {}){
  if (!env.ANTHROPIC_API_KEY) throw err("A IA ainda não está ligada no servidor: falta a chave ANTHROPIC_API_KEY.", 501);
  const messages = [{role:"user", content:prompt}];
  const tools = searches ? [{type:"web_search_20250305", name:"web_search", max_uses:searches}] : undefined;
  const fontes = new Map();
  let texto = "";
  for (let volta = 0; volta < 4; volta++){
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"x-api-key":apiKey(env), "anthropic-version":"2023-06-01", "content-type":"application/json"},
      body:JSON.stringify(Object.assign({model:env.MODEL || "claude-sonnet-5-5", max_tokens:maxTokens, system, messages}, tools ? {tools} : {}))
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw err("A IA respondeu com erro: " + ((j.error && j.error.message) || r.status), 502);
    (j.content || []).forEach(c => {
      if (c.type === "web_search_tool_result" && Array.isArray(c.content)) c.content.forEach(x => x && x.url && !fontes.has(x.url) && fontes.set(x.url, {titulo:x.title || x.url, url:x.url}));
      if (c.type === "text"){ texto += c.text; (c.citations || []).forEach(x => x && x.url && !fontes.has(x.url) && fontes.set(x.url, {titulo:x.title || x.url, url:x.url})); }
    });
    if (j.stop_reason !== "pause_turn") break;
    messages.push({role:"assistant", content:j.content});
  }
  const a = texto.indexOf("{"), b = texto.lastIndexOf("}");
  let out;
  try{ out = JSON.parse(texto.slice(a, b + 1)); }catch(e){ throw err("Não consegui interpretar a resposta da IA. Tenta outra vez.", 502); }
  return {out, fontes:[...fontes.values()]};
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
 "oportunidades":["ponto curto"]}
Regras: usa só números que encontraste ou que te foram dados; se não encontrares, escreve "n/d"; 4 a 8 métricas adequadas ao tipo de ativo; não dês ordens de compra ou venda, descreve o cenário.`;
  const prompt = `Ativo: ${sym} — ${String(body.nome || "").slice(0, 120)} (${String(body.tipo || "")}). Moeda: ${String(body.moeda || "")}.
Indicadores técnicos calculados pela app (JSON): ${JSON.stringify(body.ind || {}).slice(0, 4000)}
Posição do investidor neste ativo (JSON, pode estar vazia): ${JSON.stringify(body.posicao || {}).slice(0, 1000)}
Hoje é ${lisbonDay()}.`;
  const {out, fontes} = await claude(env, system, prompt, {maxTokens:4000, searches:5});
  const res = {sym, quando:Date.now(), resumo:String(out.resumo || ""), sinalTecnico:out.sinalTecnico || "neutro", sinalFundamental:out.sinalFundamental || "neutro", tecnica:String(out.tecnica || ""),
    metricas:(out.metricas || []).slice(0, 10), fundamental:String(out.fundamental || ""), consenso:String(out.consenso || ""), riscos:(out.riscos || []).slice(0, 6), oportunidades:(out.oportunidades || []).slice(0, 6), fontes:fontes.slice(0, 10)};
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
 "ideias":[{"titulo":"curto","sym":"símbolo do Yahoo Finance (ex.: VWCE.DE, AAPL, O, BTC-EUR, IWDA.AS)","nome":"nome do ativo","tipo":"Ação|ETF|REIT|Cripto|Obrigações","porque":"2-3 frases concretas ligadas à carteira","tecnica":"1 frase sobre o gráfico","fundamental":"1 frase com dados","risco":"baixo|médio|alto","confianca":número 0-100,"efeito":"o que muda na carteira (ex.: Tecnologia de 41% para 36%)"}]}
Regras: 4 a 6 ideias diferentes; prefere ativos acessíveis a um investidor europeu (ETFs UCITS em bolsas europeias quando for ETF); respeita o perfil de risco; não inventes números; não garantas rentabilidades; descreve, não ordenes.`;
  const prompt = `Carteira (JSON): ${JSON.stringify(body.carteira || {}).slice(0, 20000)}
Perfil do investidor: ${JSON.stringify(body.perfil || {}).slice(0, 500)}
Hoje é ${lisbonDay()}.`;
  const {out, fontes} = await claude(env, system, prompt, {maxTokens:5000, searches:8});
  return {quando:Date.now(), upd:Date.now(), resumo:String(out.resumo || ""), alertas:(out.alertas || []).slice(0, 6), ideias:(out.ideias || []).slice(0, 8), fontes:fontes.slice(0, 12)};
}

/* ---------- pedidos ---------- */
export default {
  async fetch(req, env){
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, {status:204, headers:CORS});
    try{
      if (req.method === "GET") return json({ok:true, app:"carteira-api", versao:1, ia:!!env.ANTHROPIC_API_KEY, base:env.DB ? "D1" : "nenhuma"});
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
      if (p === "/api/precos") return json(await precos(env, body));
      if (p === "/api/pesquisa") return json(await pesquisa(env, body));
      if (p === "/api/classificar") return json(await classificar(env, key, body));
      if (p === "/api/analisar") return json(await analisar(env, key, body));
      if (p === "/api/sugestoes") return json(await sugestoes(env, key, body));
      return json({error:"Endereço desconhecido."}, 404);
    }catch(e){
      return json({error:String(e.message || e)}, e.status || 500);
    }
  }
};
