import mongoose from 'mongoose';
import { ALL_REFERENCES } from './subjectReferences.js';

// READ-ONLY check: finds records that point at a subject or assignment that no longer exists.
// The app itself cannot create such records (see utils/transaction.js), but MongoDB has no built-in
// "foreign keys", so edits made outside the app (Compass, shell scripts, restored backups) could.
// This is a detector, not a guarantee. It never changes any data.
export async function findDanglingReferences() {
  const dangling = [];

  for (const reference of ALL_REFERENCES) {
    const rows = await mongoose.connection
      .collection(reference.collection)
      .aggregate([
        { $match: { [reference.field]: { $ne: null } } },
        { $lookup: { from: reference.target, localField: reference.field, foreignField: '_id', as: 'targetFound' } },
        { $match: { targetFound: { $size: 0 } } },
        { $project: { [reference.field]: 1 } },
      ])
      .toArray();

    for (const row of rows) {
      dangling.push({
        collection: reference.collection,
        id: row._id.toString(),
        field: reference.field,
        missing: row[reference.field].toString(),
      });
    }
  }
  return dangling;
}
