import nodemailer from 'nodemailer';

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.ru',
    port: Number(process.env.SMTP_PORT) || 465,
    secure: true,
    auth: {
      user: process.env.SMTP_USER || process.env.UNISENDER_SENDER_EMAIL,
      pass: process.env.SMTP_PASS,
    },
  });
}

export async function sendPasswordResetCode(
  to: string,
  code: string,
  username: string,
): Promise<void> {
  console.log(`\n🔑 [EMAIL] Код сброса пароля для ${to}: ${code}\n`);

  if (!process.env.SMTP_PASS) {
    console.warn('⚠️ [EMAIL] SMTP_PASS не задан — письмо не отправлено');
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:440px;margin:0 auto;padding:32px 24px;background:#fff;">
      <h2 style="color:#1B3A30;margin:0 0 16px;">Сброс пароля</h2>
      <p style="color:#374151;margin:0 0 8px;">Привет, <strong>${username}</strong>!</p>
      <p style="color:#374151;margin:0 0 20px;">Введите этот код в приложении для создания нового пароля:</p>
      <div style="background:#F0FDF4;border:2px solid #BBF7D0;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:12px;color:#1B3A30;">${code}</span>
      </div>
      <p style="color:#6B7280;font-size:13px;margin:0 0 6px;">Код действителен 10 минут.</p>
      <p style="color:#6B7280;font-size:13px;margin:0;">Если вы не запрашивали сброс пароля — проигнорируйте письмо.</p>
    </div>
  `;

  try {
    const transporter = createTransport();
    const info = await transporter.sendMail({
      from: `"Моя библиотека" <${process.env.SMTP_USER || process.env.UNISENDER_SENDER_EMAIL}>`,
      to,
      subject: 'Сброс пароля',
      html,
    });
    console.log(`🔑 [EMAIL] Письмо отправлено: ${info.messageId}`);
  } catch (err: any) {
    console.error('🔑 [EMAIL] Ошибка отправки:', err.message);
  }
}

export async function sendEmailVerificationCode(
  to: string,
  code: string,
  username: string,
): Promise<void> {
  console.log(`\n📧 [EMAIL] Код подтверждения для ${to}: ${code}\n`);

  if (!process.env.SMTP_PASS) {
    console.warn('⚠️ [EMAIL] SMTP_PASS не задан — письмо не отправлено');
    return;
  }

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:440px;margin:0 auto;padding:32px 24px;background:#fff;">
      <h2 style="color:#1B3A30;margin:0 0 16px;">Подтверждение email</h2>
      <p style="color:#374151;margin:0 0 8px;">Привет, <strong>${username}</strong>!</p>
      <p style="color:#374151;margin:0 0 20px;">Введите этот код в приложении для смены email:</p>
      <div style="background:#F0FDF4;border:2px solid #BBF7D0;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
        <span style="font-size:36px;font-weight:700;letter-spacing:12px;color:#1B3A30;">${code}</span>
      </div>
      <p style="color:#6B7280;font-size:13px;margin:0 0 6px;">Код действителен 10 минут.</p>
      <p style="color:#6B7280;font-size:13px;margin:0;">Если вы не запрашивали это — проигнорируйте письмо.</p>
    </div>
  `;

  try {
    const transporter = createTransport();
    const info = await transporter.sendMail({
      from: `"Моя библиотека" <${process.env.SMTP_USER || process.env.UNISENDER_SENDER_EMAIL}>`,
      to,
      subject: 'Код подтверждения',
      html,
    });
    console.log(`📧 [EMAIL] Письмо отправлено: ${info.messageId}`);
  } catch (err: any) {
    console.error('📧 [EMAIL] Ошибка отправки:', err.message);
  }
}
