import { randomUUID } from "node:crypto";
import { queryRow, queryRows } from "@/lib/storage/postgres";

export const FEEDBACK_TYPES = ["bug", "feature", "other"] as const;
export const FEEDBACK_STATUSES = ["open", "resolved"] as const;

export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export type UserFeedback = {
  content: string;
  createdAt: number;
  id: string;
  resolvedAt: number | null;
  status: FeedbackStatus;
  type: FeedbackType | null;
  userEmail: string;
  userId: string;
  username: string;
};

type FeedbackRow = {
  content: string;
  created_at: number;
  id: string;
  resolved_at: number | null;
  status: FeedbackStatus;
  type: FeedbackType | null;
  user_email: string;
  user_id: string;
  username: string;
};

export async function createUserFeedback(input: {
  content: string;
  type: FeedbackType | null;
  userId: string;
}): Promise<UserFeedback> {
  const row = await queryRow<FeedbackRow>(
    `INSERT INTO user_feedback (id, user_id, content, type)
     SELECT $1, users.id, $2, $3
     FROM users
     WHERE users.id = $4
     RETURNING id, user_id, content, type, status, created_at, resolved_at,
       (SELECT username FROM users WHERE id = user_id) AS username,
       (SELECT email FROM users WHERE id = user_id) AS user_email`,
    [randomUUID(), input.content, input.type, input.userId],
  );
  if (!row) {
    throw new Error("反馈提交失败：用户不存在。");
  }
  return toUserFeedback(row);
}

export async function listUserFeedback(): Promise<UserFeedback[]> {
  const rows = await queryRows<FeedbackRow>(
    `SELECT feedback.id, feedback.user_id, feedback.content, feedback.type, feedback.status,
            feedback.created_at, feedback.resolved_at, users.username, users.email AS user_email
     FROM user_feedback feedback
     INNER JOIN users ON users.id = feedback.user_id
     ORDER BY feedback.created_at DESC, feedback.id DESC`,
  );
  return rows.map(toUserFeedback);
}

export async function deleteUserFeedback(id: string): Promise<boolean> {
  const row = await queryRow<{ id: string }>(
    "DELETE FROM user_feedback WHERE id = $1 RETURNING id",
    [id],
  );
  return Boolean(row);
}

export async function updateUserFeedbackStatus(
  id: string,
  status: FeedbackStatus,
): Promise<UserFeedback | null> {
  const row = await queryRow<FeedbackRow>(
    `UPDATE user_feedback feedback
     SET status = $2,
         resolved_at = CASE WHEN $2 = 'resolved' THEN CURRENT_TIMESTAMP ELSE NULL END
     WHERE feedback.id = $1
     RETURNING id, user_id, content, type, status, created_at, resolved_at,
       (SELECT username FROM users WHERE id = user_id) AS username,
       (SELECT email FROM users WHERE id = user_id) AS user_email`,
    [id, status],
  );
  return row ? toUserFeedback(row) : null;
}

function toUserFeedback(row: FeedbackRow): UserFeedback {
  return {
    content: row.content,
    createdAt: row.created_at,
    id: row.id,
    resolvedAt: row.resolved_at,
    status: row.status,
    type: row.type,
    userEmail: row.user_email,
    userId: row.user_id,
    username: row.username,
  };
}
