import mongoose from 'mongoose';
import { PRIORITIES, STATUSES } from '../models/Assignment.js';
import { TIMINGS, timingFilter } from '../utils/assignmentTiming.js';
import { AppError } from '../utils/AppError.js';
import { throwIfErrors } from '../utils/validation.js';
import { createQueryReader, escapeRegExp, parsePositiveInt } from './queryHelpers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SORTS = ['dueDate', 'priority', 'createdAt'];
const ORDERS = ['asc', 'desc'];
// Sensible default direction for each sort: soonest due first, High priority first, newest first.
const DEFAULT_ORDER = { dueDate: 'asc', priority: 'desc', createdAt: 'desc' };

// Turns ?subject=...&status=...&sort=... into a safe MongoDB filter and sort.
// Every value must be a plain string from a known list/format; anything else is a 400.
export function parseAssignmentQuery(query) {
  const errors = [];
  const read = createQueryReader(query, errors);

  const now = read.now();
  const subject = read.reference('subject');
  const status = read.oneOf('status', STATUSES);
  const priority = read.oneOf('priority', PRIORITIES);
  const timing = read.oneOf('timing', TIMINGS);
  const dueFrom = read.date('dueFrom');
  const dueTo = read.date('dueTo');
  const sortName = read.oneOf('sort', SORTS) ?? 'dueDate';
  const order = read.oneOf('order', ORDERS) ?? DEFAULT_ORDER[sortName];
  const search = read.search();

  throwIfErrors(errors);
  if (dueFrom && dueTo && dueFrom > dueTo) throw new AppError('"dueFrom" must not be after "dueTo".', 400);

  const conditions = [];
  if (subject === 'none') conditions.push({ subject: null });
  else if (subject) conditions.push({ subject: new mongoose.Types.ObjectId(subject) });
  if (status) conditions.push({ status });
  if (priority) conditions.push({ priority });
  if (dueFrom) conditions.push({ dueDate: { $gte: dueFrom } });
  if (dueTo) conditions.push({ dueDate: { $lte: dueTo } });
  if (search) conditions.push({ title: { $regex: escapeRegExp(search), $options: 'i' } });
  if (timing) conditions.push(timingFilter(timing, now));

  const direction = order === 'asc' ? 1 : -1;
  // Extra sort keys make the order stable when values tie.
  const sort = {
    dueDate: { dueDate: direction, dueTime: direction, _id: 1 },
    priority: { priorityRank: direction, dueDate: 1, dueTime: 1, _id: 1 },
    createdAt: { createdAt: direction, _id: direction },
  }[sortName];

  return {
    filter: conditions.length > 0 ? { $and: conditions } : {},
    sort,
    page: parsePositiveInt(query.page, 1),
    limit: parsePositiveInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT),
    now,
  };
}
