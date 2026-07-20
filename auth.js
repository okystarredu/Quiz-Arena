const crypto = require('crypto');

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function makeDataCheckString(params, excludeSignature) {
  return [...params.entries()]
    .filter(([key]) => key !== 'hash' && (!excludeSignature || key !== 'signature'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function calculateTelegramHash(dataCheckString, botToken) {
  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  return crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');
}

function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  const rawInitData = String(initData || '').trim();
  const token = String(botToken || '').trim();
  if (!rawInitData || !token) return null;

  const params = new URLSearchParams(rawInitData);
  const receivedHash = String(params.get('hash') || '').toLowerCase();
  if (!receivedHash) return null;

  /*
   * Telegram added the optional signature field after the original HMAC
   * validation flow was introduced. Current clients may require signature
   * to be omitted from the HMAC data-check-string, while older payloads do
   * not contain it. Trying both forms keeps compatibility without accepting
   * any payload that lacks a valid bot-token HMAC.
   */
  const withoutSignature = makeDataCheckString(params, true);
  const withSignature = makeDataCheckString(params, false);
  const hashWithoutSignature = calculateTelegramHash(withoutSignature, token);
  const hashWithSignature = calculateTelegramHash(withSignature, token);

  if (
    !timingSafeEqualHex(receivedHash, hashWithoutSignature) &&
    !timingSafeEqualHex(receivedHash, hashWithSignature)
  ) {
    return null;
  }

  const authDate = Number(params.get('auth_date') || 0);
  const now = Math.floor(Date.now() / 1000);
  const allowedFutureClockSkew = 300;
  if (!Number.isFinite(authDate) || authDate <= 0) return null;
  if (authDate > now + allowedFutureClockSkew) return null;
  if (now - authDate > maxAgeSeconds) return null;

  try {
    const user = JSON.parse(params.get('user') || '{}');
    if (!user || user.id == null) return null;

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
