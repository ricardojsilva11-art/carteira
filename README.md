# Carteira

App pessoal para acompanhar investimentos (ações, ETFs, REITs e cripto), sincronizada entre PC e iPhone.

- Valor de cada posição atualizado automaticamente com o preço de mercado (Yahoo Finance) e convertido para euros.
- Ganho/perda total, do dia e realizado em vendas; evolução da carteira face ao valor investido.
- Exposição por setor (incluindo o interior dos ETFs), por classe de ativo, por ativo e por moeda, com alertas de concentração.
- Análise técnica (médias de 50/200 dias, RSI, MACD, suportes e resistências, volatilidade).
- Análise fundamental e sugestões de investimento com IA (Claude com pesquisa na web, com fontes).
- Dividendos: histórico detetado automaticamente, registo do valor líquido recebido, previsão para 12 meses e rendimento.
- Análise e sugestões de ETFs com dados lidos no justETF (TER, tamanho, replicação, distribuição, rentabilidade).
- Importação de extratos de corretoras (CSV, Excel, PDF ou imagem) com revisão antes de guardar.
- Exposição real por dentro dos ETFs (empresas e países), plano de investimento com distribuição alvo e sugestão mensal a partir do vencimento (via app dia.).
- Rentabilidade ponderada no tempo, TIR anual e comparação com o MSCI World / S&P 500 / FTSE All-World.
- Separação por corretora, lista de ativos a seguir, calendário de dividendos e resultados, resumo semanal com IA.
- Notificações (Web Push): alertas de preço, variações fortes, dividendos (data ex e pagamento), resultados e resumo de domingo.
- Avisos de dados em falta (extratos por importar, compras repetidas, vendas sem compra, dividendos por registar).
- Tema claro e escuro; instalável no ecrã principal do iPhone.

## Ficheiros

| Ficheiro | O que é |
|---|---|
| `index.html` | A app (GitHub Pages) |
| `worker.js` | O servidor (Cloudflare Worker `carteira-api`) |
| `manifest.webmanifest`, `icon-*.png` | Instalação no telemóvel |

## Servidor (Cloudflare)

1. Workers & Pages › Create › Worker, com o nome `carteira-api`. Em «Edit code» cola o conteúdo de `worker.js` e faz Deploy.
2. Settings › Bindings › Add › D1 database: nome da variável `DB`, base de dados `carteira`.
3. Settings › Variables and Secrets › Add › Secret: `ANTHROPIC_API_KEY` com a chave da API da Anthropic.
4. Settings › Trigger events › Cron Triggers › Add: `*/15 * * * *` (notificações automáticas e resumo de domingo).
5. Opcional: `IA_LIMITE_DIA` (por omissão 40 pedidos de IA por dia) e `MODEL` (por omissão `claude-sonnet-5-5`).

Abrir `https://carteira-api.<subdomínio>.workers.dev` no browser deve mostrar `"ok":true` e `"ia":true`.

## Na app

Definições › endereço do servidor e código pessoal (botão «Gerar»). Usa o mesmo código no PC e no iPhone.

As análises e sugestões são geradas automaticamente a partir de fontes públicas e não são aconselhamento financeiro.
