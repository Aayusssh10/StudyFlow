import mongoose from 'mongoose';
import { jsonOptions } from '../utils/validation.js';

export const PRIORITIES = ['Low', 'Medium', 'High'];
export const STATUSES = ['Not Started', 'In Progress', 'Completed'];
export const TYPES = ['Homework', 'Project', 'Exam', 'Other'];
export const MAX_ESTIMATED_MINUTES = 10080; // one week

// Priorities as numbers so "sort by priority" is possible (text would sort High, Low, Medium).
export const PRIORITY_RANK = { Low: 1, Medium: 2, High: 3 };

const assignmentSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Title is required.'], trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 2000, default: '' },
    // Optional link to a subject. Phase 3's subject deletion rule looks at assignments.subject.
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    dueDate: { type: String, required: [true, 'Due date is required.'], match: /^\d{4}-\d{2}-\d{2}$/ },
    dueTime: { type: String, default: '', match: /^$|^([01]\d|2[0-3]):[0-5]\d$/ },
    priority: { type: String, enum: PRIORITIES, default: 'Medium' },
    priorityRank: { type: Number, default: PRIORITY_RANK.Medium },
    status: { type: String, enum: STATUSES, default: 'Not Started' },
    estimatedMinutes: {
      type: Number,
      default: null,
      min: 1,
      max: MAX_ESTIMATED_MINUTES,
      validate: { validator: (value) => value === null || Number.isInteger(value), message: 'Estimated minutes must be a whole number.' },
    },
    type: { type: String, enum: [...TYPES, ''], default: '' },
    // Internal lock token (see utils/transaction.js): incremented whenever a task starts pointing at this
    // assignment, so that attaching a task and deleting the assignment always conflict.
    referenceVersion: { type: Number, default: 0, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      ...jsonOptions,
      transform: (doc, ret) => {
        jsonOptions.transform(doc, ret);
        delete ret.priorityRank; // internal helper for sorting
        delete ret.referenceVersion; // internal, never sent to the browser
        return ret;
      },
    },
  },
);

// Keep the numeric rank in step with the priority name, whoever sets it.
assignmentSchema.pre('validate', function setPriorityRank() {
  this.priorityRank = PRIORITY_RANK[this.priority];
});

assignmentSchema.index({ dueDate: 1, dueTime: 1 });
assignmentSchema.index({ subject: 1 });

export default mongoose.model('Assignment', assignmentSchema);
