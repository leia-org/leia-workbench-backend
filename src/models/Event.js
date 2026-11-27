import { Schema, model } from 'mongoose';
import { EVENT_ACTORS, EVENT_SOURCES, EVENT_TYPES, EVENT_VIEWS } from '../utils/eventTypes.js';

// One student interaction event: a test run of the code editor, a copy / cut /
// paste, leaving or returning to the page... Events are reported by the
// browser, so everything is client-reported; the server derives a few fields
// and places the event on its own clock (`at`).
//
// A single collection for every kind of event keeps ingestion, consent, caps,
// exports and the live feed in one place. What is specific to a kind lives in
// utils/eventTypes.js.
const eventSchema = new Schema(
  {
    session: {
      type: Schema.Types.ObjectId,
      ref: 'Session',
      required: true,
    },
    replication: {
      type: Schema.Types.ObjectId,
      ref: 'Replication',
      required: true,
    },
    // Where the session sat in its activity when the event was stored. Hints
    // only: sessions created before the staged model have none, so exports
    // read run and stage from the session itself.
    run: { type: Schema.Types.ObjectId, ref: 'ActivityRun', default: undefined },
    stageId: { type: String, default: undefined },
    stageIndex: { type: Number, default: undefined },

    type: { type: String, enum: EVENT_TYPES, required: true },
    // The surface of the student UI where it happened (chat input, an editor…).
    source: { type: String, enum: EVENT_SOURCES, required: true },
    actor: { type: String, enum: EVENT_ACTORS, required: true },
    view: { type: String, enum: EVENT_VIEWS, default: undefined },

    // Light, type-specific data. Safe for lists and live updates.
    payload: { type: Schema.Types.Mixed, default: {} },
    // Heavy text (code under test, clipboard text). Never selected unless
    // asked for, so it cannot reach a list, a socket or a log by accident.
    content: { type: String, select: false },
    hasContent: { type: Boolean, default: false },
    contentTruncated: { type: Boolean, default: false },

    // Client-generated id that makes a retried report idempotent.
    clientEventId: { type: String, required: true },
    // Client clock and per-page counter, as reported.
    clientAt: { type: Date, required: true },
    seq: { type: Number, default: 0 },
    // When the event happened on the server clock. Batches arrive late, so
    // this is derived from the client clock, not the time of reception.
    at: { type: Date, required: true },
    // Set once the LEIA has been told about the event (test runs today).
    reportedToLeiaAt: { type: Date, default: undefined },
  },
  {
    // createdAt = when the server received it.
    timestamps: { createdAt: true, updatedAt: false },
    minimize: false,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
      },
    },
  }
);

eventSchema.index({ session: 1, at: 1 });
eventSchema.index({ session: 1, type: 1, createdAt: 1 });
eventSchema.index({ replication: 1, session: 1, type: 1 });
eventSchema.index({ session: 1, clientEventId: 1 }, { unique: true });

export default model('Event', eventSchema);
