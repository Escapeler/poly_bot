/**
 * deriveKeys.js — Auto-derive Polymarket API credentials.
 *
 * Uses Polymarket CLOB's /auth/derive-api-key endpoint with EIP-712 signature.
 * No Python needed. Pure JavaScript using ethers.js.
 *
 * Can be used:
 *   1. Automatically at bot startup (if POLY_API_KEY is empty in .env)
 *   2. Manually: node src/deriveKeys.js
 *
 * The derived credentials are:
 *   - apiKey:      UUID format
 *   - secret:      base64 encoded string
 *   - passphrase:  random string
 *
 * These same credentials are passed to Almanac when creating a session.
 */

import { ethers } from 'ethers';
import axios from 'axios';
import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(__dirname, '..', '.env');

// ── EIP-712 Domain & Types for Polymarket CLOB Auth ──────
const CLOB_AUTH_DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: 137,
};

const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ],
};

/**
 * Derive or create Polymarket API credentials from a private key.
 * Tries derive first (idempotent), falls back to create.
 *
 * @param {string} privateKey - wallet private key (with or without 0x)
 * @param {string} clobUrl - CLOB API base URL
 * @returns {{ apiKey: string, secret: string, passphrase: string }}
 */
export async function deriveApiCredentials(privateKey, clobUrl = 'https://clob.polymarket.com') {
  const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const wallet = new ethers.Wallet(pk);
  const address = wallet.address;

  // Build EIP-712 auth headers
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 0;

  const value = {
    address,
    timestamp,
    nonce,
    message: 'This message attests that I control the given wallet',
  };

  const signature = await wallet.signTypedData(CLOB_AUTH_DOMAIN, CLOB_AUTH_TYPES, value);

  const headers = {
    'POLY_ADDRESS': address,
    'POLY_SIGNATURE': signature,
    'POLY_TIMESTAMP': timestamp,
    'POLY_NONCE': String(nonce),
  };

  // Try derive first (returns existing key if one exists)
  try {
    const resp = await axios.get(`${clobUrl}/auth/derive-api-key`, {
      headers,
      timeout: 15000,
    });
    if (resp.data && resp.data.apiKey) {
      return {
        apiKey: resp.data.apiKey,
        secret: resp.data.secret,
        passphrase: resp.data.passphrase,
      };
    }
  } catch (err) {
    const status = err.response && err.response.status;
    if (status !== 404 && status !== 400) {
      console.error(`Derive failed (${status}): ${(err.response && err.response.data) ? err.response.data.error : undefined || err.message}`);
    }
  }

  // Create new API key
  try {
    const resp = await axios.post(`${clobUrl}/auth/api-key`, null, {
      headers,
      timeout: 15000,
    });
    if (resp.data && resp.data.apiKey) {
      return {
        apiKey: resp.data.apiKey,
        secret: resp.data.secret,
        passphrase: resp.data.passphrase,
      };
    }
    throw new Error('No apiKey in response');
  } catch (err) {
    throw new Error(`Failed to create API key: ${(err.response && err.response.data) ? err.response.data.error : undefined || err.message}`);
  }
}

/**
 * Save credentials to .env file.
 * Updates existing values or appends new ones.
 */
export function saveCredsToEnv(creds) {
  if (!existsSync(ENV_PATH)) {
    writeFileSync(ENV_PATH, '', 'utf-8');
  }

  let envContent = readFileSync(ENV_PATH, 'utf-8');

  const updates = {
    'POLY_API_KEY': creds.apiKey,
    'POLY_API_SECRET': creds.secret,
    'POLY_API_PASSPHRASE': creds.passphrase,
  };

  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
      envContent += `\n${key}=${value}`;
    }
  }

  writeFileSync(ENV_PATH, envContent, 'utf-8');
}

// ── CLI Mode ─────────────────────────────────────────────
const isMainModule = process.argv[1] && process.argv[1].endsWith('deriveKeys.js');
if (isMainModule) {
  dotenvConfig({ path: ENV_PATH });

  const privateKey = process.env.WALLET_PRIVATE_KEY || '';
  if (!privateKey) {
    console.error('ERROR: Set WALLET_PRIVATE_KEY in .env first.');
    process.exit(1);
  }

  const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
  const wallet = new ethers.Wallet(pk);
  const clobUrl = process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com';

  console.log(`\nDeriving Polymarket API credentials...`);
  console.log(`  Wallet: ${wallet.address}`);
  console.log(`  CLOB:   ${clobUrl}\n`);

  try {
    const creds = await deriveApiCredentials(privateKey, clobUrl);
    console.log('='.repeat(60));
    console.log('  POLYMARKET API CREDENTIALS');
    console.log('='.repeat(60));
    console.log(`  POLY_API_KEY=${creds.apiKey}`);
    console.log(`  POLY_API_SECRET=${creds.secret}`);
    console.log(`  POLY_API_PASSPHRASE=${creds.passphrase}`);
    console.log('='.repeat(60));

    console.log('\n  Saving to .env...');
    saveCredsToEnv(creds);
    console.log('  Saved! You can now run: npm start\n');
  } catch (err) {
    console.error(`\nFailed: ${err.message}`);
    process.exit(1);
  }
}
