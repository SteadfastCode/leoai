// Per-entity daily cost/volume guardrail (LEO-035).
//
// Tracks message volume per UTC calendar day and fires ONE alert to the owner
// and superadmin when the count crosses the entity's dailyVolumeAlert
// threshold. It never blocks traffic — it warns. The "should alert now"
// decision is a pure function so it is unit-testable without a DB or send
// path, and the once-per-day guarantee uses the same atomic findOneAndUpdate
// test-and-set pattern as the handoff notification in chat.js.

const Entity = require('../models/Entity');
const { sendDailyVolumeAlert } = require('./notifications');

// UTC calendar day, e.g. '2026-08-19'.
function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

// Pure decision: should this message's increment fire the once-a-day alert?
// threshold <= 0 (or absent) means the guardrail is off.
function shouldAlertNow({ todayCount, threshold, lastAlertedDay, now }) {
  if (!Number.isFinite(threshold) || threshold <= 0) return false;
  if (todayCount < threshold) return false;
  return lastAlertedDay !== utcDay(now);
}

// Bump today's counter and fire at most one alert per UTC day. Concurrent
// messages may race the midnight rollover reset (an increment or two can be
// lost at the boundary — harmless for a warning counter), but the alert
// test-and-set matches exactly one caller, so the send never duplicates.
async function trackDailyVolume({ entityId, now = new Date() }) {
  const today = utcDay(now);

  await Entity.updateOne(
    { _id: entityId, dailyVolumeDay: { $ne: today } },
    { $set: { dailyVolumeDay: today, dailyVolumeCount: 0 } }
  );
  const entity = await Entity.findOneAndUpdate(
    { _id: entityId },
    { $inc: { dailyVolumeCount: 1 } },
    { new: true }
  );
  if (!entity) return;

  const alert = shouldAlertNow({
    todayCount: entity.dailyVolumeCount,
    threshold: entity.dailyVolumeAlert,
    lastAlertedDay: entity.dailyVolumeLastAlertedDay,
    now,
  });
  if (!alert) return;

  const winner = await Entity.findOneAndUpdate(
    { _id: entityId, dailyVolumeLastAlertedDay: { $ne: today } },
    { $set: { dailyVolumeLastAlertedDay: today } }
  );
  if (!winner) return; // a concurrent message already fired today's alert

  await sendDailyVolumeAlert({
    entity,
    count: entity.dailyVolumeCount,
    threshold: entity.dailyVolumeAlert,
  });
}

module.exports = { trackDailyVolume, shouldAlertNow, utcDay };
