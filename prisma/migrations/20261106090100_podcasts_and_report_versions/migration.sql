-- 1. Post revisions ------------------------------------------------------------
-- Reports must be allowed again after an author edits a previously reviewed post.
ALTER TABLE "Post" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Report" ADD COLUMN "postVersion" INTEGER NOT NULL DEFAULT 0;
DROP INDEX "Report_postId_reporterId_key";
CREATE UNIQUE INDEX "Report_postId_reporterId_postVersion_key"
  ON "Report" ("postId", "reporterId", "postVersion");

-- 2. Podcasts leave Trending ---------------------------------------------------
-- Each podcast feed becomes its own section, derived from the existing source key
-- ("podcast-changelog" -> "changelog"). No rows are dropped.
UPDATE "ExternalSource"
SET "kind" = 'PODCAST',
    "section" = substring("key" from 9)
WHERE "key" LIKE 'podcast-%';

UPDATE "ExternalItem"
SET "kind" = 'PODCAST',
    "section" = substring("sourceKey" from 9)
WHERE "sourceKey" LIKE 'podcast-%';

-- 3. Trending section order no longer contains podcasts ------------------------
ALTER TABLE "UserSettings"
  ALTER COLUMN "trendingOrder"
  SET DEFAULT ARRAY['youtube', 'repositories', 'models', 'datasets', 'papers']::text[];

UPDATE "UserSettings"
SET "trendingOrder" = array_remove("trendingOrder", 'podcasts')
WHERE 'podcasts' = ANY ("trendingOrder");
