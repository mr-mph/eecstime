import { Model, Schema, model } from "mongoose";

/**
 * One row per use of a class's "refresh enrollment" button. The datapuller
 * treats recently refreshed classes as high priority for the AWS enrollment
 * worker. Rows expire after a day.
 */
export interface IEnrollmentRefreshClick {
  year: number;
  semester: string;
  sessionId: string;
  subject: string;
  courseNumber: string;
  number: string;
  at: Date;
}

const enrollmentRefreshClickSchema = new Schema<IEnrollmentRefreshClick>({
  year: { type: Number, required: true },
  semester: { type: String, required: true },
  sessionId: { type: String, required: true },
  subject: { type: String, required: true },
  courseNumber: { type: String, required: true },
  number: { type: String, required: true },
  at: { type: Date, required: true, default: Date.now },
});

enrollmentRefreshClickSchema.index({ at: 1 }, { expireAfterSeconds: 24 * 60 * 60 });
enrollmentRefreshClickSchema.index({ year: 1, semester: 1, at: -1 });

export const EnrollmentRefreshClickModel: Model<IEnrollmentRefreshClick> =
  model<IEnrollmentRefreshClick>("enrollment_refresh_clicks", enrollmentRefreshClickSchema);
