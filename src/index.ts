import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

import * as ynab from "./ynab"
import * as up from "./up"

const ynabApi = new ynab.Api(process.env["YNAB_TOKEN"], process.env["YNAB_BUDGET"])
const upApis = {
    primary: new up.Api(process.env["UP_PRIMARY_TOKEN"], process.env["UP_PRIMARY_WEBHOOK"]),
    secondary: new up.Api(process.env["UP_SECONDARY_TOKEN"], process.env["UP_SECONDARY_WEBHOOK"]),
}

async function createYnabAccount(upAccount: up.Account): Promise<ynab.Account> {
    const type = upAccount.type == "TRANSACTIONAL" ? ynab.AccountType.Checking : ynab.AccountType.Savings
    const name = `Up: ${upAccount.name} (${upAccount.id})`.slice(0, 50)
    const account = await ynabApi.createAccount(name, type, upAccount.id)
    return account
}

async function getYnabTransferAccountPayeeId(upTransferAccountId: string): Promise<string> {
    let ynabAccount = await ynabApi.getAccount(upTransferAccountId);
    if (!ynabAccount) {
        let upAccount: up.Account
        try {
            upAccount = await upApis.primary.getAccount(upTransferAccountId);
        } catch (e) {
            upAccount = await upApis.secondary.getAccount(upTransferAccountId);
        }
        ynabAccount = await createYnabAccount(upAccount);
    }
    return ynabAccount.payeeId
}

export async function webhook(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const body = await request.text();
    context.log(`Webhook: ${body}`);

    const account = request.query.get("account")
    if (account != "primary" && account != "secondary") {
        context.log("ERROR: Invalid account.");
        return { status: 403, body: "Invalid account" };
    }
    const upApi: up.Api = upApis[account]

    const signature = request.headers.get("x-up-authenticity-signature");
    if (!upApi.validateWebhookSignature(body, signature)) {
        context.log("ERROR: Invalid signature.");
        return { status: 403, body: "Invalid signature" };
    }

    const json = JSON.parse(body);
    const type = json.data.attributes.eventType;
    if (type == "TRANSACTION_CREATED" || type == "TRANSACTION_SETTLED") {
        const upTransaction = await upApi.getTransaction(json.data.relationships.transaction.data.id);
        context.log("Found transaction", upTransaction);
        if (upTransaction.transferAccount && upTransaction.amount.valueInBaseUnits > 0) {
            context.log("We only need to process one side of an internal transfer.")
            return { status: 200 }
        }

        const upAccount = await upApi.getAccount(upTransaction.accountId);
        if (upAccount.ownershipType == "JOINT" && account == "secondary") {
            context.log("We will process this transaction using the primary account.")
            return { status: 200 }
        }

        // removing dashes from uuid to get the total length under YNAB"s limit.
        const importId = `up:${upTransaction.id.replaceAll("-", "")}`;
        let ynabTransactionId = await ynabApi.getTransactionFromImportId(importId, upTransaction.createdAt);
        if (ynabTransactionId) {
            const ynabTransaction: ynab.Transaction = {
                amount: upTransaction.amount.valueInBaseUnits * 10,
                cleared: upTransaction.isSettled ? "cleared" : "uncleared",
            }
            context.log(`Updating transaction ${ynabTransactionId.id}:`, ynabTransaction)
            ynabApi.updateTransaction(ynabTransactionId.id, ynabTransaction)
        } else {
            let ynabAccount = await ynabApi.getAccount(upAccount.id);
            if (!ynabAccount) {
                ynabAccount = await createYnabAccount(upAccount);
            }
            let memo = `${upTransaction.createdAt.toTimeString().slice(0, 5)}`
            if (upTransaction.message) {
                memo += `: ${upTransaction.message}`
            }
            if (upTransaction.foreignAmount) {
                memo += ` (${upTransaction.foreignAmount.currencyCode} ${upTransaction.foreignAmount.value})`
            }
            const ynabTransaction: ynab.Transaction = {
                amount: upTransaction.amount.valueInBaseUnits * 10,
                cleared: upTransaction.isSettled ? "cleared" : "uncleared",
                account_id: ynabAccount.id,
                date: upTransaction.createdAt.toLocaleDateString("sv"),
                import_id: importId,
                memo: memo,
                payee_name: upTransaction.description,
            }
            if (upTransaction.transferAccount) {
                ynabTransaction.payee_id = await getYnabTransferAccountPayeeId(upTransaction.transferAccount);
                console.log(`transferAccount:${upTransaction.transferAccount} mapped to payee_id:${ynabTransaction.payee_id}`)
            }
            context.log("Creating Transaction", ynabTransaction)
            ynabTransactionId = await ynabApi.createTransaction(ynabTransaction)
            if (ynabTransaction.payee_id && !ynabTransactionId.transfer_transaction_id) {
                context.log("WARNING: Transaction hasn't been created as a transfer.");
            }
        }
        if (ynabTransactionId.transfer_transaction_id && upTransaction.isSettled) {
            context.log("Clearing other side of transfer.", ynabTransactionId);
            await ynabApi.updateTransaction(ynabTransactionId.transfer_transaction_id, { cleared: "cleared" });
        }
    } else if (type == "TRANSACTION_DELETED") {
        context.log("Transaction deleted.")
    }

    return { status: 200, body: "" };
}
app.http("webhook", {
    methods: ["POST"],
    authLevel: "function",
    handler: webhook
});


export async function init(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const replaceExisting = request.query.get("replaceExisting") == "true";
    const account = request.query.get("account");
    if (account != "primary" && account != "secondary") {
        return { status: 403, body: "Invalid account" };
    }

    const WEBHOOK_URL = process.env["WEBHOOK_URL"];
    if (!WEBHOOK_URL) {
        return { status: 500, body: "Environmental variable WEBHOOK_URL is missing." };
    }

    const secretVariableName = `UP_${account.toUpperCase()}_WEBHOOK`
    if (process.env[secretVariableName]) {
        return { status: 500, body: `Environmental variable ${secretVariableName} is already set.` };
    }
    const webhookUrl = new URL(WEBHOOK_URL);
    webhookUrl.searchParams.set("account", account);

    const upApi = upApis[account];
    const webhooks = await upApi.getWebhooks();
    const matchingWebhooks = webhooks.filter(x => x.url == webhookUrl.toString());
    if (matchingWebhooks.length > 0 && !replaceExisting) {
        return {
            status: 500,
            body: `Found ${matchingWebhooks.length} existing webhooks using this url. Delete them with replaceExisting=true`,
        }
    }
    if (replaceExisting) {
        for (const webhook of matchingWebhooks) {
            context.log("Deleting webhook:", webhook)
            await upApi.deleteWebhook(webhook.id);
        }
    }
    const newWebhook = await upApi.newWebhook(String(webhookUrl), `up-ynab-sync ${account}`);
    const newWebhookMessage = `Save the secret as a variable in ${secretVariableName}: ${newWebhook.secretKey}`
    return { status: 200, body: newWebhookMessage }
}
app.http("init", {
    methods: ["GET"],
    authLevel: "function",
    handler: init
});



