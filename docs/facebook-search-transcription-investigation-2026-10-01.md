# Transcrição no feed de busca do Facebook

Investigação em 2026-10-01 com Chrome compartilhado, Chrome DevTools MCP e
Playwright MCP, na página https://www.facebook.com/search/top?q=manifestation.
Extensão carregada: socialMate 1.2.3. Aba visível durante as verificações.

## Implementação e validação após a investigação

Implementado a pedido do usuário:

- Botões nas buscas `/search/top`, `/search/posts` e `/search/videos`.
- Captura MAIN-world da hidratação e do GraphQL paginado, com índice limitado
  a 200 vídeos. O replay preserva respostas que chegam antes da mudança de URL
  na navegação SPA, inclusive buscas iniciadas fora da página de pesquisa.
- Áudio DASH, MP4 e legendas por vídeo. Legenda só é usada quando corresponde
  ao idioma selecionado; o áudio alimenta o pipeline existente nos demais casos.
- Associação pelo ID/capa, sem adivinhar pela duração. Links conflitantes com
  a capa e resoluções ambíguas são recusados. Resultados atualizam o botão pelo
  ID, inclusive quando jobs terminam fora de ordem.
- Contador do filtro com fundo, borda, sombra, blur e tipografia da barra de
  ordenação do Instagram. Centralizado em `left:50%`, `bottom:18px`; botão
  nativo com estado acessível, preservando a regra e o liga/desliga existentes.

Provas executadas no Chrome com a extensão carregada:

- Vídeo `1373473971651501`: transcrição pelo botão com legenda EN concluída,
  1.133 caracteres, 19 trechos, autor Joshua Williams.
- Vídeo `1131386115896619`: transcrição pelo áudio concluída, 411 caracteres,
  oito trechos, autor Manifest With Chris.
- Captura acompanhou a paginação até 31 vídeos com áudio disponível. Navegação
  para outra busca também foi exercitada; respostas grandes podem terminar de
  carregar depois de o Facebook já ter desenhado o primeiro card.
- Contador conferido visualmente; diferença medida entre seu centro e o centro
  da área útil da janela: 0,17 px. Fundo `rgba(17,20,32,.92)`, borda
  `rgba(150,185,255,.35)` e blur de 8 px. Liga/desliga exercitado e regra restaurada.
- `npm test`: **75 arquivos, 919 testes passando**. `npm run build` e
  `git diff --check`: sucesso. O build mantém avisos de tooling e tamanho de
  chunks, sem erro de compilação.

Os registros das duas transcrições de validação foram mantidos na biblioteca.
O histórico abaixo descreve o estado anterior à implementação.

## Conclusão

A busca oferece DOM, identidade de vídeo, mídia e, em alguns casos, legendas
suficientes para adicionar ações de transcrição nos posts. O bloqueio visual
imediato é `surfaceAllowsMediaButtons()` em `src/content/transcription/inject.js`:
a função permite reels, vídeos, watch e hashtags, mas não `/search/top`.
O content script está carregado (`__fbwTranscribeInit === true`).

Liberar a rota resolve a condição de exibição, mas a associação post → vídeo →
áudio precisa ser validada antes de considerar a funcionalidade pronta.
Na etapa inicial de investigação, ainda não havia sido executada transcrição
completa nem alterado código de produção; a implementação posterior está acima.

## Evidência no navegador

| Camada | Observação |
| --- | --- |
| DOM | Um `[role="feed"]`, com vídeos em seus filhos. Nem todos os posts de vídeo têm `[role="article"]`. |
| Player | `currentSrc` vazio e ausência de `<track>` não significam ausência de mídia; os dados estão no JSON e na rede. |
| Identidade no DOM | Os cards amostrados não expunham links `/reel/`, `/videos/` ou `/posts/` utilizáveis. Alguns vídeos tinham `poster`; outros, imagem de capa no card. |
| Inicialização | `<script type="application/json">` contém `data.serpResponse.results.edges`, dentro dos envelopes de hidratação. |
| Paginação | `POST /api/graphql/`, XHR, operação `SearchCometResultsPaginatedResultsQuery`, HTTP 200. |
| Variáveis | `count: 5`, `cursor`, `args`, `feedLocation`, `renderLocation`, `allow_streaming`, entre outras. |
| Resposta | Primeira paginação: 6.049.262 caracteres, 34 linhas JSON parseáveis, sete edges no bloco inicial. Segunda: 19.706.564 caracteres, 58 linhas. Não tratar o corpo como um único JSON. |
| Captura na página | Uma sonda temporária em `XMLHttpRequest.prototype.send` capturou a segunda resposta completa. Nesta busca, o transporte é acessível no MAIN world. |

O `doc_id` observado foi `39812831698315445`; é informação diagnóstica efêmera,
não um contrato para hardcode. Recomenda-se observar as respostas que o próprio
Facebook solicita, sem reproduzir tokens, cookies ou operações manualmente.

## Dados disponíveis por vídeo

Objetos `__typename: "Video"` trazem `id`, `permalink_url`,
`playable_duration_in_ms` em vídeos orgânicos, capas e:

```text
videoDeliveryResponseFragment
  videoDeliveryResponseResult
    id
    progressive_urls[].progressive_url
    progressive_urls[].metadata.quality
    dash_manifests[].manifest_xml
    dash_manifest_urls[].manifest_url

captions_url
video_available_captions_locales[]
  locale
  localized_creation_method
  captions_url
```

