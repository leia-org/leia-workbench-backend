import { Schema, model } from 'mongoose';

// One entry of the suite. `expected` / `actual` arrive already serialised by
// the client (the raw values can be BigInt, Map or circular), so they are
// stored as strings.
const testResultSchema = new Schema(
  {
    name: { type: String, default: '' },
    ok: { type: Boolean, required: true },
    error: { type: String, default: undefined },
    expected: { type: String, default: undefined },
    actual: { type: String, default: undefined },
  },
  { _id: false }
);

// A single execution of the code editor's test suite. Tests run in the
// student's browser, so everything here is client-reported; the server only
// stamps the time (`createdAt`) and derives the counters and the status.
//
// Kept in its own collection (not embedded in Session) so the code snapshots
// are never loaded on the message hot path and cannot grow a session document
// towards the 16 MB limit.
const testRunSchema = new Schema(
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
    // Who started the run: the student's "Run tests" button or the LEIA's
    // codeEditor_runTests tool.
    trigger: {
      type: String,
      enum: ['student', 'leia'],
      required: true,
    },
    language: {
      type: String,
      enum: ['javascript', 'python'],
      required: true,
    },
    fnName: { type: String, default: '' },
    // Editor content at the moment the run started.
    code: { type: String, default: '' },
    codeTruncated: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ['passed', 'failed', 'error'],
      required: true,
    },
    passed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    results: { type: [testResultSchema], default: [] },
    // Suite-level failure (syntax error, timeout): no per-test results.
    error: { type: String, default: null },
    durationMs: { type: Number, default: 0 },
    // Client clock when the run started; `createdAt` is the canonical time.
    clientRunAt: { type: Date, default: undefined },
    // Client-generated id that makes a retried report idempotent.
    clientRunId: { type: String, default: undefined },
    // Set once a student-triggered run has been passed to the LEIA as context.
    reportedToLeiaAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
      },
    },
  }
);

testRunSchema.index({ session: 1, createdAt: 1 });
testRunSchema.index({ replication: 1, createdAt: 1 });
testRunSchema.index(
  { session: 1, clientRunId: 1 },
  { unique: true, partialFilterExpression: { clientRunId: { $type: 'string' } } }
);

export default model('TestRun', testRunSchema);
