# Build público (`PUBLIC=1`) — plano

Data: 2026-10-26. Base: extensão 1.17.2, hub 0.62.0.

Objetivo: um build open-source da extensão para colegas, com **zero conexão a backend** e
**sem o recurso de aquecer**, em que o rastreio de contas (spy) roda 100% local, com um
painel em página própria da extensão (`dashboard.html`) além do sidepanel.

Mesmo código, uma flag. O repo público é **exportado** do privado (o código-fonte privado
continua tendo hub e warm; o export é que os remove).

---

## 1. O que a análise encontrou (medido)

### Dois backends, não um
- **Hub** (`socialmate.rheav.dev`): `syncClient.js`, `hubStatus`, `analysisRelay` (WebSocket),
  `analysisCollect` (upload de MP4 para análise), `spyStories` (upload de stories), push do Arquivo.
- **Instagram Scraper** (`localhost:3001`, app privado): `igExport`, `igOutbox`, `igPresence`,
  `igDestinations`, `igExportFormat`, `useIgDestinations`.

### O spy hoje não funciona sem o hub
- A lista de perfis vem do hub (`getSpyProfiles`); sem hub, `scheduleSpy` desliga o alarme e
  `spyTick` responde "acervo não configurado" (`src/background/spy.js:189-240`, `:1371`).
- Toda leitura vai só para a fila de upload; a extensão não mostra nenhum número.
- O hub decide quais thumbs quer (`wantThumbs`), devolve config de stories e `viewsReadAt`.

### O lado servidor do spy é portável
- Sem dependência de LLM, embeddings, FTS, ffmpeg ou R2. Só stories usam filesystem.
- Puro TS, copia como está: `shared/spy-metrics.ts` (39), `shared/spy-trends.ts` (225),
  `buildCard`/deltas/`subtractDays` (~350 de `server/spy.ts`), `rankRows`, `viewsWindows`,
  `healthStatus`, `parseStory`.
- Reescrever SQL → JS sobre IndexedDB: `spy.ts` (1460), `spyPosts` (405), `spyReels` (295),
  `spyViews` (233), `spyTopPosts` (259), `spyTrends` (29), `spyStories` (489).
- **O hub tem 20 arquivos de teste spy** (`tests/spy-*.test.ts`). Viram a suíte de contrato do
  store local: mesmo input, mesmo output.

### O painel spy do hub é portável quase como está
- Mesmo React 19, mesmo Tailwind 4.3, mesmo `theme/nord.css` (idêntico).
- Toda chamada de rede passa por `src/dashboard/api.ts`. Trocar por um adaptador local com a
  mesma forma deixa os componentes intactos.
- Diferenças: tema escuro padrão no hub vs claro na extensão (troca `theme.ts`, 18 LOC); `recharts`
  e `motion` entram como deps novas (recharts já é lazy); URLs de avatar/thumb viram `blob:`/`data:`;
  polling de 15 s vira `chrome.storage.onChanged`.

### O que não vem (depende de LLM/Mac/servidor)
Relatórios de IA (top diário, reel, hooks, stories, perfil, pauta, dia-a-dia), worker do Mac,
login/2FA, backup R2, relay. ~10 mil LOC de UI ficam só no privado.

### Warm
Motor inteiro em `src/content.js` (2679 linhas) + `WarmTool`, `sessionMath`, `uiPrefs`,
`OptionsDropdown`, modos A/B/C em `platforms.jsx`, badge da action, `FBW_RELEVANCE` +
`relevance.worker.js` + modelo MiniLM (23 MB em `public/models`), listener de auto-capture em
`inject.js:1524-1573`, chaves `fbw_session`/`fbw_history`/`fbw_last_summary`/`fbw_seen`/`swOptions`/`sw_ui_prefs`.

### Rede no build público
Sem telemetria/analytics. Modelos e WASM já são locais (`allowRemoteModels = false`). Depois dos
cortes, só sobra tráfego para as próprias plataformas e CDNs, com a sessão do usuário.

### Flag (medido num build de teste, Vite 8.0.16)
- `define: { __PUBLIC__ }` chega no SW, no painel **e** nos content scripts (CRXJS minifica tudo
  no mesmo build). Blocos `if (!__PUBLIC__)` e helpers inline que ficam sem uso somem.
