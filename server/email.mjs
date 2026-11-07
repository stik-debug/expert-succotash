/**
 * Outbound email for password reset.
 *
 * Preferred: RESEND_API_KEY + EMAIL_FROM
 * Or SMTP (implicit TLS): SMTP_HOST, SMTP_PORT=465, SMTP_USER, SMTP_PASS, EMAIL_FROM
 *
 * Without config, the reset link is logged to the server console (development only).
 */
import tls from 'node:tls';

export function emailConfigured() {
  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) return true;
  if (process.env.SMTP_HOST && process.env.EMAIL_FROM) return true;
  return false;
}

export async function sendPasswordResetEmail({ to, resetUrl, businessName }) {
  const subject = 'Reset your MarginPilot password';
  const text =
    `You requested a password reset${businessName ? ' for ' + businessName : ''}.\n\n` +
    `Open this link within 1 hour to choose a new password:\n${resetUrl}\n\n` +
    `If you did not ask for this, you can ignore this email.\n`;
  const html =
    `<p>You requested a password reset${businessName ? ' for <strong>' + esc(businessName) + '</strong>' : ''}.</p>` +
    `<p><a href="${escAttr(resetUrl)}">Reset your password</a> (link expires in 1 hour).</p>` +
    `<p style="color:#667085;font-size:13px">If you did not ask for this, ignore this email.</p>`;

  if (process.env.RESEND_API_KEY && process.env.EMAIL_FROM) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [to],
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) throw new Error('Resend failed: ' + res.status + ' ' + (await res.text()));
    return { provider: 'resend' };
  }

  if (process.env.SMTP_HOST && process.env.EMAIL_FROM) {
    const port = Number(process.env.SMTP_PORT || 465);
    await sendSmtpTls({
      host: process.env.SMTP_HOST,
      port,
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.EMAIL_FROM,
      to,
      subject,
      text,
    });
    return { provider: 'smtp' };
  }

  console.log('[email:dev] To:', to);
  console.log('[email:dev] Subject:', subject);
  console.log('[email:dev] Reset URL:', resetUrl);
  return { provider: 'log' };
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) {
  return esc(s).replace(/\n/g, '');
}

function sendSmtpTls({ host, port, user, pass, from, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host }, () => {
      let buf = '';
      let step = 0;
      const send = (line) => socket.write(line + '\r\n');

      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!/^\d{3}/.test(line)) continue;
          const code = line.slice(0, 3);
          const mid = line[3];
          try {
            if (step === 0 && code === '220') {
              send('EHLO marginpilot');
              step = 1;
            } else if (step === 1 && code === '250' && mid === ' ') {
              if (user) {
                send('AUTH LOGIN');
                step = 2;
              } else {
                send('MAIL FROM:<' + from + '>');
                step = 5;
              }
            } else if (step === 2 && code === '334') {
              send(Buffer.from(user).toString('base64'));
              step = 3;
            } else if (step === 3 && code === '334') {
              send(Buffer.from(pass).toString('base64'));
              step = 4;
            } else if (step === 4 && code === '235') {
              send('MAIL FROM:<' + from + '>');
              step = 5;
            } else if (step === 4) {
              reject(new Error('SMTP auth failed: ' + line));
              socket.end();
            } else if (step === 5 && code === '250') {
              send('RCPT TO:<' + to + '>');
              step = 6;
            } else if (step === 6 && (code === '250' || code === '251')) {
              send('DATA');
              step = 7;
            } else if (step === 7 && code === '354') {
              send(
                'From: ' + from + '\r\n' +
                'To: ' + to + '\r\n' +
                'Subject: ' + subject + '\r\n' +
                'MIME-Version: 1.0\r\n' +
                'Content-Type: text/plain; charset=utf-8\r\n' +
                '\r\n' +
                text +
                '\r\n.'
              );
              step = 8;
            } else if (step === 8 && code === '250') {
              send('QUIT');
              resolve();
              socket.end();
            } else if (code[0] === '4' || code[0] === '5') {
              reject(new Error('SMTP error: ' + line));
              socket.end();
            }
          } catch (e) {
            reject(e);
            socket.end();
          }
        }
      });
    });
    socket.on('error', reject);
    setTimeout(() => reject(new Error('SMTP timeout')), 20000);
  });
}
