import { Schema, model } from 'mongoose';

const messageSchema = new Schema(
  {
    text: {
      type: String,
      required: true,
    },
    isLeia: {
      type: Boolean,
      required: true,
    },
    senderType: {
      type: String,
      enum: ['participant', 'agent', 'system'],
      default: undefined,
    },
    senderId: {
      type: String,
      default: undefined,
    },
    senderName: {
      type: String,
      default: undefined,
    },
    recipientIds: {
      type: [String],
      default: undefined,
    },
    addressedToId: {
      type: String,
      default: undefined,
    },
    addressedToName: {
      type: String,
      default: undefined,
    },
    sequence: {
      type: Number,
      default: undefined,
    },
    turnId: {
      type: String,
      default: undefined,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    session: {
      type: Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
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

messageSchema.index({ session: 1 });
messageSchema.index({ session: 1, sequence: 1 });

export default model('Message', messageSchema);
