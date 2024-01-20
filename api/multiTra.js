const bitcoin = require('bitcoinjs-lib');
const axios = require('axios');

module.exports = async (req, res) => {
    const network = bitcoin.networks.bitcoin; // Change to bitcoin.networks.testnet for testnet
    // Validate request body parameters
    const { privateKeys, toAddress, amountToSend, fees, rbf = true, broadcast = false } = req.body;
    if (!privateKeys || !Array.isArray(privateKeys) || privateKeys.length === 0) {
        return res.status(400).send({ success: false, error: 'Private keys are required and must be an array.' });
    }
    if (!toAddress) {
        return res.status(400).send({ success: false, error: 'To address is required.' });
    }
    if (!amountToSend) {
        return res.status(400).send({ success: false, error: 'Amount to send is required.' });
    }
    if (!fees) {
        return res.status(400).send({ success: false, error: 'Fees are required.' });
    }

    const satoshisToBTC = (satoshis) => satoshis / 100000000;

    const publicKeys = privateKeys.map(key => bitcoin.ECPair.fromWIF(key, network).publicKey);
    const redeemScript = bitcoin.payments.p2ms({ m: 2, pubkeys: publicKeys, network }).output;
    const p2wsh = bitcoin.payments.p2wsh({ redeem: { output: redeemScript, network }, network });
    const sourceAddress = p2wsh.address;

    try {
        const utxosResponse = await axios.get(`https://blockstream.info/api/address/${sourceAddress}/utxo`);
        const utxos = utxosResponse.data;
        let inputAmount = 0;
        let selectedUtxos = [];

        for (const utxo of utxos) {
            if (inputAmount < amountToSend + fees) {
                inputAmount += utxo.value;
                selectedUtxos.push(utxo);
            } else {
                break;
            }
        }

        let adjustedAmountToSend = amountToSend;
        // Check if selected UTXOs are enough to cover the transaction
        if (inputAmount < amountToSend + fees) {
            // Adjust amountToSend if total UTXOs are not enough to cover fees
            adjustedAmountToSend = inputAmount - fees;
        }

        const newPsbt = new bitcoin.Psbt({ network: network });
        selectedUtxos.forEach(utxo => {
            newPsbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: p2wsh.output,
                    value: utxo.value,
                },
                witnessScript: redeemScript,
                sequence: rbf ? 0xfffffffd : undefined
            });
        });

        // Calculate change
        let change = inputAmount - adjustedAmountToSend - fees;
        if (change <= 547) {
            change = 0; // No change output for dust amount
        }

        // Add change output only if change is greater than 0
        if (change > 0) {
            newPsbt.addOutput({ address: sourceAddress, value: change });
        }

        newPsbt.addOutput({ address: toAddress, value: adjustedAmountToSend });

        for (let i = 0; i < utxos.length; i++) {
            privateKeys.forEach(privateKey => {
                newPsbt.signInput(i, bitcoin.ECPair.fromWIF(privateKey, network));
            });
        }

        newPsbt.finalizeAllInputs();
        const txHex = newPsbt.extractTransaction().toHex();
        
        // Modify the result based on the broadcast flag
        if (broadcast) {
            try {
                const broadcastResult = await axios.post('https://blockstream.info/api/tx', txHex);
                // Return only the transaction ID if broadcast is true
                res.status(200).send({ success: true, txId: broadcastResult.data });
            } catch (broadcastError) {
                res.status(500).send({ success: false, error: 'Error broadcasting the transaction: ' + broadcastError.message });
            }
        } else {
            // Return detailed information if broadcast is false
            const virtualSize = newPsbt.extractTransaction().virtualSize();
            const result = {
                success: true,
                transactionHex: txHex,
                virtualSize: virtualSize,
            };
            res.status(200).send(result);
        }
    } catch (error) {
        res.status(500).send({ success: false, error: error.message });
    }
};
