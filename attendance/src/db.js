'use strict';
const { Pool } = require('pg');

// Connection is configured via environment variables.
// Set DATABASE_URL or individual PG* vars in your .env file.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // If DATABASE_URL is not set, pg falls back to:
  //   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL error:', err);
});

module.exports = pool;
