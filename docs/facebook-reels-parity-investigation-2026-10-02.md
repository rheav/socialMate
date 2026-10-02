# Paridade Instagram → Facebook Reels

Investigação em 2026-10-02, com Playwright MCP e Chrome DevTools MCP no Chrome
compartilhado (porta 9222), perfil e extensões existentes. Escopo: análise e
sondas temporárias; nenhum código de produto alterado nesta investigação.

Páginas:
- https://www.facebook.com/profile.php?id=100092403319843&sk=reels_tab
- https://www.facebook.com/reel/2030018604348103

## Conclusão

A paridade é tecnicamente viável em grande parte: sort e filtros no DOM, rail de
métricas, salvar na biblioteca, baixar vídeo/capa e transcrever a partir da grade.
O backend de extração de voz também é reaproveitável, mas o fluxo completo em
Facebook precisa de validação própria. A principal lacuna é integrar os dados
ricos da hidratação e da paginação ao coletor de reels e às ações existentes.

O comentário atual de que a paginação não passa pelo XHR da main thread NÃO
descreve esta página/sessão. Uma sonda temporária em XMLHttpRequest.prototype.send
capturou respostas completas de paginação. Não generalizar esse resultado para
todos os layouts, perfis ou experimentos do Facebook.

## Provas no navegador

- Grade inicial: 10 reels. Rolagem levou a 70 e, depois do teste de reordenação,
  a 80. Visibilidade conferida como visible durante os testes.
- Operação: POST /api/graphql/,
  ProfileCometAppCollectionReelsRendererPaginationQuery, HTTP 200.
- doc_id observado: 28838816002422324. Diagnóstico efêmero; não hardcodar.
- Variáveis incluem count:10, cursor, id da coleção, renderLocation, scale e
  flags Relay. O id da coleção não deve ser presumido igual ao ID do perfil.
- Duas respostas analisadas integralmente: 8.934.008 e 7.508.005 caracteres,
  cada uma com 71 linhas JSON e 10 edges principais.
- Playwright capturou corpos e metadados; DevTools confirmou a operação na
  request 54. Sonda MAIN-world confirmou XHR, com zero fetch observado na sonda.
- Os 20 reels desses dois lotes expunham curtidas, comentários,
  compartilhamentos, views abreviadas, publicação, duração, autor, descrição,
  MP4 e DASH. Legendas estavam presentes apenas em parte deles.
- O reaproveitamento de gridCellOf/reorderCells, do código existente, foi
  exercitado em 70 células com um pai comum. 67 posições mudaram; a sequência
  resultante correspondeu ao sort decrescente e a restauração foi exata.
  Primeiros valores após sort: 1,5M, 1,4M, 1,1M, 300K.
- Uma ação temporária foi anexada a um card e teve área renderizada mensurável.
  Foi removida. Isso prova viabilidade de inserção, não a qualidade final da UI.
- A prova de sort foi pontual e restaurada; não valida sort ativo durante
  paginação, filtros persistentes, navegação SPA ou remontagem React.

## Estrutura de dados e associação

Hidratação inicial (dentro dos envelopes de script application/json):

    data.node.all_collections.nodes[].style_renderer.collection
      .aggregated_fb_shorts.edges[]

Paginação:

    data.node.aggregated_fb_shorts.edges[]
      .profile_reel_node.node                 # Story
      .profile_reel_node.node.attachments[].media  # Video

Campos úteis:
- Video.id: identidade do reel, usada para casar com /reel/<id> no DOM.
- Video.play_count_reduced: views abreviadas, por exemplo "210K".
- Story.creation_time: publicação da história.
- Video.created_time: criação do arquivo/vídeo; pode diferir da publicação.
- Video.playable_duration_in_ms.
- Story.actors, message, translated_message_for_viewer.
- Video.thumbnailImage, image, preferred_thumbnail.
- Video.videoDeliveryResponseFragment.videoDeliveryResponseResult:
  progressive_urls, dash_manifests.
- Video.video_available_captions_locales: idioma e URL da legenda.

As métricas chegam em respostas diferidas. O fragmento observado tem label:

    FBUnifiedVideoMediaTransitionContainer_video$defer$FBUnifiedVideoFeedbackBar_feedback

Nele:
- data.url identifica o reel;
- data.feedback.total_comment_count;
- data.feedback.share_count_reduced;
- data.fb_reel_react_button.story.feedback.likers.count.

