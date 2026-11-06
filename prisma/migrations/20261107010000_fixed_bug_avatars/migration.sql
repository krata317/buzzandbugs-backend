-- Profile pictures are no longer user-supplied. Detach every reference to an uploaded avatar,
-- then delete those file records permanently. Generated bug avatars are kept.

UPDATE "User" AS u
SET "avatarFileId" = NULL
FROM "FileObject" AS f
WHERE u."avatarFileId" = f."id"
  AND f."purpose" = 'AVATAR'::"FilePurpose"
  AND f."key" NOT LIKE 'avatars/generated/%';

DELETE FROM "FileObject"
WHERE "purpose" = 'AVATAR'::"FilePurpose"
  AND "key" NOT LIKE 'avatars/generated/%';
