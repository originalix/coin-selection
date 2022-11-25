import BigNumber from 'bignumber.js';

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
	assets: [] 
}

export const composeTxPlan = (
	transferInfo: ITransferInfo,
  accountXpub: string,
  utxos: IAdaUTXO[],
  changeAddress: string,
  outputs: IOutput[],
) => {
  const transformUtxos = utxos.map((utxo) => ({
    address: transferInfo.from,
    txHash: utxo.tx_hash,
    outputIndex: utxo.output_index,
    ...utxo,
  }));
  try {
    const txPlan = coinSelection(
      {
        utxos: transformUtxos as any,
        outputs: outputs as any,
        changeAddress,
        certificates: [],
        withdrawals: [],
        accountPubKey: accountXpub,
      },
      {
        debug: true,
      },
    );
    return txPlan;
  } catch (err: unknown) {
    if ((err as { code: string })?.code === 'UTXO_BALANCE_INSUFFICIENT') {
      console.log('UTxO balance insufficient');
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
}