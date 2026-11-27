import ActivityRun from '../../models/ActivityRun.js';
import Session from '../../models/Session.js';
import MessageRepository from '../../repositories/v1/MessageRepository.js';
import EventRepository from '../../repositories/v1/EventRepository.js';
import logger from '../../utils/logger.js';
import RunnerService from './RunnerService.js';

const POLL_INTERVAL_MS = 30000;
const RETRY_INTERVAL_MS = 120000;
const BATCH_SIZE = 10;

export async function processConversationRemoval(now = new Date()) {
  // Claim in MongoDB so restarts or overlapping replicas do not lose cleanup.
  const nextAttempt = new Date(now.getTime() + RETRY_INTERVAL_MS);
  const session = await Session.findOneAndUpdate(
    {
      conversationRemovalDueAt: { $lte: now },
      finishedAt: { $type: 'date' },
      isTest: { $ne: true },
      'dataUsage.config.dataUsageConsentRequired': true,
      'dataUsage.config.conversationAutomatedRemoval': true,
      'dataUsage.consentStatus': 'declined',
    },
    { $set: { conversationRemovalDueAt: nextAttempt } },
    { sort: { conversationRemovalDueAt: 1 }, new: true }
  ).select('run startedAt +langfuseEmptySince').lean();
  if (!session) return false;

  const claim = { _id: session._id, conversationRemovalDueAt: nextAttempt };
  if (session.run && !await ActivityRun.exists({ _id: session.run, finishedAt: { $type: 'date' } })) {
    return true;
  }

  try {
    await MessageRepository.deleteBySession(session._id);
    // Whatever was recorded of the student's activity goes with the messages.
    await EventRepository.deleteBySession(session._id);
    await Session.updateOne(claim, {
      $set: { messages: [], 'dataUsage.automatedRemovalApplied': true },
      $unset: { supervisorFlags: 1, supervisorState: 1 },
    });

    const complete = await RunnerService.removeSessionTraces(String(session._id), session.startedAt);
    // Require two empty reads separated by the retry interval so delayed
    // Langfuse ingestion is checked again before acknowledging removal.
    const update = !complete
      ? { $unset: { langfuseEmptySince: 1 } }
      : session.langfuseEmptySince
        ? { $unset: { conversationRemovalDueAt: 1, langfuseEmptySince: 1 } }
        : { $set: { langfuseEmptySince: now } };
    await Session.updateOne(claim, update);
  } catch {
    // HTTP exceptions may contain API credentials. The claim expires and is retried.
    logger.warn(`Conversation removal will be retried for session ${session._id}`);
  }
  return true;
}

export function startConversationRemoval() {
  let stopped = false;
  let timer;
  const poll = async () => {
    try {
      for (let i = 0; i < BATCH_SIZE && !stopped; i++) {
        if (!await processConversationRemoval()) break;
      }
    } catch {
      logger.warn('Conversation removal queue could not be processed');
    } finally {
      if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS).unref();
    }
  };
  void poll();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
