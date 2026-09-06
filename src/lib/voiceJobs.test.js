import { describe, it, expect, vi, afterEach } from 'vitest';
import { createVoiceJobs, VOICE_TIMEOUT_MS } from './voiceJobs.js';

function setup(overrides = {}) {
  const sent = [], downloads = [], released = [];
  const deps = {
    ensureOffscreen: async () => {},
    callOffscreen: async () => ({ success: true, started: true }),
    notifyTab: (tabId, msg) => sent.push({ tabId, ...msg }),
    download: async (options) => { downloads.push(options); return 42; },
    trackDownload: vi.fn(),
    release: async (url) => { released.push(url); },
    ...overrides,
  };
  return { jobs: createVoiceJobs(deps), sent, downloads, released, deps };
}
const input = { jobId:'job-1', videoId:'ABC', mediaUrl:'https://cdninstagram.com/video.mp4', filename:'creator-ABC-voz.mp3' };
afterEach(() => vi.useRealTimers());

describe('voice extraction jobs', () => {
  it('downloads only the completed job under the shared download root', async () => {
    const { jobs, downloads, sent, deps } = setup();
    await jobs.start(input, 7);
    await jobs.complete({jobId:input.jobId, success:true, blobUrl:'blob:voice'});
    expect(downloads).toEqual([{url:'blob:voice', filename:'social-mate/creator-ABC-voz.mp3'}]);
    expect(deps.trackDownload).toHaveBeenCalledWith(42, 'blob:voice');
    expect(sent.at(-1)).toMatchObject({tabId:7, success:true, phase:'done', pct:100});
    expect(jobs.status(7)).toBeNull();
  });
  it('rejects a competing job without replacing the first', async () => {
    const { jobs } = setup();
    await jobs.start(input, 7);
    await expect(jobs.start({...input,jobId:'job-2'}, 8)).rejects.toThrow(/extração/);
    expect(jobs.status(7).jobId).toBe('job-1');
    await jobs.cancel('job-1', 7);
  });
  it('keeps percentages monotonic and ignores another job progress', async () => {
    const { jobs, sent } = setup();
    await jobs.start(input, 7);
    jobs.progress({jobId:'job-1', pct:70, phase:'infer'});
    jobs.progress({jobId:'job-1', pct:20, phase:'infer'});
    jobs.progress({jobId:'other', pct:100});
    expect(sent.at(-1).pct).toBe(70);
    await jobs.cancel('job-1', 7);
  });
  it('cancels during offscreen creation before any inference is dispatched', async () => {
    let ready;
    const callOffscreen = vi.fn(async () => ({success:true}));
    const { jobs } = setup({ensureOffscreen:() => new Promise(r => {ready=r;}), callOffscreen});
    const start = jobs.start(input, 7);
    await jobs.cancel('job-1', 7);
    ready();
    await expect(start).rejects.toThrow(/cancelada/);
    expect(callOffscreen).not.toHaveBeenCalled();
  });
  it('revokes late output after cancellation instead of downloading it', async () => {
    const { jobs, downloads, released } = setup();
    await jobs.start(input, 7);
    await jobs.cancel('job-1', 7);
    await jobs.complete({jobId:'job-1', success:true, blobUrl:'blob:late'});
    expect(downloads).toEqual([]);
    expect(released).toEqual(['blob:late']);
  });
  it('does not let another tab cancel the job', async () => {
    const { jobs } = setup();
    await jobs.start(input, 7);
    await expect(jobs.cancel('job-1', 8)).rejects.toThrow(/outra aba/);
    expect(jobs.status(7).jobId).toBe('job-1');
    await jobs.cancel('job-1', 7);
  });
  it('aborts the offscreen worker when the longer timeout expires', async () => {
    vi.useFakeTimers();
    const callOffscreen = vi.fn(async () => ({success:true,started:true}));
    const { jobs, sent } = setup({callOffscreen});
    await jobs.start(input, 7);
    await vi.advanceTimersByTimeAsync(VOICE_TIMEOUT_MS);
    expect(callOffscreen).toHaveBeenLastCalledWith({action:'abortSeparation',jobId:'job-1'});
    expect(sent.at(-1)).toMatchObject({success:false, phase:'error'});
    expect(sent.at(-1).error).toMatch(/expirou/);
  });
  it('releases output when Chrome rejects the download', async () => {
    const { jobs, released, sent } = setup({download:async () => {throw new Error('disk');}});
    await jobs.start(input, 7);
    await jobs.complete({jobId:'job-1',success:true,blobUrl:'blob:failed'});
    expect(released).toEqual(['blob:failed']);
    expect(sent.at(-1)).toMatchObject({success:false,error:'disk'});
  });
});
