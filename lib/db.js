'use strict';
// One Prisma client per warm serverless instance. Required lazily so tests can inject a fake.
let client = null;

function prisma() {
  if (!client) {
    const { PrismaClient } = require('@prisma/client');
    // Tiny traffic, so a direct (non-pooled) connection is the most compatible choice with Prisma.
    client = new PrismaClient({
      datasourceUrl: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL,
    });
  }
  return client;
}

function setClientForTests(c) { client = c; }

module.exports = { prisma, setClientForTests };
