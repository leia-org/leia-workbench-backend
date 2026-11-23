function ownerId(value) {
  if (typeof value?.toHexString === 'function') return value.toHexString();
  return value?._id ?? value?.id ?? value;
}

export function ownsReplication(replication, user) {
  if (!user?.id) return false;
  const owner = replication.user ?? replication.userId;
  const effectiveOwner = owner ?? (user.role === 'advanced' ? replication.experiment?.user : null);
  const id = ownerId(effectiveOwner);
  return id != null && String(id) === String(user.id);
}

export function replicationOwnershipQuery(userId) {
  return {
    $or: [
      { user: userId },
      {
        user: null,
        $or: [
          { 'experiment.user.id': userId },
          { 'experiment.user._id': userId },
          { 'experiment.user': userId },
        ],
      },
    ],
  };
}