- **Módulo com efeito colateral no topo continua no bundle** mesmo sem uso (`spy.js:1485` registra
  listener; `background.js:90-159` instancia tudo no topo). Por isso: alias para stub, não só tree-shaking.

---

## 2. Decisões (minha recomendação; confirmar antes da fase indicada)

| # | Decisão | Recomendação | Antes da fase |
|---|---|---|---|
| D1 | Painel portado em TSX ou converter para JSX | **Manter `.tsx`** isolado em `src/dashboard/` (Vite transpila; zero trabalho de conversão; fica fácil puxar correções do hub) | F3 |
| D2 | Stories no build público | **Fase opcional (F4)**: ~65 MB por perfil rastreado com 7 dias guardados | F4 |
| D3 | Fuso fixo GMT-3 do hub | **Fuso do navegador** no público | F2 |
| D4 | Nome e ícone (marca "socialMate", chama = aquecimento) | Nome novo + ícone novo no público | F5 |
| D5 | Licença | MIT, **se** a licença do ffmpeg core e do modelo UVR-MDX permitir; senão GPL ou tirar esses do público | F5 |
| D6 | Modelos/WASM (~224 MB em `public/`) no repo público | Script `setup` que baixa/copia, fora do git | F5 |
| D7 | Acervo + busca semântica no painel | Fora do escopo (pedido foi rastreio); dá para adicionar depois, o MiniLM já está na extensão | — |
| D8 | Relatórios com chave própria (BYO key) | Fora. Seria chamada a terceiro; só como opt-in futuro | — |

---

## 3. Arquitetura alvo

```
vite.config.js      PUBLIC=1 → define __PUBLIC__=true, outDir dist-public,
                    alias @private → src/private/stub.js, plugin remove MiniLM do dist
manifest.config.js  variante pública: sem src/content.js, sem alarms? (ver F2), sem hosts
                    do hub/localhost, sem optional https://*/*, descrição nova
src/private/        tudo que só existe no privado (hub, scraper, warm)
  index.js          init(deps) + handleMessage(msg) — wiring do SW privado
  stub.js           mesmas exports, no-op
src/spy-local/      store IndexedDB + port da lógica do hub (público E privado podem usar)
  adapter.js        implementa o contrato getSpyProfiles/postSpy/putStoryMedia em processo
src/dashboard/      página dashboard.html (UI spy portada do hub + api adapter local)
scripts/export-public.mjs   gera o repo público a partir do privado
```

**Peça central:** o adaptador local implementa o **mesmo contrato HTTP do hub** em processo
(mesmas formas de request/response, `ExtensionProfile` com `wantThumbs`, `storyPks`, settings).
`spy.js` só troca o destino (`syncClient` → `spy-local/adapter`) conforme a flag. A captura,
os alarmes, o pacing do IG e o parsing ficam como estão.

Regras do contrato local (vindas do hub, não perder):
- Ordem de ingest: ops → meta → snapshots → errors → reels → reelsStatus → readings → posts → thumbs → stories; depois top 3, pruneThumbs, recordViews, refreshReelPosts.
- Clocks por campo nos posts (o mais novo vence), views do reel FB = mais novo não nulo, `reelsStatus` só avança.
- Limite de 100 perfis ativos, desfazer remoção por 7 dias, depois purge.
- IndexedDB: buscar/parsear primeiro, **uma** transação síncrona no fim (transação fecha sozinha em qualquer await não-IDB).
- Todas as escritas passam pelo service worker (o painel e o dashboard pedem por mensagem) — evita corrida entre SW, sidepanel e dashboard.
- Retenção local nova: observações por ~97 dias (o hub nunca apaga; 97 d é a maior janela que algum cálculo lê).

---

## 4. Fases

Estimativas são minhas, não medidas. Cada fase termina com `npm test` + `npm run build` +
`PUBLIC=1 npm run build` verdes, checagem ao vivo no Chrome compartilhado, commit e tag.

### F0 — Esqueleto da flag (~0,5 dia)
- Checkpoint commit.
- `vite.config.js`: `PUBLIC` → `define`, `outDir`, alias `@private`. Mesmo `define` em `vitest.config.js`
  (é config separada; usar global `__PUBLIC__`, não `import.meta`, porque testes fazem `new Function` em trechos).
