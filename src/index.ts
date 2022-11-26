import { ERROR } from './constants';
import { largestFirst } from './methods/largestFirst';
import { randomImprove } from './methods/randomImprove';
import { CoinSelectionError } from './utils/errors';
import { getLogger } from './utils/logger';
import {
  CoinSelectionParams,
  CoinSelectionResult,
  FinalOutput,
  Options,
  PrecomposedTransaction,
} from './types/types';
import { bigNumFromStr } from './utils/common';

export const coinSelection = (
  params: CoinSelectionParams,
  options?: Options,
): PrecomposedTransaction => {
  const logger = getLogger(!!options?.debug);
  logger.debug('Args:', {
    params,
    options,
  });

  if (params.utxos.length === 0) {
    logger.debug('Empty Utxo set');
    throw new CoinSelectionError(ERROR.UTXO_BALANCE_INSUFFICIENT);
  }

  const t1 = new Date().getTime();
  let res: CoinSelectionResult;
  if (
    params.outputs.find(o => o.setMax) ||
    params.certificates.length > 0 ||
    params.withdrawals.length > 0 ||
    options?.forceLargestFirstSelection
  ) {
    logger.debug('Running largest-first alg');
    res = largestFirst(params, options);
  } else {
    logger.debug('Running random-improve alg');
    try {
      res = randomImprove(params, options);
    } catch (error) {
      if (
        error instanceof CoinSelectionError &&
        error.code === 'UTXO_NOT_FRAGMENTED_ENOUGH'
      ) {
        logger.debug(
          `random-improve failed with ${error.code}. Retrying with largest-first alg.`,
        );
        res = largestFirst(params, options);
      } else {
        throw error;
      }
    }
  }

  const t2 = new Date().getTime();
  logger.debug(`Duration: ${(t2 - t1) / 1000} seconds`);

  const incompleteOutputs = res.outputs.find(
    o =>
      !o.address ||
      !o.amount ||
      // assets set with quantity = 0
      (o.assets.length > 0 &&
        o.assets.find(
          a =>
            !a.quantity ||
            bigNumFromStr(a.quantity).compare(bigNumFromStr('0')) === 0,
        )),
  );

  if (incompleteOutputs) {
    const selection = {
      type: 'nonfinal',
      fee: res.fee,
      totalSpent: res.totalSpent,
      deposit: res.deposit,
      withdrawal: res.withdrawal,
      max: res.max,
    } as const;
    logger.debug('Coin selection for a draft transaction:', selection);
    return selection;
  } else {
    const selection = {
      type: 'final',
      ...res,
      outputs: res.outputs as FinalOutput[],
    } as const;
    logger.debug('Coin selection for a final transaction:', selection);
    return selection;
  }
};

export * as types from './types/types';
export * as trezorUtils from './utils/trezor';
export { onekeyUtils } from './utils/onekey';
export { CoinSelectionError } from './utils/errors';
