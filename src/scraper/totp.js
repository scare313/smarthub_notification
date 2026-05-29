const crypto = require('crypto');

/**
 * Programmatically generates a 6-digit TOTP code (RFC 6238)
 * using a Base32-encoded 2FA Secret Key.
 * 
 * Works natively in Node.js with zero dependencies!
 * 
 * @param {string} secret Base32-encoded secret key (e.g. "JBSWY3DPEHPK3PXP")
 * @returns {string} 6-digit verification code
 */
function generateTOTP(secret) {
  if (!secret) {
    throw new Error('TOTP Secret Key is required');
  }

  // 1. Clean and Base32 decode the secret
  const cleanSecret = secret.replace(/\s/g, '').toUpperCase();
  const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  
  for (let i = 0; i < cleanSecret.length; i++) {
    const val = base32chars.indexOf(cleanSecret.charAt(i));
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  
  const hex = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    const chunk = bits.substring(i, i + 8);
    hex.push(parseInt(chunk, 2).toString(16).padStart(2, '0'));
  }
  
  const secretBuffer = Buffer.from(hex.join(''), 'hex');

  // 2. Calculate time step counter (30 seconds interval)
  const time = Math.floor(Date.now() / 1000);
  const epoch = Math.floor(time / 30);
  
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(Math.floor(epoch / 0x100000000), 0);
  timeBuffer.writeUInt32BE(epoch & 0xffffffff, 4);

  // 3. Perform HMAC-SHA1
  const hmac = crypto.createHmac('sha1', secretBuffer);
  hmac.update(timeBuffer);
  const hmacResult = hmac.digest();

  // 4. Dynamic Truncation
  const offset = hmacResult[hmacResult.length - 1] & 0xf;
  const code = (
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff)
  ) % 1000000;

  return String(code).padStart(6, '0');
}

module.exports = { generateTOTP };
