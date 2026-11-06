import { env } from '../../config/env.js';

export type EmailTemplate =
  | 'otp-register'
  | 'otp-password-reset'
  | 'otp-account-deletion'
  | 'welcome'
  | 'password-changed'
  | 'report-acknowledgement'
  | 'moderation-hidden'
  | 'moderation-removed'
  | 'appeal-decision'
  | 'account-deletion-scheduled'
  | 'account-deletion-cancelled'
  | 'account-deleted'
  | 'warning-issued'
  | 'ban-applied';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface EmailParams {
  displayName?: string;
  username?: string;
  code?: string;
  expiresInMinutes?: number;
  postTitle?: string;
  appealUrl?: string;
  appealDeadline?: string;
  reason?: string;
  warningCount?: number;
  banDays?: number;
  permanent?: boolean;
  deletionDate?: string;
  decision?: 'accepted' | 'rejected';
  actionUrl?: string;
}

/* --------------------------------------------------------------------------
   Brand
   The palette mirrors the application: warm paper, ink, a single violet accent
   and a mono face for codes and metadata. Everything is inline so the layout
   survives the clients that strip <style> blocks.
-------------------------------------------------------------------------- */

const INK = '#181511';
const MUTED = '#686156';
const SUBTLE = '#8F8779';
const LINE = '#E6E2DC';
const CANVAS = '#F4F2EF';
const SURFACE = '#FFFFFF';
const ACCENT = '#6D4AFF';

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const baseUrl = (): string => env.APP_BASE_URL.replace(/\/$/, '');

const layout = (options: {
  title: string;
  preheader: string;
  body: string;
  footerNote?: string;
}): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${CANVAS};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(
      options.preheader,
    )}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CANVAS};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${SURFACE};border:1px solid ${LINE};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:22px 32px;border-bottom:1px solid ${LINE};">
                <span style="font-family:${SERIF};font-size:19px;letter-spacing:-0.02em;color:${INK};">Buzz <span style="color:${SUBTLE};">&amp;</span> Bugs</span>
                <span style="display:inline-block;width:6px;height:6px;border-radius:999px;background:${ACCENT};margin-left:6px;vertical-align:middle;"></span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                ${options.body}
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;border-top:1px solid ${LINE};">
                <p style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:${SUBTLE};">
                  ${options.footerNote ? `${escapeHtml(options.footerNote)}<br />` : ''}
                  <a href="${baseUrl()}/terms" style="color:${SUBTLE};text-decoration:underline;">Terms</a>
                  &nbsp;·&nbsp;
                  <a href="${baseUrl()}/privacy" style="color:${SUBTLE};text-decoration:underline;">Privacy</a>
                  &nbsp;·&nbsp; Buzz and Bugs
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

const eyebrow = (label: string): string =>
  `<p style="margin:0 0 10px;font-family:${MONO};font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;color:${SUBTLE};">${escapeHtml(
    label,
  )}</p>`;

const heading = (text: string): string =>
  `<h1 style="margin:0 0 18px;font-family:${SERIF};font-size:26px;line-height:1.2;letter-spacing:-0.02em;color:${INK};font-weight:400;">${escapeHtml(
    text,
  )}</h1>`;

const paragraph = (text: string): string =>
  `<p style="margin:0 0 14px;font-family:${SANS};font-size:15px;line-height:1.65;color:${MUTED};">${text}</p>`;

const button = (url: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px;">
    <tr>
      <td style="background:${ACCENT};border-radius:10px;">
        <a href="${escapeHtml(
          url,
        )}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:14px;font-weight:600;color:#FFFFFF;text-decoration:none;">${escapeHtml(
          label,
        )}</a>
      </td>
    </tr>
  </table>`;

const codeBlock = (code: string): string =>
  `<div style="margin:22px 0;padding:18px;border:1px solid ${LINE};border-radius:12px;background:#FAF9F7;text-align:center;">
    <span style="font-family:${MONO};font-size:30px;letter-spacing:0.32em;font-weight:600;color:${INK};">${escapeHtml(
      code,
    )}</span>
  </div>`;

const note = (text: string): string =>
  `<p style="margin:18px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${SUBTLE};">${text}</p>`;

const details = (rows: Array<{ label: string; value: string }>): string =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;border:1px solid ${LINE};border-radius:12px;overflow:hidden;">
    ${rows
      .map(
        (row) =>
          `<tr>
            <td style="padding:11px 16px;border-bottom:1px solid ${LINE};font-family:${MONO};font-size:10.5px;letter-spacing:0.08em;text-transform:uppercase;color:${SUBTLE};">${escapeHtml(
              row.label,
            )}</td>
            <td style="padding:11px 16px;border-bottom:1px solid ${LINE};font-family:${SANS};font-size:13.5px;color:${INK};text-align:right;">${escapeHtml(
              row.value,
            )}</td>
          </tr>`,
      )
      .join('')}
  </table>`;

