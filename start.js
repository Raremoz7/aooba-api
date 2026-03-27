const { execSync } = require('child_process');
const path = require('path');

// Run Prisma migrate deploy
try {
  console.log('Running Prisma migrate deploy...');
  execSync('npx prisma migrate deploy', { stdio: 'inherit', cwd: __dirname });
  console.log('Migrations applied successfully!');
} catch (e) {
  console.log('Migration warning (may already be applied):', e.message);
}

// Run init-db
try {
  console.log('Running init-db...');
  require('./init-db');
} catch (e) {
  console.log('Init-db warning:', e.message);
}

// Wait a bit for init-db to finish, then start server
setTimeout(() => {
  console.log('Starting server...');
  require('./src/index.js');
}, 3000);
