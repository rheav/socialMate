# Changelog

All notable changes to socialMate.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [SemVer](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **MAJOR** — breaking engine reworks / storage-session schema breaks.
- **MINOR** — new features (platforms, modes, UI surfaces, adapters).
- **PATCH** — bug fixes, selector tweaks, copy/pacing-default updates.

Bump `version` in BOTH `manifest.config.js` and `package.json` on every code change
(keep them in sync — enforced by `.cursor/rules/bump-version.mdc`), set `version_name`,
then `npm run build` so `dist/manifest.json` reflects it.

> History before `0.5.1` is reconstructed from `README.md` / `HANDOFF.md`; dates are
> approximate. Entries from `0.5.1` on are taken from the handoff log.

---

## [0.83.0] — 2026-08-17

### Adicionado
- **Movimento no painel.** Estava tudo brusco: trocar de aba repintava o corpo
  inteiro em um quadro, um `<details>` pulava aberto e o dropdown aparecia sem
  dizer de onde veio. Nada aqui é enfeite — cada animação responde "o que mudou,
  e de onde veio?", que é a pergunta que uma troca instantânea deixa para você
  resolver sozinho.
  - **Troca de aba / ferramenta**: fade + 4px de subida (180ms). Usa `key` para
    remontar — uma transição CSS não dispararia, porque a subárvore antiga é
    destruída, não reestilizada.
  - **Dropdown**: cresce a partir da borda do gatilho (antes aparecia centrado
    em si mesmo, então abrir para baixo e para cima eram indistinguíveis).
    Fechar é mais rápido que abrir — dispensar deve parecer sair da frente.
    O chevron do gatilho gira junto.
  - **Seções recolhíveis** (Peso do TE, legenda): altura animada via
    `interpolate-size` + `::details-content`.
  - Uma única curva (`--sw-ease`) para o painel inteiro, para o app se mover
    como uma coisa só.
- Tudo entre 140–220ms e **tudo desligado sob `prefers-reduced-motion`**.

---

## [0.82.1] — 2026-08-17

### Corrigido
- **Ordenar por alcance estava lá, com outro nome.** O menu dizia "Views por
  seguidor" enquanto o card imprimia `352×` ao lado do ícone de tendência e
  chamava de **Alcance** — mesmo número, dois nomes, então a opção não era
  encontrável. Agora o menu diz `Alcance (×)`, e ela sobe para a SEGUNDA
  posição, logo abaixo de Padrão, porque é a métrica que lidera o card.
  A coluna da planilha acompanha: `Alcance (views/seguidor)`.
  Verificado ao vivo em `#cardreading`: 352 → 45 → 35 → 10 → 8.9 → 8.4 → 6.3.

---

## [0.82.0] — 2026-08-17

### Adicionado
- **Alcance (views por seguidor) virou o primeiro número do card**, com nota por
  cor. Views dizem o tamanho do número; alcance diz se o FORMATO funcionou,
  independente do tamanho da conta — que é a pergunta que se faz varrendo uma
  grade de hashtag. A escala:

  | | | |
  |---|---|---|
  | cinza | `< 1×` | ficou na base de seguidores |
  | azul | `1–3×` | alcance normal |
  | verde | `3–10×` | o formato funcionou |
  | âmbar | `10–50×` | alcance forte |
  | laranja | `50×+` | estourou |

  Medido ao vivo em `#cardreading` (24 vídeos): 5 / 6 / 10 / 2 / 1 — a escala
  separa de verdade, não empilha tudo num balde só. Um `352×` laranja com brilho
  salta da grade; um `0.2×` cinza some. Sem vermelho de propósito: aqui não
  existe estado de erro, e vermelho leria como alerta.
- **Legenda "O que significam os números"** no painel: cada ícone do trilho
  explicado, a fórmula do TE com os PESOS ATUAIS (não uma genérica que envelhece)
  e a escala de alcance — desenhada a partir do mesmo `REACH_TIERS` de que os
  cards se pintam, então a legenda não tem como descrever uma escala que os
  cards não usam.

### Corrigido
- **`3.4K · 352×` dividido em duas linhas.** Os dois números dividiam o ícone de
  seguidores, então lia-se como se ambos fossem seguidores. Agora seguidores tem
  o ícone de pessoa e o alcance tem o seu (`trending-up`).
- **A barra de ferramentas do TikTok cabia em uma linha só e não cabia.** Oito
  controles espremiam os dois selects até "P…" e "To…" — os selects são os
  membros flexíveis da linha, então a largura de cada botão saía deles. Selects
  ganharam uma linha própria; os botões, a seguinte.
- **Pesos do TE recolhidos** num `<details>` com os valores no resumo
  (`1·4·4·2`). É ajuste de uma vez por nicho, não controle de sessão, e aberto
  custava duas linhas logo acima da grade.

---

## [0.81.0] — 2026-08-17

### Corrigido
- **A busca do TikTok não capturava NADA.** Abrir
  `tiktok.com/search?q=%23cardreading` — a superfície onde uma pesquisa de hashtag
  de fato começa — rendia zero registros, por dois motivos independentes que se
  escondiam um atrás do outro:

  - o regex de endpoints cobria `/api/<algo>/item_list`, e a busca não tem essa
    forma: a aba padrão "Melhores" é `/api/search/general/full/` e a aba "Vídeos"
    é `/api/search/item/full/`. Nenhuma das duas batia;
  - e mesmo que batessem, o leitor só olhava `itemList` / `items`, enquanto a
    busca responde `item_list` (snake_case) ou `data[] → {type, item}`.

  As duas metades agora estão cobertas, junto com `/api/search/user/full/` e
  `/api/user/detail/` (estatísticas do criador). Medido ao vivo: 0 → 48 vídeos em
  três rolagens.

- **A página de um vídeo dependia de um blob que o TikTok apaga.** O item aberto
  não vem por fetch nenhum — é renderizado no servidor dentro de
  `__UNIVERSAL_DATA_FOR_REHYDRATION__`. Esse blob era lido pela ponte isolada, que
  roda em `document_idle`, e o TikTok registra um service worker: numa carga
  quente a mesma URL que tinha servido o blob minutos antes vinha sem ele. Agora
  são três fontes, nessa ordem: a captura de fetch, o blob lido em
  `document_start` (antes da hidratação poder removê-lo) e, por último, os números
  que estão na tela (`data-e2e="like-count"` e vizinhos). Views não aparecem no
  DOM de uma página de vídeo, então nessa terceira via o TE fica nulo em vez de
  ser inventado sobre um denominador menor.

### Adicionado
- **A sobreposição de estatísticas do Instagram, agora no TikTok.** Cada tile de
  grade e o player ganham o mesmo painel: views, curtidas, comentários,
  compartilhamentos, salvamentos, TE %, seguidores · views por seguidor e data —
  mais os botões salvar / baixar vídeo / baixar miniatura / transcrever. Liga e
  desliga pelo painel (`sw_tt_overlay`).

  Dois detalhes que só aparecem ao vivo: o player do TikTok pinta uma camada de
  clique sobre toda a sua subárvore (a mesma armadilha do Instagram, onde nosso
  botão chegava em SEXTO no `elementsFromPoint`), então os trilhos do player moram
  numa camada fixa de topo posicionada sobre ele; e o TikTok mistura tamanhos de
  tile na mesma página — 185×249 na barra "Você pode gostar" contra 252×336 na
  busca — então abaixo de 230px o painel cai para três linhas em vez de estourar
  a borda e cortar os próprios números.

- **Seguidores e views por seguidor, de graça.** `authorStats` viaja em todo item
  de lista do TikTok. O mesmo número no Instagram custa uma requisição de
  enriquecimento por post, e views por seguidor lá não dá nem para ordenar.

- **Paridade do painel Ordenar:** filtro de período, "Coletar (rolar 10×)",
  exportação `.xlsx` (23 colunas, com áudio, hashtags, local e a URL da legenda
  automática), ordenação por seguidores e por views/seguidor, e pesos de TE
  editáveis — quatro termos aqui (curtida, comentário, compartilhamento, salvo)
  contra três no Instagram, porque o TikTok expõe shares e saves.

  A coleta rola `<main>`, não a janela: a grade do TikTok não rola o documento
  (`document.scrollingElement.scrollHeight === clientHeight` enquanto
  `main.scrollHeight` ia de 2250 a 7287), então rolar a janela ali não paginava
  coisa nenhuma.

- **Transcrição sem Whisper quando dá.** ~2/3 dos vídeos trazem uma faixa WebVTT
  de ASR pronta em `subtitleInfos` / `claInfo.captionInfos`; o resto continua indo
  para o Whisper.

- `docs/research/tiktok-data-map.md` — o mapa de endpoints, o que a grade tem
  contra o que a página do vídeo tem, e as duas armadilhas de medição (um hook de
  `fetch` instalado depois do load não pega nada, e
  `performance.getEntriesByType("resource")` corta em 250 entradas, que os ~220
  chunks estáticos do TikTok estouram antes da primeira chamada de API).

### Mudado
- `src/lib/shared/` ganhou `ttItems.js` (uma única tradução de payload → registro,
  no lugar das duas que já tinham divergido: `liteItem` na captura e `mapItem` na
  ponte), `ttFormat.js`, `fmt.js` (`fmtDate`/`fmtER`, que existiam em duas cópias)
  e `harvest.js` (período e cadência de rolagem, que não tinham nada de Instagram
  apesar de morarem em `igFilters.js`).
- A superfície de um registro do TikTok passa a ser carimbada onde ele é
  capturado, não na hora de repassar — um replay reenvia tudo que a captura já
  viu, e o carimbo tardio renomeava os vídeos do perfil anterior como sendo do
  perfil aberto agora. O Instagram já tinha aprendido isso.

---

## [0.80.0] — 2026-08-17

### Mudado
- **Downloads: 22 pastas viraram 3.** A árvore era
  `social-mate/<plataforma>/<tipo>/`, montada por um mapa de plataformas mais um
  mapa de tipos POR plataforma — que é como o Facebook acabou com `fotos` enquanto
  todo mundo tinha `imagens`. Agora:

  ```
  social-mate/
    videos/    fb-astravale-1234.mp4   ig-ivy-DaBFBcgxZIi.mp4   tt-veloria691-765….mp4
    imagens/   fb-astravale-1234.jpg   tt-veloria691-765…-thumb.jpg
    dados/     tt-765…-2026-08-16.json   ig-tag_cardreading-2026-08-16.xlsx
  ```

### Por que os dois mapas não valiam nada
- **Todo nome de arquivo já dizia as duas coisas.** `tt-veloria691-765….mp4` diz a
  plataforma no prefixo e o tipo na extensão — então
  `social-mate/tiktok/videos/tt-…-765….mp4` falava "tiktok" duas vezes e "vídeo"
  duas vezes.
- **Só uma coisa ainda justifica uma pasta:** manter o volume de lixo longe do
  arquivo que você foi buscar. Um despejo de capas são 50–200 miniaturas e
  JSON/XLSX são dados, não mídia. Isso são três baldes, e mais nada.
- Os nomes **não mudaram**: prefixo `fb-`/`ig-`/`tt-`/`pin-`, autor, id e o sufixo
  `-thumb` continuam exatamente como estavam. Quem some é a pasta, não a
  informação.

### Corrigido
- **O ZIP do álbum do Facebook ia parar junto com as fotos.** Ele é nomeado pelo
  tipo `image` (contém fotos), então caía em `facebook/fotos/`. A extensão é o
  sinal honesto do que são os bytes, e agora ela vence o tipo declarado: `.json`,
  `.xlsx`, `.csv`, `.txt`, `.vtt`, `.srt` e `.zip` vão para `dados/` venha de onde
  vier.
- **`resolveDownloadPath` distingue caminho pronto de nome cru pelo SEGMENTO RAIZ,
  não pelos campos da mensagem.** Um painel manda `kind: "video"` junto com o
  caminho que ele mesmo montou; decidir por `kind` gerava
  `social-mate/videos/social-mate/videos/tt-x.mp4`. Tem teste de idempotência
  travando isso.

### Migração
- Nada se move. O Chrome não mexe no que já gravou — os arquivos antigos ficam
  onde estão e só os novos usam a árvore nova.

---

## [0.79.0] — 2026-08-16

### Adicionado
- **Barra de progresso no player do Instagram** (`/p/…`, `/reel/…`, `/reels/…`):
  fina na borda de baixo do vídeo, engorda no hover, e clicar/arrastar navega no
  vídeo. Verificado ao vivo nos dois formatos — post 25,7 s e reel 33,58 s.

### Como ela é leve (e por que não é um ticker)
- **Quem anima é o navegador, não nós.** O preenchimento é UMA animação Web
  Animations (`transform: scaleX`) com duração igual ao tempo que falta: roda no
  compositor, como uma transição CSS. **Zero JavaScript por quadro** — nada de
  `requestAnimationFrame`, nada de `setInterval`.
- Medido antes de escrever a barra: uma animação dessas acompanha o relógio do
  vídeo com **15 a 29 ms** de diferença em 6 segundos. Um laço de rAF gastaria uma
  chamada por quadro, numa página que já re-renderiza sem parar, para não chegar
  mais perto do que isso.
- `timeupdate` (que o Instagram já dispara ~4×/s, então não custa nada a mais) é
  só conferência: acima de 250 ms de diferença a animação leva um empurrão; um
  salto maior que 1,5 s é loop ou scrub e ela é refeita. Custo por player: 3 divs,
  8 listeners, 1 animação, 0 timers.
- Pausar cancela a animação e deixa o preenchimento parado no ponto certo
  (verificado: 0.064 → 0.064 parado, volta a andar ao despausar).

### Detalhes que não são óbvios
- **Os controles nativos (`video.controls = true`) até aparecem** — e seriam de
  graça — mas o Instagram pinta uma camada `role="presentation"` por cima da
  faixa de controle, e o `<video>` não escapa desse contexto de empilhamento sem
  mexer nos contêineres do próprio Instagram. Brigar com isso em cada superfície
  é justamente a gambiarra que este approach evita: a barra mora na camada
  própria da extensão (`#sw-ig-layer`), que já ganha o hit-test.
- **O vídeo do Instagram é MSE** (`src` é `blob:`): `duration` só existe depois que
  o player alimenta o MediaSource, então toda conta checa isso antes — buscar
  `NaN` lança. O clipe inteiro entra no buffer em segundos (33,6 de 33,6), então
  arrastar para qualquer ponto responde na hora.
- **Reels dão loop**: o `currentTime` volta para ~0 sozinho. Isso chega como um
  salto para trás e refaz a animação, em vez de ser tratado como desvio.
- O clique na barra é engolido (`stopPropagation` + `preventDefault`) porque o
  player alterna play/pause na sequência de ponteiro — arrastar não pode virar
  uma pausa.

---

## [0.78.2] — 2026-08-15

Varredura de bugs sobre o código todo (revisão + conferência ao vivo no navegador).

### Corrigido
- **O peso do TE nunca chegava ao overlay do Instagram.** Duas falhas em série:
  1. `ER_WEIGHTS_KEY` era lido no topo do bridge.js mas declarado ~300 linhas
     abaixo, na região inlinada do igFormat — zona morta temporal. O
     `ReferenceError` caía no `catch (_) {}`, então a leitura inicial E o listener
     de `onChanged` morriam calados, e o overlay ficava nos pesos padrão para
     sempre. A fiação de storage foi movida para DEPOIS da região.
  2. mesmo corrigido, nada repintava: a assinatura que decide se um tile precisa
     ser redesenhado é feita das CONTAGENS do post, então trocar o peso
     re-renderizava e pulava todo tile já na tela. Os pesos entram na assinatura.
  - Conferido ao vivo em um perfil: `(28 + 4×50 + 3×50)/650` → o tile foi de
    8,62% para 58,2% e voltou, sem recarregar a página.
- **O player de reels agia no reel anterior.** O carimbo `data-sw-media` é escrito
  na CAIXA do player (que sobrevive à troca de reel, ao contrário do `<video>`),
  mas um host já carimbado era pulado para sempre — então rolar para o próximo
  reel deixava o id antigo no lugar, e stats/baixar/salvar/transcrever atuavam no
  vídeo errado. Agora o carimbo é refeito quando a mídia sob a caixa muda
  (identidade do `<video>` + `src`), e o carimbo velho é REMOVIDO antes: não
  resolver nada é recuperável, apontar para o reel errado não é.
- **Link do card virava reel mesmo quando era vídeo de página.** `fbCardLink`
  reescrevia qualquer `/watch/?v=` como `/reel/<id>`, mas a captura grava watch de
  propósito para post de vídeo (`/<página>/videos/<id>` e o teatro `?v=`). A
  captura agora grava também a FORMA do link (`videoKind`), e só registro sem essa
  marca — os antigos, de antes da correção — continua sendo reescrito.
- **Enriquecimento carimbava a superfície errada.** A fila anda a 1 req/s e pausa
  com a aba escondida, então uma página de 24 leva ≥24 s: sair da hashtag para um
  perfil nesse meio tempo fazia os pendentes carimbarem `profile:<user>` em posts
  de hashtag (e o bridge ainda preenchia o username por ali). A superfície agora
  viaja com o `pk` na fila.
- **Playhead deixava uma porta órfã viva.** `bind()` chamava `drop()` e só então
  esperava `tabs.query`; dois gatilhos juntos (`onActivated` + `onUpdated` de SPA)
  abriam duas portas, e a perdedora nunca era desconectada — seu `onDisconnect`
  comparava com `portRef.current` e nunca batia. Agora cada `bind` tem senha: a
  antiga desconecta e para de emitir tick.
- **Parar a coleta sem coleta rodando travava a próxima.** `igScrollStop` só era
  limpo ao fim de um ciclo; um Parar clicado depois do fim real deixava a flag
  armada e o próximo Coletar saía no primeiro passo. Limpa no início do ciclo.
  Conferido ao vivo: Parar sem ciclo → Coletar → `scrollY 0 → 3234`.
- **Planilha .xlsx quebrava sem superfície.** `surface` é null antes da primeira
  resposta da página (e com "mostrar tudo" numa página sem superfície), e
  `surface.replace(...)` lançava TypeError — clique sem download e sem aviso. Cai
  para `tudo`.
- **Limpar um campo de peso zerava o peso.** `Number("")` é 0, finito e ≥ 0, então
  passava pela validação: apagar para redigitar zerava o termo e reescrevia o
  campo como "0". Campo vazio agora significa "usar o padrão".
- **Pinterest no Aquecer era um beco sem saída.** O seletor do topo oferece as
  quatro plataformas, mas o Aquecer só existe para três: escolher Pinterest ali
  mostrava a plataforma selecionada e o corpo caindo num seletor que não a lista.
  Agora essa escolha leva para a Pesquisa, que toda plataforma tem.
- Índice `igUsersByName` sem teto (só `igUsers` era podado), bytes de controle
  crus no regex do `xlsx.js` (mesmo conjunto, agora escapado) e import morto no
  `Shell.jsx`.

---

## [0.78.1] — 2026-08-15

Auditoria do filtro da pesquisa (0.77.0), com o custo medido na página.

### Alterado
- **A passada deixou de percorrer o feed inteiro.** Ela lia um
  `getBoundingClientRect()` por post JÁ carregado a cada quadro de rolagem —
  medido: 0,4 ms para 33 filhos, ou seja ~4 ms por quadro numa sessão de hashtag
  com 300 posts, para reaprender o que o IntersectionObserver já sabia. Agora o
  observador É a lista de trabalho: a passada olha só o que está perto da tela
  (mais os poucos posts devendo uma reconferência), e o custo não cresce mais com
  o tamanho do feed. `pending` virou contador, não varredura.
- Mudar a regra continua refiltrando o feed todo na hora — agora por um
  `sweepAll()` explícito, disparado só quando a regra muda, e não por acidente a
  cada quadro.

### Corrigido
- **Veredito zerado ficava para sempre.** A releitura só valia para post
  APROVADO; um REPROVADO nunca era reconferido — e ele está escondido, então nada
  mais olhava para ele. Se a barra de ações montasse um quadro antes dos números
  pintarem, o post era lido como 0/0/0, reprovava e sumia da pesquisa pelo resto
  da sessão. Agora uma leitura sem número nenhum é marcada e reconferida (até 3
  vezes, 1,2 s de intervalo) antes de o zero ser aceito.
- **Referências presas ao sair da pesquisa.** `near`/`recheck` seguram os
  elementos do feed (diferente de `verdicts`, que é WeakMap); sem limpá-los, todo
  post de toda pesquisa feita na aba continuava alcançável. `teardown()` esvazia
  os dois.
- **Timer órfão a cada reload da extensão.** A geração que sai de cena parava os
  observadores mas deixava o vigia de navegação SPA (700 ms) rodando para sempre;
  agora ele também é encerrado.

---

## [0.78.0] — 2026-08-15

Oito melhorias no Instagram, medidas contra a extensão de referência (IG Sorter
2.4.1) e contra o que o Instagram realmente manda hoje.

### Corrigido
- **As visualizações voltaram.** A busca por palavra-chave
  (`xdt_fbsearch__top_serp_graphql`) parou de mandar views: medido ao vivo em
  15/08/2026, `view_count: null` em 24 de 24 vídeos e nenhuma chave `play_count` /
  `ig_play_count` — com `like_count` presente nos 24 e
  `like_and_view_counts_disabled` falso. O campo não mudou de nome; aquele endpoint
  simplesmente parou de trazer. `/api/v1/media/<pk>/info/` responde play_count 52222
  para o mesmo post, então um vídeo sem views vira um pedido — **um por segundo, e
  só com a aba visível**. (A referência dispara os 24 de uma vez, sem fila.) O
  `x-ig-app-id` é pego do tráfego do próprio Instagram, não fixado no código.

### Adicionado
- **Tamanho do criador.** Seguidores, seguindo, nº de posts, nº de reels, bio,
  link da bio e conta comercial, colhidos passivamente dos payloads que já
  passavam por aqui — zero requisições novas. O overlay ganhou a linha de
  seguidores; a planilha ganhou "views por seguidor", que é o número que separa
  "foi bem" de "foi bem PARA uma conta desse tamanho".
- **Áudio do reel.** `audio_id`, autor e duração do som original (ou da faixa
  licenciada) — o link `instagram.com/reels/audio/<id>/` lista todo mundo que
  está usando aquele som.
- **Filtro por período** — 7/14/30/90/180 dias, 1 e 2 anos. Um post sem data é
  MANTIDO: as grades costumam omitir `taken_at`, e escondê-los pareceria que o
  filtro comeu resultados.
- **Peso do TE editável** (curtida / comentário / repost). O overlay na página lê
  os mesmos números que o painel usa para ordenar.
- **Coleta em ritmo humano** — rola a página para o Instagram paginar, com pausas
  que crescem (3 s nas primeiras 5, 6 s nas 5 seguintes, 10 s daí em diante).
- **Planilha .xlsx** com link, perfil, seguidores, views, curtidas, comentários,
  reposts, TE, views/seguidor, data, legenda, áudio e bio. Escrita sobre o
  `zipWriter` que já existe: um .xlsx é um zip de XML, e a referência carrega o
  ExcelJS inteiro (a maior parte dos 970 KB dela) para fazer o mesmo. A miniatura
  vai como link, não embutida.
- **Overlay no player de reels e no permalink** (`/reels/<code>/`, `/reel/…`,
  `/p/…`). Lá não existe `<a>` em volta do vídeo, então a varredura por link não
  achava nada — a página onde a estatística mais importa era a única sem ela.
  Verificado ao vivo em `/reels/DaBFBcgxZIi/`: 17 players marcados, 17 raias com
  93,3 mil views · 4,6 mil · 1,4 mil · 271 · 12,2% · data.
- **Os botões não pausam mais o reel — e agora recebem o clique.** O player do
  Instagram pinta uma camada `role="button"` do tamanho do vídeo POR CIMA de tudo
  que está dentro da subárvore dele. Com a raia pendurada ali, o clique real nunca
  chegava aos nossos botões: `elementsFromPoint` no centro do botão devolvia a
  camada do Instagram em 1º e o nosso `button` em 6º. Nenhum z-index resolve isso
  de dentro da subárvore, então as raias do player passaram a viver numa camada
  própria (`#sw-ig-layer`, `position:fixed`, z-index alto, pendurada no `<html>`,
  fora da raiz do React), posicionada sobre o player a cada passada e reposicionada
  no scroll/resize — a mesma forma que o overlay do Facebook já usava, pelo mesmo
  motivo.
  As duas raias também engolem a sequência de ponteiro
  (`pointerdown`/`mousedown`/`pointerup`/`mouseup`), com `stopPropagation` e não
  `stopImmediatePropagation`, para o menu de idioma do próprio botão continuar
  funcionando.
  Verificado com CLIQUE REAL (não evento sintético — o sintético pula o hit-test e
  passava mesmo quebrado): miniatura baixou `ig-agnestarot-DaBFBcgxZIi-thumb.jpg`,
  vídeo baixou 5,4 MB, salvar gravou na Biblioteca, transcrever abriu o menu
  BR/EN — e em todos os quatro o reel continuou tocando.
- **A raia do player deixou de congelar.** Ela era montada uma vez e nunca mais:
  como as views chegam ~1 s depois (o enriquecimento por mídia), a raia ficava
  para sempre com curtidas/comentários/data e SEM views e SEM TE — exatamente o
  que apareceu no player. A verificação de assinatura já cobria isso; o `continue`
  que eu tinha posto antes dela é que impedia qualquer remontagem.
- **A raia do player subiu para o meio** (60% da altura, ancorada pela camada).
  Colada embaixo ela disputava espaço com o botão de mudo do Instagram e se lia
  como parte da legenda.
- **Botão de transcrever na raia do reel/post.** A raia tinha salvar, baixar mídia
  e baixar miniatura; transcrever só existia nos stories e no painel. Mesmo caminho
  do Whisper, com o badge BR/EN e o mesmo menu de dois toques dos stories
  (idioma primeiro, job depois — o badge seria mentira se o botão não deixasse
  trocar). Verificado ponta a ponta: `DaBFBcgxZIi` → `done`, 725 caracteres, com
  views/curtidas/comentários no registro.

### Detalhes que não são óbvios
- `ER_WEIGHTS` passou a ter UMA definição (`lib/shared/igFilters.js`): duas cópias
  inlinadas no mesmo content script são `const` repetido — SyntaxError que derruba
  a bridge inteira.
- O bloco dos pesos não pode ser inicializado no topo do script: a região inlinada
  vem depois, e ler a constante ali é temporal dead zone (`Cannot access 'D' before
  initialization`). Começa `null`; `engagementRate` já cai no padrão.
- **As props do React só existem no mundo MAIN.** A primeira tentativa de ler
  `media$key.id` / `videoFBID` foi escrita na bridge, que roda no mundo ISOLADO: os
  dois mundos compartilham o DOM, não as propriedades JS penduradas nos elementos,
  então a busca não encontrava nada e nada aparecia. Agora quem resolve é o
  main-world, que escreve o id de volta como ATRIBUTO (`data-sw-media`) — atributo
  atravessa a fronteira. A extensão de referência não tem esse problema porque o
  script dela inteiro roda no MAIN.
- Estatísticas de criador não existem em NENHUM payload de busca — nem no
  `/info/`, cujo `user` não traz `follower_count`. Elas chegam em payloads de
  perfil, então o join também casa por @handle: os itens da própria timeline de
  perfil não carregam objeto `user`.

---

## [0.77.0] — 2026-08-15

Filtro de engajamento na pesquisa do Facebook. Você diz o mínimo de curtidas,
comentários e compartilhamentos; enquanto rola `/search/*` ou `/hashtag/*`, quem
não bate a regra sai do feed. Combinação E/OU: "2000 comentários OU 200
compartilhamentos", ou os dois ao mesmo tempo.

### Adicionado
- **Ferramenta "Filtrar"** (Pesquisa → Facebook): liga/desliga, três mínimos
  (branco = ignora a métrica) e o combinador E/OU, com contagem ao vivo
  ("4 exibidos · 7 ocultos"). A regra vive em `chrome.storage.local`
  (`sw_fb_filter`), então continua valendo com o painel fechado, depois de um
  reload e em qualquer outra aba do Facebook.
- **`src/content/fb/feed-filter.js`** — o filtro em si. Fatos medidos ao vivo em
  `/search/top?q=%23auralytrend` (2026-08-15) que sustentam o desenho:
  - o Facebook JÁ virtualiza esse feed: filho fora da tela perde o conteúdo mas
    mantém a altura, e filhos só são acrescentados, nunca removidos → **o filho do
    `[role="feed"]` é a identidade do post**. Permalink não serve: dois posts
    diferentes carregavam o mesmo `/stories/…`;
  - a faixa de montagem é ~−0,5 a +2,3 telas, ou seja, dá para ler as contagens de
    um post ~2 telas antes de ele ser visto e escondê-lo em silêncio;
  - `display:none` no filho encolhe a página exatamente na altura dele, não mexe no
    `scrollY` e **não trava a paginação** (38 → 54 filhos com 47 escondidos, até
    "End of results").
  - Custo em regime: 0,2–0,3 ms por passada. As passadas são disparadas por
    IntersectionObserver (margem 200%) + MutationObserver de `childList`, com um
    tique de 500 ms que só roda enquanto existe post indeciso.
- **Chip na página** (canto inferior esquerdo): mostra exibidos/ocultos e liga ou
  desliga o filtro sem sair do feed. Fica pendurado no `<html>`, fora da raiz React
  do Facebook — dentro do feed ele morreria no próximo re-render.
- **`readCountsByControl()`** em `src/lib/shared/fbCounts.js`: lê a barra de ações
  arquivando cada número no controle a que ele pertence (por conter o número ou
  pela distância até o centro), com recuo para a leitura posicional.

### Corrigido
- **Contagem zero deslocava a leitura.** O Facebook não imprime número nenhum ao
  lado de um controle zerado, então um post com 4 reações, 0 comentários e 2
  compartilhamentos renderiza "4 … 2" — e a leitura POSICIONAL de
  `readPostCounts` arquivava os 2 compartilhamentos como 2 comentários, passando
  num filtro de "≥ 2 comentários". Medido ao vivo: números em x≈1027 e x≈1131
  contra controles em curtir x≈1013, comentar x≈1065, compartilhar x≈1117.
  `readPostCounts` (usada pelos scrapers de reel) segue como estava.

### Notas de comportamento
- Mudar o limite NÃO exige rolar de novo: as contagens já lidas ficam em cache e
  são reavaliadas contra a nova regra na hora, inclusive para posts que o Facebook
  já desmontou.
- Esconder um post que ficou ACIMA da tela devolve a mesma distância ao scroll (e
  o inverso ao reexibir), senão a página pula debaixo dos olhos de quem lê.
- Post que ainda não montou não é escondido — indeciso continua visível e é
  julgado quando o Facebook o renderiza. Aba em segundo plano não monta nada, e
  aí o filtro simplesmente espera.
- Sair da pesquisa (navegação SPA) devolve todos os posts e remove o chip.

---

## [0.76.0] — 2026-08-15

### Corrigido
- **O link do card abria outro reel.** Um reel capturado a partir de um FEED era
  salvo com `/watch/?v=<id>` — a rota /watch cai no FEED de reels quando o Facebook
  não serve o item, e aí toca qualquer coisa. Agora a captura guarda a FORMA do
  link do próprio post (`/reel/<id>` para reel, `/watch/?v=` para vídeo de página),
  e os registros antigos em forma de watch são reescritos como `/reel/<id>` na hora
  de abrir. Conferido ao vivo: `/reel/1846308513007203` abre o vídeo do James Love
  Guide, que é exatamente o dono do registro.
  - Nota honesta: uma primeira leitura disso concluiu que `/watch/?v=` SEMPRE
    desvia reels para o feed. Aquilo foi medido enquanto o Facebook servia páginas
    de erro para este perfil, e a mesma sonda deu resposta oposta uma hora depois.
    O sinal de redirect não é confiável e não há nada construído sobre ele.

### Alterado
- **Três abas no topo: Pesquisa · Aquecer · Arquivo.** "Aquecimento" virou
  "Pesquisa", o "Aquecer" saiu de dentro dela e subiu para o topo, e "Biblioteca"
  virou "Arquivo". A aba Pesquisa lista só as ferramentas de pesquisa da
  plataforma; o seletor de plataforma é o mesmo componente nas duas abas.
- O warmer só existe para Facebook, Instagram e TikTok, então a aba Aquecer oferece
  apenas essas três — `WarmTool` lê `PLATFORMS[platform].defaultMode` no mount e
  quebraria com Pinterest.
- Nada de navegação salva se perde: `tab: "warm"` guardado continua significando o
  warmer (agora no topo), e uma ferramenta lembrada que sumiu da aba Pesquisa cai
  para a primeira da plataforma.

---

## [0.75.0] — 2026-08-15

Karaokê. A transcrição salva acompanha o vídeo que está tocando na aba: a linha
que está sendo falada fica destacada, a lista rola sozinha, e clicar numa linha
pula o vídeo para aquele ponto. Vale para Transcrições e para Salvos.

### Adicionado
- **Playhead da página → painel.** O content script publica `{videoId, t, paused}`
  numa porta (`fbw-playhead`); o painel decide qual linha é (`lib/playhead.js`).
  A página é dona do relógio — medido ao vivo: `timeupdate` dispara ~3,8×/s
  (intervalo mediano 265 ms), o que dá ~5 atualizações por chunk de 1,31 s. Sem
  rAF, sem polling.
- **Clicar numa linha pula o vídeo.** Verificado ao vivo: o Facebook não briga com
  o seek (11,71 → 23,71 parou em 24,00 e continuou tocando).
- **`lib/playhead.js`** — `chunkIndexAt(chunks, t)`, puro e testado: início do chunk
  pertence ao próprio chunk, buraco entre legendas segura a linha anterior em vez de
  piscar, e a última linha fica acesa quando o vídeo passa do fim da transcrição.
  Destaca 150 ms adiantado — a linha que aparece exatamente na primeira sílaba é
  lida como atrasada.

### Detalhes que não são óbvios
- **O `videoId` viaja em TODO tick.** Uma página de reel troca a URL 150-175 ms antes
  de trocar o card montado (medido), então tempo e id colhidos separados podem ser de
  reels diferentes. Junto, o painel recusa o par trocado em vez de rolar a
  transcrição errada. O mesmo vale para o seek: pedido com id de outro vídeo é
  ignorado.
- **A rolagem é do container, não `scrollIntoView`.** A lista vive numa caixa de
  176 px dentro da Biblioteca, que também rola; `scrollIntoView` sobe por todos os
  ancestros roláveis e sacudiria o painel inteiro a cada linha.
- **Nada de player próprio.** Tocar o vídeo dentro do painel funciona (um
  `progressive_url` do fbcdn carrega no `chrome-extension://`), mas 1 em 3 reels
  testados não expõe URL nenhuma (os que chegam por paginação SPA) e a URL expira
  em ~5 dias. O vídeo da própria aba não tem nenhum desses problemas.
- Sem transcrição para o vídeo que está tocando, nada muda na tela.

---

## [0.74.1] — 2026-08-10

### Corrigido
- **Transcrever no feed pegava OUTRO post.** Reproduzido ao vivo em
  `facebook.com/hashtag/soulmate`: o trilho sobre o vídeo de 7,9 s disparou o job do
  vídeo de 35,1 s — metadados, áudio e transcrição do post errado.

  Causa: os trilhos do feed são `position: fixed` e só acompanham o post por um
  handler de scroll, e esse handler usava `requestAnimationFrame` **sem nunca
  limpar a flag de fila**. `requestAnimationFrame` não roda em aba em segundo
  plano — então um scroll com a aba escondida travava a flag em `true` para
  sempre. Dali em diante os trilhos ficavam parados na TELA enquanto o feed rolava
  por baixo, e o botão que aparecia ao lado do post B pertencia ao post A.

  Duas correções: um `setTimeout` corre junto com o frame (a flag sempre limpa) e
  voltar a ficar visível reposiciona na hora; e, no clique, a geometria decide —
  um trilho flutuante que não está mais sobre o vídeo a que foi vinculado usa o
  vídeo que está de fato embaixo dele, e se não houver nenhum o job falha em vez
  de transcrever o post errado em silêncio (`src/lib/shared/railTarget.js`).

---

## [0.74.0] — 2026-08-10

### Adicionado
- **Barra de progresso real** na transcrição, no card da Biblioteca. Não é
  estimativa: são bytes do modelo (`progress_callback`), bytes do áudio
  (`content-length` + leitura em stream) e as janelas de 30 s do Whisper, contadas
  pelo `WhisperTextStreamer` — o total de janelas é conhecido pelo PCM decodificado
  antes da primeira rodar.
- O progresso trafega em mensagens (`FBW_TX_PROGRESS`), **nunca em storage**: o
  mapa de transcrições é único, enfileirado e cheio de miniaturas — escrevê-lo a
  cada token derrubaria o painel. Painel fechado só perde a barra; o registro cai
  igual.
- Tudo isso é **consultivo**: o streamer é construído em `try/catch` próprio e cada
  emissão é protegida. Uma versão do Transformers.js que pare de aceitar `streamer`
  custa a barra, não a transcrição.

### Corrigido
- Falha de transcrição aparecia como **"Transcription failed"**, sem nada para
  investigar: o worker reportava `err.message`, e o runtime ONNX lança erros com
  mensagem vazia. Agora vai a primeira linha do stack (ou o nome do erro) quando
  não há mensagem.

---

## [0.73.0] — 2026-08-10

### Adicionado
- Escolha de idioma **BR/EN** onde antes só o Facebook tinha: no botão Transcrever
  dos **stories do Instagram**, no botão do **TikTok**, e um seletor no topo da aba
  **Transcrições** que vale para os botões do painel (Instagram Reels, TikTok
  Ordenar, TikTok Stories). Instagram e TikTok liam `fbw_transcript_language` mas
  não tinham como escrevê-lo: o idioma era o que o Facebook tivesse deixado lá.
- O controle é um só (`src/lib/shared/txLang.js`, embutido nos content scripts pelo
  gerador). As três cópias manuais de `normTxLang`/`getTxLang` saíram.

### Corrigido
- Transcrição vinda de **legenda** (TikTok `subtitleInfos`) era rotulada com a
  escolha BR/EN do usuário — mas o Whisper nunca roda nesse caminho: o texto está
  no idioma em que a TikTok escreveu a própria legenda. Agora o registro leva o
  idioma da faixa (`LanguageCodeName`), e quando ela é de um idioma que a
  Biblioteca não rotula, fica **sem etiqueta** em vez de mentir.

---

## [0.72.1] — 2026-08-10

### Corrigido
- A Biblioteca marcava **BR** em transcrições feitas em inglês. A etiqueta usava o
  padrão do produto (`br`) quando o registro não tinha idioma nenhum — e nenhuma
  transcrição anterior à 0.72 tem: aquelas rodaram com o idioma **omitido**, que o
  Transformers.js decodifica como inglês. Agora a etiqueta só aparece quando o job
  realmente registrou um idioma. (Verificado ao vivo: escolher **English** grava
  `language: "en"` e o Whisper devolve texto em inglês — o caminho já estava certo,
  quem mentia era o rótulo.)
- Excluir uma transcrição não dizia nada quando não excluía nada. O painel ignorava
  a resposta do background, então uma remoção que apagou zero registros — ou um
  service worker morto — ficava idêntica a uma que funcionou: o card continuava lá,
  em silêncio, exatamente como um botão sem handler. Agora falha aparece no card
  (e no "limpar tudo").

---

## [0.72.0] — 2026-08-02

### Adicionado
- Transcrição com escolha rápida de idioma **BR/EN** no botão do Facebook.
- O idioma escolhido fica salvo em `fbw_transcript_language` e é reutilizado por
  Facebook, Instagram e TikTok.

### Corrigido
- O valor de produto agora é `br`; valores legados `pt` ainda são aceitos, mas o
  Whisper recebe o token correto `pt` internamente.

---

## [0.71.1] — 2026-08-01

Um reel transcrito podia chegar à Biblioteca **sem curtidas, comentários e
compartilhamentos** — e, uma vez sem, nunca mais os recuperava. A causa não era
"sair do reel antes de terminar": os números eram lidos **uma única vez**, no
instante do clique, e congelados na mensagem do job. Se aquele instante não desse
certo, o registro ficava com `counts: null` para sempre.

### Corrigido
- **Os números são lidos pelo controle de comentário, não pelo de curtida.**
  `Curtir` é o único rótulo que muda de estado: depois que a conta reage ele vira
  `Amei` / `Remover Curtir`, e a busca ancorada nele não achava a linha de ações —
  devolvia `null` para tudo. Verificado ao vivo no mesmo reel: com o rótulo
  reagido, o código antigo lia `null` e o novo lê `462 mil / 6,2 mil / 28 mil`.
- **A varredura passa a ler nós de texto**, não elementos-folha. O Facebook tem
  variantes em que o número divide o `span` com um ícone; um `span` com filhos era
  pulado e o número sumia.
- **A captura espera a página assentar.** Medido ao vivo (amostragem por frame, três
  trocas de reel): a URL muda ~150-175 ms **antes** do card montado trocar, e o id
  vem da URL enquanto autor/legenda/números vêm do DOM — uma leitura nessa janela
  arquiva o engajamento de um reel sob o id do outro. Agora duas leituras
  consecutivas precisam concordar (`sameCapture`) antes de o job sair.
- **Quando os números chegam tarde, o registro é remendado.** `FBW_META_PATCH`
  tenta de novo em 400/1000/2200 ms enquanto a página ainda mostra aquele vídeo, e
  só preenche o que falta.
- **Nenhuma escrita rebaixa o registro.** `mergeMeta` trata `null` no patch como
  "não vi", não como "apague" — era assim que re-transcrever um reel apagava os
  números que já estavam salvos.
- **O mapa de transcrições tem um escritor só.** Ele tinha quatro (job, remendo,
  card instantâneo da página, excluir/limpar do painel), cada um com
  get → mutate → set: duas escritas simultâneas e uma sumia. Tudo passa pelo
  background, em fila (`lib/serialQueue.js`, agora compartilhada com `fbw_saved`).

### Adicionado
- `src/lib/shared/fbCounts.js`, `src/lib/shared/captureIdentity.js`,
  `src/lib/shared/metaMerge.js`, `src/lib/serialQueue.js` — todos com testes
  (`happy-dom` para os que leem DOM).
- Mensagens `FBW_TRANSCRIPT_PUT`, `FBW_TRANSCRIPT_REMOVE`, `FBW_META_PATCH`.

---

## [0.69.0] — 2026-07-26

Os ajudantes que os content scripts copiavam à mão agora são embutidos pela build a
partir de uma única fonte testada, a Biblioteca passa a ter um formato de registro e
um único escritor, e um download que falha diz por quê.

### Adicionado
- **`src/lib/shared/` + `npm run gen:inline`.** Um content script **não pode
  importar**: qualquer `import` faz o CRXJS gerar um `*-loader.js` que chama
  `await import(chrome.runtime.getURL(...))` em vez de um IIFE autocontido — dá para
  ver em `dist/manifest.json`, onde só `content.js` e `pin-api.js` têm loader. Num
  script de mundo MAIN esse import dinâmico obedece à CSP **da página**, que no
  Facebook/Instagram pode matá-lo e desligar a captura em silêncio.
  A solução anterior era copiar os ajudantes à mão com um comentário "espelho de
  `src/lib/x.js`" — nada garantia a cópia, e seis delas já haviam divergido. Agora a
  fonte canônica (testada, e reexportada pelas libs do painel) é copiada para uma
  região marcada de cada content script:
  ```js
  // <<< inline:src/lib/shared/counts.js
  // >>> inline:end
  ```
  `npm run build` e a suíte de testes rodam `--check` e **falham** se alguma cópia
  estiver velha. Ver `src/lib/shared/README.md`.
- **`src/lib/bg.js`** (`sendBg`/`requireOk`) e **`src/lib/useItemStatus.js`**: uma
  conversa com o service worker e um estado por item para os painéis, em vez de sete
  cópias de cada.

### Corrigido
- **Divergência real que estava em produção:** a cópia de `parseCount` dentro de
  `comments-scrape.js` tinha **5** palavras de unidade localizadas contra as **13**
  da lib testada, então uma contagem de reações como `"1,2 rb"` (id/nórdico/polonês)
  virava `null` na página enquanto os testes passavam. Também: `parseReactions` tinha
  um regex mais estreito, e o `catch` de `cleanAuthorUrl` devolvia `id: null` em vez
  de derivar o slug — perdendo a identidade do autor. As três cópias agora vêm da
  mesma fonte.
- **`MAX_PHOTOS`/`MAX_SCROLLS` tinham duas casas** (o content script e
  `HARVEST_CAPS`); agora só `src/lib/shared/fbPhotoIds.js`.
- **A Biblioteca (`fbw_saved`) tinha dez escritores e cinco formatos.** Cada um fazia
  seu próprio `get → mutate → set`, que é uma corrida de atualização perdida (painel
  + overlay da página, ou duas abas, e um sobrescreve o outro em silêncio). E os
  formatos divergiam: contagens pré-formatadas por um `fmtCount(null)` **sem guarda**,
  o Pinterest gravando a string `"—"` em views onde os outros gravavam `null`,
  `sourceUrl` presente em alguns e ausente em outros (sem ele o VideoCard cai num
  link morto `facebook.com/reel/<id>`), e o TikTok guardando como `thumb` uma URL de
  CDN assinada que expira.
  Agora: `src/lib/shared/savedEntry.js` monta o registro (contagens em **números
  crus**, `schema: 2`, permalink e URL de perfil **derivados** por plataforma, para
  ninguém esquecer), e o background é o único escritor, com as escritas
  serializadas numa fila (`FBW_SAVED_TOGGLE` / `_UPSERT` / `_REMOVE`).
  A formatação virou responsabilidade de renderização no `TranscriptsPanel`, que
  ainda aceita as strings dos registros antigos.
- **Um download que falhava não dizia por quê:** o `catch` de cada painel só pintava
  o ícone de vermelho e descartava a mensagem. Agora o motivo aparece no `title` do
  botão ("Falhou: …").
- **Uma falha ao baixar a MINIATURA pintava o botão de mídia ao lado**, porque as
  duas ações compartilhavam a mesma chave de estado. Cada ação tem a sua
  (`statusKey(id, "thumb")`).
- Paridade de contagens no TikTok: `share`/`save` eram gravados pelo overlay da
  página e ignorados pelos painéis, então o mesmo vídeo virava registros diferentes
  dependendo de onde você salvava.
- **Os marcadores do Pinterest e das Coleções do TikTok nunca acendiam** (não havia
  espelho de `fbw_saved` nesses painéis), então salvar parecia não fazer nada e o
  segundo toque removia o item em silêncio. Agora acendem, ficam vermelhos com o
  motivo em caso de falha e ficam desabilitados durante a escrita.

### Notas
- 19 arquivos de teste, 345 testes. Dois deles são guardas de contrato, não testes de
  unidade: `src/lib/inline.test.js` roda `gen-inline --check` (uma cópia velha
  quebra a suíte) e o bloco do livro-caixa em `sessionMath.test.js` exige que
  `persist()` e o resume cubram o mesmo conjunto de chaves.

---

## [0.68.0] — 2026-07-26

Nenhum arquivo de relatório é mais baixado ao fim de cada execução, os limites de
segurança do aquecimento deixam de zerar a cada navegação, e um download que falha
para de se mostrar como sucesso.

### Removido
- **O JSON de telemetria baixado ao fim de TODA execução acabou.** Não existe mais
  `Downloads/social-mate/sessoes/run-*.json`, nem a mensagem `FBW_WRITE_RUN_LOG`, nem
  o buffer `fbw_run_events` em `chrome.storage`, nem o fluxo de eventos estruturados
  (`emit()`, `runMeta()`, `runCounters()`, `flushEvents()`, `flushOrphanRun()`,
  `loadEventBuffer()`) — cerca de 300 linhas de `src/content.js` que só existiam para
  alimentar aquele arquivo. **Não reintroduza um download aqui.** A execução continua
  se reportando pelas três superfícies que o painel já lê: `fbw_session` (ao vivo),
  `fbw_history` (últimas 50 execuções) e `fbw_last_summary` (o card de resumo).
  A chave `fbw_run_events` deixada por versões anteriores é apagada uma vez no
  `onInstalled`.
- `fbSavePost()` de `src/content.js`: código morto (o aquecimento no Facebook é
  somente curtir; reels usam `fbSaveReel`) e o regex do menu era só em inglês,
  contradizendo os dicionários localizados usados em todo o resto.
- `requiresTab` em `src/lib/tools.jsx` (declarado, nunca lido) e a chave `commented`
  duplicada no literal de `persist()`.

### Corrigido
- **Os limites de segurança sobreviviam mal a uma navegação.** `persist()` gravava os
  contadores mas não o *livro-caixa* de segurança, e o resume o recriava zerado — ou
  seja, `MAX_LIKES_PER_HOUR`, `MAX_LIKES_PER_AUTHOR` e os limites por autor de
  comentário voltavam a zero em toda navegação. E toda execução no modo A começa com
  uma (`location.assign` até a hashtag), assim como o fim de resultados da busca do
  TikTok (`location.reload`). Agora `likeTimes`, `authorLikes`, `commentTimes`,
  `authorComments`, `commentedIds`, `capturedIds`, `consecLikes`, `consecFollows`,
  `consecComments`, `softFailStreak` e `lastPhrase` são persistidos e restaurados.
- **Downloads que falhavam apareciam como sucesso.** O `bg()` local de cada painel
  nunca lia `chrome.runtime.lastError` e nenhum chamador checava o `.ok` que o
  service worker realmente envia — o botão ficava verde tivesse o arquivo chegado ao
  disco ou não. Agora existe um único `src/lib/bg.js` (`sendBg`/`requireOk`) usado
  por todos os painéis, e os overlays injetados (Instagram, TikTok, Pinterest, que
  são import-free de propósito) checam a resposta e piscam o estado de erro.
- **Transcrição desistia cedo demais no feed do Facebook.** Quando a legenda falhava,
  o Whisper só era tentado se houvesse `mediaUrl` ou `candidates` — que é exatamente
  o que um job de feed não tem (os `candidates` são removidos de propósito: ids de
  vizinhos contaminam). Agora `durationHint`/`primedAt` também contam, e é o
  `resolveTracks` que decide.
- **A terceira varredura do coletor de comentários era código morto.** A fase 1 só
  sai quando `stable` chega a 4 e a fase 3 exigia `stable < 3` sem reiniciar o
  contador. Além disso, uma página sem painel de comentários rodava a coleta inteira
  (~7 min) sobre um DOM vazio e baixava `{count: 0}` — agora aborta na hora.
- O estado de erro dos botões injetados existia no CSS mas nunca era acionado
  (`progress("err")` nunca era enviado); uma coleta que falha agora fica vermelha em
  vez de girar para sempre.
- `EMPTY_SCROLL_LIMIT` era declarado como 14 e ignorado por um `> 10` fixo no
  `postsLoop`, enquanto o `videoLoop` usava a constante.

### Notas
- `src/content.js` saiu de 2997 para 2732 linhas.

---

## [0.67.0] — 2026-07-25

Tradução completa para pt-BR, Facebook ganha download em massa de fotos, e todos os
downloads passam a viver numa única pasta.

### Adicionado
- **Extensão 100% em português do Brasil.** Painel, ferramentas, botões injetados nas
  páginas e as mensagens do log de execução. O idioma do painel é independente do
  idioma da página: o dicionário `L` de `aria-label`s do Facebook/Instagram
  (`curtir`, `seguir`, `salvar`…) **não** foi traduzido — ele casa com o idioma do
  site, não com o nosso. Traduzi-lo quebraria o warmer.
- **Facebook: baixar todas as fotos de um perfil como ZIP** (aba `Fotos`). A grade é
  paginada por rolagem e cada foto sai em resolução cheia.
- **Pinterest: botões de baixar/salvar direto na página**, nos tiles e no closeup —
  paridade com Facebook, Instagram e TikTok, que já tinham.
- **Tooltips nos controles que viram só ícone** em painel estreito, inclusive na
  navegação de ferramentas.

### Alterado
- **Layout responsivo**: nada mais é cortado na largura mínima do painel. Abaixo de
  ~340px os botões colapsam para só ícone. Os rótulos em português são mais longos
  que os originais em inglês, que é parte de por que passou a cortar.
- **Todos os downloads agora vivem em `Downloads/social-mate/`**, organizados por
  plataforma e tipo (`facebook/fotos`, `instagram/videos`, `sessoes`…). Antes havia
  quatro pastas diferentes — uma delas com maiúscula trocada — e a maior parte da
  mídia caía solta na raiz do Downloads. Um único `src/lib/downloadPath.js` passa a
  ser dono de todo caminho, para não divergir de novo.
- **Fotos do Facebook: a URL cheia vem do GraphQL**, não de abrir cada foto. A mesma
  resposta que monta a grade traz `image.uri` (o recorte quadrado que o tile pinta) e
  `viewer_image.uri` (a foto inteira). Antes a extensão percorria o visualizador foto
  a foto: **57s → 9s**, e a aba do usuário não é mais navegada.

### Corrigido
- **Pinterest, Idea Pins**: a resolução cheia vinha vazia porque esses pins usam
  `images.originals` (plural) e não `images.orig` — 29% de uma pasta baixava em 736px
  sem avisar.
- **Pinterest, pastas com acento**: `ingl%C3%AAs` era enviado percent-encoded e a API
  devolvia 404. Toda pasta com acento era inutilizável.
- **Pinterest, teto de páginas**: "coletar de novo" não avançava — nenhum cursor era
  guardado, então a coleta refazia a página 1. Uma pasta de 6689 pins parava em 870.
- **O botão `Iniciar` podia ficar morto sem explicação.** Ele era desabilitado por um
  ping respondido por `transcription/inject.js`, enquanto quem executa o start é o
  `content.js` — a trava usava evidência que nunca disse nada sobre o motor que ela
  travava. O painel também engolia o `{ok:false, error}` que o próprio motor devolvia.
- **Links de autor quebrados na Biblioteca**: `author.url` absoluto recebia um domínio
  prefixado, gerando URL aninhada. Conserta também registros do TikTok já salvos.
- **`NAV_PLATFORMS` travava plataformas novas**: qualquer plataforma recém-registrada
  era silenciosamente inalcançável no painel.

### Notas
- Um hook MAIN-world no `XMLHttpRequest` passa a rodar em toda página do facebook.com
  (filtrado por `indexOf("viewer_image")` antes de qualquer parse). É a origem mais
  movimentada que a extensão toca — primeiro lugar a investigar se algo estranhar.
- Sem cobertura de execução real: os ramos `inject`/`reload` do `reviveTab` e os tetos
  de coleta de fotos. Ambos têm teste unitário; o Chrome se auto-cura antes do
  primeiro, e o perfil de teste é pequeno demais para o segundo.

## [0.66.0] — 2026-07-25

- **New platform: Pinterest.** Fourth platform in the switcher, with a single `Board` tool.
- **Active fetch, not passive capture.** Pinterest's `/resource/*` API is unsigned and cookie-authenticated, so `src/content/pin/pin-api.js` calls it directly and walks the cursor — a whole board is harvested without the user scrolling. This is the first platform in the extension that works this way.
- **`filter_section_pins: false`** is what makes bulk possible; Pinterest's own site sends `true`, which returns only un-sectioned pins (a 6689-pin board returns 6).
- **HLS→MP4.** ~80% of Pinterest videos expose only an HLS manifest. Guessing MP4 paths does not work; the variant filename is read from the master `.m3u8` and the directory swapped `/hls/` → `/expMp4/`.
- Full-resolution images come from `images.orig` — the common `/236x/` → `/originals/` rewrite 403s when the original's extension differs.
- No background or engine changes: `FBW_DL_MEDIA` already covered both media kinds; Pinterest has no Warm adapter.

### Fixed
- **Platform switcher unreachable for new platforms.** `NAV_PLATFORMS` in `src/lib/navState.js` maintains a hardcoded allowlist; as the sole code path that ever sets the active platform in the panel, any newly registered platform would have been silently unreachable — selecting Pinterest would collapse straight back to Home. A latent bug any future platform would have hit. Pinterest was added to the allowlist; note this is a second registration site (alongside `PLATFORMS`/`PLATFORM_ORDER` in `platforms.jsx`, `PLATFORM_HOST` in `tabs.js`, and `TOOLS` in `tools.jsx`).
- **Author links nested for absolute URLs.** `VideoCard` in `src/components/TranscriptsPanel.jsx` unconditionally prepended an origin to `author.url`, assuming relative paths; for absolute URLs this nested one URL inside another, breaking the link. Fixed for Pinterest; also repairs author links on already-saved **TikTok** records (which store absolute URLs), so existing Library transcripts now surface correct clickable author links — a silent repair to pre-existing data.

## [0.65.0] — 2026-07-25

Audit-driven cleanup pass: dead code removal, memory-leak fixes and hot-path
performance work. Every deletion below was verified unreachable by grep across
`src/`, `manifest.config.js` and `index.html` before removal — nothing was inferred
from naming.

### Removed — dead assets (−39.5 MB packaged)
- **4 unreferenced ORT wasm binaries + 1 loader** deleted from `public/assets/`
  (58 MB → 21 MB). Two independent proofs: the built workers only ever name
  `ort-wasm-simd-threaded.jsep.{mjs,wasm}`, and three of the deleted files
  (`ort-wasm.wasm`, `ort-wasm-simd.wasm`, `ort-wasm-threaded.wasm`) **don't exist in
  the installed onnxruntime-web 1.22 at all** — they're ORT ≤1.17 filenames.
  `numThreads=1` does not switch binaries, it only stops thread spawning.
  **Verified by running a real Whisper transcription afterwards** (1786-char
  transcript, `source:"whisper"`) — the risky deletion is proven, not assumed.

### Removed — dead code
- 4 orphaned components: `DownloadPanel.jsx`, `ui/Launcher.jsx`, `ui/badge.jsx`,
  `ui/collapsible.jsx`, plus the cluster only `DownloadPanel` produced
  (`FBW_PAGE_INFO` / `FBW_COLLECT_REEL_THUMBS` handlers, `fbPageInfo`,
  `collectReelThumbs`).
- 5 dead background message handlers (`FBW_GET_ACTIVE_VIDEO`, `FBW_CURRENT`,
  `FBW_DO_TRANSCRIBE`, `FBW_DO_DOWNLOAD`, `FBW_LIST_TRANSCRIPTS`,
  `FBW_DEBUG_REGISTRY`) and 2 notifications nothing listened to
  (`FBW_TRANSCRIBE_PROGRESS`, `FBW_DOWNLOAD_PROGRESS`), plus `CURRENT_KEY` /
  `currentTabId` and the unused `pickByDuration` import.
- `globalTools()`, `commentIdFromHref()` (superseded by `commentRefs()` in the
  content script), `requiresTab` (10 declarations, 0 reads), the dead
  `.bottom-dock`/`.dock-icon` CSS block.
- **`THEMES` trimmed to what's actually read.** The `NEUTRAL` bundle
  (`--sw-action`/`--sw-switch`/`--sw-wash`/`--radius`/`--primary`/`--ring`) and
  `--sw-from`/`--sw-to`/`--sw-glow` were never read off the object; only
  `--sw-grad` is, for the Home picker's platform tiles. Stale comment corrected.
- 3 unused dependencies: `@ffmpeg/util`, `@radix-ui/react-tabs`,
  `@radix-ui/react-collapsible`.

### Fixed — memory
- **Offscreen runtimes are released when idle (~300 MB).** Whisper (~180 MB
  resident), MiniLM and ffmpeg (heap grown to the largest video ever muxed) were
  loaded once and held for the whole browser session — nothing terminated the
  workers or closed the document. Now in-flight jobs are counted; 45 s after the last
  one the workers/ffmpeg are terminated, pending resolvers settled, blob URLs revoked,
  and the SW closes the document (WASM heaps only shrink by being discarded).
  **Verified live: the document auto-closed between 30–45 s after a transcription.**
- **Generation takeover added to `ig/bridge.js`, `tt/tt-relay.js` and `content.js`.**
  Their init guards live on the isolated world's `window`, and an extension
  reload/update creates a *fresh* world — so every reload left the previous
  generation's intervals, body-wide MutationObserver, scroll listeners and stores
  running for the page's lifetime, compounding per update. Newer generation announces,
  older tears itself down (the pattern `comments-scrape.js` already used).
- **`fbw_saved` is capped (300, oldest-first by `updatedAt`).** It was the only store
  that grew forever — 9 writers, none pruning, records carrying base64 thumbs.
  Enforced centrally in the background's storage listener rather than duplicating the
  logic across all 9 writers.
- Inner-map caps added where only the outer Map was capped (`comments` items 500,
  `stories` items 100, `lists` items 300 — and `ingestListVideo` now caps `lists`
  too, since it also creates entries); `sentCom` in `tt-capture.js` was missing from
  its sibling cap block; `xpvToVideoId` now capped (600) independently of the track
  registry it used to be pruned with.
- Muxed-video blob URLs are revoked on idle release instead of only after a fixed
  5 minutes.

### Fixed — performance
- **IG `JSON.parse` hook no longer deep-walks every parse.** It wraps *every*
  `JSON.parse` on instagram.com; the media walk ran unconditionally (a recursive
  generator over the whole object graph plus a Set of every visited node) while the
  reels walk already had a string sniff. Added the same sniff
  (`image_versions2`/`video_versions`/`carousel_media`) — an `indexOf` is ~1 µs where
  the walk is milliseconds — plus a 50k-node budget alongside the depth cap.
  **Verified: IG still captures (16 records after a reload).**
- **Deleted the dead per-frame `publishCurrent` pipeline in `ig/bridge.js`.** On every
  scroll frame it did `querySelectorAll("video")` + per-video rects, up to 12 ancestor
  attribute-substring queries, and — when the record was missing — a canvas
  `toDataURL` JPEG encode plus a document-wide `innerText` scan… all feeding
  `fbw_current`, which nothing reads.
- **`repositionOverlayRails` is two-phase.** It read a rect then wrote styles per rail,
  so each of 10–30 rails forced its own synchronous layout every scroll frame; now all
  reads happen first, then all writes — one layout per frame.
- **FB reels capture**: bails immediately off a reels grid (the 3 s poll previously ran
  `scanTiles` + a walk of *megabytes* of embedded FB JSON on any facebook.com tab), and
  the embedded-JSON parse is memoized per `<script>` node in a `WeakMap` (those blobs
  are static after load).
- **TikTok overlay**: one layout pass per tick instead of two (the centered video was
  resolved twice), the per-second whole-`fbw_saved` read replaced with a
  `storage.onChanged` mirror, `ssrRecord` memoized *including failures* (it re-parsed
  the multi-MB SSR blob every tick on the FYP feed), interval 1 s → 2 s.
- **Panel polls are version-gated and pause while hidden.** New `lib/poll.js`
  `startPolling` skips ticks when the panel isn't visible and fires immediately on
  becoming visible; the TikTok bridge stamps a `storeVersion` so an unchanged poll
  answers `{unchanged:true}` (~20 bytes) instead of structured-cloning up to 500
  records — or every comment of every tracked video — across processes every 2.5 s.
  **Verified live: the gate returns `unchanged`.**
- `webRequest` filter gained `types: ["media","xmlhttprequest","other"]` — it was
  firing for every image/avatar/sticker on Facebook, thousands of dispatches a minute
  that only ever failed the `.mp4` regex while keeping the MV3 worker awake.

## [0.64.1] — 2026-07-25

### Reverted — per-platform identity retint (0.64.0)
- **The panel keeps ONE identity on every platform again** (Smart blue in light,
  Brute red→yellow in dark), as established in 0.41.0 which deliberately dropped
  per-social-network retinting. 0.64.0 wired `PLATFORMS[p].theme` into `<html>`;
  that is removed and `Shell.jsx` now carries a comment saying not to do it.
- `PLATFORMS[p].theme` stays in `platforms.jsx` — it is still read inline for the
  small per-platform icon tiles on the Home picker, which have always been branded.
- Everything else from 0.64.0's line of work (per-platform *workspaces*, tab
  following, header switcher, flame glyph, `Sort` label, `min-w-0` overflow fix) is
  unaffected — this reverts only the color retint.

