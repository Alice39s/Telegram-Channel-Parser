import { Database } from 'bun:sqlite';
import fs from 'fs';
import { logger } from '..';
import type { DataMessages } from '../types'

const MAX_CONTENT_LENGTH = 1000000; // ~1MB
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // ms, = 1 second

export const initDatabase = async (): Promise<Database> => {
  logger.info("Initializing database...");
  const dbPath = Bun.env.MESSAGE_SQLITE_FILE || "./database/messages.db";
  const dbDir = dbPath.substring(0, dbPath.lastIndexOf('/'));

  try {
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const isNew = !fs.existsSync(dbPath);
    const database = new Database(dbPath);

    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA journal_mode = WAL;');

    if (isNew) {
      const initSQL = fs.readFileSync("./database/init.sql", "utf8");
      database.transaction(() => {
        database.exec(initSQL);
      })();
    }

    logger.info("Database initialized successfully");
    return database;
  } catch (error: any) {
    logger.error(`Database initialization failed: ${error.message}`);
    throw new Error(`Failed to initialize database: ${error.message}`);
  }
};

export class MessageManager {
  private database: Database;
  private static instance: MessageManager | null = null;
  private retryCount: Map<string, number> = new Map();

  private constructor(database: Database) {
    this.database = database;
  }

  public static getInstance(database: Database): MessageManager {
    if (!MessageManager.instance) {
      MessageManager.instance = new MessageManager(database);
    }
    return MessageManager.instance;
  }

  private async retry<T>(operation: () => Promise<T>, key: string): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      const currentRetries = this.retryCount.get(key) || 0;
      if (currentRetries < MAX_RETRIES && this.isRetryableError(error)) {
        this.retryCount.set(key, currentRetries + 1);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return this.retry(operation, key);
      }
      this.retryCount.delete(key);
      throw error;
    }
  }

  private isRetryableError(error: Error): boolean {
    return error.message.includes('database is locked') ||
      error.message.includes('busy') ||
      error.message.includes('no response');
  }

  public async messageExists(messageId: number): Promise<boolean> {
    return this.retry(async () => {
      this.validateMessageId(messageId);
      const stmt = this.database.prepare(
        'SELECT 1 FROM messages WHERE message_id = ? LIMIT 1'
      );
      return stmt.get(messageId) !== null;
    }, `messageExists_${messageId}`);
  }

  public async deleteMessage(messageId: number): Promise<void> {
    return this.retry(async () => {
      this.validateMessageId(messageId);
      const result = this.database.transaction(() => {
        const stmt = this.database.prepare(
          'DELETE FROM messages WHERE message_id = ?'
        );
        return stmt.run(messageId);
      })();

      if (result.changes === 0) {
        throw new Error('Message not found');
      }
    }, `deleteMessage_${messageId}`);
  }

  public async getMessage(messageId: number): Promise<DataMessages | null> {
    return this.retry(async () => {
      this.validateMessageId(messageId);

      const stmt = this.database.prepare(`
        SELECT rowid as id, message_id, content, created_at, updated_at 
        FROM messages 
        WHERE message_id = ? 
        LIMIT 1
      `);

      return stmt.get(messageId) as DataMessages | null;
    }, `getMessage_${messageId}`);
  }

  public async getMessages(): Promise<DataMessages[]> {
    return this.retry(async () => {
      const stmt = this.database.prepare(
        'SELECT rowid as id, message_id, content, created_at, updated_at FROM messages'
      );
      return stmt.all() as Array<DataMessages>;
    }, 'getMessages');
  }

  public async insertMessage(messageId: number, content: string, createdTimestamp: number, updatedTimestamp: number): Promise<void> {
    return this.retry(async () => {
      this.validateMessageId(messageId);
      this.validateContent(content);
      this.validateTimestamps(createdTimestamp, updatedTimestamp);

      const exists = await this.messageExists(messageId);
      if (exists) {
        throw new Error(`Message with ID ${messageId} already exists`);
      }

      this.database.transaction(() => {
        const stmt = this.database.prepare(`
          INSERT INTO messages (message_id, content, created_at, updated_at) 
          VALUES (?, ?, ?, ?)
        `);
        stmt.run(messageId, content, createdTimestamp, updatedTimestamp);
      })();
    }, `insertMessage_${messageId}`);
  }


  public async updateMessage(messageId: number, content: string): Promise<void> {
    return this.retry(async () => {
      this.validateMessageId(messageId);
      this.validateContent(content);

      const now = Date.now();

      const result = this.database.transaction(() => {
        const stmt = this.database.prepare(`
          UPDATE messages 
          SET content = ?, updated_at = ? 
          WHERE message_id = ?
        `);
        return stmt.run(content, now, messageId);
      })();

      if (result.changes === 0) {
        throw new Error(`Message with ID ${messageId} not found`);
      }
    }, `updateMessage_${messageId}`);
  }

  private validateMessageId(messageId: number): void {
    if (!Number.isInteger(messageId) || messageId <= 0 || messageId > Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid message ID: must be a positive integer within safe range');
    }
  }
  private validateTimestamps(createdAt: number, updatedAt: number): void {
    if (!Number.isInteger(createdAt) || createdAt <= 0) {
      throw new Error('Invalid created_at timestamp: must be a positive integer');
    }

    if (!Number.isInteger(updatedAt) || updatedAt <= 0) {
      throw new Error('Invalid updated_at timestamp: must be a positive integer');
    }

    if (updatedAt < createdAt) {
      throw new Error('updated_at timestamp cannot be earlier than created_at timestamp');
    }
  }

  private validateContent(content: string): void {
    if (typeof content !== 'string') {
      throw new TypeError('Content must be a string');
    }

    const trimmedContent = content.trim();
    if (trimmedContent.length === 0) {
      throw new Error('Content cannot be empty');
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_LENGTH) {
      throw new Error(`Content exceeds maximum length limit of ${MAX_CONTENT_LENGTH} bytes`);
    }
  }

  public async getMessageCount(): Promise<number> {
    return this.retry(async () => {
      const stmt = this.database.prepare('SELECT COUNT(*) as count FROM messages');
      const result = stmt.get() as { count: number };
      return result.count;
    }, 'getMessageCount');
  }
}