`videoDeliveryLegacyFields` estava nulo nos objetos examinados. O XML DASH
continha `Representation[mimeType="audio/mp4"]`, codec `mp4a.40.5`, com
`BaseURL`. O atributo `mimeType` estava na Representation, não na AdaptationSet.

Verificações feitas pelo service worker da própria extensão:

- Vídeo `823150870841024`: GET da faixa de áudio com `Range: bytes=0-1023`
  retornou **206 e 1.024 bytes**. O cabeçalho HTTP dizia `video/mp4`; a
  classificação de áudio vem da Representation no manifesto.
- Vídeo `1393672992797407`: legenda retornou **200, `text/srt`, 5.427 caracteres
  e 69 cues**. Era `id_ID`, descrita como tradução automática. Não serve como
  transcrição BR/EN sem uma decisão explícita de idioma.
- Os demais vídeos amostrados não tinham legenda disponível. O fluxo de áudio
  com Whisper continua necessário.

## O que a extensão já tem e o que falta

1. **Overlay por vídeo:** `buildVideoRail()`, `syncOverlayRails()` e
   `feedUnitAnchor()` já posicionam ações sobre vídeos de feeds. O overlay vive
   em `<html>`, fora da árvore React do Facebook, e reposiciona ao rolar.
   Incluir as rotas de busca de posts pretendidas no gate de superfície.
2. **Captura contínua:** adaptar o padrão MAIN-world XHR + relay já utilizado em
   `src/content/fb/photos-capture.js`. Capturar a hidratação inicial e cada linha
   das respostas GraphQL de paginação; extrair somente registros normalizados
   de vídeo. Evitar transmitir/reter os corpos de vários megabytes.
3. **Áudio direto:** `fbEmbeddedMediaFor()` reconhece `progressive_url` e objetos
   JSON `base_url` de áudio, mas não interpreta `manifest_xml`. Adicionar leitura
   do DASH para obter a faixa de áudio por ID, sem depender de reprodução prévia.
   Manter `webRequest`/registro de faixas como fallback.
4. **Identidade:** preferir um permalink/ID do próprio card quando existir.
   Investigar correspondência única da capa com o registro capturado, usando
   duração e metadados do mesmo post como validação. Não usar apenas posição na
   lista, último request ou duração como identidade. Essa correspondência ainda
   precisa ser implementada e testada, especialmente após remount e scroll.
5. **Legendas:** passar `captionUrl`/idioma apenas quando adequados ao idioma
   escolhido. O background já tem fluxo caption-first e um parser que aceita
   timestamps com vírgula ou ponto; validar o SRT real nesse fluxo. Sem legenda
   compatível, usar a faixa de áudio e o pipeline existente de transcrição.
6. **UI:** reaproveitar os estados de idioma, progresso, erro e conclusão. Uma
   eventual exibição do texto dentro do post precisa vincular os resultados ao
   ID, limitar altura e sobreviver às substituições do DOM.

### Ambiguidade observada

Os vídeos iniciais `823150870841024` e `1393672992797407` tinham duração de
141,867 s e 142,367 s. Ambos caem na tolerância de ±1,5 s de
`fbEmbeddedResolve()`. O código rejeita múltiplos candidatos por duração, mas
isso impede a resolução direta quando a legenda do post também não corresponde.
Nesta página o Facebook exibia texto traduzido em português; comparar esse texto
com o original do JSON pode falhar. Não foi demonstrada uma transcrição trocada.

Os comentários antigos que dizem que toda paginação do Facebook ocorre fora da
main thread não descrevem esta superfície observada. Não generalizar a evidência
da busca para todas as outras superfícies do Facebook.

## Contador com a UI antiga

O elemento da captura do usuário é `#sw-fbfilter-chip`, criado por `paintChip()`
em `src/content/fb/feed-filter.js`. Conta itens exibidos/ocultos pelo filtro e
permite ligar/desligar ao clicar. A regra persistida observada em `sw_fb_filter`:

```json
{"on":true,"mode":"or","min":{"comments":2000,"likes":null,"shares":200}}
```

O gradiente `#3c7cfc → #59c0e8`, a pílula e a sombra estão codificados diretamente
em `chip.style.cssText`. A UI nova do painel usa a paleta Nord de `src/index.css`,
que não é aplicada automaticamente ao documento do Facebook. O rail de vídeo
também mantém CSS azul próprio em `ensureBtnStyle()`.

Portanto, o contador ficou fora da migração visual. Migrar os estilos injetados,
com escopo próprio, para os mesmos tokens/cores da UI atual. Usar um botão
semântico com foco e estado acessível ao revisar o contador; não importar o CSS
global do painel no Facebook.

## Critérios identificados na investigação

- Botão aparece no vídeo correto no carregamento inicial e após duas paginações.
- Post sem legenda, com legenda compatível e com legenda de outro idioma.
- Vídeos de duração semelhante, anúncios, cards sem permalink e feed filtrado.
- Scroll, remount, aba oculta/visível e navegação SPA não trocam o alvo do botão.
- Resultado completo de transcrição com ID, texto, idioma e metadados corretos.
- Regressão em reels/hashtags e conferência visual com a UI atual.

As sondas XHR e Playwright foram removidas e o scroll retornou ao topo. A aba de
busca permanece aberta. Não foram alterados filtros persistidos nem guardados
cookies, tokens, URLs assinadas de mídia ou corpos brutos das respostas.
