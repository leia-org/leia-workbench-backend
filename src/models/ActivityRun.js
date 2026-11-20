import { Schema, model } from 'mongoose';

const stageEntrySchema = new Schema(
  {
    stageId: { type: String, required: true },
    stageIndex: { type: Number, required: true },
    session: { type: Schema.Types.ObjectId, ref: 'Session', required: true },
  },
  { _id: false, id: false }
);

const activityRunSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    replication: {
      type: Schema.Types.ObjectId,
      ref: 'Replication',
      required: true,
    },
    isTest: {
      type: Boolean,
      default: false,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    finishedAt: {
      type: Date,
    },
    currentStageIndex: {
      type: Number,
      default: 0,
    },
    runKey: {
      type: String,
    },
    stages: {
      type: [stageEntrySchema],
      default: [],
    },
    // Placeholder for unified per-run data usage consent & post-run removal.
    dataUsage: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  {
    strict: false,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
        delete ret._id;
        delete ret.__v;
      },
    },
  }
);

activityRunSchema.index(
  { user: 1, replication: 1, isTest: 1, startedAt: -1 },
  { partialFilterExpression: { isTest: false } }
);
activityRunSchema.index({ runKey: 1 }, { unique: true, sparse: true });

export default model('ActivityRun', activityRunSchema);
