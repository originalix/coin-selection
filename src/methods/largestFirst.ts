import { ERROR } from '../constants';
import * as CardanoWasm from '@emurgo/cardano-serialization-lib-browser';
import {
  Certificate,
  ChangeOutput,
  CoinSelectionResult,
  Options,
  Output,
  UserOutput,
  Utxo,
  Withdrawal,
} from '../types/types';
import {
  bigNumFromStr,
  calculateRequiredDeposit,
  getAssetAmount,
  getOutputCost,
  prepareCertificates,
  prepareChangeOutput,
  prepareWithdrawals,
  setMinUtxoValueForOutputs,
  sortUtxos,
  getTxBuilder,
  getInitialUtxoSet,
  setMaxOutput,
  getUserOutputQuantityWithDeposit,
  multiAssetToArray,
  buildTxInput,
  buildTxOutput,
  getUnsatisfiedAssets,
  splitChangeOutput,
} from '../utils/common';
import { CoinSelectionError } from '../utils/errors';

export const largestFirst = (
  utxos: Utxo[],
  outputs: UserOutput[],
  changeAddress: string,
  certificates: Certificate[],
  withdrawals: Withdrawal[],
  accountPubKey: string,
  options?: Options,
): CoinSelectionResult => {
  const txBuilder = getTxBuilder(options?.feeParams?.a);
  const usedUtxos: Utxo[] = [];
  let sortedUtxos = sortUtxos(utxos);
  const accountKey = CardanoWasm.Bip32PublicKey.from_bytes(
    Buffer.from(accountPubKey, 'hex'),
  );

  // add withdrawals and certs to correctly set a fee
  const preparedCertificates = prepareCertificates(certificates, accountKey);
  const preparedWithdrawals = prepareWithdrawals(withdrawals);

  if (preparedCertificates.len() > 0) {
    txBuilder.set_certs(preparedCertificates);
  }
  if (preparedWithdrawals.len() > 0) {
    txBuilder.set_withdrawals(preparedWithdrawals);
  }

  // TODO: negative value in case of deregistration (-2000000), but we still need enough utxos to cover fee which can't be (is that right?) paid from returned deposit
  const deposit = calculateRequiredDeposit(certificates);
  const totalWithdrawal = withdrawals.reduce(
    (acc, withdrawal) => acc.checked_add(bigNumFromStr(withdrawal.amount)),
    bigNumFromStr('0'),
  );

  // calc initial fee
  let totalFeesAmount = txBuilder.min_fee();
  let utxosTotalAmount = totalWithdrawal;
  if (deposit < 0) {
    // stake deregistration, 2 ADA returned
    utxosTotalAmount = utxosTotalAmount.checked_add(
      bigNumFromStr(Math.abs(deposit).toString()),
    );
  }

  const preparedOutputs = setMinUtxoValueForOutputs(txBuilder, outputs);

  const addUtxoToSelection = (utxo: Utxo) => {
    const { input, address, amount } = buildTxInput(utxo);
    const fee = txBuilder.fee_for_input(address, input, amount);
    txBuilder.add_input(address, input, amount);
    usedUtxos.push(utxo);
    totalFeesAmount = totalFeesAmount.checked_add(fee);
    utxosTotalAmount = utxosTotalAmount.checked_add(
      bigNumFromStr(getAssetAmount(utxo)),
    );
  };

  // set initial utxos set for setMax functionality
  const maxOutputIndex = outputs.findIndex(o => !!o.setMax);
  const maxOutput = preparedOutputs[maxOutputIndex];
  const { used, remaining } = getInitialUtxoSet(sortedUtxos, maxOutput);
  sortedUtxos = remaining;
  used.forEach(utxo => addUtxoToSelection(utxo));

  // Calculate fee and minUtxoValue for all external outputs
  const outputsCost = preparedOutputs.map(output =>
    getOutputCost(txBuilder, output),
  );

  const totalOutputsFee = outputsCost.reduce(
    (acc, output) => (acc = acc.checked_add(output.outputFee)),
    bigNumFromStr('0'),
  );

  // add external outputs fees to total
  totalFeesAmount = totalFeesAmount.checked_add(totalOutputsFee);

  let totalUserOutputsAmount = getUserOutputQuantityWithDeposit(
    preparedOutputs,
    deposit,
  );

  let changeOutput: ChangeOutput[] | null = null;
  let sufficientUtxos = false;
  let forceAnotherRound = false;
  while (!sufficientUtxos) {
    if (maxOutput) {
      // reset previously computed maxOutput in order to correctly calculate a potential change output
      preparedOutputs[maxOutputIndex] = setMinUtxoValueForOutputs(txBuilder, [
        maxOutput,
      ])[0];
    }
    // Calculate change output
    let singleChangeOutput = prepareChangeOutput(
      txBuilder,
      usedUtxos,
      preparedOutputs,
      changeAddress,
      utxosTotalAmount,
      getUserOutputQuantityWithDeposit(preparedOutputs, deposit),
      totalFeesAmount,
    );

    if (maxOutput) {
      // set amount for a max output from a changeOutput calculated above
      const { changeOutput: newChangeOutput, maxOutput: newMaxOutput } =
        setMaxOutput(maxOutput, singleChangeOutput);
      // change output may be completely removed if all ADA are consumed by max output
      singleChangeOutput = newChangeOutput;
      preparedOutputs[maxOutputIndex] = newMaxOutput;
      // recalculate  total user outputs amount
      totalUserOutputsAmount = getUserOutputQuantityWithDeposit(
        preparedOutputs,
        deposit,
      );
    }

    const changeOutputs = singleChangeOutput
      ? splitChangeOutput(
          txBuilder,
          singleChangeOutput,
          changeAddress,
          options?._maxTokensPerOutput,
        )
      : [];

    let requiredAmount = totalFeesAmount.checked_add(totalUserOutputsAmount);
    changeOutputs.forEach(changeOutput => {
      // we need to cover amounts and fees for change outputs
      requiredAmount = requiredAmount
        .checked_add(changeOutput.output.amount().coin())
        .checked_add(changeOutput.outputFee);
    });

    // List of tokens for which we don't have enough utxos
    const unsatisfiedAssets = getUnsatisfiedAssets(usedUtxos, preparedOutputs);

    if (
      utxosTotalAmount.compare(requiredAmount) >= 0 &&
      unsatisfiedAssets.length === 0 &&
      usedUtxos.length > 0 && // TODO: force at least 1 utxo, otherwise withdrawal tx is composed without utxo if rewards > tx cost
      !forceAnotherRound
    ) {
      // we are done. we have enough utxos to cover fees + minUtxoValue for each output. now we can add the cost of the change output to total fees
      if (changeOutputs.length > 0) {
        changeOutputs.forEach(changeOutput => {
          totalFeesAmount = totalFeesAmount.checked_add(changeOutput.outputFee);
        });

        // set change output
        changeOutput = changeOutputs.map(change => ({
          isChange: true,
          amount: change.output.amount().coin().to_str(),
          address: changeAddress,
          assets: multiAssetToArray(change.output.amount().multiasset()),
        }));
      } else {
        if (sortedUtxos.length > 0) {
          // In current iteration we don't have enough utxo to meet min utxo value for an output,
          // but some utxos are still available, force adding another one in order to create a change output
          forceAnotherRound = true;
          continue;
        }

        // Change output would be inefficient., we can burn its value + fee we would pay for it
        const unspendableChangeAmount = utxosTotalAmount.clamped_sub(
          totalFeesAmount.checked_add(totalUserOutputsAmount),
        );
        totalFeesAmount = totalFeesAmount.checked_add(unspendableChangeAmount);
      }
      sufficientUtxos = true;
    } else {
      if (unsatisfiedAssets.length > 0) {
        sortedUtxos = sortUtxos(sortedUtxos, unsatisfiedAssets[0]);
      } else {
        sortedUtxos = sortUtxos(sortedUtxos);
      }

      const utxo = sortedUtxos.shift();
      if (!utxo) break;
      addUtxoToSelection(utxo);
      forceAnotherRound = false;
    }
    // END LOOP
  }

  if (!sufficientUtxos) {
    throw new CoinSelectionError(ERROR.UTXO_BALANCE_INSUFFICIENT);
  }

  preparedOutputs.forEach(output => {
    const txOutput = buildTxOutput(output);
    txBuilder.add_output(txOutput);
  });

  const finalOutputs: Output[] = JSON.parse(JSON.stringify(preparedOutputs));
  if (changeOutput) {
    changeOutput.forEach(change => {
      finalOutputs.push(change);
      txBuilder.add_output(buildTxOutput(change));
    });
  }

  txBuilder.set_fee(totalFeesAmount);
  const txBody = txBuilder.build();
  const txHash = Buffer.from(
    CardanoWasm.hash_transaction(txBody).to_bytes(),
  ).toString('hex');
  const txBodyHex = Buffer.from(txBody.to_bytes()).toString('hex');

  const totalSpent = totalUserOutputsAmount.checked_add(totalFeesAmount);

  // Set max property with the value of an output which has setMax=true
  let max;
  if (maxOutput) {
    max =
      maxOutput.assets.length > 0
        ? maxOutput.assets[0].quantity
        : maxOutput.amount;
  }

  return {
    inputs: usedUtxos,
    outputs: finalOutputs,
    fee: totalFeesAmount.to_str(),
    totalSpent: totalSpent.to_str(),
    deposit: deposit.toString(),
    withdrawal: totalWithdrawal.to_str(),
    tx: { body: txBodyHex, hash: txHash, size: txBuilder.full_size() },
    max,
  };
};
