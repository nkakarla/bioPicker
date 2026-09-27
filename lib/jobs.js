// BioPicker — in-process background jobs. Renders run one at a time; AI jobs a few at a time.
// Copyright (c) 2026 ePerf
import { newId } from "./util.js";

const jobs = new Map();
const queues = { render: { limit: Number(process.env.RENDER_CONCURRENCY || 1), running: 0, waiting: [] }, ai: { limit: 3, running: 0, waiting: [] } };

export function startJob({ projectId, type, lane = "ai", label }, fn) {
  const job = {
    id: newId(12),
    projectId,
    type,
    label: label || type,
    status: "queued",
    progress: 0,
    log: [],
    error: null,
    result: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  const q = queues[lane];
  const exec = async () => {
    q.running++;
    job.status = "running";
    try {
      job.result = await fn({
        log: (m) => {
          job.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`);
          if (job.log.length > 400) job.log.splice(0, job.log.length - 400);
        },
        progress: (x) => (job.progress = Math.max(job.progress, Math.min(1, x))),
      });
      job.status = "done";
      job.progress = 1;
    } catch (e) {
      console.error(`[job ${job.type}]`, e);
      job.status = "error";
      job.error = e.message || String(e);
    } finally {
      q.running--;
      const next = q.waiting.shift();
      if (next) next();
    }
  };
  if (q.running < q.limit) exec();
  else q.waiting.push(exec);
  return job;
}

export const getJob = (id) => jobs.get(id);

export const activeJobs = (projectId) =>
  [...jobs.values()].filter((j) => j.projectId === projectId && (j.status === "running" || j.status === "queued"));

// forget finished jobs after a day
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff && j.status !== "running") jobs.delete(id);
}, 3600 * 1000).unref();
