module.exports = {
  apps: [
    {
      name: 'backend-api',
      script: 'src/index.js',
    },
    {
      name: 'doc-worker',
      script: 'src/worker/documentWorker.js',
    },
  ],
};
