import { Client } from './db.js';
import dbConfig from '../db-config.js';

async function cleanupDatabase() {
  const { database, adminDatabase, ...baseConfig } = dbConfig;

  const adminClient = new Client({ ...baseConfig, database: adminDatabase });

  try {
    await adminClient.connect();
    await adminClient.query(`DROP DATABASE IF EXISTS ${database}`);
    console.log(`Database '${database}' dropped successfully`);
  } catch (err) {
    console.error('Error cleaning up database:', err);
    process.exit(1);
  } finally {
    await adminClient.end();
  }
}

cleanupDatabase();
