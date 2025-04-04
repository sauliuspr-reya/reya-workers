"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = require("./db");
async function initDatabase() {
    try {
        const createTableQuery = `
      CREATE TABLE IF NOT EXISTS transactions (
        id UUID PRIMARY KEY,
        status VARCHAR(20) NOT NULL,
        tx_hash VARCHAR(66),
        created_at TIMESTAMP NOT NULL,
        updated_at TIMESTAMP NOT NULL
      );
    `;
        await db_1.pool.query(createTableQuery);
        console.log('Database initialized successfully');
        process.exit(0);
    }
    catch (error) {
        console.error('Error initializing database:', error);
        process.exit(1);
    }
}
initDatabase();
