import { env } from '../../config/env.js';

export type EmailTemplate =
  | 'otp-register'
  | 'otp-password-reset'
  | 'welcome'
  | 'password-changed'
  | 'report-acknowledgement'
  | 'moderation-hidden'
  | 'moderation-removed'
  | 'appeal-decision'
  | 'account-deletion-scheduled'
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

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const layout = (title: string, bodyHtml: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e4e4e7;">
      <tr>
        <td style="padding:20px 28px;border-bottom:1px solid #e4e4e7;">
          <span style="font-size:18px;font-weight:700;letter-spacing:-0.02em;">Buzz and Bugs</span>
        </td>
      </tr>
      <tr>
        <td style="padding:28px;">
          <h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;">${escapeHtml(title)}</h1>
          ${bodyHtml}
        </td>
      </tr>
      <tr>
        <td style="padding:16px 28px;border-top:1px solid #e4e4e7;color:#71717a;font-size:12px;">
          Sent by Buzz and Bugs. This mailbox is not monitored.
        </td>
      </tr>
    </table>
  </body>
</html>`;

const paragraph = (text: string): string =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3f3f46;">${text}</p>`;

const button = (url: string, label: string): string =>
  `<p style="margin:22px 0;"><a href="${escapeHtml(url)}" style="display:inline-block;background:#6d28d9;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-size:14px;font-weight:600;">${escapeHtml(label)}</a></p>`;

const codeBlock = (code: string): string =>
  `<p style="margin:20px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;letter-spacing:8px;font-weight:700;background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:14px 18px;text-align:center;">${escapeHtml(code)}</p>`;

const greeting = (params: EmailParams): string =>
  params.displayName ? `Hi ${escapeHtml(params.displayName)},` : 'Hi,';

export const renderEmail = (template: EmailTemplate, params: EmailParams): EmailContent => {
  const baseUrl = env.APP_BASE_URL.replace(/\/$/, '');

  switch (template) {
    case 'otp-register':
      return {
        subject: 'Your Buzz and Bugs verification code',
        html: layout(
          'Verify your email',
          paragraph(greeting(params)) +
            paragraph(
              `Use the code below to finish creating your Buzz and Bugs account. It expires in ${params.expiresInMinutes ?? 10} minutes.`,
            ) +
            codeBlock(params.code ?? '') +
            paragraph('If you did not try to create an account, you can ignore this email.'),
        ),
        text: `Verify your email\n\nUse this code to finish creating your Buzz and Bugs account: ${params.code}\n\nIt expires in ${params.expiresInMinutes ?? 10} minutes.\nIf you did not try to create an account, ignore this email.`,
      };

    case 'otp-password-reset':
      return {
        subject: 'Your Buzz and Bugs password reset code',
        html: layout(
          'Reset your password',
          paragraph(greeting(params)) +
            paragraph(
              `Use the code below to reset your password. It expires in ${params.expiresInMinutes ?? 10} minutes.`,
            ) +
            codeBlock(params.code ?? '') +
            paragraph(
              'If you did not request a password reset, ignore this email. Your password will not change.',
            ),
        ),
        text: `Reset your password\n\nUse this code to reset your password: ${params.code}\n\nIt expires in ${params.expiresInMinutes ?? 10} minutes.\nIf you did not request this, ignore this email.`,
      };

    case 'welcome':
      return {
        subject: 'Welcome to Buzz and Bugs',
        html: layout(
          'Your account is ready',
          paragraph(greeting(params)) +
            paragraph(
              `Your account <strong>@${escapeHtml(params.username ?? '')}</strong> is confirmed. You can post, reply and follow other developers right away.`,
            ) +
            button(baseUrl, 'Open Buzz and Bugs'),
        ),
        text: `Your account @${params.username ?? ''} is confirmed.\n\nOpen Buzz and Bugs: ${baseUrl}`,
      };

    case 'password-changed':
      return {
        subject: 'Your Buzz and Bugs password was changed',
        html: layout(
          'Password changed',
          paragraph(greeting(params)) +
            paragraph(
              'Your password was changed and every active session was signed out, on all devices.',
            ) +
            paragraph(
              'If this was not you, reset your password immediately using the "Forgot password" flow.',
            ),
        ),
        text: `Your Buzz and Bugs password was changed and all active sessions were signed out.\n\nIf this was not you, reset your password immediately.`,
      };

    case 'report-acknowledgement':
      return {
        subject: 'We received your report',
        html: layout(
          'Report received',
          paragraph(greeting(params)) +
            paragraph(
              `Thanks for reporting "${escapeHtml(params.postTitle ?? 'a post')}". A moderator will review it.`,
            ) +
            paragraph('We do not share the outcome of individual reports.'),
        ),
        text: `Thanks for reporting "${params.postTitle ?? 'a post'}". A moderator will review it.`,
      };

    case 'moderation-hidden':
      return {
        subject: 'Your post was hidden pending review',
        html: layout(
          'Your post was hidden',
          paragraph(greeting(params)) +
            paragraph(
              `"${escapeHtml(params.postTitle ?? 'Your post')}" was reported and our automated check flagged it. The post is hidden from other people while the case is open.`,
            ) +
            paragraph(
              `You can appeal until ${escapeHtml(params.appealDeadline ?? 'the deadline')}. If you do not appeal, the post will be deleted and a warning will be added to your account.`,
            ) +
            (params.appealUrl ? button(params.appealUrl, 'Appeal this decision') : ''),
        ),
        text: `"${params.postTitle ?? 'Your post'}" was hidden after a report and an automated check.\n\nAppeal until ${params.appealDeadline ?? 'the deadline'}: ${params.appealUrl ?? ''}\n\nIf you do not appeal, the post will be deleted and a warning added.`,
      };

    case 'moderation-removed':
      return {
        subject: 'Your post was removed',
        html: layout(
          'Post removed',
          paragraph(greeting(params)) +
            paragraph(
              `"${escapeHtml(params.postTitle ?? 'Your post')}" was removed after review. A warning has been added to your account.`,
            ) +
            paragraph('Repeated warnings lead to temporary bans and, eventually, a permanent ban.'),
        ),
        text: `"${params.postTitle ?? 'Your post'}" was removed after review and a warning was added to your account.`,
      };

    case 'appeal-decision': {
      const accepted = params.decision === 'accepted';
      return {
        subject: accepted ? 'Your appeal was accepted' : 'Your appeal was rejected',
        html: layout(
          accepted ? 'Appeal accepted' : 'Appeal rejected',
          paragraph(greeting(params)) +
            paragraph(
              accepted
                ? `Your appeal for "${escapeHtml(params.postTitle ?? 'your post')}" was accepted. The post is visible again and no warning was added.`
                : `Your appeal for "${escapeHtml(params.postTitle ?? 'your post')}" was rejected. The post has been deleted and a warning was added to your account.`,
            ) +
            paragraph('This decision is final.'),
        ),
        text: accepted
          ? `Your appeal for "${params.postTitle ?? 'your post'}" was accepted. The post is visible again.`
          : `Your appeal for "${params.postTitle ?? 'your post'}" was rejected. The post was deleted and a warning was added.`,
      };
    }

    case 'account-deletion-scheduled':
      return {
        subject: 'Your Buzz and Bugs account is scheduled for deletion',
        html: layout(
          'Account deletion scheduled',
          paragraph(greeting(params)) +
            paragraph(
              `Your account will be permanently deleted on ${escapeHtml(params.deletionDate ?? 'the scheduled date')}.`,
            ) +
            paragraph(
              'Until then you can sign in and cancel the deletion. After that date your profile and personal information are removed and your username is released. Your posts and replies stay public but are shown as "Squashed Bug".',
            ) +
            button(`${baseUrl}/settings/account`, 'Cancel deletion'),
        ),
        text: `Your account will be permanently deleted on ${params.deletionDate ?? 'the scheduled date'}.\n\nSign in before then to cancel: ${baseUrl}/settings/account`,
      };

    case 'account-deleted':
      return {
        subject: 'Your Buzz and Bugs account was deleted',
        html: layout(
          'Account deleted',
          paragraph('Your account and personal information have been permanently deleted.') +
            paragraph(
              'Your public posts and replies remain visible under the name "Squashed Bug" and are no longer linked to you.',
            ),
        ),
        text: 'Your account and personal information have been permanently deleted.',
      };

    case 'warning-issued':
      return {
        subject: 'A warning was added to your Buzz and Bugs account',
        html: layout(
          'Warning added',
          paragraph(greeting(params)) +
            paragraph(
              `A warning was added to your account for "${escapeHtml(params.reason ?? 'a community guideline violation')}". You now have ${params.warningCount ?? 1} active warning(s).`,
            ) +
            paragraph(
              'Warnings stay active for 150 days. Two active warnings result in a one-day ban, and further warnings increase the ban length.',
            ),
        ),
        text: `A warning was added to your account. Active warnings: ${params.warningCount ?? 1}. Warnings stay active for 150 days.`,
      };

    case 'ban-applied':
      return {
        subject: params.permanent
          ? 'Your Buzz and Bugs account is permanently banned'
          : 'Your Buzz and Bugs account was banned',
        html: layout(
          params.permanent ? 'Permanent ban' : 'Account banned',
          paragraph(greeting(params)) +
            paragraph(
              params.permanent
                ? 'Your account has been permanently banned. You can still read Buzz and delete your own posts, but you cannot post, reply or react.'
                : `Your account has been banned for ${params.banDays ?? 1} day(s). You can still read Buzz and delete your own posts, but you cannot post, reply or react until the ban ends.`,
            ),
        ),
        text: params.permanent
          ? 'Your account has been permanently banned.'
          : `Your account has been banned for ${params.banDays ?? 1} day(s).`,
      };

    default:
      return {
        subject: 'Buzz and Bugs',
        html: layout('Buzz and Bugs', paragraph('You have a new notification.')),
        text: 'You have a new notification.',
      };
  }
};
