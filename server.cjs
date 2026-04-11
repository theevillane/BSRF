const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'client')));

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'mydb',
  password: 'password',
  port: 5432
});

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const okStatuses = ['available', 'rented', 'maintenance'];

const fail = (res, err, tag) => {
  console.error(`[${tag}]`, err.message);
  return res.status(500).json({ error: err.message });
};

function required(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') return `Field ${f} is required`;
  }
  return null;
}

function ageFromDob(dob) {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function deriveMember(dob) {
  const age = ageFromDob(dob);
  if (age === null) return null;
  if (age < 14) return { member_type: 'child', monthly_fee: 0 };
  if (age <= 64) return { member_type: 'adult', monthly_fee: 12.5 };
  if (age <= 70) return { member_type: 'senior_citizen', monthly_fee: 8.0 };
  return { member_type: 'adult', monthly_fee: 12.5 };
}

function isValidDate(value) {
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

function toInt(value) {
  const n = Number.parseInt(String(value), 10);
  return Number.isNaN(n) ? null : n;
}

function toNum(value) {
  const n = Number.parseFloat(String(value));
  return Number.isNaN(n) ? null : n;
}

function requirePositive(value, fieldName) {
  const n = toNum(value);
  if (n === null) return { ok: false, error: `Field ${fieldName} must be a number` };
  if (n <= 0) return { ok: false, error: `Field ${fieldName} must be greater than 0` };
  return { ok: true, value: n };
}

app.post('/api/contact', async (req, res) => {
  try {
    console.log('[CONTACT]', req.body);
    res.json({ success: true, message: 'Thank you for your enquiry. We will respond within 2 business days.' });
  } catch (err) { fail(res, err, 'POST /api/contact'); }
});

app.get('/api/stats', async (req, res) => {
  try {
    const [t, b, s, m, a, o] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM service_terminal'),
      pool.query("SELECT COUNT(*)::int AS count FROM bicycle WHERE status='available'"),
      pool.query("SELECT COUNT(*)::int AS count FROM e_scooter WHERE status='available'"),
      pool.query("SELECT COUNT(*)::int AS count FROM member WHERE membership_status='active'"),
      pool.query("SELECT COUNT(*)::int AS count FROM rental WHERE status='active'"),
      pool.query("SELECT COUNT(*)::int AS count FROM rental WHERE status='overdue'")
    ]);
    res.json({
      terminals: t.rows[0].count, availableBicycles: b.rows[0].count, availableScooters: s.rows[0].count,
      activeMembers: m.rows[0].count, activeRentals: a.rows[0].count, overdueRentals: o.rows[0].count
    });
  } catch (err) { fail(res, err, 'GET /api/stats'); }
});