## [0.64.0] — 2026-07-25

### Added — per-platform identity retint (REVERTED in 0.64.1 — do not reintroduce)
- **The panel now takes the active platform's brand gradient.** `platforms.jsx` has
  always defined a per-platform `THEMES` map whose comment claimed it was "applied to
  `<html>` on switch", but nothing ever applied it (0.63.0 documented this as dead
  code). Now `applyPlatformIdentity()` wires it up, so the logo squircle, the
  `socialMate` wordmark, the active switcher glyph + glow, the segmented thumb, the
  Start button and the toggles all retint: Facebook blue→cyan, Instagram
  orange→pink→purple, TikTok cyan→red. Home restores the default.
- **Only the four identity vars are applied** (`--sw-from`, `--sw-to`, `--sw-grad`,
  `--sw-glow`) — deliberately *not* `PLATFORMS[p].theme` wholesale, because that
  object spreads a `NEUTRAL` bundle of **light-mode** tokens (`--primary: 240 6% 10%`,
  `--ring`, `--radius`, `--sw-wash`); inline-styling those on `<html>` would beat the
  `.dark` block and wreck dark mode.
- **Label contrast pinned.** Dark mode's `--primary-foreground` is *black*, tuned for
  the Brute red→yellow accent whose yellow end kills white text. A platform gradient
  needs white, so `--primary-foreground` is pinned to white while a platform identity
  is active and removed at Home. Re-runs on the light/dark toggle.

