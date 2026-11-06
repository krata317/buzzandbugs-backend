import argon2 from 'argon2';

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export const hashPassword = async (password: string): Promise<string> =>
  argon2.hash(password, ARGON2_OPTIONS);

export const verifyPassword = async (hash: string, password: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
};

let dummyHashPromise: Promise<string> | null = null;

/**
 * A real hash of a throwaway value, used to keep login timing similar when the account does
 * not exist. This makes username/email enumeration by response timing harder.
 */
export const dummyPasswordHash = (): Promise<string> => {
  dummyHashPromise ??= argon2.hash('timing-equalisation-placeholder', ARGON2_OPTIONS);
  return dummyHashPromise;
};
