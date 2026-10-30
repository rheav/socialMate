// Archives being assembled in the offscreen document, one file per call: the caller
// keeps the pace, the progress and the stop button, and a worker that sleeps between
// two files loses nothing. Each file stays a Blob, which Chrome can spill to disk;
// its bytes are in the renderer's memory only long enough to compute the CRC.

import { ZipBuilder } from "./zipWriter.js";

// Sealing at 2 GiB stays clear of the format's 4 GiB ceiling (no ZIP64 here) and of
// the unzippers that fail past 2 GiB. The next files open "-parte2".
export const ZIP_PART_BYTES = 2 ** 31;
// A tab closed mid-run never calls finish; its bytes go after this long with no add.
export const ZIP_ABANDON_MS = 10 * 60 * 1000;

export function createZipJobs({ mint, fetchFn = (url) => fetch(url), partBytes = ZIP_PART_BYTES, now = Date.now }) {
  const jobs = new Map();
  const seal = (job) => {
    const blobUrl = mint(new Blob(job.zip.finish(), { type: "application/zip" }));
    job.zip = new ZipBuilder({ date: new Date() });
    return { blobUrl, part: ++job.part };
  };
  return {
    // Resolves with { blobUrl, part } when this file closed a full part, else {}.
    async add(jobId, name, url) {
      let job = jobs.get(jobId);
      if (!job) jobs.set(jobId, (job = { zip: new ZipBuilder({ date: new Date() }), part: 0 }));
      job.touched = now();
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const sealed = job.zip.count && job.zip.byteLength + blob.size > partBytes ? seal(job) : {};
      job.zip.add(name, new Uint8Array(await blob.arrayBuffer()), blob);
      job.touched = now();
      return sealed;
    },
    // The last part, or {} when no file made it in.
    finish(jobId) {
      const job = jobs.get(jobId);
      jobs.delete(jobId);
      return job?.zip.count ? seal(job) : {};
    },
    // The idle release asks this before closing the document.
    active() {
      for (const [id, job] of jobs) if (now() - job.touched > ZIP_ABANDON_MS) jobs.delete(id);
      return jobs.size > 0;
    },
  };
}