## [0.63.0] — 2026-07-25

### Added — per-platform workspaces that follow the active browser tab
- **The panel now mirrors the active tab's platform.** Previously the platform was
  detected **once on mount** (no `chrome.tabs` listeners existed), so moving from a
  TikTok tab to an Instagram tab left the panel on TikTok until you manually went
  back to Platforms and re-picked.
- **Each platform keeps its own workspace and resumes it.** Nav state moved from a
  flat `{tab, platform, toolId}` (`sw_nav2`, which *reset* `toolId` on every platform
  change) to `{tab, platform, perPlatform:{<platform>:{toolId}}}` under the new key
  **`sw_nav3`**. Pick Stories on Instagram and Comments on TikTok, bounce between
  tabs, and each platform comes back where you left it. The legacy `sw_nav2` value is
  migrated on first run (last platform + tool preserved), never mutated.
- **Reliability/perf guards** (all in `lib/navState.js` + `useFollowActiveTab`):
  - Listeners live in the **panel**, not the background SW — zero cost while the
    panel is closed, no storage round-trip, no extra MV3 wakeups.
  - **Own-window filter**: a side panel belongs to one window, so tab events from
    other windows are ignored. `windows.onFocusChanged` is deliberately *not* used
    (another window gaining focus isn't a change to our window's tab).
  - `onUpdated` pre-filtered to real navigations of the active tab, then a **150 ms
    debounce** → a page load's event burst costs one `tabs.query`.
  - **Monotonic ticket** drops out-of-order async resolutions from fast tab switching.
  - Every `withPlatform`/`withToolId`/`withTab` returns the **same object reference**
    when nothing changes, so repeat events cause **no re-render**.
  - **Non-platform tabs are sticky** — switching to gmail/localhost keeps your last
    workspace instead of blanking the panel.
  - **Library is never disturbed** by a tab switch; the workspace updates underneath.
  - A remembered tool that no longer exists falls back to the platform's first tool.
  - Exactly **one platform's tools stay mounted** (unchanged) — deliberately *not*
    mounting all three, which would triple the tools' 2.5 s polling intervals.
