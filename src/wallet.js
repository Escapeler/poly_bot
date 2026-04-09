/**
 * wallet.js — Wallet management, EIP-712 signing, RPC provider with failover.
 *
 * Features:
 *   - Ethers.js v6 wallet + provider
 *   - EIP-712 typed data signing for Polymarket orders
 *   - RPC failover (Infura → public fallbacks)
 *   - Balance checking (MATIC + USDC)
 */

import { ethers } from 'ethers';
import config from './config.js';
import { logger } from './utils.js';

// ── Contract Addresses (Polygon) ──────────────────────────
const EIP712_DOMAIN_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const EIP712_DOMAIN_NEGRISK_CONTRACT = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const MULTISEND_ADDRESS = '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761';

const ERC20_ABI = [
  'function balanceOf(address account) view returns (uint256)',
];

const SAFE_ABI = [
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)',
  'function nonce() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
];

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];

const MULTISEND_ABI = [
  'function multiSend(bytes transactions)',
];

// ── EIP-712 Types ────────────────────────────────────────
const ORDER_TYPES = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ],
};

class WalletManager {
  constructor() {
    this._provider = null;
    this._wallet = null;
    this._healthyUrl = null;
    this._lastHealthCheck = 0;
  }

  // ═══════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════

  init() {
    const pk = config.walletPrivateKey.startsWith('0x')
      ? config.walletPrivateKey
      : '0x' + config.walletPrivateKey;

    this._provider = this._createProvider(config.resolvedRpcUrl);
    this._wallet = new ethers.Wallet(pk, this._provider);
    logger.info(`Wallet initialized: ${this._wallet.address}`);
    return this;
  }

  _createProvider(url) {
    return new ethers.JsonRpcProvider(url, {
      chainId: config.chainId,
      name: 'polygon',
    });
  }

  get provider() { return this._provider; }
  get wallet() { return this._wallet; }
  get address() { return this._wallet ? this._wallet.address : ''; }

  // ═══════════════════════════════════════════════════════
  // RPC FAILOVER
  // ═══════════════════════════════════════════════════════

  async getHealthyProvider() {
    const now = Date.now();
    // OPTIMIZED: 300s cache (was 60s). Saves ~1150 CU/day.
    // RPC providers don't change that often.
    if (this._healthyUrl && (now - this._lastHealthCheck) < 300000) {
      return this._provider;
    }

    const urls = [config.resolvedRpcUrl, ...config.rpcFallbackUrls];
    for (const url of urls) {
      try {
        const provider = this._createProvider(url);
        await provider.getBlockNumber();
        this._provider = provider;
        this._wallet = this._wallet.connect(provider);
        this._healthyUrl = url;
        this._lastHealthCheck = now;
        return provider;
      } catch {
        continue;
      }
    }
    throw new Error('All RPC providers unreachable');
  }

  // ═══════════════════════════════════════════════════════
  // BALANCES
  // ═══════════════════════════════════════════════════════

  async getMaticBalance(address) {
    const provider = await this.getHealthyProvider();
    const wei = await provider.getBalance(address || config.funderAddress);
    return parseFloat(ethers.formatEther(wei));
  }

  async getUsdcBalance(address) {
    const provider = await this.getHealthyProvider();
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const raw = await usdc.balanceOf(address || config.funderAddress);
    return Number(raw) / 1e6; // USDC has 6 decimals
  }

  async getBlockNumber() {
    const provider = await this.getHealthyProvider();
    return provider.getBlockNumber();
  }

  // ═══════════════════════════════════════════════════════
  // MESSAGE SIGNING (EIP-191)
  // ═══════════════════════════════════════════════════════

  signMessage(message) {
    return this._wallet.signMessage(message);
  }

  // ═══════════════════════════════════════════════════════
  // EIP-712 ORDER SIGNING
  // ═══════════════════════════════════════════════════════

