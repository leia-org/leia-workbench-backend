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
    assignedLeia: {
      type: Schema.Types.ObjectId,
      required: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    isTest: {
      type: Boolean,
      default: false,
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
