#!/usr/bin/env node
/*
 * Reads the workflow board, compares it against the last run, and emails each
 * person about the cards they are tagged on.
 *
 * Runs in GitHub Actions on a schedule, so it works whether or not anyone has
 * the board open, and the API keys stay in repository secrets rather than in
 * the public page.
 *
 * Environment:
 *   BIN_ID          the JSONBin holding the board
 *   JSONBIN_KEY     JSONBin access key (read is enough)
 *   Sending, pick one:
 *     SMTP_USER + SMTP_PASS + MAIL_FROM   any SMTP relay (Brevo, Gmail, etc.)
 *     RESEND_API_KEY + MAIL_FROM          send through Resend (needs a domain)
 *   SMTP_HOST, SMTP_PORT  default to Brevo's relay on 587
 *   BOARD_URL       link included in the email
 *   STATE_BIN_ID    a second JSONBin holding the previous board. Kept out of
 *                   the repo so the job does not commit on every run, which
 *                   would rebuild the site each time.
 *   STATE_FILE      local fallback when STATE_BIN_ID is unset (testing)
 *   DRY_RUN         "1" prints the emails instead of sending them
 */

const fs = require('fs');

const BIN_ID = process.env.BIN_ID || '';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || '';
/* Any SMTP relay. Defaults suit Brevo, which needs no domain and no
   two-factor dance — you verify one sender address by email and copy the
   credentials it gives you. */
const SMTP_HOST = process.env.SMTP_HOST || 'smtp-relay.brevo.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || process.env.GMAIL_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || process.env.GMAIL_APP_PASSWORD || '';
const USE_SMTP = !!(SMTP_USER && SMTP_PASS);
const BOARD_URL = process.env.BOARD_URL || '';
const STATE_FILE = process.env.STATE_FILE || '.notify-state.json';
const STATE_BIN_ID = process.env.STATE_BIN_ID || '';
const DRY_RUN = process.env.DRY_RUN === '1';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function whoOf(card) {
  if (Array.isArray(card.who)) return card.who.filter(Boolean);
  if (card.person) return [card.person];
  return [];
}

/* Every card, wherever it currently lives, keyed by id. */
function indexBoard(board) {
  const out = {};
  const add = (list, where) => {
    (Array.isArray(list) ? list : []).forEach(c => {
      if (c && c.id != null) out[String(c.id)] = { card: c, where };
    });
  };
  add(board.cards, 'active');
  add(board.completed, 'completed');
  add(board.removed, 'removed');
  return out;
}

function stageLabel(board, id) {
  const s = (board.stages || []).find(x => x.id === id);
  return s ? s.label : '';
}

function nameOf(board, personId) {
  const p = (board.people || []).find(x => x.id === personId);
  return p ? p.name : 'someone';
}

/*
 * What changed between two boards, as a list of plain-language events with the
 * people who should hear about each one.
 */
function diffBoards(prev, cur) {
  const before = indexBoard(prev);
  const after = indexBoard(cur);
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const events = [];

  ids.forEach(id => {
    const b = before[id];
    const a = after[id];

    /* Anyone tagged before or after hears about it, so a person who was
       removed from a card finds out too. */
    const audience = new Set([
      ...(b ? whoOf(b.card) : []),
      ...(a ? whoOf(a.card) : [])
    ]);
    if (!audience.size) return;

    const title = (a ? a.card.n : b.card.n) || 'Untitled';
    const push = text => events.push({ id, title, text, audience: [...audience] });

    if (!b && a) {
      if (a.where === 'active') push('added to the board in ' + (stageLabel(cur, a.card.stage) || 'the first stage'));
      return;
    }
    if (b && !a) {
      push('deleted permanently');
      return;
    }

    if (b.where !== a.where) {
      if (a.where === 'completed') push('marked done');
      else if (a.where === 'removed') push('moved to Removed');
      else if (b.where === 'completed') push('reopened from Completed');
      else if (b.where === 'removed') push('put back on the board');
    }

    if (a.where === 'active' && b.card.stage !== a.card.stage) {
      push('moved to ' + (stageLabel(cur, a.card.stage) || 'another stage'));
    }
    if ((b.card.n || '') !== (a.card.n || '')) {
      push('renamed from "' + (b.card.n || '') + '"');
    }
    if ((b.card.dates || '') !== (a.card.dates || '')) {
      push(a.card.dates ? 'dates set to ' + a.card.dates : 'dates cleared');
    }

    const wb = whoOf(b.card), wa = whoOf(a.card);
    const added = wa.filter(x => !wb.includes(x));
    const gone = wb.filter(x => !wa.includes(x));
    if (added.length) push('tagged ' + added.map(x => nameOf(cur, x)).join(', '));
    if (gone.length) push('untagged ' + gone.map(x => nameOf(prev, x)).join(', '));
  });

  return events;
}

