// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { expect, it } from 'vitest';
import { stripRegions } from '../../build/stripRegions.js';

it('excludes previous-profile DOM during query-only navigation and retains filtered current tiles', () => {
  const document = new Window().document;
  const location = { href:'https://www.facebook.com/profile.php?id=111&sk=reels_tab',hostname:'www.facebook.com',pathname:'/profile.php',origin:'https://www.facebook.com' };
  const listeners=[];
  const chrome={runtime:{id:'test',onMessage:{addListener:f=>listeners.push(f)},sendMessage:async()=>({})},storage:{local:{get:async()=>({}),set:async()=>({})},onChanged:{addListener:()=>{}}}};
  Object.defineProperty(document,'visibilityState',{value:'hidden'});
  const tile=id=>{const a=document.createElement('a');a.href='/reel/'+id;a.innerHTML='<img src="https://scontent.fbcdn.net/a.jpg"><span>44</span>';a.getBoundingClientRect=()=>({width:150,height:200,top:0});document.body.append(a);return a;};
  new Function('window','document','location','chrome','setInterval','setTimeout','clearInterval','clearTimeout',stripRegions(readFileSync('src/content/fb/reels-capture.js','utf8'),'public'))({postMessage:()=>{},addEventListener:()=>{}},document,location,chrome,()=>1,()=>1,()=>{},()=>{});
  const list=()=>{let res;listeners.at(-1)({type:'FBW_FB_REELS_LIST'},{},r=>{res=r;});return res.records.map(r=>r.id);};
  const a=tile('11111111');expect(list()).toEqual(['11111111']);
  tile('11111112'); // Pagination may append an old-profile tile between ticks.
  location.href='https://www.facebook.com/profile.php?id=222&sk=reels_tab';
  expect(list()).toEqual([]);
  a.remove();const b=tile('22222222');expect(list()).toEqual(['22222222']);
  b.dataset.swHidden='1';b.getBoundingClientRect=()=>({width:0,height:0,top:0});
  expect(list()).toEqual(['22222222']);
  // Facebook can recycle a card node for a different reel.
  a.href='/reel/33333333';document.body.append(a);
  expect(list()).toEqual(['22222222','33333333']);
});

// ---- profile header: "Baixar capas" / "Baixar reels" after the Hub button (1.45) ----
const PROFILE = 'https://www.facebook.com/profile.php?id=61590925281317';
const COVER = n => `https://scontent.fbcdn.net/c${n}.jpg?stp=dst-jpg&ctp=s960x960`;
function bootHeader(href, { send } = {}) {
  const win = new Window();
  const document = win.document;
  Object.defineProperty(document, 'visibilityState', { value: 'hidden' });
  document.body.innerHTML = `<div role="main"><span dir="auto" style="font-size:32px"><div role="button">Sandy Spirit Guide</div></span>
    <a href="/reel/11111111"><img src="${COVER(1)}"><span>666</span></a>
    <a href="/reel/22222222"><img src="${COVER(2)}"><span>380</span></a></div>`;
  for (const a of document.querySelectorAll('a')) a.getBoundingClientRect = () => ({ width: 150, height: 200, top: 300 });
  const location = { href, hostname: 'www.facebook.com', pathname: '/profile.php', origin: 'https://www.facebook.com', hash: '' };
  const sent = [];
  const chrome = { runtime: { id: 'test', onMessage: { addListener: () => {} },
    sendMessage: async msg => { sent.push(msg); return msg.type === 'FBW_DL_MEDIA' && send ? send(msg) : { ok: true }; } },
  storage: { local: { get: (k, cb) => (cb ? cb({}) : Promise.resolve({})), set: async () => ({}) },
    onChanged: { addListener: () => {}, removeListener: () => {} } } };
  const listeners = [];
  const timers = [];
  const window = { postMessage: () => {}, addEventListener: (type, f) => { if (type === 'message') listeners.push(f); } };
  new Function('window', 'document', 'location', 'chrome', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout', 'getComputedStyle',
    stripRegions(readFileSync('src/content/fb/reels-capture.js', 'utf8'), 'public'))(
    window, document, location, chrome, (f, ms) => timers.push({ f, ms }), () => 1, () => {}, () => {}, el => win.getComputedStyle(el));
  const post = data => listeners.forEach(f => f({ source: window, data }));
  return {
    document, location, sent, post,
    records: rows => post({ type: '__fbwReelRecords', rows }),
    hubTick: () => timers.filter(t => t.ms === 1000).forEach(t => t.f()),
    btn: kind => document.getElementById(kind === 'covers' ? 'fbw-dl-covers' : 'fbw-dl-posts'),
    downloads: () => sent.filter(m => m.type === 'FBW_DL_MEDIA'),
  };
}
const flush = () => new Promise(r => setTimeout(r, 0));
const REC = (id, progressive) => ({ id, progressive, authorName: 'Sandy Spirit Guide', authorId: '61590925281317' });

