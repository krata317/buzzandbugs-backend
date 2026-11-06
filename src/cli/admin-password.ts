import { parseArgs } from 'node:util';
import { prisma } from '../lib/prisma.js';
import { hashPassword, verifyPassword } from '../modules/auth/password.js';
import { writeAuditLog } from '../modules/admin/audit.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    old: { type: 'string' },
    new: { type: 'string' },
  },
  allowPositionals: false,
});

const main = async (): Promise<void> => {
  const username = (values.username ?? process.env.ADMIN_BOOTSTRAP_USERNAME ?? '').trim();
  const oldPassword = values.old ?? process.env.ADMIN_OLD_PASSWORD ?? '';
  const newPassword = values.new ?? process.env.ADMIN_NEW_PASSWORD ?? '';

  const admin = username
    ? await prisma.adminUser.findUnique({ where: { username } })
    : await prisma.adminUser.findFirst();

  if (!admin) {
    process.stderr.write('No admin account found. Run "npm run admin:create" first.\n');
    process.exitCode = 1;
    return;
  }

  if (!oldPassword || !newPassword) {
    process.stderr.write(
      'Usage: npm run admin:password -- --old <current> --new <new>\n' +
        '(or set ADMIN_OLD_PASSWORD and ADMIN_NEW_PASSWORD)\n',
    );
    process.exitCode = 1;
    return;
  }

  if (newPassword.length < 12) {
    process.stderr.write('The new admin password must be at least 12 characters.\n');
    process.exitCode = 1;
    return;
  }

  const ok = await verifyPassword(admin.passwordHash, oldPassword);
  if (!ok) {
    process.stderr.write('The current admin password is incorrect.\n');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } }),
    prisma.adminSession.deleteMany({ where: { adminId: admin.id } }),
  ]);

  await writeAuditLog({
    actorType: 'SYSTEM',
    action: 'admin.password_changed',
    targetType: 'AdminUser',
    targetId: admin.id,
  });

  process.stdout.write(
    `Admin password updated for ${admin.username}. All admin sessions were revoked.\n`,
  );
};

main()
  .catch((error: unknown) => {
    process.stderr.write(`Admin password change failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
