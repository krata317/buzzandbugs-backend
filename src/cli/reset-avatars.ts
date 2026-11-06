import { prisma } from '../lib/prisma.js';
import { getStorage } from '../modules/storage/index.js';
import { createBugAvatar } from '../modules/auth/service.js';

/**
 * One-off maintenance task for the move to fixed bug avatars.
 *
 * 1. Every avatar file that was uploaded by a person is deleted from the database and from
 *    storage. Generated bug avatars (`avatars/generated/…`) are kept.
 * 2. Every account without a usable avatar is assigned a bug avatar through the same path
 *    registration uses, so the illustration matches the username deterministically.
 * 3. Avatar files left in storage with no database row are removed.
 *
 * Safe to run more than once.
 */

const GENERATED_PREFIX = 'avatars/generated/';

const main = async (): Promise<void> => {
  const storage = getStorage();

  const custom = await prisma.fileObject.findMany({
    where: { purpose: 'AVATAR', key: { not: { startsWith: GENERATED_PREFIX } } },
    select: { id: true, key: true },
  });

  if (custom.length > 0) {
    await prisma.user.updateMany({
      where: { avatarFileId: { in: custom.map((file) => file.id) } },
      data: { avatarFileId: null },
    });
    await prisma.fileObject.deleteMany({ where: { id: { in: custom.map((file) => file.id) } } });
    for (const file of custom) {
      await storage.delete(file.key).catch(() => undefined);
    }
  }

  const users = await prisma.user.findMany({
    select: { id: true, username: true, avatarFileId: true },
    orderBy: { createdAt: 'asc' },
  });

  const known = new Set(
    (
      await prisma.fileObject.findMany({
        where: { purpose: 'AVATAR' },
        select: { id: true },
      })
    ).map((file) => file.id),
  );

  let assigned = 0;
  for (const user of users) {
    if (user.avatarFileId && known.has(user.avatarFileId)) continue;

    const fileId = await createBugAvatar(user.username);
    if (!fileId) continue;

    await prisma.user.update({ where: { id: user.id }, data: { avatarFileId: fileId } });
    await prisma.fileObject
      .update({ where: { id: fileId }, data: { ownerId: user.id } })
      .catch(() => undefined);
    known.add(fileId);
    assigned += 1;
  }

  const stored = await storage.list('avatars');
  const referenced = new Set(
    (
      await prisma.fileObject.findMany({
        where: { purpose: 'AVATAR' },
        select: { key: true },
      })
    ).map((file) => file.key),
  );
  const orphans = stored.filter((key) => !referenced.has(key));
  for (const key of orphans) {
    await storage.delete(key).catch(() => undefined);
  }

  process.stdout.write(
    [
      `Uploaded avatars removed: ${custom.length}`,
      `Bug avatars assigned: ${assigned}`,
      `Orphaned files removed: ${orphans.length}`,
      '',
    ].join('\n'),
  );
};

main()
  .catch((error: unknown) => {
    process.stderr.write(`Avatar reset failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
