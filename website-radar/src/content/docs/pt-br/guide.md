---
title: Guia do socialRadar
description: Como usar cada parte do socialRadar — ordenar posts, transcrever, a aba Salvos, o Spy e o Painel — com capturas de tela.
updated: 28 de outubro de 2026
updatedISO: "2026-10-28"
---

Este guia mostra cada parte da extensão, na ordem em que você vai usar. As capturas são da própria extensão, com contas fictícias (`*.demo`).

## Primeiros passos

<figure class="shot shot-panel">
  <img src="/images/docs/panel-home.webp" alt="O painel lateral aberto na aba Pesquisa, com a lista de plataformas" width="800" height="1560" loading="lazy" />
  <figcaption>O painel lateral na aba Pesquisa.</figcaption>
</figure>

### Instalar

1. Baixe o `.zip` da [última versão](https://github.com/rheav/socialmate-pub/releases/latest) e descompacte.
2. Abra `chrome://extensions` e ligue o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta descompactada.
4. Fixe o ícone do socialRadar na barra do Chrome. Um clique nele abre o **painel lateral**.

Funciona também no Edge e no Brave, pelo mesmo caminho (`edge://extensions`, `brave://extensions`).

### O painel lateral

O cabeçalho tem quatro coisas:

- **Logo** — volta ao início da aba Pesquisa.
- **Ícones das redes** — mostram qual rede o painel está acompanhando e deixam trocar de rede na mão.
- **Painel** — abre o [Painel do Spy](#o-painel-dashboard) numa aba do navegador.
- **Engrenagem** — abre as [Opções](#opções).

Embaixo ficam as três abas:

| Aba | Para quê |
| --- | --- |
| **Pesquisa** | As ferramentas da rede que está aberta: ordenar, stories, comentários, filtro, fotos, pastas. |
| **Arquivo** | Suas **Transcrições** e seus **Salvos**, de todas as redes. |
| **Spy** | Os perfis que você acompanha e a medição diária. |

**O painel acompanha a sua aba.** Abra o Instagram e ele mostra as ferramentas do Instagram; mude para uma aba do TikTok e ele muda junto. Não precisa escolher nada.

## Ordenar posts

A ferramenta mais usada. Ela coloca os posts de um perfil (ou de uma hashtag, de uma busca) na ordem que você quiser: mais vistos, mais comentados, melhor taxa de engajamento.

<figure class="shot shot-panel">
  <img src="/images/docs/panel-ig-sort.webp" alt="Ordenar no Instagram: barra de ferramentas e a grade de posts ordenada por visualizações" width="800" height="1800" loading="lazy" />
  <figcaption>Instagram › Ordenar, por visualizações.</figcaption>
</figure>

### Como funciona

1. Abra um **perfil**, uma **hashtag**, uma **busca** ou o **Explorar** no Instagram.
2. No painel, vá em **Pesquisa › Instagram › Ordenar**.
3. **Role a página.** A extensão lê os posts que o próprio Instagram carrega e monta a grade no painel. Para não rolar na mão, use o botão **Coletar** (veja abaixo).
4. Escolha a ordem em **Ordenar por**.

A ordem vale nos dois lugares: a grade do painel **e a grade do próprio Instagram** são reordenadas juntas.

### A barra de ferramentas

Da esquerda para a direita:

| Botão | O que faz |
| --- | --- |
| **Ordenar por** | Visualizações, Velocidade (views por dia), Curtidas, Comentários, Reposts, TE %, Alcance (views ÷ seguidores), Curtidas / views %, Comentários / views %, Reposts / views % ou Data. **Padrão** mantém a ordem do Instagram. |
| **Período** | Só posts dos últimos 7, 14, 30, 90 ou 180 dias, do último ano, dos últimos 2 anos, ou todo o período. Bom para hashtags, que misturam posts antigos. |
| **Seta** | Inverte a ordem: maior → menor ou menor → maior. |
| **Atualizar** (seta circular) | Limpa tudo o que foi coletado no Instagram e recolhe a página atual. Pede um **segundo toque** para confirmar, porque apaga a captura de Ordenar e de Stories. |
| **Coletar** (setas para baixo) | Rola a página sozinha, 10 vezes, em ritmo humano (3 s, depois 6 s, depois 10 s), para o Instagram carregar mais posts. Toque de novo para parar. |
| **Transcrever todos** | Põe na fila, um de cada vez, os vídeos da lista que ainda não têm transcrição. |
| **Comentários de todos** | Abre, um por vez e em aba própria, até 15 posts da lista e lê os comentários e respostas (20–40 s entre um post e outro). |
| **Planilha** | Exporta os posts listados para `.xlsx`, com seguidores, TE, views por seguidor e o áudio usado. |
| **Tudo** | Baixa todos os posts listados para a sua pasta de downloads. |

Passe o mouse sobre qualquer botão para ver o nome dele.

### Cada card da grade

- **Coluna da esquerda:** **Salvar** (vai para [Arquivo › Salvos](#salvos) e fica amarelo), **Baixar a mídia**, **Baixar a miniatura** e **Transcrever**. O botão de transcrever gira enquanto trabalha, fica verde quando termina (um toque abre o texto) e vermelho se falhar.
- **Canto superior direito:** o tipo do post — vídeo, carrossel ou foto.
- **Os números:** visualizações, curtidas, comentários, reposts, **TE %** e a data. A caixa **O que significam os números** explica cada ícone.
- **Clique na imagem** para abrir o post no Instagram.

### Filtros e desempate

<figure class="shot shot-panel">
  <img src="/images/docs/panel-ig-filters.webp" alt="A caixa Filtros e desempate aberta, com um filtro de visualizações e um critério de desempate" width="800" height="1800" loading="lazy" />
  <figcaption>Só posts com 500 mil views ou mais, desempatando por TE.</figcaption>
</figure>

Toque em **Filtros e desempate** para abrir a caixa.

- **Regra de filtro:** escolha um campo, uma condição e um valor — por exemplo *Visualizações ≥ pelo menos 500000*. Pode somar várias regras.
- **Critério de desempate:** o que decide entre dois posts empatados no critério principal. Na captura, depois de Visualizações, desempata por TE %.
- O número ao lado de **Filtros e desempate** diz quantas regras estão ativas; **limpar filtros** apaga todas.
- Os filtros também valem na página do Instagram: **os posts que não passam somem de lá**.
- O contador ao lado da página mostrada passa a ser *mostrados/coletados* (na captura, 10 de 12).

### Peso do TE

TE é a **taxa de engajamento** de cada post:

> TE % = (curtidas × peso + comentários × peso + reposts × peso) ÷ visualizações × 100

Os pesos padrão são **1** para curtida, **4** para comentário e **4** para repost, porque comentar e repostar dão mais trabalho do que curtir. Mude os números em **Peso do TE** se o seu nicho pede outra conta; a grade e a sobreposição na página recalculam na hora.

### Página mostrada

O seletor **Seguir a página** decide quais posts aparecem:

- **Seguir a página** (padrão) — só os posts da página que você está vendo agora. Muda sozinho quando você navega.
- **Uma página da lista** — fixa uma página que você já visitou (outro perfil, uma hashtag), mesmo depois de sair dela.
- **Tudo** — tudo o que foi coletado nessa aba.

### Sobreposição no Instagram

Com a chave **Sobreposição de estatísticas no Instagram** ligada, cada post da grade do próprio Instagram ganha um selo com os números e os botões de salvar, baixar e transcrever. Desligue se preferir a página limpa. A mesma chave existe em [Opções](#opções), para cada rede.

### TikTok e Reels do Facebook

- **TikTok › Ordenar** funciona igual ao Instagram: abra um perfil, uma hashtag, uma busca ou um som, role (ou colete) e escolha a ordem.
- **Facebook › Ordenar Reels** funciona na aba **Reels** de uma página ou perfil. **Coletar tudo** rola a grade até carregar todos os reels; o olho mostra ou esconde os números na página.

## Transcrever vídeos

O botão **Transcrever** aparece:

- nos cards de **Ordenar** (Instagram e TikTok);
- nos botões que a extensão desenha sobre os vídeos na própria rede: reels e posts do Instagram, vídeos do TikTok, reels, vídeos e as buscas e hashtags do Facebook.

A transcrição roda **no seu computador**, com o Whisper. Nenhum áudio sai da máquina. Na primeira vez o modelo leva alguns segundos para carregar.

**Idioma:** escolha **BR**, **EN**, **ES** ou **AUTO** (detecta sozinho) no topo de Arquivo › Transcrições, ou em Opções › Transcrição. Vale para as **próximas** transcrições; as que já foram feitas guardam o idioma com que foram geradas.

O resultado vai para **Arquivo › Transcrições**.

## Arquivo

A aba **Arquivo** junta o que você guardou, de todas as redes. Ela tem duas partes, **Transcrições** e **Salvos**.

### Transcrições

<figure class="shot shot-panel">
  <img src="/images/docs/panel-archive.webp" alt="Arquivo › Transcrições com três vídeos transcritos e o seletor de idioma" width="800" height="1560" loading="lazy" />
  <figcaption>Arquivo › Transcrições.</figcaption>
</figure>

Cada vídeo transcrito vira um card:

- **No alto:** abrir o post original, **salvar** (copia o card para Salvos) e apagar.
- **Os números do post:** curtidas, comentários, visualizações, data e duração.
- **Transcrição:** toque para abrir o texto. O selo ao lado (BR, EN, ES) é o idioma usado.
- **copiar** · **.txt** · **.srt** — copia o texto ou baixa como arquivo de texto ou legenda com tempos.

O seletor **BR / EN / ES / AUTO** define o idioma das próximas transcrições. **limpar tudo** apaga todas (pede confirmação).

Por padrão ficam guardadas as **20** mais recentes. Para guardar mais, vá em Opções › Arquivo (20, 50, 100, 300 ou sem limite).

### Salvos

<figure class="shot shot-panel">
  <img src="/images/docs/panel-saved.webp" alt="Arquivo › Salvos com posts agrupados por rede" width="800" height="1560" loading="lazy" />
  <figcaption>Arquivo › Salvos, agrupados por rede.</figcaption>
</figure>

**Salvos** é a sua coleção de referências: os posts que você marcou para estudar depois.

**Como salvar um post:**

- no botão **Salvar** (marcador) de um card em Ordenar;
- no botão **Salvar** que aparece sobre o post na própria rede;
- no marcador de um card em Transcrições.

**Na aba Salvos:**

- Os posts ficam **agrupados por rede** (Facebook, Instagram, TikTok, Pinterest), com o total de cada grupo. A seta ao lado do nome recolhe o grupo.
- **Ordene** por Padrão, Visualizações, Curtidas, Comentários, Data do post ou Salvo em; a seta inverte.
- Cada card abre o post original e tem o marcador para **tirar dos Salvos**. Se o vídeo já foi transcrito, a transcrição aparece no card; senão, ele diz *sem transcrição*.
- **limpar** apaga só um grupo; **limpar tudo** apaga todos (os dois pedem um segundo toque).

As miniaturas são guardadas como imagem dentro da extensão. Por isso não quebram quando o link da rede expira. Cabem até 300 posts salvos.

## Spy: acompanhar perfis

<figure class="shot shot-panel">
  <img src="/images/docs/panel-spy.webp" alt="A aba Spy com a medição e a lista de perfis salvos" width="800" height="1560" loading="lazy" />
  <figcaption>A aba Spy no painel lateral.</figcaption>
</figure>

O Spy mede perfis do **Instagram** e do **Facebook** uma vez por dia e guarda a história de cada um: seguidores, posts, visualizações. Você vê tudo no [Painel](#o-painel-dashboard).

### Salvar um perfil

Há três jeitos:

- **Na aba Spy:** abra um perfil do Instagram ou do Facebook. O quadro **Perfil da aba ativa** mostra esse perfil com o botão de salvar.
- **Na própria página do Instagram:** o botão **Salvar no Spy** aparece no cabeçalho do perfil.
- **No Painel:** **Adicionar perfil** e cole o link do perfil.

Dá para acompanhar até **100** perfis.

### A medição

O quadro **Medição** mostra o que está acontecendo:

- **Medir agora** — mede os perfis salvos na hora, sem esperar a passada automática.
- A linha de status diz se há algo em andamento e quando será a **próxima passada automática**.
- **Hoje: 1 de 6 medidos · Instagram: 0 de 20 leituras do dia** — quantos perfis já foram medidos hoje e quanto do limite diário do Instagram já foi usado.

Cada leitura abre a página do perfil numa **aba em segundo plano**, uma a cada **20–40 segundos**, com a sua sessão. O limite padrão é de **20 leituras do Instagram por dia** (até 200, em Opções › Spy). O Instagram não publica um limite oficial: mais leituras aumentam o risco de verificação ou bloqueio temporário da sua conta. Use com moderação.

### Perfis salvos

Cada linha mostra o nome, a rede, o @ e o estado da última medição (por exemplo *só seguidores lidos · views na próxima medição*, logo depois de salvar). Os botões abrem o perfil e o tiram da lista; nos perfis do Facebook, um terceiro botão mede de novo. **Abrir painel** leva ao Painel.

As medições ficam **só neste navegador**.

## O Painel (dashboard)

O Painel é uma página inteira da extensão, numa aba do navegador. Abra pelo botão **Painel** no cabeçalho do painel lateral, ou por **Abrir painel** na aba Spy.

A coluna da esquerda tem **Adicionar perfil** e as seções **Top**, **Perfis**, **Stories** e **Leituras**. No canto superior direito: atualizar, configurações do Painel e tema claro/escuro.

### Top

<figure class="shot shot-wide">
  <img src="/images/docs/dash-top.webp" alt="A seção Top do Painel: os cinco posts mais vistos e o mapa de horários de postagem" width="1440" height="900" loading="lazy" />
  <figcaption>Top: os posts que mais performaram e os melhores horários.</figcaption>
</figure>

**Top posts** reúne os melhores vídeos de **todos** os perfis acompanhados.

- **Ontem / 3 dias / 7 dias** — os vídeos publicados nesse período (dias fechados, no fuso do seu computador).
- **A ordem:** **Mais vistos**, **Maior interação / view** ou **Mais comentários / mil views**.
- **Cada card:** visualizações, curtidas, comentários, interação %, índice, comentários por mil views, quantas vezes ele fez a **mediana do próprio perfil**, data, duração e quando foi observado.
- **Duração média** (à direita) — a duração média e a mediana dos vídeos do Top.

**Horários de postagem** é um mapa de dia da semana × hora com a **mediana das views** dos vídeos postados em cada horário, nos últimos 90 dias. Quanto mais clara a célula, mais views. As marcadas como **top** são os 5 horários com as maiores medianas. Passe o mouse numa célula para ver os números.

### Perfis

<figure class="shot shot-wide">
  <img src="/images/docs/dash-profiles.webp" alt="A seção Perfis do Painel: a grade de perfis acompanhados" width="1440" height="900" loading="lazy" />
  <figcaption>Perfis: um card por conta acompanhada.</figcaption>
</figure>

Um card por perfil, com:

- **seguidores**, a mini-curva do período e o ganho em 7 dias;
- total de **posts** e **views em 24 h, 3 dias e 7 dias**;
- **posts por dia** em barras, com os números de ontem e de hoje;
- **Top da semana** — as miniaturas dos vídeos que mais performaram.

No topo da seção: busca (por nome, @ ou nota), a ordem da grade, a densidade (cards maiores ou menores) e quais propriedades aparecem no card.

### Ficha do perfil

<figure class="shot shot-wide">
  <img src="/images/docs/dash-sheet.webp" alt="A ficha de um perfil aberta sobre a grade, com o gráfico de seguidores" width="1440" height="900" loading="lazy" />
  <figcaption>Clique num card para abrir a ficha do perfil.</figcaption>
</figure>

Clique num card para abrir a ficha completa:

- **Tags** (com cores) e **Anotações** livres sobre o perfil;
- **Trackear stories** — liga a coleta dos stories desse perfil: duas passadas por dia, guardados por 7 dias;
- a bio, a **evolução de seguidores** em gráfico, as **métricas atuais** (seguidores, seguindo, posts) e as **views dos reels**;
- no alto, os botões para abrir o perfil na rede, abrir os stories guardados e fechar (Esc).

### Stories e Leituras

- **Stories** — os stories guardados dos perfis com **Trackear stories** ligado.
- **Leituras** — a saúde da coleta nas últimas 24 horas e o histórico de cada leitura. É aqui que você descobre por que um perfil não foi medido.

## Outras ferramentas

Todas ficam na aba **Pesquisa**, dentro da rede correspondente.

| Rede | Ferramenta | O que faz |
| --- | --- | --- |
| Instagram | **Stories** | Mostra e baixa os stories do perfil aberto. |
| Instagram | **Comentários** | No post aberto, **Coletar todos** busca todos os comentários e respostas (um pedido a cada 4–8 s; para sozinho se o Instagram limitar). Exporta em CSV ou XLSX. |
| TikTok | **Comentários**, **Stories**, **Playlists** | Exporta os comentários de um vídeo, mostra e baixa stories, e baixa os vídeos de uma playlist (coleção) em HD. |
| Facebook | **Filtrar** | Na busca e nas hashtags, esconde os posts abaixo do engajamento que você definir (por exemplo *≥ 2000 comentários OU ≥ 200 compartilhamentos*), enquanto você rola. |
| Facebook | **Comentários** | Exporta a conversa inteira de um post. |
| Facebook | **Fotos** | Baixa as fotos de um perfil num ZIP. |
| Pinterest | **Pasta** | Baixa uma pasta inteira, não só os pins que passaram na tela. |

## Opções

<figure class="shot shot-panel">
  <img src="/images/docs/panel-options.webp" alt="A janela Opções do painel lateral" width="800" height="1560" loading="lazy" />
  <figcaption>Opções, pela engrenagem do cabeçalho.</figcaption>
</figure>

A engrenagem no cabeçalho abre as Opções:

- **Painel** — tema claro ou escuro.
- **Sobreposições nas páginas** — liga ou desliga os selos e botões desenhados sobre os posts do Instagram, do TikTok e do Pinterest.
- **Downloads** — uma pasta dentro da pasta de downloads do navegador (vazio = direto em Downloads) e a opção **Tudo numa pasta só**. Para mudar o disco, use `chrome://settings/downloads`.
- **Arquivo** — quantas transcrições ficam guardadas.
- **Spy** — ligar ou desligar a medição uma vez por dia e o limite de **leituras do Instagram por dia**.
- **Transcrição** — o idioma padrão das próximas transcrições.

## Problemas comuns

- **"Nenhuma aba do Instagram está aberta."** A ferramenta controla uma aba da rede. Abra uma (o botão no aviso faz isso) e volte ao painel.
- **O painel diz que a página não respondeu.** Use o botão do aviso para reconectar a aba; se não resolver, recarregue a página da rede.
- **A grade não enche.** Role a página, ou use **Coletar**: a extensão só vê os posts que a rede já carregou.
- **Duas cópias da extensão.** Não deixe duas versões do socialRadar instaladas no mesmo perfil do Chrome (por exemplo, uma antiga e uma nova): elas disputam a página e as ferramentas param de responder.
- **Onde ficam meus dados?** No seu navegador. Desinstalar a extensão apaga tudo. Veja a [política de privacidade](/privacy).