- 18 new unit tests (`lib/navState.test.js`); no content-script, bridge, background,
  or tool-data changes. Spec: `docs/superpowers/specs/2026-07-25-per-platform-workspaces-design.md`.

### Changed — UI
- **Platform switcher moved into the header**, right of the `socialMate` wordmark
  (was inside `ToolFrame`, only visible within a tool). It is now visible everywhere
  and doubles as the indicator of which platform the panel is following; clicking a
  glyph jumps straight into that platform's workspace.
- **Flame glyph added inside the identity squircle** in the header (it was an empty
  gradient tile), matching the extension icon.
- **`"Sort + Download"` → `"Sort"`** (download is implicit) and `Segmented` buttons
  gained `min-w-0`. Root cause of TikTok's clipped 5th tab: flex items default to
  `min-width:auto`, so buttons wouldn't shrink below their label and the existing
  `truncate` never engaged, overflowing the track.

### Note
- `platforms.jsx` defines a per-platform `THEMES` map whose comment claims it is
  applied to `<html>` on switch — **nothing applies it** (no `setProperty` anywhere),
  so the identity gradient comes from `index.css :root` on every platform. Left
  as-is deliberately (wiring it would restyle the whole panel); documented so it
  isn't mistaken for a regression introduced here.

## [0.62.0] — 2026-07-25

