import { afterAll, beforeAll } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { setTransporterForTests } from '../src/modules/email/service.js';
import { mailbox, resetMailbox, testTransporter } from './helpers/mailbox.js';

beforeAll(() => {
  setTransporterForTests(testTransporter);
});

afterAll(async () => {
  setTransporterForTests(null);
  await prisma.$disconnect();
});

export const resetDatabase = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(`
    DO $$
    DECLARE
      target record;
    BEGIN
      FOR target IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
      LOOP
        EXECUTE format('TRUNCATE TABLE %I CASCADE', target.tablename);
      END LOOP;
    END $$;
  `);
  resetMailbox();
};

export { mailbox };
