-- Podcasts become a first-class source kind instead of a Trending section.
-- This is a separate migration on purpose: PostgreSQL cannot use a value added to an
-- enum inside the same transaction that adds it.
ALTER TYPE "SourceKind" ADD VALUE IF NOT EXISTS 'PODCAST';
