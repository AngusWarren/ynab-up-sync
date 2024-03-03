
import { createHmac } from "crypto";

type TransactionAmount = {
    currencyCode: string,
    value: string,
    valueInBaseUnits: number,
}

export class Transaction {
    id: string;
    accountId: string;
    createdAt: Date;
    isSettled: boolean;
    description: string;
    amount: TransactionAmount;
    message: string | null;
    foreignAmount: TransactionAmount | null;
    transferAccount: string | null;
    constructor(data: any) {
        this.id = data.id;
        this.accountId = data.relationships.account.data.id;
        this.createdAt = new Date(Date.parse(data.attributes.createdAt));
        this.isSettled = data.attributes.status === "SETTLED";
        this.description = data.attributes.description;
        this.amount = data.attributes.amount;
        this.message = data.attributes.message;
        this.foreignAmount = data.attributes.foreignAmount;
        this.transferAccount = data.relationships.transferAccount.data?.id || null;
    }
}

class Webhook {
    id: string;
    url: string;
    description: string;
    createdAt: Date;
    secretKey?: string;
    constructor(data: any) {
        this.id = data.id;
        this.url = data.attributes.url;
        this.description = data.attributes.description;
        this.createdAt = new Date(Date.parse(data.attributes.createdAt));
        this.secretKey = data.attributes?.secretKey;
    }
}

export type AccountType = "SAVER" | "TRANSACTIONAL" | "HOME_LOAN";
export type AccountOwnershipType = "INDIVIDUAL" | "JOINT";

export class Account {
    id: string;
    type: AccountType;
    name: string;
    ownershipType: AccountOwnershipType;
    constructor(data: any) {
        this.id = data.id;
        this.type = data.attributes.accountType;
        this.name = data.attributes.displayName;
        this.ownershipType = data.attributes.ownershipType;
    }
}

/*
type WebhookConfig = {
    id: string;
    secret: string;
}
*/

export class Api {
    apiKey: string;
    webhookSecret?: string;
    baseUrl = "https://api.up.com.au/api/v1/";
    constructor(apiKey: string = "", webhookSecret: string = "") {
        this.apiKey = apiKey;
        this.webhookSecret = webhookSecret;
    }
    get headers(): HeadersInit {
        if (!this.apiKey) {
            throw "API key required."
        }
        return {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
        };
    }

    fullUrl(endpoint: string, query = {}): string {
        const queryString = new URLSearchParams(query);
        return `${this.baseUrl}/${endpoint}?${queryString}`;
    }

    async fetchUrl(method: string, url: string, payload?: object) {
        let body: string | null = null;
        if (payload) {
            body = JSON.stringify(payload);
        }
        const options = {
            method,
            body,
            headers: this.headers,
        }
        const resp = await fetch(url, options);
        if (!resp.ok) {
            throw new Error(`${resp.status}: ${await resp.text()}`);
        }
        return await resp.json();
    }

    async fetch(method: string, endpoint: string, query = {}, payload?: object) {
        const url = this.fullUrl(endpoint, query);
        return await this.fetchUrl(method, url, payload);
    }

    async delete(endpoint: string, query = {}): Promise<any> {
        return await this.fetch("delete", endpoint, query);
    }

    async get(endpoint: string, query = {}): Promise<any> {
        return await this.fetch("get", endpoint, query);
    }

    async getAllPages<T>(endpoint: string, query = {}): Promise<T[]> {
        let data: T[] = [];
        let nextLink: string | null = this.fullUrl(endpoint, query);
        while (nextLink) {
            const json: any = await this.fetchUrl("get", nextLink);
            data = data.concat(json.data);
            nextLink = json.links.next;
        }
        return data;
    }

    async post(endpoint: string, payload: object, query = {}): Promise<any> {
        return await this.fetch("post", endpoint, query, payload);
    }

    async getTransaction(id: string): Promise<Transaction> {
        const json = await this.get(`transactions/${id}`);
        return new Transaction(json.data);
    }

    async getAccount(id: string): Promise<Account> {
        const json = await this.get(`accounts/${id}`);
        return new Account(json.data);
    }

    async getWebhooks(): Promise<Webhook[]> {
        const webhooks: Webhook[] = [];
        for (const item of await this.getAllPages("webhooks")) {
            webhooks.push(new Webhook(item));
        }
        return webhooks;
    }

    async newWebhook(url: string, description: string): Promise<Webhook> {
        const payload = {
            data: {
                attributes: {
                    url,
                    description,
                }
            }
        }
        const json = await this.post("webhooks", payload);
        return new Webhook(json.data);
    }

    async deleteWebhook(id: string) {
        await this.delete(`webhooks/${id}`);
    }

    validateWebhookSignature(body: string, signature: string | null): boolean {
        if (!signature || !this.webhookSecret) {
            return false
        }
        const calculatedSignature = createHmac("sha256", this.webhookSecret).update(body).digest("hex");
        return calculatedSignature === signature;
    }
}