const greeting = (params: EmailParams): string =>
  params.displayName ? `Hi ${escapeHtml(params.displayName)},` : 'Hi,';

const plain = (parts: string[]): string => parts.filter(Boolean).join('\n\n');

export const renderEmail = (template: EmailTemplate, params: EmailParams): EmailContent => {
  const root = baseUrl();
  const expires = params.expiresInMinutes ?? 10;

  switch (template) {
    case 'otp-register':
      return {
        subject: 'Confirm your email address',
        html: layout({
          title: 'Confirm your email address',
          preheader: 'Your Buzz and Bugs verification code.',
          body:
            eyebrow('Email verification') +
            heading('Confirm your email address') +
            paragraph(greeting(params)) +
            paragraph(
              'Enter this code to finish setting up your Buzz and Bugs account. It expires in ' +
                `${expires} minutes and can be used once.`,
            ) +
            codeBlock(params.code ?? '') +
            note(
              'If you did not start this, no account will be created. You can ignore this email.',
            ),
        }),
        text: plain([
          'Confirm your email address',
          `Your code: ${params.code}`,
          `It expires in ${expires} minutes and can be used once.`,
          'If you did not start this, you can ignore this email.',
        ]),
      };

    case 'otp-password-reset':
      return {
        subject: 'Reset your password',
        html: layout({
          title: 'Reset your password',
          preheader: 'Your Buzz and Bugs password reset code.',
          body:
            eyebrow('Password reset') +
            heading('Reset your password') +
            paragraph(greeting(params)) +
            paragraph(
              `Enter this code to choose a new password. It expires in ${expires} minutes and can be used once.`,
            ) +
            codeBlock(params.code ?? '') +
            note('If you did not request this, nothing has changed and you can ignore this email.'),
        }),
        text: plain([
          'Reset your password',
          `Your code: ${params.code}`,
          `It expires in ${expires} minutes.`,
          'If you did not request this, nothing has changed.',
        ]),
      };

    case 'otp-account-deletion':
      return {
        subject: 'Confirm your account deletion',
        html: layout({
          title: 'Confirm your account deletion',
          preheader: 'Your Buzz and Bugs account deletion code.',
          body:
            eyebrow('Account deletion') +
            heading('Confirm your account deletion') +
            paragraph(greeting(params)) +
            paragraph(
              'Enter this code to schedule the deletion of your Buzz and Bugs account. Once confirmed, you are signed out and the account is deleted after seven days.',
            ) +
            codeBlock(params.code ?? '') +
            note(
              'If you did not request this, change your password now. Nothing has been scheduled yet.',
            ),
        }),
        text: plain([
          'Confirm your account deletion',
          `Your code: ${params.code}`,
          'Confirming schedules deletion after seven days and signs you out.',
          'If you did not request this, change your password now.',
        ]),
      };

    case 'welcome':
      return {
        subject: 'Welcome to Buzz and Bugs',
        html: layout({
          title: 'Welcome to Buzz and Bugs',
          preheader: 'Your account is ready.',
          body:
            eyebrow('Account') +
            heading('Welcome to Buzz and Bugs') +
            paragraph(greeting(params)) +
            paragraph(
              `Your account <strong style="color:${INK};">@${escapeHtml(
                params.username ?? '',
              )}</strong> is ready. The feed is chronological, the sections are yours to arrange, and nothing is ranked against your attention.`,
            ) +
            button(root, 'Open Buzz and Bugs') +
            note('You can change your display name, bio and links from Settings at any time.'),
        }),
        text: plain([
          'Welcome to Buzz and Bugs',
          `Your account @${params.username ?? ''} is ready.`,
          `Open the platform: ${root}`,
        ]),
      };

    case 'password-changed':
      return {
        subject: 'Your password was changed',
        html: layout({
          title: 'Your password was changed',
          preheader: 'All active sessions were signed out.',
          body:
            eyebrow('Security') +
            heading('Your password was changed') +
            paragraph(greeting(params)) +
            paragraph(
              'The password on your Buzz and Bugs account was changed, and every active session was signed out on all devices.',
            ) +
            button(`${root}/forgot-password`, 'Reset your password') +
            note(
              'If you made this change, no action is needed. If you did not, reset your password immediately.',
            ),
        }),
        text: plain([
          'Your password was changed',
          'Every active session was signed out on all devices.',
          `If this was not you: ${root}/forgot-password`,
        ]),
      };

    case 'report-acknowledgement':
      return {
        subject: 'We received your report',
        html: layout({
          title: 'We received your report',
          preheader: 'Your report has been recorded.',
          body:
            eyebrow('Moderation') +
            heading('We received your report') +
            paragraph(greeting(params)) +
            paragraph(
              `Thank you for reporting "${escapeHtml(
                params.postTitle ?? 'a post',
              )}". The post has been checked against the community guidelines and the case is closed.`,
            ) +
            note('We do not share the outcome of individual reports.'),
        }),
        text: plain([
          'We received your report',
          `Reported post: ${params.postTitle ?? 'a post'}`,
          'The case has been reviewed and closed.',
        ]),
      };

    case 'moderation-hidden':
      return {
        subject: 'Your post is hidden pending review',
        html: layout({
          title: 'Your post is hidden pending review',
          preheader: 'You have seven days to appeal.',
          body:
            eyebrow('Moderation') +
            heading('Your post is hidden pending review') +
            paragraph(greeting(params)) +
            paragraph(
              `"${escapeHtml(
                params.postTitle ?? 'Your post',
              )}" was reported and did not pass an automated check against the community guidelines. It is hidden from other people while the case is open.`,
            ) +
            details([
              { label: 'Appeal by', value: params.appealDeadline ?? 'the deadline' },
              { label: 'Outcome if unappealed', value: 'Post deleted, warning added' },
            ]) +
            (params.appealUrl ? button(params.appealUrl, 'Appeal this decision') : '') +
            note('Appeals are read by a person.'),
        }),
        text: plain([
          'Your post is hidden pending review',
          `Post: ${params.postTitle ?? 'Your post'}`,
          `Appeal by ${params.appealDeadline ?? 'the deadline'}: ${params.appealUrl ?? ''}`,
          'If you do not appeal, the post is deleted and a warning is added.',
        ]),
      };

    case 'moderation-removed':
      return {
        subject: 'Your post was removed',
        html: layout({
          title: 'Your post was removed',
          preheader: 'A warning was added to your account.',
          body:
            eyebrow('Moderation') +
            heading('Your post was removed') +
            paragraph(greeting(params)) +
            paragraph(
              `"${escapeHtml(
                params.postTitle ?? 'Your post',
              )}" was removed after review and a warning was added to your account.`,
            ) +
            note(
              'Repeated warnings lead to temporary restrictions and, eventually, a permanent ban.',
            ),
        }),
        text: plain([
          'Your post was removed',
          `Post: ${params.postTitle ?? 'Your post'}`,
          'A warning was added to your account.',
        ]),
      };

    case 'appeal-decision': {
      const accepted = params.decision === 'accepted';
      return {
        subject: accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
        html: layout({
          title: accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
          preheader: accepted
            ? 'Your post is visible again.'
            : 'The post has been removed and a warning added.',
          body:
            eyebrow('Moderation') +
            heading(accepted ? 'Your appeal was accepted' : 'Your appeal was rejected') +
            paragraph(greeting(params)) +
            paragraph(
              accepted
                ? `Your appeal for "${escapeHtml(
                    params.postTitle ?? 'your post',
                  )}" was accepted. The post is visible again and no warning was added.`
                : `Your appeal for "${escapeHtml(
                    params.postTitle ?? 'your post',
                  )}" was rejected. The post has been removed and a warning was added to your account.`,
            ) +
            note('This decision is final.'),
        }),
        text: plain([
          accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
          `Post: ${params.postTitle ?? 'your post'}`,
          accepted
            ? 'The post is visible again and no warning was added.'
            : 'The post was removed and a warning was added.',
        ]),
      };
    }

    case 'account-deletion-scheduled':
      return {
        subject: 'Your account is scheduled for deletion',
        html: layout({
          title: 'Your account is scheduled for deletion',
          preheader: 'Seven days to change your mind.',
          body:
            eyebrow('Account') +
            heading('Your account is scheduled for deletion') +
            paragraph(greeting(params)) +
            paragraph(
              'You asked us to delete your Buzz and Bugs account. It will be permanently deleted on the date below, and you have been signed out.',
            ) +
            details([
              { label: 'Deletion date', value: params.deletionDate ?? 'the scheduled date' },
              { label: 'Grace period', value: '7 days' },
            ]) +
            button(`${root}/settings/account`, 'Cancel deletion') +
            note(
              'Until the deletion date you can sign in and cancel. After it passes, your profile and personal information are removed and your username is released. Your posts and replies remain public under the name "Squashed Bug".',
            ),
        }),
        text: plain([
          'Your account is scheduled for deletion',
          `Deletion date: ${params.deletionDate ?? 'the scheduled date'}`,
          `Cancel before then: ${root}/settings/account`,
          'After deletion your posts remain public under the name "Squashed Bug".',
        ]),
      };

    case 'account-deletion-cancelled':
      return {
        subject: 'Your account deletion was cancelled',
        html: layout({
          title: 'Your account deletion was cancelled',
          preheader: 'Your account is active again.',
          body:
            eyebrow('Account') +
            heading('Your account deletion was cancelled') +
            paragraph(greeting(params)) +
            paragraph(
              'The scheduled deletion of your Buzz and Bugs account has been cancelled and the request has been removed. Your account and content are unchanged.',
            ) +
            button(`${root}/buzz`, 'Return to Buzz') +
            note(
              'If you did not cancel this request, change your password immediately and review your active sessions.',
            ),
        }),
        text: plain([
          'Your account deletion was cancelled',
          'Your account and content are unchanged.',
          `Return to Buzz: ${root}/buzz`,
          'If you did not do this, change your password immediately.',
        ]),
      };

    case 'account-deleted':
      return {
        subject: 'Your Buzz and Bugs account was deleted',
        html: layout({
          title: 'Your account was deleted',
          preheader: 'Your personal information has been removed.',
          body:
            eyebrow('Account') +
            heading('Your account was deleted') +
            paragraph(
              'Your Buzz and Bugs account and personal information have been permanently deleted. Your public posts and replies remain visible under the name "Squashed Bug" and are no longer linked to you.',
            ) +
            note('You can create a new account with this email address at any time.'),
        }),
        text: plain([
          'Your account was deleted',
          'Your personal information has been permanently deleted.',
          'Your posts remain visible under the name "Squashed Bug".',
        ]),
      };

    case 'warning-issued':
      return {
        subject: 'A warning was added to your account',
        html: layout({
          title: 'A warning was added to your account',
          preheader: 'Review the community guidelines.',
          body:
            eyebrow('Account') +
            heading('A warning was added to your account') +
            paragraph(greeting(params)) +
            paragraph(
              `A warning was added for "${escapeHtml(
                params.reason ?? 'a community guideline violation',
              )}". You now have ${params.warningCount ?? 1} active warning(s).`,
            ) +
            details([
              { label: 'Active warnings', value: String(params.warningCount ?? 1) },
              { label: 'Warning lifetime', value: '150 days' },
            ]) +
            note(
              'Two active warnings result in a one-day restriction. Further warnings increase the length.',
            ),
        }),
        text: plain([
          'A warning was added to your account',
          `Reason: ${params.reason ?? 'community guideline violation'}`,
          `Active warnings: ${params.warningCount ?? 1}`,
          'Warnings stay active for 150 days.',
        ]),
      };

    case 'ban-applied':
      return {
        subject: params.permanent
          ? 'Your account is permanently banned'
          : 'Your account was restricted',
        html: layout({
          title: params.permanent
            ? 'Your account is permanently banned'
            : 'Your account was restricted',
          preheader: params.permanent
            ? 'You can still read Buzz.'
            : `A ${params.banDays ?? 1}-day restriction is in effect.`,
          body:
            eyebrow('Account') +
            heading(
              params.permanent
                ? 'Your account is permanently banned'
                : 'Your account was restricted',
            ) +
            paragraph(greeting(params)) +
            paragraph(
              params.permanent
                ? 'Your account has been permanently banned. You can still read Buzz and delete your own posts, but you cannot post, reply or react.'
                : `Your account has been restricted for ${
                    params.banDays ?? 1
                  } day(s). You can still read Buzz and delete your own posts, but you cannot post, reply or react until the restriction ends.`,
            ) +
            note('Repeated violations increase the length of the restriction.'),
        }),
        text: params.permanent
          ? 'Your account has been permanently banned.'
          : `Your account has been restricted for ${params.banDays ?? 1} day(s).`,
      };

    default:
      return {
        subject: 'Buzz and Bugs',
        html: layout({
          title: 'Buzz and Bugs',
          preheader: 'You have a new message.',
          body: heading('Buzz and Bugs') + paragraph('You have a new notification.'),
        }),
        text: 'You have a new notification.',
      };
  }
};
