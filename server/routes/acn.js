'use strict';
const { Router } = require('express');
const { sendConfiguredEmail } = require('../email');

// Utility ACN program: the utility puts service back in our name automatically
// when a tenant shuts it off. Enrolling and disenrolling is done by emailing
// the utility, so the app sends the notice and tracks the pending state until
// the utility confirms.
const STATUSES = ['not_enrolled', 'pending_enrollment', 'enrolled', 'pending_disenrollment', 'na'];

const STATUS_LABEL = {
  not_enrolled: 'Not Enrolled',
  pending_enrollment: 'Pending Enrollment',
  enrolled: 'Enrolled',
  pending_disenrollment: 'Pending Disenrollment',
  na: 'N/A',
};

const MUNI_LABEL = {
  baltimore_city: 'Baltimore City',
  baltimore_county: 'Baltimore County',
  harford: 'Harford County',
};

const TEMPLATE_KEYS = {
  enroll: { to: 'acn_enroll_to', cc: 'acn_enroll_cc', subject: 'acn_enroll_subject', body: 'acn_enroll_body' },
  disenroll: { to: 'acn_disenroll_to', cc: 'acn_disenroll_cc', subject: 'acn_disenroll_subject', body: 'acn_disenroll_body' },
};

const DEFAULTS = {
  enroll: {
    subject: 'ACN Enrollment Request — {{property_name}}',
    body: [
      '<p>Please enroll the following property in the ACN program:</p>',
      '<p><strong>{{address}}</strong><br/>',
      'Account #: {{account_number}}<br/>',
      'Owner: {{owner_name}}<br/>',
      'Jurisdiction: {{municipality}}</p>',
      '<p>Please confirm once the property has been added.</p>',
    ].join('\n'),
  },
  disenroll: {
    subject: 'ACN Disenrollment Request — {{property_name}}',
    body: [
      '<p>Please remove the following property from the ACN program:</p>',
      '<p><strong>{{address}}</strong><br/>',
      'Account #: {{account_number}}<br/>',
      'Owner: {{owner_name}}<br/>',
      'Jurisdiction: {{municipality}}</p>',
      '<p>Please confirm once the property has been removed.</p>',
    ].join('\n'),
  },
};

// {{placeholder}} substitution shared by the subject and the body.
function fillTemplate(text, property) {
  const values = {
    property_name: property.name || '',
    address: property.address || '',
    account_number: property.account_number || '',
    owner_name: property.owner_name || '',
    owner_address: property.owner_address || '',
    municipality: MUNI_LABEL[property.municipality] || property.municipality || '',
    tax_id: property.tax_id || '',
    today: new Date().toISOString().slice(0, 10),
  };
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : m);
}

module.exports = function makeAcnRouter(db) {
  const router = Router();
  const aw = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  function getSetting(key) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return row ? row.value : null;
  }

  function loadTemplate(kind) {
    const keys = TEMPLATE_KEYS[kind];
    return {
      to: getSetting(keys.to) || '',
      cc: getSetting(keys.cc) || '',
      subject: getSetting(keys.subject) || DEFAULTS[kind].subject,
      body: getSetting(keys.body) || DEFAULTS[kind].body,
    };
  }

  function statusOf(p) {
    if (p.acn_not_monitored) return { status: 'na', label: 'Not monitored', monitored: false };
    const key = STATUSES.includes(p.acn_status) ? p.acn_status : 'not_enrolled';
    return { status: key, label: STATUS_LABEL[key], monitored: true };
  }

  // Property list with ACN state
  router.get('/', (req, res) => {
    const props = db.prepare(
      `SELECT id, name, address, municipality, account_number, owner_name, acn_status,
              acn_not_monitored, acn_updated_at, acn_note
         FROM properties WHERE active = 1 ORDER BY name`
    ).all();
    res.json(props.map(p => ({ ...p, acn: statusOf(p) })));
  });

  // Both email templates, with the defaults filled in where unset
  router.get('/templates', (req, res) => {
    res.json({ enroll: loadTemplate('enroll'), disenroll: loadTemplate('disenroll') });
  });

  router.put('/templates/:kind', (req, res) => {
    const kind = req.params.kind;
    if (!TEMPLATE_KEYS[kind]) return res.status(400).json({ error: 'Unknown template' });
    const keys = TEMPLATE_KEYS[kind];
    for (const field of ['to', 'cc', 'subject', 'body']) {
      const value = req.body[field];
      db.prepare(`DELETE FROM settings WHERE key = ?`).run(keys[field]);
      if (value != null && value !== '') {
        db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run(keys[field], String(value));
      }
    }
    res.json(loadTemplate(kind));
  });

  // What would be sent for this property — lets the settings page preview a
  // real property before anything goes out.
  router.get('/preview/:kind/:propertyId', (req, res) => {
    const kind = req.params.kind;
    if (!TEMPLATE_KEYS[kind]) return res.status(400).json({ error: 'Unknown template' });
    const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });
    const t = loadTemplate(kind);
    res.json({
      to: t.to, cc: t.cc,
      subject: fillTemplate(t.subject, property),
      html: fillTemplate(t.body, property),
    });
  });

  function sendFor(kind, nextStatus) {
    return aw(async (req, res) => {
      const property = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
      if (!property) return res.status(404).json({ error: 'Not found' });
      if (property.acn_not_monitored) return res.status(400).json({ error: 'Property is not monitored for ACN' });

      const t = loadTemplate(kind);
      if (!t.to) {
        return res.status(400).json({ error: `No recipient configured — set one on the ACN Email Setup page` });
      }

      const subject = fillTemplate(t.subject, property);
      const html = fillTemplate(t.body, property);
      try {
        await sendConfiguredEmail({ to: t.to, cc: t.cc, subject, html });
      } catch (err) {
        // Status only advances if the email actually went out.
        return res.status(422).json({ error: `Email failed: ${err.message}` });
      }

      db.prepare(`UPDATE properties SET acn_status = ?, acn_updated_at = datetime('now') WHERE id = ?`)
        .run(nextStatus, property.id);
      const updated = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(property.id);
      res.json({ sent: { to: t.to, subject }, acn: statusOf(updated) });
    });
  }

  router.post('/:propertyId/enroll', sendFor('enroll', 'pending_enrollment'));
  router.post('/:propertyId/disenroll', sendFor('disenroll', 'pending_disenrollment'));

  // Manual status change — used to confirm the utility's reply
  router.patch('/:propertyId/status', (req, res) => {
    const { status, note } = req.body || {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
    }
    const property = db.prepare(`SELECT id FROM properties WHERE id = ?`).get(req.params.propertyId);
    if (!property) return res.status(404).json({ error: 'Not found' });

    db.prepare(`UPDATE properties SET acn_status = ?, acn_note = ?, acn_updated_at = datetime('now') WHERE id = ?`)
      .run(status, note != null ? String(note) : null, req.params.propertyId);
    const updated = db.prepare(`SELECT * FROM properties WHERE id = ?`).get(req.params.propertyId);
    res.json({ acn: statusOf(updated), acn_updated_at: updated.acn_updated_at });
  });

  return router;
};

module.exports.STATUSES = STATUSES;
module.exports.STATUS_LABEL = STATUS_LABEL;
module.exports.fillTemplate = fillTemplate;
