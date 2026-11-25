export function captureDataUsage(replication) {
  const config = replication.dataUsageConfig;
  if (!config?.dataUsageConsentRequired) return undefined;
  return {
    config: {
      dataUsageConsentRequired: true,
      dataUsageConsentMessage: config.dataUsageConsentMessage,
      conversationAutomatedRemoval: config.conversationAutomatedRemoval === true,
    },
    consentStatus: 'pending',
    decidedAt: null,
    automatedRemovalApplied: false,
  };
}

export function isConsentPending(session) {
  return !session.isTest && session.dataUsage?.config?.dataUsageConsentRequired
    && !['accepted', 'declined', 'not_required'].includes(session.dataUsage.consentStatus);
}

export function shouldRemoveConversation(session) {
  return !session.isTest && session.dataUsage?.config?.dataUsageConsentRequired === true
    && session.dataUsage.config.conversationAutomatedRemoval === true
    && session.dataUsage.consentStatus === 'declined';
}

export function assertConsentDecided(session) {
  if (isConsentPending(session)) {
    throw Object.assign(new Error('Choose whether to allow conversation data usage before interacting'), { statusCode: 403 });
  }
}

// Leave time for the final supervision/evaluation and Langfuse ingestion.
export function conversationRemovalTime(session) {
  return shouldRemoveConversation(session) ? new Date(Date.now() + 5 * 60 * 1000) : undefined;
}
