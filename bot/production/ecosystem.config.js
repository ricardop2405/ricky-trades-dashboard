module.exports = {
  apps: [
    {
      name: "ricky-mev",
      script: "npx",
      args: "ts-node src/mev-engine.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ricky-arb",
      script: "npx",
      args: "ts-node src/arb-engine.ts",
      cwd: __dirname,
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
