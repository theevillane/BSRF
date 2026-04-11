import pkg from 'pg';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dbConfig from '../db-config.js';

export const { Client } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const client = new Client(dbConfig);

export async function readSqlFile(filename) {
  const path = join(__dirname, '../db', filename);
  return await readFile(path, 'utf8');
}
