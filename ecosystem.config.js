'use strict';

module.exports = {
  apps: [{
    name: 'water-bills',
    script: 'server/index.js',
    cwd: '/opt/water-bills',
    env: {
      NODE_ENV: 'production',
      PORT: 3401,
      APP_URL: 'https://monitor.krsproperty.com',
      ALLOWED_DOMAIN: 'krsproperty.com',
      EMAIL_FROM: 'kevin@krsproperty.com',
      EMAIL_TO: 'krsproperty@invoices.appfolio.com',
      AZURE_TENANT_ID: 'ff28c03f-da17-4c87-8807-86260a1a619d',
      AZURE_CLIENT_ID: 'ee0f8e86-b97b-4a12-926d-22cbcb0fc1f4',
    },
  }],
};
