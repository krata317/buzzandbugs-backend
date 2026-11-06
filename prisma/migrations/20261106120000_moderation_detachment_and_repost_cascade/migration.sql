-- 1. A repost is a derivative of the post it quotes -------------------------
-- Permanently removing a post (moderation) now removes its reposts with it, so no post can
-- point at content that no longer exists. Author deletion is a soft delete and never triggers
-- this path, so ordinary threads keep their reposted quote.
ALTER TABLE "Post" DROP CONSTRAINT "Post_repostOfId_fkey";
ALTER TABLE "Post" ADD CONSTRAINT "Post_repostOfId_fkey"
  FOREIGN KEY ("repostOfId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Moderation records outlive the content they describe ---------------------
-- A case keeps a snapshot of the title and detaches from the post when the post is deleted,
-- so the 30-day moderation history survives permanent removal.
ALTER TABLE "ModerationCase" ADD COLUMN "postTitle" TEXT;

UPDATE "ModerationCase" AS c
SET "postTitle" = p."title"
FROM "Post" AS p
WHERE p."id" = c."postId";

ALTER TABLE "ModerationCase" ALTER COLUMN "postId" DROP NOT NULL;
ALTER TABLE "ModerationCase" DROP CONSTRAINT "ModerationCase_postId_fkey";
ALTER TABLE "ModerationCase" ADD CONSTRAINT "ModerationCase_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE SET NULL ON UPDATE CASCADE;
