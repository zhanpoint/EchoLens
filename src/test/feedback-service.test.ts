import { describe, expect, it } from "vitest";
import { insertUser } from "@/lib/auth/db";
import { deleteUserFeedback } from "@/lib/feedback/service";
import { execute } from "@/lib/storage/postgres";
import { setupPostgresTestDb } from "@/test/postgres-test-utils";

setupPostgresTestDb();

describe("feedback deletion", () => {
  it("reports whether a feedback record was actually deleted", async () => {
    await insertUser({ id: "feedback-user", email: "feedback@example.com", username: "reader", passwordHash: "hash", termsAcceptedAt: Date.now() });
    await execute("INSERT INTO user_feedback (id, user_id, content, type) VALUES ($1, $2, $3, $4)", ["feedback-1", "feedback-user", "反馈内容", "bug"]);
    await expect(deleteUserFeedback("missing")).resolves.toBe(false);
    await expect(deleteUserFeedback("feedback-1")).resolves.toBe(true);
    await expect(deleteUserFeedback("feedback-1")).resolves.toBe(false);
  });
});
