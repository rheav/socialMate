# Facebook Reels parity implementation plan

Goal: bring Instagram's research controls to Facebook profile reels and the reel player, preserving the current search/transcription flows.

Spec: ../../facebook-reels-parity-investigation-2026-10-02.md (approved for implementation in the conversation).

Architecture: enrich the existing MAIN capture with a bounded reel index; normalize streamed fragments by identity; let the existing isolated reels bridge own the profile sort and overlays. Share query fields, saved-record and job builders between page and panel. Extend the existing player download/transcription/comment rail with library, cover, link and voice actions in one left column. Integrate bulk thumbnail downloads into the right end of the Facebook sort bar.

Constraints: no extra API requests for collection; no tokens/raw response persistence; no new dependencies; unknown metrics remain null. Work on feat/facebook-reels-parity, keep main at the verified baseline, push feature branch and prepare a draft PR for later merge.

1. Capture and normalize: add fbReelsData and tests for out-of-order deferred parts, unrelated videos, partial/zero counts, abbreviated shares, media, publication vs creation, and invalid URLs. Extend video-capture for hydration and reels XHR with bounded replay; retain search behavior.
2. Query and DOM: add FB_QUERY_FIELDS and saved/job helpers. Test profile query-string identity changes in pageSorter. Update reels-capture to retain all loaded cards through filtering, use captured metadata, synchronize sw_fb_query and avoid overlay text contaminating native views.
3. Actions: add card and player save, cover, copy-link and voice controls; keep existing player jobs. Test action-to-ID association, language/captions, failed acknowledgements and library metadata. Use exact IDs and fresh media at click time; preserve existing transcripts via background writer.
4. Panel: replace local sort state with useFeedQuery/QueryBuilder, expose richer metrics and all available actions, preserve harvest/cancel and library synchronization.
5. Validation: run focused red/green tests per behavior, full suite and build once integrated; exercise visible Chrome profile pagination, sort/filter/reset, native navigation and player actions. Run independent final review, fix material findings, commit/push branch and create labeled draft PR. Do not merge.

Review focus: profile.php query-only navigation; deferred stats without adjacent media; unknown/zero metrics; hidden filtered tiles surviving collection; stale player and expired media URLs.

Baseline: 7bd693b pushed to main, 919 tests passing, build passing. Recovery tag: pre-facebook-reels-parity-2026-10-02. GitHub label: facebook-reels-parity.

Execution: inline using test-driven-development and executing-plans, followed by independent branch review. Current checkout is isolated by the requested feature branch; no additional worktree or dependency installation is needed.
