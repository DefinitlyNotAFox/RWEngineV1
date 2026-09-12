const MAX_STEPS_PER_JOB = 12;
const STEP_DELAY_MS = 250;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledSweep(env, controller));
  },

  async fetch() {
    return new Response(JSON.stringify({
      ok: true,
      service: 'rwengine-daily-sync',
      note: 'Faction snapshots are scheduled by Cron Trigger.'
    }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
};

async function runScheduledSweep(env, controller) {
  const baseUrl = String(env.RWE_BASE_URL || 'https://rwenginev1.pages.dev').replace(/\/$/, '');
  const plan = await cronPost(baseUrl, env, { action: 'cronPlan' });
  const results = [];

  for (const entry of plan.jobs || []) {
    let job = entry.job || null;
    const item = {
      factionId: Number(entry.factionId || job?.factionId || 0),
      factionName: entry.factionName || null,
      reason: entry.reason || null,
      jobId: Number(job?.jobId || 0),
      status: job?.status || null,
      steps: 0,
      error: null
    };

    try {
      for (let step = 0; step < MAX_STEPS_PER_JOB; step += 1) {
        if (!job || ['completed', 'failed'].includes(String(job.status))) break;

        const response = await cronPost(baseUrl, env, {
          action: 'cronStep',
          factionId: item.factionId,
          jobId: item.jobId
        });

        job = response.job || job;
        item.steps += 1;
        item.status = job?.status || item.status;

        if (response.busy || ['completed', 'failed'].includes(String(job?.status))) break;
        await sleep(STEP_DELAY_MS);
      }
    } catch (error) {
      item.error = error?.message || String(error);
      item.status = item.status || 'error';
    }

    results.push(item);
  }

  console.log(JSON.stringify({
    event: 'rwengine-scheduled-sync',
    cron: controller?.cron || null,
    scheduledTime: controller?.scheduledTime || Date.now(),
    date: plan.date || null,
    jobs: results,
    skipped: plan.skipped || []
  }));
}

async function cronPost(baseUrl, env, payload) {
  const secret = String(env.CRON_SECRET || '');
  if (!secret) throw new Error('CRON_SECRET is not configured on the Worker.');

  const response = await fetch(`${baseUrl}/v2/sync-current`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-RWE-Cron-Secret': secret
    },
    body: JSON.stringify(payload)
  });

  let data = null;
  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok || !data?.success) {
    throw new Error(data?.message || `RWEngine sync endpoint returned HTTP ${response.status}.`);
  }

  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
