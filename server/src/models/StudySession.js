import mongoose from 'mongoose';
import { jsonOptions } from '../utils/validation.js';

export const SESSION_TYPES = ['Reading', 'Practice', 'Revision', 'Group study', 'Other'];
export const MAX_DURATION_MINUTES = 1440; // 24 hours

// A study session: time spent studying one SUBJECT (required), optionally for one ASSIGNMENT.
// The duration is entered in minutes. Study-time totals are always CALCULATED from stored sessions
// (see the summary endpoint), never stored separately, so they can never disagree with the sessions.
// Both links follow the rules in utils/transaction.js: the subject and assignment are locked inside a
// transaction when a session is saved; a subject that has sessions cannot be deleted; deleting an assignment
// keeps its sessions and clears their `assignment` link.
const studySessionSchema = new mongoose.Schema(
  {
    subject: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: [true, 'Subject is required.'] },
    assignment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', default: null },
    date: { type: String, required: [true, 'Date is required.'], match: /^\d{4}-\d{2}-\d{2}$/ },
    startTime: { type: String, default: '', match: /^$|^([01]\d|2[0-3]):[0-5]\d$/ },
    durationMinutes: {
      type: Number,
      required: [true, 'Duration is required.'],
      min: 1,
      max: MAX_DURATION_MINUTES,
      validate: { validator: Number.isInteger, message: 'Duration must be a whole number of minutes.' },
    },
    notes: { type: String, trim: true, maxlength: 1000, default: '' },
    type: { type: String, enum: [...SESSION_TYPES, ''], default: '' },
  },
  { timestamps: true, toJSON: jsonOptions },
);

studySessionSchema.index({ date: -1, startTime: -1 });
studySessionSchema.index({ subject: 1 });
studySessionSchema.index({ assignment: 1 });

export default mongoose.model('StudySession', studySessionSchema);