### Added — TikTok Stories + Playlists/Collections tools
- **Two new TikTok tools**, unblocked after finding a creator (@edu_limoncelli) that
  actually has them — the shapes are now verified populated:
  - **Stories** — passive tee of `/api/story/item_list` (each item is a full video
    struct: HD + captions + stats). Grouped by creator; per-item **Download HD**,
    **Transcribe** (caption-first), **Save**. Verified: edu had 2 active stories.
  - **Playlists** — passive tee of `/api/user/playlist` + `/api/user/collection_list`
    (bucket metadata: `{id/mixId, name, videoCount, cover}` — edu had 10 playlists)
    plus `/api/{mix,collection}/item_list` for the videos inside. Collapsible bucket
    list; open a playlist on TikTok to load its videos, then Download-HD-all / Save.
- Capture routing added to `tt-capture` (`STORY_RE`/`MIX_RE`/`LISTMETA_RE`); the
  bridge gains `stories` + `lists` stores and `FBW_TT_STORIES` / `FBW_TT_LISTS`
  (both cleared by `FBW_TT_CLEAR`). Story/playlist videos reuse the HD + caption-first
  paths from 0.61.0.

## [0.61.0] — 2026-07-25

### Added — HD-everywhere downloads
- **TikTok downloads now pick the highest-quality rendition.** `tt-capture` reads
  `video.bitrateInfo[]` and selects the gear with the largest resolution (tie-break
  bitrate) as `hd_url` — verified live: a 1080×1920 h265 gear above TikTok's default
  720 `playAddr`. Sort-tool download + on-page overlay download both use `hd_url`
  (falls back to `downloadAddr`/`playAddr`). Instagram already serves the largest
  `image_versions2.candidates[0]` / `video_versions[0]`, and Facebook uses the
  delivered progressive/DASH, so TikTok is where the upgrade lands.

### Added — caption-first transcription (skip Whisper when captions exist)
- **TikTok ships ASR caption tracks** (`video.subtitleInfos[]`, `Format:"webvtt"`,
  direct `Url`). Transcription now downloads and parses that webvtt into text +
  timestamped chunks **instead of running Whisper** — far faster/cheaper. Whisper
  stays the fallback when no caption URL is present (and if the caption fetch fails
  but media exists). New `parseWebVtt` in `background.js`; the transcript record is
  tagged `source:"caption"`. The existing Library SRT/txt export works unchanged
  (chunks mirror the Whisper shape). `FBW_TRANSCRIBE` gains `captionUrl`.

### Added — Instagram story-link stickers
- **Swipe-up / link-sticker destinations are now captured** (`liteStory` reads
  `story_link_stickers[].story_link.url`, defensively) and shown as a tappable
  **link** chip on each story card in the Stories tool — surfacing competitors'
  actual funnel/landing-page URLs.

### Deferred (need a populated account to verify shapes)
- **TikTok Stories** (`/api/story/item_list`) and **Collections/Playlists**
  (`/api/user/{collection_list,playlist}`) — endpoints verified firing, but the
  test creator (@zachking) had no active stories and no playlists, so the populated
  item shapes couldn't be nailed. Deferred until a creator that has them is available.

## [0.60.0] — 2026-07-24

### Added — Refresh + auto-follow current video (FB / IG / TikTok)
- **Passive-capture tools accumulated across videos/surfaces** — the panel could
  show a *previous* video's comments/posts after you'd moved on. Fixed two ways:
  - **Auto-follow the current video.** The TikTok bridge now tracks
    `lastCommentAweme` (the video whose comments last loaded) and returns a
    `current` id in `FBW_TT_LIST`/`FBW_TT_COMMENTS`; the Comments tool auto-selects
    it until you manually pick a video.
  - **Refresh button** on IG Sort, IG Stories, TikTok Sort, TikTok Comments, and FB
    Comments. New `FBW_TT_CLEAR` / `FBW_IG_CLEAR` bridge messages wipe the captured
    store and re-pull the current surface, so switching context drops stale items.
    (FB Reels already re-scans live DOM via "Collect all"; FB Comments refresh jumps
    to the newest/streaming scrape.)

