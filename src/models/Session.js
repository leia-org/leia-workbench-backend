import { Schema, model } from 'mongoose';

const sessionSchema = new Schema(
  {
    startedAt: {
      type: Date,
      default: Date.now,
    },
    finishedAt: {
      type: Date,
    },
    result: {
      type: String,
    },
    evaluation: {
      type: String,
    },
    score: {
      type: Number,
    },
    messages: [
      {
        type: Schema.Types.ObjectId,
        ref: 'Message',
      },
    ],
    replication: {
      type: Schema.Types.ObjectId,
      ref: 'Replication',
      required: true,
    },
    leia: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
    isTest: {
      type: Boolean,
      default: false,
    },
    isRunnerInitialized: {
      type: Boolean,
      default: false,
    },
    draft: {
      type: String,
    },
    // Background supervisor (instructor-only). Flags raised while observing the
    // activity; never exposed to the student. supervisorState tracks the
    // observation cursor and any pending student nudge.
    supervisorFlags: {
      type: [Schema.Types.Mixed],
      default: undefined,
    },
    supervisorState: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  {
    strict: false,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
      },
    },
  }
);

sessionSchema.index({ user: 1, replication: 1, isTest: 1 }, { partialFilterExpression: { isTest: false } });

export default model('Session', sessionSchema);
