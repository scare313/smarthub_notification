const { TOTP, Secret } = require('otpauth');

/**
 * Programmatically generates a 6-digit TOTP code (RFC 6238)
 * using a Base32-encoded 2FA Secret Key.
 * 
 * Uses the battle-tested `otpauth` library for correctness.
 * 
 * @param {string} secret Base32-encoded secret key (e.g. "JBSWY3DPEHPK3PXP")
 * @returns {string} 6-digit verification code
 */
function generateTOTP(secret) {
  if (!secret) {
    throw new Error('TOTP Secret Key is required');
  }

  const cleanSecret = secret.replace(/[\s=-]+/g, '').toUpperCase();

  const totp = new TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(cleanSecret),
  });

  return totp.generate();
}

module.exports = { generateTOTP };

