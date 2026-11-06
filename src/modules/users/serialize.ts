import type { Prisma, User } from '@prisma/client';
import { DELETED_AUTHOR_LABEL, DELETED_PROFILE_PATH } from '../../config/constants.js';

export const publicUserSelect = {
  id: true,
  username: true,
  displayName: true,
  avatarFileId: true,
  about: true,
  socialLinks: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type PublicUserRecord = Prisma.UserGetPayload<{ select: typeof publicUserSelect }>;

export interface PublicAuthor {
  id: string | null;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string;
  deleted: boolean;
}

export const avatarUrlFor = (fileId: string | null | undefined): string | null =>
  fileId ? `/api/v1/media/avatars/${fileId}` : null;

export const toPublicAuthor = (
  user: Pick<User, 'id' | 'username' | 'displayName' | 'avatarFileId'> | null,
  deleted: boolean,
): PublicAuthor => {
  if (!user || deleted) {
    return {
      id: null,
      username: null,
      displayName: DELETED_AUTHOR_LABEL,
      avatarUrl: null,
      profileUrl: DELETED_PROFILE_PATH,
      deleted: true,
    };
  }
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: avatarUrlFor(user.avatarFileId),
    profileUrl: `/users/${user.username}`,
    deleted: false,
  };
};

export const socialLinkKeys = [
  'instagram',
  'x',
  'linkedin',
  'github',
  'youtube',
  'website',
] as const;

export type SocialLinks = Partial<Record<(typeof socialLinkKeys)[number], string>>;

export const parseSocialLinks = (value: unknown): SocialLinks => {
  if (!value || typeof value !== 'object') return {};
  const input = value as Record<string, unknown>;
  const output: SocialLinks = {};
  for (const key of socialLinkKeys) {
    const entry = input[key];
    if (typeof entry === 'string' && entry.trim().length > 0) {
      output[key] = entry.trim();
    }
  }
  return output;
};

export const profileVisibilityDefaults = {
  about: true,
  socialLinks: true,
  followers: true,
  following: true,
};

export type ProfileVisibility = typeof profileVisibilityDefaults;

export const parseProfileVisibility = (value: unknown): ProfileVisibility => {
  if (!value || typeof value !== 'object') return { ...profileVisibilityDefaults };
  const input = value as Record<string, unknown>;
  return {
    about: typeof input.about === 'boolean' ? input.about : true,
    socialLinks: typeof input.socialLinks === 'boolean' ? input.socialLinks : true,
    followers: typeof input.followers === 'boolean' ? input.followers : true,
    following: typeof input.following === 'boolean' ? input.following : true,
  };
};