  /**
   * Build and sign an EIP-712 order for Polymarket CLOB.
   *
   * @param {Object} params
   * @param {string} params.tokenId - CLOB token ID
   * @param {number} params.side - 0=BUY, 1=SELL
   * @param {number} params.price - Order price (0-1)
   * @param {number} params.size - Order size in shares
   * @param {boolean} params.negRisk - neg_risk flag
   * @param {string} params.orderType - FOK, GTC, FAK
   * @param {number} params.feeRateBps - Fee rate in basis points
   * @returns {{ signature: string, orderPayload: Object }} | null
   */
  async signOrder({ tokenId, side, price, size, negRisk, orderType, feeRateBps = 0 }) {
    try {
      const walletAddr = config.walletAddress;
      const proxy = config.funderAddress;
      const exchange = negRisk ? EIP712_DOMAIN_NEGRISK_CONTRACT : EIP712_DOMAIN_CONTRACT;

      const sideNum = side === 'BUY' ? 0 : 1;
      const salt = BigInt(Date.now());

      // Price buffer for FOK/FAK
      const BUFFER = 0.01;
      let adjPrice;
      if (orderType === 'FOK' || orderType === 'FAK') {
        adjPrice = sideNum === 0
          ? price + BUFFER
          : Math.max(0.01, price - BUFFER);
      } else {
        adjPrice = price;
      }
      adjPrice = Math.min(adjPrice, 0.99);
      adjPrice = Math.max(adjPrice, 0.01);

      // Amount calculation — CLOB precision rules
      // BUY:  makerAmount (USDC) = 2 decimals, takerAmount (shares) = 4 decimals
      // SELL: makerAmount (shares) = 4 decimals, takerAmount (USDC) = 2 decimals
      const toMicro2dec = (x) => BigInt(Math.floor(x * 100)) * 10000n;
      const toMicro4dec = (x) => BigInt(Math.floor(x * 10000)) * 100n;

      let makerAmount, takerAmount;
      if (sideNum === 0) {
        makerAmount = toMicro2dec(size * adjPrice);
        takerAmount = toMicro4dec(size);
      } else {
        makerAmount = toMicro4dec(size);
        takerAmount = toMicro2dec(size * adjPrice);
      }

      const tokenIdBigInt = BigInt(tokenId);

      const domain = {
        name: 'Polymarket CTF Exchange',
        version: '1',
        chainId: config.chainId,
        verifyingContract: exchange,
      };

      const orderMsg = {
        salt,
        maker: proxy,
        signer: walletAddr,
        taker: ethers.ZeroAddress,
        tokenId: tokenIdBigInt,
        makerAmount,
        takerAmount,
        expiration: 0n,
        nonce: 0n,
        feeRateBps: BigInt(feeRateBps),
        side: sideNum,
        signatureType: 2,
      };

      const signature = await this._wallet.signTypedData(domain, ORDER_TYPES, orderMsg);

      // Return payload with string values (as required by Almanac API)
      const orderPayload = {
        salt: salt.toString(),
        maker: proxy,
        signer: walletAddr,
        taker: ethers.ZeroAddress,
        tokenId: tokenIdBigInt.toString(),
        makerAmount: makerAmount.toString(),
        takerAmount: takerAmount.toString(),
        expiration: '0',
        nonce: '0',
        feeRateBps: String(feeRateBps),
        side: sideNum,
        signatureType: 2,
      };

      return { signature, orderPayload };
    } catch (err) {
      logger.error(`EIP-712 sign failed: ${err.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // SAFE TX EXECUTION (for redeems)
  // ═══════════════════════════════════════════════════════

  async executeSafeBatchRedeem(positions) {
    try {
      const provider = await this.getHealthyProvider();
      const proxy = config.funderAddress;
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
      const safe = new ethers.Contract(proxy, SAFE_ABI, this._wallet);
      const multisend = new ethers.Contract(MULTISEND_ADDRESS, MULTISEND_ABI, provider);

      // Check gas
      const balance = await provider.getBalance(this._wallet.address);
      if (balance < ethers.parseEther('0.005')) {
        return { success: false, error: 'Need more MATIC for gas' };
      }

      // Encode individual CTF calls and pack for MultiSend
      let packed = '0x';
      for (const pos of positions) {
        const conditionId = pos.conditionId.startsWith('0x')
          ? pos.conditionId
          : '0x' + pos.conditionId;
        const indexSet = 1 << (pos.outcomeIndex || 0);

        const calldata = ctf.interface.encodeFunctionData('redeemPositions', [
          USDC_ADDRESS,
          ethers.ZeroHash,
          conditionId,
          [indexSet],
        ]);

        // MultiSend packed format per tx:
        // operation (1 byte) + to (20 bytes) + value (32 bytes) + dataLength (32 bytes) + data
        const calldataBytes = calldata.slice(2); // remove 0x
        const dataLen = (calldataBytes.length / 2).toString(16).padStart(64, '0');
        packed +=
          '00' + // operation = Call
          CTF_ADDRESS.slice(2).toLowerCase() + // to
          '0'.repeat(64) + // value = 0
          dataLen +
          calldataBytes;
      }

      const multisendData = multisend.interface.encodeFunctionData('multiSend', [packed]);
      const safeNonce = await safe.nonce();

      const safeTxHash = await safe.getTransactionHash(
        MULTISEND_ADDRESS, 0, multisendData,
        1, // DelegateCall
        0, 0, 0,
        ethers.ZeroAddress, ethers.ZeroAddress,
        safeNonce,
      );

      // Sign the Safe tx hash directly
      const sig = this._wallet.signingKey.sign(safeTxHash);
      const signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);

      const gasLimit = 200000 + (150000 * positions.length);
      const tx = await safe.execTransaction(
        MULTISEND_ADDRESS, 0, multisendData,
        1, 0, 0, 0,
        ethers.ZeroAddress, ethers.ZeroAddress,
        signature,
        { gasLimit },
      );

      const receipt = await tx.wait(1, 120000);
      return {
        success: receipt.status === 1,
        txHash: receipt.hash,
        error: receipt.status !== 1 ? 'execTransaction reverted' : null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async executeSafeSingleRedeem(conditionId, indexSet) {
    try {
      const provider = await this.getHealthyProvider();
      const proxy = config.funderAddress;
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, provider);
      const safe = new ethers.Contract(proxy, SAFE_ABI, this._wallet);

      const cid = conditionId.startsWith('0x') ? conditionId : '0x' + conditionId;
      const calldata = ctf.interface.encodeFunctionData('redeemPositions', [
        USDC_ADDRESS,
        ethers.ZeroHash,
        cid,
        [indexSet],
      ]);

      const safeNonce = await safe.nonce();
      const safeTxHash = await safe.getTransactionHash(
        CTF_ADDRESS, 0, calldata, 0, 0, 0, 0,
        ethers.ZeroAddress, ethers.ZeroAddress, safeNonce,
      );

      const sig = this._wallet.signingKey.sign(safeTxHash);
      const signature = ethers.concat([sig.r, sig.s, ethers.toBeHex(sig.v, 1)]);

      const tx = await safe.execTransaction(
        CTF_ADDRESS, 0, calldata, 0, 0, 0, 0,
        ethers.ZeroAddress, ethers.ZeroAddress,
        signature,
        { gasLimit: 500000 },
      );

      const receipt = await tx.wait(1, 90000);
      return {
        success: receipt.status === 1,
        txHash: receipt.hash,
        error: receipt.status !== 1 ? 'execTransaction reverted' : null,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

// Singleton
const walletManager = new WalletManager();
export default walletManager;
export {
  EIP712_DOMAIN_CONTRACT,
  EIP712_DOMAIN_NEGRISK_CONTRACT,
  USDC_ADDRESS,
  CTF_ADDRESS,
  MULTISEND_ADDRESS,
};
