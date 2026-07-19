const crypto = require('crypto');

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash) return null;
  params.delete('hash');
  params.delete('signature');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!timingSafeEqualHex(receivedHash, calculatedHash)) return null;

  const authDate = Number(params.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || Math.abs(now - authDate) > maxAgeSeconds) return null;

  try {
    const user = JSON.parse(params.get('user') || '{}');
    if (!user.id) return null;
    return {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `User ${user.id}`,
      username: user.username || '',
      photoUrl: user.photo_url || ''
    };
  } catch {
    return null;
  }
}

function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

function createAdminCookie(secret) {
  const payload = `${Date.now()}.${crypto.randomBytes(12).toString('hex')}`;
  return `${payload}.${signValue(payload, secret)}`;
}

function verifyAdminCookie(cookieValue, secret, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  if (!cookieValue || !secret) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!timingSafeEqualHex(parts[2], signValue(payload, secret))) return false;
  const createdAt = Number(parts[0]);
  return Number.isFinite(createdAt) && Date.now() - createdAt <= maxAgeMs;
}

module.exports = {
  validateTelegramInitData,
  createAdminCookie,
  verifyAdminCookie
};
