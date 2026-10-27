# Chrome Web Store listing — socialMate (public build, v1.18.0)

Paste into the developer dashboard. Upload the package built from the public tree
(`npm run export:public`, then `dist/` zipped), never the private `dist/`.

Images are in `screenshots/`: `pt-BR/1–5.jpg` and `en/1–5.jpg` (1280×800),
`promo-tile-440x280.png` and `marquee-1400x560.png` (`-en` variants for the English
listing). All captures are of the public build on **synthetic data**: fictional
accounts (`*.demo`), generated pictures, no third-party content. Regenerate with
`node docs/store/tools/capture.mjs <exported dist>` then `node docs/store/tools/render.mjs`.

| # | Caption (pt-BR) | Shows |
| --- | --- | --- |
| 1 | Acompanhe contas no seu painel | Spy dashboard, profile grid |
| 2 | Veja o que mais funciona | Top posts and posting-hours map |
| 3 | A evolução de cada perfil | Profile sheet: followers chart, metrics |
| 4 | Transcreva vídeos com IA local | Side panel, Arquivo: a Spanish transcript, language picker |
| 5 | Tudo no seu navegador | Side panel, Spy tab: saved profiles, "Abrir painel" |

## Store settings

- **Category:** Tools (alternative: Social Networking).
- **Language:** Portuguese (Brazil) as the default listing; English and Spanish as extra listings.
- **Website / Support URL:** the public repository (https://github.com/rheav/socialmate-pub) once it is public; until then, leave empty or use an e-mail.
- **Privacy policy URL:** required. `PRIVACY.md` ships in the public repo; it needs a public address (the repo made public, or GitHub Pages).
- **Contact e-mail:** rheav7@gmail.com, or a dedicated address.

## Short description (≤132 characters)

- **pt-BR:** Pesquise e baixe posts, transcreva vídeos e acompanhe contas no Instagram, Facebook, TikTok e Pinterest. Tudo local.
- **en:** Research and download posts, transcribe videos and track accounts on Instagram, Facebook, TikTok and Pinterest. All local.
- **es:** Investiga y descarga posts, transcribe videos y sigue cuentas en Instagram, Facebook, TikTok y Pinterest. Todo local.

## Description

### pt-BR

O socialMate é um painel lateral para quem pesquisa conteúdo nas redes: criadores, social medias e quem estuda o próprio nicho.

Pesquisa, direto na página que você já está vendo:
• Instagram: ordene os posts e reels de um perfil por views, curtidas ou comentários; veja stories; exporte comentários (inclusive de vários posts seguidos)
• TikTok: ordene vídeos, exporte comentários, veja stories e playlists
• Facebook: filtre a busca por engajamento, ordene os reels de uma página, exporte comentários e baixe as fotos de um perfil
• Pinterest: baixe uma pasta inteira

Transcrição com IA local (Whisper): português, inglês, espanhol ou automático. O áudio é processado no seu computador. Copie o texto ou baixe em .txt e .srt.

Spy — acompanhe contas:
• salve perfis do Instagram e do Facebook com um clique
• a extensão mede uma vez por dia: seguidores, posts por dia e views
• um painel próprio com a grade dos perfis, a evolução de cada um, os top posts por views, interação e comentários e os melhores horários para postar
• stories das contas que você escolher, guardados pelo tempo que você definir

Privacidade: sem conta, sem login, sem servidor. Tudo fica no seu navegador; desinstalar apaga tudo. A extensão só conversa com as próprias redes, usando a sessão que você já tem aberta, e grava os arquivos na sua pasta de downloads.

Use com moderação: a área Spy respeita um limite diário de leituras do Instagram, ajustável em Opções. Projeto independente, sem afiliação com Meta, TikTok ou Pinterest.

### en

socialMate is a side panel for people who research content on social media: creators, social media managers and anyone studying their niche.

Research, right on the page you are viewing:
• Instagram: sort a profile's posts and reels by views, likes or comments; view stories; export comments (across several posts in a row)
• TikTok: sort videos, export comments, view stories and playlists
• Facebook: filter search results by engagement, sort a page's reels, export comments and download a profile's photos
• Pinterest: download a whole board

On-device AI transcription (Whisper): Portuguese, English, Spanish or automatic. The audio is processed on your computer. Copy the text or download it as .txt and .srt.

Spy — track accounts:
• save Instagram and Facebook profiles in one click
• the extension measures them once a day: followers, posts per day and views
• a dashboard of its own with the profile grid, each profile's growth, top posts by views, engagement and comments, and the best hours to post
• stories of the accounts you choose, kept for as long as you set

Privacy: no account, no login, no server. Everything stays in your browser; uninstalling removes it all. The extension only talks to the social networks themselves, with the session you already have open, and saves files to your downloads folder.

Use it in moderation: the Spy respects a daily limit of Instagram readings, adjustable in Options. Independent project, not affiliated with Meta, TikTok or Pinterest.

### es

socialMate es un panel lateral para quien investiga contenido en redes sociales: creadores, community managers y quien estudia su nicho.

Investigación, en la misma página que estás viendo:
• Instagram: ordena los posts y reels de un perfil por vistas, likes o comentarios; mira stories; exporta comentarios
• TikTok: ordena videos, exporta comentarios, mira stories y playlists
• Facebook: filtra la búsqueda por interacción, ordena los reels de una página, exporta comentarios y descarga las fotos de un perfil
• Pinterest: descarga un tablero completo

Transcripción con IA local (Whisper): portugués, inglés, español o automático. El audio se procesa en tu computadora.

Spy — sigue cuentas: guarda perfiles de Instagram y Facebook con un clic; la extensión los mide una vez al día (seguidores, posts por día y vistas) y los muestra en un panel propio con la evolución de cada perfil, los mejores posts y los mejores horarios para publicar.

Privacidad: sin cuenta, sin login, sin servidor. Todo queda en tu navegador. Proyecto independiente, sin afiliación con Meta, TikTok ni Pinterest.

## Single purpose

Help people research public content on Instagram, Facebook, TikTok and Pinterest: sort, download and transcribe the posts they are viewing, and track the public metrics of profiles they save, all locally in the browser.

## Permission justifications

| Permission | Justification |
| --- | --- |
| `sidePanel` | The whole interface lives in the side panel. |
| `storage` | Saves settings, the saved items, the transcripts and the tracked profiles locally. |
| `unlimitedStorage` | The local archive keeps thumbnails and the Spy keeps months of daily readings and the stories the user chose to keep; the default quota is too small for that. Nothing leaves the device. |
| `tabs` | Finds which supported site (Instagram, Facebook, TikTok, Pinterest) the active tab shows, so the panel offers that site's tools; reloads the extension's scripts into tabs already open after an update. |
| `scripting` | Re-injects the extension's own content scripts into an open social-network tab when the panel finds it disconnected (one click, user-initiated). |
| `webRequest` | Read-only: notes the address of the video and audio tracks a Facebook video loads, so the user can download or transcribe the video they are watching. No request is blocked or modified. |
| `declarativeNetRequest` | One session rule that adds the Referer header TikTok's video CDN requires, so a TikTok video the user chose to download does not fail with 403. |
| `offscreen` | Runs the on-device speech-to-text model (Whisper) and ffmpeg (joining a video's audio and image tracks) in an offscreen document, which a service worker cannot do. |
| `downloads` | Saves the videos, images, transcripts and exports the user asks for. |
| `alarms` | Runs the once-a-day measurement of the profiles the user saved in the Spy, and the hourly clean-up of its local database (old stories and readings). |
| Host permissions (`*.instagram.com`, `*.facebook.com`, `*.tiktok.com`, `*.pinterest.com`, `*.cdninstagram.com`, `*.fbcdn.net`, `*.pinimg.com`) | The tools run on these sites only, and their media is downloaded from their CDNs. No other site is accessed. |

**Remote code:** none. All code ships in the package, including the speech model (ONNX), ffmpeg and SQLite (WebAssembly); the transcription library is configured not to fetch models from the network.

## Privacy practices form

The extension has no server and sends nothing to its developer. Everything it reads is processed and stored in the user's browser.

- **Personally identifiable information:** no.
- **Health, financial and payment, authentication, personal communications, location:** no.
- **Web history:** no.
- **User activity:** no.
- **Website content:** no (posts, profiles and media are read in the browser to show, save or download them; nothing is transmitted to the developer or third parties).

Certify: data is not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

## Review risks

- Chrome Web Store reviews downloaders of third-party content closely; the listing must keep the focus on research of public content and say the user downloads what they are viewing.
- The Spy opens profile pages in a background tab on a schedule. If review questions it, the justification is the `alarms` row above: it runs only for profiles the user saved, at most once a day, under a user-set daily limit.