- `manifest.config.js`: ramo público.
- `scripts/verify-public.mjs`: grep em `dist-public` por `rheav|X-Sync-Token|/api/sync|ingest/socialmate|ws/socialmate|extension-relay|localhost:3001|fbw-hub-btn|FBW_SYNC_|FBW_START|FBW_RELEVANCE|fbw_session|aquec|Aquecer|warm` + checagem do `manifest.json` (sem `localhost`, sem loader do `content.js`) + ausência de `models/Xenova/all-MiniLM-L6-v2`. Hoje falha; vira o critério de pronto da F1.
- Pronto quando: build privado byte-a-byte igual ao de antes (comparar `dist/`).

### F1 — Isolar hub, scraper e warm (~2–3 dias)
Service worker:
- Mover de `background.js` para `src/private/index.js`: imports `:35-86`, wiring `:88-159`, listener de alarmes, ganchos `onInstalled`/`onChanged`/wake, push do Arquivo (`:612-745`), cases `FBW_SYNC_*`, `FBW_IG_CAPTURE/EXPORT_*`, `FBW_RELEVANCE`, badge da sessão. `queueForSync` vira no-op no stub.
- **Dividir `analysisCollect.js`**: a varredura "Comentários de todos" (`:350-397`, `FBW_IG_COMMENT_SWEEP*`) e a leitura em aba ficam; upload/lease/relay vão para o privado.
- `FBW_SPY_*` **fica** (o spy vira público na F2), mas `spyStories` e a parte de upload saem.

Painel:
- `Shell.jsx` (HubStatusDot, aba Aquecer, `WarmTab`), `OptionsModal.jsx` (`HubSection`, `IgDestinationsSection`, "Mostrar Aquecer", textos de acervo, `ivymoontarot7` em `:599`), `TranscriptsPanel.jsx` (`SyncButton`), `tools.jsx`, `toolsFilter.js`, `uiPrefs.js`, `navState.js`, `platforms.jsx` (modos A/B/C) — imports via `@private`, render com `__PUBLIC__`.

Content scripts (mecanismo inline, sem imports):
- `bridge.js`: botão "Trackear no Hub" (`:710-884`), export do Scraper (`:320-331`, `:1340-1360`) atrás de `if (!__PUBLIC__)`. **Manter** `FBW_ANALYSIS_COLLECT` (a varredura de comentários usa).
- `inject.js:1524-1573` (auto-capture do warm).
- `src/content.js` sai do manifest público inteiro.
- Opcional: `gen-inline.mjs` aceita região marcada como privada.

Assets: plugin `writeBundle` (estilo `dropBundledOrtWasm`) remove MiniLM e `relevance.worker` do `dist-public`.

Pronto quando: `verify-public` passa, exceto strings de spy que a F2 resolve; build privado sem mudança de comportamento (checar ao vivo: Aquecer, hub dot, botão Hub do IG).

### F2 — Spy local (~5–7 dias)
- `src/spy-local/db.js`: schema IndexedDB espelhando as tabelas do hub (profiles, tags, snapshots, reels, posts, post_observations, readings 7 d, views, settings). Sem histórico de migrações.
- Copiar como estão: `spy-metrics`, `spy-trends`, `buildCard`, `rankRows`, `viewsWindows`, `healthStatus`.
- Reescrever ingest e consultas (spy, spyPosts, spyReels, spyViews, spyTopPosts, spyTrends) em JS; tirar as 4 funções só de análise e a checagem `analysis_evidence`; `reportTags` = todos os perfis.
- `adapter.js`: `getSpyProfiles`/`postSpy` com o contrato do hub. `spy.js` escolhe o destino pela flag; `isSyncConfigured` vira "sempre pronto" no público.
- Thumbs: guardar **bytes** (thumbs assinadas expiram), cap igual ao hub (top 3 + vídeos de 8 dias).
- Prune: alarme `chrome.alarms` (então `alarms` **fica** no manifest público).
- Fuso: D3.
- Testes: portar `tests/spy-*.test.ts` do hub contra o store local (contrato), exceto stories/UI.
- `SpyTool.jsx`: tirar "Configure o acervo", "Hub:" e `hub_sem_spy`; botão "Abrir painel" → `dashboard.html`.
- Pronto quando: rastrear 2–3 perfis IG + 1 FB ao vivo, ver leituras chegando no IndexedDB por 24 h.

