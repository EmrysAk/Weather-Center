// pm2 process config for the Weather Center (port 3006 in the service table —
// see docs/LAUNCH.md).
//
//   cp .env.example .env    # set NEWSROOM_URL / NEWSROOM_TOKEN at least
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 logs weather-center

module.exports = {
  apps: [{
    name: 'weather-center',
    script: 'server.js',
    instances: 1,            // in-memory caches + the mirror are per-process
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 20,
    // The working set is small: a 20k-row mirror of the weather desk plus
    // source caches (the NWPS gauge list and CO-OPS station list are the
    // largest, a few MB each). 384M is generous.
    max_memory_restart: '384M',
    env: {
      NODE_ENV: 'production',
      ...(process.env.PORT ? { PORT: process.env.PORT } : {}),
    },
  }],
};