let messageManagerInstance: MessageManager | null = null;
let databaseInstance: Database | null = null;

export const getMessageManager = async (): Promise<MessageManager> => {
  if (!messageManagerInstance) {
    if (!databaseInstance) {
      databaseInstance = await initDatabase();
    }
    messageManagerInstance = MessageManager.getInstance(databaseInstance);
  }
  return messageManagerInstance;
};

export const getMessages = async (): Promise<DataMessages[]> => {
  const manager = await getMessageManager();
  return manager.getMessages();
};

export const insertMessage = async (messageId: number, content: string, createdTimestamp: number, updatedTimestamp: number): Promise<void> => {
  const manager = await getMessageManager();
  return manager.insertMessage(messageId, content, createdTimestamp, updatedTimestamp);
};

export const deleteMessage = async (messageId: number): Promise<void> => {
  const manager = await getMessageManager();
  return manager.deleteMessage(messageId);
};

export const getMessage = async (messageId: number): Promise<DataMessages | null> => {
  const manager = await getMessageManager();
  return manager.getMessage(messageId);
};

export const updateMessage = async (messageId: number, content: string): Promise<void> => {
  const manager = await getMessageManager();
  return manager.updateMessage(messageId, content);
};

export const getMessageCount = async (): Promise<number> => {
  const manager = await getMessageManager();
  return manager.getMessageCount();
};

export const messageExists = async (messageId: number): Promise<boolean> => {
  const manager = await getMessageManager();
  return manager.messageExists(messageId);
};