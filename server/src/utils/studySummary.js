import StudySession from '../models/StudySession.js';

// Study-time totals, CALCULATED from the stored sessions that match `filter` (a MongoDB filter built by the
// query validators). Used by the study-sessions summary endpoint AND the dashboard, so the two can never
// disagree: "minutes" are always sums of durationMinutes.
export async function summarizeSessions(filter = {}) {
  const [result] = await StudySession.aggregate([
    { $match: filter },
    {
      $facet: {
        totals: [{ $group: { _id: null, minutes: { $sum: '$durationMinutes' }, sessions: { $sum: 1 } } }],
        byDay: [
          { $group: { _id: '$date', minutes: { $sum: '$durationMinutes' }, sessions: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        bySubject: [
          { $group: { _id: '$subject', minutes: { $sum: '$durationMinutes' }, sessions: { $sum: 1 } } },
          { $sort: { minutes: -1, _id: 1 } },
          { $lookup: { from: 'subjects', localField: '_id', foreignField: '_id', as: 'subject' } },
        ],
      },
    },
  ]);

  const totals = result.totals[0] ?? { minutes: 0, sessions: 0 };
  return {
    totalMinutes: totals.minutes,
    sessionCount: totals.sessions,
    byDay: result.byDay.map((row) => ({ date: row._id, minutes: row.minutes, sessions: row.sessions })),
    bySubject: result.bySubject.map((row) => ({
      subjectId: row._id.toString(),
      // null when the subject is missing (damage made outside the app): the minutes still count
      subject: row.subject[0] ? { id: row._id.toString(), name: row.subject[0].name, color: row.subject[0].color } : null,
      minutes: row.minutes,
      sessions: row.sessions,
    })),
  };
}
