module.exports = {
  apps: [
    {
      name: "ricky-mev",
      script: "./node_modules/.bin/ts-node",
      args: "src/mev-engine.ts",
      cwd: __dirname,
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ricky-arb",
      script: "./node_modules/.bin/ts-node",
      args: "src/arb-engine.ts",
      cwd: __dirname,
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ricky-limitless",
      script: "./node_modules/.bin/ts-node",
      args: "--transpile-only src/limitless-engine.ts",
      cwd: __dirname,
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ricky-cow",
      script: "./node_modules/.bin/ts-node",
      args: "--transpile-only src/cow-polymarket-engine.ts",
      cwd: __dirname,
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "ricky-cow-limitless",
      script: "./node_modules/.bin/ts-node",
      args: "--transpile-only src/cow-limitless-engine.ts",
      cwd: __dirname,
      interpreter: "node",
      restart_delay: 5000,
      max_restarts: 50,
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