it('puts Baixar capas and Baixar reels after the Hub button and downloads the loaded reels one by one', async () => {
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`);
  fb.records([REC('11111111', 'https://scontent.fbcdn.net/v1.mp4'), REC('22222222', null)]);
  fb.hubTick();
  const hub = fb.document.getElementById('fbw-hub-btn');
  expect(hub.nextElementSibling.id).toBe('fbw-dl-covers');
  expect(fb.btn('covers').nextElementSibling).toBe(fb.btn('posts'));
  expect(fb.btn('covers').getAttribute('aria-label')).toBe('Baixar 2 capas');
  expect(fb.btn('posts').getAttribute('aria-label')).toBe('Baixar 2 reels');

  fb.btn('covers').click();
  await flush();
  expect(fb.downloads()).toEqual([
    { type: 'FBW_DL_MEDIA', platform: 'facebook', kind: 'image', url: 'https://scontent.fbcdn.net/c1.jpg?stp=dst-jpg',
      filename: 'Sandy Spirit Guide-fb-11111111.jpg', dir: ['Sandy Spirit Guide', 'capas'] },
    { type: 'FBW_DL_MEDIA', platform: 'facebook', kind: 'image', url: 'https://scontent.fbcdn.net/c2.jpg?stp=dst-jpg',
      filename: 'Sandy Spirit Guide-fb-22222222.jpg', dir: ['Sandy Spirit Guide', 'capas'] },
  ]);
  expect(fb.btn('covers').dataset.state).toBe('done');

  fb.sent.length = 0;
  fb.btn('posts').click();
  await flush();
  // A reel whose MP4 link has not come in is never swapped for its cover.
  expect(fb.downloads()).toEqual([{ type: 'FBW_DL_MEDIA', platform: 'facebook', kind: 'video', url: 'https://scontent.fbcdn.net/v1.mp4',
    filename: 'Sandy Spirit Guide-fb-11111111.mp4', dir: ['Sandy Spirit Guide', 'reels'] }]);
  expect(fb.btn('posts').dataset.state).toBe('partial');
  expect(fb.btn('posts').getAttribute('aria-label')).toContain('1 de 2 baixados');
  expect(fb.btn('posts').getAttribute('aria-label')).toContain('1 vídeo ainda sem link: espere uns segundos.');

  fb.sent.length = 0;
  fb.records([REC('22222222', 'https://scontent.fbcdn.net/v2.mp4')]);
  fb.btn('posts').click();
  await flush();
  expect(fb.downloads().map(m => m.filename)).toEqual(['Sandy Spirit Guide-fb-22222222.mp4']);
  expect(fb.btn('posts').dataset.state).toBe('done');
});

it('greys both buttons out away from the Reels tab', () => {
  const fb = bootHeader(PROFILE);
  for (const kind of ['covers', 'posts']) {
    expect(fb.btn(kind).dataset.state).toBe('empty');
    expect(fb.btn(kind).getAttribute('aria-disabled')).toBe('true');
    expect(fb.btn(kind).getAttribute('aria-label')).toBe('Abra a aba Reels do perfil para baixar capas e reels');
  }
  fb.btn('covers').click();
  expect(fb.downloads()).toEqual([]);
});

it('stops after the current file on a click while busy, and a takeover removes all three buttons', async () => {
  const pending = [];
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`, { send: () => new Promise(r => pending.push(r)) });
  fb.records([REC('11111111', 'https://scontent.fbcdn.net/v1.mp4'), REC('22222222', 'https://scontent.fbcdn.net/v2.mp4')]);
  fb.btn('covers').click();
  await flush();
  expect(fb.btn('covers').dataset.state).toBe('busy');
  expect(fb.btn('covers').getAttribute('aria-label')).toBe('Baixando 0 de 2… clique para parar');
  fb.btn('covers').click();
  pending.shift()({ ok: true });
  await flush();
  expect(fb.downloads()).toHaveLength(1);
  expect(fb.btn('covers').dataset.state).toBe('partial');
  expect(fb.btn('covers').getAttribute('aria-label')).toBe('Parado: 1 de 2 baixados. Falta 1: clique para continuar');

  fb.post({ __fbwReelsTakeover: 'new-gen' });
  for (const id of ['fbw-hub-btn', 'fbw-dl-covers', 'fbw-dl-posts']) expect(fb.document.getElementById(id)).toBeNull();
});

