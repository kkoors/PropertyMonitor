'use strict';
const { Router } = require('express');
const path = require('path');
const { jsPDF } = require('jspdf');
const autoTable = require('jspdf-autotable').default || require('jspdf-autotable');
const { sendBillEmail } = require('../email');

const MUNI_LABEL = { baltimore_city: 'Baltimore City', baltimore_county: 'Baltimore County', harford: 'Harford County' };

function generateBillPdf(bill, property) {
  const doc = new jsPDF();
  const muniLabel = MUNI_LABEL[property.municipality] || property.municipality;

  doc.setFontSize(18);
  doc.setTextColor(37, 99, 235);
  doc.text('Water Bill Summary', 14, 20);

  doc.setFontSize(11);
  doc.setTextColor(0, 0, 0);

  const rows = [
    ['Property', property.name],
    ['Address', property.address],
    ['Municipality', muniLabel],
    ['Account #', bill.account_number || property.account_number || '—'],
  ];
  if (bill.period_start) rows.push(['Period Start', bill.period_start]);
  if (bill.period_end)   rows.push(['Period End',   bill.period_end]);
  rows.push(['Bill Date',    bill.bill_date  || '—']);
  rows.push(['Due Date',     bill.due_date   || '—']);
  rows.push(['Amount Due',   `$${Number(bill.amount_due || 0).toFixed(2)}`]);
  if (bill.last_pay_date) {
    rows.push(['Last Payment', `$${Math.abs(Number(bill.last_pay_amount || 0)).toFixed(2)} on ${bill.last_pay_date}`]);
  }
  rows.push(['Status', bill.status]);

  autoTable(doc, {
    startY: 30,
    theme: 'grid',
    styles: { fontSize: 11, cellPadding: 4 },
    headStyles: { fillColor: [37, 99, 235] },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 45, fillColor: [243, 244, 246] } },
    body: rows,
  });

  const propName = property.name.replace(/\s+/g, '_');
  const filename = `water-bill_${propName}_${bill.bill_date || 'unknown'}.pdf`;
  return { buffer: Buffer.from(doc.output('arraybuffer')), filename };
}

module.exports = function makeEmailRouter(db) {
  const router = Router();

  router.post('/bill/:id', async (req, res) => {
    try {
      const bill = db.prepare(`SELECT * FROM bills WHERE id = ?`).get(req.params.id);
      if (!bill) return res.status(404).json({ error: 'Bill not found' });

      const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(bill.property_id);
      if (!property) return res.status(404).json({ error: 'Property not found' });

      const { buffer, filename } = generateBillPdf(bill, property);
      await sendBillEmail(bill, property, buffer, filename);
      db.prepare(`UPDATE bills SET status = 'reviewed' WHERE id = ? AND status = 'new'`).run(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[email] error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