### Added — TikTok on-page action overlay
- **A floating action stack on TikTok videos** (feed + detail), so you can act
  without opening the side panel — mirrors the FB/IG on-page buttons. Pinned to the
  window's right edge (clear of TikTok's own rail), **no backdrop-blur**. Buttons:
  **Save** to Library, **Download** MP4, **Transcribe** (Whisper), **Scrape
  comments** (opens the comment panel + auto-scrolls to bulk-load into the passive
  capture, incl. expanding replies), **Like** (clicks TikTok's native control).
  Resolves the current video from the captured record (`byId` keyed by the URL /
  most-centered-video's aweme id); media actions disable when no record is captured
  yet. Lives in `content/tt/tt-relay.js` (isolated world, import-free).

## [0.59.0] — 2026-07-24

### Added — TikTok Sort + Download + Comments (new platform tools)
- **TikTok now has scraping tools, not just warming.** Two new tools in the TikTok
  workspace: **Sort + Download** (mirror of IG Sort) and **Comments**.
- **Capture = passive fetch/XHR response tee, NOT a JSON.parse hook.** TikTok parses
  its API responses with `fetch().json()` (native — a JSON.parse monkey-patch caught
  0/167 calls live), so `content/tt/main-world.js` wraps `window.fetch` (+ XHR) at
  document_start and tees the response bodies of `/api/{post,recommend,challenge,
  search}/item_list` and `/api/comment/list`. Passive — reads what the page already
  fetched, so **no request signing** (msToken/X-Bogus/X-Gnarly) and no flagging risk.
  `content/tt/bridge.js` (isolated, import-free like ig/bridge) keeps a surface-scoped
  video map + a per-video comment store, answering `FBW_TT_LIST` / `FBW_TT_COMMENTS`.
- **Sort + Download**: 2-col 9:16 card grid, sort by **views / likes / comments /
  shares / saves / ER% / date** (TikTok exposes shares AND saves on the list — richer
  than IG), per-card download MP4 + thumbnail + save-to-Library + transcribe (reuses
  the Whisper pipeline via the direct `playAddr` MP4). Surfaces: profile, hashtag,
  search, For You.
- **Comments**: capture-on-open (opening a video loads its comments → teed). Pick a
  captured video, search text/author, sort by thread/likes, reply-nested rows, copy
  corpus, export JSON.
- **Download referer fix**: TikTok's video CDN 403s a hotlinked download (no Referer);
  `fetch`/`downloads` can't set Referer (forbidden header), so a lazy
  `chrome.declarativeNetRequest` session rule injects `Referer: tiktok.com` on the
  video-CDN hosts (new `declarativeNetRequest` permission). Also covers the offscreen
  audio fetch for TikTok transcription.
- New pure libs `lib/ttMedia.js` + `lib/ttComments.js` (31 unit tests).
- Spec: `docs/superpowers/specs/2026-07-24-tiktok-scrape-design.md`.

### Performance — backdrop-blur removed from every scroll/grid surface
- Following the 0.58.3 IG on-page fix, removed `backdrop-filter`/`backdrop-blur` from
  **all remaining rail-over-scrolling-media surfaces** where it caused the same
  repaint-per-frame jank: the side-panel card grids (**IgSort, IgStories, FbReels**
  stat rails + action buttons, **Library/Transcripts** buttons) and the **Facebook
  on-page** action buttons (`transcription/inject.js`, was `blur(9px) saturate(140%)`).
  Compensated with darker solid backgrounds; identity styling (blue border/glow) kept.
- Left intentionally: the options dropdown/tooltip and the transcript modal — static,
  one-shot overlays that don't sit over a scrolling grid.

## [0.58.3] — 2026-07-24

### Performance — Instagram overlay scroll jank
- **Removed `backdrop-filter` blur from all IG on-page overlay styles** (grid stat
  rails, tile action buttons, story-viewer buttons). Measured live: with 28 tiles
  annotated the DOM held 112 blur surfaces, each re-rastering the moving grid
  behind it every scrolled frame — avg frame 68.3ms (~15fps, p95 96ms) vs 8.3ms
  (120fps) with blur disabled and *identical* 8.3ms with overlays hidden, i.e.
  the blur was 100% of the overlay cost. Load-time extension cost (32ms), the
  MAIN-world `JSON.parse` hook (3.6ms), and the overlay render pass (0.05ms
  selector scan) were all measured negligible.
- Compensated visually with darker solid backgrounds: rail/buttons
  `rgba(0,0,0,.42)`+blur → `.62` solid (hover `.78`); story buttons `.55`+blur →
  `.68` solid (hover `.84`). Blue border, outer glow, and text-shadow unchanged.
  `OVL.blurPx` config key removed.
- Known remaining instance (out of scope tonight): Facebook's on-page buttons
  (`transcription/inject.js`, `blur(9px) saturate(140%)`) have the same defect.
- Spec + measurements: `docs/superpowers/specs/2026-07-24-ig-overlay-blur-perf-design.md`.

## [0.58.2] — 2026-07-20

### Performance — storage I/O during live scrape
- **Live scrape no longer re-serializes the whole comment archive every tick.**
  Streaming now writes a single-post key (`fbw_comments_live`); the finished
  scrape merges that post into the archive (`fbw_comments`, ≤8 posts) and clears
  the live key. So each ~1.4s flush writes ~one post (~200KB) instead of all 8
  (~800KB).
- **Panel updates from the `storage.onChanged` event's `newValue`** (no
  re-`get`), and archive vs live are separate state — during a scrape only the
  live key changes, so the archive is never re-read either. Backward compatible:
  the archive schema is unchanged, so previously-scraped posts still show (no
  migration). A stale live key (tab navigated away mid-scrape) is ignored after
  10 min; a failed scrape clears it.

## [0.58.1] — 2026-07-20

### Performance — comment scrape hot path
- **Incremental extraction.** `collect()` re-ran the heavy `extractComment`
  (5× `querySelectorAll` + `innerText` reflows per article) over EVERY loaded
  article on EVERY tick — O(N²) (~130k extractions for a 512-comment thread).
  Now each article node is read at most once during the growth loops (a
  `WeakSet` guard), with two full re-reads at the end to pick up late reactions
  / expanded "Ver mais" text — ~1.5k extractions total (≈99% fewer). Output is
  byte-identical.
- **Rail-scoped load-more scan.** `clickLoadMore` scanned every `[role="button"]`
  in the document (hundreds once comments load); now scoped to the comment rail
  (`[role="complementary"]`).
- One `querySelectorAll` per tick reused for both collect + count (was 2–3), and
  `nudgeRail` no longer copies a 512-element array to grab the last node.

## [0.58.0] — 2026-07-20

### Added — live streaming + virtualized comment list
- The side-panel **Comments** tool now fills in **live during the scrape** (was
  a single write at the end). The scraper streams the growing thread to storage
  on a **throttled, growth-gated flush** (~1.4s, only when the count changed —
  so the whole array isn't re-serialized every tick), tagging the record
  `scraping: true` until done. The tool follows the active scrape, shows a
  spinner + `N shown · M…`, and marks the streaming post with ⏳ in the picker.
- The comment list is **virtualized with `@tanstack/react-virtual`** (dynamic
  row measurement) — a 500–1000-comment thread renders only the ~15 visible
  rows, so scrolling and live updates stay smooth.
- Default sort is now **Thread order** (calm during live streaming — new
  comments append); **Reactions** still available to rank.

## [0.57.0] — 2026-07-20

### Changed — button look
- The **Scrape comments** button now lives **in the reel action rail, below
  Transcribe** (was a detached floating pill) — a third icon-square built by
  `transcription/inject.js`; the scraper (`comments-scrape.js`, same isolated
  world) is triggered via a `__fbwScrapeComments` window event and reports
  progress back to the button via `__fbwScrapeProgress`.
- **All on-page buttons are now blue-tinted, translucent, and blurred**
  (`rgba(46,96,200,.40)` + `blur(9px) saturate(140%)` + blue border), and every
  button gets an instant **hover tooltip** (`[data-tip]:hover::after`).

### Added — side-panel Comments tool
- New **Comments** tool in the Facebook workspace renders a scraped thread:
  search (text/author), sort by **reactions**, filter **All / Top-level / Replies**,
  reply-indented rows with author link + reactions + badges + time, **Copy text**,
  re-**export JSON**, and clear. A post selector switches between recent scrapes.
- The scraper now also **stores each scrape** in `chrome.storage.local`
  (`fbw_comments`, 8 most-recent posts) alongside the JSON download, so the tool
  updates live via `storage.onChanged`.

## [0.56.0] — 2026-07-20

### Added — Facebook comment scraper
- A floating **"Scrape comments"** button on FB reel/post permalinks harvests the
  whole comment thread (top-level **and** replies) to a JSON file, for mining
  hooks / objections / sentiment from the audience's own words. Per comment:
  text, **reactions** total, author (name + profile URL + id), relative time,
  top-fan badges, `is_reply` + `parent_id`, and permalink. Output:
  `~/Downloads/socialmate-comments/fb-<reelId>-<timestamp>.json`.
- New `src/content/fb/comments-scrape.js` (isolated) + `src/lib/fbComments.js`
  (unit-tested pure helpers) + a `FBW_DL_JSON` background handler (reuses the
  run-log `jsonDataUrl` → `chrome.downloads`). No new permissions.
- Verified live on a 571-comment reel: 443 comments captured (author name +
  comment_id on 443/443, clean bodies, reactions, badges).

### Notes — how FB comments load (learned live)
- Unlike the feed/reels grid (off-thread), **comment pagination parses on the
  main thread**. But in the immersive reel viewer comments **paginate via a
  "Ver mais comentários" button, not infinite scroll** — and the only scroll
  container there is the reel FEED (scrolling it navigates to the next reel).
  So the scraper is **button-driven** (clicks "load more" + expands
  "Ver N respostas" replies + "Ver mais" truncations), never scrolls the feed.
- **Replies are flat siblings, not nested articles**; they're identified by the
  permalink's `reply_comment_id` (own id) + `comment_id` (parent). The author
  link and the timestamp permalink both carry `comment_id`, so ids come from the
  reel-permalink link (clean numeric), authors from the profile link.
- v1 is DOM-only (no JSON.parse hook), FB-only, single open post, JSON export,
  total-reactions only — each deferred item is an additive follow-up.

## [0.55.0] — 2026-07-16

### Added — Facebook Reels Sort (mirrors the IG Sort tool)
- New **Reels Sort** tool in the Facebook workspace: on a profile's
  `?sk=reels_tab` grid, collect every reel and sort them in the side panel by
  **Views / Comments / Shares** (asc/desc), as a 2-col 9:16 card grid with a
  stat rail, per-card **Save to Library** + **Download thumbnail**, and
  **download all thumbnails**.
- New `src/content/fb/reels-capture.js` (isolated) reads the grid from the
  **DOM tiles** (reel id, thumbnail, localized view count) and enriches the
  first batch with comment/share counts from the initial embedded
  `<script type="application/json">` blocks. FB paginates the reels grid off
  the main thread, so — unlike Instagram — there is no `JSON.parse` capture;
  a **Collect all** button auto-scrolls the grid to load the full list.
- New `src/lib/fbReels.js` (unit-tested): `parseCount` for localized abbreviated
  counts (`"14 mil"` → 14000, `"1,5 mil"` → 1500, `"1.2M"` → 1200000), the
  view/comment/share sort comparators, and card/filename helpers.

### Notes / limits
- **Views is the universal metric** (present on every tile). Comments/shares
  are available only for the reels in the initial embedded payload; paginated
  reels show views only. **Likes/reactions are not exposed on the FB grid** (they
  live inside the reel viewer), so there is no likes sort or ER — this is a
  Facebook data limitation, not an omission.
- Video download / transcription of a reel stays on the existing on-page reel
  buttons (open the reel); the grid tool is thumbnail + save + sort.

## [0.54.1] — 2026-07-16

### Changed — feed resolution reworked (0.54.0 MAIN-world capture reverted)
- 0.54.0 tried the IG pattern (a MAIN-world `JSON.parse` hook) on Facebook. It
  doesn't work here: instrumented live, **58 `JSON.parse` calls during a feed
  scroll carried 0 video payloads** — FB paginates the feed OFF the main thread
  (Worker), so a page-thread hook never sees the media. Removed
  `src/content/fb/`.
- Kept the honest signal it surfaced: FB's initial embedded
  `<script type="application/json">` blocks carry each video's real id, its
  **accurate** `playable_duration_in_ms` (efg's `duration_s` lies —
  preview-cut values on full videos), and its caption. New `fbEmbeddedResolve`
  (isolated world, on demand) matches a clicked feed post to its video id by
  caption (unique) then accurate duration.
- Feed jobs resolve in order: permalink id → embedded-JSON caption/duration →
  prime-window wire attribution (`pickByWindow`, the always-available fallback
  for paginated posts). All three yield a confident id or bail; none can cross
  to a neighbour.

## [0.53.7] — 2026-07-16

### Fixed — duration matching was built on sand; replaced with wire attribution
- Registry dump (new `FBW_DEBUG_REGISTRY`) proved **efg `duration_s` is
  unreliable**: FB stamped ~29s (a preview-cut) on the 80s video's own tracks,
  so the "unique duration match" confidently returned the wrong neighbour —
  the crossing that survived 0.53.4–0.53.6.
- Feed resolution is now **prime-window attribution**: the tracks that hit the
  wire while the content script played THIS video are its tracks
  (`pickByWindow`, unit-tested). efg duration only breaks ties among the
  fresh set; with no fresh tracks it falls back to the strict duration match
  (own ambiguity guard). The confident PRE-prime duration lookup is gone —
  feed jobs always prime first.
- `primeVideo` now **seeks into an unbuffered stretch** when the video is
  already (partly) buffered — an MSE replay emits no fetches, which starved
  the window of evidence.

## [0.53.6] — 2026-07-15

### Fixed — 0.53.5's feed-detection had a hole FB's remounts walked through
- Live repro of the crossing AGAIN: between the first message build and the
  post-prime rebuild, FB remounted the clicked video — the held node went
  detached, so `duration` read NaN (no hint) and `closest('[role="feed"]')`
  returned null (classified as NOT feed) → the candidates fallback fired and a
  neighbour's id won, overwriting the neighbour's Library card with this
  post's metadata.
- Three layers now close it: `onFeed` derives from the **button** (overlay
  rails only exist on feed) and rides through both message builds; the live
  video is re-resolved geometrically after priming; and the background strips
  `candidates` from any message flagged `feedSurface` (defense in depth).

## [0.53.5] — 2026-07-15

### Fixed — fourth and last crossing path: the not-yet-loaded video
- Clicking Transcribe on a feed video whose metadata hadn't loaded yet
  (`duration` still NaN → no hint) fell back to the candidates message — and
  feed markup embeds NEIGHBOURING videos' ids, so the job inherited the
  neighbour's transcript under this post's metadata AND overwrote the
  neighbour's Library card (same record id). Feed posts now never send
  candidates; a job with no id, no direct URL, and no duration fails fast at
  the button (✗) instead of letting the background guess by recency.

### Added
- **Library history**: `fbw_transcripts` keeps the newest **20** records
  (rolling). Fixes the "cards keep replacing each other" feel and bounds
  storage (thumbs are 10-20KB each).

## [0.53.4] — 2026-07-15

### Fixed — the audio crossing had a THIRD path, found via the wire log
- 0.53.3 closed the embedded-JSON crossing but the same symptom re-appeared:
  the record's id (`1586262063063962`) turned out to be a **29s neighbour**,
  while the clicked video's true id (`1371677391606167`, 80s) was sitting in
  the registry. Cause: with no permalink and no duration match yet, the job
  fell back to `candidates[0]` — a junk 15-19-digit markup id that happened to
  BE a real captured video's id, and `resolveTracks` step 1 trusted it exactly.
- Feed jobs are now **duration-only end to end**: no junk fallback into
  `videoId`, candidates omitted whenever a duration hint rides the message, and
  a hinted `resolveTracks` call never falls through to the candidate scan.
- Same-duration ties (29.3s vs 29.9s spam clones, live on the test feed) break
  via `primedAt`: after priming, only tracks fetched during the prime window
  count; still ambiguous → explicit error instead of a guess.

## [0.53.3] — 2026-07-15

### Fixed — one post's metadata carried ANOTHER video's transcript
- Live repro: the "middle of the night" post transcribed the neighbouring
  "222" video's audio. Two crossing paths closed:
  - **Embedded-JSON lookup now gets confident ids only** (permalink or
    duration-matched). It used to be seeded with every 15-19-digit run from the
    post markup — story/actor/comment ids that sit as JSON ancestors of a
    *different* video's media object in the hashtag page's combined scripts,
    handing back the wrong progressive/audio URL.
  - **`pickByDuration` returns null when two DIFFERENT videos fall inside the
    ±2s window** — no transcript beats a wrong transcript; the caller primes
    the video and exact-id paths get another chance.
- **Thumbnails were pixelated** in the Library grid: capture bumped from
  90px/q0.45 to 180px/q0.6 (card renders ~250px wide).

## [0.53.2] — 2026-07-15

### Fixed — rails STILL flickered; busy spinner reset mid-job
- 0.53.1's post-unit anchor wasn't enough: FB's virtualized feed remounts the
  **whole post subtree**, not just the player — any rail parented anywhere
  inside the feed dies with it (flicker), taking its busy/ok state along
  (the observed click → spin → reset). Feed rails now live in a
  **fixed-position overlay on `<html>`** — outside FB's React root entirely —
  and are positioned over their media on each sync tick + rAF-repositioned on
  scroll. Rail identity is keyed by video duration / image src (things that
  survive remounts), so the button element is never re-created and a running
  job's spinner keeps spinning until its result arrives.
- Button handlers bind a live getter (the tracked record's current media node)
  with a geometric fallback (the video under the rail), so clicks work no
  matter how many times FB has swapped the node since decoration.
- Reel/watch surfaces keep the verified in-DOM rail (their players don't
  churn); the overlay engages only on feed surfaces.

## [0.53.1] — 2026-07-15

### Fixed — first live pass on the hashtag feed
- **Rails flickered once per second and clicks opened the reel theater.** Both
  had one root cause: the rail was anchored to the video's parent, which FB
  destroys + re-creates every second while a video plays (rail died with it),
  and which sits inside the tile's click target (FB's delegated handler treated
  the button click as a tile click). Feed rails now hang on the post unit
  (`[role="feed"]` direct child) — stable across player re-renders and outside
  the click target — offset to the media's corner.
- The rail can now outlive the <video> node it was built with, so button
  handlers re-resolve the live video from the post unit when the bound node is
  detached.
- Re-injection after an extension reload strips the previous context's zombie
  rails instead of stacking a second rail next to them.

## [0.53.0] — 2026-07-15

### Added — hashtag-feed research surface
- **Download/Transcribe rails now show on hashtag feeds** (`/hashtag/<tag>/`),
  including the photo-download rail on image posts — not just reel/watch/video
  pages. Scoped live on `/hashtag/auralytrend/`.
- **Duration-keyed track matching.** Hashtag/feed posts bury the real
  `video_id` in page JSON only — the post markup never names it, so the old
  permalink/candidate resolution came up empty (or worse, guessed a junk
  15-19-digit id). The DOM video's `duration` now pairs it to a captured efg
  `duration_s` (±2s): new `pickByDuration` in `lib/fbcdn.js` (unit-tested), a
  `FBW_MATCH_TRACKS` background query so the content script gets a
  deterministic record id *before* building the job (embedded progressive/audio
  lookup then works for cached videos too), and a duration step inside
  `resolveTracks`. The hint is only sent when there's no permalink id, so
  reel/watch jobs can never cross to a same-length neighbour. Recency alone was
  provably wrong here: FB prefetches future posts' tracks while an earlier
  video plays.
- Jobs built without a trusted id (`!idConfident`) now prime the video first
  and skip the eager Library card, so a guessed id never mints an orphan record.

### Fixed — FB anti-scrape noise poisoned post scraping
- `findPostUnit` climbed onto junk on feed surfaces: FB scatters dozens of
  aria-hidden "Facebook" watermark spans inside each post, and the old scramble
  guard `/(?:Facebook ){4}/` expected spaces where innerText emits newlines.
  Feed posts now anchor to the `[role="feed"]` direct-child boundary (clean:
  author + caption + action bar, one video), and the guard matches `\s*`.
- `grabCaption` picked FB's invisible decoy blocks (scrambled strings, fake
  domains) over the real caption; `grabAuthor` could hit the same decoys. Both
  now skip `[aria-hidden="true"]` subtrees and zero-size rects — verified: all
  decoys render 0×0, real captions are visible and aria-exposed.

## [0.52.0] — 2026-07-13

### Fixed — found by reading the first real run log
- **The run log recorded no events at all** (`"events": []`). `start()` navigates
  to the target surface, which destroys the content script; the resume path
  rebuilds state from storage, and `runId` was never persisted. `emit()` bails
  when there's no `runId`, so every event after the navigation — i.e. all of them
  — was dropped. `runId` and `itemSeq` now persist and restore, and the run
  re-attaches to its event buffer (keyed by `runId`) so events from before the
  navigation stay in the same record.
- **The session mood was being erased by the same navigation.** The log said
  `mood 0.90`, the file said `sessionIntensity: 1` — `sessionIntensity` and
  `browseOnly` weren't persisted either, so every run reset to neutral intensity
  after navigating and the 0.50 realism pass was effectively dead. Both now
  survive the resume.
- **The dwell cap was a constant, and it showed.** Over half that run's dwells
  (15 of 29) were *exactly* 30s: the reels rail is mostly long-form, so the
  fraction dwell exceeds the ceiling on most items and every one clamped to the
  same number. Fifteen identical 30.000s watches is a signature no human
  produces. The cap is now rolled per item (23–34s) and recorded in the log.
- `flushOrphanRun` compares `runId` before shipping a buffer, so the run that
  just started can't be mistaken for an orphan and deleted.

## [0.51.0] — 2026-07-13

### Added — run telemetry
- **Every run is now recorded as structured events** and written to disk on
  finish: `~/Downloads/socialmate-runs/run-<timestamp>-<outcome>.json`. One file
  holds the run config (personality, mood, caps, pacing), the final counters, the
  human log, and the full event stream: `item`, `dwell` (planned vs actual ms,
  video length, watch fraction, watchedFull), `react` (**want vs got** — so a
  picker miss is visible), `no_react`, `feint`, `comment`, `comment_skip` (with
  the gate that declined), `skip`, `idle`, `break`, `pause`/`resume`, `halt`.
- The in-flight run is mirrored to `chrome.storage.local`, so a tab closed
  mid-run isn't lost — the next run flushes it as an `abandoned` file.

### Fixed
- **Comments were silently failing.** `fbCommentReel` had four distinct failure
  exits that all returned a bare `false`, so the log only ever said "did not
  post" — you couldn't tell whether the composer never opened, the send button
  wasn't found, or it actually posted and we misread it. It now reports *which*
  step failed, and the run log records it.
- Comment submit falls back to **Enter** (how a person actually sends a reel
  comment) when the send button can't be matched — its accessible name is
  localised, so a fixed aria-label list was always going to be partial. Also
  raised the composer wait 3.5s → 6s (the rail loads the drawer lazily).
- Breaks now show the **live seconds counter** like dwell and idle, instead of a
  static `☕ break ~166s`.

## [0.50.0] — 2026-07-13

### Added — human realism pass
- **Per-session mood.** Each run rolls its own engagement intensity (0.60–1.35×)
  and ~1 in 6 runs is **browse-only** (0.15–0.25×) — a session that mostly just
  scrolls. Stops every session having the same like-rate. Logged at start
  (`mood 0.87` / `👀browse-only`).
- **Engagement ramp / taper curve.** Reaction & engage probabilities follow a
  half-sine over the session — low at the start, peak mid-run, taper toward the
  end (people warm up then wind down) — instead of a flat rate.
- **Idle gaps.** ~4.5% of the time between items, a `💤 idle` pause of 18–85s
  ("got distracted / phone rang"), shown as a live countdown. Skipped if the
  session would end during it.
- **Hover-and-bail feints.** When the dice say *don't* react, ~9% of the time it
  travels to the like control, hovers a beat, then drifts away without clicking
  (`· hovered, didn't react`) — a person who looked but didn't engage.
- **Curved cursor travel.** Hovers now move the synthetic cursor along an eased
  bezier arc (jitter + occasional overshoot-correct) from its last position,
  instead of teleporting straight to the target. Movement events go to
  `document` so the in-flight path can't trip intermediate hover handlers.

> Note: our synthetic events are still `isTrusted: false`. This pass hardens
> against *behavioral* heuristics (rate/regularity/precision), not the trust
> flag — the biggest real risks remain account-level (IP, fingerprint, age, rate).

## [0.49.0] — 2026-07-13

### Fixed
- **Reactions actually go through now (was only ever Liking).** The engine
  opened the picker but then ran the *slow* `humanClick` on the reaction chip —
  a 0.5–1.1s hover before the click — which let FB's picker close/deselect, so
  the click committed a plain Like (and the degrade-to-Like fallback hid it).
  `humanHover` now also fires `pointerenter`/`mouseenter` (highlights the chip),
  and reactions use a **fast** chip click (brief hover, immediate press) that
  keeps the picker alive. [VERIFIED live: Haha → "Alterar reação Haha" applied.]

### Added
- **Live dwell counter in the log.** The watch line now counts up in place
  (`👀 dwell (full) 3s / 7s`) while the reel/post plays — the panel polls the
  log every second, so a single entry animates — and flips to `✅ dwell 7s` when
  done, so you can see how long each item takes and how long is left.

## [0.48.0] — 2026-07-12

### Changed (performance / memory)
- Added the `unlimitedStorage` permission and shrank the stored thumbnail
  (90px / q0.45) — the thumb was ~78% of each transcript record, which could hit
  the 10 MB quota and silently drop new transcripts.
- `trackRegistry` (background fbcdn track capture) is now pruned to the 300
  most-recent entries; it grew unbounded for the whole warm session.
- `fbPickPost` gates on cheap checks first and only hashes the one in-view
  candidate, instead of enumerating + hashing every accumulated feed child.

## [0.47.0] — 2026-07-12

### Added
- **Comment on fully-watched reels (first version).** A new "💬 Comment on reels"
  card (FB · Reels) lets the warmer rarely post one of your phrases — but only on
  a reel it watched to the end, and heavily capped. The composer flow is
  [VERIFIED live]: click the reel's "Comentar" button → inline Lexical editor →
  type the phrase char-by-char (`execCommand('insertText')`, emoji included, e.g.
  "So true 💫") → click "Postar comentário" → success = the editor clears →
  collapse the composer and continue the reel flow.
  - **Editable phrase pool** (mirrors the ugc-factory headlines UX): seed set of
    mystic/astro one-liners with emoji, each row editable, a trash button, and an
    "Add" input (Enter or +) that appends a new line. Persists in `swOptions`.
    The whole list is the random pool (never repeats back-to-back).
  - **How-often** slider (2–30% of full watches; default 8%) + "only fully-watched"
    is on by design for this version.
  - **Safety**: ≤10 comments/hour (hard), ≤1 per creator/session, never
    back-to-back, warm-up skip, once-per-reel dedup, and a soft-block halt if a
    post doesn't clear the editor. Counter shows 💬 in the running view.

## [0.46.0] — 2026-07-12

### Added
- **Pick any of Facebook's 7 reactions, not just Like.** The warmer can now send
  Like · Love · Care · Haha · Wow · Sad · Angry, chosen as a weighted mix (Like
  dominant, the rest sprinkled in) from the ones you enable in a new "Reactions"
  chip row (FB, when Like is on). It hovers the like control to open FB's
  reaction picker and clicks the chip — [VERIFIED live] that a content-script
  (synthetic) hover+click actually applies the reaction on a reel
  (Like→"Alterar reação Uau"/"…Força"). Wired into both the reels loop and the
  hashtag-posts loop; a per-reaction breakdown shows in the running counters.
  If the picker ever misses, it degrades to a plain Like (never a false
  soft-block). Localized picker names (pt-br verified: Curtir/Amei/Força/Haha/
  Uau/Triste/Grr).

### Fixed
- **Per-item dwell capped at 30s.** The reels rail mixes long-form video (60s+),
  and watch-full sat through the whole thing — 60–100s on one item. Watch-full
  now only applies to genuinely short reels (≤40s) and every dwell (reels and
  posts) is hard-capped at 30s, so the warmer keeps moving.

## [0.45.0] — 2026-07-12

### Changed
- **Tabs now flow the accent gradient like liquid.** Both the Warmer/Library
  segmented control and the Library sub-tabs (Transcripts/Saved) use a single
  accent-gradient indicator that is JS-positioned over the active tab and
  transitions its `left`/`width` (`cubic-bezier(0.25,0.8,0.25,1)`, 300ms), so
  switching tabs slides the brand color smoothly left/right instead of snapping.
  The gradient is themed (Smart blue in light, Brute red→yellow in dark) with
  black/white text per the contrast rule. Modeled on the unFunnelizer website's
  `.nav-highlight`. Repositions on resize; no animation flash on mount.

### Fixed
- **Toggle switches no longer show a white edge.** The `border-2 border-transparent`
  seamed against the accent gradient and the thumb was `bg-background` (a dark
  blob in dark mode). Now the gradient fills the whole pill (no border), the
  thumb is a clean white circle (design-doc §10.7), and the stray UA focus
  outline is removed (accessible `focus-visible` ring kept).

## [0.44.0] — 2026-07-12

### Added
- **Transcripts store the source reel URL.** Each capture now records a clean
  permalink (`/reel/<id>` or `/watch/?v=<id>`) for the video, and the Library
  card's thumbnail links back to it (plus a small ↗ button) so you can reopen
  the reel to re-transcribe or re-download. Old records fall back to a URL
  reconstructed from the id.

## [0.43.0] — 2026-07-12

### Changed
- **Dark theme now uses the Brute red→yellow accent** (`#ff4d4d`→`#f9cb28`),
  matching the unFunnelizer model (light = Smart blue, dark = Brute). Wordmark,
  primary button, tab underline, and transcript links all follow the accent;
  text on the Brute gradient is black per the contrast rule. Tokenized the last
  hardcoded blues (TabNav divider, transcript export links, Start button text)
  so they theme correctly.

### Added
- **Transcript card appears instantly on click.** The content script now writes
  a "running" record (thumbnail + author + caption already in hand) the moment
  you hit Transcribe, so the reel shows up in the Library → Transcripts list
  immediately instead of only after the job resolves. Transcription prefers the
  embedded audio-only stream (deterministic id, so the eager card matches the
  final one) and no longer waits on video priming.

## [0.42.0] — 2026-07-12

### Added
- **Embedded progressive_url fallback — Download/Transcribe now work on cached
  videos.** FB embeds each delivered video's direct progressive MP4 URL
  (audio+video, single file) under `videoDeliveryLegacyFields` in
  `<script type="application/json">` blocks. The content script reads it on
  demand (`fbProgressiveUrlFor`) by walking that JSON and matching the target
  video's id via its nearest ancestor id, so a Download/Transcribe no longer
  depends on having seen the video's fbcdn tracks on the wire (the old failure
  mode when a reel was served from cache). Runs only on click/capture, and only
  JSON.parses the few scripts that mention both an id and a url — no per-frame
  cost. Verified live: a reel downloads as `fb-<id>.mp4` and transcribes with no
  fresh network capture.
  - **Download** uses the progressive URL (single file, no offscreen mux).
  - **Transcribe** prefers a captured audio-only DASH track; when none exists it
    uses the **audio-only representation `base_url`** from the same embedded JSON
    (small, ~13s) — never the full progressive video, which decoded too slowly
    and timed out. Verified: a reel that was never played transcribes in ~13s.