it('ends a running download when the page moves to another profile, without sending its files there', async () => {
  const pending = [];
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`, { send: () => new Promise(r => pending.push(r)) });
  fb.records([REC('11111111', 'https://scontent.fbcdn.net/v1.mp4'), REC('22222222', 'https://scontent.fbcdn.net/v2.mp4')]);
  fb.btn('posts').click();
  await flush();
  fb.location.href = 'https://www.facebook.com/profile.php?id=999999999&sk=reels_tab';
  pending.shift()({ ok: true });
  await flush();
  expect(fb.downloads()).toHaveLength(1);
  fb.hubTick();
  expect(fb.btn('posts').dataset.state).not.toBe('busy');
});

it('retries only the missing reel after a tab round-trip unmounted its tile', async () => {
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`);
  fb.records([REC('11111111', 'https://scontent.fbcdn.net/v1.mp4'), REC('22222222', null)]);
  fb.btn('posts').click();
  await flush();
  expect(fb.btn('posts').dataset.state).toBe('partial');
  fb.location.href = PROFILE; // All tab
  fb.hubTick();
  fb.document.querySelector('a[href="/reel/22222222"]').remove();
  fb.location.href = `${PROFILE}&sk=reels_tab`;
  fb.hubTick();
  fb.records([REC('22222222', 'https://scontent.fbcdn.net/v2.mp4')]);
  fb.sent.length = 0;
  fb.btn('posts').click();
  await flush();
  expect(fb.downloads().map(m => m.url)).toEqual(['https://scontent.fbcdn.net/v2.mp4']);
  expect(fb.btn('posts').dataset.state).toBe('done');
});

it("names the folder after the profile heading when no record or link carries the name yet", async () => {
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`);
  fb.records([{ id: '11111111', progressive: 'https://scontent.fbcdn.net/v1.mp4' }]);
  fb.btn('covers').click();
  await flush();
  expect(fb.downloads().map(m => [m.dir, m.filename])).toEqual([
    [['Sandy Spirit Guide', 'capas'], 'Sandy Spirit Guide-fb-11111111.jpg'],
    [['Sandy Spirit Guide', 'capas'], 'Sandy Spirit Guide-fb-22222222.jpg'],
  ]);
});

it('leaves the buttons a newer world already put up when it hands over (no flicker on reload)', () => {
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`);
  const ids = ['fbw-hub-btn', 'fbw-dl-covers', 'fbw-dl-posts'];
  // What this world sees after a reload: the new world's nodes, which carry none of its expandos.
  for (const id of ids) { const n = fb.document.createElement('div'); n.id = id; fb.document.getElementById(id).replaceWith(n); }
  fb.post({ __fbwReelsTakeover: 'new-gen' });
  for (const id of ids) expect(fb.document.getElementById(id)).not.toBeNull();
});

it('counts the whole set after a stop and a second click: "2 capas baixadas", not just the last run', async () => {
  const pending = [];
  const fb = bootHeader(`${PROFILE}&sk=reels_tab`, { send: () => new Promise(r => pending.push(r)) });
  fb.records([REC('11111111', 'https://scontent.fbcdn.net/v1.mp4'), REC('22222222', 'https://scontent.fbcdn.net/v2.mp4')]);
  fb.btn('covers').click();
  await flush();
  fb.btn('covers').click();
  pending.shift()({ ok: true });
  await flush();
  expect(fb.btn('covers').getAttribute('aria-label')).toBe('Parado: 1 de 2 baixados. Falta 1: clique para continuar');
  fb.btn('covers').click();
  await flush();
  expect(fb.btn('covers').getAttribute('aria-label')).toBe('Baixando 1 de 2… clique para parar');
  pending.shift()({ ok: true });
  await flush();
  expect(fb.downloads()).toHaveLength(2);
  expect(fb.btn('covers').getAttribute('aria-label')).toBe('2 capas baixadas. Clique para baixar de novo');
});
