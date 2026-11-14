import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transporter = config.SMTP_HOST
  ? nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    })
  : null;

export async function sendMail(input: { to: string; subject: string; text: string; html?: string }): Promise<void> {
  if (!transporter) {
    console.info(JSON.stringify({ event: 'email_skipped', to: input.to, subject: input.subject }));
    return;
  }
  await transporter.sendMail({ from: config.SMTP_FROM, ...input });
}
