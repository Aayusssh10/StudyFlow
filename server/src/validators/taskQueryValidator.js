import mongoose from 'mongoose';
import { PRIORITIES } from '../models/Task.js';
import { AppError } from '../utils/AppError.js';
import { TASK_TIMINGS, taskTimingFilter } from '../utils/taskTiming.js';
import { throwIfErrors } from '../utils/validation.js';
import { createQueryReader, escapeRegExp, parsePositiveInt } from './queryHelpers.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const SORTS = ['schedule', 'priority', 'createdAt'];
const ORDERS = ['asc', 'desc'];
// Planner order: earliest day and time first; High priority first; newest first.
const DEFAULT_ORDER = { schedule: 'asc', priority: 'desc', createdAt: 'desc' };

const idCondition = (value) => (value === 'none' ? null : new mongoose.Types.ObjectId(value));

// Turns ?date=...&completed=...&sort=... into a safe MongoDB filter and sort.
// Every value must be a plain string from a known list/format; anything else is a 400.
export function parseTaskQuery(query) {
  const errors = [];
  const read = createQueryReader(query, errors);

  const now = read.now();
  const date = read.date('date'); // one exact day, e.g. "today's tasks"
  const dateFrom = read.date('dateFrom');
  const dateTo = read.date('dateTo');
  const completed = read.bool('completed');
  const priority = read.oneOf('priority', PRIORITIES);
  const timing = read.oneOf('timing', TASK_TIMINGS);
  const subject = read.reference('subject');
  const assignment = read.reference('assignment');
  const sortName = read.oneOf('sort', SORTS) ?? 'schedule';
  const order = read.oneOf('order', ORDERS) ?? DEFAULT_ORDER[sortName];
  const search = read.search();

  throwIfErrors(errors);
  if (dateFrom && dateTo && dateFrom > dateTo) throw new AppError('"dateFrom" must not be after "dateTo".', 400);

  const conditions = [];
  if (date) conditions.push({ date });
  if (dateFrom) conditions.push({ date: { $gte: dateFrom } });
  if (dateTo) conditions.push({ date: { $lte: dateTo } });
  if (completed !== undefined) conditions.push({ completed });
  if (priority) conditions.push({ priority });
  if (subject) conditions.push({ subject: idCondition(subject) });
  if (assignment) conditions.push({ assignment: idCondition(assignment) });
  if (search) conditions.push({ title: { $regex: escapeRegExp(search), $options: 'i' } });
  if (timing) conditions.push(taskTimingFilter(timing, now));

  const direction = order === 'asc' ? 1 : -1;
  const sort = {
    schedule: { date: direction, timeSort: direction, priorityRank: -1, _id: 1 },
    priority: { priorityRank: direction, date: 1, timeSort: 1, _id: 1 },
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
