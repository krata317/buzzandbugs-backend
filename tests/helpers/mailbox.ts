import type { Transporter } from 'nodemailer';

export interface CapturedMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const mailbox: CapturedMessage[] = [];

export const resetMailbox = (): void => {
  mailbox.length = 0;
};

export const testTransporter = {
  sendMail: async (message: {
    to?: string | { address: string }[];
    subject?: string;
    text?: string;
    html?: string;
  }) => {
    const to = Array.isArray(message.to)
      ? message.to.map((entry) => (typeof entry === 'string' ? entry : entry.address)).join(',')
      : typeof message.to === 'string'
        ? message.to
        : '';

    mailbox.push({
      to,
      subject: message.subject ?? '',
      text: message.text ?? '',
      html: message.html ?? '',
    });
    return { messageId: `test-${mailbox.length}` };
  },
} as unknown as Transporter;

export const messagesFor = (email: string): CapturedMessage[] =>
  mailbox.filter((message) => message.to.toLowerCase() === email.toLowerCase());

export const lastMessageFor = (email: string): CapturedMessage | undefined => {
  const messages = messagesFor(email);
  return messages[messages.length - 1];
};

export const extractOtp = (email: string): string => {
  const message = lastMessageFor(email);
  if (!message) throw new Error(`No email was sent to ${email}`);
  const match = message.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`No OTP found in the email sent to ${email}`);
  return match[1];
};

export const extractTokenFromLink = (email: string, pathFragment: string): string => {
  const message = lastMessageFor(email);
  if (!message) throw new Error(`No email was sent to ${email}`);
  const pattern = new RegExp(`${pathFragment}/([A-Za-z0-9_-]+)`);
  const match = message.text.match(pattern) ?? message.html.match(pattern);
  if (!match?.[1]) throw new Error(`No link containing ${pathFragment} found for ${email}`);
  return match[1];
};
