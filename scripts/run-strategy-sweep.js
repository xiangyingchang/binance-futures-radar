'use strict';

const handler = require('../api/strategy-sweep-30d');

const req = { method: 'GET' };
const res = {
  statusCode: 200,
  headers: {},
  setHeader(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(payload) {
    console.log(JSON.stringify({ statusCode: this.statusCode, payload }, null, 2));
    if (this.statusCode >= 400) process.exitCode = 1;
    return payload;
  },
};

Promise.resolve(handler(req, res)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});