## [0.41.0] — 2026-07-12

### Changed
- **Unified azure design + light/dark themes.** Dropped per-social-network
  retinting — one brand (Smart azure → seaFoam) across the whole panel, matching
  the unFunnelizer design system. shadcn tokens remapped, so every component
  re-skins at once; primary actions are now the Smart-blue gradient. A header
  sun/moon toggle switches light/dark (defaults to the OS preference, persisted).
- **On-page buttons only on reel + video-post pages.** Removed the per-post
  Download/Transcribe rail from the home/profile **feed** — there you open the
  reel to grab it. Reel and video-permalink pages keep the rail; the reels-tab
  thumbnail button is unaffected.
- **Library opens on Transcripts** (was Saved) and the **History tab was
  removed** — Library is now Transcripts + Saved.

### Performance (code review pass)
- **Removed the per-second canvas readback.** The transcription content script
  was scraping + JPEG-encoding the in-view `<video>` (`grabThumb` → canvas
  `toDataURL`) every second and on every scroll frame to publish `fbw_current` —
  which no longer has any consumer since the panel's Current-video card was
  removed. Deleted the interval, its scroll/resize/visibility listeners, and the
  publish path. Metadata/thumbnail is now scraped only on demand (button click /
  auto-capture). Big CPU/GC saving on every FB tab with a video.
- **Blob URLs from transcript exports (.txt/.srt) are now revoked** after the
  download hands off, instead of leaking for the panel's lifetime.
- **No theme flash** — the OS light/dark preference is applied before first
  paint (in `main.jsx`), and the reel rail-cleanup now runs after the
  MutationObserver is disconnected to avoid extra decorate passes.

## [0.40.0] — 2026-07-12

### Changed
- **Two-tab shell — Warmer · Library.** The panel is now two top-level tabs.
  **Warmer** → pick a platform → that platform's workspace; a platform's tools
  show as a segmented sub-nav inside the workspace, which is where the Instagram
  **Sort + Download** and **Stories** tools now live (alongside Warm). **Library**
  → Saved / Transcripts / History. Opens on the active tab's platform.
- **Library is a 2-column grid** of big thumbnail cards — portrait preview,
  counts strip over the image, author, caption, inline transcript toggle, and
  copy/.txt/.srt export. Replaces the old cramped horizontal rows. The panel-side
  "Current video" card was removed (on-page buttons do capture now).
- **Reel action buttons moved to the right side** of the reel (they were over
  FB's mute control at top-left); feed videos keep the top-left rail.

### Fixed
- **Author no longer "unknown" on followed reels.** The name is read off the
  follow control, which reads "Seguindo/Following <name>" once you follow the
  page (not just "Seguir/Follow <name>"); a generic "View owner's profile" link
  now falls back to its visible text ("Laura Shift") instead of being skipped.
  (Existing transcripts keep their stored author; the fix applies to new ones.)
- **Feed Download/Transcribe reliability.** Buttons now *prime* the target video
  — centre it, play it, and wait until it is actually streaming — before sending
  the job, so a feed video FB had paused/unloaded gets its fbcdn tracks fetched
  (and captured) instead of resolving nothing. Failures show ✗ with a retry hint.

## [0.39.1] — 2026-07-12

### Fixed
- **Reel buttons no longer pause the video** — the click handler used to pause
  every other `<video>` and play the rail's bound node; on a reel (several video
  elements, FB swaps them) that paused the reel you were watching. Now it never
  pauses neighbours, only plays a paused target, and swallows the whole pointer
  sequence (pointerdown/mouseup too) so FB's tap-to-pause never fires.
- **Reel jobs target the active reel** — Download/Transcribe on a reel now
  resolve the currently-visible reel at click time instead of the (possibly
  stale/preloaded) node captured when the rail was built, so the transcript/
  download matches what's on screen. Reel pages now get exactly one rail.
