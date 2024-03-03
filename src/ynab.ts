

function removeEmptyProperties(data: object): object {
    return Object.fromEntries(
        Object.entries(data).filter(([, value]) => value != null && value !== "")
    )
}


function todayOffset(days: number, startOfDay = true): Date {
    const date = new Date()
    date.setDate(date.getDate() + days);
    if (startOfDay) {
        date.setHours(0, 0, 0, 0);
    }
    return date
}


class YnabCache<T> extends Map<string, T> {
    lastKnowledgeOfServer = 0;
    sinceDate?: Date;
}


export enum AccountType {
    Checking = "checking",
    Savings = "savings",
    Cash = "cash",
    CreditCard = "creditCard",
    LineOfCredit = "lineOfCredit",
    OtherAsset = "otherAsset",
    OtherLiability = "otherLiability",
    Mortgage = "mortgage",
    AutoLoan = "autoLoan",
    StudentLoan = "studentLoan",
    PersonalLoan = "personalLoan",
    MedicalDebt = "medicalDebt",
    OtherDebt = "otherDebt",
}

export type Transaction = {
    cleared: "cleared" | "uncleared" | "reconciled"
    amount?: number
    account_id?: string
    date?: string
    import_id?: string
    memo?: string
    payee_id?: string
    payee_name?: string
}

export type TransactionIds = {
    id: string,
    transfer_transaction_id?: string,
}

export type Account = {
    id: string,
    payeeId: string,
}


export class Api {
    apiKey: string;
    budgetId: string;
    private accounts = new YnabCache<Account>();
    private transactions = new YnabCache<TransactionIds>();
    constructor(apiKey: string = "", budgetId: string = "") {
        if (!apiKey || !budgetId) {
            throw "apiKey and budgetId are both required."
        }
        this.apiKey = apiKey;
        this.budgetId = budgetId;
    }
    get headers(): HeadersInit {
        return {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
        };
    }
    get baseUrl(): string {
        return `https://api.ynab.com/v1/budgets/${this.budgetId}`;
    }

    fullUrl(endpoint: string, query = {}): string {
        const queryString = new URLSearchParams(query);
        return `${this.baseUrl}/${endpoint}?${queryString}`;
    }

    async fetch(method: string, endpoint: string, query = {}, payload?: object) {
        const url = this.fullUrl(endpoint, query)
        let body: string | null = null;
        if (payload != null) {
            body = JSON.stringify(payload);
        }
        const options = {
            method,
            body,
            headers: this.headers,
        }
        const resp = await fetch(url, options)
        if (!resp.ok) {
            throw new Error(`${resp.status}: ${await resp.text()}`);
        }
        return await resp.json()
    }

    async get(endpoint: string, query = {}): Promise<any> {
        return await this.fetch('get', endpoint, query)
    }

    async patch(endpoint: string, payload: object, query = {}): Promise<any> {
        return await this.fetch('patch', endpoint, query, payload)
    }

    async post(endpoint: string, payload: object, query = {}): Promise<any> {
        return await this.fetch('post', endpoint, query, payload)
    }

    async put(endpoint: string, payload: object, query = {}): Promise<any> {
        return await this.fetch('put', endpoint, query, payload)
    }

    async getTransactionFromImportId(importId: string, transactionDate?: Date): Promise<TransactionIds | undefined> {
        const cache = this.transactions
        if (!cache.has(importId)) {
            let lastKnowledgeOfServer = cache.lastKnowledgeOfServer;
            let syncFrom = cache.sinceDate;
            if (!syncFrom) {
                syncFrom = todayOffset(-4);
            }
            if (transactionDate && transactionDate < syncFrom) {
                console.log(`Pushing back the sync date to ${transactionDate}`);
                syncFrom = transactionDate;
                lastKnowledgeOfServer = 0;
            }
            const isoDateLocale = "sv";
            const query = {
                since_date: syncFrom.toLocaleDateString(isoDateLocale),
                last_knowledge_of_server: lastKnowledgeOfServer,
            }
            console.log("Updating ynab transaction cache")
            const data = (await this.get("transactions", query)).data
            for (const transaction of data.transactions.filter((x: any) => x.import_id)) {
                const ids: TransactionIds = {
                    id: transaction.id,
                    transfer_transaction_id: transaction.transfer_transaction_id,
                }
                cache.set(transaction.import_id, ids)
            }
            cache.lastKnowledgeOfServer = data.server_knowledge;
            cache.sinceDate = syncFrom;
        }
        return cache.get(importId);
    }

    /*
    async getTransferPayeeId(accountId: string): Promise<string> {
        let cache = this.payees
        if (!cache.has(accountId)) {
            const query = {
                last_knowledge_of_server: cache.lastKnowledgeOfServer,
            }
            console.log("Updating ynab payee cache")
            const data = (await this.get("payees", query)).data
            data.payees.filter(x => x.transfer_account_id).map(
                x => cache.set(x.transfer_account_id, x.id)
            )
            cache.lastKnowledgeOfServer = data.server_knowledge;
        }
        return cache.get(accountId);
    }
    */

    async getAccount(upAccountId: string): Promise<Account | undefined> {
        const cache = this.accounts;
        if (!cache.has(upAccountId)) {
            const query = {
                last_knowledge_of_server: cache.lastKnowledgeOfServer,
            }
            console.log("Updating ynab account cache")
            const data = (await this.get("accounts", query)).data;
            for (const account of data.accounts) {
                const match = account.note?.match(/upId:([a-f0-9-]{36}\b)/i)
                if (match) {
                    cache.set(match[1], { id: account.id, payeeId: account.transfer_payee_id })
                }
            }
            cache.lastKnowledgeOfServer = data.server_knowledge;
        }
        return cache.get(upAccountId);
    }

    async createAccount(name: string, type: AccountType, upAccountId: string, balance = 0): Promise<Account> {
        const note = `upId:${upAccountId}`
        const payload = {
            account: {
                name: name.substring(0, 50),
                type: type.toString(),
                balance: balance,
                note: note,
            }
        }
        const json = await this.post("accounts", payload);
        const account = {
            id: json.data.account.id,
            payeeId: json.data.account.transfer_payee_id
        }
        this.accounts.set(upAccountId, account)
        return account
    }

    async createTransaction(transaction: Transaction): Promise<TransactionIds> {
        const payload = { transaction }
        const json = await this.post("transactions", payload);
        const import_id = json.data.transaction.import_id
        const transactionCache: TransactionIds = {
            id: json.data.transaction.id,
            transfer_transaction_id: json.data.transaction.transfer_transaction_id
        }
        if (import_id) {
            console.log(`Adding ${import_id} to transaction cache.`)
            this.transactions.set(import_id, transactionCache)
        }
        return transactionCache
    }

    async updateTransaction(id: string, transaction: Transaction) {
        const payload = { transaction: removeEmptyProperties(transaction) }
        await this.put(`transactions/${id}`, payload);
    }
}