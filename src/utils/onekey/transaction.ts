import BigNumber from 'bignumber.js';
import { coinSelection } from '../../index';
import { PrecomposedTransaction, UserOutput, Utxo } from '../../types/types';
import { getLogger } from '../logger';

type ITransferInfo = {
  from: string;
  to: string;
  amount: string;
  token?: string; // tokenIdOnNetwork
  isNFT?: boolean;
  tokenId?: string; // NFT token id
  type?: string; // NFT standard: erc721/erc1155
};

type IAdaAmount = {
  unit: string;
  quantity: string;
};

type IAdaUTXO = {
  tx_hash: string;
  tx_index: number;
  output_index: string;
  amount: IAdaAmount[];
};

type IOutput = {
  address: string;
  amount: string;
  assets: [];
};

export const composeTxPlan = (
  transferInfo: ITransferInfo,
  accountXpub: string,
  utxos: IAdaUTXO[],
  changeAddress: string,
  outputs: IOutput[],
  options?: { debug: boolean },
): PrecomposedTransaction => {
  const logger = getLogger(!!options?.debug);
  const transformUtxos = utxos.map(utxo => ({
    address: transferInfo.from,
    txHash: utxo.tx_hash,
    outputIndex: utxo.output_index,
    ...utxo,
  }));
  try {
    const txPlan = coinSelection(
      {
        utxos: transformUtxos as unknown as Utxo[],
        outputs: outputs as UserOutput[],
        changeAddress,
        certificates: [],
        withdrawals: [],
        accountPubKey: accountXpub,
      },
      {
        debug: options?.debug ?? false,
      },
    );
    return txPlan;
  } catch (err: unknown) {
    if ((err as { code: string })?.code === 'UTXO_BALANCE_INSUFFICIENT') {
      logger.debug('UTxO balance insufficient');
      if (outputs.length === 1) {
        const fixedOutput = [...outputs];
        const amountBN = new BigNumber(outputs[0].amount);
        const oneLovelace = new BigNumber('100000');
        if (amountBN.gte(oneLovelace)) {
          fixedOutput[0].amount = amountBN.minus(oneLovelace).toFixed();
          return composeTxPlan(
            transferInfo,
            accountXpub,
            utxos,
            changeAddress,
            fixedOutput,
          );
        }
      }
      throw err;
    } else {
      throw err;
    }
  }
};
