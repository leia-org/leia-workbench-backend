import mongoose, { Schema } from 'mongoose';
import { generateUniqueCode } from '../utils/entity.js';
import generatePassword from 'omgopass';

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
      default: null,
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
    form: {
      type: String,
    },
    dataUsageConsentRequired: {
      type: Boolean,
      required: true,
      default: false,
    },
    dataUsageConsentMessage: {
      type: String,
      required: true,
      default:
        'Before starting this activity, please indicate whether you consent to the use of your conversation data for educational and research purposes. Your choice will be recorded with this conversation.',
    },
    conversationAutomatedRemoval: {
      type: Boolean,
      required: true,
      default: false,
    },
    isShared: {
      type: Boolean,
      required: true,
      default: false,
    },
    shareToken: {
      type: String,
    },
  },
  {
    strict: false,
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret) => {
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

ReplicationSchema.methods.regenerateShareToken = function () {
  this.shareToken = generatePassword({
    titlecased: false,
    separators: '-'
  });
};

const ReplicationModel = mongoose.model('Replication', ReplicationSchema);

export default ReplicationModel;
