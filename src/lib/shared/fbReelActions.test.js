import { expect, it } from 'vitest';
import { fbReelEntry, fbReelJob } from './fbReelActions.js';
import { FB_QUERY_FIELDS, fbEngagement } from './fbQuery.js';
import { applyQuery } from './feedQuery.js';
const rec = {id:'2030018604348103',views:4400,likes:125,comments:32,shares:16,taken_at:1790877335,duration:87.167,
  caption:'Original',authorName:'Creator',authorId:'100092403319843',progressive:'https://scontent.fbcdn.net/v.mp4',audio:'https://scontent.fbcdn.net/a.mp4',
  captions:[{lang:'en_US',url:'https://scontent.fbcdn.net/en.srt'}]};
it('saves complete, numeric library metadata with a canonical source', () => {
  expect(fbReelEntry(rec)).toMatchObject({videoId:rec.id,platform:'facebook',counts:{like:125,views:4400,share:16},takenAt:rec.taken_at,durationS:87.167,caption:'Original',sourceUrl:`https://www.facebook.com/reel/${rec.id}`});
});
it('builds jobs for the exact video and chosen caption language', () => {
  expect(fbReelJob(rec,'transcribe','en')).toMatchObject({type:'FBW_TRANSCRIBE',videoId:rec.id,mediaUrl:rec.audio,captionUrl:rec.captions[0].url,idConfident:true});
  expect(fbReelJob(rec,'transcribe','br')).not.toHaveProperty('captionUrl');
  expect(fbReelJob(rec,'download')).toMatchObject({type:'FBW_DL_MEDIA',url:rec.progressive,platform:'facebook',kind:'video'});
  expect(fbReelJob(rec,'voice')).toMatchObject({type:'FBW_EXTRACT_VOICE',videoId:rec.id,mediaUrl:rec.audio});
});
it('refuses absent media and does not invent metrics for sorting', () => {
  expect(()=>fbReelJob({id:rec.id},'download')).toThrow();
  expect(fbEngagement({...rec,likes:null})).toBeNull();
  expect(fbEngagement({...rec,likes:0,comments:0,shares:0})).toBe(0);
  expect(applyQuery([{...rec,id:'a',likes:null}, {...rec,id:'b',likes:0}],{filters:[],sorts:[{key:'likes',dir:'asc'}]},FB_QUERY_FIELDS).map(r=>r.id)).toEqual(['b','a']);
});
