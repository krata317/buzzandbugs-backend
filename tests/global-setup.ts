import { execFileSync } from 'node:child_process';
import { config as loadDotenv } from 'dotenv';

export default function globalSetup(): void {
  loadDotenv();

  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error('DATABASE_URL is required to run the test suite (set it in backend/.env)');
  }

  const derived = new URL(base);
  derived.pathname = '/bnb_test';
  const configured = process.env.TEST_DATABASE_URL?.trim();
  const databaseUrl = configured && configured.length > 0 ? configured : derived.toString();

  if (!databaseUrl.includes('_test')) {
    throw new Error(
      'Refusing to run tests: the test database name must end with _test so data is never lost',
    );
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    shell: process.platform === 'win32',
  });
}
