import mongoose from 'mongoose';
import { SESSION_TYPES } from '../models/StudySession.js';
import { AppError } from '../utils/AppError.js';
import { isObjectId, throwIfErrors } from '../utils/validation.js';
import { createQueryReader, escapeRegExp, parsePositiveInt } from './queryHelpers.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SORTS = ['date', 'duration', 'createdAt'];
const ORDERS = ['asc', 'desc'];
// Newest session first, longest first, newest added first.
const DEFAULT_ORDER = { date: 'desc', duration: 'desc', createdAt: 'desc' };

// The filters shared by the list and the summary: ?date= ?dateFrom= ?dateTo= ?subject= ?assignment= ?type= ?q=
// Every value must be a plain string from a known list/format; anything else is a 400.
function readFilters(query, errors) {
  const read = createQueryReader(query, errors);

  const date = read.date('date');
  const dateFrom = read.date('dateFrom');
  const dateTo = read.date('dateTo');
  const subject = read.text('subject');
  if (subject !== undefined && !isObjectId(subject)) errors.push({ field: 'subject', message: '"subject" must be a subject id.' });
  const assignment = read.reference('assignment');
  const type = read.oneOf('type', SESSION_TYPES);
  const search = read.search();

  return { read, date, dateFrom, dateTo, subject, assignment, type, search };
}

function buildConditions({ date, dateFrom, dateTo, subject, assignment, type, search }) {
  const conditions = [];
  if (date) conditions.push({ date });
  if (dateFrom) conditions.push({ date: { $gte: dateFrom } });
  if (dateTo) conditions.push({ date: { $lte: dateTo } });
  if (subject && isObjectId(subject)) conditions.push({ subject: new mongoose.Types.ObjectId(subject) });
  if (assignment === 'none') conditions.push({ assignment: null });
  else if (assignment) conditions.push({ assignment: new mongoose.Types.ObjectId(assignment) });
  if (type) conditions.push({ type });
  if (search) conditions.push({ notes: { $regex: escapeRegExp(search), $options: 'i' } });
  return conditions.length > 0 ? { $and: conditions } : {};
}

function checkRange({ dateFrom, dateTo }) {
  if (dateFrom && dateTo && dateFrom > dateTo) throw new AppError('"dateFrom" must not be after "dateTo".', 400);
}

export function parseSessionQuery(query) {
  const errors = [];
  const filters = readFilters(query, errors);
  const sortName = filters.read.oneOf('sort', SORTS) ?? 'date';
  const order = filters.read.oneOf('order', ORDERS) ?? DEFAULT_ORDER[sortName];
  throwIfErrors(errors);
  checkRange(filters);

  const direction = order === 'asc' ? 1 : -1;
  // Extra sort keys make the order stable when values tie.
  const sort = {
    date: { date: direction, startTime: direction, _id: direction },
    duration: { durationMinutes: direction, date: -1, _id: 1 },
    createdAt: { createdAt: direction, _id: direction },
  }[sortName];

  return {
    filter: buildConditions(filters),
    sort,
    page: parsePositiveInt(query.page, 1),
    limit: parsePositiveInt(query.limit, DEFAULT_LIMIT, MAX_LIMIT),
  };
}

export function parseSummaryQuery(query) {
  const errors = [];
  const filters = readFilters(query, errors);
  throwIfErrors(errors);
  checkRange(filters);
  return { filter: buildConditions(filters) };
}
