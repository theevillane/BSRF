import { Client, readSqlFile } from './db.js';
import dbConfig from '../db-config.js';

async function setupDatabase() {
  const { database, adminDatabase, ...baseConfig } = dbConfig;

  // Use admin database to create the target database
  const adminClient = new Client({ ...baseConfig, database: adminDatabase });

  try {
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${database}`);
    console.log(`Database '${database}' created successfully`);
    await adminClient.end();

    // Now connect to the newly created database
    const dbClient = new Client({ ...baseConfig, database });
    await dbClient.connect();

    const createTablesSql = await readSqlFile('create-tables.sql');
    await dbClient.query(createTablesSql);
    console.log('Tables created successfully');

    const seedDataSql = await readSqlFile('seed-data.sql');
    await dbClient.query(seedDataSql);
    console.log('Data seeded successfully');

    await dbClient.end();
  } catch (err) {
    console.error('Error setting up database:', err);
    process.exit(1);
  }
}

setupDatabase();
