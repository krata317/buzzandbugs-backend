import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { prisma } from '../lib/prisma.js';
import { hashPassword } from '../modules/auth/password.js';
import { writeAuditLog } from '../modules/admin/audit.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' },
    password: { type: 'string' },
  },
  allowPositionals: false,
});

const main = async (): Promise<void> => {
  const username = (values.username ?? process.env.ADMIN_BOOTSTRAP_USERNAME ?? '').trim();
  const providedPassword = values.password ?? process.env.ADMIN_BOOTSTRAP_PASSWORD ?? '';

  if (!username) {
    process.stderr.write(
      'Missing admin username.\nUsage: npm run admin:create -- --username <name> [--password <password>]\n',
    );
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.adminUser.findFirst();
  if (existing) {
    process.stderr.write(
      'An admin account already exists. Use "npm run admin:password" to change its password.\n',
    );
    process.exitCode = 1;
    return;
  }

  const generated = providedPassword.length === 0;
  const password = generated ? randomBytes(18).toString('base64url') : providedPassword;

  if (password.length < 12) {
    process.stderr.write('The admin password must be at least 12 characters.\n');
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  const admin = await prisma.adminUser.create({
    data: { username, passwordHash },
    select: { id: true, username: true, createdAt: true },
  });

  await writeAuditLog({
    actorType: 'SYSTEM',
    action: 'admin.bootstrap',
    targetType: 'AdminUser',
    targetId: admin.id,
    metadata: { username },
  });

  process.stdout.write(`Admin created: ${admin.username}\n`);
  if (generated) {
    process.stdout.write(
      `Generated password (store it now, it will not be shown again): ${password}\n`,
    );
  }
  process.stdout.write('Password changes: npm run admin:password -- --old <old> --new <new>\n');
};

main()
  .catch((error: unknown) => {
    process.stderr.write(`Admin bootstrap failed: ${String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