O path do fragmento aponta para o índice de edges da resposta original.
É necessário associar fragmentos pelo path + ID/URL e IDs de feedback, dentro
da requisição correspondente. Não associar pela ordem de chegada: os fragmentos
chegaram fora da ordem dos cards. Também não coletar todo objeto Video como se
pertencesse ao perfil: uma resposta pode conter mais objetos de vídeo do que
os 10 reels da conexão principal.

Exemplo real da paginação:
- Reel 1568404074723397: 210K views, 13.921 curtidas, 6.400 comentários,
  "2.2K" compartilhamentos, 65,467 s.
- Reel 1009440842085173: 300K views, 7.498 curtidas, 2.669 comentários,
  "1.7K" compartilhamentos, 84,148 s.

Views e compartilhamentos abreviados produzem estimativas numéricas. Não
apresentar essas métricas ou taxas derivadas como números exatos. O campo
likers.count foi observado; não presumir que seja um total separado de todas
as categorias de reações. Contagem de salvamentos não foi demonstrada.

## Reel individual e Salvar

No reel 2030018604348103, a extensão mostra exatamente:
- Baixar vídeo;
- Transcrever vídeo (EN na sessão);
- Coletar comentários.

A causa está em src/content/transcription/inject.js:2050, buildVideoRail():
não há criação de botão de salvamento. buildReelTileRail(), linha 2068, só
adiciona baixar miniatura. É funcionalidade ausente, não evidência de bloqueio
do Facebook.

Salvar na biblioteca já existe em
src/components/tools/FbReelsTool.jsx:126, usando buildSavedEntry e
FBW_SAVED_TOGGLE. O background serializa a gravação e responde com o estado
final (src/background.js:1656). O novo botão pode usar esse contrato, espelhar
storage.onChanged e resolver o ID do reel ativo a cada ação.

O menu nativo do Facebook contém "Save reel", confirmado abrindo o menu.
Esse salvamento pertence à conta Facebook. O bookmark do socialMate pertence à
biblioteca da extensão; manter nomes e estados independentes. Nenhum dos dois
foi acionado durante a análise.

Dados do reel fornecido, na sessão:
- 4,4K views na grade;
- 125 curtidas, 32 comentários, 16 compartilhamentos;
- 87,167 segundos;
- MP4 e DASH disponíveis; nenhuma legenda no objeto de mídia examinado no player;
- autor Spiritual Revelations.

O player monta também vídeos de preloading fora da área visível. Salvar,
baixar e transcrever precisam apontar para o reel ativo, não para o primeiro
objeto Video encontrado nem para o último request. A descrição visível estava
traduzida: manter texto original e tradução distinguíveis.

## Matriz de paridade

| Recurso | Estado atual do Facebook | Adaptação e confiança |
| --- | --- | --- |
| Ordenar a grade | Sort só no painel | Viabilidade demonstrada no DOM; integrar makePageSorter |
| Views, curtidas, comentários, compartilhamentos e data | Coleta parcial; data descartada | Dados encontrados também na paginação; novo parser e merge |
| Filtros combinados e múltiplas ordenações | Painel FB usa sort simples | Reaproveitar feedQuery/pageSorter com mapa de campos FB |
| Taxa de engajamento e views/dia | Ausentes na grade | Calculáveis com dados capturados; explicitar estimativas e fórmula |
| Views/seguidores | Ausente | Cabeçalho mostra 476K; fonte exata não confirmada, permitir desconhecido |
| Salvar/remover da biblioteca | Disponível no painel | Ligar o mesmo contrato ao card e ao player |
| Baixar capa | Botão nos cards e ação em lote | Reaproveitar e unificar aparência |
| Baixar vídeo pela grade | Ausente | MP4/DASH capturados permitem a implementação; validar download completo |
| Transcrever pela grade | Ausente; player já tem botão | Integrar mídia por ID ao pipeline existente; respeitar idioma |
| Extrair voz/remover música | Rail IG tem botão; FB não | Backend aceita mediaUrl; validar decodificação e resultado em FB |
| Data, duração, autor, descrição no overlay/biblioteca | Parcial | Disponíveis na rede; preservar na normalização e no salvamento |
| Progresso de reprodução/transcrição | FB já tem infraestrutura no player/painel | Reaproveitar componentes e estados, sem disparar trabalhos nesta análise |
| Comentários | Player já tem coleta | Preservar o fluxo e associar ao reel correto; grade exige adaptação do alvo |
| Copiar link | Existe no menu nativo | Ação simples com permalink canônico |
| Quantidade de salvamentos | Não confirmada | Não inventar nem usar zero como substituto de desconhecido |

