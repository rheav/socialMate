// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { expect, it } from 'vitest';

it('excludes previous-profile DOM during query-only navigation and retains filtered current tiles', () => {
  const document = new Window().document;
  const location = { href:'https://www.facebook.com/profile.php?id=111&sk=reels_tab',hostname:'www.facebook.com',pathname:'/profile.php',origin:'https://www.facebook.com' };
  const listeners=[];
  const chrome={runtime:{id:'test',onMessage:{addListener:f=>listeners.push(f)},sendMessage:async()=>({})},storage:{local:{get:async()=>({}),set:async()=>({})},onChanged:{addListener:()=>{}}}};
  Object.defineProperty(document,'visibilityState',{value:'hidden'});
  const tile=id=>{const a=document.createElement('a');a.href='/reel/'+id;a.innerHTML='<img src="https://scontent.fbcdn.net/a.jpg"><span>44</span>';a.getBoundingClientRect=()=>({width:150,height:200,top:0});document.body.append(a);return a;};
  new Function('window','document','location','chrome','setInterval','setTimeout','clearInterval','clearTimeout',readFileSync('src/content/fb/reels-capture.js','utf8'))({postMessage:()=>{},addEventListener:()=>{}},document,location,chrome,()=>1,()=>1,()=>{},()=>{});
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
