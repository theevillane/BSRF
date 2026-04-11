// Editable PostgreSQL configuration for development setup
// Update the values below to match your local PostgreSQL setup

export default {
  user: 'postgres', // Your PostgreSQL username
  host: 'localhost', // Your PostgreSQL host (usually localhost)
  database: 'mydb', // The DB your app will use (make sure this doesn't exist yet)
  adminDatabase: 'postgres', // The DB used when creating/dropping the app DB (make sure this exists)
  password: 'password', // Your PostgreSQL password (leave empty if no password)
  port: 5432, // Your PostgreSQL port (default is 5432)
};