## Lacunas e riscos concretos encontrados no código

1. src/content/fb/reels-capture.js:256 só enriquece scripts embutidos.
   A paginação rica observada não é incorporada, perdendo dados dos novos cards.
2. Mesmo na hidratação, o parser extrai apenas comentários e compartilhamentos;
   ignora curtidas, legenda, autor estruturado, datas, duração e mídia.
3. Linha 278 usa parseInt em share_count_reduced. "2.2K" vira 2, quando a
   aproximação correta seria 2.200. Usar o parseCount compartilhado.
4. Linha 312 fixa taken_at:null. Existe comparator de data em fbReels.js,
   mas sem preenchimento, e o seletor atual do painel nem oferece data.
5. makePageSorter identifica mudanças de grade por location.pathname
   (src/lib/shared/pageSorter.js:80–82). No FB, perfis diferentes podem usar
   o mesmo /profile.php e mudar apenas id/sk na query. Precisa de identidade
   de superfície que inclua perfil/aba; não copiar o adaptador IG sem ajuste.
6. src/content/fb/video-capture.js já fornece captura limitada e parser DASH,
   mas seu gate e detecção de operação são exclusivos de buscas SearchComet.
   Não supor que ele já captura esta grade e este player.
7. scanTiles usa o texto do link para views. Novos overlays dentro do link podem
   contaminar essa leitura: usar alvo de contador nativo ou dados normalizados.
8. UI do Facebook mistura rails, botão em lote e filtros. Ao trazer a barra
   de sort, revisar sobreposição, clique do card e eventos de pointer para que
   as ações não abram o reel nem alterem a reprodução involuntariamente.

## Implementação recomendada

1. Normalizar reels de hidratação + XHR GraphQL/partes diferidas em um índice
   limitado por ID, com escopo de perfil/coleção. Compartilhar a leitura de mídia
   existente, evitando duas varreduras completas dos mesmos corpos. Emitir só
   registros compactos entre MAIN e isolated world; não reter respostas de MB.
2. Completar os metadados e corrigir shares/datas. Adicionar campo de query FB,
   estado sw_fb_query e adaptador de makePageSorter. Sincronizar painel e DOM,
   preservar ordem original e manter dados desconhecidos como null.
3. Adicionar Salvar no player e nos cards, seguido de rail de métricas,
   vídeo/capa/transcrição. Usar a biblioteca e os jobs existentes.
4. Integrar extração de voz e aperfeiçoar a apresentação/progresso. Fórmulas de
   engajamento devem identificar compartilhamentos FB e não fingir equivalência
   semântica com reposts IG.

Critérios para considerar a implementação pronta:
- Carregamento inicial, duas paginações com sort ativo, filtros e restauração.
- Navegação entre perfis numéricos, aliases owner_reels/reels_tab e player.
- Remount, rolagem, mudança de aba e respostas diferidas fora de ordem.
- Mesmos metadados/ID entre painel, card, player e biblioteca.
- Salvar/remover sincronizado, sem perder transcrições já existentes.
- Download real, transcrição com/sem legenda e extração de voz end-to-end.
- Contagens abreviadas, ausentes e zero; data de publicação vs criação.
- Controles acessíveis, sem colisão visual ou navegação acidental.

## Limites e encerramento

A análise confirmou disponibilidade dos dados e viabilidade da reordenação,
não uma implementação pronta nem paridade de 100%. Não foram executados
downloads, transcrições, extração de voz, salvamentos ou ações sociais.

A ordem da grade foi restaurada, a rolagem voltou ao topo, o menu do reel foi
fechado, as sondas XHR/fetch foram removidas e os listeners/corpos temporários
do Playwright descartados. As duas abas criadas para análise permanecem abertas.
As abas preexistentes e alterações de código já presentes no repositório foram
preservadas. Não foi salvo HAR nem corpo bruto de requests; a evidência adjacente
contém apenas métricas e resultados sanitizados.