### F3 — Página dashboard (~4–6 dias)
- `dashboard.html` como entrada extra no Vite (como o `offscreen`), aberta por `chrome.tabs.create`.
- Copiar `components/ui` do hub (APIs diferentes dos da extensão; não mapear), `styles.css`, `effects.css`, troca de tema.
- `src/dashboard/api.js`: adaptador local com a mesma forma de `api.ts`, falando com o SW por mensagem; `onUnauthorized` como no-op.
- Portar: grade de perfis (`SpyView` sem painel de análise/ajuda/dia-a-dia/hooks, ~−250 LOC), `ProfileCard`, `CardProperties`, `ProfileSheet` (sem card de relatório), `FollowersChart`, `ViewsChart`, `ViewsSection`, `TrendsSection`, `TopPostsSection` (sem atalho de relatório do reel), `ReadingsView`, `TagPicker`, `SpySettingsDialog` só com campos/tags/layout (~−300 LOC).
- `recharts` lazy; `motion` fica (LazyMotion) ou vira `tw-animate-css` que a extensão já tem.
- Pronto quando: os perfis da F2 aparecem com cards, sheet, gráficos, top posts e tendências; screenshot conferido.

### F4 — Stories locais (opcional, ~2–3 dias, depende de D2)
- Mídia como Blob no IndexedDB (nunca `chrome.storage`), uma por vez em memória, `keepDays` 1–30 com estrelas isentas.
- UI de stories do hub (~1.200 LOC) com `blob:` URLs assíncronas.
- "Coletar stories" vira mensagem ao SW em vez do relay.

### F5 — Export público e higiene (~1–2 dias)
- `scripts/export-public.mjs`: copia allowlist, apaga `src/private/**` e a lista de arquivos privados, troca `@private` pelo stub, remove regiões `if (!__PUBLIC__)` dos content scripts, fixa `__PUBLIC__ = true`, roda testes + build + `verify-public` **dentro do export**.
- Excluir: `CHANGELOG.md`, `POCKETBASE_MIGRATION.md`, `COMMENT_SCRAPER_SPEC.md`, `EXTRACT_AUDIO.md`, `docs/**` (fora um `ARCHITECTURE.md` limpo), `.code-foundations/`, `.cursor/`, `AGENTS.md`, `website/`, `userscripts/`, scripts pessoais, testes de hub/scraper/warm.
- Fixtures com dados reais → sintéticas: `__fixtures__/spy/fb_personal_with_story.json`, `fixtures/ig-stories-page.html`, ids reais em `background.spy.test.js`, `pinMedia.test.js` (board `rheav7`), `downloadPath.test.js` (caminho `/Users/rheavictor`), `igSurface.test.js`.
- Repo novo, histórico novo (um commit), autor noreply. **Não** tornar `rheav/socialMate` público (68 trailers, 159 MB, extensões de terceiros no histórico).
- README em PT: instalação "carregar sem compactação", o que a extensão acessa (só as plataformas, com a sua sessão), riscos de conta, sem Web Store.
- D4, D5, D6.

---

## 5. Total estimado
~13–21 dias de trabalho (F0–F3 + F5 ≈ 11–18; F4 +2–3). Maior que a estimativa inicial de
1–2 semanas porque a análise achou o segundo backend, a divisão do `analysisCollect` e a necessidade
do export para tirar o warm do código-fonte público.

## 6. Riscos
- **Contas dos colegas**: o spy abre perfis em aba de fundo e repete GraphQL do IG; cap diário (`igLimit`) e pacing 20–40 s ficam, mas o risco de bloqueio é de quem usa.
- **Scrapers quebram**: por isso a flag; uma correção serve aos dois builds. O export precisa rodar a cada release pública.
- **Spy no privado**: o privado continua mandando para o hub; o store local é só do público, a menos que se decida o contrário depois.
- Não lido por completo: `bridge.js` (3946 linhas) e `content.js`; podem existir referências pequenas de spy/hub a mais. O `verify-public` pega o que sobrar no `dist`.