/* One email per person, listing only what touches them. */
function groupByPerson(events, board) {
  const people = board.people || [];
  const out = [];
  people.forEach(p => {
    if (!p.email) return;
    const mine = events.filter(e => e.audience.includes(p.id));
    if (!mine.length) return;
    const byCard = {};
    mine.forEach(e => {
      byCard[e.id] = byCard[e.id] || { title: e.title, lines: [] };
      byCard[e.id].lines.push(e.text);
    });
    out.push({ person: p, cards: Object.values(byCard) });
  });
  return out;
}

function renderEmail(entry) {
  const count = entry.cards.length;
  const subject = count === 1
    ? 'Workflow board: ' + entry.cards[0].title
    : 'Workflow board: ' + count + ' projects updated';

  const body = entry.cards.map(c =>
    '<p style="margin:0 0 14px"><strong>' + esc(c.title) + '</strong><br>' +
    c.lines.map(l => '<span style="color:#555">' + esc(l) + '</span>').join('<br>') +
    '</p>'
  ).join('');

  const html =
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#1a1a1a;line-height:1.6">' +
    '<p>Hi ' + esc(entry.person.name) + ', here is what changed on projects you are tagged on:</p>' +
    body +
    (BOARD_URL ? '<p><a href="' + esc(BOARD_URL) + '">Open the board</a></p>' : '') +
    '<p style="color:#888;font-size:12px">You are getting this because you are tagged on these projects.</p>' +
    '</div>';

  const text = entry.cards.map(c => c.title + '\n  ' + c.lines.join('\n  ')).join('\n\n');
  return { subject, html, text };
}

async function fetchBoard() {
  const r = await fetch('https://api.jsonbin.io/v3/b/' + BIN_ID + '/latest', {
    /* Access Key only — sending X-Master-Key too makes JSONBin validate it
       as a master key and reject the request with a 401. */
    headers: { 'X-Access-Key': JSONBIN_KEY }
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error('Could not read the board (bin ' + BIN_ID + '): HTTP ' + r.status +
      (r.status === 401 ? ' — the JSONBIN_KEY is wrong or has no access to this bin.' :
       r.status === 404 ? ' — no bin with that ID.' : '') +
      (body ? ' ' + body.slice(0, 200) : ''));
  }
  const j = await r.json();
  return j.record || {};
}

/* State lives in its own bin so a scheduled run never touches the repo. */
async function readState() {
  if (STATE_BIN_ID) {
    const r = await fetch('https://api.jsonbin.io/v3/b/' + STATE_BIN_ID + '/latest', {
      /* Access Key only — sending X-Master-Key too makes JSONBin validate it
       as a master key and reject the request with a 401. */
    headers: { 'X-Access-Key': JSONBIN_KEY }
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error('Could not read the state bin (' + STATE_BIN_ID + '): HTTP ' + r.status +
        (r.status === 404 ? ' — no bin with that ID.' : '') +
        (body ? ' ' + body.slice(0, 200) : ''));
    }
    const j = await r.json();
    const rec = j.record || {};
    return rec.board || null;
  }
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch (e) { return null; }
  }
  return null;
}
async function writeState(board) {
  if (STATE_BIN_ID) {
    const r = await fetch('https://api.jsonbin.io/v3/b/' + STATE_BIN_ID, {
      method: 'PUT',
      headers: {
        'X-Access-Key': JSONBIN_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ savedAt: new Date().toISOString(), board })
    });
    if (!r.ok) throw new Error('Could not write the state bin: HTTP ' + r.status);
    return;
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(board, null, 2));
}

let transport = null;
function smtpTransport() {
  if (transport) return transport;
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  return transport;
}

