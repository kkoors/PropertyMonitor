'use strict';
const fetch = require('node-fetch');

const TENANT_ID = process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const FROM = process.env.EMAIL_FROM;
const TO = process.env.EMAIL_TO;

async function getAccessToken() {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });
  const resp = await fetch(url, { method: 'POST', body });
  const data = await resp.json();
  if (!data.access_token) throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function sendBillEmail(bill, property, pdfBuffer, pdfFilename) {
  const token = await getAccessToken();

  const muniLabel = { baltimore_city: 'Baltimore City', baltimore_county: 'Baltimore County', harford: 'Harford County' }[property.municipality] || property.municipality;
  const subject = `Water Bill — ${property.name} — ${bill.bill_date || 'Unknown Date'}`;

  const htmlBody = `
    <h2>Water Bill Summary</h2>
    <table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Property</td><td style="padding:6px 0"><strong>${property.name}</strong></td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Address</td><td style="padding:6px 0">${property.address}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Municipality</td><td style="padding:6px 0">${muniLabel}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Account #</td><td style="padding:6px 0">${bill.account_number || property.account_number || '—'}</td></tr>
      ${bill.period_start ? `<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Period Start</td><td style="padding:6px 0">${bill.period_start}</td></tr>` : ''}
      ${bill.period_end ? `<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Period End</td><td style="padding:6px 0">${bill.period_end}</td></tr>` : ''}
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Bill Date</td><td style="padding:6px 0">${bill.bill_date || '—'}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Due Date</td><td style="padding:6px 0">${bill.due_date || '—'}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Amount Due</td><td style="padding:6px 0"><strong style="font-size:16px">$${Number(bill.amount_due || 0).toFixed(2)}</strong></td></tr>
      ${bill.last_pay_date ? `<tr><td style="padding:6px 16px 6px 0;color:#6b7280">Last Payment</td><td style="padding:6px 0">$${Math.abs(Number(bill.last_pay_amount || 0)).toFixed(2)} on ${bill.last_pay_date}</td></tr>` : ''}
      <tr><td style="padding:6px 16px 6px 0;color:#6b7280">Status</td><td style="padding:6px 0">${bill.status}</td></tr>
    </table>
  `;

  const message = {
    subject,
    body: { contentType: 'HTML', content: htmlBody },
    toRecipients: [{ emailAddress: { address: TO } }],
  };

  if (pdfBuffer) {
    message.attachments = [{
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: pdfFilename,
      contentType: 'application/pdf',
      contentBytes: pdfBuffer.toString('base64'),
    }];
  }

  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${FROM}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Graph sendMail failed: ${resp.status} ${err}`);
  }
}

module.exports = { sendBillEmail };
