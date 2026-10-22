/**
 * PM2 example. Build first (`npm run build`), then:
 *   pm2 start ecosystem.config.cjs
 * Secrets stay in the environment / .env file, never in this file.
 */
module.exports = {
  apps: [
    {
      name: 'simtrade-demo',
      script: 'dist/server.js',
      instances: 1, // SQLite + in-process settlement must stay single-instance
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: 3000,
      },
      out_file: './data/logs/out.log',
      error_file: './data/logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