- Longer per-video wait (2.2s) before the job so the media has a beat to
  (re)fetch its fbcdn tracks. (Known limit: a fully-cached video exposes no new
  fbcdn request to capture — let it stream once, then retry; the button shows ✗.)

### Added
- **Reel-thumbnail download restored** — the old profile-thumbnails feature is
  back as a single floating “Download reel thumbnails” button that appears only
  on a profile’s Reels tab (auto-scrolls the lazy grid, saves to
  Downloads/socialMate-thumbs/&lt;page&gt;/). Keeps the side panel clean
  (Warm + Library) — all download/transcribe actions are now on-page and
  contextual.

## [0.39.0] — 2026-07-12

### Added
- **On-page Download / Transcribe buttons** — a small action rail is injected
  directly onto each Facebook video (feed, reel page, video-post page): Download
  + Transcribe; standalone photo posts get Download. Buttons act on the SPECIFIC
  media they belong to (play-in-place → capture tracks → job), and flip to ✓/✗
  when the background reports the result. Built the IG-overlay way for memory
  safety: one injected `<style>`, one debounced MutationObserver disconnected
  while appending (never self-triggers), dataset dedup, size + near-viewport
  gating so decoration stays bounded on long feeds. No React-internals hooking.
- **Facebook photo download** — largest fbcdn/scontent image in a post →
  `FBW_DL_MEDIA` (background fetch → data URL → downloads).

### Fixed
- **Reel-surface metadata scrape** — `grabVideoId` now reads the `/reel/<id>` ·
  `/videos/<id>` · `/watch?v=` id straight off the URL (reel pages hang no
  permalink near the player, so the id was null and jobs relied entirely on the
  fbcdn-track fallback). `grabAuthor` reads the creator off the “Seguir/Follow
  <name>” button and skips the generic “Ver perfil do dono / View owner’s
  profile” link that was mislabelling the card. Reel metadata now anchors to the
  “Change Position” slider card instead of the generic ancestor climb (which the
  multi-`<video>` guard broke early on reel pages).

### Changed
- **Facebook side panel simplified** — Facebook is now a single-tool surface
  (Warm); the panel opens straight into the Warmer, and per-video
  Download/Transcribe live as on-page buttons with results in the global Library
  (Transcripts / Saved). The old profile-thumbnail “Download” tool was removed
  from the FB hub. Single-tool platforms skip the hub grid and back-navigates
  Home.

## [0.38.0] — 2026-07-11

### Removed
- **Deep relevance (Whisper-for-relevance) removed end-to-end** — the engine
  flag/state, the quick-transcript request path (`FBW_QUICK_TRANSCRIBE`), the
  offscreen `quickTranscribe` action + cache, and the post-side helpers
  (`fbVideoIdCandidates`, `whisperLangFor`, `WHISPER_LANG`). Full transcription
  (Transcripts tab / auto-capture) is untouched.

### Fixed
- **Pagination-aware empty-scroll counter** — hashtag/feed children only ever
  grow (~8/batch) and hydrate lazily near the viewport; a growing child count
  during an empty stretch now resets the empty-scroll counter (progress, not
  selector loss), so slow pagination can't accrue misses toward a false
  "selectors not found" halt.
- **Fresh-node re-queries in the posts loop** — `fbPostStats` and the
  already-reacted check re-query the like control from the post root instead
  of trusting the enumerated node; FB's windowed hydration swaps a post's
  inner nodes when it leaves/re-enters the viewport window.

## [0.37.1] — 2026-07-11

### Fixed
- **Start silently doing nothing after an extension reload** — reloading the
  extension orphans the content script in every open FB/IG/TT tab
  ("Receiving end does not exist"), and the panel swallowed the send failure.
  Two-sided fix: the background now re-injects all manifest content scripts
  into matching open tabs on `onInstalled` (new `scripting` permission; every
  content script already carries an init guard, so double-injection is a
  no-op), and the panel shows a "tab isn't responding — Reload tab" banner
  (with button) after 3 failed status polls, disabling Start meanwhile.

## [0.37.0] — 2026-07-11

### Fixed
- **Sponsored detection localized** — `fbIsSponsored` matched only the literal
  "Sponsored", so on non-English accounts the hashtag warmer would engage with
  ads. Now a case-insensitive set (en/pt-br/es/fr/it/de: "Patrocinado" …).

### Changed
- **Hashtag UI simplified to match Reels** — the AI card (niche-relevance
  slider, spam-guard switch, deep-relevance/Whisper toggle) is gone. Spam/scam
  guard stays ON via the engine default (no UI); the relevance gate is off (a
  hashtag feed is already on-niche); deep relevance dropped. English-only now
  shows only in Hashtag mode (the filter never ran in the reels loop).
- **Hashtag postKey stays author+caption hash** — hashtag-surface posts expose
  no permalink; the 15–19-digit ids in post HTML include per-render tracking
  tokens, so promoting them to the dedup key would break cross-session dedup.

## [0.36.0] — 2026-07-11

### Added
- **⚡ Quick mode** — panel switch (persisted in `swOptions`): 3–10s dwell per
  item and 1–2.5s action gaps, overriding watch-full/fraction dwell and the
  circadian pacing multiplier. Applies to the video loop (`reelDwell`) and the
  FB posts loop (`fbWatchPost`) on every platform. For fast test iterations —
  not for real warming sessions. Run-start log line gets an `⚡quick` marker;
  the flag survives navigation resume.

## [0.35.0] — 2026-07-11

### Added
- **Facebook Reels mode (C) restored** — panel shows Reels + Hashtag tabs for FB
  (Reels is the default). Simple flow: watch the reel to the end, advance via the
  next-card button, Like randomly by personality. Like-only (Save/Follow forced
  off for FB runs even though the engine adapter supports them).
- **Watch-full dwell** — `FB_VIDEO.watchFull`: dwell = the video's remaining
  runtime (+0.4–1.2s), for items ≤ 5 min; longer long-form items mixed into the
  reels rail fall back to the personality fraction dwell.

### Fixed
- **FB reels selectors localized** — the reels adapter was hardcoded to English
  aria-labels ("Like"/"Remove Like"/"Next Card"/"Save reel"/`/^follow/`) and dead
  on non-English accounts. Now uses the same localized exact-membership sets as
  the posts adapter (en/pt-br/es/fr/it), plus `FB_NEXT_CARD` ("Próximo cartão" …)
  and `descurtir`/`unlike` in the unlike set. Verified live on a pt-br account:
  active-card anchor (`Change Position` slider — unlocalized), advance soft-nav,
  menu → "Salvar reel".
- **Stale-card video reads** — `reelDwell` now reads the active container's
  `<video>` (FB keeps previous reel cards in the DOM above the viewport, so
  document-order queries hit the old card); generic video-loop Like now uses the
  synthetic pointer trail (`humanClick`) instead of a bare `.click()`.

## [0.34.0] — 2026-07-02

### Added
- **Time-based sessions** — Duration (min) is now the primary target (default 15,
  min 3); item count demoted to an optional "Max items" ceiling in Pacing.
- **Personality-driven breaks** — the engine idles between items on a randomized
  cadence per personality (Binge 12–20m/20–60s, Casual 5–9m/1–3m, Engaged
  8–14m/45–120s); panel shows an "on break" chip.
- **Watch-commitment** — dwell is a personality-driven fraction of each video's
  length (Binge 70–100%, Casual 15–50%, Engaged 40–80%), clamped to
  [reelDwellMin, 4×reelDwellMax]; falls back to the old dwell range when no
  duration is readable.
- **Session lifecycle + summary** — new `abandoned` outcome reconciled on panel
  mount from stale `fbw_session`; every end path writes `fbw_last_summary`;
  WarmTool shows a dismissible last-session recap card; history rows show
  outcome badge + runtime.
- `src/lib/sessionMath.js` — pure, vitest-covered session helpers.

### Changed
- **Renamed** the extension `socialWarmer` → **socialMate** (display name, wordmark,
  and the `socialMate-thumbs/` download folder). Internal storage keys unchanged.
- `FBW_START` settings: `durationMinutes` + `maxItems` replace `targetN` +
  `sessionCapMinutes`.

---

## [0.9.0 – 0.33.x] — between 2026-06-07 and 2026-07-02 · GAP, NOT A RELEASE ENTRY

> **This window was never logged.** Twenty-five versions shipped between `0.8.2` and
> `0.34.0` — a three-platform warmer picked up the whole research half of the product
> (capture, downloads, local transcription, Library) and the shell that holds it — and
> no per-version history survives to reconstruct. The list below is deliberately
> **undated and unattributed**: it is only what provably
> landed somewhere in here, read off artifacts still in the tree and off later entries
> that already treat these features as present. Nothing here was inferred from
> plausibility. Do not cite this section as a release record; for the current picture
> read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Landed in this window
- **The media pipeline.** The `chrome.webRequest` registry of fbcdn DASH tracks, the
  offscreen document, local Whisper transcription and the ffmpeg audio+video mux behind
  Download. Design spec dated 2026-06-08 (the day after `0.8.2`):
  `docs/superpowers/specs/2026-06-08-fb-video-transcription-download-design.md`. Every
  later entry that touches it (`0.38.0`, `0.41.0`–`0.44.0`, `0.48.0`) only fixes or
  trims something already built.
- **Instagram passive capture and its tools.** The MAIN-world `JSON.parse` hook plus the
  isolated bridge/overlay, with **Sort + Download** and **Stories / Highlights** on top.
  Specs `2026-06-30-swiss-knife-shell-ig-sort-design.md` and
  `2026-07-01-ig-stories-highlights-download-design.md`; `0.39.0` cites the IG overlay as
  the pattern to copy, and `0.40.0` only *moves* both tools into the new workspace.
- **The swiss-knife shell.** `App.jsx` went from one ~810-line monolith with a flat
  five-tab bottom nav (Warm · History · Transcripts · Saved · Download) to
  Home → platform hub → tool with per-tool panel components. The 2026-06-30 spec records
  that before-state as **v0.33.0**, i.e. at the very end of this window.
- **The Library** (Transcripts / Saved / History) and the profile **reel-thumbnail bulk
  download**. `0.34.0` renames the latter's download folder, `0.39.1` *restores* it and
  `0.41.0` *removes* the History tab — all three presuppose it.
- **MiniLM niche-relevance gating** of warm targets, including the Whisper-for-relevance
  path. Described as current in the 2026-06-30 spec, then dismantled in `0.37.0` /
  `0.38.0`.

### Also happened in this window
- **Facebook Reels mode (C) was dropped** at some point in here — `0.35.0` is titled
  "restored". When and why is not recorded.

---

## [0.8.2] — 2026-06-07

### Fixed
- Side panel no longer leaves a **white gap on the right** when the panel is wider than
  360px. `body` was locked to `width: 360px`, so the themed background wash (`--sw-wash`)
  only painted 360px and the rest of a resized panel showed bare white. Body now fills the
  panel (`width: 100%`, `min-width: 320px` — Chrome's side-panel floor) and content reflows
  to the available width.

---

## [0.8.1] — 2026-06-04

Mature multi-platform baseline (feature set as of this version; precise per-patch
boundaries for `0.6.x`–`0.8.x` not separately logged).

### Added
- **Detach to own window** — pop the bound platform tab into its own (unfocused) window so
  it keeps `visibilityState === "visible"` and Chrome won't throttle its timers; the run
  keeps scrolling while you work in other tabs.
- **Pacing controls** (collapsible) — action delay min/max, reel dwell min/max, and an
  optional session time cap (minutes, 0 = none).
- **Personality** select (Random / Binge / Casual / Engaged) driving Like/Follow
  probability and dwell.
- **English-only posts** filter for Facebook Feed/Keyword modes.
- Live counters (done / saved / liked / followed), timestamped log, ETA, and a status
  badge (idle / running / paused / halted) with an auto-halt banner on login wall /
  checkpoint / captcha / rate-limit / selector-loss.

### Changed
- Tab stays **locked to the bound tab by id** — switching browser tabs no longer drops the
  target; only a closed tab or a platform switch re-resolves it.

---

## [0.5.6] — 2026-06-04

### Changed
- **Standardized UI** — one white/black control surface for all three platforms. Only the
  brand identity changes per platform (logo gradient, wordmark color, glow, body wash);
  the rest of the chrome is neutral black/white.

---

## [0.5.5] — 2026-06-04

### Added
- **TikTok verified (logged in).** Favorite verified — count increments on click (TikTok
  keeps the "Adicionar aos favoritos" label and only bumps the count, so a click is treated
  as success). Follow verified via a synthetic content-script click (icon morphs `+` ↔ `✓`).
  Feed hooks `like-icon` / `favorite-icon` / `feed-follow`; detail view `browse-*`. TikTok
  selectors are language-independent (`data-e2e`).

---

## [0.5.4] — 2026-06-04

### Added
- **Instagram verified (logged in, pt-br).** Save verified live (`Salvar` → `Remover`,
  persists in `/saved`); Follow selector mapped (`Seguir` `div[role=button]`); Like / advance
  / resume made locale-aware.

### Fixed
- **Locale-dependent selectors.** Added a multi-locale `L` dictionary (en + pt + es/fr/it
  seeds) plus `nameOf` / `inSet` / `findByName` helpers in `content.js`; the IG adapter now
  matches via `L`. (FB adapters remain English-only — extend with `L` for non-EN FB
  accounts.)

---

## [0.5.2] — 2026-06-03

### Added
- Native **per-platform UI** — platform-specific theming applied via the `--sw-*` CSS-var
  bundle on `<html>` (later standardized in `0.5.6`).

---

## [0.5.1] — 2026-06-03

### Added
- **Multi-platform support** — Facebook, Instagram, and TikTok behind a **platform
  switcher** (`PlatformSwitcher.jsx`): three brand-logo buttons; the active logo fills the
  platform gradient and glows; disabled while a run is active.
- **Per-platform config** (`src/lib/platforms.jsx`) — brand SVG glyphs, supported `modes`
  (+ tab labels), `defaultMode`, `keywordPlaceholder`, and a `theme` CSS-var bundle.
- **Per-platform theming** — one swap retints logo / title / Start / badge / scrollbars /
  glow / body wash + shadcn `--primary` / `--ring`.

### Changed
- **Engine refactored to adapters** (`src/content.js`) — shared core (state / pacing /
  safety / counters / persistence / resume) + per-platform adapters. `platformForHost()`
  is the selector source of truth; one generic `videoLoop(adapter)` drives FB reels /
  IG reels+explore / TikTok For-You+search; FB keeps `postsLoop` for Feed/Keyword.
- Added safety patterns: consecutive like/follow caps + cooldown, resume-if-paused,
  end-of-results reload (TikTok search). Session key `fbw_session` gains a `platform`
  field; resume guards by host ↔ platform. Panel message names kept `FBW_*`.
- Manifest `host_permissions` + `content_scripts` extended to `*.facebook.com`,
  `*.instagram.com`, `*.tiktok.com` (one content script on all three).

---

## [0.1.0] — 2026-06-03

Initial **Facebook-only** build (MV3, CRXJS + React + Tailwind + shadcn-style components).

### Added
- Side-panel cockpit; vanilla content-script engine driving facebook.com via ARIA roles +
  accessible names (obfuscated FB classes never used).
- **Modes** — Reels (C), Feed (B), Keyword/#hashtag (A).
- **Actions** — Save (reels + posts), Like, Follow; English-only post filter.
- Human-started runs with randomized pacing (4–9s action, 6–15s reel dwell), per-run
  de-dup, N as a ceiling, and auto-halt on stop conditions.
- `background.js` opens the side panel on toolbar click. No backend, no auth — local only.