async function sendEmail(to, subject, html, text) {
  if (USE_SMTP) {
    await smtpTransport().sendMail({
      from: MAIL_FROM || ('Workflow Board <' + SMTP_USER + '>'),
      to, subject, html, text
    });
    return;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text })
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error('Send to ' + to + ' failed: HTTP ' + r.status + ' ' + detail.slice(0, 200));
  }
}

/* Print what the job can actually see before doing anything. Secrets are
   shown only as present/absent and by length, never by value, so a wrong
   paste is visible without exposing the credential. */
function report() {
  const mask = v => v ? ('set, ' + v.length + ' chars') : 'MISSING';
  console.log('--- configuration ---');
  console.log('BIN_ID:        ' + (BIN_ID || 'MISSING'));
  console.log('STATE_BIN_ID:  ' + (STATE_BIN_ID || 'MISSING'));
  console.log('BOARD_URL:     ' + (BOARD_URL || 'not set (optional)'));
  console.log('JSONBIN_KEY:   ' + mask(JSONBIN_KEY));
  console.log('SMTP_USER:     ' + (SMTP_USER || 'MISSING'));
  console.log('SMTP_PASS:     ' + mask(SMTP_PASS));
  console.log('MAIL_FROM:     ' + (MAIL_FROM || 'MISSING'));
  console.log('DRY_RUN:       ' + (DRY_RUN ? 'yes' : 'no'));
  if (MAIL_FROM && /secret|`|^"|"$/i.test(MAIL_FROM)) {
    console.log('WARNING: MAIL_FROM looks like it has extra characters in it.');
  }
  console.log('---------------------');
}

async function main() {
  report();
  if (!BIN_ID || !JSONBIN_KEY) {
    console.error('STOP: BIN_ID and JSONBIN_KEY are both required. See the list above for which is missing.');
    process.exit(1);
  }

  const cur = await fetchBoard();

  let prev = null;
  try { prev = await readState(); }
  catch (e) { console.log('State unreadable (' + e.message + '), treating this as a first run.'); }

  /* On a first run there is nothing to compare against. Record the board and
     stop, otherwise everyone would be emailed about every existing card. */
  if (!prev) {
    await writeState(cur);
    console.log('First run — saved the current board, no emails sent.');
    return;
  }

  const events = diffBoards(prev, cur);
  if (!events.length) {
    await writeState(cur);
    console.log('No changes.');
    return;
  }

  const entries = groupByPerson(events, cur);
  console.log(events.length + ' change(s), ' + entries.length + ' person(s) to notify.');

  if (DRY_RUN) {
    entries.forEach(e => {
      const m = renderEmail(e);
      console.log('\n--- to ' + e.person.email + ' ---\nSubject: ' + m.subject + '\n' + m.text);
    });
    console.log('\nDry run — nothing sent, state not saved.');
    return;
  }

  if (!USE_SMTP && (!RESEND_API_KEY || !MAIL_FROM)) {
    console.error('Set SMTP_USER and SMTP_PASS (plus MAIL_FROM), or RESEND_API_KEY and MAIL_FROM.');
    process.exit(1);
  }
  if (USE_SMTP && !MAIL_FROM) {
    console.error('MAIL_FROM is required — it must be the sender address you verified.');
    process.exit(1);
  }
  console.log('Sending via ' + (USE_SMTP ? SMTP_HOST + ' as ' + MAIL_FROM : 'Resend') + '.');

  let sent = 0, failed = 0;
  for (const e of entries) {
    const m = renderEmail(e);
    try {
      await sendEmail(e.person.email, m.subject, m.html, m.text);
      sent++;
      console.log('Sent to ' + e.person.email);
    } catch (err) {
      failed++;
      console.error(String(err.message));
    }
  }

  /* Save state even if some sends failed, so one bad address cannot cause the
     same changes to be re-sent to everyone on every later run. */
  await writeState(cur);
  console.log('Done. Sent ' + sent + ', failed ' + failed + '.');
  if (failed && !sent) process.exit(1);
}

if (require.main === module) {
  main().catch(err => {
    console.error('\n================ FAILED ================');
    console.error(err && err.message ? err.message : String(err));
    console.error('=======================================');
    process.exit(1);
  });
}

module.exports = { main, diffBoards, groupByPerson, renderEmail };
