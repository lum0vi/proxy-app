import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transporter = config.SMTP_HOST
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    })
  : null;

export async function sendMail(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  if (!transporter) {
    throw new Error('SMTP_NOT_CONFIGURED');
  }
  await transporter.sendMail({ from: config.SMTP_FROM, ...input });
}
