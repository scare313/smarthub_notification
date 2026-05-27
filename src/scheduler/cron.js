const cron = require('node-cron');

let fastMode = false;
let lastRunTime = 0;

function startScheduler(runCycleCallback, initialMinMins = Infinity) {
  // Determine initial fastMode status
  if (initialMinMins <= 60) {
    fastMode = true;
    console.log(`[Scheduler] Initial pending orders are near deadline (${initialMinMins} mins remaining). Fast Mode (5m) enabled.`);
  } else {
    fastMode = false;
    console.log('[Scheduler] Pending orders are clear or far from deadline. Normal Mode (15m) enabled.');
  }

  // Triggered every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    const now = Date.now();
    const minutesSinceLastRun = (now - lastRunTime) / (1000 * 60);

    // Decide if we should execute this cycle
    if (lastRunTime === 0 || fastMode || minutesSinceLastRun >= 14) {
      console.log(`[Scheduler] Triggering check cycle. FastMode=${fastMode}, Minutes since last run: ${minutesSinceLastRun.toFixed(1)}`);
      
      try {
        lastRunTime = now;
        const minRemainingMins = await runCycleCallback();

        // Update fastMode status based on remaining times from current run
        if (minRemainingMins <= 60) {
          if (!fastMode) {
            fastMode = true;
            console.log('[Scheduler] Urgent pending orders detected (<= 60 mins remaining). Switching to Fast Mode (5m).');
          }
        } else {
          if (fastMode) {
            fastMode = false;
            console.log('[Scheduler] No urgent pending orders. Restoring Normal Mode (15m).');
          }
        }
      } catch (err) {
        console.error('[Scheduler] Scheduled execution cycle failed:', err);
      }
    } else {
      console.log(`[Scheduler] Skipping 5-minute trigger. FastMode=false, minutes since last run: ${minutesSinceLastRun.toFixed(1)}`);
    }
  });

  console.log('[Scheduler] Cron scheduler registered successfully to run every 5 minutes.');
}

module.exports = { startScheduler };
