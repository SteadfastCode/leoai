/**
 * Pure helpers for handoff follow-up logic, kept free of Mongoose so they can
 * be unit-tested without a database.
 */

const DEFAULT_MAX_REMINDERS = 3;

/**
 * Should this conversation get a follow-up reminder right now?
 *
 * `entity` needs handoffFollowUp ({ enabled, intervalHours, maxReminders }),
 * ownerPhone, ownerEmail. `conversation` needs lastHandoffNotifiedAt and
 * handoffReminderCount. Entities and conversations created before these fields
 * existed lack them — absent maxReminders means the default cap, absent
 * reminderCount means zero sent so far.
 */
function reminderDue(entity, conversation, now = Date.now()) {
  const followUp = entity.handoffFollowUp || {};
  if (!followUp.enabled) return false;
  if (!entity.ownerPhone && !entity.ownerEmail) return false;

  // Follow-ups only ever trail an initial notification
  if (!conversation.lastHandoffNotifiedAt) return false;

  const count = conversation.handoffReminderCount || 0;
  const max = followUp.maxReminders ?? DEFAULT_MAX_REMINDERS;
  if (count >= max) return false;

  const intervalMs = (followUp.intervalHours || 24) * 60 * 60 * 1000;
  return now - new Date(conversation.lastHandoffNotifiedAt).getTime() >= intervalMs;
}

module.exports = { reminderDue, DEFAULT_MAX_REMINDERS };
