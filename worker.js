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
async function chart(env, sym, range, ctx){
  const ck = `ch3:${sym}:${range}`, maxAge = range === "5d" ? 3 * 60e3 : 10 * 60e3;
  if (ctx && ctx.pre){ const r = ctx.pre.get(ck); if (r && Date.now() - r.t < maxAge) return JSON.parse(r.v); }
  else { const hit = await cacheGet(env, ck, maxAge); if (hit) return hit; }
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
  let price = +(m.regularMarketPrice != null ? m.regularMarketPrice : (h2.length ? h2[h2.length - 1][1] : 0));
  const today = m.regularMarketTime ? dayOf(m.regularMarketTime) : (h2.length ? h2[h2.length - 1][0] : "");
  const prevBar = [...h2].reverse().find(h => h[0] < today);
  /* preço de agora: o histórico diário às vezes falha dias (ETFs em Londres) e não tem pré-abertura/após-fecho */
  let anterior = prevBar ? prevBar[1] : (m.chartPreviousClose || price), sessao = "", hora = m.regularMarketTime || 0;
  if (!/=X$/.test(sym)){
    try{
      const jl = await yahoo(`/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=5m&includePrePost=true`);
      const rl = jl && jl.chart && jl.chart.result && jl.chart.result[0];
      if (rl){
        const ml = rl.meta || {}, tl = rl.timestamp || [], cl = (((rl.indicators || {}).quote || [{}])[0] || {}).close || [];
        if (ml.regularMarketPrice != null) price = +ml.regularMarketPrice;
        if (ml.chartPreviousClose != null) anterior = +ml.chartPreviousClose;
        if (ml.regularMarketTime) hora = ml.regularMarketTime;
        let lt = null, lp = null;
        for (let i = tl.length - 1; i >= 0; i--) if (cl[i] != null && isFinite(cl[i])){ lt = tl[i]; lp = +cl[i]; break; }
        const reg = (ml.currentTradingPeriod || {}).regular || {};
        if (lt && ml.regularMarketTime && lt > ml.regularMarketTime + 120 && lp > 0){
          price = lp; hora = lt;
          sessao = reg.start && lt < reg.start ? "pré-abertura" : "após fecho";
        }
      }
    }catch(e){ /* fica o preço do histórico diário */ }
  }
  const divs = Object.values(((r.events || {}).dividends) || {}).filter(d => d && d.amount > 0 && d.date).map(d => [dayOf(d.date), +(+d.amount).toFixed(6)]).sort((a, b) => a[0].localeCompare(b[0]));
  const out = {divs, sym:m.symbol || sym, nome:m.longName || m.shortName || sym, moeda:m.currency || "", tipoY:m.instrumentType || "", bolsa:m.fullExchangeName || m.exchangeName || "",
    preco:price, anterior, sessao, hora, dia:today, max52:m.fiftyTwoWeekHigh || null, min52:m.fiftyTwoWeekLow || null, hist:h2};
  if (ctx && ctx.writes) ctx.writes.push([ck, JSON.stringify(out)]);
  else await cachePut(env, ck, out);
  return out;
}
/* converte para euros: GBp (pence) → GBP/100; outras moedas pelo par XXXEUR=X */
async function precos(env, body){
  const syms = [...new Set((body.symbols || []).map(s => String(s).trim()).filter(symOk))].slice(0, 60);
  const range = ["5d","1mo","6mo","1y","2y","5y","10y","max"].includes(body.range) ? body.range : "1y";
  const out = {}, erros = {};
  /* uma só leitura da cache para todos os ativos e câmbios (limite de consultas por pedido) */
  await ensure(env);
  const moedasProv = ["USD","GBP","CHF","JPY","CAD","AUD","DKK","SEK","NOK","HKD"].map(c => `ch3:${c}EUR=X:${range}`);
  const keys = syms.map(s => `ch3:${s}:${range}`).concat(moedasProv);
  const pre = new Map();
  for (let i = 0; i < keys.length; i += 90){
    const part = keys.slice(i, i + 90);
    const r = await env.DB.prepare(`SELECT k, v, t FROM cache WHERE k IN (${part.map(() => "?").join(",")})`).bind(...part).all();
    (r.results || []).forEach(x => pre.set(x.k, x));
  }
  const ctx = {pre, writes:[]};
  await Promise.all(syms.map(async s => { try{ out[s] = await chart(env, s, range, ctx); }catch(e){ erros[s] = e.message; } }));
  const moedas = new Set(Object.values(out).map(x => x.moeda === "GBp" || x.moeda === "GBX" ? "GBP" : x.moeda).filter(c => c && c !== "EUR"));
  const fx = {EUR:{preco:1, hist:[]}};
  await Promise.all([...moedas].map(async c => {
    try{ const r = await chart(env, `${c}EUR=X`, range, ctx); fx[c] = {preco:r.preco, hist:r.hist.map(h => [h[0], h[1]])}; }
    catch(e){ erros[`${c}EUR`] = "Câmbio indisponível: " + e.message; }
  }));
  if (ctx.writes.length){
    const now = Date.now();
    await env.DB.batch(ctx.writes.map(([k, v]) => env.DB.prepare("INSERT INTO cache (k, v, t) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t").bind(k, v, now)));
  }
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
  const {out, fontes} = await claude(env, system, prompt, {maxTokens:6000, searches:5, fetches:4, fetchDomains:["justetf.com"]});
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
      return json({error:"Endereço desconhecido."}, 404);
    }catch(e){
      return json({error:String(e.message || e)}, e.status || 500);
    }
  }
};
