// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { parseFbReels, mergeFbReel, fbReelsSurface } from './fbReelsData.js';

const video = (id) => ({ __typename: 'Video', id, created_time: 100, playable_duration_in_ms: 87167,
  play_count_reduced: '4.4K', thumbnailImage: { uri: 'https://scontent.fbcdn.net/cover.jpg' },
  videoDeliveryResponseFragment: { videoDeliveryResponseResult: { progressive_urls: [{ progressive_url: 'https://scontent.fbcdn.net/video.mp4' }] } },
});
const story = (id) => ({ __typename: 'Story', creation_time: 200, actors: [{ id: '100092403319843', name: 'Creator' }],
  message: { text: 'Original caption' }, attachments: [{ media: video(id) }] });
const base = { data: { node: { aggregated_fb_shorts: { edges: ['2030018604348103', '2900245527021430'].map(id => ({ profile_reel_node: { node: story(id) } })) } } } };
const feedback = (id, index, likes = 0) => ({ path: ['node', 'aggregated_fb_shorts', 'edges', index, 'profile_reel_node', 'node'],
  data: { url: `https://www.facebook.com/reel/${id}/`, feedback: { total_comment_count: 32, share_count_reduced: '2.2K' },
    fb_reel_react_button: { story: { feedback: { likers: { count: likes } } } } } });
describe('Facebook reel normalization', () => {
  it('joins out-of-order deferred stats by reel identity, preserves zero and publication date', () => {
    const rows = parseFbReels([base, feedback('2900245527021430', 1, 9), feedback('2030018604348103', 0)]);
    expect(rows.find(r => r.id === '2030018604348103')).toMatchObject({ views: 4400, likes: 0, comments: 32, shares: 2200,
      taken_at: 200, created_at: 100, duration: 87.167, caption: 'Original caption', authorName: 'Creator', progressive: 'https://scontent.fbcdn.net/video.mp4' });
    expect(rows.find(r => r.id === '2900245527021430').likes).toBe(9);
  });
  it('supports newline GraphQL and malformed deferred chunks without dropping valid rows', () => {
    const rows = parseFbReels(JSON.stringify(base) + '\ninvalid\n' + JSON.stringify(feedback('2030018604348103', 0)));
    expect(rows).toHaveLength(2);
    expect(rows[0].shares).toBe(2200);
  });
  it('does not associate a conflicting URL with a deferred edge', () => {
    const f = feedback('9999999999999', 0, 1000);
    const rows = parseFbReels([base, f]);
    expect(rows.find(r => r.id === '2030018604348103').likes).toBeNull();
  });
  it('does not add unrelated delivery videos to the reel list', () => {
    expect(parseFbReels([base, { data: { suggestion: video('9999999999999') } }])).toHaveLength(2);
  });
  it('reads hydration envelopes and standalone player feedback', () => {
    const rows = parseFbReels({ require: [[{ __bbox: { result: base } }, feedback('2030018604348103', 0, 125).data]] });
    expect(rows[0]).toMatchObject({ likes: 125, views: 4400 });
  });
  it('never clears known fields with partial records or confuses unknown with zero', () => {
    expect(mergeFbReel({ id: '1', likes: 3, shares: 100 }, { id: '1', likes: 0, shares: null })).toMatchObject({ likes: 0, shares: 100 });
    expect(parseFbReels(base)[0].likes).toBeNull();
  });
  it('separates numeric profiles, normalizes aliases and rejects foreign origins', () => {
    expect(fbReelsSurface('https://www.facebook.com/profile.php?id=123&sk=reels_tab')).toBe('profile:123');
    expect(fbReelsSurface('https://www.facebook.com/profile.php?id=123&sk=owner_reels')).toBe('profile:123');
    expect(fbReelsSurface('https://www.facebook.com/profile.php?id=456&sk=reels_tab')).toBe('profile:456');
    expect(fbReelsSurface('https://www.facebook.com/reel/2030018604348103')).toBe('reel:2030018604348103');
    expect(fbReelsSurface('https://evil.example/reel/2030018604348103')).toBeNull();
  });
});
