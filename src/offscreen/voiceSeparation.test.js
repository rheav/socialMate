import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createVoiceSeparator } from './voiceSeparation.js';
import { serialQueue } from '../lib/serialQueue.js';

let workers, emitted;
const channels = () => [new Float32Array(441), new Float32Array(441)];
beforeEach(() => {
  workers = []; emitted = [];
  vi.stubGlobal('chrome', {runtime:{getURL:p => `chrome-extension://test/${p}`, sendMessage:async m => {emitted.push(m);}}});
  vi.stubGlobal('fetch', async () => new Response(new Uint8Array([1,2,3])));
  vi.stubGlobal('AudioContext', class {
    decodeAudioData() {return Promise.resolve({duration:0.01});}
    close() {return Promise.resolve();}
  });
  vi.stubGlobal('OfflineAudioContext', class {
    createBufferSource() {return {connect(){},start(){}};}
    startRendering() {return Promise.resolve({getChannelData:() => new Float32Array(441)});}
  });
  vi.stubGlobal('Worker', class {
    constructor() {workers.push(this);this.terminated=false;}
    postMessage(m) {this.msg=m;}
    terminate() {this.terminated=true;}
    finish(ok = true) {this.onmessage({data:{id:this.msg.id,ok,channels:channels(),error:'bad inference'}});}
  });
});
afterEach(() => vi.unstubAllGlobals());
function setup(extra = {}) {
  const fm = {writeFile:vi.fn(async () => {}), exec:vi.fn(async () => 0), readFile:vi.fn(async () => Uint8Array.of(1,2)),deleteFile:vi.fn(async () => {})};
  const registerBlob = vi.fn(() => 'blob:voice');
  const resetFfmpeg = vi.fn();
  const engine = createVoiceSeparator({getFfmpeg:async () => fm, queueFfmpeg:serialQueue(), resetFfmpeg, registerBlob, ...extra});
  return {engine,fm,registerBlob,resetFfmpeg};
}
const msg = {jobId:'j1',videoId:'v1',audioUrl:'https://cdninstagram.com/test.mp4',filename:'ig-v1-voz.mp3'};

describe('offscreen voice lifecycle', () => {
  it('terminates inference on cancel, settles the job, and can start again', async () => {
    const {engine,registerBlob} = setup();
    const first = engine.run(msg);
    const rejected = expect(first).rejects.toThrow(/cancelada/);
    await vi.waitFor(() => expect(workers[0]?.msg).toBeTruthy());
    engine.abort('wrong');
    expect(workers[0].terminated).toBe(false);
    engine.abort('j1');
    await rejected;
    expect(workers[0].terminated).toBe(true);
    expect(engine.busy()).toBe(false);
    expect(registerBlob).not.toHaveBeenCalled();
    const next = engine.run({...msg,jobId:'j2'});
    await vi.waitFor(() => expect(workers[1]?.msg).toBeTruthy());
    workers[1].finish();
    await expect(next).resolves.toMatchObject({blobUrl:'blob:voice'});
    engine.release();
    expect(workers[1].terminated).toBe(true);
  });
  it('ignores late decoding after cancellation and never starts a worker', async () => {
    let resolveDecode;
    vi.stubGlobal('AudioContext', class {
      decodeAudioData() {return new Promise(r => {resolveDecode=r;});}
      close() {return Promise.resolve();}
    });
    const {engine,registerBlob} = setup();
    const run = engine.run(msg);
    const rejected = expect(run).rejects.toThrow(/cancelada/);
    await vi.waitFor(() => expect(resolveDecode).toBeTruthy());
    engine.abort('j1');
    await rejected;
    resolveDecode({duration:1});
    await Promise.resolve();
    expect(workers).toHaveLength(0);
    expect(registerBlob).not.toHaveBeenCalled();
  });
  it('reports an encoder failure without publishing a blob', async () => {
    const {engine,fm,registerBlob} = setup();
    fm.exec.mockResolvedValue(1);
    const run = engine.run(msg);
    const rejected = expect(run).rejects.toThrow(/MP3/);
    await vi.waitFor(() => expect(workers[0]?.msg).toBeTruthy());
    workers[0].finish();
    await rejected;
    expect(registerBlob).not.toHaveBeenCalled();
    expect(fm.deleteFile).toHaveBeenCalledTimes(2);
    engine.release();
  });
  it('aborts only the FFmpeg instance currently encoding this voice job', async () => {
    const {engine,fm,resetFfmpeg,registerBlob} = setup();
    let failExec;
    fm.exec.mockImplementation(() => new Promise((_,reject) => {failExec=reject;}));
    resetFfmpeg.mockImplementation(() => failExec(new Error('terminated')));
    const run = engine.run(msg);
    const rejected = expect(run).rejects.toThrow(/cancelada/);
    await vi.waitFor(() => expect(workers[0]?.msg).toBeTruthy());
    workers[0].finish();
    await vi.waitFor(() => expect(failExec).toBeTruthy());
    engine.abort('j1');
    await rejected;
    expect(resetFfmpeg).toHaveBeenCalledWith(fm);
    expect(registerBlob).not.toHaveBeenCalled();
  });
});
