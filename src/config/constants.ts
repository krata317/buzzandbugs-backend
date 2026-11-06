export const API_PREFIX = '/api/v1';

export const SESSION_COOKIE = 'bnb_session';
export const CSRF_COOKIE = 'bnb_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const ADMIN_SESSION_COOKIE = 'bnb_admin_session';

export const SESSION_TTL_DAYS = 90;
export const ADMIN_SESSION_TTL_HOURS = 12;
export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_LIMIT = 10;
export const OTP_RESEND_WINDOW_MINUTES = 30;
export const LOGIN_FAIL_LIMIT = 5;
export const LOGIN_FAIL_WINDOW_MINUTES = 30;
export const LOGIN_COOLDOWN_MINUTES = 60;
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const REGISTRATION_TOKEN_TTL_MINUTES = 30;
export const APPEAL_WINDOW_DAYS = 7;
export const ACCOUNT_DELETION_GRACE_DAYS = 7;
export const WARNING_WINDOW_DAYS = 150;
export const NOTIFICATION_TTL_DAYS = 7;
export const POST_RATE_LIMIT = 5;
export const POST_RATE_WINDOW_MINUTES = 60;
export const MAX_REPLIES_PER_ROOT = 10;
export const NEWS_ITEMS_PER_SECTION = 40;
export const EVENT_ITEMS_PER_SECTION = 25;
export const TRENDING_ITEMS_PER_SECTION = 25;

export const BAN_SCHEDULE_DAYS: Record<number, number | 'permanent'> = {
  1: 0,
  2: 1,
  3: 3,
  4: 7,
  5: 14,
  6: 30,
  7: 60,
  8: 'permanent',
};

export const DELETED_AUTHOR_LABEL = 'Squashed Bug';
export const DELETED_PROFILE_PATH = '/users/deleted';

export const NEWS_SECTIONS = ['trending', 'ai', 'security', 'leaders', 'india'] as const;
export const EVENT_SECTIONS = ['hackathons', 'contests', 'ctf'] as const;
export const TRENDING_SECTIONS = [
  'youtube',
  'repositories',
  'models',
  'datasets',
  'papers',
  'podcasts',
] as const;

export const ALLOWED_AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_AVATAR_INPUT_BYTES = 2 * 1024 * 1024;
export const MAX_AVATAR_INPUT_DIMENSION = 2048;
export const AVATAR_OUTPUT_DIMENSION = 512;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

export type NewsSection = (typeof NEWS_SECTIONS)[number];
export type EventSection = (typeof EVENT_SECTIONS)[number];
export type TrendingSection = (typeof TRENDING_SECTIONS)[number];
