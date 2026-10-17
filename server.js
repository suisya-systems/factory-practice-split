'use strict';

const http = require('node:http');
const { createApp } = require('./src/app');
const { Store } = require('./src/store');

const port = Number(process.env.PORT) || 3000;
const store = new Store(process.env.DATA_DIR);
const server = http.createServer(createApp(store));

server.listen(port, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
