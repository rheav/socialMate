# Facebook Reels parity validation — 2026-10-02

Feature branch: `feat/facebook-reels-parity`. Baseline: `7bd693b` on remote main, preserved by `pre-facebook-reels-parity-2026-10-02`. Release: 1.3.0.

## Automated checks

`npm test`: 79 files, 937 passing tests. `npm run build`: successful; generated inline regions current. `git diff --check`: clean. Existing Vite/CRXJS chunk/deprecation warnings remain.

New coverage includes streamed deferred identity joins, partial/zero counts, unrelated-video exclusion, canonical reel routes, media/caption action messages, numeric-profile query changes, injected-text exclusion, stale players and retained filtered cards. Owner-only hydration, search initiated from a reel, and stale profile DOM navigation were reproduced failing before their fixes.

Independent whole-change review found two important navigation regressions; both were fixed and covered. Panel voice progress/error visibility was also added after review.

## Live shared Chrome checks

Used Playwright and Chrome DevTools on the supplied profile and reel URLs, preserving the shared Chrome profile and other tabs.

- Profile hydration and real scrolling pagination returned rich records: first 10, then 30/30 with captured likes and progressive media. Further filter/pagination checks retained 370 loaded records rather than dropping hidden cards.
- Views > 300,000 filtering hid rejected cards; likes descending displayed 40,729 before 38,484. Clearing the query restored the grid. Test query changes were restored.
- Direct player showed one left rail containing save, download, transcription, comments, thumbnail, voice and copy-link. The link uses a chain glyph. Metrics have no approximation prefix; unavailable views display an em dash. Owner-only hydration now supplies Spiritual Revelations and publication metadata.
- Profile card save/remove round trip succeeded, preserving numeric counts (1,400,000 views, 38,484 likes, 8,307 comments, 6,900 shares), publication time and duration. The test record was removed to restore the prior library state. Existing user-saved reels were left intact.
- Card thumbnail download completed (103,842-byte JPEG); button showed completion.
- Bulk thumbnail action is the rightmost child of the Facebook sorting bar, with static positioning and one instance. It hides/reappears with collapse/expand. No separate floating bulk button remains.

## Validation limits

Full Whisper transcription, completed voice separation and a complete bulk download of the profile were not rerun end to end in this pass. Their existing engines are reused; message construction, language/caption selection and error handling have automated coverage. Live assertions above cover the actions actually exercised.

Facebook can omit views, followers or media on individual surfaces. Unknown data stays null; unavailable actions explain that the reel should be opened. Signed CDN URLs can expire. A profile transition conservatively excludes an old anchor with the same reel ID until Facebook replaces/reuses it for a new ID.
