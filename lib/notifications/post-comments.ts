import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// Milestone R6 (docs/BROHDA_2_0_MILESTONE_MAP.md, Post Conversation).
// Mirrors lib/notifications/create.ts's own createCommentReplyNotification
// exactly (self-notification suppressed, a short preview, a real link to
// the canonical Post) — kept in its own file rather than appended to that
// shared, pool-notification-heavy module, consistent with this milestone's
// own domain (lib/post-comments/, lib/communities/, lib/posts/) staying
// decoupled from the legacy pool product's notification code.
//
// Deliberately the ONLY Post-conversation notification (§21): no generic
// "someone commented on a Post you participated in" event exists — a
// direct reply is the one clearly interpersonally-relevant case this
// milestone implements.
export async function createPostCommentReplyNotification({
  postId,
  parentCommentUserId,
  replierUserId,
  replierDisplayName,
  replyBody,
}: {
  postId: string;
  parentCommentUserId: string;
  replierUserId: string;
  replierDisplayName: string;
  replyBody: string;
}) {
  if (parentCommentUserId === replierUserId) return;

  const admin = createAdminClient();
  const preview = replyBody.length > 140 ? `${replyBody.slice(0, 140)}…` : replyBody;

  await admin.from("notifications").insert({
    user_id: parentCommentUserId,
    type: "POST_COMMENT_REPLY",
    title: "New reply",
    body: `${replierDisplayName} replied: "${preview}"`,
    post_id: postId,
  });
}
