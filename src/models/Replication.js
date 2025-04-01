import mongoose, { Schema } from 'mongoose';
import { generateUniqueCode } from '../utils/entity.js';

const ReplicationSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
    },
    isActive: {
      type: Boolean,
      required: true,
      default: false,
    },
    duration: {
      type: Number,
      required: true,
      default: 1800,
    },
    isRepeatable: {
      type: Boolean,
      required: true,
      default: false,
    },
    experiment: {
      type: Schema.Types.Mixed,
      required: true,
    },
  },
  {
    strict: false,
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
      },
    },
  }
);

ReplicationSchema.pre('validate', async function (next) {
  try {
    if (!this.code) {
      console.log('Generating unique code for replication...');
      this.code = await generateUniqueCode(ReplicationModel, 'R', 5);
    }

    next();
  } catch (err) {
    next(err);
  }
});

ReplicationSchema.methods.regenerateCode = async function () {
  this.code = await generateUniqueCode(ReplicationModel, 'R', 5);
};

const ReplicationModel = mongoose.model('Experiment', ReplicationSchema);

export default ReplicationModel;