app.get('/api/terminals', async (req, res) => {
  try {
    const r = await pool.query(`SELECT
        st.*,
      COALESCE(bc.cnt, 0)::int AS current_bicycle_count,
      COALESCE(sc.cnt, 0)::int AS current_scooter_count,
      sp.company_name AS sponsor_name,
      sa.logo_placement AS sponsor_logo_placement,
      CASE
        WHEN sp.sponsor_id IS NULL THEN NULL
        WHEN sp.end_date < CURRENT_DATE THEN 'expired'
        WHEN sp.end_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
        ELSE 'active'
      END AS sponsor_contract_status
      FROM service_terminal st
      LEFT JOIN (SELECT terminal_id, COUNT(*) cnt FROM bicycle WHERE status='available' GROUP BY terminal_id) bc ON bc.terminal_id=st.terminal_id
      LEFT JOIN (SELECT terminal_id, COUNT(*) cnt FROM e_scooter WHERE status='available' GROUP BY terminal_id) sc ON sc.terminal_id=st.terminal_id
      LEFT JOIN sponsorship_asset sa ON sa.asset_type='terminal' AND sa.asset_id = st.terminal_id
      LEFT JOIN sponsor sp ON sp.sponsor_id = sa.sponsor_id
      ORDER BY st.city, st.terminal_name`);
    res.json(r.rows);
  } catch (err) { fail(res, err, 'GET /api/terminals'); }
});
app.get('/api/terminals/:id', async (req, res) => {
  try {
    const r = await pool.query(`SELECT st.*, COALESCE(dc.cnt,0)::int AS dock_count
      FROM service_terminal st
      LEFT JOIN (SELECT terminal_id, COUNT(*) cnt FROM parking_dock GROUP BY terminal_id) dc ON dc.terminal_id = st.terminal_id
      WHERE st.terminal_id = $1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Terminal not found' });
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'GET /api/terminals/:id'); }
});
app.post('/api/terminals', async (req, res) => {
  try {
    const msg = required(req.body, ['terminal_name', 'street_address', 'city', 'phone', 'max_bicycle_cap', 'max_scooter_cap']);
    if (msg) return res.status(400).json({ error: msg });
    if (String(req.body.phone).length < 10) return res.status(400).json({ error: 'Phone must be at least 10 characters' });
    const bikeCap = requirePositive(req.body.max_bicycle_cap, 'max_bicycle_cap'); if (!bikeCap.ok) return res.status(400).json({ error: bikeCap.error });
    const scooterCap = requirePositive(req.body.max_scooter_cap, 'max_scooter_cap'); if (!scooterCap.ok) return res.status(400).json({ error: scooterCap.error });
    const r = await pool.query('INSERT INTO service_terminal (terminal_name,street_address,city,phone,max_bicycle_cap,max_scooter_cap) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.body.terminal_name, req.body.street_address, req.body.city, req.body.phone, Math.trunc(bikeCap.value), Math.trunc(scooterCap.value)]);
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'POST /api/terminals'); }
});
app.put('/api/terminals/:id', async (req, res) => {
  try {
    const msg = required(req.body, ['terminal_name', 'street_address', 'city', 'phone', 'max_bicycle_cap', 'max_scooter_cap']);
    if (msg) return res.status(400).json({ error: msg });
    if (String(req.body.phone).length < 10) return res.status(400).json({ error: 'Phone must be at least 10 characters' });
    const bikeCap = requirePositive(req.body.max_bicycle_cap, 'max_bicycle_cap'); if (!bikeCap.ok) return res.status(400).json({ error: bikeCap.error });
    const scooterCap = requirePositive(req.body.max_scooter_cap, 'max_scooter_cap'); if (!scooterCap.ok) return res.status(400).json({ error: scooterCap.error });
    const r = await pool.query(`UPDATE service_terminal SET terminal_name=$1, street_address=$2, city=$3, phone=$4,
      max_bicycle_cap=$5, max_scooter_cap=$6 WHERE terminal_id=$7 RETURNING *`,
    [req.body.terminal_name, req.body.street_address, req.body.city, req.body.phone, Math.trunc(bikeCap.value), Math.trunc(scooterCap.value), req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Terminal not found' });
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'PUT /api/terminals/:id'); }
});
app.delete('/api/terminals/:id', async (req, res) => {
  try {
    const c = await pool.query('SELECT (SELECT COUNT(*) FROM bicycle WHERE terminal_id=$1)::int AS bikes, (SELECT COUNT(*) FROM e_scooter WHERE terminal_id=$1)::int AS scooters', [req.params.id]);
    if (c.rows[0].bikes > 0 || c.rows[0].scooters > 0) return res.status(409).json({ error: 'Cannot delete: terminal has assets assigned to it' });
    await pool.query('DELETE FROM service_terminal WHERE terminal_id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'DELETE /api/terminals/:id'); }
});

app.get('/api/docks', async (req, res) => {
  try { const r = await pool.query('SELECT d.*, st.terminal_name FROM parking_dock d JOIN service_terminal st ON st.terminal_id=d.terminal_id ORDER BY st.city, d.dock_name'); res.json(r.rows); }
  catch (err) { fail(res, err, 'GET /api/docks'); }
});
app.get('/api/docks/:id', async (req, res) => {
  try { const r = await pool.query('SELECT * FROM parking_dock WHERE dock_id=$1', [req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Dock not found' }); res.json(r.rows[0]); }
  catch (err) { fail(res, err, 'GET /api/docks/:id'); }
});
app.post('/api/docks', async (req, res) => {
  try {
    const msg = required(req.body, ['terminal_id', 'dock_name', 'location', 'capacity']);
    if (msg) return res.status(400).json({ error: msg });
    const terminalId = toInt(req.body.terminal_id); if (terminalId === null) return res.status(400).json({ error: 'Field terminal_id must be a number' });
    const cap = requirePositive(req.body.capacity, 'capacity'); if (!cap.ok) return res.status(400).json({ error: cap.error });
    const r = await pool.query('INSERT INTO parking_dock (terminal_id,dock_name,location,capacity) VALUES ($1,$2,$3,$4) RETURNING *', [terminalId, req.body.dock_name, req.body.location, Math.trunc(cap.value)]);
    res.json(r.rows[0]);
  }
  catch (err) { fail(res, err, 'POST /api/docks'); }
});
app.put('/api/docks/:id', async (req, res) => {
  try {
    const msg = required(req.body, ['terminal_id', 'dock_name', 'location', 'capacity']);
    if (msg) return res.status(400).json({ error: msg });
    const terminalId = toInt(req.body.terminal_id); if (terminalId === null) return res.status(400).json({ error: 'Field terminal_id must be a number' });
    const cap = requirePositive(req.body.capacity, 'capacity'); if (!cap.ok) return res.status(400).json({ error: cap.error });
    const r = await pool.query('UPDATE parking_dock SET terminal_id=$1,dock_name=$2,location=$3,capacity=$4 WHERE dock_id=$5 RETURNING *', [terminalId, req.body.dock_name, req.body.location, Math.trunc(cap.value), req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Dock not found' });
    res.json(r.rows[0]);
  }
  catch (err) { fail(res, err, 'PUT /api/docks/:id'); }
});
app.delete('/api/docks/:id', async (req, res) => {
  try { const c = await pool.query('SELECT COUNT(*)::int AS count FROM rental WHERE return_dock_id=$1', [req.params.id]); if (c.rows[0].count > 0) return res.status(409).json({ error: 'Cannot delete: dock is used by rentals' }); await pool.query('DELETE FROM parking_dock WHERE dock_id=$1', [req.params.id]); res.json({ success: true }); }
  catch (err) { fail(res, err, 'DELETE /api/docks/:id'); }
});

app.get('/api/fleet', async (req, res) => {
  try {
    const values = [];
    const clauses = [];
    if (req.query.type === 'bicycle' || req.query.type === 'scooter') { values.push(req.query.type); clauses.push(`asset_type = $${values.length}`); }
    if (okStatuses.includes(req.query.status)) { values.push(req.query.status); clauses.push(`status = $${values.length}`); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await pool.query(`SELECT * FROM (
      SELECT 'bicycle' AS asset_type, b.bicycle_id AS asset_id, b.terminal_id, b.make, b.model, b.size, b.bicycle_type AS subtype, NULL::text AS colour, b.gps_sensor_id, b.status, st.terminal_name, st.city,
        sp.company_name AS sponsor_name,
        sa.logo_placement AS logo_placement
      FROM bicycle b JOIN service_terminal st ON st.terminal_id=b.terminal_id
      LEFT JOIN sponsorship_asset sa ON sa.asset_type='bicycle' AND sa.asset_id=b.bicycle_id
      LEFT JOIN sponsor sp ON sp.sponsor_id=sa.sponsor_id
      UNION ALL
      SELECT 'scooter' AS asset_type, s.scooter_id AS asset_id, s.terminal_id, NULL::text AS make, s.model, s.size, NULL::text AS subtype, s.colour, s.gps_sensor_id, s.status, st.terminal_name, st.city,
        sp.company_name AS sponsor_name,
        sa.logo_placement AS logo_placement
      FROM e_scooter s JOIN service_terminal st ON st.terminal_id=s.terminal_id
      LEFT JOIN sponsorship_asset sa ON sa.asset_type='scooter' AND sa.asset_id=s.scooter_id
      LEFT JOIN sponsor sp ON sp.sponsor_id=sa.sponsor_id
    ) z ${where} ORDER BY city, terminal_name, asset_id`, values);
    res.json(r.rows);
  } catch (err) { fail(res, err, 'GET /api/fleet'); }
});
app.get('/api/bicycles', async (req, res) => { try { const r = await pool.query('SELECT b.*, st.terminal_name, st.city FROM bicycle b JOIN service_terminal st ON st.terminal_id=b.terminal_id ORDER BY b.bicycle_id'); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/bicycles'); } });
app.get('/api/bicycles/:id', async (req, res) => { try { const r = await pool.query('SELECT * FROM bicycle WHERE bicycle_id=$1', [req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Bicycle not found' }); res.json(r.rows[0]); } catch (err) { fail(res, err, 'GET /api/bicycles/:id'); } });
// POST /api/bicycles — insert new bicycle
app.post('/api/bicycles', async (req, res) => {
  try {
    const { terminal_id, make, model, size, bicycle_type, gps_sensor_id } = req.body;

    if (!terminal_id || !make || !model || !size || !bicycle_type || !gps_sensor_id) {
      return res.status(400).json({ error: 'All bicycle fields are required.' });
    }
    const validTypes = ['child', 'adult', 'senior_citizen'];
    if (!validTypes.includes(bicycle_type)) {
      return res.status(400).json({ error: "bicycle_type must be 'child', 'adult', or 'senior_citizen'." });
    }

    const result = await pool.query(
      `INSERT INTO bicycle (terminal_id, make, model, size, bicycle_type, gps_sensor_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'available') RETURNING *`,
      [terminal_id, make.trim(), model.trim(), size.trim(), bicycle_type, gps_sensor_id.trim()]
    );

    const enriched = await pool.query(
      `SELECT b.*, st.terminal_name, st.city
       FROM bicycle b
       JOIN service_terminal st ON st.terminal_id = b.terminal_id
       WHERE b.bicycle_id = $1`,
      [result.rows[0].bicycle_id]
    );
    res.status(201).json(enriched.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `GPS sensor ID '${req.body.gps_sensor_id}' already exists.` });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: `Terminal ID ${req.body.terminal_id} does not exist.` });
    }
    console.error('[POST /api/bicycles]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/bicycles/:id — update bicycle
app.put('/api/bicycles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { terminal_id, make, model, size, bicycle_type, gps_sensor_id, status } = req.body;

    // allow partial updates (e.g. status only) by filling missing fields
    const existing = await pool.query('SELECT * FROM bicycle WHERE bicycle_id=$1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: `Bicycle ${id} not found.` });
    const cur = existing.rows[0];
    terminal_id = terminal_id ?? cur.terminal_id;
    make = make ?? cur.make;
    model = model ?? cur.model;
    size = size ?? cur.size;
    bicycle_type = bicycle_type ?? cur.bicycle_type;
    gps_sensor_id = gps_sensor_id ?? cur.gps_sensor_id;
    status = status ?? cur.status;

    const result = await pool.query(
      `UPDATE bicycle
       SET terminal_id=$1, make=$2, model=$3, size=$4, bicycle_type=$5, gps_sensor_id=$6, status=$7
       WHERE bicycle_id=$8
       RETURNING *`,
      [terminal_id, make.trim(), model.trim(), size.trim(), bicycle_type, gps_sensor_id.trim(), status, id]
    );

    const enriched = await pool.query(
      `SELECT b.*, st.terminal_name, st.city FROM bicycle b
       JOIN service_terminal st ON st.terminal_id = b.terminal_id
       WHERE b.bicycle_id = $1`, [id]
    );
    res.json(enriched.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `GPS sensor ID '${req.body.gps_sensor_id}' already exists.` });
    }
    console.error('[PUT /api/bicycles/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/bicycles/:id
app.delete('/api/bicycles/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const activeRentals = await pool.query(
      `SELECT COUNT(*) FROM rental WHERE bicycle_id = $1 AND status IN ('active','overdue')`, [id]
    );
    if (parseInt(activeRentals.rows[0].count, 10) > 0) {
      return res.status(409).json({ error: 'Cannot delete: bicycle has active or overdue rentals.' });
    }
    const result = await pool.query(
      `DELETE FROM bicycle WHERE bicycle_id = $1 RETURNING make, model`, [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Bicycle ${id} not found.` });
    }
    res.json({ message: `Bicycle '${result.rows[0].make} ${result.rows[0].model}' deleted successfully.` });
  } catch (err) {
    console.error('[DELETE /api/bicycles/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/scooters', async (req, res) => { try { const r = await pool.query('SELECT s.*, st.terminal_name, st.city FROM e_scooter s JOIN service_terminal st ON st.terminal_id=s.terminal_id ORDER BY s.scooter_id'); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/scooters'); } });
app.get('/api/scooters/:id', async (req, res) => { try { const r = await pool.query('SELECT * FROM e_scooter WHERE scooter_id=$1', [req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Scooter not found' }); res.json(r.rows[0]); } catch (err) { fail(res, err, 'GET /api/scooters/:id'); } });
// POST /api/scooters — insert new e-scooter
app.post('/api/scooters', async (req, res) => {
  try {
    const { terminal_id, size, colour, model, gps_sensor_id } = req.body;

    if (!terminal_id || !size || !colour || !model || !gps_sensor_id) {
      return res.status(400).json({ error: 'All e-scooter fields are required.' });
    }

    const result = await pool.query(
      `INSERT INTO e_scooter (terminal_id, size, colour, model, gps_sensor_id, status)
       VALUES ($1, $2, $3, $4, $5, 'available') RETURNING *`,
      [terminal_id, size.trim(), colour.trim(), model.trim(), gps_sensor_id.trim()]
    );

    const enriched = await pool.query(
      `SELECT es.*, st.terminal_name, st.city
       FROM e_scooter es
       JOIN service_terminal st ON st.terminal_id = es.terminal_id
       WHERE es.scooter_id = $1`,
      [result.rows[0].scooter_id]
    );
    res.status(201).json(enriched.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `GPS sensor ID '${req.body.gps_sensor_id}' already exists.` });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: `Terminal ID ${req.body.terminal_id} does not exist.` });
    }
    console.error('[POST /api/scooters]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/scooters/:id — update scooter
app.put('/api/scooters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { terminal_id, size, colour, model, gps_sensor_id, status } = req.body;

    // allow partial updates (e.g. status only) by filling missing fields
    const existing = await pool.query('SELECT * FROM e_scooter WHERE scooter_id=$1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: `Scooter ${id} not found.` });
    const cur = existing.rows[0];
    terminal_id = terminal_id ?? cur.terminal_id;
    size = size ?? cur.size;
    colour = colour ?? cur.colour;
    model = model ?? cur.model;
    gps_sensor_id = gps_sensor_id ?? cur.gps_sensor_id;
    status = status ?? cur.status;

    const result = await pool.query(
      `UPDATE e_scooter
       SET terminal_id=$1, size=$2, colour=$3, model=$4, gps_sensor_id=$5, status=$6
       WHERE scooter_id=$7
       RETURNING *`,
      [terminal_id, size.trim(), colour.trim(), model.trim(), gps_sensor_id.trim(), status, id]
    );
    const enriched = await pool.query(
      `SELECT es.*, st.terminal_name, st.city FROM e_scooter es
       JOIN service_terminal st ON st.terminal_id = es.terminal_id
       WHERE es.scooter_id = $1`, [id]
    );
    res.json(enriched.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: `GPS sensor ID '${req.body.gps_sensor_id}' already exists.` });
    }
    console.error('[PUT /api/scooters/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/scooters/:id
app.delete('/api/scooters/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const activeRentals = await pool.query(
      `SELECT COUNT(*) FROM rental WHERE scooter_id = $1 AND status IN ('active','overdue')`, [id]
    );
    if (parseInt(activeRentals.rows[0].count, 10) > 0) {
      return res.status(409).json({ error: 'Cannot delete: scooter has active or overdue rentals.' });
    }
    const result = await pool.query(
      `DELETE FROM e_scooter WHERE scooter_id = $1 RETURNING colour, model`, [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Scooter ${id} not found.` });
    }
    res.json({ message: `Scooter '${result.rows[0].colour} ${result.rows[0].model}' deleted successfully.` });
  } catch (err) {
    console.error('[DELETE /api/scooters/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/members', async (req, res) => {
  try {
    const { search, type, status } = req.query;
    const conditions = [];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(m.full_name ILIKE $${params.length} OR m.email ILIKE $${params.length})`);
    }
    if (type) {
      const types = String(type).split(',').map(t => t.trim()).filter(Boolean);
      if (types.length) {
        const placeholders = types.map((_, i) => `$${params.length + i + 1}`).join(',');
        params.push(...types);
        conditions.push(`m.member_type IN (${placeholders})`);
      }
    }
    if (status) {
      params.push(status);
      conditions.push(`m.membership_status = $${params.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const r = await pool.query(`
      SELECT m.*, p.full_name AS parent_name
      FROM member m
      LEFT JOIN member p ON p.member_id=m.parent_member_id
      ${whereClause}
      ORDER BY m.full_name
      LIMIT 100
    `, params);
    res.json(r.rows);
  } catch (err) { fail(res, err, 'GET /api/members'); }
});
app.get('/api/members/:id', async (req, res) => {
  try {
    const member = await pool.query('SELECT m.*, p.full_name AS parent_name FROM member m LEFT JOIN member p ON p.member_id = m.parent_member_id WHERE m.member_id=$1', [req.params.id]);
    if (!member.rows.length) return res.status(404).json({ error: 'Member not found' });
    const children = await pool.query('SELECT member_id, full_name, member_type, membership_status FROM member WHERE parent_member_id=$1 ORDER BY full_name', [req.params.id]);
    res.json({ ...member.rows[0], children: children.rows });
  } catch (err) { fail(res, err, 'GET /api/members/:id'); }
});
app.post('/api/members', async (req, res) => {
  try {
    const msg = required(req.body, ['full_name', 'email', 'phone', 'address_line1', 'city', 'postcode', 'date_of_birth']);
    if (msg) return res.status(400).json({ error: msg });
    if (!emailRegex.test(req.body.email)) return res.status(400).json({ error: 'Invalid email format' });
    if (String(req.body.phone).length < 10) return res.status(400).json({ error: 'Phone must be at least 10 characters' });
    if (!isValidDate(req.body.date_of_birth)) return res.status(400).json({ error: 'Invalid date_of_birth' });
    const derived = deriveMember(req.body.date_of_birth);
    if (!derived) return res.status(400).json({ error: 'Invalid date_of_birth' });

    if (derived.member_type === 'child') {
      if (!req.body.parent_member_id) return res.status(400).json({ error: 'parent_member_id is required for child members.' });
      const p = await pool.query('SELECT member_type FROM member WHERE member_id=$1', [req.body.parent_member_id]);
      if (!p.rows.length) return res.status(400).json({ error: 'parent_member_id does not exist.' });
      if (!['adult', 'senior_citizen'].includes(p.rows[0].member_type)) {
        return res.status(400).json({ error: 'Parent/guardian must be an adult or senior_citizen member.' });
      }
    }
    const r = await pool.query(`INSERT INTO member (parent_member_id, full_name, email, phone, address_line1, city, postcode, date_of_birth, member_type, membership_status, monthly_fee)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.body.parent_member_id || null, req.body.full_name, req.body.email, req.body.phone, req.body.address_line1, req.body.city, req.body.postcode, req.body.date_of_birth, derived.member_type, req.body.membership_status || 'active', derived.monthly_fee]);
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'POST /api/members'); }
});
app.put('/api/members/:id', async (req, res) => {
  try {
    const msg = required(req.body, ['full_name', 'email', 'phone', 'address_line1', 'city', 'postcode', 'date_of_birth', 'membership_status']);
    if (msg) return res.status(400).json({ error: msg });
    if (!emailRegex.test(req.body.email)) return res.status(400).json({ error: 'Invalid email format' });
    if (String(req.body.phone).length < 10) return res.status(400).json({ error: 'Phone must be at least 10 characters' });
    if (!isValidDate(req.body.date_of_birth)) return res.status(400).json({ error: 'Invalid date_of_birth' });
    const derived = deriveMember(req.body.date_of_birth);
    if (!derived) return res.status(400).json({ error: 'Invalid date_of_birth' });

    if (derived.member_type === 'child') {
      if (!req.body.parent_member_id) return res.status(400).json({ error: 'parent_member_id is required for child members.' });
      const p = await pool.query('SELECT member_type FROM member WHERE member_id=$1', [req.body.parent_member_id]);
      if (!p.rows.length) return res.status(400).json({ error: 'parent_member_id does not exist.' });
      if (!['adult', 'senior_citizen'].includes(p.rows[0].member_type)) {
        return res.status(400).json({ error: 'Parent/guardian must be an adult or senior_citizen member.' });
      }
    }
    const r = await pool.query(`UPDATE member SET parent_member_id=$1, full_name=$2, email=$3, phone=$4, address_line1=$5, city=$6, postcode=$7, date_of_birth=$8, member_type=$9, membership_status=$10, monthly_fee=$11
      WHERE member_id=$12 RETURNING *`,
    [req.body.parent_member_id || null, req.body.full_name, req.body.email, req.body.phone, req.body.address_line1, req.body.city, req.body.postcode, req.body.date_of_birth, derived.member_type, req.body.membership_status, derived.monthly_fee, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Member not found' });
    res.json(r.rows[0]);
  } catch (err) { fail(res, err, 'PUT /api/members/:id'); }
});
app.delete('/api/members/:id', async (req, res) => {
  try {
    const [rentals, bills] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS c FROM rental WHERE member_id=$1 AND status IN ('active','overdue')", [req.params.id]),
      pool.query("SELECT COUNT(*)::int AS c FROM bill WHERE member_id=$1 AND status='pending'", [req.params.id])
    ]);
    if (rentals.rows[0].c > 0 || bills.rows[0].c > 0) return res.status(409).json({ error: 'Cannot delete member with active rentals or unpaid bills' });
    await pool.query('DELETE FROM member WHERE member_id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { fail(res, err, 'DELETE /api/members/:id'); }
});

app.get('/api/visitors', async (req, res) => { try { const r = await pool.query('SELECT v.*, MAX(dp.expiry_datetime) AS latest_pass_expiry FROM visitor v LEFT JOIN day_pass dp ON dp.visitor_id=v.visitor_id GROUP BY v.visitor_id ORDER BY v.full_name'); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/visitors'); } });
app.get('/api/visitors/:id', async (req, res) => {
  try {
    const v = await pool.query('SELECT * FROM visitor WHERE visitor_id=$1', [req.params.id]);
    if (!v.rows.length) return res.status(404).json({ error: 'Visitor not found' });
    const passes = await pool.query('SELECT * FROM day_pass WHERE visitor_id=$1 ORDER BY purchase_datetime DESC', [req.params.id]);
    res.json({ visitor: v.rows[0], passes: passes.rows });
  } catch (err) { fail(res, err, 'GET /api/visitors/:id'); }
});
app.post('/api/visitors', async (req, res) => {
  const client = await pool.connect();
  try {
    const msg = required(req.body, ['full_name', 'email', 'phone', 'address_line1', 'city', 'card_last4', 'card_expiry']);
    if (msg) return res.status(400).json({ error: msg });
    await client.query('BEGIN');
    const v = await client.query('INSERT INTO visitor (full_name,email,phone,address_line1,city,postcode,card_last4,card_expiry) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.body.full_name, req.body.email, req.body.phone, req.body.address_line1, req.body.city, req.body.postcode || null, req.body.card_last4, req.body.card_expiry]);
    const p = await client.query("INSERT INTO day_pass (visitor_id, expiry_datetime, cost) VALUES ($1, NOW()+INTERVAL '24 hours', 15.00) RETURNING *", [v.rows[0].visitor_id]);
    await client.query('COMMIT');
    res.json({ visitor: v.rows[0], pass: p.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    fail(res, err, 'POST /api/visitors');
  } finally { client.release(); }
});
app.delete('/api/visitors/:id', async (req, res) => { try { const c = await pool.query("SELECT COUNT(*)::int AS c FROM rental WHERE visitor_id=$1 AND status IN ('active','overdue')", [req.params.id]); if (c.rows[0].c > 0) return res.status(409).json({ error: 'Cannot delete visitor with active/overdue rentals' }); await pool.query('DELETE FROM visitor WHERE visitor_id=$1', [req.params.id]); res.json({ success: true }); } catch (err) { fail(res, err, 'DELETE /api/visitors/:id'); } });

app.get('/api/rentals', async (req, res) => {
  try {
    const vals = []; let where = '';
    if (req.query.status) { vals.push(req.query.status); where = `WHERE r.status=$${vals.length}`; }
    const r = await pool.query(`SELECT r.*, COALESCE(m.full_name, v.full_name) AS user_name,
      CASE WHEN r.member_id IS NOT NULL THEN 'member' ELSE 'visitor' END AS user_type,
      CASE WHEN r.bicycle_id IS NOT NULL THEN CONCAT(b.make, ' ', b.model) ELSE CONCAT(es.colour, ' ', es.model) END AS asset_description,
      CASE WHEN r.bicycle_id IS NOT NULL THEN 'bicycle' ELSE 'scooter' END AS asset_type,
      st.terminal_name AS pickup_terminal_name, d.dock_name AS return_dock_name
      FROM rental r
      LEFT JOIN member m ON m.member_id=r.member_id
      LEFT JOIN visitor v ON v.visitor_id=r.visitor_id
      LEFT JOIN bicycle b ON b.bicycle_id=r.bicycle_id
      LEFT JOIN e_scooter es ON es.scooter_id=r.scooter_id
      JOIN service_terminal st ON st.terminal_id=r.pickup_terminal_id
      LEFT JOIN parking_dock d ON d.dock_id=r.return_dock_id
      ${where} ORDER BY r.rental_id DESC`, vals);
    res.json(r.rows);
  } catch (err) { fail(res, err, 'GET /api/rentals'); }
});
app.get('/api/rentals/:id', async (req, res) => { try { const r = await pool.query('SELECT * FROM rental WHERE rental_id=$1', [req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Rental not found' }); res.json(r.rows[0]); } catch (err) { fail(res, err, 'GET /api/rentals/:id'); } });
app.post('/api/rentals/start', async (req, res) => {
  const client = await pool.connect();
  try {
    const { userType, userId, assetType, assetId, terminalId } = req.body;
    if (!userType || !userId || !assetType || !assetId || !terminalId) return res.status(400).json({ error: 'Missing required fields' });
    const isMember = userType === 'member';
    const isVisitor = userType === 'visitor';
    if (!(isMember ^ isVisitor)) return res.status(400).json({ error: 'Exactly one user type is required' });
    const isBike = assetType === 'bicycle';
    const isScooter = assetType === 'scooter';
    if (!(isBike ^ isScooter)) return res.status(400).json({ error: 'Exactly one asset type is required' });
    if (isMember) {
      const m = await client.query('SELECT member_type, date_of_birth FROM member WHERE member_id=$1', [userId]);
      if (!m.rows.length) return res.status(404).json({ error: 'Member not found' });
      const age = ageFromDob(m.rows[0].date_of_birth);
      if (m.rows[0].member_type === 'child' || age < 14) return res.status(400).json({ error: 'Children under 14 are not permitted to rent any asset.' });
      if (age > 70) return res.status(400).json({ error: 'HSWS health and safety policy does not permit rental to members over age 70.' });
    }
    const table = isBike ? 'bicycle' : 'e_scooter';
    const col = isBike ? 'bicycle_id' : 'scooter_id';
    const asset = await client.query(`SELECT status FROM ${table} WHERE ${col}=$1`, [assetId]);
    if (!asset.rows.length) return res.status(404).json({ error: 'Asset not found' });
    if (asset.rows[0].status !== 'available') return res.status(409).json({ error: 'This asset is currently unavailable.' });
    await client.query('BEGIN');
    const rental = await client.query(`INSERT INTO rental (member_id, visitor_id, bicycle_id, scooter_id, pickup_terminal_id, status)
      VALUES ($1,$2,$3,$4,$5,'active') RETURNING *`,
    [isMember ? userId : null, isVisitor ? userId : null, isBike ? assetId : null, isScooter ? assetId : null, terminalId]);
    await client.query(`UPDATE ${table} SET status='rented' WHERE ${col}=$1`, [assetId]);
    await client.query('COMMIT');
    res.json(rental.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    fail(res, err, 'POST /api/rentals/start');
  } finally { client.release(); }
});
app.put('/api/rentals/:id/complete', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!req.body.dockId) return res.status(400).json({ error: 'Field dockId is required' });
    await client.query('BEGIN');
    const rr = await client.query('SELECT * FROM rental WHERE rental_id=$1 FOR UPDATE', [req.params.id]);
    if (!rr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Rental not found' }); }
    const rental = rr.rows[0];
    const minsQ = await client.query('SELECT GREATEST(1, ROUND(EXTRACT(EPOCH FROM (NOW() - $1::timestamp))/60.0))::int AS m', [rental.pickup_datetime]);
    const mins = minsQ.rows[0].m;
    const total = rental.bicycle_id ? mins * 0.05 : mins * 0.0667;
    await client.query(`UPDATE rental SET return_dock_id=$1, return_datetime=NOW(), duration_minutes=$2, total_cost=$3, status='completed' WHERE rental_id=$4`,
      [req.body.dockId, mins, Math.round(total * 100) / 100, req.params.id]);
    const d = await client.query('SELECT terminal_id FROM parking_dock WHERE dock_id=$1', [req.body.dockId]);
    if (!d.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Dock not found' }); }
    if (rental.bicycle_id) await client.query("UPDATE bicycle SET status='available', terminal_id=$1 WHERE bicycle_id=$2", [d.rows[0].terminal_id, rental.bicycle_id]);
    if (rental.scooter_id) await client.query("UPDATE e_scooter SET status='available', terminal_id=$1 WHERE scooter_id=$2", [d.rows[0].terminal_id, rental.scooter_id]);
    const out = await client.query('SELECT * FROM rental WHERE rental_id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json(out.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    fail(res, err, 'PUT /api/rentals/:id/complete');
  } finally { client.release(); }
});
app.put('/api/rentals/:id/overdue', async (req, res) => { try { const r = await pool.query("UPDATE rental SET status='overdue' WHERE rental_id=$1 RETURNING *", [req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Rental not found' }); res.json(r.rows[0]); } catch (err) { fail(res, err, 'PUT /api/rentals/:id/overdue'); } });

app.get('/api/bills', async (req, res) => {
  try {
    const vals = []; let where = '';
    if (req.query.status) { vals.push(req.query.status); where = `WHERE b.status=$${vals.length}`; }
    const r = await pool.query(`SELECT b.*, m.full_name, COALESCE(SUM(p.amount),0)::numeric(10,2) AS total_paid
      FROM bill b
      JOIN member m ON m.member_id=b.member_id
      LEFT JOIN payment p ON p.bill_id=b.bill_id
      ${where}
      GROUP BY b.bill_id, m.full_name
      ORDER BY b.bill_date DESC`, vals);
    res.json(r.rows);
  } catch (err) { fail(res, err, 'GET /api/bills'); }
});
app.get('/api/bills/:id', async (req, res) => { try { const bill = await pool.query('SELECT * FROM bill WHERE bill_id=$1', [req.params.id]); if (!bill.rows.length) return res.status(404).json({ error: 'Bill not found' }); const payments = await pool.query('SELECT * FROM payment WHERE bill_id=$1 ORDER BY payment_date DESC', [req.params.id]); res.json({ bill: bill.rows[0], payments: payments.rows }); } catch (err) { fail(res, err, 'GET /api/bills/:id'); } });
app.post('/api/bills', async (req, res) => { try { const msg = required(req.body, ['member_id', 'total_amount']); if (msg) return res.status(400).json({ error: msg }); const r = await pool.query('INSERT INTO bill (member_id,bill_date,total_amount,status) VALUES ($1,$2,$3,$4) RETURNING *', [req.body.member_id, req.body.bill_date || new Date(), req.body.total_amount, req.body.status || 'pending']); res.json(r.rows[0]); } catch (err) { fail(res, err, 'POST /api/bills'); } });
app.put('/api/bills/:id', async (req, res) => { try { const r = await pool.query('UPDATE bill SET status=$1 WHERE bill_id=$2 RETURNING *', [req.body.status, req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Bill not found' }); res.json(r.rows[0]); } catch (err) { fail(res, err, 'PUT /api/bills/:id'); } });

app.get('/api/payments', async (req, res) => { try { const r = await pool.query('SELECT p.*, b.total_amount, b.status AS bill_status, m.full_name FROM payment p JOIN bill b ON b.bill_id=p.bill_id JOIN member m ON m.member_id=b.member_id ORDER BY p.payment_date DESC'); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/payments'); } });
app.post('/api/payments', async (req, res) => {
  const client = await pool.connect();
  try {
    const msg = required(req.body, ['bill_id', 'amount', 'mode']);
    if (msg) return res.status(400).json({ error: msg });
    await client.query('BEGIN');
    const payment = await client.query('INSERT INTO payment (bill_id,payment_date,amount,mode) VALUES ($1,$2,$3,$4) RETURNING *', [req.body.bill_id, req.body.payment_date || new Date(), req.body.amount, req.body.mode]);
    const sum = await client.query('SELECT b.total_amount, COALESCE(SUM(p.amount),0) AS paid FROM bill b LEFT JOIN payment p ON p.bill_id=b.bill_id WHERE b.bill_id=$1 GROUP BY b.bill_id', [req.body.bill_id]);
    let billStatus = 'pending';
    if (Number(sum.rows[0].paid) >= Number(sum.rows[0].total_amount)) {
      await client.query("UPDATE bill SET status='paid' WHERE bill_id=$1", [req.body.bill_id]);
      billStatus = 'paid';
    }
    await client.query('COMMIT');
    res.json({ payment: payment.rows[0], billStatus });
  } catch (err) {
    await client.query('ROLLBACK');
    fail(res, err, 'POST /api/payments');
  } finally { client.release(); }
});

// Sponsors (enriched + contract status)
app.get('/api/sponsors', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        s.*,
        COALESCE(COUNT(sa.asset_id),0)::int AS sponsored_assets,
        CASE
          WHEN s.end_date < CURRENT_DATE THEN 'expired'
          WHEN s.end_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
          ELSE 'active'
        END AS contract_status,
        (s.end_date - CURRENT_DATE)::int AS days_remaining
      FROM sponsor s
      LEFT JOIN sponsorship_asset sa ON sa.sponsor_id=s.sponsor_id
      GROUP BY s.sponsor_id
      ORDER BY s.sponsor_name
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /api/sponsors]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sponsors/:id', async (req, res) => {
  try {
    const sponsor = await pool.query('SELECT * FROM sponsor WHERE sponsor_id=$1', [req.params.id]);
    if (!sponsor.rows.length) return res.status(404).json({ error: 'Sponsor not found' });
    const assets = await pool.query(`
      SELECT
        sa.*,
        CASE
          WHEN sa.asset_type='terminal' THEN st.terminal_name
          WHEN sa.asset_type='bicycle' THEN CONCAT(b.make,' ',b.model)
          WHEN sa.asset_type='scooter' THEN CONCAT(es.colour,' ',es.model)
          ELSE NULL
        END AS asset_description
      FROM sponsorship_asset sa
      LEFT JOIN service_terminal st ON sa.asset_type='terminal' AND sa.asset_id=st.terminal_id
      LEFT JOIN bicycle b ON sa.asset_type='bicycle' AND sa.asset_id=b.bicycle_id
      LEFT JOIN e_scooter es ON sa.asset_type='scooter' AND sa.asset_id=es.scooter_id
      WHERE sa.sponsor_id=$1
      ORDER BY sa.asset_type, sa.asset_id
    `, [req.params.id]);
    res.json({ sponsor: sponsor.rows[0], assets: assets.rows });
  } catch (err) {
    console.error('[GET /api/sponsors/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sponsors', async (req, res) => {
  try {
    const msg = required(req.body, ['sponsor_name', 'company_name', 'contact_person', 'phone', 'address', 'start_date', 'end_date', 'annual_fee', 'contract_ref']);
    if (msg) return res.status(400).json({ error: msg });
    if (!isValidDate(req.body.start_date) || !isValidDate(req.body.end_date)) return res.status(400).json({ error: 'Invalid start_date or end_date.' });
    if (new Date(req.body.end_date) <= new Date(req.body.start_date)) return res.status(400).json({ error: 'end_date must be after start_date.' });
    const r = await pool.query(
      `INSERT INTO sponsor (sponsor_name,company_name,contact_person,phone,address,start_date,end_date,annual_fee,contract_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.body.sponsor_name, req.body.company_name, req.body.contact_person, req.body.phone, req.body.address, req.body.start_date, req.body.end_date, req.body.annual_fee, req.body.contract_ref]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Contract ref '${req.body.contract_ref}' already exists.` });
    console.error('[POST /api/sponsors]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sponsors/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE sponsor SET sponsor_name=$1,company_name=$2,contact_person=$3,phone=$4,address=$5,start_date=$6,end_date=$7,annual_fee=$8,contract_ref=$9
       WHERE sponsor_id=$10 RETURNING *`,
      [req.body.sponsor_name, req.body.company_name, req.body.contact_person, req.body.phone, req.body.address, req.body.start_date, req.body.end_date, req.body.annual_fee, req.body.contract_ref, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Sponsor not found' });
    res.json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: `Contract ref '${req.body.contract_ref}' already exists.` });
    console.error('[PUT /api/sponsors/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sponsors/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sponsorship_asset WHERE sponsor_id=$1', [req.params.id]);
    await client.query('DELETE FROM sponsor WHERE sponsor_id=$1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DELETE /api/sponsors/:id]', err.message);
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// Sponsorship assets module
app.get('/api/sponsorship-assets', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        sa.*,
        sp.company_name,
        CASE
          WHEN sa.asset_type='terminal' THEN st.terminal_name
          WHEN sa.asset_type='bicycle' THEN CONCAT(b.make,' ',b.model)
          WHEN sa.asset_type='scooter' THEN CONCAT(es.colour,' ',es.model)
          ELSE NULL
        END AS asset_description,
        CASE
          WHEN sp.end_date < CURRENT_DATE THEN 'expired'
          WHEN sp.end_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
          ELSE 'active'
        END AS contract_status
      FROM sponsorship_asset sa
      JOIN sponsor sp ON sp.sponsor_id=sa.sponsor_id
      LEFT JOIN service_terminal st ON sa.asset_type='terminal' AND sa.asset_id=st.terminal_id
      LEFT JOIN bicycle b ON sa.asset_type='bicycle' AND sa.asset_id=b.bicycle_id
      LEFT JOIN e_scooter es ON sa.asset_type='scooter' AND sa.asset_id=es.scooter_id
      ORDER BY sp.company_name, sa.asset_type, sa.asset_id
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /api/sponsorship-assets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sponsorship-assets/available/:type', async (req, res) => {
  try {
    const type = req.params.type;
    if (!['bicycle', 'scooter', 'terminal'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
    if (type === 'terminal') {
      const r = await pool.query(`
        SELECT st.terminal_id AS asset_id, st.terminal_name AS asset_description
        FROM service_terminal st
        WHERE NOT EXISTS (SELECT 1 FROM sponsorship_asset sa WHERE sa.asset_type='terminal' AND sa.asset_id=st.terminal_id)
        ORDER BY st.city, st.terminal_name
      `);
      return res.json(r.rows);
    }
    if (type === 'bicycle') {
      const r = await pool.query(`
        SELECT b.bicycle_id AS asset_id, CONCAT(b.make,' ',b.model) AS asset_description
        FROM bicycle b
        WHERE NOT EXISTS (SELECT 1 FROM sponsorship_asset sa WHERE sa.asset_type='bicycle' AND sa.asset_id=b.bicycle_id)
        ORDER BY b.bicycle_id
      `);
      return res.json(r.rows);
    }
    const r = await pool.query(`
      SELECT es.scooter_id AS asset_id, CONCAT(es.colour,' ',es.model) AS asset_description
      FROM e_scooter es
      WHERE NOT EXISTS (SELECT 1 FROM sponsorship_asset sa WHERE sa.asset_type='scooter' AND sa.asset_id=es.scooter_id)
      ORDER BY es.scooter_id
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /api/sponsorship-assets/available/:type]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sponsorship-assets', async (req, res) => {
  try {
    const msg = required(req.body, ['sponsor_id', 'asset_type', 'asset_id']);
    if (msg) return res.status(400).json({ error: msg });
    const { sponsor_id, asset_type, asset_id, logo_placement } = req.body;
    // verify asset existence
    if (asset_type === 'terminal') {
      const ex = await pool.query('SELECT 1 FROM service_terminal WHERE terminal_id=$1', [asset_id]);
      if (!ex.rows.length) return res.status(400).json({ error: 'Terminal does not exist.' });
    } else if (asset_type === 'bicycle') {
      const ex = await pool.query('SELECT 1 FROM bicycle WHERE bicycle_id=$1', [asset_id]);
      if (!ex.rows.length) return res.status(400).json({ error: 'Bicycle does not exist.' });
    } else if (asset_type === 'scooter') {
      const ex = await pool.query('SELECT 1 FROM e_scooter WHERE scooter_id=$1', [asset_id]);
      if (!ex.rows.length) return res.status(400).json({ error: 'Scooter does not exist.' });
    } else return res.status(400).json({ error: 'Invalid asset_type.' });

    const r = await pool.query(
      `INSERT INTO sponsorship_asset (sponsor_id, asset_type, asset_id, logo_placement)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [sponsor_id, asset_type, asset_id, logo_placement || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[POST /api/sponsorship-assets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sponsorship-assets', async (req, res) => {
  try {
    const msg = required(req.body, ['sponsor_id', 'asset_type', 'asset_id', 'logo_placement']);
    if (msg) return res.status(400).json({ error: msg });
    const { sponsor_id, asset_type, asset_id, logo_placement } = req.body;
    const r = await pool.query(
      `UPDATE sponsorship_asset SET logo_placement=$1
       WHERE sponsor_id=$2 AND asset_type=$3 AND asset_id=$4
       RETURNING *`,
      [logo_placement, sponsor_id, asset_type, asset_id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Sponsorship link not found.' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[PUT /api/sponsorship-assets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/sponsorship-assets', async (req, res) => {
  try {
    const msg = required(req.body, ['sponsor_id', 'asset_type', 'asset_id']);
    if (msg) return res.status(400).json({ error: msg });
    const { sponsor_id, asset_type, asset_id } = req.body;
    await pool.query(`DELETE FROM sponsorship_asset WHERE sponsor_id=$1 AND asset_type=$2 AND asset_id=$3`, [sponsor_id, asset_type, asset_id]);
    res.json({ message: 'Sponsorship link removed.' });
  } catch (err) {
    console.error('[DELETE /api/sponsorship-assets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/sponsorship', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT asset_type, COUNT(*)::int AS links
      FROM sponsorship_asset
      GROUP BY asset_type
      ORDER BY asset_type
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /api/reports/sponsorship]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/sponsorship/revenue', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT EXTRACT(YEAR FROM start_date)::int AS year, COALESCE(SUM(annual_fee),0)::numeric(12,2) AS revenue
      FROM sponsor
      GROUP BY year
      ORDER BY year DESC
    `);
    res.json(r.rows);
  } catch (err) {
    console.error('[GET /api/reports/sponsorship/revenue]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/service-companies', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT sc.*,
        COUNT(mr.record_id)::INT AS maintenance_count,
        CASE
          WHEN sc.contract_end < CURRENT_DATE THEN 'expired'
          WHEN sc.contract_end <= CURRENT_DATE + INTERVAL '30 days' THEN 'expiring_soon'
          ELSE 'active'
        END AS contract_status
      FROM service_company sc
      LEFT JOIN maintenance_record mr ON mr.company_id = sc.company_id
      GROUP BY sc.company_id
      ORDER BY sc.company_name
    `);
    res.json(result.rows);
  } catch (err) { fail(res, err, 'GET /api/service-companies'); }
});
app.get('/api/service-companies/:id', async (req, res) => { try { const company = await pool.query('SELECT * FROM service_company WHERE company_id=$1', [req.params.id]); if (!company.rows.length) return res.status(404).json({ error: 'Company not found' }); const maintenance = await pool.query('SELECT * FROM maintenance_record WHERE company_id=$1 ORDER BY service_date DESC LIMIT 20', [req.params.id]); res.json({ company: company.rows[0], maintenance: maintenance.rows }); } catch (err) { fail(res, err, 'GET /api/service-companies/:id'); } });
app.post('/api/service-companies', async (req, res) => { try { const msg = required(req.body, ['company_name', 'address', 'city', 'contact_person', 'phone', 'contract_number', 'contract_start', 'contract_end', 'contract_fee']); if (msg) return res.status(400).json({ error: msg }); const r = await pool.query('INSERT INTO service_company (company_name,address,city,contact_person,phone,contract_number,contract_start,contract_end,contract_fee) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [req.body.company_name, req.body.address, req.body.city, req.body.contact_person, req.body.phone, req.body.contract_number, req.body.contract_start, req.body.contract_end, req.body.contract_fee]); res.json(r.rows[0]); } catch (err) { fail(res, err, 'POST /api/service-companies'); } });
app.put('/api/service-companies/:id', async (req, res) => { try { const r = await pool.query('UPDATE service_company SET company_name=$1,address=$2,city=$3,contact_person=$4,phone=$5,contract_number=$6,contract_start=$7,contract_end=$8,contract_fee=$9 WHERE company_id=$10 RETURNING *', [req.body.company_name, req.body.address, req.body.city, req.body.contact_person, req.body.phone, req.body.contract_number, req.body.contract_start, req.body.contract_end, req.body.contract_fee, req.params.id]); if (!r.rows.length) return res.status(404).json({ error: 'Company not found' }); res.json(r.rows[0]); } catch (err) { fail(res, err, 'PUT /api/service-companies/:id'); } });

// Maintenance routes (enriched + urgency + days)
app.get('/api/maintenance', async (req, res) => {
  try {
    const { due } = req.query;
    let extraCondition = '';
    const params = [];

    if (due) {
      params.push(parseInt(due, 10));
      extraCondition = `AND mr.next_service_date <= CURRENT_DATE + ($${params.length} || ' days')::INTERVAL`;
    }

    const result = await pool.query(`
      SELECT
        mr.*,
        sc.company_name,
        sc.phone AS company_phone,
        b.make || ' ' || b.model AS bicycle_desc,
        es.colour || ' ' || es.model AS scooter_desc,
        CASE WHEN mr.bicycle_id IS NOT NULL THEN 'bicycle' ELSE 'scooter' END AS asset_type,
        COALESCE(b.make || ' ' || b.model, es.colour || ' ' || es.model) AS asset_desc,
        CASE
          WHEN mr.next_service_date IS NULL THEN NULL
          WHEN mr.next_service_date < CURRENT_DATE THEN 'overdue'
          WHEN mr.next_service_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'due_soon'
          ELSE 'scheduled'
        END AS service_urgency,
        (mr.next_service_date - CURRENT_DATE)::INT AS days_until_service
      FROM maintenance_record mr
      JOIN service_company sc ON sc.company_id = mr.company_id
      LEFT JOIN bicycle b ON b.bicycle_id = mr.bicycle_id
      LEFT JOIN e_scooter es ON es.scooter_id = mr.scooter_id
      WHERE 1=1 ${extraCondition}
      ORDER BY mr.next_service_date ASC NULLS LAST, mr.service_date DESC
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/maintenance]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`
      SELECT mr.*, sc.company_name, sc.phone AS company_phone,
        COALESCE(b.make || ' ' || b.model, es.colour || ' ' || es.model) AS asset_desc,
        CASE WHEN mr.bicycle_id IS NOT NULL THEN 'bicycle' ELSE 'scooter' END AS asset_type
      FROM maintenance_record mr
      JOIN service_company sc ON sc.company_id = mr.company_id
      LEFT JOIN bicycle b ON b.bicycle_id = mr.bicycle_id
      LEFT JOIN e_scooter es ON es.scooter_id = mr.scooter_id
      WHERE mr.record_id = $1
    `, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: `Maintenance record ${id} not found.` });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[GET /api/maintenance/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/maintenance', async (req, res) => {
  try {
    const { company_id, bicycle_id, scooter_id, service_date, description, cost, next_service_date } = req.body;
    if (!company_id || !service_date || !description) return res.status(400).json({ error: 'company_id, service_date, and description are required.' });
    if (!bicycle_id && !scooter_id) return res.status(400).json({ error: 'Either bicycle_id or scooter_id must be provided.' });
    if (bicycle_id && scooter_id) return res.status(400).json({ error: 'Provide either bicycle_id or scooter_id, not both.' });

    if (bicycle_id) {
      await pool.query(`UPDATE bicycle SET status='maintenance' WHERE bicycle_id=$1 AND status='available'`, [bicycle_id]);
    }
    if (scooter_id) {
      await pool.query(`UPDATE e_scooter SET status='maintenance' WHERE scooter_id=$1 AND status='available'`, [scooter_id]);
    }

    const result = await pool.query(`
      INSERT INTO maintenance_record (company_id, bicycle_id, scooter_id, service_date, description, cost, next_service_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [company_id, bicycle_id || null, scooter_id || null, service_date, String(description).trim(), cost || null, next_service_date || null]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[POST /api/maintenance]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { company_id, service_date, description, cost, next_service_date } = req.body;
    const result = await pool.query(`
      UPDATE maintenance_record
      SET company_id=$1, service_date=$2, description=$3, cost=$4, next_service_date=$5
      WHERE record_id=$6
      RETURNING *
    `, [company_id, service_date, String(description).trim(), cost || null, next_service_date || null, id]);
    if (result.rows.length === 0) return res.status(404).json({ error: `Record ${id} not found.` });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[PUT /api/maintenance/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/maintenance/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(`DELETE FROM maintenance_record WHERE record_id=$1 RETURNING record_id`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: `Record ${id} not found.` });
    res.json({ message: 'Maintenance record deleted.' });
  } catch (err) {
    console.error('[DELETE /api/maintenance/:id]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/revenue', async (req, res) => {
  try {
    const r = await pool.query(`SELECT
        TO_CHAR(DATE_TRUNC('month', rental.pickup_datetime), 'YYYY-MM') AS month,
        st.city,
        CASE WHEN rental.bicycle_id IS NOT NULL THEN 'bicycle' ELSE 'scooter' END AS asset_type,
        COUNT(*)::int AS total_rentals,
        COALESCE(SUM(rental.total_cost),0)::numeric(10,2) AS gross_revenue,
        COALESCE(AVG(rental.total_cost),0)::numeric(10,2) AS avg_cost,
        COALESCE(AVG(rental.duration_minutes),0)::numeric(10,2) AS avg_duration
      FROM rental
      JOIN service_terminal st ON st.terminal_id = rental.pickup_terminal_id
      WHERE rental.status = 'completed'
      GROUP BY month, st.city, asset_type
      ORDER BY month DESC, st.city, asset_type`);
    res.json(r.rows);
  } catch (err) { fail(res, err, 'GET /api/reports/revenue'); }
});
app.get('/api/reports/top-members', async (req, res) => { try { const r = await pool.query(`SELECT m.member_id,m.full_name,m.member_type,m.city,COUNT(rt.rental_id)::int AS total_rentals,COALESCE(SUM(rt.total_cost),0)::numeric(10,2) AS total_spent,MAX(rt.pickup_datetime) AS last_rental,EXISTS(SELECT 1 FROM rental rr WHERE rr.member_id=m.member_id AND rr.status='overdue') AS has_overdue FROM member m LEFT JOIN rental rt ON rt.member_id=m.member_id GROUP BY m.member_id ORDER BY total_spent DESC, total_rentals DESC LIMIT 10`); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/reports/top-members'); } });
app.get('/api/reports/maintenance-due', async (req, res) => { try { const r = await pool.query(`SELECT CASE WHEN mr.bicycle_id IS NOT NULL THEN 'bicycle' ELSE 'scooter' END AS asset_type, CASE WHEN mr.bicycle_id IS NOT NULL THEN CONCAT(b.make,' ',b.model) ELSE CONCAT(es.colour,' ',es.model) END AS description, COALESCE(bt.terminal_name,st.terminal_name) AS terminal_name, COALESCE(bt.city,st.city) AS city, (mr.next_service_date-CURRENT_DATE) AS days_remaining, sc.company_name, sc.phone FROM maintenance_record mr JOIN service_company sc ON sc.company_id=mr.company_id LEFT JOIN bicycle b ON b.bicycle_id=mr.bicycle_id LEFT JOIN e_scooter es ON es.scooter_id=mr.scooter_id LEFT JOIN service_terminal bt ON bt.terminal_id=b.terminal_id LEFT JOIN service_terminal st ON st.terminal_id=es.terminal_id WHERE mr.next_service_date IS NOT NULL AND mr.next_service_date <= CURRENT_DATE + INTERVAL '30 days' ORDER BY mr.next_service_date`); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/reports/maintenance-due'); } });
app.get('/api/reports/terminal-utilisation', async (req, res) => { try { const r = await pool.query(`WITH terminal_totals AS (SELECT st.terminal_id, st.terminal_name, st.city, COUNT(DISTINCT b.bicycle_id)+COUNT(DISTINCT es.scooter_id) AS total_assets, COUNT(DISTINCT CASE WHEN b.status='rented' THEN b.bicycle_id END)+COUNT(DISTINCT CASE WHEN es.status='rented' THEN es.scooter_id END) AS rented_assets FROM service_terminal st LEFT JOIN bicycle b ON b.terminal_id=st.terminal_id LEFT JOIN e_scooter es ON es.terminal_id=st.terminal_id GROUP BY st.terminal_id) SELECT tt.*, CASE WHEN tt.total_assets=0 THEN 0 ELSE ROUND((tt.rented_assets::numeric/tt.total_assets)*100,2) END AS utilisation_pct, DENSE_RANK() OVER (ORDER BY COALESCE(rc.count,0) DESC) AS dock_popularity_rank FROM terminal_totals tt LEFT JOIN (SELECT pickup_terminal_id, COUNT(*) AS count FROM rental GROUP BY pickup_terminal_id) rc ON rc.pickup_terminal_id=tt.terminal_id ORDER BY tt.city, tt.terminal_name`); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/reports/terminal-utilisation'); } });
app.get('/api/reports/bill-ageing', async (req, res) => { try { const r = await pool.query(`SELECT m.full_name, m.email, b.bill_date, b.total_amount, COALESCE(SUM(p.amount),0)::numeric(10,2) AS amount_paid, (b.total_amount-COALESCE(SUM(p.amount),0))::numeric(10,2) AS balance_due, CASE WHEN CURRENT_DATE-b.bill_date < 30 THEN '0-30' WHEN CURRENT_DATE-b.bill_date < 60 THEN '31-60' WHEN CURRENT_DATE-b.bill_date < 90 THEN '61-90' ELSE '90+' END AS age_bracket FROM bill b JOIN member m ON m.member_id=b.member_id LEFT JOIN payment p ON p.bill_id=b.bill_id WHERE b.status='pending' GROUP BY b.bill_id, m.full_name, m.email ORDER BY b.bill_date`); res.json(r.rows); } catch (err) { fail(res, err, 'GET /api/reports/bill-ageing'); } });

app.listen(port, () => console.log(`Server running on http://localhost:${port}`));
