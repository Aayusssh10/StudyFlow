import mongoose from 'mongoose';
import { jsonOptions } from '../utils/validation.js';

export const DEFAULT_SUBJECT_COLOR = '#4f46e5';

const subjectSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Subject name is required.'], trim: true, maxlength: 100 },
    code: { type: String, trim: true, maxlength: 20, default: '' },
    description: { type: String, trim: true, maxlength: 500, default: '' },
    instructor: { type: String, trim: true, maxlength: 100, default: '' },
    color: {
      type: String,
      default: DEFAULT_SUBJECT_COLOR,
      match: [/^#[0-9a-fA-F]{6}$/, 'Color must look like #4f46e5.'],
    },
    // Internal lock token (see utils/transaction.js). Incremented whenever something starts pointing at
    // this subject, so that creating a reference and deleting the subject always conflict.
    referenceVersion: { type: Number, default: 0, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      ...jsonOptions,
      transform: (doc, ret) => {
        jsonOptions.transform(doc, ret);
        delete ret.referenceVersion; // internal, never sent to the browser
        return ret;
      },
    },
  },
);

// Two subjects cannot share a name, ignoring upper/lower case ("Math" = "math").
export const NAME_COLLATION = { locale: 'en', strength: 2 };
subjectSchema.index({ name: 1 }, { unique: true, collation: NAME_COLLATION });

export default mongoose.model('Subject', subjectSchema);
