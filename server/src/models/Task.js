import mongoose from 'mongoose';
import { PRIORITIES, PRIORITY_RANK } from './Assignment.js';
import { jsonOptions } from '../utils/validation.js';

export { PRIORITIES };

// A daily task: something to do on a given day, optionally at a given time.
// It can be linked to ONE subject OR ONE assignment (not both). A task linked to an assignment gets its subject
// from that assignment when displayed, so the assignment's information is never copied into the task.
const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: [true, 'Title is required.'], trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 1000, default: '' },
    date: { type: String, required: [true, 'Date is required.'], match: /^\d{4}-\d{2}-\d{2}$/ },
    time: { type: String, default: '', match: /^$|^([01]\d|2[0-3]):[0-5]\d$/ },
    priority: { type: String, enum: PRIORITIES, default: 'Medium' },
    completed: { type: Boolean, default: false },
    // Optional links. Every write that sets one follows utils/transaction.js (locks the target in a transaction).
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', default: null },
    // Internal helpers for sorting (set automatically, never sent to the browser).
    priorityRank: { type: Number, default: PRIORITY_RANK.Medium },
    timeSort: { type: String, default: '99:99' }, // tasks without a time sort after timed ones
  },
  {
    timestamps: true,
    toJSON: {
      ...jsonOptions,
      transform: (doc, ret) => {
        jsonOptions.transform(doc, ret);
        delete ret.priorityRank;
        delete ret.timeSort;
        return ret;
      },
    },
  },
);

taskSchema.pre('validate', function setSortHelpers() {
  this.priorityRank = PRIORITY_RANK[this.priority];
  this.timeSort = this.time || '99:99';
  if (this.subject && this.assignment) this.invalidate('assignment', 'A task links to a subject or an assignment, not both.');
});

taskSchema.index({ date: 1, timeSort: 1 });
taskSchema.index({ subject: 1 });
taskSchema.index({ assignment: 1 });

export default mongoose.model('Task', taskSchema);
